// The tools-only pi host (ADR 0039): the user's allowlisted pi TUI extensions (`pi-web-access`,
// `pi-fff`) offered to every thread as ordinary pi-durable tools, in one `cairn.pi-tools`
// extension the brain installs once at boot.
//
// - Resolve: the extension entries pi resolved and enabled (`PiConfig`), kept only for packages
//   `PiHostPolicy` names in its version range. A package outside its range loads nothing
//   (`event: pi_host_skipped`); a package that fails to load, or registers a provider, an MCP server
//   or a virtual model, is dropped alone (`event: pi_host_failed`) and boot goes on.
// - Load: pi's own `discoverAndLoadExtensions`, with an empty host-owned directory as both cwd and
//   agent dir, so no project-local or global extension is discovered. Each instance is its own
//   load, so it has its own runtime and its own module state.
// - Instances: a brain-scoped package gets one instance, started at boot. A folder-scoped package
//   (pi-fff searches the folder of its last `session_start`, not the call's) gets one instance per
//   cwd, built on its first call and started with that cwd, at most `folderInstances` of them; the
//   least recently used idle one is shut down first. Concurrent first calls in one cwd share one
//   build. A boot-time template of each folder-scoped package, never started, gives the tool
//   definitions the brain installs.
// - Close: every instance gets `session_shutdown` when the layer closes.
//
// Instances live in memory: a restart rebuilds them on the next call. A crash mid-call reruns a
// `safe` tool and returns an `unsafe` one `interrupted`, like any pi-durable tool.

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  Extension,
  ExtensionRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { Context, Effect, FiberSet, Layer, Option, Schema } from "effect";

import { errorText } from "../brain/Durable.ts";
import { ExtensionOrder } from "../brain/Extensions.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import { ServerConfig } from "../Config.ts";
import { PiConfig } from "../models/PiConfig.ts";
import type { PiExtensionEntry } from "../models/PiConfig.ts";
import type {
  PiHostDirs,
  PiHostPolicy,
  PiPackagePolicy,
} from "./PiHostPolicy.ts";
import {
  decidePackage,
  PackageDecision,
  PI_HOST_POLICY,
  piHostDirs,
  replayOf,
} from "./PiHostPolicy.ts";
import type { HostEvents } from "./PiHostRuntime.ts";
import {
  bindRuntime,
  deliver,
  hostContext,
  refusedRegistrations,
  runInCall,
} from "./PiHostRuntime.ts";
import { adaptTool, piToolsSection } from "./PiToolAdapter.ts";
import type { PiToolCall, PiToolRunner } from "./PiToolAdapter.ts";

/** The extension's name in pi-durable's registry. */
export const PI_TOOLS_EXTENSION = "cairn.pi-tools";

/** The prompt section the surviving tools' snippets and guidelines render into. */
export const PI_TOOLS_SECTION = "pi-tools";

/** pi-coding-agent could not be loaded. Boot stops; reinstall the brain's dependencies. */
export class PiHostError extends Schema.TaggedError<PiHostError>()(
  "PiHostError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  }
) {}

/** A package the host loaded, and the tools it offers. */
export interface PiHostPackage {
  readonly name: string;
  readonly version: string;
  readonly scope: PiPackagePolicy["scope"];
  readonly tools: ReadonlyArray<string>;
}

/** One loaded instance of a package. */
interface Instance {
  readonly extensions: ReadonlyArray<Extension>;
  readonly runtime: ExtensionRuntime;
}

/** A package that passed the allowlist: its entries and policy. */
interface Candidate {
  readonly name: string;
  readonly version: string;
  readonly entries: ReadonlyArray<string>;
  readonly policy: PiPackagePolicy;
}

/** How the host reports, from plain callbacks: one log line with its annotations. */
type Report = (
  level: "info" | "warning",
  message: string,
  annotations: Readonly<Record<string, string | number>>
) => void;

