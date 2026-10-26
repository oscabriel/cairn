// The Claude bridge as the brain composes it: the whole `@cairn/bridge` stack (the `claude-bridge`
// provider, its conversations, plan windows and login, one-shot summaries and the generation slots)
// built once per process, and handed to the model runtime through `ExtraProviders` so
// `PiModelSource` registers it with `registerNativeProvider`. Everything else in the brain that
// reaches the bridge (the cwd hook, the stop hook, the shutdown hook, the shell's slot and plan
// signals, `usage.subscribe`) reads it through this service.
//
// The kill switch is `CAIRN_BRIDGE` (default on; `CAIRN_BRIDGE=false` turns it off, and a value that is
// not a boolean turns it off with a warning). Off, no provider is registered, no `claude` child
// ever starts (not even the usage probe), and every reader sees no bridge. The `bridgeEnabled`
// server setting is the softer switch: it hides the bridge's models from the picker while the
// provider stays registered, so threads already on Claude keep running.
//
// Boot also logs the Agent SDK's version, the `claude` bundled with it and the one on PATH, and any
// `claude` process whose parent died (re-parented to init or to a systemd subreaper): a child the
// last brain lost.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Claude } from "@cairn/bridge/Claude";
import { ClaudeSdk } from "@cairn/bridge/ClaudeSdk";
import type { ClaudeSdkScripts } from "@cairn/bridge/ClaudeSdk";
import { ClaudeUsage } from "@cairn/bridge/ClaudeUsage";
import { NodeServices } from "@effect/platform-node";
import {
  Config,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { shutdownHook } from "../Shutdown.ts";
import { ExtraProviders } from "./PiModelSource.ts";

/** How long `claude --version` may take at boot before it is logged as unknown. */
const VERSION_TIMEOUT = Duration.seconds(5);

const SdkManifest = Schema.Struct({ version: Schema.String });

const decodeSdkManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(SdkManifest)
);

/** One process line of `/proc/<pid>/stat`: its command name and parent. */
interface ProcessStat {
  readonly pid: number;
  readonly command: string;
  readonly parent: number;
}

/**
 * Parses `/proc/<pid>/stat`. The command name sits in parentheses and may itself hold spaces or
 * parentheses, so the fields after it are read from the last `)`.
 */
export const parseProcessStat = (text: string): Option.Option<ProcessStat> => {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");

  if (open === -1 || close < open) {
    return Option.none();
  }

  const pid = Number(text.slice(0, open).trim());

  const rest = text
    .slice(close + 1)
    .trim()
    .split(" ");

  const parent = Number(rest[1]);

  return Number.isSafeInteger(pid) && Number.isSafeInteger(parent)
    ? Option.some({ pid, command: text.slice(open + 1, close), parent })
    : Option.none();
};

/**
 * The `claude` processes whose parent died: re-parented to pid 1 or to a process named `systemd`
 * (the user manager is a subreaper). A brain's own children have the brain as their parent.
 */
export const orphanClaudes = (
  processes: ReadonlyArray<ProcessStat>
): ReadonlyArray<number> => {
  const commands = new Map(
    processes.map((entry) => [entry.pid, entry.command])
  );

  return processes.flatMap((entry) =>
    entry.command === "claude" &&
    (entry.parent === 1 || commands.get(entry.parent) === "systemd")
      ? [entry.pid]
      : []
  );
};

/** Every process `/proc` lists now; a process that ends while it is read is skipped. */
const readProcesses = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const names = yield* fs.readDirectory("/proc");

  const stats = yield* Effect.forEach(
    names.filter((name) => /^\d+$/u.test(name)),
    (name) =>
      fs.readFileString(`/proc/${name}/stat`).pipe(
        Effect.map(parseProcessStat),
        Effect.orElseSucceed(() => Option.none<ProcessStat>())
      ),
    { concurrency: 16 }
  );

  return stats.flatMap((stat) => (Option.isSome(stat) ? [stat.value] : []));
});

/** The version of the `claude` binary the pinned Agent SDK ships, from its `manifest.json`. */
const bundledClaudeVersion = Effect.tryPromise(async () => {
  const bridge = fileURLToPath(import.meta.resolve("@cairn/bridge/ClaudeSdk"));
  const sdk = createRequire(bridge).resolve("@anthropic-ai/claude-agent-sdk");

  return await readFile(path.join(path.dirname(sdk), "manifest.json"), "utf-8");
}).pipe(
  Effect.map((text) =>
    Option.match(decodeSdkManifest(text), {
      onNone: () => "unknown",
      onSome: ({ version }) => version,
    })
  ),
  Effect.orElseSucceed(() => "unknown")
);

/** `claude --version` of the binary on PATH, or `missing`. */
const pathClaudeVersion = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("claude", ["--version"], { stdin: "ignore" })
      );

      const text = yield* Stream.mkString(Stream.decodeText(handle.stdout));

      yield* handle.exitCode;

      return text.trim().split(/\s/u)[0] ?? "unknown";
    })
  );
}).pipe(
  Effect.timeoutOption(VERSION_TIMEOUT),
  Effect.map(Option.getOrElse(() => "unknown")),
  Effect.orElseSucceed(() => "missing")
);

