// systemd user units for judges: start the brain (or anything) as a transient unit, kill its main
// process the way a crash would, and list what is left in its cgroup. The cgroup method is
// `judges/relay-orphans.sh`'s: a process is an orphan when it is alive and no longer in the unit's
// cgroup, because then stopping the unit no longer reaches it.
//
//   const unit = yield* Unit.start({ name: "cairn-judge-1", command: ["node", "apps/server/src/judge-main.ts"],
//     properties: Unit.brainProperties, env: { CAIRN_PORT: "0" } })
//   yield* Unit.killMain(unit)                       // systemctl --user kill --kill-whom=main -s KILL
//
// Every function shells out to `systemctl --user`, `systemd-run --user` or `journalctl --user` with
// argv only, and reads `/sys/fs/cgroup` and `/proc`. No sudo.

import { existsSync } from "node:fs";

import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class UnitError extends Schema.TaggedError<UnitError>()("UnitError", {
  unit: Schema.String,
  operation: Schema.String,
  /** What the command printed on stderr, trimmed; unit commands print no secrets. */
  detail: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `Unit ${this.operation} failed for ${this.unit}: ${this.detail || "no output"}. Inspect it with systemctl --user status ${this.unit}.`;
  }
}

/**
 * The transient-unit properties the brain's judges use (plan D48 and `ops/cairn/cairn.service`): a
 * crash restarts the brain at once and never trips the start limit, and SIGTERM reaches only the
 * main process.
 */
export const brainProperties = {
  Restart: "always",
  RestartSec: "100ms",
  StartLimitIntervalSec: "0",
  KillMode: "mixed",
  KillSignal: "SIGTERM",
  TimeoutStopSec: "30",
  SuccessExitStatus: "130",
} as const satisfies Readonly<Record<string, string>>;

export interface StartOptions {
  /**
   * The unit name without `.service`: `cairn-judge-<role>-<pid>[-<suffix>]`, where pid is the
   * judge's own process id and the suffix is digits or hex. The pid lets a later judge stop a unit
   * whose judge died without cleaning up (`sweepOrphans`).
   */
  readonly name: string;
  readonly command: readonly [string, ...Array<string>];
  readonly cwd?: string;
  /** Set in the unit's environment with `--setenv`, nothing else is inherited. */
  readonly env?: Readonly<Record<string, string>>;
  readonly properties?: Readonly<Record<string, string>>;
  /**
   * How long the unit may live, in systemd's time syntax; a timer stops it then even if the judge
   * died. `RuntimeMaxSec` would not do: under `Restart=always` systemd restarts a unit that hits it.
   * Default `LIFETIME`.
   */
  readonly lifetime?: string;
}

/** The default lifetime: longer than any judge's longest window set. */
export const LIFETIME = "90min";

// `cairn-judge-durability-1234-2.service`: the role has no digits, so the first digit run is the pid.
const JUDGE_UNIT =
  /^(?<name>cairn-judge-[a-z-]+-(?<pid>\d+)(?:-[\da-f]+)?)\.service$/u;

/** The timer that stops `unit` when its lifetime runs out. */
const reaperOf = (unit: string) => `${unit}-reaper`;

export interface Process {
  readonly pid: number;
  /** The command line, arguments joined by spaces. */
  readonly command: string;
}

const decoder = new TextDecoder();

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => "")
  );

/** Runs one command to its end; a non-zero exit fails with its stderr. Returns stdout. */
const run = Effect.fnUntraced(
  function* (
    unit: string,
    operation: string,
    command: string,
    args: ReadonlyArray<string>
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(ChildProcess.make(command, args));

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" }
    );

    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* new UnitError({
        unit,
        operation,
        detail: `exit ${exitCode}: ${stderr.trim().slice(0, 500)}`,
      });
    }

    return stdout;
  },
  Effect.scoped,
  (effect, unit, operation) =>
    Effect.catchTag(effect, "PlatformError", (cause) =>
      Effect.fail(
        new UnitError({ unit, operation, detail: cause.message, cause })
      )
    )
);

const systemctl = (
  unit: string,
  operation: string,
  args: ReadonlyArray<string>
) => run(unit, operation, "systemctl", ["--user", ...args]);

/** One property, as `systemctl --user show -P` prints it. */
export const show = (
  unit: string,
  property: string
): Effect.Effect<string, UnitError, ChildProcessSpawner.ChildProcessSpawner> =>
  systemctl(unit, `show ${property}`, ["show", "-P", property, unit]).pipe(
    Effect.map((value) => value.trim())
  );

const numberProperty = (unit: string, property: string) =>
  show(unit, property).pipe(Effect.map(Number));

