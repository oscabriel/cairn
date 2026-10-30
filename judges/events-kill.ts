// The durable events judge (ADR 0033, plan 1B, workflows note judge 5): a judge brain
// (`fixtures/events/EventsBrain.ts`, Cairn's `Brain` and reactor host over a store in a scratch
// directory, never the deployed unit) produces events while the judge `kill -9`s it, again and
// again, each kill a random 50 to 600 ms after the brain says it is producing. The last life runs
// to the end and writes its report.
//
//   node judges/events-kill.ts [--case kills|rotation|control]... [--kills N] [--total N] [--keep]
//
// Cases (default: all three):
// - kills: 12 kills, injected handler faults on all three reactors, one log.
// - rotation: 10 kills, faults, and the log rotating mid-run (two rotations).
// - control: the broken control, reactors that keep their cursor in memory; 4 kills, no faults.
//   It must fail by handling events more than once (and their tasks), with nothing missing and no
//   other fault, or the judge proves nothing.
//
// Per case it asserts: every event of each reactor's kinds was handled exactly once and nothing
// else was; `judge.spawn` created one task per event and each ran to its end once (its outside
// effect at least once, counted for the record); every reactor's lag is 0; faults were injected
// when asked; with rotation, the log moved on to the last month and every cursor is in that log.
// Prints one JSON line per case and a summary, and exits 0 when kills and rotation pass and the
// control fails for that reason alone.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Console, Duration, Effect, Option, Random, Result } from "effect";

const root = path.join(import.meta.dirname, "..");

const brainScript = path.join(
  import.meta.dirname,
  "fixtures",
  "events",
  "EventsBrain.ts"
);

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    kills: { type: "string" },
    total: { type: "string", default: "300" },
    keep: { type: "boolean", default: false },
  },
});

interface CaseSpec {
  readonly name: string;
  readonly kills: number;
  readonly faults: boolean;
  readonly rotate: boolean;
  readonly control: boolean;
}

const CASES: ReadonlyArray<CaseSpec> = [
  { name: "kills", kills: 12, faults: true, rotate: false, control: false },
  { name: "rotation", kills: 10, faults: true, rotate: true, control: false },
  { name: "control", kills: 4, faults: false, rotate: false, control: true },
];

/** The kinds each judge reactor handles, as `EventsBrain.ts` registers them. */
const REACTOR_EVENTS = {
  "judge.count": ["workflow.node.settled", "workflow.node.refused"],
  "judge.meter": ["workflow.node.settled"],
  "judge.spawn": ["workflow.node.settled", "workflow.node.stopped"],
} satisfies Record<string, ReadonlyArray<string>>;

/** What `EventsBrain.ts` writes to `report.json`. */
interface Report {
  readonly judge: {
    readonly emitted: number;
    readonly events: Readonly<Record<string, string>>;
    readonly handled: Readonly<
      Record<string, Readonly<Record<string, number>> | undefined>
    >;
    readonly created: Readonly<Record<string, number>>;
    readonly ran: Readonly<Record<string, number>>;
  };
  readonly events: {
    readonly logConversationId: number | null;
    readonly logMonth: string | null;
    readonly cursors: Readonly<
      Record<string, { readonly logConversationId: number }>
    >;
  };
  readonly status: ReadonlyArray<{
    readonly reactor: string;
    readonly lag: number;
  }>;
}

/** Starts one life of the judge brain. */
const startBrain = (dir: string, spec: CaseSpec, total: number) =>
  Effect.sync(() => {
    const args = [brainScript, "--dir", dir, "--total", String(total)];

    if (spec.faults) {
      args.push("--faults");
    }

    if (spec.rotate) {
      args.push("--rotate");
    }

    if (spec.control) {
      args.push("--control");
    }

    return spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
  });

