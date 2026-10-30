// The node stop matrix (workflows note judge 2, plan 5C, ADR 0012 as amended): a judge brain
// (`fixtures/workflows/StopBrain.ts`, a pi-durable Harness over SQLite in a scratch directory with
// Cairn's code mode, workflows and results extensions over faux models, never the deployed unit)
// runs a workflow, stops one node or the whole workflow through `WorkflowStops` (the service behind
// `workflow.stopNode` and `workflow.stop`), and the judge `kill -9`s it around the stop.
//
//   node judges/workflow-stop.ts [--case <name>]... [--keep]
//
// Cases. The probe's five on the real `agent` tool: stop, stop-kill (kill right after the node saw
// the stop), kill-stop (kill mid fan-out, restart, then stop), mark-kill (kill inside a 5 s window
// where the node's child ignores the stop, after the mark) and uncaught-stop-kill (the script reads
// the stopped node without a null check). Then stop-last-node; stop-then-budget (a stopped node's
// spend is in its receipt and in the script's budget reading); stop-in-hold (a node held in a wait
// deaf to its signal stops at once, because every node tool polls it); stop-workflow,
// stop-workflow-kill (kill inside a deaf child's window after the whole-workflow stop) and
// kill-stop-workflow; stop-before-start (Go given, stopped before the codemode call: the script is
// refused and nothing is dispatched). The control, control-deaf, plants node tools deaf to the
// stop: it must fail by a slow stop.
//
// Every case checks, from the brain's report and from `effects.log` (written outside the store):
// every dispatched row names an accepted brief; each dispatched row has one child and no child is
// without a row; no label has two rows or two `work` starts; each settled node did its work once;
// each stopped node is `stopped` with its work never finished and `null` to the script where the
// script went on; nodes the stop came before were never dispatched; the workflow's end state and
// outcome.
//
// Prints one JSON line per case and a summary; exits 0 when every case passes and the control
// fails for the reason it exists. No model, no network, no secrets.

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

const brainScript = path.join(fixtures, "StopBrain.ts");

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    keep: { type: "boolean", default: false },
  },
});

/** A stop answered after this long did not poll its signal. */
const PROMPT_STOP_MS = 2000;

/** One life of the brain: its arguments, and the line after which it is killed (none: the last). */
interface Life {
  readonly args: ReadonlyArray<string>;
  readonly killOn: Option.Option<{
    readonly line: string;
    readonly delayMs: number;
  }>;
}

interface Expect {
  readonly state: "finished" | "failed" | "stopped";
  readonly reason: Option.Option<string>;
  /** Nodes stopped: each row `stopped`, its work never finished. */
  readonly stopped: ReadonlyArray<string>;
  /** Whether the script went on with the stopped node as `null`. */
  readonly nullInResult: boolean;
  /** Labels that must settle, each with its work done once. */
  readonly settled: ReadonlyArray<string>;
  /** Labels the stop came before: no row, no child, no work. */
  readonly absent: ReadonlyArray<string>;
  /** The stop answered within `PROMPT_STOP_MS`. */
  readonly prompt: boolean;
  /** The stopped node's receipt and the script's budget reading count its spend. */
  readonly budget: boolean;
}

interface CaseSpec {
  readonly name: string;
  readonly script: string;
  readonly lives: ReadonlyArray<Life>;
  readonly control: boolean;
  readonly expect: Expect;
}

const life = (
  args: ReadonlyArray<string> = [],
  killOn?: { readonly line: string; readonly delayMs: number }
): Life => ({ args, killOn: Option.fromUndefinedOr(killOn) });

/** A node stopped, the script went on: b stopped and null, the other three settled. */
const NODE_STOPPED: Expect = {
  state: "finished",
  reason: Option.none(),
  stopped: ["b"],
  nullInResult: true,
  settled: ["a", "c", "d"],
  absent: [],
  prompt: false,
  budget: false,
};

