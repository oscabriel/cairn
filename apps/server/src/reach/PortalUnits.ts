// The host's side of a portal (ADR 0038, docs/phase-2/notes/reach.md R5): its dev server runs as a
// transient systemd user unit, started with `systemd-run --user --collect`, so it has its own cgroup
// outside the brain's (`cairn.service` is `KillMode=mixed`, which kills whatever is left in its own
// cgroup) and keeps answering through a brain restart or a `kill -9`. This service starts, reads,
// lists and stops those units, reads the end of a unit's journal, and checks loopback ports: whether
// one is free to hand out, and whether a dev server answers HTTP on it.
//
// Every command runs with argv entries, never through a shell of Cairn's own; the dev server's
// command is the one string handed to `/bin/sh -c` inside the unit, as `bash` runs a model's
// command. `CAIRN_*` variables never reach a child. No sudo.

import { request } from "node:http";
import { createServer } from "node:net";

import { NodeServices } from "@effect/platform-node";
import { Context, Duration, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** What a portal's unit runs, and where. */
export interface UnitSpec {
  /** The unit's name without `.service`, such as `cairn-portal-0f3a9c1d2e4b5a69`. */
  readonly unit: string;
  readonly cwd: string;
  /** The dev server's command, run by `/bin/sh -c` in `cwd`. */
  readonly command: string;
  /** The unit's own variables, set with `--setenv`, over the user manager's environment. */
  readonly env: Readonly<Record<string, string>>;
  /** `RuntimeMaxSec`: systemd stops the unit then, even while the brain is down. */
  readonly lifetime: Duration.Duration;
}

/** A unit command could not run, or systemd refused it. */
export class PortalUnitError extends Schema.TaggedError<PortalUnitError>()(
  "PortalUnitError",
  {
    message: Schema.String,
    /** `start`, `is-active`, `stop` or `list`. */
    operation: Schema.String,
    unit: Schema.String,
    /** The end of what the command printed on stderr; unit commands print no secrets. */
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** How much of a command's stderr an error keeps. */
const DETAIL_CHARS = 1000;

/** How long one systemctl or journalctl call may take. */
const COMMAND_TIMEOUT = Duration.seconds(20);

/** How long a readiness probe waits for an answer before it counts as none. */
const PROBE_TIMEOUT_MS = 2000;

/** The systemd states in which a unit's process is running or starting. */
const RUNNING_STATES: ReadonlySet<string> = new Set([
  "active",
  "activating",
  "reloading",
]);

/** `systemctl stop` of a unit that is not loaded: already gone, which is what stop wants. */
const EXIT_NOT_LOADED = 5;

/** The environment a unit command sees: the brain's own less every `CAIRN_*` variable. */
const commandEnv = () =>
  Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => name.startsWith("CAIRN_"))
      .map((name) => [name, undefined])
  );

/** The unit names `systemctl list-units --plain --no-legend` printed, without `.service`. */
export const unitsOfListing = (listing: string): ReadonlyArray<string> =>
  listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/u)[0] ?? "")
    .filter((name) => name.endsWith(".service"))
    .map((name) => name.slice(0, -".service".length));

/** The `systemd-run` argv that starts `spec` as a transient user service. */
export const systemdRunArgs = (spec: UnitSpec): ReadonlyArray<string> => [
  "--user",
  "--collect",
  "--quiet",
  `--unit=${spec.unit}`,
  `--working-directory=${spec.cwd}`,
  `--property=RuntimeMaxSec=${String(Math.max(1, Math.floor(Duration.toSeconds(spec.lifetime))))}`,
  "--property=MemoryHigh=2G",
  ...Object.entries(spec.env).map(([key, value]) => `--setenv=${key}=${value}`),
  "--",
  "/bin/sh",
  "-c",
  spec.command,
];

/** Whether something answers HTTP on 127.0.0.1:`port` at `path`; any status counts. */
const answersHttp = (port: number, path: string) =>
  Effect.callback<boolean>((resume) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        timeout: PROBE_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        resume(Effect.succeed(true));
      }
    );

    req.on("timeout", () => {
      req.destroy();
    });
    req.on("error", () => {
      resume(Effect.succeed(false));
    });
    req.end();

    return Effect.sync(() => {
      req.destroy();
    });
  });

/** Whether 127.0.0.1:`port` can be bound now, so nothing else listens there. */
const bindable = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const server = createServer();

    server.once("error", () => {
      resume(Effect.succeed(false));
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resume(Effect.succeed(true));
      });
    });
  });

/** systemd's refusal of `operation`, with the end of its stderr. */
const refused = (
  operation: string,
  unit: string,
  result: { readonly exitCode: number; readonly stderr: string }
) => {
  const detail = result.stderr.trim().slice(-DETAIL_CHARS);

  return new PortalUnitError({
    message: `systemd refused ${operation} of ${unit} (exit ${String(result.exitCode)}): ${detail}. Inspect it with systemctl --user status ${unit}.`,
    operation,
    unit,
    detail,
  });
};