/** The packages pi resolved, grouped by root, with each one's name and version. */
const packagesOf = (
  entries: ReadonlyArray<PiExtensionEntry>
): ReadonlyArray<{
  readonly name: string;
  readonly version: Option.Option<string>;
  readonly entries: ReadonlyArray<string>;
}> => {
  const byRoot = new Map<
    string,
    {
      name: string;
      version: Option.Option<string>;
      entries: Array<string>;
    }
  >();

  for (const entry of entries) {
    if (Option.isNone(entry.packageRoot) || Option.isNone(entry.packageName)) {
      continue;
    }

    const root = entry.packageRoot.value;
    const known = byRoot.get(root);

    if (known === undefined) {
      byRoot.set(root, {
        name: entry.packageName.value,
        version: entry.packageVersion,
        entries: [entry.path],
      });
    } else {
      known.entries.push(entry.path);
    }
  }

  return [...byRoot.values()];
};

/** Events of one package's instances, as log lines. */
const eventsFor = (name: string, report: Report): HostEvents => ({
  notify: (message, level) => {
    report("info", "pi host notice", {
      event: "pi_host_notice",
      package: name,
      level,
      message: message.slice(0, 300),
    });
  },
  dropped: (api) => {
    report("warning", "pi host dropped an unsupported call", {
      event: "pi_host_dropped",
      package: name,
      api,
    });
  },
  appended: (customType) => {
    report("info", "pi host dropped an appended entry", {
      event: "pi_host_append_dropped",
      package: name,
      customType,
    });
  },
});

/** One package could not be loaded; the host drops it and boot goes on. */
export class PiHostLoadError extends Schema.TaggedError<PiHostLoadError>()(
  "PiHostLoadError",
  {
    message: Schema.String,
    package: Schema.String,
  }
) {}

/**
 * Loads one instance of `candidate`: its env set, its entries loaded together through pi's loader
 * from `dirs.empty`, its runtime bound and its flags set. Fails with `PiHostLoadError` when an entry
 * fails to load or the package registered something a tools-only host refuses.
 */
const loadInstance = Effect.fn("PiHost.loadInstance")(function* (
  pi: typeof PiCodingAgent,
  candidate: Candidate,
  dirs: PiHostDirs,
  events: HostEvents
) {
  for (const [key, value] of candidate.policy.env(dirs)) {
    process.env[key] = value;
  }

  const loaded = yield* Effect.tryPromise({
    try: async () =>
      await pi.discoverAndLoadExtensions(
        [...candidate.entries],
        dirs.empty,
        dirs.empty,
        pi.createEventBus()
      ),
    catch: (cause) =>
      new PiHostLoadError({
        message: `pi's loader failed on ${candidate.name}: ${errorText(cause)}`,
        package: candidate.name,
      }),
  });

  if (loaded.errors.length > 0) {
    return yield* new PiHostLoadError({
      message: loaded.errors
        .map((failure) => `${failure.path}: ${failure.error}`)
        .join("; "),
      package: candidate.name,
    });
  }

  const refused = refusedRegistrations(loaded.runtime);

  if (refused.length > 0) {
    return yield* new PiHostLoadError({
      message: `${candidate.name} called ${refused.join(", ")} while loading; the tools-only pi host loads tools only, so the package stays off.`,
      package: candidate.name,
    });
  }

  bindRuntime(loaded.runtime, loaded.extensions, events);

  for (const [flag, value] of candidate.policy.flags(dirs)) {
    loaded.runtime.flagValues.set(flag, value);
  }

  const instance: Instance = {
    extensions: loaded.extensions,
    runtime: loaded.runtime,
  };

  return instance;
});

/** Logs the failures of one lifecycle event. */
const logFailures = (
  failures: ReadonlyArray<string>,
  event: string,
  cwd: string
) =>
  Effect.forEach(
    failures,
    (error) =>
      Effect.logWarning("pi host lifecycle handler failed").pipe(
        Effect.annotateLogs({
          event: "pi_host_event_failed",
          on: event,
          cwd,
          error,
        })
      ),
    { discard: true }
  );