/** The whole workflow stopped while b ran: a and c settled before it, d never dispatched. */
const WORKFLOW_STOPPED: Expect = {
  state: "stopped",
  reason: Option.some("stopped"),
  stopped: ["b"],
  nullInResult: false,
  settled: ["a", "c"],
  absent: ["d"],
  prompt: false,
  budget: false,
};

const nodeCase = (
  name: string,
  lives: ReadonlyArray<Life>,
  expect: Partial<Expect> = {},
  script = "stop.workflow"
): CaseSpec => ({
  name,
  script,
  lives,
  control: false,
  expect: { ...NODE_STOPPED, ...expect },
});

const HELD = ["--hold", "after-reserve:b:6000", "--stop-node", "b:300"];

const CASES: ReadonlyArray<CaseSpec> = [
  nodeCase("stop", [life(["--stop-node", "b:800"])]),
  nodeCase("stop-kill", [
    life(["--stop-node", "b:800"], { line: "effect b aborted", delayMs: 0 }),
    life(),
  ]),
  nodeCase("kill-stop", [
    life([], { line: "effect b start", delayMs: 300 }),
    life(["--stop-node", "b:800"]),
  ]),
  nodeCase(
    "mark-kill",
    [
      life(["--stop-node", "b:500"], { line: "stopped b", delayMs: 1500 }),
      life(),
    ],
    {},
    "stop-deaf.workflow"
  ),
  nodeCase(
    "uncaught-stop-kill",
    [
      life(["--stop-node", "b:800"], { line: "workflow failed", delayMs: 0 }),
      life(),
    ],
    {
      state: "failed",
      reason: Option.some("script_error"),
      nullInResult: false,
      settled: ["a"],
    },
    "uncaught.workflow"
  ),
  nodeCase("stop-last-node", [life(["--stop-node", "d:300"])], {
    stopped: ["d"],
    settled: ["a", "b", "c"],
  }),
  nodeCase(
    "stop-then-budget",
    [life(["--stop-node", "b:800"])],
    { settled: ["a"], budget: true },
    "stop-budget.workflow"
  ),
  nodeCase("stop-in-hold", [life(HELD)], { prompt: true }),
  {
    ...nodeCase("control-deaf", [life([...HELD, "--deaf"])], { prompt: true }),
    control: true,
  },
  {
    name: "stop-workflow",
    script: "stop.workflow",
    lives: [life(["--stop-workflow", "b:2500"])],
    control: false,
    expect: WORKFLOW_STOPPED,
  },
  {
    name: "stop-workflow-kill",
    script: "stop-deaf.workflow",
    lives: [
      life(["--stop-workflow", "b:2500"], {
        line: "stopping workflow",
        delayMs: 1000,
      }),
      life(),
    ],
    control: false,
    expect: WORKFLOW_STOPPED,
  },
  {
    name: "kill-stop-workflow",
    script: "stop.workflow",
    lives: [
      life([], { line: "effect b start", delayMs: 300 }),
      life(["--stop-workflow", "b:2500"]),
    ],
    control: false,
    expect: WORKFLOW_STOPPED,
  },
  {
    name: "stop-before-start",
    script: "stop.workflow",
    lives: [life(["--stop-before-run"])],
    control: false,
    expect: {
      ...WORKFLOW_STOPPED,
      stopped: [],
      settled: [],
      absent: ["a", "b", "c", "d"],
    },
  },
];

/** What `StopBrain.ts` writes to `report.json`. */
interface Report {
  readonly result: string;
  readonly workflow: {
    readonly state: string;
    readonly outcome: {
      readonly kind: string;
      readonly reason?: string;
    } | null;
    readonly spent: { readonly tokens: number };
    readonly nodes: Readonly<
      Record<
        string,
        {
          readonly id: string;
          readonly label: string;
          readonly state: string;
          readonly receipt: { readonly totalTokens: number } | null;
        }
      >
    >;
  } | null;
  readonly children: Readonly<Record<string, number>>;
  readonly problems: ReadonlyArray<{
    readonly nodeId: string;
    readonly problem: string;
  }>;
  readonly stopMs: ReadonlyArray<number>;
}

