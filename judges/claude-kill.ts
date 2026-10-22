// J2 and J9 on the bridge, one case per run: the judge brain (`judge-main.ts --models real`, the
// production composition with the real Claude bridge) runs as a transient systemd user unit with
// the production unit's kill settings; a Claude thread opens with an 800-line ledger (about 22K
// tokens, so a lost prompt cache shows as a cache write that size) and runs Cairn's `bash` tool once
// to append one line to a marker file; the brain's main process gets `kill -9`:
//
// - streaming: while the reply streams, before the tool call;
// - parked: while the `bash` command still runs, so Claude Code's tool call is held in the bridge;
// - answer: after the `bash` result is committed, while Claude writes its answer.
//
// systemd restarts the brain and the thread resumes. Checks: the marker has exactly one line (the
// command never reran); the parked case committed an interrupted tool result; every `claude` child
// of the killed brain is gone within 2 s, and none ran outside the unit's cgroup (J9); the first
// reply after the restart has `cacheRead >= 10 * cacheWrite` and `cacheRead > 0` (the native
// resume kept the prefix); the restarted brain's first thread snapshot reaches a reconnected client
// within 2 s of its socket opening. Then J9's other two moves on the same unit: a clean restart and
// a stop, each with a live `claude` child before it and none left outside the cgroup after 2 s.
//   node judges/claude-kill.ts --case streaming|parked|answer [--model claude-haiku-5-5] [--keep]
//
// Ported in intent from cairn-v1 apps/server/scripts/kill-test-claude.sh at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0 (Cairn's own code). Changed: a transient unit and the
// protocol client instead of the deployed unit and v1's CLI client, a `streaming` window, the 2 s
// child and convergence limits, and J9's cgroup checks. `judges/claude-kill.sh` runs every case.
//
// The brain uses the real home (Claude Code's login lives in `~/.claude`, pi's models in
// `~/.pi/agent`, read only) and a scratch folder under `~/cairn-judges` (FolderRules admits only
// folders under the home that are not hidden), removed afterwards with the transcripts Claude Code
// wrote for it. Prints one JSON line; exit 0 when every check holds. Costs a few cents of plan usage.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { CommandId, ProjectId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import { RootWorkspace } from "@cairn/protocol/Launch";
import type { CairnRpcs } from "@cairn/protocol/Rpc";
import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import type { Entry } from "@cairn/protocol/Thread";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Clock,
  Duration,
  Effect,
  Exit,
  Option,
  Predicate,
  Random,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { RpcClient, RpcClientError, RpcGroup } from "effect/rpc";

import { projectIdFor } from "../apps/server/src/shell/ShellCommands.ts";
import * as Events from "./lib/Events.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";
import * as Unit from "./lib/Unit.ts";

const CASES = ["streaming", "parked", "answer"] as const;

type CaseName = (typeof CASES)[number];

const isCase = (name: string): name is CaseName =>
  CASES.some((known) => known === name);

const { values } = parseArgs({
  options: {
    case: { type: "string", default: "parked" },
    model: { type: "string", default: "claude-haiku-5-5" },
    keep: { type: "boolean", default: false },
  },
});

const REPO = path.resolve(import.meta.dirname, "..");

const ORIGIN = "http://judge.cairn.test";

const HOST = "judge.cairn.test";

const OWNER = "owner@loopback";

/** J2's limits: children gone, and the first snapshot after a restart. */
const LIMIT_MS = 2000;

const UP_TIMEOUT = Duration.seconds(60);

/** A check could not even be made (the brain never answered, a timeout). */
class ClaudeKillFailed extends Schema.TaggedError<ClaudeKillFailed>()(
  "ClaudeKillFailed",
  { message: Schema.String }
) {}

const fail = (message: string) =>
  Effect.fail(new ClaudeKillFailed({ message }));

type Client = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof CairnRpcs>,
  RpcClientError.RpcClientError
