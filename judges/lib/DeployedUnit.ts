// The production unit's durability checks (plan 5F; ADR 0022's gate on the real `cairn.service`).
// Production loads no judge tools and no faux provider, so the turns run on a cheap real model and
// hold the brain with the coding tool `bash sleep 20` instead of the judge tools `slow` and `mark`.
//
//   yield* DeployedUnit.restarts({ unit: "cairn.service", model })   // `judges/shutdown.sh --unit`
//   yield* DeployedUnit.streaming({ unit: "cairn.service", model })  // `judges/durability.ts --unit`
//
// `restarts`: six `systemctl --user restart`s while `bash sleep 20` runs. Each stopped invocation
// logged `closing` and `closed <ms>` with ms under 5,000 and no `shutdown_slow`; `NRestarts` is
// unchanged; the turn ends with nothing parked; the reconnected client equals a fresh one.
//
// `streaming`: one `kill -9` of the unit's main pid while the reply streams (80 characters into
// pi-durable's live reply). Every entry committed before the kill is kept, no `claude` process of
// the killed brain is alive outside the unit's cgroup 2 s after the kill, the restarted brain's
// first thread snapshot reaches a reconnected client within 2 s of its socket opening, the
// reconnected client equals a fresh one within 2 s of the turn going quiet, and the unit is
// active again with one more `NRestarts` (the start limit never tripped).
//
// Both talk straight to the brain's port with the headers Caddy would add, as
// `ops/cairn/deploy-check.ts` does, read `~/.config/cairn/cairn.json` (no secret) and delete their
// thread afterwards unless `keep`. Each answers one JSON-able result; no reply text is reported.

import { homedir } from "node:os";

