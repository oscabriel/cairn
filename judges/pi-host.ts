// The durable run of a tools-only pi tool (ADR 0039, reach R8, the reach note's "Durable run of a
// tools-only tool"): a judge brain (`fixtures/pi-host/HostBrain.ts`, Cairn's pi-durable Harness
// over a scratch directory on pi-ai's faux model, the tools-only pi host loading the user's real
// `pi-web-access` and `@ff-labs/pi-fff` beside the `pi-host-counter` fixture) is `kill -9`ed while
// two fixture calls run, then reopened.
//
//   node judges/pi-host.ts [--case kills|control]... [--kills N] [--user-agent <dir>] [--no-real]
//                          [--keep]
//
// Per case:
//
// 1. Life `call`: the real packages load through pi's own loader and answer (`ffgrep` finds a
//    fresh nonce in a scratch folder, `get_search_content` answers with its own "no stored
//    results"), then two threads call `counter_safe` and `counter_unsafe`, each of which counts its
//    run in a file and waits on a hold. Once both counted, `kill -9`.
// 2. With the hold kept, `--kills` minus one more lives resume and are killed once the safe call has
//    counted its rerun.
// 3. The hold lifted, a life resumes and finishes both threads, and runs `ffgrep` again in a new
//    folder (the restart dropped every folder instance).
// 4. Life `read` reopens without resuming and reads back what the store committed.
//
// Passes when: the safe call ran once per life that reached it (1 + kills) and committed exactly
// one result, "counter_safe ran N times", not an error; the unsafe call ran once and committed
// exactly one result, pi-durable's "interrupted"; both threads finished; the read-back equals what
// the resuming life saw; and, with the real packages, both loaded with their tools and answered
// from their own code before and after the kill. The pi home (`~/.pi`) must be identical before and
// after but for `exa-usage.json`, the Exa counter Cairn shares with the TUI (ADR 0039): the scratch
// agent dir's `npm` is a symlink to the user's installed packages, read only.
//
// The broken control is a host whose replay table forgets `counter_safe`: the safe call must come
// back interrupted, so the case fails by replay alone, or the judge proves nothing. Prints one JSON
// line per case and a summary; exits 0 when kills passes and the control fails rightly. Faux model,
// no network, no secrets, $0.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import type { Duration } from "effect";
import { Console, Effect, Option, Result, Schema } from "effect";

const root = path.join(import.meta.dirname, "..");

const brainScript = path.join(
  import.meta.dirname,
  "fixtures",
  "pi-host",
  "HostBrain.ts"
);

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    kills: { type: "string", default: "2" },
    "user-agent": { type: "string" },
    "no-real": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});

const userAgent =
  values["user-agent"] ??
  process.env.PI_CODING_AGENT_DIR ??
  path.join(homedir(), ".pi", "agent");

/** The pi home the judge watches: the agent dir's parent, `~/.pi` by default. */
const piHome = path.dirname(userAgent);

/** The one file under the pi home the host may change (ADR 0039). */
const EXA_USAGE = "exa-usage.json";

interface CaseSpec {
  readonly name: string;
  readonly control: boolean;
}

const CASES: ReadonlyArray<CaseSpec> = [
  { name: "kills", control: false },
  { name: "control", control: true },
];

const Loaded = Schema.Struct({
  event: Schema.Literal("loaded"),
  packages: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      tools: Schema.Array(Schema.String),
    })
  ),
});

const ThreadReport = Schema.Struct({
  toolResults: Schema.Array(Schema.String),
  finished: Schema.Boolean,
  entries: Schema.Int,
});

const Report = Schema.Struct({
  event: Schema.Literal("report"),
  life: Schema.String,
  threads: Schema.Record(Schema.String, ThreadReport),
});

type Report = typeof Report.Type;

const BrainLine = Schema.Union([
  Loaded,
  Report,
  Schema.Struct({ event: Schema.Literal("calling") }),
]);

type BrainLine = typeof BrainLine.Type;

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(BrainLine));

/** A committed tool result, as the store holds it (the parts the judge reads). */
const ToolResult = Schema.Struct({
  model: Schema.Array(
    Schema.Struct({
      toolName: Schema.String,
      content: Schema.Array(
        Schema.Struct({ text: Schema.optionalKey(Schema.String) })
      ),
      isError: Schema.Boolean,
    })
  ),
});

const decodeResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(ToolResult)
);

/** A result's tool, its text and whether it is an error; none when it does not decode. */
const resultOf = (json: string) =>
  Option.flatMap(decodeResult(json), (entry) =>
    Option.fromUndefinedOr(entry.model[0])
  ).pipe(
    Option.map((message) => ({
      tool: message.toolName,
      text: message.content.map((part) => part.text ?? "").join("\n"),
      isError: message.isError,
    }))
  );

