// ADR 0030's gate: Go is the commit that starts the child. A judge brain
// (`fixtures/brief-go/GoBrain.ts`: the production seam, brain and subagents extension over a
// scratch data folder and git repository, never the deployed unit) is run one life at a time, and
// killed with SIGKILL before, inside and after the Go commit and at each step of the child's start.
// However it dies, a brief must yield one worktree, one workspace plan, one child conversation, one
// first input and one answer to the parent, or, declined, none of them. Promoted from the briefs
// note's probe 1 (docs/phase-2/notes/briefs.md), on the real code.
//
//   node judges/brief-go.ts [--case <name>]... [--keep]
//
// Cases (default: all):
// - no-kill: Go, nothing killed.
// - before-go: killed with the brief pending; Go after the restart.
// - inside-commit: killed inside the Go commit: still pending, no start task, nothing made.
// - go-again: the same brief, Go again after that: one child.
// - after-commit: killed after the Go commit, before the start task ran.
// - after-prepare: killed after the worktree was made, before the creating commit.
// - after-child: killed after the creating commit, before the first input.
// - after-input: killed after the first input was submitted.
// - race: Go, Decline and Go at once: one answer takes effect.
// - decline: Decline: nothing made, the parent told once.
// - parked: killed at the top of the start five times in a row: the task parks, a clean boot does
//   not retry it (ADR 0030), and a human Retry starts the child once.
// - control: the broken control, an answer that commits Go without its start, killed before a
//   second commit would create it. Its brief is accepted and never starts, so the one-child check
//   must fail on it, or the judge proves nothing.
//
// Prints one JSON line per case and a summary; exits 0 when every case passes and the control
// fails. No network, no model spend ($0): the faux provider answers.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Option, Schema } from "effect";

const root = path.join(import.meta.dirname, "..");

const brainScript = path.join(
  import.meta.dirname,
  "fixtures",
  "brief-go",
  "GoBrain.ts"
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
  status: Schema.String,
  started: Schema.NullOr(Schema.String),
  worktrees: Schema.Int,
  plans: Schema.Int,
  children: Schema.Int,
  inputs: Schema.Array(Schema.Int),
  told: Schema.Int,
  starts: Schema.Array(
    Schema.Struct({
      status: Schema.String,
      inspected: Schema.String,
      reason: Schema.NullOr(Schema.String),
    })
  ),
  rested: Schema.Boolean,
});

type Report = typeof Report.Type;

const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(Report));

/** How one life ended: its exit, whether a planted fault or `--die` killed it, and its report. */
interface Life {
  readonly step: string;
  readonly killed: boolean;
  readonly code: number | null;
  readonly report: Option.Option<Report>;
  readonly stderr: string;
}

/** One life of the judge brain over `dir`. */
const life = (dir: string, step: string, extra: ReadonlyArray<string> = []) =>
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
    child.once("exit", (code, signal) => {
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
      child.kill("SIGKILL");
    });
  });

/** A run folder with a repository holding one commit on `main`. */
const freshRun = (base: string, name: string) =>
  Effect.sync(() => {
    const dir = path.join(base, name);
    const repo = path.join(dir, "repo");

    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, "README.md"), "helo\n");

    const git = (args: ReadonlyArray<string>) =>
      spawnSync(
        "git",
        [
          "-c",
          "user.name=brief-go",
          "-c",
          "user.email=brief-go@loopback",
          ...args,
        ],
        { cwd: repo, stdio: "ignore" }
      );

    git(["init", "--quiet", "-b", "main"]);
    git(["add", "README.md"]);
    git(["commit", "--quiet", "-m", "init"]);

    return dir;
  });

/** What a check found wrong; empty when it held. */
type Problems = Array<string>;

/** A life that must find nothing happening waits this long, in seconds, not thirty. */
const QUIET = ["--wait", "3"];

/** Each life's outcome, per case, for the case's line: `<step>:<status>/<children>`. */
const seen: Array<string> = [];

const reportOf = (lived: Life, problems: Problems): Option.Option<Report> => {
  if (Option.isNone(lived.report)) {
    problems.push(
      `${lived.step}: no report (exit ${String(lived.code)}${lived.killed ? ", killed" : ""}): ${lived.stderr}`
    );
  }

  return lived.report;
};

