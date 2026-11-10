// The approval kill judge (ADR 0046, the gate of ADR 0013's S4 on pi-durable 1.5): an approval left
// pending across more crashes than pi-durable's default restart limit allows can still be answered,
// and its call runs exactly once. A judge brain (`fixtures/approval-kill/ApprovalBrain.ts`: Cairn's
// production seam, brain, extension set and boot repairs over pi-ai's faux provider and a scratch
// folder, never the deployed unit) runs one thread in Supervised whose model calls the gated
// `bash` once. The judge `kill -9`s the brain while the call waits on its approval, six times (each
// life must show the approval pending again before it dies), then a seventh life accepts it as the
// user would and waits until the thread is idle.
//
//   node judges/approval-kill.ts [--case real|control]... [--kills N] [--keep]
//
// Checks on the last life: the approval was pending after every restart; it is accepted, by the
// user; the command ran exactly once (`effects.log` has one line); the call's result is not an
// error. Cases (default: both):
// - real: the brain as it ships (crashes end no tool call, `RestartLimit.ts`); every check passes.
// - control: the broken control, the brain opened with pi-durable's own restart limit, as a bump
//   that kept it would. The call ends with a restart-limit error after the fifth crash, so the
//   approval is no longer answerable or its call never runs, and the case must fail.
//
// Prints one JSON line per case and a summary; exits 0 when the real case passes and the control
// fails. Kills only the processes it started. No model, no network, no secrets, $0.

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Console, Duration, Effect, Option, Schema } from "effect";

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    kills: { type: "string", default: "6" },
    keep: { type: "boolean", default: false },
  },
});

const root = path.resolve(import.meta.dirname, "..");

const brainScript = path.join(
  root,
  "judges",
  "fixtures",
  "approval-kill",
  "ApprovalBrain.ts"
);

/** How long a life may take to show the approval pending again. */
const PENDING_TIMEOUT_MS = 30_000;

/** How long the last life may take to answer and come to rest. */
const ANSWER_TIMEOUT_MS = 60_000;

/** How long after the approval shows pending a life is killed: long enough to be waiting again. */
const KILL_AFTER_MS = 300;

const Line = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("pending"),
    approvalId: Schema.String,
  }),
  Schema.Struct({ event: Schema.Literal("gone") }),
  Schema.Struct({
    event: Schema.Literal("report"),
    effects: Schema.Finite,
    approvals: Schema.Array(
      Schema.Struct({
        status: Schema.String,
        decidedBy: Schema.NullOr(Schema.String),
      })
    ),
    results: Schema.Array(
      Schema.Struct({ isError: Schema.Boolean, text: Schema.String })
    ),
  }),
]);

type Line = typeof Line.Type;

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line));

type BrainProcess = ChildProcessByStdio<null, Readable, null>;

/** One life: its process and the lines it printed. */
interface Life {
  readonly child: BrainProcess;
  readonly lines: Array<Line>;
  readonly exited: Promise<unknown>;
}

const startLife = (dir: string, step: string, control: boolean): Life => {
  const args = [brainScript, "--dir", dir, "--step", step];

  if (control) {
    args.push("--control");
  }

  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
  });

  const lines: Array<Line> = [];
  let buffered = "";

  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf-8");

    const parts = buffered.split("\n");

    buffered = parts.pop() ?? "";

    for (const part of parts) {
      for (const line of Option.toArray(decodeLine(part))) {
        lines.push(line);
      }
    }
  });

  const exited = once(child, "exit");

  return { child, lines, exited };
};

/** Waits until `life` printed a line `found` accepts, or `ms` passed. */
const lineOf = <A>(
  life: Life,
  found: (line: Line) => Option.Option<A>,
  ms: number
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;

    while (Date.now() < deadline) {
      for (const line of life.lines) {
        const value = found(line);

        if (Option.isSome(value)) {
          return value;
        }
      }

      if (life.child.exitCode !== null) {
        return Option.none<A>();
      }

      yield* Effect.sleep("50 millis");
    }

    return Option.none<A>();
  });

const pendingOf = (line: Line) =>
  line.event === "pending" ? Option.some(line.approvalId) : Option.none();

const reportOf = (line: Line) =>
  line.event === "report" ? Option.some(line) : Option.none();

const kill = (life: Life) =>
  Effect.promise(async () => {
    life.child.kill("SIGKILL");
    await life.exited;
  });

/** One case: `kills` lives killed with the approval pending, then the answering life. */
const runCase = (name: "real" | "control", kills: number) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(
      path.join(os.tmpdir(), `cairn-approval-kill-${name}-`)
    );

    const control = name === "control";
    const failures: Array<string> = [];
    const pendingIds = new Set<string>();
    let landed = 0;

    for (let index = 0; index < kills; index += 1) {
      const life = startLife(dir, index === 0 ? "ask" : "wait", control);
      const pending = yield* lineOf(life, pendingOf, PENDING_TIMEOUT_MS);

      if (Option.isNone(pending)) {
        failures.push(
          `life ${String(index + 1)}: the approval was not pending`
        );
      } else {
        pendingIds.add(pending.value);
        yield* Effect.sleep(Duration.millis(KILL_AFTER_MS));
      }

      yield* kill(life);
      landed += Option.isSome(pending) ? 1 : 0;
    }

    const last = startLife(dir, "answer", control);
    const report = yield* lineOf(last, reportOf, ANSWER_TIMEOUT_MS);

    yield* kill(last);

    if (landed < kills) {
      failures.push(
        `${String(landed)} of ${String(kills)} kills landed with the approval pending`
      );
    }

    if (pendingIds.size > 1) {
      failures.push(
        `the approval changed across lives: ${[...pendingIds].join(", ")}`
      );
    }

    Option.match(report, {
      onNone: () => {
        failures.push("the answering life wrote no report");
      },
      onSome: (found) => {
        if (found.effects !== 1) {
          failures.push(
            `the command ran ${String(found.effects)} times, expected once`
          );
        }

        const approval = found.approvals.at(0);

        if (
          found.approvals.length !== 1 ||
          approval?.status !== "accepted" ||
          approval.decidedBy !== "user"
        ) {
          failures.push(
            `approvals ${JSON.stringify(found.approvals)}, expected one accepted by the user`
          );
        }

        if (found.results.length !== 1 || found.results[0]?.isError !== false) {
          failures.push(
            `results ${JSON.stringify(found.results)}, expected one that is not an error`
          );
        }
      },
    });

    if (!values.keep) {
      rmSync(dir, { recursive: true, force: true });
    }

    return {
      case: name,
      control,
      pass: failures.length === 0,
      kills: landed,
      failures,
      report: Option.getOrNull(report),
      kept: values.keep ? dir : null,
    };
  });

const program = Effect.gen(function* () {
  const kills = Number(values.kills);

  const cases = (values.case ?? ["real", "control"]).filter(
    (name): name is "real" | "control" => name === "real" || name === "control"
  );

  const results = [];

  for (const name of cases) {
    const result = yield* runCase(name, kills);

    yield* Console.log(JSON.stringify(result));
    results.push(result);
  }

  const real = results.filter((result) => !result.control);
  const controls = results.filter((result) => result.control);

  // A control passes the judge only by failing its checks.
  const ok =
    real.every((result) => result.pass) &&
    controls.every((result) => !result.pass);

  yield* Console.log(
    JSON.stringify({
      summary: "approval-kill",
      real: real.map((result) => result.pass),
      controlFailed: controls.map((result) => !result.pass),
      pass: ok,
    })
  );

  if (!ok) {
    process.exitCode = 1;
  }
});

NodeRuntime.runMain(program);