import {
  applyShellStreamItem,
  shellCursor,
} from "@cairn/client-logic/ShellReducer";
import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { CommandId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import { RootWorkspace } from "@cairn/protocol/Launch";
import type { CairnRpcs } from "@cairn/protocol/Rpc";
import { ShellSnapshot } from "@cairn/protocol/Shell";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { ThreadDelete } from "@cairn/protocol/ShellCommands";
import { ConversationView } from "@cairn/protocol/Thread";
import type { Entry } from "@cairn/protocol/Thread";
import {
  Clock,
  Console,
  Effect,
  Exit,
  FileSystem,
  Option,
  Predicate,
  Random,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { RpcClient, RpcClientError, RpcGroup } from "effect/rpc";

import * as Events from "./Events.ts";
import * as ProtocolClient from "./ProtocolClient.ts";
import * as Unit from "./Unit.ts";

export interface Options {
  /** `cairn.service` or `cairn`. */
  readonly unit: string;
  /** `<provider>/<modelId>`. */
  readonly model: string;
  /** Keep the judge's thread instead of deleting it. */
  readonly keep: boolean;
}

export class DeployedUnitFailed extends Schema.TaggedError<DeployedUnitFailed>()(
  "DeployedUnitFailed",
  { message: Schema.String }
) {}

const fail = (message: string) =>
  Effect.fail(new DeployedUnitFailed({ message }));

const CLOSED_LIMIT_MS = 5000;

const CONVERGE_MS = 2000;

const UP_DEADLINE_MS = 60_000;

const QUIET_DEADLINE_MS = 300_000;

/** pi-durable's live reply must hold this many characters before the kill lands. */
const STREAM_AIM_CHARS = 80;

const RESTARTS = 6;

const CLAUDE_COMMAND = /(?:^|\/)claude(?:\s|$)/u;

const SLEEP_PROMPT =
  "Use the bash tool to run exactly this command: sleep 20. If its result says it was interrupted or may not have finished, run the same command again, as many times as needed. Once one run finishes normally, reply with the single word: done.";

const AGAIN_PROMPT =
  "Run exactly the same bash command again: sleep 20. Then reply with the single word: done.";

const STREAM_PROMPT =
  "Write a numbered list of 60 short facts about granite, one fact per line, at least ten words each. Use no tool.";

type Client = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof CairnRpcs>,
  RpcClientError.RpcClientError
>;

const CairnJson = Schema.fromJsonString(
  Schema.Struct({
    owner: Schema.String,
    host: Schema.String,
    origin: Schema.String,
  })
);

const unitName = (unit: string) => unit.replace(/\.service$/u, "");

// Ids, as the browser mints them.

const hex = (value: number, width: number) =>
  value.toString(16).padStart(width, "0");

const uuid7 = Effect.gen(function* () {
  const time = hex(yield* Clock.currentTimeMillis, 12);

  const [a = 0, b = 0, c = 0, d = 0, e = 0] = yield* Effect.forEach(
    [0, 1, 2, 3, 4],
    () => Random.nextIntBetween(0, 0xff_ff)
  );

  return [
    time.slice(0, 8),
    time.slice(8, 12),
    `7${hex(a % 0x10_00, 3)}`,
    hex(0x80_00 + (b % 0x40_00), 4),
    `${hex(c, 4)}${hex(d, 4)}${hex(e, 4)}`,
  ].join("-");
});

const newCommandId = Effect.map(uuid7, (id) => CommandId.make(id));

const newRequestId = Effect.map(uuid7, (id) =>
  RequestId.make(`req_${id.replaceAll("-", "")}`)
);

/** Polls `check` every 50 ms until it holds, or fails with `what` after `ms`. */
// Generic in what `check` needs, so an arrow over `Effect.gen`: `fnUntraced` would widen E and R.
const until = <E, R>(
  what: string,
  check: Effect.Effect<boolean, E, R>,
  ms: number
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;

    while (!(yield* check)) {
      if ((yield* Clock.currentTimeMillis) - started > ms) {
        return yield* fail(`timed out after ${ms} ms waiting for ${what}`);
      }

      yield* Effect.sleep("50 millis");
    }

    return (yield* Clock.currentTimeMillis) - started;
  });

// The unit.

interface Target {
  readonly unit: string;
  readonly owner: string;
  readonly host: string;
  readonly origin: string;
}

const readTarget = Effect.fnUntraced(function* (unit: string) {
  const fs = yield* FileSystem.FileSystem;

  const text = yield* fs.readFileString(
    `${homedir()}/.config/cairn/cairn.json`
  );

  const config = yield* Schema.decodeEffect(CairnJson)(text);

  return { unit: unitName(unit), ...config } satisfies Target;
});

/** The port of the unit's invocation other than `previous`, once it logged `listening`. */
const portAfter = Effect.fnUntraced(function* (
  target: Target,
  previous: string
) {
  const started = yield* Clock.currentTimeMillis;

  while ((yield* Clock.currentTimeMillis) - started < UP_DEADLINE_MS) {
    const invocation = yield* Unit.invocationId(target.unit);

    if (invocation !== "" && invocation !== previous) {
      const port = Events.parseLines(
        yield* Unit.journal(target.unit, invocation)
      )
        .filter(Events.named("listening"))
        .flatMap((event) => Option.toArray(Events.numberField(event, "port")))
        .at(0);

      if (port !== undefined) {
        return { invocation, port };
      }
    }

    yield* Effect.sleep("100 millis");
  }

  return yield* fail(
    `${target.unit} logged no listening line from a new invocation within ${UP_DEADLINE_MS} ms`
  );
});

/** A client in the caller's scope, retried on a fresh socket until `session.hello` answers. */
const connect = Effect.fnUntraced(function* (target: Target, port: number) {
  const started = yield* Clock.currentTimeMillis;

  while ((yield* Clock.currentTimeMillis) - started < UP_DEADLINE_MS) {
    const scope = yield* Scope.make();

    const opened = yield* ProtocolClient.cairn({
      base: `http://127.0.0.1:${port}`,
      origin: target.origin,
      headers: { Host: target.host, "X-Cairn-User": target.owner },
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
    yield* Effect.sleep("100 millis");
  }

  return yield* fail(`no socket to port ${port} within ${UP_DEADLINE_MS} ms`);
});

// A client's view of the thread and the shell.

interface Follower {
  readonly thread: Ref.Ref<Option.Option<ThreadViewState>>;
  readonly shell: Ref.Ref<Option.Option<ShellSnapshot>>;
  readonly snapshotAt: Ref.Ref<Option.Option<number>>;
  readonly errors: Ref.Ref<ReadonlyArray<string>>;
}

const makeFollower = Effect.gen(function* () {
  return {
    thread: yield* Ref.make(Option.none<ThreadViewState>()),
    shell: yield* Ref.make(Option.none<ShellSnapshot>()),
    snapshotAt: yield* Ref.make(Option.none<number>()),
    errors: yield* Ref.make<ReadonlyArray<string>>([]),
  } satisfies Follower;
});

/** Follows the thread and the shell on `client` for the caller's scope. */
const follow = Effect.fnUntraced(function* (
  client: Client,
  threadId: ThreadId,
  follower: Follower
) {
  yield* Ref.set(follower.snapshotAt, Option.none());

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
        }

        const next = applyThreadStreamItem(
          yield* Ref.get(follower.thread),
          item
        );

        if (Result.isFailure(next)) {
          yield* Ref.update(follower.errors, (errors) => [
            ...errors,
            next.failure.message,
          ]);

          return;
        }

        yield* Ref.set(follower.thread, Option.some(next.success));
      })
    ),
    Effect.ignore,
    Effect.forkScoped
  );

  yield* client["shell.subscribe"]({
    afterSequence: shellCursor(yield* Ref.get(follower.shell)),
    requestCompletionMarker: false,
  }).pipe(
    Stream.runForEach((item) =>
      Ref.update(follower.shell, (state) => applyShellStreamItem(state, item))
    ),
    Effect.ignore,
    Effect.forkScoped
  );
});

