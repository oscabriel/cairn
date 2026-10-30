// Budget enforcement for workflows (workflows note judge 4, plan 5B, ADR 0036): a judge brain
// (`fixtures/workflows/BudgetBrain.ts`, Cairn's Brain and reactor host over SQLite in a scratch
// directory, never the deployed unit) runs a fan-out of twenty-four faux nodes, eight at once,
// against a token line, while this judge `kill -9`s it at named moments: mid fan-out, as the soft
// line fires, as the hard line fires, while the stopper stops nodes, three times in one run, and
// between a node's submit and the commit that marks it submitted, its rerun held until the line.
//
//   node judges/workflow-budget.ts [--case <name>]... [--keep]
//
// Every case checks, from the brain's report and from `effects.log` (written outside the store by
// each node child's `work` call, with the wall time):
//
// - lines: `workflow.budget.soft` and `workflow.budget.spent` each fired once, one stopper task was
//   created and one raise asked (cancelled when the run ended);
// - admission: no node reserved after the line was reached was dispatched, and some were refused
//   `budget_spent`;
// - bound: nodes dispatched are at most ceil(line / tokens per node) + 8 (the run's concurrency),
//   tokens per node being the median of the nodes that settled;
// - abort: some node was stopped, and no node's work finished more than half a second after the
//   line (a 6 s node running at the line never finishes);
// - outcome: the run finished `partial`, `budget_spent`, and the script read `remaining() === 0`;
// - once: every dispatched row has one child, no label two rows or two starts of its work, and every
//   row names an accepted brief.
//
// Two broken controls must fail for their reason: `control-no-admission` (the reserve commit never
// refuses at the line) fails admission or the bound, `control-no-stopper` (no budget reactor, so
// nothing stops the running nodes) fails abort.
//
// Prints one JSON line per case and a summary; exits 0 when every case passes and both controls
// fail rightly. No model, no network, no secrets, no cost.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Console, Duration, Effect, Option, Result } from "effect";

const root = path.join(import.meta.dirname, "..");

const fixtures = path.join(import.meta.dirname, "fixtures", "workflows");

const brainScript = path.join(fixtures, "BudgetBrain.ts");

const workflowScript = path.join(fixtures, "budget.workflow");

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    keep: { type: "boolean", default: false },
  },
});

/** The token line: about ten nodes' worth, so the line falls while the first waves run. */
const MAX_TOKENS = 60_000;

/** Nodes one workflow runs at once (`MAX_CONCURRENT_NODES`, the envelope's default). */
const MAX_CONCURRENT = 8;

/** How long after the line a node's work may still finish: the time to see the line and stop. */
const ABORT_SLACK_MILLIS = 500;

/** A failed check's kind: the controls must fail with theirs. */
type Kind = "lines" | "admission" | "bound" | "abort" | "outcome" | "once";

interface Failure {
  readonly kind: Kind | "life";
  readonly text: string;
}

/** A failure no report check made: the brain died, stalled or wrote no report. */
const lifeFailure = (text: string): Failure => ({ kind: "life", text });

/** One life of the brain: its arguments, and the line after which it is killed (none: the last). */
interface Life {
  /** The brain's extra arguments in this life (its holds). */
  readonly args: ReadonlyArray<string>;
  readonly killOn: Option.Option<{
    readonly line: string;
    readonly delayMs: number;
  }>;
}

interface CaseSpec {
  readonly name: string;
  readonly lives: ReadonlyArray<Life>;
  readonly control: Option.Option<"no-admission" | "no-stopper">;
}

const life = (
  line?: string,
  delayMs = 0,
  args: ReadonlyArray<string> = []
): Life => ({
  args,
  killOn: Option.map(Option.fromUndefinedOr(line), (seen) => ({
    line: seen,
    delayMs,
  })),
});