/** One life of the judge brain, the lines it printed so far, and a hook for each new line. */
interface Life {
  readonly child: ChildProcess;
  readonly lines: Array<BrainLine>;
}

const startLife = (
  dir: string,
  spec: CaseSpec,
  life: "call" | "resume" | "read"
) =>
  Effect.sync((): Life => {
    const args = [brainScript, "--dir", dir, "--life", life];

    if (spec.control) {
      args.push("--control");
    }

    if (!values["no-real"]) {
      args.push("--user-agent", userAgent);
    }

    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });

    const lines: Array<BrainLine> = [];
    let buffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");

      const parts = buffer.split("\n");

      buffer = parts.pop() ?? "";

      for (const part of parts) {
        Option.map(decodeLine(part), (line) => lines.push(line));
      }
    });

    return { child, lines };
  });

/** Polls `ready` every 20 ms; fails if the life exits first or `timeout` passes. */
const waitUntil = (
  life: Life,
  what: string,
  ready: () => boolean,
  timeout: Duration.Input
) =>
  Effect.gen(function* () {
    for (;;) {
      if (ready()) {
        return true;
      }

      if (life.child.exitCode !== null || life.child.signalCode !== null) {
        return yield* Effect.fail(
          `the judge brain exited (${String(life.child.exitCode)}) before ${what}`
        );
      }

      yield* Effect.sleep("20 millis");
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(`no ${what} from the judge brain in time`),
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

/** Waits for a life to exit by itself. */
const exited = (child: ChildProcess) =>
  Effect.callback<number | null>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(child.exitCode));

      return;
    }

    child.once("exit", (code) => {
      resume(Effect.succeed(code));
    });
  });

/** Runs counted in `<dir>/<tool>.runs`. */
const runsOf = (dir: string, tool: string) => {
  const file = path.join(dir, `${tool}.runs`);

  return existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line !== "").length
    : 0;
};

const reportOf = (life: Life) =>
  Option.fromUndefinedOr(
    life.lines.find((line): line is Report => line.event === "report")
  );

/** An entry's type letter, as `find -printf %y` writes it. */
const kindOf = (stat: Stats) => {
  if (stat.isDirectory()) {
    return "d";
  }

  return stat.isSymbolicLink() ? "l" : "f";
};

/** Each entry under the pi home outside the agent dir, with type, size, mtime and mode. */
const recordPiHome = (): Map<string, string> => {
  const record = new Map<string, string>();
  const agent = path.resolve(userAgent);

  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);

      if (full === agent) {
        continue;
      }

      const stat = lstatSync(full);

      record.set(
        path.relative(piHome, full),
        `${kindOf(stat)} ${String(stat.size)} ${String(stat.mtimeMs)} ${stat.mode.toString(8)}`
      );

      if (stat.isDirectory()) {
        walk(full);
      }
    }
  };

  if (existsSync(piHome)) {
    walk(piHome);
  }

  return record;
};

/** The agent dir's entries, as `recordPiHome` records them, so the judge sees it untouched. */
const recordAgentDir = (): Map<string, string> => {
  const record = new Map<string, string>();

  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = lstatSync(full);

      record.set(
        path.relative(userAgent, full),
        `${String(stat.size)} ${String(stat.mtimeMs)} ${stat.mode.toString(8)}`
      );

      if (stat.isDirectory()) {
        walk(full);
      }
    }
  };

  if (existsSync(userAgent)) {
    walk(userAgent);
  }

  return record;
};

/** Paths whose record differs between `before` and `after`. */
const changed = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
) =>
  [...new Set([...before.keys(), ...after.keys()])].filter(
    (key) => before.get(key) !== after.get(key)
  );

/** One failed check: `replay` is the failure the control must show, anything else is `other`. */
interface Failure {
  readonly kind: "replay" | "other";
  readonly text: string;
}

const other = (text: string): Failure => ({ kind: "other", text });

const replay = (text: string): Failure => ({ kind: "replay", text });

/** The real packages loaded with their tools and answered from their own code in `call`. */
const checkReal = (
  loaded: typeof Loaded.Type | undefined,
  call: Report | undefined,
  resumed: Report
): Array<Failure> => {
  const failures: Array<Failure> = [];
  const tools = new Set(loaded?.packages.flatMap((each) => each.tools));

  for (const tool of [
    "web_search",
    "fetch_content",
    "get_search_content",
    "ffgrep",
    "fffind",
  ]) {
    if (!tools.has(tool)) {
      failures.push(other(`the host did not offer ${tool}`));
    }
  }

  const answered = (report: Report | undefined, thread: string) =>
    (report?.threads[thread]?.toolResults ?? []).flatMap((json) =>
      Option.toArray(resultOf(json))
    );

  for (const [report, thread] of [
    [call, "grep"],
    [resumed, "regrep"],
  ] as const) {
    const [grep] = answered(report, thread);

    if (
      grep === undefined ||
      grep.isError ||
      !/cairn\d+nonce/u.test(grep.text)
    ) {
      failures.push(
        other(
          `${thread}: ffgrep did not find the nonce (${grep?.text ?? "no result"})`
        )
      );
    }
  }

  const [content] = answered(call, "content");

  if (content === undefined || !/No stored results/u.test(content.text)) {
    failures.push(
      other(
        `get_search_content did not answer from pi-web-access (${content?.text ?? "no result"})`
      )
    );
  }

  return failures;
};