const viewOf = (follower: Follower) =>
  Effect.map(Ref.get(follower.thread), (state) =>
    Option.map(state, (held) => held.view)
  );

const entriesOf = (view: Option.Option<ConversationView>) =>
  Option.match(view, {
    onNone: (): ReadonlyArray<Entry> => [],
    onSome: (found) => found.entries,
  });

const rowOf = (follower: Follower, threadId: ThreadId) =>
  Effect.map(Ref.get(follower.shell), (shell) =>
    Option.flatMap(shell, (snapshot) =>
      Option.fromUndefinedOr(
        snapshot.threads.find((thread) => thread.id === threadId)
      )
    )
  );

const PartsOf = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
    })
  ),
});

const decodeParts = Schema.decodeUnknownOption(PartsOf);

const callsTool = (entry: Entry, tool: string) =>
  entry.kind === "pi.assistant" &&
  Option.exists(decodeParts(entry.model?.[0]), (message) =>
    message.content.some(
      (part) => part.type === "toolCall" && part.name === tool
    )
  );

/** The newest entry's id when it is an assistant call of `tool` with no result after it. */
const pendingCall = (entries: ReadonlyArray<Entry>, tool: string) =>
  Option.filter(Option.fromUndefinedOr(entries.at(-1)), (last) =>
    callsTool(last, tool)
  ).pipe(Option.map((last) => last.id));

/** A pending call of `tool` other than the one `previous` names. */
const freshCall = (
  entries: ReadonlyArray<Entry>,
  tool: string,
  previous: Option.Option<Entry["id"]>
) =>
  Option.exists(
    pendingCall(entries, tool),
    (id) => !Option.contains(previous, id)
  );

const ResultOf = Schema.Struct({
  toolName: Schema.optionalKey(Schema.String),
  isError: Schema.optionalKey(Schema.Boolean),
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optionalKey(Schema.String),
    })
  ),
});

const decodeResult = Schema.decodeUnknownOption(ResultOf);

/** The results of `tool` calls: whether each says it was interrupted, and whether it is an error. */
const toolResults = (entries: ReadonlyArray<Entry>, tool: string) =>
  entries.flatMap((entry) =>
    entry.kind === "pi.tool-result"
      ? decodeResult(entry.model?.[0]).pipe(
          Option.filter((result) => result.toolName === tool),
          Option.map((result) => ({
            interrupted: /interrupted/iu.test(
              result.content.map((part) => part.text ?? "").join("")
            ),
            isError: result.isError === true,
          })),
          Option.toArray
        )
      : []
  );