const CASES: ReadonlyArray<CaseSpec> = [
  { name: "plain", lives: [life()], control: Option.none() },
  {
    name: "kill-fanout",
    lives: [life("node n2 settled"), life()],
    control: Option.none(),
  },
  {
    name: "kill-at-soft",
    lives: [life("soft"), life()],
    control: Option.none(),
  },
  {
    name: "kill-at-spent",
    lives: [life("spent"), life()],
    control: Option.none(),
  },
  {
    name: "kill-in-stop",
    lives: [life("spent", 40), life()],
    control: Option.none(),
  },
  {
    name: "kill-thrice",
    lives: [
      life("node n1 running", 30),
      life("soft"),
      life("spent", 15),
      life(),
    ],
    control: Option.none(),
  },
  // n1 (a 6 s node) is killed after its child took its input, before its row says so. Its rerun
  // waits until the line, so it finds the row at `child_created` with the run at its line, and the
  // reactor host starts late, so the stopper comes after it. Settling n1 there without waiting
  // for its child would leave the child working past the line, with nothing left to stop it.
  {
    name: "kill-after-submit",
    lives: [
      life("holding after-submit n1", 0, ["--hold-submit", "n1"]),
      life(undefined, 0, [
        "--hold-reserve-until-spent",
        "n1",
        "--reactors-after",
        "1500",
      ]),
    ],
    control: Option.none(),
  },
  {
    name: "control-no-admission",
    lives: [life()],
    control: Option.some("no-admission"),
  },
  {
    name: "control-no-stopper",
    lives: [life()],
    control: Option.some("no-stopper"),
  },
];

/** The kind each control must fail with. */
const CONTROL_KINDS = {
  "no-admission": ["admission", "bound"],
  "no-stopper": ["abort"],
} satisfies Record<"no-admission" | "no-stopper", ReadonlyArray<Kind>>;

/** A row of the report's ledger, as this judge reads it. */
interface Row {
  readonly id: string;
  readonly label: string;
  readonly state: string;
  readonly refusal: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly receipt: { readonly totalTokens: number } | null;
}

/** What `BudgetBrain.ts` writes to `report.json`. */
interface Report {
  readonly result: string;
  readonly workflow: {
    readonly state: string;
    readonly outcome: {
      readonly kind: string;
      readonly reason?: string;
    } | null;
    readonly softAt: number | null;
    readonly spentAt: number | null;
    readonly spent: { readonly tokens: number };
    readonly nodes: Readonly<Record<string, Row>>;
  } | null;
  readonly events: ReadonlyArray<string>;
  readonly stoppers: number;
  /** Each life's boot, as JSON: whether the line was reached and a stopper still ran. */
  readonly boots: ReadonlyArray<string>;
  readonly raises: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
  }>;
  readonly children: Readonly<Record<string, number>>;
  readonly problems: ReadonlyArray<{
    readonly nodeId: string;
    readonly problem: string;
  }>;
}

/** One `effects.log` line. */
interface WorkLine {
  readonly node: string;
  readonly what: "start" | "done" | "aborted";
  readonly at: number;
}

const startBrain = (dir: string, spec: CaseSpec, each: Life) =>
  Effect.sync(() =>
    spawn(
      process.execPath,
      [
        brainScript,
        "--dir",
        dir,
        "--script",
        workflowScript,
        "--max-tokens",
        String(MAX_TOKENS),
        ...Option.match(spec.control, {
          onNone: () => [],
          onSome: (control) => ["--control", control],
        }),
        ...each.args,
      ],
      { cwd: root, stdio: ["ignore", "pipe", "inherit"] }
    )
  );

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

const readEffects = (dir: string): ReadonlyArray<WorkLine> => {
  const file = path.join(dir, "effects.log");

  if (!existsSync(file)) {
    return [];
  }

  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map(
      (line) =>
        // SAFETY: each line is `JSON.stringify` of a `WorkEffect` and its time, written by the brain
        // in this run.
        // Verified by: this judge (a malformed line fails its checks)
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        JSON.parse(line) as WorkLine
    );
};