/** Starts `instance` in `cwd`; handler failures are logged, not failed. */
const startInstance = Effect.fn("PiHost.startInstance")(function* (
  instance: Instance,
  cwd: string,
  sessionId: string,
  events: HostEvents
) {
  const failures = yield* deliver(
    instance.extensions,
    { type: "session_start", reason: "startup" },
    hostContext({ cwd, signal: undefined, sessionId, events })
  );

  yield* logFailures(failures, "session_start", cwd);
});

/** Shuts `instance` down and makes it stale; handler failures are logged, not failed. */
const stopInstance = Effect.fn("PiHost.stopInstance")(function* (
  instance: Instance,
  cwd: string,
  events: HostEvents
) {
  const failures = yield* deliver(
    instance.extensions,
    { type: "session_shutdown", reason: "quit" },
    hostContext({ cwd, signal: undefined, sessionId: "pi-host", events })
  );

  instance.runtime.invalidate(
    "The Cairn pi host shut this instance down; its next call builds a new one."
  );

  yield* logFailures(failures, "session_shutdown", cwd);
});

/** Runs `call` on `instance`, with the call's context, as one live call. */
const runOn = async (
  instance: Instance,
  call: PiToolCall,
  events: HostEvents
): Promise<AgentToolResult<unknown>> => {
  const registered = instance.extensions
    .map((extension) => extension.tools.get(call.name))
    .find((tool) => tool !== undefined);

  if (registered === undefined) {
    throw new Error(
      `${call.name} is not registered by its pi extension in ${call.cwd}; the package changed since boot. Restart the brain.`
    );
  }

  const context = hostContext({
    cwd: call.cwd,
    signal: call.signal,
    sessionId: call.conversationId,
    events,
  });

  return await runInCall(
    async () =>
      await registered.definition.execute(
        call.callId,
        call.args,
        call.signal,
        call.onUpdate,
        context
      )
  );
};

/** One folder's instance in the pool. */
interface Slot {
  readonly cwd: string;
  readonly instance: Promise<Instance>;
  inFlight: number;
  lastUsed: number;
}

/**
 * A folder-scoped package's instances, one per cwd, at most `capacity` idle ones kept. Busy
 * instances are never shut down, so the pool may hold more while every one of them is in a call.
 */
const folderPool = (
  capacity: number,
  build: (cwd: string) => Promise<Instance>,
  stop: (instance: Instance, cwd: string) => Promise<void>
) => {
  const slots = new Map<string, Slot>();
  let clock = 0;

  /** Stops the slot's instance; a build that failed has nothing to stop (its caller saw why). */
  const shutDown = async (slot: Slot) => {
    let built: Instance;

    try {
      built = await slot.instance;
    } catch {
      return;
    }

    await stop(built, slot.cwd);
  };

  const trim = () => {
    while (slots.size > capacity) {
      const [idle] = [...slots.values()]
        .filter((slot) => slot.inFlight === 0)
        .toSorted((a, b) => a.lastUsed - b.lastUsed);

      if (idle === undefined) {
        return;
      }

      slots.delete(idle.cwd);
      void shutDown(idle);
    }
  };

  const acquire = async (cwd: string) => {
    const key = path.resolve(cwd);
    const known = slots.get(key);

    const slot: Slot = known ?? {
      cwd: key,
      instance: build(key),
      inFlight: 0,
      lastUsed: 0,
    };

    if (known === undefined) {
      slots.set(key, slot);
    }

    slot.inFlight += 1;
    clock += 1;
    slot.lastUsed = clock;
    trim();

    const release = () => {
      slot.inFlight -= 1;
      trim();
    };

    try {
      return { instance: await slot.instance, release };
    } catch (error) {
      release();

      // A build that failed leaves the pool, so the next call in that cwd tries again.
      if (slots.get(key) === slot) {
        slots.delete(key);
      }

      throw error;
    }
  };

  return {
    acquire,
    /** The cwds with an instance, oldest use first. */
    folders: () =>
      [...slots.values()]
        .toSorted((a, b) => a.lastUsed - b.lastUsed)
        .map((slot) => slot.cwd),
    closeAll: async () => {
      const all = [...slots.values()];

      slots.clear();
      await Promise.all(all.map(shutDown));
    },
  };
};

