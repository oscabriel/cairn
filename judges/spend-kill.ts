// J-spend under kill -9 (ADR 0036, plan 2C, models note "Judges"): a judge brain
// (`fixtures/spend/SpendBrain.ts`, Cairn's `Brain`, spend feed, ledger and shell store over a scratch
// directory, never the deployed unit) runs turns on four threads while the judge `kill -9`s it,
// again and again, each kill a random 100 to 1,500 ms after the brain says it is producing. The last
// life retries every task the kills parked (five kills on one request park it), runs every turn and
// writes its report.
//
//   node judges/spend-kill.ts [--case kills|control]... [--kills N] [--turns N] [--quick] [--keep]
//
// `--quick` kills 50 to 150 ms after the brain says it is producing, so five kills land on one
// request and pi-durable parks it; `retriedParked` in the result counts what the last life retried.
//
// Cases (default: both):
// - kills: 12 kills over 48 turns, the real ledger.
// - control: the broken control, a ledger that adds what it reads and catches up at boot by adding
//   every response again; 4 kills. It must fail by double counting, and by nothing else, or the
//   judge proves nothing.
//
// Per conversation it asserts, against what the brain computed itself (each `pi.usage`, and each
// response priced alone by pi-ai's `calculateCost`): the ledger's tokens equal the document's; a
// bridge thread's list price equals the sum of its responses' (within a micro per response); the
// unpriced thread has no price and all its tokens unpriced. Per thread row: the `spend` figure
// carries the same tokens and price, and the unpriced thread's says how many tokens have no price
// (never a bare $0). Prints one JSON line per case and a summary; exits 0 when kills passes and the
// control fails for that reason alone. No network, no secrets, $0.

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
  "spend",
  "SpendBrain.ts"
);

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    kills: { type: "string" },
    turns: { type: "string", default: "48" },
    keep: { type: "boolean", default: false },
    // Kills 50 to 150 ms after producing, so several land on one request and park it.
    quick: { type: "boolean", default: false },
  },
});

interface CaseSpec {
  readonly name: string;
  readonly kills: number;
  readonly control: boolean;
}

const CASES: ReadonlyArray<CaseSpec> = [
  { name: "kills", kills: 12, control: false },
  { name: "control", kills: 4, control: true },
];

const Truth = Schema.Struct({
  thread: Schema.Int,
  key: Schema.String,
  responses: Schema.Int,
  input: Schema.Int,
  output: Schema.Int,
  tokens: Schema.Int,
  listMicros: Schema.NullOr(Schema.Int),
  sumPricedMicros: Schema.NullOr(Schema.Int),
});

const Report = Schema.Struct({
  truth: Schema.Record(Schema.String, Truth),
  ledger: Schema.Array(
    Schema.Struct({
      conversation_id: Schema.Int,
      model_key: Schema.String,
      input: Schema.Int,
      output: Schema.Int,
      list_micros: Schema.NullOr(Schema.Int),
      unpriced_tokens: Schema.Int,
    })
  ),
  shell: Schema.Record(
    Schema.String,
    Schema.NullOr(
      Schema.Struct({
        totalTokens: Schema.Int,
        listMicros: Schema.Int,
        unpricedTokens: Schema.Int,
      })
    )
  ),
});

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(Report));

