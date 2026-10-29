// The workflow kill and node stop matrices (workflows note judges 1 and 2, plan 4D, ADR 0012 as
// amended): a judge brain (`fixtures/workflows/WorkflowBrain.ts`, a pi-durable Harness over SQLite
// in a scratch directory with Cairn's code mode, workflows and results extensions, never the
// deployed unit) runs a workflow while the judge `kill -9`s it at named moments. Spike 3's seven
// cases are carried over onto the real node tools and ledger, and extended.
//
//   node judges/workflow-kill.ts [--case <name>]... [--keep]
//
// Kill matrix: plain, kill-fanout, kill-before-nodes, kill-thrice, kill-after-reserve (child made,
// input not yet sent), kill-in-settle (child answered, receipt not yet committed),
// kill-between-approve-and-codemode, prelude (the gate's rewrite is what replays), approve (a kill
// while the script's question waits), divergence (the stored start data changed between lives, as
// a pi bump does), and control (a dispatch that ignores its row; it must fail by dispatching twice).
//
// Stop matrix (the probe's five cases on the real `agent` tool, plus one): stop, stop-kill,
// kill-stop, mark-kill (a kill between the abort mark and the node seeing it), uncaught-stop-kill
// and stop-last-node.
//
// Every case checks, from the brain's report and from `effects.log` (written outside the store by
// each node child's one `work` call): every dispatched row names an accepted brief; each dispatched
// row has exactly one child conversation and no child is without a row; no label has two rows or
// two `work` starts; each settled node did its work once; the stored script call is the gate's
// rewrite. Then the case's own expectation: the workflow's end state, the stopped node `null` to the
// script with its work never finished, the approval asked once.
//
// Prints one JSON line per case and a summary; exits 0 when every case passes and the control
// fails for the reason it exists (a node dispatched twice). No model, no network, no secrets.

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

const brainScript = path.join(fixtures, "WorkflowBrain.ts");

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    keep: { type: "boolean", default: false },
  },
});

/** One life of the brain: its arguments, and the line after which it is killed (none: the last). */
interface Life {
  readonly args: ReadonlyArray<string>;
  readonly killOn: Option.Option<{
    readonly line: string;
    readonly delayMs: number;
  }>;
}

interface CaseSpec {
  readonly name: string;
  readonly matrix: "kill" | "stop";
  readonly script: string;
  readonly lives: ReadonlyArray<Life>;
  readonly control: boolean;
  readonly expect: {
    readonly state: "finished" | "failed" | "stopped";
    readonly reason: Option.Option<string>;
    /** The node stopped: its row `stopped`, its work never finished. */
    readonly stopped: Option.Option<string>;
    /** Whether the script went on with the stopped node as `null`. */
    readonly nullInResult: boolean;
    /** Labels that must settle, each with its work done once. */
    readonly settled: ReadonlyArray<string>;
    readonly approveRecords: number;
  };
}

const life = (
  args: ReadonlyArray<string> = [],
  killOn?: { readonly line: string; readonly delayMs: number }
): Life => ({ args, killOn: Option.fromUndefinedOr(killOn) });

const FINISHED_ALL = {
  state: "finished",
  reason: Option.none(),
  stopped: Option.none(),
  nullInResult: false,
  settled: ["a", "b", "c", "d"],
  approveRecords: 0,
} as const;

const killCase = (
  name: string,
  lives: ReadonlyArray<Life>,
  script = "fan.workflow"
): CaseSpec => ({
  name,
  matrix: "kill",
  script,
  lives,
  control: false,
  expect: FINISHED_ALL,
});

const stopCase = (
  name: string,
  lives: ReadonlyArray<Life>,
  stopped: string,
  settled: ReadonlyArray<string>,
  script = "stop.workflow"
): CaseSpec => ({
  name,
  matrix: "stop",
  script,
  lives,
  control: false,
  expect: {
    state: "finished",
    reason: Option.none(),
    stopped: Option.some(stopped),
    nullInResult: true,
    settled,
    approveRecords: 0,
  },
});