/** The counter threads after the last resume and on read-back. */
const checkCounters = (
  dir: string,
  kills: number,
  resumed: Report,
  read: Report
): Array<Failure> => {
  const failures: Array<Failure> = [];
  const { safe } = resumed.threads;
  const { unsafe } = resumed.threads;

  if (safe === undefined || unsafe === undefined) {
    return [other("the resuming life did not report both counter threads")];
  }

  const safeRuns = runsOf(dir, "counter_safe");
  const unsafeRuns = runsOf(dir, "counter_unsafe");

  if (safeRuns !== kills + 1) {
    failures.push(
      replay(
        `counter_safe ran ${String(safeRuns)} times; expected ${String(kills + 1)} (once per life that reached it)`
      )
    );
  }

  if (unsafeRuns !== 1) {
    failures.push(
      other(`counter_unsafe ran ${String(unsafeRuns)} times; expected once`)
    );
  }

  if (safe.toolResults.length !== 1) {
    failures.push(
      other(
        `counter_safe committed ${String(safe.toolResults.length)} results; expected one`
      )
    );
  }

  if (unsafe.toolResults.length !== 1) {
    failures.push(
      other(
        `counter_unsafe committed ${String(unsafe.toolResults.length)} results; expected one`
      )
    );
  }

  const safeResult = Option.flatMap(
    Option.fromUndefinedOr(safe.toolResults[0]),
    resultOf
  );

  if (
    Option.isNone(safeResult) ||
    safeResult.value.isError ||
    safeResult.value.text !== `counter_safe ran ${String(safeRuns)} times`
  ) {
    failures.push(
      replay(
        `counter_safe's committed result is ${Option.match(safeResult, {
          onNone: () => "missing",
          onSome: (result) =>
            `"${result.text}"${result.isError ? " (error)" : ""}`,
        })}`
      )
    );
  }

  const unsafeResult = Option.flatMap(
    Option.fromUndefinedOr(unsafe.toolResults[0]),
    resultOf
  );

  if (
    Option.isNone(unsafeResult) ||
    !unsafeResult.value.isError ||
    !/interrupted/u.test(unsafeResult.value.text)
  ) {
    failures.push(
      other(
        `counter_unsafe's committed result is not interrupted: ${Option.match(unsafeResult, { onNone: () => "missing", onSome: (result) => result.text })}`
      )
    );
  }

  if (!safe.finished || !unsafe.finished) {
    failures.push(other("a counter thread did not finish after the resume"));
  }

  for (const name of ["safe", "unsafe"]) {
    const was = JSON.stringify(resumed.threads[name]?.toolResults);
    const now = JSON.stringify(read.threads[name]?.toolResults);

    if (was !== now) {
      failures.push(
        other(`${name}: the read-back differs from what the resuming life saw`)
      );
    }
  }

  if (runsOf(dir, "counter_safe") !== safeRuns) {
    failures.push(other("the read-back life ran counter_safe again"));
  }

  return failures;
};

const controlFailedRightly = (failures: ReadonlyArray<Failure>) =>
  failures.some((failure) => failure.kind === "replay") &&
  failures.every((failure) => failure.kind !== "other");