>;

const hex = (value: number, width: number) =>
  value.toString(16).padStart(width, "0");

const uuid7 = Effect.gen(function* () {
  const time = hex(yield* Clock.currentTimeMillis, 12);

  const parts = yield* Effect.forEach([0, 1, 2, 3, 4], () =>
    Random.nextIntBetween(0, 0xff_ff)
  );

  const [a = 0, b = 0, c = 0, d = 0, e = 0] = parts;

  return [
    time.slice(0, 8),
    time.slice(8, 12),
    `7${hex(a % 0x10_00, 3)}`,
    hex(0x80_00 + (b % 0x40_00), 4),
    `${hex(c, 4)}${hex(d, 4)}${hex(e, 4)}`,
  ].join("-");
});

/** The ledger: 800 lines a model has no reason to read, as v1 built it. */
const ledger = Array.from(
  { length: 800 },
  (_, index) =>
    `Ledger line ${index}: account ${(index * 7919) % 10_007} moved ${(index * 104_729) % 9973} units to bin ${index % 97}.`
).join("\n");

const TASKS: Readonly<Record<CaseName, (marker: string) => string>> = {
  streaming: (marker) =>
    `First write the numbers from one to one hundred in words, one per line. Then use bash to run exactly this command, once: echo ran >> ${marker}. Never run it a second time. Then say done.`,
  parked: (marker) =>
    `Use bash to run exactly this command, once, with a timeout of 120 seconds: echo ran >> ${marker} && sleep 40. Never run it a second time, even if it reports an error or an interruption. Then say in one sentence what happened.`,
  answer: (marker) =>
    `Use bash to run exactly this command, once: echo ran >> ${marker}. Never run it a second time. Then write the numbers from one to two hundred in words, one per line.`,
};

// The brain.

interface Brain {
  readonly unit: string;
  readonly dir: string;
  readonly events: string;
  readonly project: string;
}

const waitUp = (brain: Brain, from: number) =>
  Effect.gen(function* () {
    const port = yield* Events.waitForListening(brain.events, {
      from,
      timeout: UP_TIMEOUT,
    });

    yield* Events.waitFor(brain.events, "ready", Events.named("ready"), {
      from,
      timeout: UP_TIMEOUT,
    });

    return port;
  });

const rmdirIfEmpty = (folder: string) => {
  try {
    rmdirSync(folder);
  } catch {
    // Another run still uses it.
  }
};

const startBrain = Effect.gen(function* () {
  // FolderRules admits only folders under the home that are not hidden.
  const cache = path.join(os.homedir(), "cairn-judges");

  mkdirSync(cache, { recursive: true });

  const dir = mkdtempSync(path.join(cache, `claude-kill-${values.case}-`));
  const project = path.join(dir, "project");

  mkdirSync(project);

  const brain: Brain = {
    unit: `cairn-judge-claude-kill-${process.pid}`,
    dir,
    events: path.join(dir, "events.log"),
    project,
  };

  yield* Unit.start({
    name: brain.unit,
    command: [
      process.execPath,
      "apps/server/src/judge-main.ts",
      "--models",
      "real",
    ],
    cwd: REPO,
    properties: Unit.brainProperties,
    env: {
      HOME: os.homedir(),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CAIRN_PORT: "0",
      CAIRN_ORIGIN: ORIGIN,
      CAIRN_OWNER: OWNER,
      CAIRN_DATA_DIR: path.join(dir, "data"),
      CAIRN_CONFIG_DIR: path.join(dir, "config"),
      CAIRN_EVENTS_LOG: brain.events,
    },
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (!values.keep) {
        rmSync(dir, { recursive: true, force: true });
        rmSync(
          path.join(
            os.homedir(),
            ".claude",
            "projects",
            project.replaceAll(/[/.]/gu, "-")
          ),
          { recursive: true, force: true }
        );
        rmdirIfEmpty(cache);
      }
    })
  );

  return { brain, port: yield* waitUp(brain, 0) };
});