/** The main process id; 0 when the unit is not running. */
export const mainPid = (unit: string) => numberProperty(unit, "MainPID");

/** How many times systemd restarted the unit; a crash counts, a `systemctl restart` does not. */
export const restarts = (unit: string) => numberProperty(unit, "NRestarts");

/** Changes on every start, so a judge can tell which run wrote a journal line. */
export const invocationId = (unit: string) => show(unit, "InvocationID");

export const activeState = (unit: string) => show(unit, "ActiveState");

export const stop = (unit: string) => systemctl(unit, "stop", ["stop", unit]);

/** Whether a process id is live; `/proc` has a folder for each. */
const isAlive = (pid: number) => Effect.sync(() => existsSync(`/proc/${pid}`));

/**
 * Stops every `cairn-judge-*` unit whose judge process is gone, as a judge killed outright leaves
 * its `Restart=always` brain and that brain's children running. Returns the units it stopped.
 */
export const sweepOrphans = Effect.gen(function* () {
  const listed = yield* systemctl("cairn-judge-*", "list-units", [
    "list-units",
    "--all",
    "--plain",
    "--no-legend",
    "--type=service",
    "cairn-judge-*",
  ]);

  const orphans = yield* Effect.filter(
    listed
      .split("\n")
      .map((line) => line.trim().split(/\s+/u)[0] ?? "")
      .flatMap((name) => {
        const groups = JUDGE_UNIT.exec(name)?.groups;

        return groups?.name === undefined || groups.pid === undefined
          ? []
          : [{ unit: groups.name, pid: Number(groups.pid) }];
      }),
    ({ pid }) =>
      Effect.map(isAlive(pid), (alive) => !alive && pid !== process.pid)
  );

  yield* Effect.forEach(orphans, ({ unit }) =>
    Effect.ignore(Effect.andThen(stop(unit), stop(`${reaperOf(unit)}.timer`)))
  );

  return orphans.map(({ unit }) => unit);
});

/**
 * Starts a transient service with `systemd-run --user --collect`, after sweeping the units of dead
 * judges. The unit is stopped when the scope closes, a timer stops it once its lifetime runs out
 * should the judge die first, and `--collect` removes it even when it failed.
 */
export const start = (
  options: StartOptions
): Effect.Effect<
  string,
  UnitError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> => {
  const args = [
    "--user",
    "--collect",
    "--quiet",
    `--unit=${options.name}`,
    ...Object.entries(options.properties ?? {}).map(
      ([key, value]) => `--property=${key}=${value}`
    ),
    ...Object.entries(options.env ?? {}).map(
      ([key, value]) => `--setenv=${key}=${value}`
    ),
    ...(options.cwd === undefined
      ? []
      : [`--working-directory=${options.cwd}`]),
    "--",
    ...options.command,
  ];

  const reaper = [
    "--user",
    "--collect",
    "--quiet",
    `--unit=${reaperOf(options.name)}`,
    `--on-active=${options.lifetime ?? LIFETIME}`,
    "--",
    "systemctl",
    "--user",
    "stop",
    `${options.name}.service`,
  ];

  return Effect.acquireRelease(
    Effect.ignore(sweepOrphans).pipe(
      Effect.andThen(run(options.name, "start", "systemd-run", args)),
      Effect.andThen(run(options.name, "reaper", "systemd-run", reaper)),
      Effect.as(options.name)
    ),
    (unit) =>
      Effect.ignore(stop(unit)).pipe(
        Effect.andThen(Effect.ignore(stop(`${reaperOf(unit)}.timer`)))
      )
  );
};

export const restart = (unit: string) =>
  systemctl(unit, "restart", ["restart", unit]);

/** Sends `signal` to the main process only, as a crash of the brain itself would look. */
export const killMain = (unit: string, signal = "KILL") =>
  systemctl(unit, `kill ${signal}`, [
    "kill",
    "--kill-whom=main",
    "-s",
    signal,
    unit,
  ]);

/** The unit's cgroup under `/sys/fs/cgroup`. */
export const cgroupPath = (unit: string) =>
  show(unit, "ControlGroup").pipe(
    Effect.map((group) => `/sys/fs/cgroup${group}`)
  );

const readOrEmpty = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.readFile(path).pipe(
      Effect.map((bytes) => Option.some(decoder.decode(bytes))),
      Effect.orElseSucceed(() => Option.none<string>())
    );
  });

const pidsIn = (text: string): ReadonlyArray<number> =>
  text
    .split(/\s+/u)
    .filter((part) => part !== "")
    .map(Number);

/** The command line of a live process; none once it has exited. */
export const commandOf = (pid: number) =>
  readOrEmpty(`/proc/${pid}/cmdline`).pipe(
    Effect.map(
      Option.map((cmdline) =>
        cmdline
          .split("\0")
          .filter((part) => part !== "")
          .join(" ")
      )
    )
  );