/** A brief that started exactly one child, once, and told its parent once. */
const oneChild = (report: Report): Problems => {
  const problems: Problems = [];

  if (!report.rested) {
    problems.push("never came to rest");
  }

  if (report.status !== "accepted" || report.started === null) {
    problems.push(`status ${report.status}, started ${String(report.started)}`);
  }

  if (report.worktrees !== 1 || report.plans !== 1) {
    problems.push(`${report.worktrees} worktrees, ${report.plans} plans`);
  }

  if (report.children !== 1) {
    problems.push(`${report.children} child conversations`);
  }

  if (report.inputs.length !== 1 || report.inputs[0] !== 1) {
    problems.push(`child inputs ${JSON.stringify(report.inputs)}`);
  }

  if (report.told !== 1) {
    problems.push(`the parent was told ${report.told} times`);
  }

  if (report.starts.length > 1) {
    problems.push(`${report.starts.length} start tasks`);
  }

  return problems;
};

/** The words of each check that did not hold. */
const failing = (
  checks: ReadonlyArray<readonly [held: boolean, text: string]>
): Problems => checks.flatMap(([held, text]) => (held ? [] : [text]));

/** A brief that made nothing: no worktree, plan or child. */
const nothingMade = (report: Report): Problems =>
  failing([
    [
      report.worktrees === 0 && report.plans === 0 && report.children === 0,
      `${report.worktrees} worktrees, ${report.plans} plans, ${report.children} children`,
    ],
  ]);

/** Declined: nothing made, the parent told once. */
const declined = (report: Report): Problems => [
  ...failing([
    [report.status === "declined", `status ${report.status}`],
    [report.told === 1, `the parent was told ${report.told} times`],
  ]),
  ...nothingMade(report),
];

/** Still pending: no start task, nothing made, nothing told. */
const stillPending = (report: Report): Problems => [
  ...failing([
    [report.status === "pending", `status ${report.status}`],
    [report.starts.length === 0, `${report.starts.length} start tasks`],
    [report.told === 0, `the parent was told ${report.told} times`],
  ]),
  ...nothingMade(report),
];

/** Accepted, its start task parked by the crash-loop guard, nothing made. */
const parkedNow = (report: Report): Problems => [
  ...failing([
    [
      report.starts.length === 1 &&
        report.starts[0]?.inspected === "blocked" &&
        report.starts[0].reason === "restart_limit",
      `start tasks ${JSON.stringify(report.starts)}, expected one parked`,
    ],
    [report.status === "accepted", `status ${report.status}`],
  ]),
  ...nothingMade(report),
];

/** Expects `lived` to have been killed by its planted fault. */
const killed = (lived: Life, problems: Problems) => {
  if (!lived.killed) {
    problems.push(
      `${lived.step}: expected a kill, exited ${String(lived.code)}: ${lived.stderr}`
    );
  }
};

const check = (
  lived: Life,
  problems: Problems,
  judge: (report: Report) => Problems
) => {
  for (const report of Option.toArray(reportOf(lived, problems))) {
    seen.push(`${lived.step}:${report.status}/${report.children}`);
    problems.push(...judge(report).map((text) => `${lived.step}: ${text}`));
  }
};

/** Spawns a brief in `dir`, the parent's run ending normally. */
const spawned = (dir: string, problems: Problems, die = false) =>
  Effect.gen(function* () {
    const lived = yield* life(dir, "spawn", die ? ["--die"] : []);

    if (die) {
      killed(lived, problems);
    } else {
      check(lived, problems, (report) =>
        report.status === "pending" ? [] : [`status ${report.status}`]
      );
    }
  });

/** Go killed at `point`, then a clean boot that must bring one child. */
const killedAt = (point: string) => (dir: string, problems: Problems) =>
  Effect.gen(function* () {
    yield* spawned(dir, problems);
    killed(yield* life(dir, "go", ["--fault", point]), problems);
    check(yield* life(dir, "boot"), problems, oneChild);
  });

