// J-budget under kill -9 (ADR 0036, plan 4E, models note "Judges"): a judge brain
// (`fixtures/budget/BudgetBrain.ts`: the pi-durable harness behind the seam, the spend ledger, the
// budget book, sources, guard and `cairn.budgets` gate, over a scratch directory, never the deployed
// unit) fans out ten faux children under a `stop` budget of four children's worth of list price.
// The judge `kill -9`s it a few times while the children run, then once more while the guard is
// stopping them (a random moment inside its stop pass), and lets a last life finish.
//
//   node judges/budget-kill.ts [--case kills|no-stop|no-boot]... [--early N] [--keep]
//
// Checks on the last life's report:
// - overshoot: the scope's spend passed its line by at most one response per running child: the
//   response that crossed it, plus one in flight per child (ten children, the largest response's
//   price measured from the store);
// - restarted: no child answered after the restart (each child's answered responses at the last
//   boot, before the Harness resumed, equal its answered responses at the end; a response an abort
//   cut off is the end of a stopped run, not a new one);
// - the stopped notice appears once in the scope's transcript, its row reads `exhausted`, and at
//   most one stopped push went out;
// - then the raise, answered as the user after the restart, lets work start again: `admit` passes,
//   the row reads below its line, and a child sent more work answers.
//
// Cases (default: all three):
// - kills: the real guard; every check passes.
// - no-stop: a broken control whose guard stops nothing, halts nothing and has no gate. It must fail
//   by overshoot.
// - no-boot: a broken control without the guard's boot repair. It must fail by a child running
//   after the restart.
//
// Prints one JSON line per case and a summary; exits 0 when kills passes and each control fails for
// its reason. No network, no secrets, $0.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import {
  Console,
  Duration,
  Effect,
  Option,
  Random,
  Result,
  Schema,
} from "effect";

const root = path.join(import.meta.dirname, "..");

const brainScript = path.join(
  import.meta.dirname,
  "fixtures",
  "budget",
  "BudgetBrain.ts"
);

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    early: { type: "string", default: "2" },
    keep: { type: "boolean", default: false },
  },
});

/** The fixture's children and stop stagger, which bound the kill window and the overshoot. */
const CHILDREN = 10;

const STAGGER_MS = 10;

interface CaseSpec {
  readonly name: string;
  readonly control: "none" | "no-stop" | "no-boot";
  /** The failure a control must show; none for the real case. */
  readonly mustFail: Option.Option<FailureKind>;
}

const FailureKind = Schema.Literals([
  "overshoot",
  "restarted",
  "notice",
  "row",
  "push",
  "raise",
  "other",
]);

type FailureKind = typeof FailureKind.Type;

const CASES: ReadonlyArray<CaseSpec> = [
  { name: "kills", control: "none", mustFail: Option.none() },
  { name: "no-stop", control: "no-stop", mustFail: Option.some("overshoot") },
  { name: "no-boot", control: "no-boot", mustFail: Option.some("restarted") },
];

const Report = Schema.Struct({
  limitMicros: Schema.Int,
  spentMicros: Schema.Int,
  maxResponseMicros: Schema.Int,
  children: Schema.Int,
  atBoot: Schema.Record(Schema.String, Schema.Int),
  atEnd: Schema.Record(Schema.String, Schema.Int),
  stoppedNotices: Schema.Int,
  rowBudget: Schema.NullOr(Schema.String),
  stoppedPushes: Schema.Int,
});

const Raise = Schema.Struct({
  admitted: Schema.Boolean,
  rowBudget: Schema.NullOr(Schema.String),
  retriedResponses: Schema.Int,
});

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(Report));

const decodeRaise = Schema.decodeUnknownEffect(Schema.fromJsonString(Raise));

interface Failure {
  readonly kind: FailureKind;
  readonly text: string;
}

