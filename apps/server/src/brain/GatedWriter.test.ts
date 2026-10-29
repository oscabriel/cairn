// The briefs note's probe 2 kept as a test (ADR 0031): a gated writer is a replay-safe tool that
// waits for its approval, commits an effect mark, then runs its effect, so `kill -9` at any point
// never runs the effect twice. Each case runs `fixtures/gated-writer-brain.ts` (pi-durable over a
// SQLite file, the production gated `bash`) in its own process and kills it for real:
//
// - full access, killed after the mark and before the effect: the rerun says "may have run", and
//   the command never ran;
// - full access, killed after the effect: the rerun says "may have run", and the command ran once;
// - Supervised, killed while the call waits for its approval (kill one), resumed and accepted, then
//   killed by the command after its effect (kill two): the command ran once, and the last rerun
//   says "may have run".
//
// The broken control (a replay-safe `bash` with no mark) must fail the same checks: its rerun runs
// the command again.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Option, Schema } from "effect";

import { MAY_HAVE_RUN } from "./Permissions.ts";

const fixture = path.join(
  import.meta.dirname,
  "fixtures",
  "gated-writer-brain.ts"
);

const FixtureLine = Schema.Union([
  Schema.Struct({ event: Schema.Literal("pending") }),
  Schema.Struct({
    event: Schema.Literal("done"),
    results: Schema.Array(Schema.String),
  }),
]);

const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(FixtureLine)
);

/** How one fixture process ended: killed or not, and the lines it printed. */
interface Ended {
  readonly killed: boolean;
  readonly results: Option.Option<ReadonlyArray<string>>;
}

/**
 * Runs the fixture with `args`; with `killOnPending`, sends it SIGKILL once it prints that the call
 * waits for its approval.
 */
const runFixture = (
  dir: string,
  args: ReadonlyArray<string>,
  command: string,
  killOnPending = false
) =>
  Effect.callback<Ended>((resume) => {
    const child = spawn(process.execPath, [fixture, dir, ...args], {
      env: { ...process.env, CAIRN_FIXTURE_COMMAND: command },
      stdio: ["ignore", "pipe", "inherit"],
    });

    let results = Option.none<ReadonlyArray<string>>();
    let buffered = "";

    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf-8");

      const lines = buffered.split("\n");

      buffered = lines.pop() ?? "";

      for (const line of lines) {
        const decoded = decodeLine(line);

        if (Option.isSome(decoded) && decoded.value.event === "done") {
          results = Option.some(decoded.value.results);
        }

        if (
          killOnPending &&
          Option.isSome(decoded) &&
          decoded.value.event === "pending"
        ) {
          child.kill("SIGKILL");
        }
      }
    });

    child.on("exit", (_code, signal) => {
      resume(Effect.succeed({ killed: signal === "SIGKILL", results }));
    });

    return Effect.sync(() => {
      child.kill("SIGKILL");
    });
  }).pipe(
    // A fixture that hangs is killed by the finalizer above, and the case fails.
    Effect.timeout(Duration.seconds(30)),
    Effect.orDie
  );

const runsIn = (dir: string) => {
  try {
    return readFileSync(path.join(dir, "runs.log"), "utf-8")
      .split("\n")
      .filter((line) => line !== "").length;
  } catch {
    return 0;
  }
};

/** Kills the brain from inside the command, once, then ends the command at once. */
const killOnce = (dir: string) =>
  `[ -e ${dir}/killed ] || { touch ${dir}/killed; kill -9 $(cat ${dir}/brain.pid); kill -9 $$; }`;

/** The effect: one line in `runs.log` per run of the command. */
const effect = (dir: string) => `echo ran >> ${dir}/runs.log`;

/** What one case observed after its last resume. */
interface Observed {
  readonly kills: number;
  readonly runs: number;
  readonly mayHaveRun: boolean;
}

const observe = (
  dir: string,
  kills: ReadonlyArray<Ended>,
  last: Ended
): Observed => ({
  kills: kills.filter((ended) => ended.killed).length,
  runs: runsIn(dir),
  mayHaveRun: Option.exists(last.results, (results) =>
    results.some((text) => text === MAY_HAVE_RUN)
  ),
});

const scratch = () => mkdtempSync(path.join(os.tmpdir(), "cairn-gated-"));

const control = (broken: boolean) => (broken ? ["control"] : []);

/** Full access, killed after the mark and before the effect. */
const afterMark = (broken: boolean) =>
  Effect.gen(function* () {
    const dir = scratch();
    const command = `${killOnce(dir)}; ${effect(dir)}`;

    const killed = yield* runFixture(
      dir,
      ["run", "full-access", ...control(broken)],
      command
    );

    const last = yield* runFixture(
      dir,
      ["resume", ...control(broken)],
      command
    );

    return observe(dir, [killed], last);
  });

/** Full access, killed after the effect. */
const afterEffect = (broken: boolean) =>
  Effect.gen(function* () {
    const dir = scratch();
    const command = `${effect(dir)}; ${killOnce(dir)}`;

    const killed = yield* runFixture(
      dir,
      ["run", "full-access", ...control(broken)],
      command
    );

    const last = yield* runFixture(
      dir,
      ["resume", ...control(broken)],
      command
    );

    return observe(dir, [killed], last);
  });

/** Supervised: killed during the wait, accepted after the restart, killed after the effect. */
const twoKills = (broken: boolean) =>
  Effect.gen(function* () {
    const dir = scratch();
    const command = `${effect(dir)}; ${killOnce(dir)}`;

    const waiting = yield* runFixture(
      dir,
      ["run", "approval-required", ...control(broken)],
      command,
      true
    );

    const accepted = yield* runFixture(
      dir,
      ["resume", "accept", ...control(broken)],
      command
    );

    const last = yield* runFixture(
      dir,
      ["resume", ...control(broken)],
      command
    );

    return observe(dir, [waiting, accepted], last);
  });

describe("a gated writer across kill -9 (probe 2)", () => {
  it.live(
    "after the mark: may have run, and the effect never ran",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* afterMark(false), {
          kills: 1,
          runs: 0,
          mayHaveRun: true,
        });

        const broken = yield* afterMark(true);

        assert.notDeepEqual(broken, { kills: 1, runs: 0, mayHaveRun: true });
        assert.strictEqual(broken.runs, 1, "the control reruns the command");
      }),
    60_000
  );

  it.live(
    "after the effect: may have run, and the effect ran once",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* afterEffect(false), {
          kills: 1,
          runs: 1,
          mayHaveRun: true,
        });

        const broken = yield* afterEffect(true);

        assert.strictEqual(broken.runs, 2, "the control reruns the command");
      }),
    60_000
  );

  it.live(
    "two kills in Supervised, one during the wait and one after the effect: the effect ran once",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* twoKills(false), {
          kills: 2,
          runs: 1,
          mayHaveRun: true,
        });

        const broken = yield* twoKills(true);

        assert.strictEqual(broken.kills, 2);
        assert.strictEqual(broken.runs, 2, "the control reruns the command");
      }),
    60_000
  );
});