interface Case {
  readonly name: string;
  /** Runs the case in a fresh `dir`; fills `problems`. */
  readonly run: (dir: string, problems: Problems) => Effect.Effect<void>;
  /** The broken control: it must fail. */
  readonly control?: boolean;
}

const CASES: ReadonlyArray<Case> = [
  {
    name: "no-kill",
    run: (dir, problems) =>
      Effect.gen(function* () {
        yield* spawned(dir, problems);
        check(yield* life(dir, "go"), problems, oneChild);
      }),
  },
  {
    name: "before-go",
    run: (dir, problems) =>
      Effect.gen(function* () {
        yield* spawned(dir, problems, true);
        check(yield* life(dir, "boot", QUIET), problems, stillPending);
        check(yield* life(dir, "go"), problems, oneChild);
      }),
  },
  {
    name: "inside-commit",
    run: (dir, problems) =>
      Effect.gen(function* () {
        yield* spawned(dir, problems);
        killed(yield* life(dir, "go", ["--fault", "go-commit"]), problems);
        check(yield* life(dir, "boot", QUIET), problems, stillPending);
      }),
  },
  {
    name: "go-again",
    run: (dir, problems) =>
      Effect.gen(function* () {
        yield* spawned(dir, problems);
        killed(yield* life(dir, "go", ["--fault", "go-commit"]), problems);
        check(yield* life(dir, "go"), problems, oneChild);
      }),
  },
  { name: "after-commit", run: killedAt("start") },
  { name: "after-prepare", run: killedAt("prepared") },
  { name: "after-child", run: killedAt("created") },
  { name: "after-input", run: killedAt("submitted") },
  {
    name: "race",
    run: (dir, problems) =>
      Effect.gen(function* () {
        yield* spawned(dir, problems);
        check(yield* life(dir, "race"), problems, (report) =>
          report.status === "declined" ? declined(report) : oneChild(report)
        );
      }),
  },
  {
    name: "decline",
    run: (dir, problems) =>
      Effect.gen(function* () {
        yield* spawned(dir, problems);
        check(yield* life(dir, "decline"), problems, declined);
      }),
  },
  {
    name: "parked",
    run: (dir, problems) =>
      Effect.gen(function* () {
        const fault = ["--fault", "start", "--times", "5"];

        yield* spawned(dir, problems);

        let lived = yield* life(dir, "go", fault);
        let kills = lived.killed ? 1 : 0;

        // Each boot resumes the start task, which dies again, until the crash-loop guard parks it.
        while (lived.killed && kills < 8) {
          lived = yield* life(dir, "boot", fault);
          kills += lived.killed ? 1 : 0;
        }

        if (kills !== 5) {
          problems.push(
            `${kills} kills before the brain stayed up, expected 5`
          );
        }

        // The life that stayed up booted with the task parked; a second clean boot runs the
        // subagent boot retry again, which must leave it parked.
        check(lived, problems, parkedNow);
        check(yield* life(dir, "boot"), problems, parkedNow);
        check(yield* life(dir, "retry"), problems, oneChild);
      }),
  },
  {
    name: "control",
    control: true,
    run: (dir, problems) =>
      Effect.gen(function* () {
        yield* spawned(dir, problems);
        killed(yield* life(dir, "split"), problems);
        check(yield* life(dir, "boot", QUIET), problems, oneChild);
      }),
  },
];

const program = Effect.gen(function* () {
  const wanted = values.case ?? CASES.map((spec) => spec.name);
  const base = mkdtempSync(path.join(tmpdir(), "cairn-brief-go-"));
  const results: Array<{ name: string; pass: boolean; control: boolean }> = [];

  for (const spec of CASES.filter((found) => wanted.includes(found.name))) {
    const dir = yield* freshRun(base, spec.name);
    const problems: Problems = [];
    const started = performance.now();

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

  const windows = results.filter(
    (result) => !result.control && result.name !== "parked"
  );

  yield* Console.log(
    JSON.stringify({
      summary: "brief-go",
      windows: `${windows.filter((result) => result.pass).length} of ${windows.length}`,
      parked: results.some((result) => result.name === "parked" && result.pass),
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
