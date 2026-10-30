// The kill judge of a goal's judge run (plan 5F, briefs note "Criteria and verdicts"): a judge brain
// (`fixtures/goal-kill/GoalBrain.ts`: a pi-durable Harness with the goals extension over a scratch
// SQLite store and folder, never the deployed unit) is run one life at a time and killed with
// SIGKILL at each window of a `goal_check` and its judge run. However it dies, one check must yield
// one judge run, one verdict (one try), one note to the thread's model, and the criterion met.
//
//   node judges/goal-kill.ts [--case <name>]... [--keep]
//
// Cases (default: all):
// - no-kill: the check and its run, nothing killed: the command ran once.
// - queued: killed after `goal_check`'s commit created the run, before the tool's result; the
//   tool's rerun finds its run, so one run is indexed.
// - in-command: killed while the judge's command runs; the command runs again on the next life.
// - judged: killed after judging, before the run's completing commit; the command runs again.
// - after-commit: a clean life after the run settled: nothing runs again.
// - control: the broken control, the verdict committed apart from the run's end under a run id
//   minted per attempt, killed between the two. It records a second verdict on the rerun, so the
//   one-try check must fail on it, or the judge proves nothing.
//
// Prints one JSON line per case and a summary; exits 0 when every case passes and the control
// fails. No network, no model spend ($0): the faux provider answers.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Option, Schema } from "effect";

const root = path.join(import.meta.dirname, "..");

const brainScript = path.join(
  import.meta.dirname,
  "fixtures",
  "goal-kill",
  "GoalBrain.ts"
);

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    keep: { type: "boolean", default: false },
  },
});

const Report = Schema.Struct({
  event: Schema.Literal("report"),
  step: Schema.String,
  state: Schema.NullOr(Schema.String),
  tries: Schema.Int,
  runId: Schema.NullOr(Schema.String),
  notes: Schema.Int,
  queued: Schema.Int,
  ran: Schema.Int,
  settled: Schema.Boolean,
});

type Report = typeof Report.Type;

const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(Report));

/** How one life ended. */
interface Life {
  readonly step: string;
  readonly killed: boolean;
  readonly code: number | null;
  readonly report: Option.Option<Report>;
  readonly stderr: string;
}

/** Lines in the run's `runs` file: how many times the judge's command started. */
const ranIn = (dir: string) => {
  const file = path.join(dir, "runs");

  return existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line !== "").length
    : 0;
};

/**
 * One life of the judge brain over `dir`. With `killWhenRan`, the judge kills it once the command
 * has started that many times.
 */