const connect = (port: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const scope = yield* Scope.make();

      const opened = yield* ProtocolClient.cairn({
        base: `http://127.0.0.1:${port}`,
        origin: ORIGIN,
        headers: { host: HOST, "x-cairn-user": OWNER },
        openTimeout: "2 seconds",
      }).pipe(
        Effect.tap((client) =>
          client["session.hello"]().pipe(Effect.timeout("2 seconds"))
        ),
        Scope.provide(scope),
        Effect.result
      );

      if (Result.isSuccess(opened)) {
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

        return opened.success;
      }

      yield* Scope.close(scope, Exit.void);
      yield* Effect.sleep("50 millis");
    }

    return yield* fail(`no socket to the brain on port ${port} after 10 s`);
  });

// The thread as a client sees it.

interface Follower {
  readonly thread: Ref.Ref<Option.Option<ThreadViewState>>;
  readonly ops: Ref.Ref<number>;
  readonly snapshotAt: Ref.Ref<Option.Option<number>>;
}

const makeFollower = Effect.gen(function* () {
  return {
    thread: yield* Ref.make(Option.none<ThreadViewState>()),
    ops: yield* Ref.make(0),
    snapshotAt: yield* Ref.make(Option.none<number>()),
  } satisfies Follower;
});

const follow = (client: Client, threadId: ThreadId, follower: Follower) =>
  Effect.gen(function* () {
    yield* Ref.set(follower.snapshotAt, Option.none());
    yield* Ref.set(follower.ops, 0);

    yield* client["thread.subscribe"]({
      threadId,
      conversationId: Option.none(),
    }).pipe(
      Stream.runForEach((item) =>
        Effect.gen(function* () {
          if (Predicate.isTagged(item, "Snapshot")) {
            const now = yield* Clock.currentTimeMillis;

            yield* Ref.update(follower.snapshotAt, (at) =>
              Option.isSome(at) ? at : Option.some(now)
            );
          } else {
            yield* Ref.update(follower.ops, (count) => count + 1);
          }

          const next = applyThreadStreamItem(
            yield* Ref.get(follower.thread),
            item
          );

          if (Result.isSuccess(next)) {
            yield* Ref.set(follower.thread, Option.some(next.success));
          }
        })
      ),
      Effect.ignore,
      Effect.forkScoped
    );
  });

const entriesOf = (follower: Follower) =>
  Effect.map(Ref.get(follower.thread), (state) =>
    Option.match(state, {
      onNone: (): ReadonlyArray<Entry> => [],
      onSome: (held) => held.view.entries,
    })
  );

const until = (
  what: string,
  check: Effect.Effect<boolean, ClaudeKillFailed>,
  timeout: Duration.Input
) =>
  Effect.gen(function* () {
    while (!(yield* check)) {
      yield* Effect.sleep("100 millis");
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => fail(`timed out waiting for ${what}`),
    })
  );

const ModelMessage = Schema.Struct({
  role: Schema.String,
  stopReason: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optionalKey(Schema.String),
      })
    )
  ),
  usage: Schema.optionalKey(
    Schema.Struct({ cacheRead: Schema.Finite, cacheWrite: Schema.Finite })
  ),
});

const decodeModel = Schema.decodeUnknownOption(ModelMessage);

const modelOf = (entry: Entry) => decodeModel(entry.model?.[0]);

const isReply = (entry: Entry) =>
  entry.kind === "pi.assistant" &&
  Option.exists(
    modelOf(entry),
    (message) =>
      message.stopReason === "stop" || message.stopReason === "toolUse"
  );

const isToolResult = (entry: Entry) => entry.kind === "pi.tool-result";

const textOf = (entry: Entry) =>
  Option.match(modelOf(entry), {
    onNone: () => "",
    onSome: (message) =>
      (message.content ?? []).map((part) => part.text ?? "").join(""),
  });