/** One `effects.log` line. */
interface WorkLine {
  readonly node: string;
  readonly what: "start" | "done" | "aborted";
}

/** One failed check: `slow` is the failure the deaf control must show. */
interface Failure {
  readonly kind: "slow" | "other";
  readonly text: string;
}

type Rows = ReadonlyArray<NonNullable<Report["workflow"]>["nodes"][string]>;

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

/** Waits until the brain prints a line starting with `line`; fails if it exits first or times out. */
const waitForLine = (
  child: ChildProcess,
  line: string,
  timeout: Duration.Input
) =>
  Effect.callback<true, string>((resume) => {
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");

      if (buffer.split("\n").some((seen) => seen.startsWith(line))) {
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

const lineOf = (line: string): WorkLine =>
  // SAFETY: each line is `JSON.stringify` of a `WorkEffect`, written by the brain in this run.
  // Verified by: this judge (a malformed line fails its checks)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  JSON.parse(line) as WorkLine;

const readEffects = (dir: string): ReadonlyArray<WorkLine> => {
  const file = path.join(dir, "effects.log");

  return existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line !== "")
        .map(lineOf)
    : [];
};

const count = (
  effects: ReadonlyArray<WorkLine>,
  node: string,
  what: WorkLine["what"]
) => effects.filter((line) => line.node === node && line.what === what).length;

/** Collects the failed checks of one case. */
class Failures {
  readonly list: Array<Failure> = [];

  other(text: string) {
    this.list.push({ kind: "other", text });
  }

  slow(text: string) {
    this.list.push({ kind: "slow", text });
  }
}

/** The ledger rules: an accepted brief per row, one child per dispatched row, none without one. */
const checkLedger = (report: Report, rows: Rows, failures: Failures) => {
  const dispatched = rows.filter((row) => row.state !== "refused");

  for (const problem of report.problems) {
    failures.other(`ledger: ${problem.nodeId} ${problem.problem}`);
  }

  for (const row of dispatched) {
    const made = report.children[row.id] ?? 0;

    if (made !== 1) {
      failures.other(
        `${row.label}: ${String(made)} child conversations for row ${row.id}`
      );
    }
  }

  const orphans = Object.keys(report.children).filter(
    (id) => !dispatched.some((row) => row.id === id)
  );

  if (orphans.length > 0) {
    failures.other(`children without a dispatched row: ${orphans.join(", ")}`);
  }
};

/** Once per node, the settled ones worked once, the absent ones never started. */
const checkNodes = (
  spec: CaseSpec,
  rows: Rows,
  effects: ReadonlyArray<WorkLine>,
  failures: Failures
) => {
  const labels = new Set([
    ...rows.map((row) => row.label),
    ...effects.map((line) => line.node),
  ]);

  for (const label of labels) {
    const sameLabel = rows.filter((row) => row.label === label).length;
    const starts = count(effects, label, "start");

    if (sameLabel > 1 || starts > 1) {
      failures.other(
        `${label}: ${String(sameLabel)} rows, its work started ${String(starts)} times`
      );
    }
  }

  for (const label of spec.expect.settled) {
    const row = rows.find((each) => each.label === label);

    if (row?.state !== "settled") {
      failures.other(`${label}: ${row?.state ?? "no row"}, want settled`);
    }

    if (count(effects, label, "done") !== 1) {
      failures.other(`${label}: its work did not finish once`);
    }
  }

  for (const label of spec.expect.absent) {
    if (rows.some((row) => row.label === label) || labels.has(label)) {
      failures.other(`${label}: dispatched after the stop`);
    }
  }
};

/** Each stopped node: its row stopped, its work never finished, null where the script went on. */
const checkStopped = (
  spec: CaseSpec,
  report: Report,
  rows: Rows,
  effects: ReadonlyArray<WorkLine>,
  failures: Failures
) => {
  for (const label of spec.expect.stopped) {
    const row = rows.find((each) => each.label === label);

    if (row?.state !== "stopped") {
      failures.other(`${label}: ${row?.state ?? "no row"}, want stopped`);
    }

    if (count(effects, label, "done") !== 0) {
      failures.other(`${label}: stopped, but its work finished`);
    }

    if (
      spec.expect.nullInResult &&
      !report.result.includes(`"${label}":null`)
    ) {
      failures.other(`${label}: the script's result does not hold null for it`);
    }
  }
};

/** The stop answered promptly; the stopped node's spend counted. */
const checkStop = (
  spec: CaseSpec,
  report: Report,
  rows: Rows,
  failures: Failures
) => {
  if (report.stopMs.length !== 1 && spec.expect.stopped.length > 0) {
    failures.other(`${String(report.stopMs.length)} stop calls, want 1`);
  }

  const slowest = Math.max(0, ...report.stopMs);

  if (spec.expect.prompt && slowest > PROMPT_STOP_MS) {
    failures.slow(
      `the stop took ${String(slowest)} ms, want at most ${String(PROMPT_STOP_MS)}`
    );
  }

  if (!spec.expect.budget) {
    return;
  }

  const [label = ""] = spec.expect.stopped;
  const tokens = rows.find((row) => row.label === label)?.receipt?.totalTokens;

  if (tokens === undefined || tokens <= 0) {
    failures.other(`${label}: stopped with no receipt of its spend`);
  }

  const receipts = rows.reduce(
    (sum, row) => sum + (row.receipt?.totalTokens ?? 0),
    0
  );

  if (report.workflow?.spent.tokens !== receipts) {
    failures.other(
      `spent ${String(report.workflow?.spent.tokens)} tokens, receipts sum ${String(receipts)}`
    );
  }

  const seen = Number(/"spent":(?<n>\d+)/u.exec(report.result)?.groups?.n);

  if (!(seen >= (tokens ?? 1))) {
    failures.other(
      `the script's budget read ${String(seen)} tokens, under ${label}'s ${String(tokens)}`
    );
  }
};

/** The workflow's end state and outcome. */
const checkWorkflow = (spec: CaseSpec, report: Report, failures: Failures) => {
  const { workflow } = report;

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
};

const check = (
  spec: CaseSpec,
  report: Report,
  effects: ReadonlyArray<WorkLine>
): ReadonlyArray<Failure> => {
  const failures = new Failures();
  const rows = Object.values(report.workflow?.nodes ?? {});

  checkLedger(report, rows, failures);
  checkNodes(spec, rows, effects, failures);
  checkStopped(spec, report, rows, effects, failures);
  checkStop(spec, report, rows, failures);
  checkWorkflow(spec, report, failures);

  return failures.list;
};

const lifeFailure = (text: string): Failure => ({ kind: "other", text });

/** One case: its lives, kills between them, the checks. */
const runCase = Effect.fn("workflow-stop.case")(function* (spec: CaseSpec) {
  const dir = mkdtempSync(
    path.join(tmpdir(), `cairn-workflow-stop-${spec.name}-`)
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

  // SAFETY: `report.json` is written by `StopBrain.ts` in this run, from the `Report` shape.
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
    pass: failures.length === 0,
    kills: landed,
    rows: Object.keys(report.workflow?.nodes ?? {}).length,
    starts: effects.filter((line) => line.what === "start").length,
    state: report.workflow?.state ?? "none",
    stopMs: report.stopMs,
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

    // The control proves the judge can fail: it must fail, by a stop that waited.
    ok &&= spec.value.control
      ? result.failures.some((failure) => failure.kind === "slow")
      : result.pass;
  }

  yield* Console.log(JSON.stringify({ summary: ok ? "pass" : "fail" }));

  if (!ok) {
    process.exitCode = 1;
  }
});

NodeRuntime.runMain(program);