/** The boot log lines: versions, then orphaned children. Forked, so boot never waits on them. */
const BridgeBootLog = Layer.effectDiscard(
  Effect.gen(function* () {
    const claude = yield* Claude;

    const versions = Effect.gen(function* () {
      const [bundled, onPath] = yield* Effect.all(
        [bundledClaudeVersion, pathClaudeVersion],
        { concurrency: 2 }
      );

      yield* Effect.logInfo("claude versions").pipe(
        Effect.annotateLogs({
          event: "claude_versions",
          sdk: claude.sdkVersion,
          bundled,
          path: onPath,
        })
      );
    });

    const orphans = Effect.gen(function* () {
      const found = orphanClaudes(yield* readProcesses);

      const line =
        found.length > 0
          ? Effect.logWarning("orphaned claude processes")
          : Effect.logInfo("no orphaned claude processes");

      yield* line.pipe(
        Effect.annotateLogs({
          event: "claude_orphans",
          count: found.length,
          pids: found.join(" "),
        })
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not list processes").pipe(
          Effect.annotateLogs({ event: "claude_orphans", cause: String(cause) })
        )
      )
    );

    yield* Effect.forkScoped(Effect.andThen(versions, orphans));
  })
);

/** What the brain reaches the bridge through. */
export interface BridgeServices {
  /** The Claude bridge; none when it is off. */
  readonly claude: Option.Option<Claude["Service"]>;
  /** Claude's plan windows and login; none when the bridge is off. */
  readonly usage: Option.Option<ClaudeUsage["Service"]>;
}

/** No bridge: no provider, no children, no plan windows. */
const OFF: BridgeServices = { claude: Option.none(), usage: Option.none() };

/**
 * The bridge, or none. A reference whose default is off, so a brain that composes no bridge (the
 * dev and judge brains, tests) needs no change; the deployed brain provides `BridgeProvider.layer`.
 */
export class BridgeProvider extends Context.Reference<BridgeServices>(
  "cairn/server/models/BridgeProvider",
  { defaultValue: () => OFF }
) {
  /** The bridge over the `Claude` and `ClaudeUsage` services the root provides. */
  static readonly layerNoDeps = Layer.effect(
    BridgeProvider,
    Effect.gen(function* () {
      const claude = yield* Claude;
      const usage = yield* ClaudeUsage;

      return { claude: Option.some(claude), usage: Option.some(usage) };
    })
  );

  /** No bridge, explicitly. */
  static readonly layerOff = Layer.succeed(BridgeProvider, OFF);

  /**
   * The bridge on a scripted Claude Code (`ClaudeSdk.layerTest`), with the real usage service,
   * slots and login over it; needs `ClaudeSdkScripts`.
   */
  static readonly layerTest: Layer.Layer<never, never, ClaudeSdkScripts> =
    BridgeProvider.layerNoDeps.pipe(
      Layer.provide(ClaudeUsage.layerBridgeNoDeps),
      Layer.provide(ClaudeSdk.layerTest)
    );

  /**
   * The bridge on the real Agent SDK, unless `CAIRN_BRIDGE` is false; logs the versions and any
   * orphaned `claude` process at boot without waiting for them.
   */
  static readonly layer: Layer.Layer<never> = Layer.unwrap(
    Effect.gen(function* () {
      // A value that is not a boolean turns the bridge off with a warning: a kill switch that
      // misreads as on would spend the plan, and failing boot would crash-loop the unit (T6).
      const enabled = yield* Config.Boolean("CAIRN_BRIDGE").pipe(
        Config.withDefault(true),
        Effect.catch((error) =>
          Effect.logWarning(
            "CAIRN_BRIDGE is not a boolean (true/false, on/off, yes/no, 1/0); the claude bridge stays off"
          ).pipe(
            Effect.annotateLogs({
              event: "claude_bridge_flag_invalid",
              detail: error.message,
            }),
            Effect.as(false)
          )
        )
      );

      if (!enabled) {
        yield* Effect.logInfo("claude bridge off").pipe(
          Effect.annotateLogs({ event: "claude_bridge_off" })
        );

        return BridgeProvider.layerOff;
      }

      return Layer.merge(
        BridgeProvider.layerNoDeps,
        BridgeBootLog.pipe(Layer.provide(NodeServices.layer))
      ).pipe(Layer.provide(ClaudeUsage.layerBridge));
    })
  );
}

/**
 * `ExtraProviders` for `PiModelSource`: the bridge's provider, or nothing while the bridge is off.
 * Needs `BridgeProvider`.
 */
export const BridgeExtraProviders = Layer.effect(
  ExtraProviders,
  BridgeProvider.useSync((bridge) =>
    Option.match(bridge.claude, {
      onNone: () => [],
      onSome: (claude) => [claude.provider],
    })
  )
);

/**
 * The bridge's close hook, first in shutdown order: from here on an `AbortError` from the Harness
 * closing means "close and stay resumable", not a user's stop, so no session is forked.
 */
export const bridgeClosingHook = shutdownHook(
  "claude-bridge begin closing",
  BridgeProvider.use((bridge) =>
    Option.match(bridge.claude, {
      onNone: () => Effect.void,
      onSome: (claude) => claude.beginClosing,
    })
  ),
  "1 second"
);