/** Starts one life of the judge brain. */
const startBrain = (
  dir: string,
  spec: CaseSpec,
  turns: number,
  last: boolean
) =>
  Effect.sync(() => {
    const args = [brainScript, "--dir", dir, "--turns", String(turns)];

    if (spec.control) {
      args.push("--control");
    }

    // The last life retries what the kills parked: five kills on one request park it for good.
    if (last) {
      args.push("--retry-parked");
    }

    return spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
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

/**
 * One failed check. `double` is the failure the broken control must show (more counted than
 * happened); anything else is `other`.
 */
interface Failure {
  readonly kind: "double" | "other";
  readonly text: string;
}

const controlFailedRightly = (failures: ReadonlyArray<Failure>) =>
  failures.some((failure) => failure.kind === "double") &&
  failures.every((failure) => failure.kind !== "other");

type Truth = typeof Truth.Type;

type Report = typeof Report.Type;

/** A failure, `double` when the ledger holds more than happened. */
const failure = (text: string, more: boolean): Failure => ({
  kind: more ? "double" : "other",
  text,
});

/** The ledger row of one conversation against what the store holds. */
const checkRow = (
  spec: CaseSpec,
  id: string,
  truth: Truth,
  row: Report["ledger"][number]
): Array<Failure> => {
  const failures: Array<Failure> = [];

  if (row.input !== truth.input || row.output !== truth.output) {
    failures.push(
      failure(
        `conversation ${id}: ledger ${row.input} in, ${row.output} out; pi.usage ${truth.input} in, ${truth.output} out`,
        row.input > truth.input || row.output > truth.output
      )
    );
  }

  if (truth.listMicros !== null) {
    const listed = row.list_micros ?? 0;

    if (Math.abs(listed - truth.listMicros) > truth.responses) {
      failures.push(
        failure(
          `conversation ${id}: ledger ${listed} micros, responses priced alone ${truth.listMicros}`,
          listed > truth.listMicros
        )
      );
    }

    return failures;
  }

  if (row.list_micros !== null) {
    failures.push(
      failure(`conversation ${id}: the unpriced model has a price`, false)
    );
  }

  if (!spec.control && row.unpriced_tokens !== truth.tokens) {
    failures.push(
      failure(
        `conversation ${id}: ${row.unpriced_tokens} unpriced tokens, expected ${truth.tokens}`,
        row.unpriced_tokens > truth.tokens
      )
    );
  }

  return failures;
};

/** A thread row's spend figure against what the store holds. */
const checkShell = (truth: Truth, report: Report): Array<Failure> => {
  const summary = report.shell[String(truth.thread)] ?? null;
  const price = truth.listMicros ?? 0;

  if (summary === null) {
    return [failure(`thread ${truth.thread}: no spend on its row`, false)];
  }

  if (
    summary.totalTokens !== truth.tokens ||
    Math.abs(summary.listMicros - price) > truth.responses
  ) {
    return [
      failure(
        `thread ${truth.thread}: row says ${summary.totalTokens} tokens and ${summary.listMicros} micros, expected ${truth.tokens} and ${price}`,
        summary.totalTokens > truth.tokens
      ),
    ];
  }

  const readsAsZero =
    summary.unpricedTokens !== truth.tokens || summary.unpricedTokens === 0;

  return truth.listMicros === null && readsAsZero
    ? [
        failure(
          `thread ${truth.thread}: the unpriced thread's row would read as $0 (${summary.unpricedTokens} unpriced tokens)`,
          false
        ),
      ]
    : [];
};

/** Every failed check of one report; empty when it passed. */
const check = (spec: CaseSpec, report: Report) =>
  Object.entries(report.truth).flatMap(([id, truth]) => {
    const row = report.ledger.find(
      (each) =>
        String(each.conversation_id) === id && each.model_key === truth.key
    );

    const ledger =
      row === undefined
        ? [failure(`conversation ${id}: no ledger row for ${truth.key}`, false)]
        : checkRow(spec, id, truth, row);

    return spec.control ? ledger : [...ledger, ...checkShell(truth, report)];
  });

/** One case: the kills, the last life, the checks. */
const runCase = Effect.fn("spend-kill.case")(function* (spec: CaseSpec) {
  const turns = Number(values.turns);
  const kills = values.kills === undefined ? spec.kills : Number(values.kills);

  const dir = mkdtempSync(
    path.join(tmpdir(), `cairn-spend-kill-${spec.name}-`)
  );

  const started = Date.now();
  const reportFile = path.join(dir, "report.json");
  let landed = 0;

  for (let life = 0; life < kills; life += 1) {
    const child = yield* startBrain(dir, spec, turns, false);

    const ready = yield* Effect.result(
      waitForLine(child, "producing", "60 seconds")
    );

    if (Result.isFailure(ready)) {
      yield* killHard(child);

      return {
        case: spec.name,
        pass: false,
        failures: [{ kind: "other" as const, text: ready.failure }],
        dir,
      };
    }

    const delay = values.quick
      ? yield* Random.nextIntBetween(50, 150)
      : yield* Random.nextIntBetween(100, 1500);

    yield* Effect.sleep(Duration.millis(delay));
    yield* killHard(child);
    landed += 1;
  }

  const last = yield* startBrain(dir, spec, turns, true);
  const done = yield* Effect.result(waitForLine(last, "done", "180 seconds"));

  yield* killHard(last);

  if (Result.isFailure(done) || !existsSync(reportFile)) {
    return {
      case: spec.name,
      pass: false,
      failures: [
        {
          kind: "other" as const,
          text: Result.isFailure(done) ? done.failure : "no report",
        },
      ],
      dir,
    };
  }

  const report = yield* decodeReport(readFileSync(reportFile, "utf-8"));
  const retriedFile = path.join(dir, "retried.json");

  // Tasks the kills parked, which the last life ran again.
  const retriedParked = existsSync(retriedFile)
    ? Number(readFileSync(retriedFile, "utf-8"))
    : 0;

  const failures = check(spec, report);

  if (!values.keep) {
    rmSync(dir, { recursive: true, force: true });
  }

  const bridge = Object.values(report.truth).filter(
    (truth) => truth.listMicros !== null
  );

  return {
    case: spec.name,
    pass: failures.length === 0,
    kills: landed,
    retriedParked,
    turns,
    responses: Object.values(report.truth).reduce(
      (sum, truth) => sum + truth.responses,
      0
    ),
    listMicros: bridge.reduce((sum, truth) => sum + (truth.listMicros ?? 0), 0),
    // What pricing each thread's sum as one request would have said instead.
    sumPricedMicros: bridge.reduce(
      (sum, truth) => sum + (truth.sumPricedMicros ?? 0),
      0
    ),
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
      yield* Console.log(`${name}: not a case (kills or control)`);
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