/** Waits until the brain prints `line`; fails if it exits first or `timeout` passes. */
const waitForLine = (
  child: ChildProcess,
  line: string,
  timeout: Duration.Input
) =>
  Effect.callback<true, string>((resume) => {
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");

      if (buffer.split("\n").includes(line)) {
        resume(Effect.succeed(true));
      }
    };

    const onExit = (code: number | null) => {
      resume(
        Effect.fail(
          `the judge brain exited (${String(code)}) before printing "${line}"`
        )
      );
    };

    child.stdout?.on("data", onData);
    child.once("exit", onExit);

    return Effect.sync(() => {
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(`no "${line}" from the judge brain in the time allowed`),
    })
  );

/** `kill -9`, resolved once the process is gone. */
const killHard = (child: ChildProcess) =>
  Effect.callback<true>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(true));

      return;
    }

    child.once("exit", () => {
      resume(Effect.succeed(true));
    });
    child.kill("SIGKILL");
  });

const countLines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line !== "").length
    : 0;

/**
 * One failed check. `duplicate` is the failure the broken control must show (an event handled more
 * than once, and none missing or stray); `tasks` follows from it, since a twice-handled spawn event
 * creates a second task; anything else is `other`.
 */
interface Failure {
  readonly kind: "duplicate" | "tasks" | "other";
  readonly text: string;
}

/** A failure no report check made: the brain died, stalled or wrote no report. */
const lifeFailure = (text: string): Failure => ({ kind: "other", text });

/**
 * True when the control failed for the reason it exists: its cursors in memory replay events after
 * a kill. A control that crashed, timed out or lost events fails the judge instead.
 */
const controlFailedRightly = (failures: ReadonlyArray<Failure>) =>
  failures.some((failure) => failure.kind === "duplicate") &&
  failures.every((failure) => failure.kind !== "other");

/** Every failed check of one case's report; empty when it passed. */
const check = (
  spec: CaseSpec,
  report: Report,
  total: number,
  faults: number
) => {
  const failures: Array<Failure> = [];
  const other = (text: string) => failures.push({ kind: "other", text });
  const { judge, events } = report;
  const recorded = Object.entries(judge.events);

  if (judge.emitted !== total || recorded.length !== total) {
    other(
      `emitted ${judge.emitted} events and recorded ${recorded.length}, expected ${total}`
    );
  }

  for (const [name, kinds] of Object.entries(REACTOR_EVENTS)) {
    const expected = new Set(
      recorded.filter(([, kind]) => kinds.includes(kind)).map(([id]) => id)
    );

    const handled = Object.entries(judge.handled[name] ?? {});
    const twice = handled.filter(([, times]) => times !== 1);
    const stray = handled.filter(([id]) => !expected.has(id));
    const seen = new Set(handled.map(([id]) => id));
    const missing = [...expected].filter((id) => !seen.has(id));

    if (twice.length > 0 || missing.length > 0 || stray.length > 0) {
      const most = Math.max(0, ...twice.map(([, times]) => times));

      failures.push({
        kind:
          twice.length > 0 && missing.length === 0 && stray.length === 0
            ? "duplicate"
            : "other",
        text: `${name}: ${twice.length} handled more than once (up to ${most} times), ${missing.length} missing, ${stray.length} stray, of ${expected.size}`,
      });
    }
  }

  const spawned = recorded
    .filter(([, kind]) => REACTOR_EVENTS["judge.spawn"].includes(kind))
    .map(([id]) => id);

  const badCreate = spawned.filter((id) => judge.created[id] !== 1);
  const badRun = spawned.filter((id) => judge.ran[id] !== 1);

  if (badCreate.length > 0 || badRun.length > 0) {
    failures.push({
      kind: "tasks",
      text: `tasks: ${badCreate.length} not created exactly once and ${badRun.length} not run exactly once, of ${spawned.length}`,
    });
  }

  const lagging = report.status.filter((each) => each.lag !== 0);

  if (!spec.control && lagging.length > 0) {
    other(
      `lag not zero: ${lagging.map((each) => `${each.reactor} ${each.lag}`).join(", ")}`
    );
  }

  if (spec.faults && faults === 0) {
    other("no handler fault was injected");
  }

  if (spec.rotate) {
    const behind = Object.entries(events.cursors).filter(
      ([, cursor]) => cursor.logConversationId !== events.logConversationId
    );

    if (events.logMonth !== "2999-11") {
      other(`the log covers ${String(events.logMonth)}, not 2999-11`);
    }

    if (behind.length > 0) {
      other(
        `cursors left in an old log: ${behind.map(([name]) => name).join(", ")}`
      );
    }
  }

  return failures;
};