const markerLines = (marker: string) => {
  try {
    return readFileSync(marker, "utf-8")
      .split("\n")
      .filter((line) => line !== "").length;
  } catch {
    return 0;
  }
};

/** The `claude` children in the unit's cgroup now. */
const claudeChildren = (unit: string) =>
  Effect.map(Unit.processes(unit), (all) =>
    all.filter(({ command }) => /(?:^|\/)claude(?:\s|$)/u.test(command))
  );

/** Milliseconds until none of `pids` is alive, or none when some outlive `LIMIT_MS * 5`. */
const goneWithin = (pids: ReadonlyArray<number>, from: number) =>
  Effect.gen(function* () {
    for (;;) {
      const alive = yield* Effect.forEach(pids, (pid) => Unit.commandOf(pid));
      const now = yield* Clock.currentTimeMillis;

      if (alive.every(Option.isNone)) {
        return Option.some(now - from);
      }

      if (now - from > LIMIT_MS * 5) {
        return Option.none<number>();
      }

      yield* Effect.sleep("50 millis");
    }
  });

/** Runs `move` on the unit and reports the `claude` processes from before it left outside it. */
const orphansAfter = (
  unit: string,
  move: Effect.Effect<
    unknown,
    Unit.UnitError,
    ChildProcessSpawner.ChildProcessSpawner
  >
) =>
  Effect.gen(function* () {
    const before = yield* Unit.snapshot(unit);

    const children = before.filter(({ command }) =>
      /(?:^|\/)claude(?:\s|$)/u.test(command)
    );

    yield* move;
    yield* Effect.sleep(Duration.millis(LIMIT_MS));

    const left = yield* Unit.orphans(unit, children);

    return { childrenBefore: children.length, orphans: left.length };
  });