const CASES: ReadonlyArray<CaseSpec> = [
  killCase("plain", [life()]),
  killCase("kill-fanout", [
    life([], { line: "effect b start", delayMs: 300 }),
    life(),
  ]),
  killCase("kill-before-nodes", [
    life([], { line: "workflow running", delayMs: 0 }),
    life(),
  ]),
  killCase("kill-thrice", [
    life([], { line: "effect a start", delayMs: 200 }),
    life([], { line: "producing", delayMs: 900 }),
    life([], { line: "node d running", delayMs: 50 }),
    life(),
  ]),
  killCase("kill-after-reserve", [
    life(["--hold", "after-reserve:b:4000"], {
      line: "holding after-reserve b",
      delayMs: 300,
    }),
    life(),
  ]),
  killCase("kill-in-settle", [
    life(["--hold", "before-settle:c:4000"], {
      line: "holding before-settle c",
      delayMs: 300,
    }),
    life(),
  ]),
  killCase("kill-between-approve-and-codemode", [
    life(["--defer-run"], { line: "deferred", delayMs: 100 }),
    life(),
  ]),
  killCase("prelude", [
    life([], { line: "effect c start", delayMs: 500 }),
    life(),
  ]),
  {
    name: "approve",
    matrix: "kill",
    script: "approve.workflow",
    lives: [
      life([], { line: "approval-pending", delayMs: 200 }),
      life(["--answer"]),
    ],
    control: false,
    expect: { ...FINISHED_ALL, settled: ["a"], approveRecords: 1 },
  },
  {
    name: "divergence",
    matrix: "kill",
    script: "fan.workflow",
    lives: [
      life([], { line: "effect b start", delayMs: 300 }),
      life(["--diverge"]),
    ],
    control: false,
    expect: {
      ...FINISHED_ALL,
      state: "failed",
      reason: Option.some("replay_diverged"),
      settled: [],
    },
  },
  {
    name: "control",
    matrix: "kill",
    script: "fan.workflow",
    lives: [
      life(["--control"], { line: "effect b start", delayMs: 300 }),
      life(["--control"]),
    ],
    control: true,
    expect: FINISHED_ALL,
  },
  stopCase("stop", [life(["--stop", "b:800"])], "b", ["a", "c", "d"]),
  stopCase(
    "stop-kill",
    [
      life(["--stop", "b:800"], { line: "effect b aborted", delayMs: 0 }),
      life(),
    ],
    "b",
    ["a", "c", "d"]
  ),
  stopCase(
    "kill-stop",
    [
      life([], { line: "effect b start", delayMs: 300 }),
      life(["--stop", "b:800"]),
    ],
    "b",
    ["a", "c", "d"]
  ),
  stopCase(
    "mark-kill",
    [life(["--stop", "b:500"], { line: "stopped b", delayMs: 1500 }), life()],
    "b",
    ["a", "c", "d"],
    "stop-deaf.workflow"
  ),
  {
    name: "uncaught-stop-kill",
    matrix: "stop",
    script: "uncaught.workflow",
    lives: [
      life(["--stop", "b:800"], { line: "workflow failed", delayMs: 0 }),
      life(),
    ],
    control: false,
    expect: {
      state: "failed",
      reason: Option.some("script_error"),
      stopped: Option.some("b"),
      nullInResult: false,
      settled: ["a"],
      approveRecords: 0,
    },
  },
  stopCase("stop-last-node", [life(["--stop", "d:300"])], "d", ["a", "b", "c"]),
];

/** What `WorkflowBrain.ts` writes to `report.json`. */
interface Report {
  readonly result: string;
  readonly workflow: {
    readonly state: string;
    readonly outcome: {
      readonly kind: string;
      readonly reason?: string;
    } | null;
    readonly nodes: Readonly<
      Record<
        string,
        {
          readonly id: string;
          readonly label: string;
          readonly state: string;
          readonly briefId: string | null;
        }
      >
    >;
  } | null;
  readonly children: Readonly<Record<string, number>>;
  readonly approveRecords: number;
  readonly problems: ReadonlyArray<{
    readonly nodeId: string;
    readonly problem: string;
  }>;
  readonly storedRewrites: ReadonlyArray<boolean>;
}

/** One `effects.log` line. */
interface Effect1 {
  readonly node: string;
  readonly what: "start" | "done" | "aborted";
}