const LiveDoc = Schema.Struct({
  generation: Schema.optionalKey(
    Schema.Struct({ message: Schema.optionalKey(PartsOf) })
  ),
});

const decodeLive = Schema.decodeUnknownOption(LiveDoc);

/** Characters of text in the reply pi-durable is streaming now (`pi.live`). */
const partialChars = (view: Option.Option<ConversationView>) =>
  Option.match(
    Option.flatMap(view, (found) => decodeLive(found.docs["pi.live"])),
    {
      onNone: () => 0,
      onSome: (live) =>
        (live.generation?.message?.content ?? [])
          .map((part) => part.text ?? "")
          .join("").length,
    }
  );

const isQuiet = (row: Option.Option<ThreadShell>) =>
  Option.exists(
    row,
    (thread) =>
      thread.activity === "idle" &&
      Option.isNone(thread.activeRunId) &&
      thread.queueLength === 0 &&
      Option.exists(
        thread.latestVisibleMessage,
        (message) => message.role === "assistant"
      )
  );

const sameView = Schema.toEquivalence(ConversationView);

const sameShell = Schema.toEquivalence(ShellSnapshot);

// The steps both checks share.

/** Launches the judge's thread in the scratch project; answers its id. */
const launch = Effect.fnUntraced(function* (
  client: Client,
  model: string,
  prompt: string
) {
  const slash = model.indexOf("/");

  if (slash <= 0) {
    return yield* fail(`--model ${model} is not <provider>/<modelId>`);
  }

  const scratch = yield* client["projects.ensureScratch"]();
  const threadId = ThreadId.make(yield* uuid7);

  yield* client["thread.launch"]({
    commandId: yield* newCommandId,
    threadId,
    projectId: scratch.id,
    title: Option.some("Deployed unit judge"),
    model: {
      provider: model.slice(0, slash),
      modelId: model.slice(slash + 1),
    },
    thinkingLevel: "off",
    runtimeMode: "full-access",
    workspace: RootWorkspace.make({ branch: Option.none() }),
    initialMessage: {
      requestId: yield* newRequestId,
      text: prompt,
      attachments: [],
      skillRefs: [],
    },
  });

  return threadId;
});

/** Opens a client on the new invocation and follows; answers the ms from socket to first snapshot. */
const reconnect = Effect.fnUntraced(function* (
  target: Target,
  previous: string,
  threadId: ThreadId,
  follower: Follower
) {
  const { invocation, port } = yield* portAfter(target, previous);
  const client = yield* connect(target, port);
  const opened = yield* Clock.currentTimeMillis;

  yield* follow(client, threadId, follower);
  yield* until(
    "the first thread snapshot after the restart",
    Effect.map(Ref.get(follower.snapshotAt), Option.isSome),
    10_000
  );

  const at = yield* Ref.get(follower.snapshotAt);

  return {
    invocation,
    port,
    client,
    snapshotMs: Option.getOrElse(at, () => opened) - opened,
  };
});

/**
 * Waits for the turn to go quiet on `follower`, then for it to equal a fresh client within 2 s.
 * Answers the oracle's entries, the quiet row and the ms from quiet to equal.
 */
const converge = Effect.fnUntraced(function* (
  target: Target,
  port: number,
  threadId: ThreadId,
  follower: Follower
) {
  yield* until(
    "the turn to end",
    Effect.map(rowOf(follower, threadId), isQuiet),
    QUIET_DEADLINE_MS
  );

  const quietAt = yield* Clock.currentTimeMillis;
  const oracle = yield* makeFollower;

  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* follow(yield* connect(target, port), threadId, oracle);
      yield* until(
        "the fresh client's snapshots",
        Effect.map(
          Effect.all([viewOf(oracle), Ref.get(oracle.shell)]),
          ([view, shell]) => Option.isSome(view) && Option.isSome(shell)
        ),
        10_000
      );
    })
  );

  const oracleView = yield* viewOf(oracle);
  const oracleShell = yield* Ref.get(oracle.shell);

  const equal = yield* until(
    "the reconnected client to equal a fresh one",
    Effect.gen(function* () {
      const view = yield* viewOf(follower);
      const shell = yield* Ref.get(follower.shell);

      return (
        Option.isSome(view) &&
        Option.isSome(oracleView) &&
        sameView(view.value, oracleView.value) &&
        Option.isSome(shell) &&
        Option.isSome(oracleShell) &&
        sameShell(shell.value, oracleShell.value)
      );
    }),
    CONVERGE_MS
  ).pipe(Effect.result);

  const errors = yield* Ref.get(follower.errors);

  if (Result.isFailure(equal)) {
    return yield* fail(
      `the reconnected client did not equal a fresh one within ${CONVERGE_MS} ms${errors.length > 0 ? `: ${errors.join("; ")}` : ""}`
    );
  }

  return {
    entries: entriesOf(oracleView),
    row: yield* rowOf(oracle, threadId),
    quietToEqualMs: (yield* Clock.currentTimeMillis) - quietAt,
  };
});