const program = Effect.gen(function* () {
  const name: CaseName = isCase(values.case) ? values.case : "parked";
  const { brain, port } = yield* startBrain;
  const marker = path.join(brain.project, "marker.txt");
  const client = yield* connect(port);
  const projectCommand = CommandId.make(yield* uuid7);

  yield* client["shell.dispatch"](
    ProjectCreate.make({
      commandId: projectCommand,
      workspaceRoot: brain.project,
      title: Option.some("claude-kill"),
    })
  );

  const threadId = ThreadId.make(yield* uuid7);

  yield* client["thread.launch"]({
    commandId: CommandId.make(yield* uuid7),
    threadId,
    projectId: ProjectId.make(projectIdFor(projectCommand)),
    title: Option.some("claude-kill"),
    model: { provider: "claude-bridge", modelId: values.model },
    thinkingLevel: "off",
    runtimeMode: "full-access",
    workspace: RootWorkspace.make({ branch: Option.none() }),
    initialMessage: {
      requestId: RequestId.make(`req_${(yield* uuid7).replaceAll("-", "")}`),
      text: `<ledger>\n${ledger}\n</ledger>\n\nIgnore the ledger. ${TASKS[name](marker)}`,
      attachments: [],
      skillRefs: [],
    },
  });

  const follower = yield* makeFollower;

  yield* follow(client, threadId, follower);

  // Aim the kill.
  yield* until(
    `the ${name} window`,
    Effect.gen(function* () {
      const entries = yield* entriesOf(follower);
      const ops = yield* Ref.get(follower.ops);

      const marked = markerLines(marker) > 0;
      const resulted = entries.some(isToolResult);

      const aims: Readonly<Record<CaseName, boolean>> = {
        streaming: ops >= 6 && !marked,
        parked: marked && !resulted,
        answer: marked && resulted,
      };

      return aims[name];
    }),
    "180 seconds"
  );

  if (name === "parked") {
    yield* Effect.sleep("1 second");
  }

  const repliesBefore = (yield* entriesOf(follower)).filter(isReply).length;
  const children = yield* claudeChildren(brain.unit);

  if (children.length === 0) {
    return yield* fail("no claude child in the unit before the kill");
  }

  const from = yield* Events.size(brain.events);
  const before = yield* Unit.snapshot(brain.unit);
  const killedAt = yield* Clock.currentTimeMillis;

  yield* Unit.killMain(brain.unit);

  const childrenGoneMs = yield* goneWithin(
    children.map(({ pid }) => pid),
    killedAt
  );

  const restartedPort = yield* waitUp(brain, from);

  const outside = yield* Unit.orphans(
    brain.unit,
    before.filter(({ command }) => /(?:^|\/)claude(?:\s|$)/u.test(command))
  );

  const reconnected = yield* connect(restartedPort);
  const upAt = yield* Clock.currentTimeMillis;
  const after = yield* makeFollower;

  yield* follow(reconnected, threadId, after);
  yield* until(
    "the first snapshot after the restart",
    Effect.map(Ref.get(after.snapshotAt), Option.isSome),
    "10 seconds"
  );

  const snapshotMs = Option.map(
    yield* Ref.get(after.snapshotAt),
    (at) => at - upAt
  );

  // The resumed turn: wait for a final reply after the restart.
  yield* until(
    "the answer after the restart",
    Effect.map(entriesOf(after), (entries) =>
      entries.some(
        (entry, index) =>
          entry.kind === "pi.assistant" &&
          index > 0 &&
          Option.exists(
            modelOf(entry),
            (message) => message.stopReason === "stop"
          ) &&
          entries.filter(isReply).length > repliesBefore
      )
    ),
    "240 seconds"
  );

  const entries = yield* entriesOf(after);

  const firstAfter = Option.fromUndefinedOr(
    entries.filter(isReply)[repliesBefore]
  );

  const usage = Option.flatMap(firstAfter, (entry) =>
    Option.flatMap(modelOf(entry), (message) =>
      Option.fromUndefinedOr(message.usage)
    )
  );

  const interrupted = entries
    .filter(isToolResult)
    .some((entry) => /interrupted/iu.test(textOf(entry)));

  // J9's other moves, with the thread's child still held.
  const restartFrom = yield* Events.size(brain.events);
  const restartMove = yield* orphansAfter(brain.unit, Unit.restart(brain.unit));

  yield* waitUp(brain, restartFrom).pipe(Effect.ignore);

  const stopMove = yield* orphansAfter(brain.unit, Unit.stop(brain.unit));

  const checks = {
    markerOnce: markerLines(marker) === 1,
    interruptedResult: name !== "parked" || interrupted,
    childrenGone: Option.exists(childrenGoneMs, (ms) => ms <= LIMIT_MS),
    noOrphansAfterKill: outside.length === 0,
    noOrphansAfterRestart: restartMove.orphans === 0,
    noOrphansAfterStop: stopMove.orphans === 0,
    cacheKept: Option.exists(
      usage,
      (found) => found.cacheRead > 0 && found.cacheRead >= 10 * found.cacheWrite
    ),
    converged: Option.exists(snapshotMs, (ms) => ms <= LIMIT_MS),
  };

  const pass = Object.values(checks).every(Boolean);

  yield* Effect.sync(() => {
    process.stdout.write(
      `${JSON.stringify({
        case: name,
        pass,
        checks,
        marker: markerLines(marker),
        childrenKilled: children.length,
        childrenGoneMs: Option.getOrNull(childrenGoneMs),
        snapshotMs: Option.getOrNull(snapshotMs),
        firstReplyAfterRestart: Option.getOrNull(usage),
        restartMove,
        stopMove,
        unit: brain.unit,
        dir: brain.dir,
      })}\n`
    );
  });

  if (!pass) {
    return yield* fail(`claude-kill ${name} failed`);
  }

  return pass;
});

NodeRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