const life = (
  dir: string,
  step: string,
  extra: ReadonlyArray<string> = [],
  killWhenRan: Option.Option<number> = Option.none()
) =>
  Effect.callback<Life>((resume) => {
    const child = spawn(
      process.execPath,
      [brainScript, "--dir", dir, "--step", step, ...extra],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    // Polls for the command to have started, then kills the life inside it.
    const watch = Option.map(killWhenRan, (times) =>
      setInterval(() => {
        if (ranIn(dir) >= times) {
          child.kill("SIGKILL");
        }
      }, 10)
    );

    const unwatch = () => {
      Option.map(watch, clearInterval);
    };

    child.once("exit", (code, signal) => {
      unwatch();

      const lines = stdout.split("\n").filter((line) => line.trim() !== "");

      resume(
        Effect.succeed({
          step,
          killed: signal === "SIGKILL",
          code,
          report: Option.firstSomeOf(
            lines.toReversed().map((line) => decodeReport(line))
          ),
          stderr: stderr.slice(-2000),
        })
      );
    });

    return Effect.sync(() => {
      unwatch();
      child.kill("SIGKILL");
    });
  });

/** What a check found wrong; empty when it held. */
type Problems = Array<string>;

/** Each life's outcome, per case. */
const seen: Array<string> = [];

/** One check, one run, one verdict, one note, the criterion met; `ran` times the command started. */
const once =
  (ran: number) =>
  (report: Report): Problems =>
    [
      [report.settled, "never came to rest"],
      [report.state === "met", `state ${String(report.state)}`],
      [report.tries === 1, `${report.tries} verdicts recorded`],
      [report.notes === 1, `${report.notes} verdict notes`],
      [report.queued === 1, `${report.queued} judge runs indexed`],
      [
        report.ran === ran,
        `the command ran ${report.ran} times, expected ${ran}`,
      ],
    ].flatMap(([held, text]) => (held === true ? [] : [String(text)]));

const check = (
  lived: Life,
  problems: Problems,
  judge: (report: Report) => Problems
) => {
  if (Option.isNone(lived.report)) {
    problems.push(
      `${lived.step}: no report (exit ${String(lived.code)}${lived.killed ? ", killed" : ""}): ${lived.stderr}`
    );

    return;
  }

  const report = lived.report.value;

  seen.push(`${lived.step}:${String(report.state)}/${report.tries}`);
  problems.push(...judge(report).map((text) => `${lived.step}: ${text}`));
};

const killed = (lived: Life, problems: Problems) => {
  if (!lived.killed) {
    problems.push(
      `${lived.step}: expected a kill, exited ${String(lived.code)}: ${lived.stderr}`
    );
  }

  seen.push(`${lived.step}:killed`);
};

/** The goal thread made, its setup life ended cleanly. */
const setup = (dir: string, problems: Problems) =>
  Effect.gen(function* () {
    const lived = yield* life(dir, "setup");

    if (lived.code !== 0) {
      problems.push(`setup: exit ${String(lived.code)}: ${lived.stderr}`);
    }
  });

interface Case {
  readonly name: string;
  readonly run: (dir: string, problems: Problems) => Effect.Effect<void>;
  /** The broken control: it must fail. */
  readonly control?: boolean;
}

const CASES: ReadonlyArray<Case> = [
  {
    name: "no-kill",
    run: (dir, problems) =>
      Effect.gen(function* () {
        yield* setup(dir, problems);
        check(yield* life(dir, "check"), problems, once(1));
      }),
  },
  {
    name: "queued",
    run: (dir, problems) =>
      Effect.gen(function* () {
        yield* setup(dir, problems);
        killed(yield* life(dir, "check", ["--fault", "queued"]), problems);
        check(yield* life(dir, "boot"), problems, (report) =>
          // The run may have started its command before the kill: once or twice, never more.
          once(report.ran === 2 ? 2 : 1)(report)
        );
      }),
  },
  {
    name: "in-command",
    run: (dir, problems) =>
      Effect.gen(function* () {
        yield* setup(dir, problems);
        killed(yield* life(dir, "check", [], Option.some(1)), problems);
        check(yield* life(dir, "boot"), problems, once(2));
      }),
  },
  {
    name: "judged",
    run: (dir, problems) =>
      Effect.gen(function* () {
        yield* setup(dir, problems);
        killed(yield* life(dir, "check", ["--fault", "judged"]), problems);
        check(yield* life(dir, "boot"), problems, once(2));
      }),
  },
  {
    name: "after-commit",
    run: (dir, problems) =>
      Effect.gen(function* () {
        yield* setup(dir, problems);
        check(yield* life(dir, "check"), problems, once(1));
        check(yield* life(dir, "boot"), problems, once(1));
      }),
  },
  {
    name: "control",
    control: true,
    run: (dir, problems) =>
      Effect.gen(function* () {
        const split = ["--control", "split"];

        yield* setup(dir, problems);
        killed(
          yield* life(dir, "check", [...split, "--fault", "judged"]),
          problems
        );
        check(yield* life(dir, "boot", split), problems, once(2));
      }),
  },
];

const program = Effect.gen(function* () {
  const wanted = values.case ?? CASES.map((spec) => spec.name);
  const base = mkdtempSync(path.join(tmpdir(), "cairn-goal-kill-"));
  const results: Array<{ name: string; pass: boolean; control: boolean }> = [];

  for (const spec of CASES.filter((found) => wanted.includes(found.name))) {
    const dir = path.join(base, spec.name);
    const problems: Problems = [];
    const started = performance.now();

    mkdirSync(dir, { recursive: true });
    seen.length = 0;

    yield* spec.run(dir, problems);

    const control = spec.control === true;
    const pass = control ? problems.length > 0 : problems.length === 0;

    results.push({ name: spec.name, pass, control });
    yield* Console.log(
      JSON.stringify({
        case: spec.name,
        control,
        pass,
        problems,
        lives: [...seen],
        ms: Math.round(performance.now() - started),
      })
    );
  }

  if (!values.keep) {
    rmSync(base, { recursive: true, force: true });
  }

  const windows = results.filter((result) => !result.control);

  yield* Console.log(
    JSON.stringify({
      summary: "goal-kill",
      windows: `${windows.filter((result) => result.pass).length} of ${windows.length}`,
      controlFailed: results
        .filter((result) => result.control)
        .every((result) => result.pass),
      kept: values.keep ? base : null,
    })
  );

  if (results.some((result) => !result.pass)) {
    process.exitCode = 1;
  }
});

NodeRuntime.runMain(program);