/** Starts one life of the judge brain. */
const startBrain = (dir: string, spec: CaseSpec, final: boolean) =>
  Effect.sync(() => {
    const args = [
      brainScript,
      "--dir",
      dir,
      "--control",
      spec.control,
      "--children",
      String(CHILDREN),
      "--stagger-ms",
      String(STAGGER_MS),
    ];

    if (final) {
      args.push("--final");
    }

    return spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
  });

/** Resolves with the first of `lines` the brain prints; fails if it exits first or time runs out. */
const waitForAny = (
  child: ChildProcess,
  lines: ReadonlyArray<string>,
  timeout: Duration.Input
) =>
  Effect.callback<string, string>((resume) => {
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");

      const seen = buffer.split("\n");
      const found = lines.find((line) => seen.includes(line));

      if (found !== undefined) {
        resume(Effect.succeed(found));
      }
    };

    const onExit = (code: number | null) => {
      resume(
        Effect.fail(
          `the judge brain exited (${String(code)}) before printing ${lines.join(" or ")}`
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
      orElse: () => Effect.succeed("timeout"),
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

type Report = typeof Report.Type;

type Raise = typeof Raise.Type;

/** Every failed check of one run. */
const check = (report: Report, raise: Raise): ReadonlyArray<Failure> => {
  const failures: Array<Failure> = [];
  const overshoot = report.spentMicros - report.limitMicros;
  // The response that crossed the line, plus one per running child in flight when it did.
  const allowed = (report.children + 1) * report.maxResponseMicros;

  if (overshoot > allowed) {
    failures.push({
      kind: "overshoot",
      text: `spent ${report.spentMicros} micros against a line of ${report.limitMicros}: ${overshoot} over, more than the crossing response and one per running child (${allowed})`,
    });
  }

  const ran = Object.entries(report.atEnd).filter(
    ([thread, end]) => end > (report.atBoot[thread] ?? 0)
  );

  if (ran.length > 0) {
    failures.push({
      kind: "restarted",
      text: `${ran.length} children answered after the restart: ${ran
        .map(
          ([thread, end]) => `${thread} ${report.atBoot[thread] ?? 0} to ${end}`
        )
        .join(", ")}`,
    });
  }

  if (report.stoppedNotices !== 1) {
    failures.push({
      kind: "notice",
      text: `the stopped notice appears ${report.stoppedNotices} times, not once`,
    });
  }

  if (report.rowBudget !== "exhausted") {
    failures.push({
      kind: "row",
      text: `the scope's row reads ${String(report.rowBudget)}, not exhausted`,
    });
  }

  if (report.stoppedPushes > 1) {
    failures.push({
      kind: "push",
      text: `${report.stoppedPushes} stopped pushes went out, more than one`,
    });
  }

  if (
    !raise.admitted ||
    raise.rowBudget === "exhausted" ||
    raise.retriedResponses < 1
  ) {
    failures.push({
      kind: "raise",
      text: `after the raise: admitted ${String(raise.admitted)}, row ${String(raise.rowBudget)}, ${raise.retriedResponses} responses from the retried child`,
    });
  }

  return failures;
};

/** One case: early kills, the kill while stopping, the last life, the checks. */
const runCase = Effect.fn("budget-kill.case")(function* (spec: CaseSpec) {
  const dir = mkdtempSync(
    path.join(tmpdir(), `cairn-budget-kill-${spec.name}-`)
  );

  const started = Date.now();
  const early = Number(values.early);
  let kills = 0;
  let killedStopping = false;
  let crossed = false;

  for (let life = 0; !crossed && life < early + 3; life += 1) {
    const child = yield* startBrain(dir, spec, false);

    const ready = yield* Effect.result(
      waitForAny(child, ["exhausted", "producing"], "60 seconds")
    );

    // A kill landed after the crossing and before the guard's first stop: the boot repair halted
    // the scope, and this life only resumes what is left.
    if (Result.isSuccess(ready) && ready.success === "exhausted") {
      crossed = true;
      yield* killHard(child);
      kills += 1;
      continue;
    }

    if (Result.isFailure(ready) || ready.success === "timeout") {
      yield* killHard(child);

      return {
        case: spec.name,
        pass: false,
        failures: [
          {
            kind: "other" as const,
            text: Result.isFailure(ready) ? ready.failure : "no producing",
          },
        ],
        dir,
      };
    }

    // Early lives die at a random moment, unless the guard starts stopping first; later lives wait
    // for the guard.
    const delay =
      life < early ? yield* Random.nextIntBetween(300, 900) : 60_000;

    const seen = yield* waitForAny(
      child,
      ["stopping"],
      Duration.millis(delay)
    ).pipe(Effect.orElseSucceed(() => "exited"));

    if (seen === "stopping") {
      // Somewhere inside the stop pass: the guard staggers its stops by STAGGER_MS each.
      yield* Effect.sleep(
        Duration.millis(yield* Random.nextIntBetween(0, STAGGER_MS * CHILDREN))
      );
      killedStopping = true;
      crossed = true;
    }

    yield* killHard(child);
    kills += 1;
  }

  const last = yield* startBrain(dir, spec, true);

  const done = yield* waitForAny(last, ["done"], "120 seconds").pipe(
    Effect.orElseSucceed(() => "exited")
  );

  yield* killHard(last);

  const reportFile = path.join(dir, "report.json");
  const raiseFile = path.join(dir, "raise.json");

  if (done !== "done" || !existsSync(reportFile) || !existsSync(raiseFile)) {
    return {
      case: spec.name,
      pass: false,
      failures: [
        { kind: "other" as const, text: `the last life ended with ${done}` },
      ],
      dir,
    };
  }

  const report = yield* decodeReport(readFileSync(reportFile, "utf-8"));
  const raise = yield* decodeRaise(readFileSync(raiseFile, "utf-8"));
  const failures = check(report, raise);

  if (!values.keep) {
    rmSync(dir, { recursive: true, force: true });
  }

  return {
    case: spec.name,
    pass: failures.length === 0,
    kills,
    killedStopping,
    crossed,
    limitMicros: report.limitMicros,
    spentMicros: report.spentMicros,
    overshootMicros: report.spentMicros - report.limitMicros,
    allowedMicros: (report.children + 1) * report.maxResponseMicros,
    responseMicros: report.maxResponseMicros,
    stoppedNotices: report.stoppedNotices,
    stoppedPushes: report.stoppedPushes,
    rowBudget: report.rowBudget,
    raise,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    failures,
    dir: values.keep ? dir : "removed",
  };
});

/** A control proves the judge can fail: it must fail, and for the reason it exists. */
const outcomeOk = (
  spec: CaseSpec,
  result: { readonly pass: boolean; readonly failures: ReadonlyArray<Failure> }
) =>
  Option.match(spec.mustFail, {
    onNone: () => result.pass,
    onSome: (kind) =>
      result.failures.some((failure) => failure.kind === kind) &&
      result.failures.every((failure) => failure.kind !== "other"),
  });

const program = Effect.gen(function* () {
  const names = values.case ?? CASES.map((spec) => spec.name);
  let ok = true;

  for (const name of names) {
    const spec = Option.fromUndefinedOr(
      CASES.find((candidate) => candidate.name === name)
    );

    if (Option.isNone(spec)) {
      yield* Console.log(`${name}: not a case (kills, no-stop or no-boot)`);
      ok = false;
      continue;
    }

    const result = yield* runCase(spec.value);

    yield* Console.log(JSON.stringify(result));

    ok &&= outcomeOk(spec.value, result);
  }

  yield* Console.log(JSON.stringify({ summary: ok ? "pass" : "fail" }));

  if (!ok) {
    process.exitCode = 1;
  }
});

NodeRuntime.runMain(program);