const lostEntries = (
  before: ReadonlyArray<Entry>,
  after: ReadonlyArray<Entry>
) => {
  const ids = new Set(after.map((entry) => entry.id));

  return before.filter((entry) => !ids.has(entry.id)).length;
};

/** Deletes the judge's thread; a failed delete becomes a note, so the thread is not left unseen. */
const remove = Effect.fnUntraced(function* (
  client: Client,
  threadId: ThreadId
) {
  const sent = yield* Effect.result(
    client["shell.dispatch"](
      ThreadDelete.make({ commandId: yield* newCommandId, threadId })
    )
  );

  return Result.isSuccess(sent)
    ? []
    : [`thread ${threadId} not deleted: ${sent.failure.message}`];
});

/**
 * Deletes the judge's thread unless `keep`, however the check ends. The check calls the returned
 * `removeWith` on its way out to have a failed delete in its notes; when a step fails or times out
 * first, the scope's finalizer deletes the thread over a fresh socket and prints a failed delete.
 */
const ownThread = Effect.fnUntraced(function* (
  target: Target,
  threadId: ThreadId,
  keep: boolean
) {
  const removed = yield* Ref.make(keep);

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (yield* Ref.getAndSet(removed, true)) {
        return;
      }

      const up = yield* portAfter(target, "");
      const client = yield* connect(target, up.port);
      const notes = yield* remove(client, threadId);

      yield* Effect.forEach(notes, (note) => Console.error(note));
    }).pipe(
      Effect.scoped,
      Effect.catch((error) =>
        Console.error(`thread ${threadId} not deleted: ${error.message}`)
      )
    )
  );

  return {
    removeWith: (client: Client) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(removed, true)) {
          return [];
        }

        return yield* remove(client, threadId);
      }),
  };
});

const lastErrorNotes = (row: Option.Option<ThreadShell>) =>
  Option.match(
    Option.flatMap(row, (thread) => thread.lastError),
    { onNone: () => [], onSome: (error) => [`lastError: ${error}`] }
  );

/** `bash` results that neither failed nor say they were interrupted. */
const completedRuns = (entries: ReadonlyArray<Entry>) =>
  toolResults(entries, "bash").filter(
    (result) => !result.interrupted && !result.isError
  ).length;

/** Asks for one more `sleep 20` and waits for its call, newer than `seen`, to be pending. */
const runAgain = Effect.fnUntraced(function* (
  client: Client,
  threadId: ThreadId,
  follower: Follower,
  seen: Option.Option<Entry["id"]>,
  before: string
) {
  yield* client["thread.send"]({
    threadId,
    input: {
      requestId: yield* newRequestId,
      text: AGAIN_PROMPT,
      attachments: [],
      skillRefs: [],
    },
    whenBusy: "followUp",
  });
  yield* until(
    `bash to run again before ${before}`,
    Effect.map(viewOf(follower), (view) =>
      freshCall(entriesOf(view), "bash", seen)
    ),
    120_000
  );
  // The shell row can trail the thread view; wait for it to show the run, so a later quiet is this one's.
  yield* until(
    `the shell row to show the run before ${before}`,
    Effect.map(rowOf(follower, threadId), (row) => !isQuiet(row)),
    10_000
  );
});