const runCase = Effect.fn("pi-host.case")(function* (spec: CaseSpec) {
  const kills = Math.max(1, Number(values.kills));
  const dir = mkdtempSync(path.join(tmpdir(), `cairn-pi-host-${spec.name}-`));
  const hold = path.join(dir, "hold");
  const started = Date.now();

  const fail = (text: string) => ({
    case: spec.name,
    pass: false,
    failures: [other(text)],
    dir,
  });

  // Life `call`: the real packages answer, then the two counter calls start and wait on the hold.
  const first = yield* startLife(dir, spec, "call");

  const calling = yield* Effect.result(
    waitUntil(
      first,
      "both counter calls running",
      () =>
        first.lines.some((line) => line.event === "calling") &&
        runsOf(dir, "counter_safe") === 1 &&
        runsOf(dir, "counter_unsafe") === 1,
      "90 seconds"
    )
  );

  yield* killHard(first.child);

  if (Result.isFailure(calling)) {
    return fail(calling.failure);
  }

  const loaded = first.lines.find(
    (line): line is typeof Loaded.Type => line.event === "loaded"
  );

  const call = Option.getOrUndefined(reportOf(first));
  const killedAt: Array<number> = [Date.now() - started];

  // Further kills: each life resumes with the hold kept and dies once the safe call reran.
  for (let n = 2; n <= kills; n += 1) {
    const life = yield* startLife(dir, spec, "resume");

    const rerun = yield* Effect.result(
      waitUntil(
        life,
        `counter_safe's run ${String(n)}`,
        () =>
          runsOf(dir, "counter_safe") >= n || runsOf(dir, "counter_unsafe") > 1,
        spec.control ? "5 seconds" : "60 seconds"
      )
    );

    yield* killHard(life.child);
    killedAt.push(Date.now() - started);

    // The control never reruns the safe call, so it has nothing to kill mid-call: go on.
    if (Result.isFailure(rerun) && !spec.control) {
      return fail(rerun.failure);
    }
  }

  rmSync(hold, { force: true });

  const resumeStart = Date.now();
  const last = yield* startLife(dir, spec, "resume");

  const done = yield* Effect.result(
    waitUntil(
      last,
      "its report",
      () => Option.isSome(reportOf(last)),
      "120 seconds"
    )
  );

  yield* exited(last.child).pipe(Effect.timeout("30 seconds"), Effect.ignore);
  yield* killHard(last.child);

  if (Result.isFailure(done)) {
    return fail(done.failure);
  }

  const resumeMs = Date.now() - resumeStart;
  const reader = yield* startLife(dir, spec, "read");

  const read = yield* Effect.result(
    waitUntil(
      reader,
      "its read-back",
      () => Option.isSome(reportOf(reader)),
      "60 seconds"
    )
  );

  yield* exited(reader.child).pipe(Effect.timeout("30 seconds"), Effect.ignore);
  yield* killHard(reader.child);

  if (Result.isFailure(read)) {
    return fail(read.failure);
  }

  const resumed = Option.getOrThrow(reportOf(last));
  const readBack = Option.getOrThrow(reportOf(reader));

  const real =
    loaded?.packages.some((each) => each.name === "@ff-labs/pi-fff") ?? false;

  const failures = checkCounters(dir, kills, resumed, readBack);

  if (!values["no-real"]) {
    failures.push(...checkReal(loaded, call, resumed));
  }

  const runs = {
    safe: runsOf(dir, "counter_safe"),
    unsafe: runsOf(dir, "counter_unsafe"),
  };

  if (!values.keep) {
    rmSync(dir, { recursive: true, force: true });
  }

  return {
    case: spec.name,
    pass: failures.length === 0,
    kills,
    killedAtMs: killedAt,
    resumeToReportMs: resumeMs,
    real,
    packages: (loaded?.packages ?? []).map(
      (each) => `${each.name}@${each.version} (${each.tools.join(" ")})`
    ),
    runs,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    failures,
    dir: values.keep ? dir : "removed",
  };
});

/** The Exa counter's month and count, or a reason it is not the shape pi-web-access writes. */
const ExaUsage = Schema.Struct({
  month: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}$/u)),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const decodeExaUsage = Schema.decodeUnknownOption(
  Schema.fromJsonString(ExaUsage)
);

const readExaUsage = () => {
  const file = path.join(piHome, EXA_USAGE);

  return existsSync(file)
    ? decodeExaUsage(readFileSync(file, "utf-8"))
    : Option.none();
};

const program = Effect.gen(function* () {
  const names = values.case ?? CASES.map((spec) => spec.name);
  const homeBefore = recordPiHome();
  const agentBefore = recordAgentDir();
  const exaBefore = readExaUsage();
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

  // The user's pi stays theirs: nothing under the pi home changed but the shared Exa counter.
  const homeChanged = changed(homeBefore, recordPiHome());
  const agentChanged = changed(agentBefore, recordAgentDir());
  const strays = homeChanged.filter((name) => name !== EXA_USAGE);
  const exaAfter = readExaUsage();

  const exaOk =
    !homeChanged.includes(EXA_USAGE) ||
    (Option.isSome(exaAfter) &&
      Option.match(exaBefore, {
        onNone: () => true,
        onSome: (before) =>
          before.month !== exaAfter.value.month ||
          before.count <= exaAfter.value.count,
      }));

  yield* Console.log(
    JSON.stringify({
      piHome: {
        entries: homeBefore.size,
        changed: homeChanged,
        agentDirEntries: agentBefore.size,
        agentDirChanged: agentChanged.length,
      },
    })
  );

  if (strays.length > 0 || agentChanged.length > 0 || !exaOk) {
    ok = false;
  }

  yield* Console.log(JSON.stringify({ summary: ok ? "pass" : "fail" }));

  if (!ok) {
    process.exitCode = 1;
  }
});

NodeRuntime.runMain(program);