/** One case: the kills, the last life, the checks. */
const runCase = Effect.fn("events-kill.case")(function* (spec: CaseSpec) {
  const total = Number(values.total);
  const kills = values.kills === undefined ? spec.kills : Number(values.kills);

  const dir = mkdtempSync(
    path.join(tmpdir(), `cairn-events-kill-${spec.name}-`)
  );

  const started = Date.now();
  const reportFile = path.join(dir, "report.json");
  let landed = 0;

  // The events each killed life had emitted before it started, to show the kills spread.
  const startedAt: Array<number> = [];

  for (let life = 0; life < kills; life += 1) {
    const child = yield* startBrain(dir, spec, total);
    const output: Array<string> = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("utf-8"));
    });

    const ready = yield* Effect.result(
      waitForLine(child, "producing", "60 seconds")
    );

    if (Result.isFailure(ready)) {
      yield* killHard(child);

      // The brain finished before this life: nothing is left to interrupt.
      if (existsSync(reportFile)) {
        break;
      }

      return {
        case: spec.name,
        pass: false,
        failures: [lifeFailure(ready.failure)],
        dir,
      };
    }

    const delay = yield* Random.nextIntBetween(50, 600);

    yield* Effect.sleep(Duration.millis(delay));
    yield* killHard(child);
    landed += 1;

    const from = /^from (?<emitted>\d+)$/mu.exec(output.join(""));

    startedAt.push(Number(from?.groups?.emitted ?? -1));
  }

  const last = yield* startBrain(dir, spec, total);
  const done = yield* Effect.result(waitForLine(last, "done", "180 seconds"));

  yield* killHard(last);

  if (Result.isFailure(done) || !existsSync(reportFile)) {
    const failure = Result.isFailure(done) ? done.failure : "no report";

    return {
      case: spec.name,
      pass: false,
      failures: [lifeFailure(failure)],
      dir,
    };
  }

  // SAFETY: `report.json` is written by `EventsBrain.ts` in this run, from the `Report` shape.
  // Verified by: this judge (a report missing a field fails its checks, never passes them)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const report = JSON.parse(readFileSync(reportFile, "utf-8")) as Report;

  const faults = countLines(path.join(dir, "faults.log"));
  const effects = countLines(path.join(dir, "effects.log"));
  const failures = check(spec, report, total, faults);

  if (!values.keep) {
    rmSync(dir, { recursive: true, force: true });
  }

  return {
    case: spec.name,
    pass: failures.length === 0,
    kills: landed,
    emittedBeforeEachKilledLife: startedAt,
    events: report.judge.emitted,
    handled: Object.fromEntries(
      Object.entries(report.judge.handled).map(([name, counts]) => [
        name,
        Object.keys(counts ?? {}).length,
      ])
    ),
    tasks: Object.keys(report.judge.ran).length,
    outsideEffects: effects,
    faultsInjected: faults,
    logMonth: report.events.logMonth,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    failures,
    dir: values.keep ? dir : "removed",
  };
});

const program = Effect.gen(function* () {
  const names = values.case ?? CASES.map((spec) => spec.name);
  let ok = true;

  for (const name of names) {
    const spec = Option.fromUndefinedOr(
      CASES.find((candidate) => candidate.name === name)
    );

    if (Option.isNone(spec)) {
      yield* Console.log(`${name}: not a case (kills, rotation or control)`);
      ok = false;
      continue;
    }

    const result = yield* runCase(spec.value);

    yield* Console.log(JSON.stringify(result));

    // The control proves the judge can fail: it must fail, and for the reason it exists.
    ok &&= spec.value.control
      ? controlFailedRightly(result.failures)
      : result.pass;
  }

  yield* Console.log(JSON.stringify({ summary: ok ? "pass" : "fail" }));

  if (!ok) {
    process.exitCode = 1;
  }
});

NodeRuntime.runMain(program);