// The two checks.

/** Six clean restarts during a `bash sleep 20` turn. */
export const restarts = Effect.fnUntraced(function* (options: Options) {
  const target = yield* readTarget(options.unit);
  const notes: Array<string> = [];
  const restartsBefore = yield* Unit.restarts(target.unit);
  let previous = "";

  let { port } = yield* portAfter(target, previous);
  let client = yield* connect(target, port);

  const follower = yield* makeFollower;
  const threadId = yield* launch(client, options.model, SLEEP_PROMPT);
  const owned = yield* ownThread(target, threadId, options.keep);

  yield* follow(client, threadId, follower);

  const closedMs: Array<number> = [];
  const stopMs: Array<number> = [];
  const snapshotMs: Array<number> = [];
  let slow = 0;

  let followUps = 0;
  // The bash call pending at the previous restart: each restart waits for a newer one, so it
  // interrupts a call of its own.
  let interruptedCall = Option.none<Entry["id"]>();

  for (let count = 1; count <= RESTARTS; count += 1) {
    const seen = interruptedCall;

    // The model may end the turn after an interrupted `bash` instead of running it again; then
    // one more message asks for another run, so every restart lands during `bash sleep 20`.
    const bashOrQuiet = Effect.gen(function* () {
      const view = yield* viewOf(follower);
      const row = yield* rowOf(follower, threadId);

      return freshCall(entriesOf(view), "bash", seen) || isQuiet(row);
    });

    yield* until(`bash to run before restart ${count}`, bashOrQuiet, 120_000);

    if (isQuiet(yield* rowOf(follower, threadId))) {
      followUps += 1;
      yield* runAgain(client, threadId, follower, seen, `restart ${count}`);
    }

    yield* Effect.sleep("500 millis");

    const pending = pendingCall(entriesOf(yield* viewOf(follower)), "bash");

    if (Option.isNone(pending)) {
      return yield* fail(
        `restart ${count}: the bash call finished within 500 ms of starting`
      );
    }

    interruptedCall = pending;
    previous = yield* Unit.invocationId(target.unit);

    const at = yield* Clock.currentTimeMillis;

    yield* Unit.restart(target.unit);
    stopMs.push((yield* Clock.currentTimeMillis) - at);

    const stopped = Events.parseLines(
      yield* Unit.journal(target.unit, previous)
    );

    const closed = stopped
      .filter(Events.named("closed"))
      .flatMap((event) => Option.toArray(Events.numberField(event, "ms")));

    if (stopped.filter(Events.named("closing")).length === 0) {
      notes.push(`restart ${count}: no closing line`);
    }

    closedMs.push(closed.at(-1) ?? Number.NaN);
    slow += stopped.filter(Events.named("shutdown_slow")).length;

    const next = yield* reconnect(target, previous, threadId, follower);

    ({ port, client } = next);
    snapshotMs.push(next.snapshotMs);
  }

  let outcome = yield* converge(target, port, threadId, follower);

  // The model may also stop after the last interrupted run; one more message gets the run that
  // finishes, which the gate needs as much as the six interrupted ones.
  if (completedRuns(outcome.entries) === 0) {
    followUps += 1;
    yield* runAgain(client, threadId, follower, interruptedCall, "the end");
    outcome = yield* converge(target, port, threadId, follower);
  }

  const restartsAfter = yield* Unit.restarts(target.unit);

  const parked = Option.match(outcome.row, {
    onNone: () => 0,
    onSome: (row) => row.parkedTaskIds.length,
  });

  const failed = Option.exists(outcome.row, (row) => row.activity === "failed");

  notes.push(
    ...lastErrorNotes(outcome.row),
    ...(yield* owned.removeWith(client))
  );

  const worstClosed = Math.max(...closedMs);
  const results = toolResults(outcome.entries, "bash");
  const interrupted = results.filter((result) => result.interrupted).length;

  const completed = completedRuns(outcome.entries);

  const checks = {
    closedUnder5s: closedMs.every((ms) => ms < CLOSED_LIMIT_MS),
    noShutdownSlow: slow === 0,
    nRestartsUnchanged: restartsAfter === restartsBefore,
    nothingParked: parked === 0,
    turnEnded: !failed,
    snapshotsUnder2s: snapshotMs.every((ms) => ms <= CONVERGE_MS),
    everyRestartInterruptedBash: interrupted >= RESTARTS,
    bashCompleted: completed >= 1,
  };

  return {
    check: "restarts",
    unit: `${target.unit}.service`,
    model: options.model,
    pass: Object.values(checks).every(Boolean),
    checks,
    closedMs,
    worstClosedMs: worstClosed,
    restartCallMs: stopMs,
    upToSnapshotMs: snapshotMs,
    quietToEqualMs: outcome.quietToEqualMs,
    nRestarts: { before: restartsBefore, after: restartsAfter },
    parked,
    followUps,
    bashCalls: outcome.entries.filter((entry) => callsTool(entry, "bash"))
      .length,
    bashInterrupted: interrupted,
    bashCompleted: completed,
    notes,
  };
}, Effect.scoped);