/** The tools-only pi host: the extension the brain installs, and what it loaded. */
export class PiHost extends Context.Service<
  PiHost,
  {
    /** The `cairn.pi-tools` extension, for the installed set; empty when nothing loaded. */
    readonly extension: CairnExtension;
    /** The packages loaded at boot. */
    readonly packages: ReadonlyArray<PiHostPackage>;
    /** The cwds with a live instance of the folder-scoped package `name`, least recently used first. */
    folders(name: string): ReadonlyArray<string>;
  }
>()("cairn/server/pi-host/PiHost") {
  /**
   * Loads the packages `policy` allows from what `PiConfig` resolved, under `root` (emptied of its
   * `empty` directory first). Fails with `PiHostError` only when pi-coding-agent cannot be loaded.
   */
  static readonly layerWith = (options: {
    readonly policy: PiHostPolicy;
    readonly root: string;
  }) =>
    Layer.effect(
      PiHost,
      Effect.gen(function* () {
        const config = yield* PiConfig;
        const run = yield* FiberSet.makeRuntimePromise();
        const dirs = piHostDirs(options.root);

        const report: Report = (level, message, annotations) => {
          const line =
            level === "info"
              ? Effect.logInfo(message)
              : Effect.logWarning(message);

          void run(line.pipe(Effect.annotateLogs(annotations)));
        };

        const pi = yield* Effect.tryPromise({
          try: async () => await import("@earendil-works/pi-coding-agent"),
          catch: (cause) =>
            new PiHostError({
              message: `PiHost could not load @earendil-works/pi-coding-agent: ${errorText(cause)}. Reinstall the brain's dependencies (pnpm install --frozen-lockfile).`,
              cause,
            }),
        });

        yield* Effect.sync(() => {
          rmSync(dirs.empty, { recursive: true, force: true });
          mkdirSync(dirs.empty, { recursive: true, mode: 0o700 });
        });

        const candidates: Array<Candidate> = [];

        for (const found of packagesOf(config.current().extensions)) {
          yield* PackageDecision.$match(
            decidePackage(options.policy, found.name, found.version),
            {
              Allowed: ({ policy }) =>
                Effect.sync(() => {
                  candidates.push({
                    name: found.name,
                    version: Option.getOrElse(found.version, () => "unknown"),
                    entries: found.entries,
                    policy,
                  });
                }),
              NotAllowed: () => Effect.void,
              OutOfRange: ({ policy, version }) =>
                Effect.logWarning("pi host skipped a package").pipe(
                  Effect.annotateLogs({
                    event: "pi_host_skipped",
                    package: found.name,
                    version,
                    range: policy.versions,
                  })
                ),
            }
          );
        }

        // What the layer's close runs: `session_shutdown` for every instance still loaded.
        const closers: Array<Effect.Effect<void>> = [];

        yield* Effect.addFinalizer(() =>
          Effect.suspend(() =>
            Effect.all(closers, { concurrency: "unbounded", discard: true })
          )
        );

        const tools: Array<ToolRegistration> = [];
        const offered: Array<ToolDefinition> = [];
        const packages: Array<PiHostPackage> = [];
        const pools = new Map<string, ReturnType<typeof folderPool>>();
        const names = new Set<string>();

        for (const candidate of candidates) {
          const events = eventsFor(candidate.name, report);
          const sessionId = `pi-host-${candidate.name}`;

          const boot = yield* loadInstance(pi, candidate, dirs, events).pipe(
            Effect.tap((instance) =>
              candidate.policy.scope === "brain"
                ? startInstance(instance, dirs.empty, sessionId, events)
                : Effect.void
            ),
            Effect.asSome,
            Effect.catchTag("PiHostLoadError", (failure) =>
              Effect.logWarning("pi host could not load a package").pipe(
                Effect.annotateLogs({
                  event: "pi_host_failed",
                  package: candidate.name,
                  version: candidate.version,
                  error: failure.message,
                }),
                Effect.as(Option.none<Instance>())
              )
            )
          );

          if (Option.isNone(boot)) {
            continue;
          }

          const instance = boot.value;
          let runner: PiToolRunner;

          if (candidate.policy.scope === "brain") {
            runner = async (call) => await runOn(instance, call, events);
            closers.push(stopInstance(instance, dirs.empty, events));
          } else {
            const pool = folderPool(
              options.policy.folderInstances,
              async (cwd) =>
                await run(
                  loadInstance(pi, candidate, dirs, events).pipe(
                    Effect.tap((built) =>
                      startInstance(built, cwd, sessionId, events)
                    ),
                    Effect.tap(
                      Effect.logInfo("pi host started a folder instance").pipe(
                        Effect.annotateLogs({
                          event: "pi_host_folder_started",
                          package: candidate.name,
                          cwd,
                        })
                      )
                    )
                  )
                ),
              async (stopped, cwd) => {
                await run(stopInstance(stopped, cwd, events));
              }
            );

            pools.set(candidate.name, pool);

            runner = async (call) => {
              const lease = await pool.acquire(call.cwd);

              try {
                return await runOn(lease.instance, call, events);
              } finally {
                lease.release();
              }
            };

            closers.push(Effect.promise(pool.closeAll));
          }

          const kept: Array<string> = [];

          for (const extension of instance.extensions) {
            for (const { definition } of extension.tools.values()) {
              if (
                candidate.policy.dropped.includes(definition.name) ||
                names.has(definition.name)
              ) {
                continue;
              }

              const adapted = adaptTool(
                definition,
                replayOf(options.policy, definition.name),
                runner
              );

              if (Option.isSome(adapted)) {
                names.add(definition.name);
                kept.push(definition.name);
                tools.push(adapted.value);
                offered.push(definition);
              }
            }
          }

          packages.push({
            name: candidate.name,
            version: candidate.version,
            scope: candidate.policy.scope,
            tools: kept,
          });

          yield* Effect.logInfo("pi host loaded a package").pipe(
            Effect.annotateLogs({
              event: "pi_host_loaded",
              package: candidate.name,
              version: candidate.version,
              tools: kept.join(" "),
            })
          );
        }

        const sectionText = piToolsSection(offered);

        const extension = defineExtension({
          name: PI_TOOLS_EXTENSION,
          tools,
          sections: Option.match(sectionText, {
            onNone: () => [],
            onSome: (text) => [section(PI_TOOLS_SECTION, () => text)],
          }),
        });

        return PiHost.of({
          extension: { order: ExtensionOrder.piTools, extension },
          packages,
          folders: (name) => pools.get(name)?.folders() ?? [],
        });
      })
    );

  /** The brain's host: `PI_HOST_POLICY` over the brain's `PiConfig`, under `<dataDir>/pi-host`. */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig;

      return PiHost.layerWith({
        policy: PI_HOST_POLICY,
        root: path.join(config.dataDir, "pi-host"),
      });
    })
  ).pipe(Layer.provide(PiConfig.layer));

  /**
   * No packages: the same empty `cairn.pi-tools` extension, so a brain without the user's pi setup
   * (tests, dev) installs the same extension set.
   */
  static readonly layerEmpty = Layer.succeed(
    PiHost,
    PiHost.of({
      extension: {
        order: ExtensionOrder.piTools,
        extension: defineExtension({ name: PI_TOOLS_EXTENSION, tools: [] }),
      },
      packages: [],
      folders: () => [],
    })
  );
}