/** A PATH value's directories, in order, each once, without empty parts. */
export const pathDirectories = (path: string): ReadonlyArray<string> => [
  ...new Set(path.split(":").filter((part) => part !== "")),
];

/**
 * The directories of a live process's PATH, read from `/proc`; none once it has exited. Only PATH
 * is taken from the environment, which may hold secrets.
 */
export const pathOf = (pid: number) =>
  readOrEmpty(`/proc/${pid}/environ`).pipe(
    Effect.map(
      Option.map((environ) =>
        pathDirectories(
          environ
            .split("\0")
            .find((variable) => variable.startsWith("PATH="))
            ?.slice("PATH=".length) ?? ""
        )
      )
    )
  );

/** The PATH the user's login shell builds (`$SHELL -lc`), the toolchains a thread should see. */
export const loginPath = (shell: string) =>
  run("login shell", "read PATH", shell, ["-lc", 'printf %s "$PATH"']).pipe(
    Effect.map(pathDirectories)
  );

/** Every process in the unit's cgroup now, with its command line. */
export const processes = (
  unit: string
): Effect.Effect<
  ReadonlyArray<Process>,
  UnitError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const group = yield* cgroupPath(unit);

    const procs = yield* readOrEmpty(`${group}/cgroup.procs`);

    const pids = pidsIn(Option.getOrElse(procs, () => ""));

    const listed = yield* Effect.forEach(pids, (pid) =>
      commandOf(pid).pipe(
        Effect.map(Option.map((command) => ({ pid, command })))
      )
    );

    return listed.flatMap(Option.toArray);
  });

/** Every process descended from `pid` now, by `/proc/<pid>/task/<tid>/children`. */
export const descendants = (pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const found: Array<number> = [];

    let frontier: ReadonlyArray<number> = [pid];

    while (frontier.length > 0) {
      const next = yield* Effect.forEach(frontier, (parent) =>
        Effect.gen(function* () {
          const tasks = yield* fs
            .readDirectory(`/proc/${parent}/task`)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

          const children = yield* Effect.forEach(tasks, (task) =>
            readOrEmpty(`/proc/${parent}/task/${task}/children`)
          );

          return children.flatMap((text) =>
            pidsIn(Option.getOrElse(text, () => ""))
          );
        })
      );

      frontier = next.flat();

      found.push(...frontier);
    }

    return found;
  });

/**
 * Descendants of the main process that are not in the unit's cgroup. A process can ask systemd for
 * a scope of its own (Chrome does, over the session bus), and then stopping the unit misses it.
 */
export const escaped = (
  unit: string
): Effect.Effect<
  ReadonlyArray<Process>,
  UnitError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const main = yield* mainPid(unit);

    if (main === 0) {
      return [];
    }

    const inGroup = new Set((yield* processes(unit)).map(({ pid }) => pid));

    const outside = (yield* descendants(main)).filter(
      (pid) => !inGroup.has(pid)
    );

    const listed = yield* Effect.forEach(outside, (pid) =>
      commandOf(pid).pipe(
        Effect.map(Option.map((command) => ({ pid, command })))
      )
    );

    return listed.flatMap(Option.toArray);
  });

/** What an orphan count starts from: the cgroup's processes plus any that already escaped it. */
export const snapshot = (unit: string) =>
  Effect.all([processes(unit), escaped(unit)]).pipe(
    Effect.map(([inside, outside]) => [...inside, ...outside])
  );

/**
 * Processes recorded earlier (`before`) that are still alive but no longer in the unit's cgroup.
 * Zero is the pass: everything the unit started either ended or is still the unit's to stop.
 */
export const orphans = (
  unit: string,
  before: ReadonlyArray<Process>
): Effect.Effect<
  ReadonlyArray<Process>,
  UnitError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const now = new Set((yield* processes(unit)).map(({ pid }) => pid));

    const alive = yield* Effect.forEach(
      before.filter(({ pid }) => !now.has(pid)),
      ({ pid }) =>
        commandOf(pid).pipe(
          Effect.map(Option.map((command) => ({ pid, command })))
        )
    );

    return alive.flatMap(Option.toArray);
  });

/**
 * The unit's output for one invocation (`journalctl -o cat`), so lines from an earlier run never
 * pass for this one's. Pass the text to `Events.parseLines` for the brain's events.
 */
export const journal = (unit: string, invocation: string) =>
  run(unit, "journal", "journalctl", [
    "--user",
    "--no-pager",
    "--output=cat",
    `_SYSTEMD_INVOCATION_ID=${invocation}`,
  ]);