const median = (numbers: ReadonlyArray<number>): number => {
  const sorted = numbers.toSorted((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** What every check reads: the case, its report's run and rows, and the work lines. */
interface Checked {
  readonly spec: CaseSpec;
  readonly report: Report;
  readonly workflow: NonNullable<Report["workflow"]>;
  readonly rows: ReadonlyArray<Row>;
  readonly dispatched: ReadonlyArray<Row>;
  readonly effects: ReadonlyArray<WorkLine>;
}

type Fail = (kind: Kind, text: string) => void;

/** Each line fired once; one stopper and one raise, cancelled at the end, unless no reactor ran. */
const checkLines = (checked: Checked, fail: Fail) => {
  const { report, spec } = checked;

  for (const name of ["workflow.budget.soft", "workflow.budget.spent"]) {
    const fired = report.events.filter((event) => event === name).length;

    if (fired !== 1) {
      fail("lines", `${name} fired ${String(fired)} times, want 1`);
    }
  }

  if (Option.contains(spec.control, "no-stopper")) {
    return;
  }

  if (report.stoppers !== 1) {
    fail("lines", `${String(report.stoppers)} stopper tasks, want 1`);
  }

  const [raise] = report.raises;

  if (report.raises.length !== 1 || raise?.status !== "cancelled") {
    fail(
      "lines",
      `raises ${JSON.stringify(report.raises)}, want one, cancelled at the end`
    );
  }
};

/** No node reserved after the line was dispatched, and some were refused at it. */
const checkAdmission = (checked: Checked, fail: Fail) => {
  const line = checked.workflow.spentAt;

  if (line === null) {
    fail("admission", "the run never reached its line");
  } else {
    const late = checked.dispatched.filter(
      (row) => (row.startedAt ?? 0) > line
    );

    if (late.length > 0) {
      fail(
        "admission",
        `${String(late.length)} nodes dispatched after the line (${late.map((row) => row.label).join(", ")})`
      );
    }
  }

  if (!checked.rows.some((row) => row.refusal === "budget_spent")) {
    fail("admission", "no node was refused budget_spent");
  }
};

/** Nodes dispatched are at most ceil(line / tokens per node) + the run's concurrency. */
const checkBound = (checked: Checked, fail: Fail) => {
  const perNode = median(
    checked.rows
      .filter((row) => row.state === "settled")
      .map((row) => row.receipt?.totalTokens ?? 0)
  );

  const bound =
    perNode > 0 ? Math.ceil(MAX_TOKENS / perNode) + MAX_CONCURRENT : 0;

  if (perNode === 0 || checked.dispatched.length > bound) {
    fail(
      "bound",
      `${String(checked.dispatched.length)} nodes dispatched, bound ${String(bound)} (${String(perNode)} tokens per node)`
    );
  }
};

/** Some node was stopped, and no node's work finished well after the line. */
const checkAbort = (checked: Checked, fail: Fail) => {
  const line = checked.workflow.spentAt;

  if (!checked.rows.some((row) => row.state === "stopped")) {
    fail("abort", "no running node was stopped at the line");
  }

  if (line === null) {
    return;
  }

  const ranOn = checked.effects.filter(
    (each) => each.what === "done" && each.at > line + ABORT_SLACK_MILLIS
  );

  if (ranOn.length > 0) {
    fail(
      "abort",
      `work finished after the line: ${ranOn.map((each) => `${each.node} +${String(each.at - line)} ms`).join(", ")}`
    );
  }
};

/** The run finished partial, budget_spent, and the script read nothing left. */
const checkOutcome = (checked: Checked, fail: Fail) => {
  const { workflow } = checked;

  if (
    workflow.state !== "finished" ||
    workflow.outcome?.kind !== "partial" ||
    workflow.outcome.reason !== "budget_spent"
  ) {
    fail(
      "outcome",
      `workflow ${workflow.state} ${JSON.stringify(workflow.outcome)}, want finished partial budget_spent`
    );
  }

  if (!checked.report.result.includes('"remaining":0')) {
    fail("outcome", "the script did not read remaining() === 0 at the end");
  }
};

/** Every dispatched row names an accepted brief and has one child; no label twice; work once. */
const checkOnce = (checked: Checked, fail: Fail) => {
  const { report, rows, effects } = checked;

  for (const problem of report.problems) {
    fail("once", `ledger: ${problem.nodeId} ${problem.problem}`);
  }

  for (const row of checked.dispatched) {
    const made = report.children[row.id] ?? 0;

    if (made !== 1) {
      fail("once", `${row.label}: ${String(made)} child conversations`);
    }
  }

  for (const label of new Set(effects.map((each) => each.node))) {
    const starts = effects.filter(
      (each) => each.node === label && each.what === "start"
    ).length;

    const sameLabel = rows.filter((row) => row.label === label).length;

    if (starts > 1 || sameLabel > 1) {
      fail(
        "once",
        `${label}: ${String(sameLabel)} rows, its work started ${String(starts)} times`
      );
    }
  }
};

/** Every failed check of one case; empty when it passed. */
const check = (
  spec: CaseSpec,
  report: Report,
  effects: ReadonlyArray<WorkLine>
): ReadonlyArray<Failure> => {
  const { workflow } = report;

  if (workflow === null) {
    return [{ kind: "outcome", text: "no workflow row" }];
  }

  const failures: Array<Failure> = [];
  const rows = Object.values(workflow.nodes);

  const fail: Fail = (kind, text) => {
    failures.push({ kind, text });
  };

  const checked: Checked = {
    spec,
    report,
    workflow,
    rows,
    dispatched: rows.filter((row) => row.state !== "refused"),
    effects,
  };

  for (const each of [
    checkLines,
    checkAdmission,
    checkBound,
    checkAbort,
    checkOutcome,
    checkOnce,
  ]) {
    each(checked, fail);
  }

  return failures;
};

/** One case: its lives, kills between them, the checks. */
const runCase = Effect.fn("workflow-budget.case")(function* (spec: CaseSpec) {
  const dir = mkdtempSync(
    path.join(tmpdir(), `cairn-workflow-budget-${spec.name}-`)
  );

  const reportFile = path.join(dir, "report.json");
  const started = performance.now();
  let landed = 0;

  for (const each of spec.lives) {
    const child = yield* startBrain(dir, spec, each);

    if (Option.isNone(each.killOn)) {
      const done = yield* Effect.result(
        waitForLine(child, "done", "120 seconds")
      );

      yield* killHard(child);

      if (Result.isFailure(done)) {
        return {
          case: spec.name,
          pass: false,
          failures: [lifeFailure(done.failure)],
          dir,
        };
      }

      break;
    }

    const { line, delayMs } = each.killOn.value;
    const seen = yield* Effect.result(waitForLine(child, line, "60 seconds"));

    if (Result.isSuccess(seen)) {
      yield* Effect.sleep(Duration.millis(delayMs));
    }

    yield* killHard(child);

    if (Result.isSuccess(seen)) {
      landed += 1;
    }

    // The brain finished before this kill could land: nothing is left to interrupt.
    if (existsSync(reportFile)) {
      break;
    }
  }

  if (!existsSync(reportFile)) {
    return {
      case: spec.name,
      pass: false,
      failures: [lifeFailure("no report")],
      dir,
    };
  }

  // SAFETY: `report.json` is written by `BudgetBrain.ts` in this run, from the `Report` shape.
  // Verified by: this judge (a report missing a field fails its checks, never passes them)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const report = JSON.parse(readFileSync(reportFile, "utf-8")) as Report;
  const effects = readEffects(dir);
  const failures: Array<Failure> = [...check(spec, report, effects)];

  const wantKills = spec.lives.filter((each) =>
    Option.isSome(each.killOn)
  ).length;

  if (landed < Math.min(1, wantKills)) {
    failures.push(lifeFailure("no kill landed"));
  }

  if (!values.keep) {
    rmSync(dir, { recursive: true, force: true });
  }

  const rows = Object.values(report.workflow?.nodes ?? {});

  return {
    case: spec.name,
    pass: failures.length === 0,
    kills: landed,
    dispatched: rows.filter((row) => row.state !== "refused").length,
    refused: rows.filter((row) => row.state === "refused").length,
    stopped: rows.filter((row) => row.state === "stopped").length,
    settled: rows.filter((row) => row.state === "settled").length,
    tokens: report.workflow?.spent.tokens ?? 0,
    line: MAX_TOKENS,
    events: {
      soft: report.events.filter((event) => event === "workflow.budget.soft")
        .length,
      spent: report.events.filter((event) => event === "workflow.budget.spent")
        .length,
    },
    stoppers: report.stoppers,
    // Lives that booted past the line, and those that booted with the stopper still running.
    bootsPastLine: report.boots.filter((boot) => boot.includes('"spent":true'))
      .length,
    bootsInStop: report.boots.filter((boot) => boot.includes('"stopping":true'))
      .length,
    outcome: report.workflow?.outcome ?? null,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    failures,
    dir: values.keep ? dir : "removed",
  };
});

/** Whether a control failed for its reason, and only by that kind of check. */
const controlFailedRightly = (
  control: "no-admission" | "no-stopper",
  failures: ReadonlyArray<Failure>
) =>
  failures.some((failure) =>
    CONTROL_KINDS[control].some((kind) => kind === failure.kind)
  );

const program = Effect.gen(function* () {
  const names = values.case ?? CASES.map((spec) => spec.name);
  let ok = true;

  for (const name of names) {
    const spec = Option.fromUndefinedOr(
      CASES.find((candidate) => candidate.name === name)
    );

    if (Option.isNone(spec)) {
      yield* Console.log(`${name}: not a case`);
      ok = false;
      continue;
    }

    const result = yield* runCase(spec.value);

    yield* Console.log(JSON.stringify(result));

    // A control proves the judge can fail: it must fail, for the reason it exists.
    ok &&= Option.match(spec.value.control, {
      onNone: () => result.pass,
      onSome: (control) => controlFailedRightly(control, result.failures),
    });
  }

  yield* Console.log(JSON.stringify({ summary: ok ? "pass" : "fail" }));

  if (!ok) {
    process.exitCode = 1;
  }
});

NodeRuntime.runMain(program);