/**
 * One failed check. `duplicate` is the failure the broken control must show (a node dispatched or
 * started twice); anything else is `other`.
 */
interface Failure {
  readonly kind: "duplicate" | "other";
  readonly text: string;
}

const startBrain = (dir: string, spec: CaseSpec, args: ReadonlyArray<string>) =>
  Effect.sync(() =>
    spawn(
      process.execPath,
      [
        brainScript,
        "--dir",
        dir,
        "--script",
        path.join(fixtures, spec.script),
        ...args,
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

/** One line of `effects.log`. */
const effectOf = (line: string): Effect1 =>
  // SAFETY: each line is `JSON.stringify` of a `WorkEffect`, written by the brain in this run.
  // Verified by: this judge (a malformed line fails its checks)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  JSON.parse(line) as Effect1;

const readEffects = (dir: string): ReadonlyArray<Effect1> => {
  const file = path.join(dir, "effects.log");

  if (!existsSync(file)) {
    return [];
  }

  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map(effectOf);
};

const count = (
  effects: ReadonlyArray<Effect1>,
  node: string,
  what: Effect1["what"]
) => effects.filter((line) => line.node === node && line.what === what).length;

/** A failure no report check made: the brain died, stalled or wrote no report. */
const lifeFailure = (text: string): Failure => ({ kind: "other", text });

/** Collects the failed checks of one case. */
class Failures {
  readonly list: Array<Failure> = [];

  other(text: string) {
    this.list.push({ kind: "other", text });
  }

  duplicate(text: string) {
    this.list.push({ kind: "duplicate", text });
  }
}

type Rows = ReadonlyArray<NonNullable<Report["workflow"]>["nodes"][string]>;

/** The ledger rules: an accepted brief per row, one child per dispatched row, none without one. */
const checkLedger = (report: Report, rows: Rows, failures: Failures) => {
  const dispatched = rows.filter((row) => row.state !== "refused");

  for (const problem of report.problems) {
    failures.other(`ledger: ${problem.nodeId} ${problem.problem}`);
  }

  for (const row of dispatched) {
    const made = report.children[row.id] ?? 0;
    const text = `${row.label}: ${String(made)} child conversations for row ${row.id}`;

    if (made > 1) {
      failures.duplicate(text);
    } else if (made < 1) {
      failures.other(text);
    }
  }

  const orphans = Object.keys(report.children).filter(
    (id) => !dispatched.some((row) => row.id === id)
  );

  if (orphans.length > 0) {
    failures.other(`children without a dispatched row: ${orphans.join(", ")}`);
  }
};

/** Once per node: one row and one start of its work per label; each settled node worked once. */
const checkOnce = (
  spec: CaseSpec,
  rows: Rows,
  effects: ReadonlyArray<Effect1>,
  failures: Failures
) => {
  const labels = new Set([
    ...rows.map((row) => row.label),
    ...effects.map((line) => line.node),
  ]);

  for (const label of labels) {
    const sameLabel = rows.filter((row) => row.label === label).length;
    const starts = count(effects, label, "start");

    if (sameLabel > 1) {
      failures.duplicate(`${label}: ${String(sameLabel)} ledger rows`);
    }

    if (starts > 1) {
      failures.duplicate(`${label}: its work started ${String(starts)} times`);
    }
  }

  for (const label of spec.expect.settled) {
    const row = rows.find((each) => each.label === label);
    const done = count(effects, label, "done");

    if (row?.state !== "settled") {
      failures.other(`${label}: ${row?.state ?? "no row"}, want settled`);
    }

    if (done !== 1) {
      failures.other(
        `${label}: its work finished ${String(done)} times, want 1`
      );
    }
  }
};

/** The stopped node: its row stopped, its work never finished, null to the script. */
const checkStopped = (
  spec: CaseSpec,
  report: Report,
  rows: Rows,
  effects: ReadonlyArray<Effect1>,
  failures: Failures
) => {
  if (Option.isNone(spec.expect.stopped)) {
    return;
  }

  const label = spec.expect.stopped.value;
  const row = rows.find((each) => each.label === label);

  if (row?.state !== "stopped") {
    failures.other(`${label}: ${row?.state ?? "no row"}, want stopped`);
  }

  if (count(effects, label, "done") !== 0) {
    failures.other(`${label}: stopped, but its work finished`);
  }

  if (spec.expect.nullInResult && !report.result.includes(`"${label}":null`)) {
    failures.other(`${label}: the script's result does not hold null for it`);
  }
};

/** The workflow's end, the stored rewrite and the approvals asked. */
const checkWorkflow = (spec: CaseSpec, report: Report, failures: Failures) => {
  const { workflow } = report;

  // A life that saw its script call running saw the gate's rewrite stored, prelude included; a
  // case whose script never ran past a kill (divergence ends it at once) may see none.
  if (report.storedRewrites.some((rewritten) => !rewritten)) {
    failures.other("a stored script call is not the gate's rewrite");
  }

  if (spec.expect.settled.length > 0 && report.storedRewrites.length === 0) {
    failures.other("no life saw the script call's stored source");
  }

  if (workflow?.state !== spec.expect.state) {
    failures.other(
      `workflow ${workflow?.state ?? "none"}, want ${spec.expect.state}`
    );
  }

  if (
    Option.isSome(spec.expect.reason) &&
    workflow?.outcome?.reason !== spec.expect.reason.value
  ) {
    failures.other(
      `outcome ${JSON.stringify(workflow?.outcome ?? null)}, want ${spec.expect.reason.value}`
    );
  }

  if (report.approveRecords !== spec.expect.approveRecords) {
    failures.other(
      `${String(report.approveRecords)} approve records, want ${String(spec.expect.approveRecords)}`
    );
  }
};

/** Every failed check of one case; empty when it passed. */
const check = (
  spec: CaseSpec,
  report: Report,
  effects: ReadonlyArray<Effect1>
): ReadonlyArray<Failure> => {
  const failures = new Failures();
  const rows = Object.values(report.workflow?.nodes ?? {});

  checkLedger(report, rows, failures);
  checkOnce(spec, rows, effects, failures);
  checkStopped(spec, report, rows, effects, failures);
  checkWorkflow(spec, report, failures);

  return failures.list;
};

const controlFailedRightly = (failures: ReadonlyArray<Failure>) =>
  failures.some((failure) => failure.kind === "duplicate");

/** One case: its lives, kills between them, the checks. */
const runCase = Effect.fn("workflow-kill.case")(function* (spec: CaseSpec) {
  const dir = mkdtempSync(
    path.join(tmpdir(), `cairn-workflow-kill-${spec.name}-`)
  );

  const reportFile = path.join(dir, "report.json");
  const started = performance.now();
  let landed = 0;

  for (const each of spec.lives) {
    const child = yield* startBrain(dir, spec, each.args);

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

  // SAFETY: `report.json` is written by `WorkflowBrain.ts` in this run, from the `Report` shape.
  // Verified by: this judge (a report missing a field fails its checks, never passes them)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const report = JSON.parse(readFileSync(reportFile, "utf-8")) as Report;
  const effects = readEffects(dir);
  const failures = [...check(spec, report, effects)];

  const wantKills = spec.lives.filter((each) =>
    Option.isSome(each.killOn)
  ).length;

  if (landed < Math.min(1, wantKills)) {
    failures.push(lifeFailure("no kill landed"));
  }

  if (!values.keep) {
    rmSync(dir, { recursive: true, force: true });
  }

  return {
    case: spec.name,
    matrix: spec.matrix,
    pass: failures.length === 0,
    kills: landed,
    rows: Object.keys(report.workflow?.nodes ?? {}).length,
    children: Object.values(report.children).reduce(
      (sum, made) => sum + made,
      0
    ),
    starts: effects.filter((line) => line.what === "start").length,
    state: report.workflow?.state ?? "none",
    seconds: Math.round((performance.now() - started) / 100) / 10,
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
      yield* Console.log(`${name}: not a case`);
      ok = false;
      continue;
    }

    const result = yield* runCase(spec.value);

    yield* Console.log(JSON.stringify(result));

    // The control proves the judge can fail: it must fail, by dispatching a node twice.
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