// ── The service ──────────────────────────────────────────────────────────────────────────────────

/** Portal units and loopback ports on this host. */
export class PortalUnits extends Context.Service<
  PortalUnits,
  {
    /**
     * Starts `spec` as a transient user service. Fails `PortalUnitError` when systemd refuses, as
     * it does for a unit of that name that already runs.
     */
    start(spec: UnitSpec): Effect.Effect<void, PortalUnitError>;
    /** Whether the unit's process is running or starting. */
    isActive(unit: string): Effect.Effect<boolean, PortalUnitError>;
    /** Stops the unit; a unit that is already gone is not an error. */
    stop(unit: string): Effect.Effect<void, PortalUnitError>;
    /** Every loaded unit whose name starts with `prefix`, without `.service`. */
    list(prefix: string): Effect.Effect<ReadonlyArray<string>, PortalUnitError>;
    /** The last `lines` lines the unit wrote; empty when the journal cannot be read. */
    journal(unit: string, lines: number): Effect.Effect<string>;
    /** Whether 127.0.0.1:`port` is free to hand out now. */
    portFree(port: number): Effect.Effect<boolean>;
    /** Whether a server answers HTTP on 127.0.0.1:`port` at `path`, with any status. */
    answers(port: number, path: string): Effect.Effect<boolean>;
  }
>()("cairn/server/reach/PortalUnits") {
  /** `systemd-run --user` and `systemctl --user` through the ambient spawner. */
  static readonly layerNoDeps = Layer.effect(
    PortalUnits,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      /** Runs one command; answers its exit code and output, failing only when it could not run. */
      const run = (
        operation: string,
        unit: string,
        command: string,
        args: ReadonlyArray<string>
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, [...args], {
                env: commandEnv(),
                extendEnv: true,
                stdin: "ignore",
              })
            );

            const [stdout, stderr] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
              ],
              { concurrency: 2 }
            );

            const exitCode = yield* handle.exitCode;

            return { exitCode: Number(exitCode), stdout, stderr };
          })
        ).pipe(
          Effect.mapError(
            (cause) =>
              new PortalUnitError({
                message: `PortalUnits could not run ${command} for ${operation} of ${unit}: ${cause.message}. Check that systemd's user manager is running for this user.`,
                operation,
                unit,
                detail: cause.message,
                cause,
              })
          ),
          Effect.timeoutOrElse({
            duration: COMMAND_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new PortalUnitError({
                  message: `${command} ${operation} of ${unit} did not finish within ${Duration.format(COMMAND_TIMEOUT)}. Inspect it with systemctl --user status ${unit}.`,
                  operation,
                  unit,
                  detail: "",
                })
              ),
          })
        );

      const start = Effect.fn("PortalUnits.start")(function* (spec: UnitSpec) {
        const result = yield* run(
          "start",
          spec.unit,
          "systemd-run",
          systemdRunArgs(spec)
        );

        if (result.exitCode !== 0) {
          return yield* refused("start", spec.unit, result);
        }

        return yield* Effect.void;
      });

      const isActive = Effect.fn("PortalUnits.isActive")(function* (
        unit: string
      ) {
        // `is-active` exits non-zero for every state but active; its stdout names the state.
        const result = yield* run("is-active", unit, "systemctl", [
          "--user",
          "is-active",
          `${unit}.service`,
        ]);

        return RUNNING_STATES.has(result.stdout.trim());
      });

      const stop = Effect.fn("PortalUnits.stop")(function* (unit: string) {
        const result = yield* run("stop", unit, "systemctl", [
          "--user",
          "stop",
          `${unit}.service`,
        ]);

        if (result.exitCode !== 0 && result.exitCode !== EXIT_NOT_LOADED) {
          return yield* refused("stop", unit, result);
        }

        return yield* Effect.void;
      });

      const list = Effect.fn("PortalUnits.list")(function* (prefix: string) {
        const result = yield* run("list", `${prefix}*`, "systemctl", [
          "--user",
          "list-units",
          "--all",
          "--plain",
          "--no-legend",
          "--type=service",
          `${prefix}*`,
        ]);

        if (result.exitCode !== 0) {
          return yield* refused("list", `${prefix}*`, result);
        }

        return unitsOfListing(result.stdout).filter((name) =>
          name.startsWith(prefix)
        );
      });

      const journal = (unit: string, lines: number) =>
        run("journal", unit, "journalctl", [
          "--user",
          `--unit=${unit}.service`,
          `--lines=${String(lines)}`,
          "--no-pager",
          "--output=cat",
        ]).pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.orElseSucceed(() => "")
        );

      return PortalUnits.of({
        start,
        isActive,
        stop,
        list,
        journal,
        portFree: bindable,
        answers: answersHttp,
      });
    })
  );

  /** With Node's spawner. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(NodeServices.layer)
  );
}