/** One `kill -9` of the main pid while the reply streams. */
export const streaming = Effect.fnUntraced(function* (options: Options) {
  const target = yield* readTarget(options.unit);
  const notes: Array<string> = [];
  const restartsBefore = yield* Unit.restarts(target.unit);
  const up = yield* portAfter(target, "");
  const client = yield* connect(target, up.port);
  const follower = yield* makeFollower;
  const threadId = yield* launch(client, options.model, STREAM_PROMPT);
  const owned = yield* ownThread(target, threadId, options.keep);

  yield* follow(client, threadId, follower);
  yield* until(
    `${STREAM_AIM_CHARS} streamed characters`,
    Effect.map(
      viewOf(follower),
      (view) => partialChars(view) >= STREAM_AIM_CHARS
    ),
    120_000
  );

  const committed = entriesOf(yield* viewOf(follower));
  const streamedChars = partialChars(yield* viewOf(follower));
  const before = yield* Unit.snapshot(target.unit);

  const claudeBefore = before.filter(({ command }) =>
    CLAUDE_COMMAND.test(command)
  ).length;

  const previous = yield* Unit.invocationId(target.unit);
  const killedAt = yield* Clock.currentTimeMillis;

  yield* Unit.killMain(target.unit);

  const next = yield* reconnect(target, previous, threadId, follower);
  const killToUp = (yield* Clock.currentTimeMillis) - killedAt;
  const waited = 2000 - ((yield* Clock.currentTimeMillis) - killedAt);

  if (waited > 0) {
    yield* Effect.sleep(waited);
  }

  const orphans = (yield* Unit.orphans(target.unit, before)).filter(
    ({ command }) => CLAUDE_COMMAND.test(command)
  );

  const outcome = yield* converge(target, next.port, threadId, follower);
  const restartsAfter = yield* Unit.restarts(target.unit);
  const active = yield* Unit.activeState(target.unit);
  const lost = lostEntries(committed, outcome.entries);

  notes.push(
    ...lastErrorNotes(outcome.row),
    ...(yield* owned.removeWith(next.client))
  );

  const checks = {
    committedKept: lost === 0,
    claudeChildSeen: claudeBefore >= 1,
    noClaudeOutsideCgroup: orphans.length === 0,
    snapshotUnder2s: next.snapshotMs <= CONVERGE_MS,
    equalUnder2s: outcome.quietToEqualMs <= CONVERGE_MS,
    unitBack: active === "active" && restartsAfter === restartsBefore + 1,
    turnEnded: !Option.exists(outcome.row, (row) => row.activity === "failed"),
  };

  return {
    check: "streaming",
    unit: `${target.unit}.service`,
    model: options.model,
    pass: Object.values(checks).every(Boolean),
    checks,
    streamedChars,
    committedBefore: committed.length,
    lost,
    claudeBefore,
    claudeOrphans: orphans.length,
    killToUpMs: killToUp,
    upToSnapshotMs: next.snapshotMs,
    quietToEqualMs: outcome.quietToEqualMs,
    nRestarts: { before: restartsBefore, after: restartsAfter },
    activeState: active,
    notes,
  };
}, Effect.scoped);
