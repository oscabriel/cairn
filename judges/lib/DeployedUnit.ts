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
  readonly keep?: boolean;
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

const readTarget = (unit: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const text = yield* fs.readFileString(
      `${homedir()}/.config/cairn/cairn.json`
    );

    const config = yield* Schema.decodeEffect(CairnJson)(text);

    return { unit: unitName(unit), ...config } satisfies Target;
  });

/** The port of the unit's invocation other than `previous`, once it logged `listening`. */
const portAfter = (target: Target, previous: string) =>
  Effect.gen(function* () {
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
const connect = (target: Target, port: number) =>
  Effect.gen(function* () {
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
const follow = (client: Client, threadId: ThreadId, follower: Follower) =>
  Effect.gen(function* () {
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

/** Whether the newest entry is an assistant call of `tool` with no result after it. */
const toolPending = (entries: ReadonlyArray<Entry>, tool: string) => {
  const last = entries.at(-1);

  return (
    last !== undefined &&
    last.kind === "pi.assistant" &&
    Option.exists(decodeParts(last.model?.[0]), (message) =>
      message.content.some(
        (part) => part.type === "toolCall" && part.name === tool
      )
    )
  );
};

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
const launch = (client: Client, model: string, prompt: string) =>
  Effect.gen(function* () {
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
const reconnect = (
  target: Target,
  previous: string,
  threadId: ThreadId,
  follower: Follower
) =>
  Effect.gen(function* () {
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
const converge = (
  target: Target,
  port: number,
  threadId: ThreadId,
  follower: Follower
) =>
  Effect.gen(function* () {
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

const remove = (client: Client, threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* client["shell.dispatch"](
      ThreadDelete.make({ commandId: yield* newCommandId, threadId })
    );
  }).pipe(Effect.ignore);

const NO_TOOL_ERRORS = (row: Option.Option<ThreadShell>) =>
  Option.match(
    Option.flatMap(row, (thread) => thread.lastError),
    { onNone: () => [], onSome: (error) => [`lastError: ${error}`] }
  );

// The two checks.

/** Six clean restarts during a `bash sleep 20` turn. */
export const restarts = (options: Options) =>
  Effect.gen(function* () {
    const target = yield* readTarget(options.unit);
    const notes: Array<string> = [];
    const restartsBefore = yield* Unit.restarts(target.unit);
    let previous = "";

    let { port, client } = yield* Effect.gen(function* () {
      const up = yield* portAfter(target, previous);

      return { port: up.port, client: yield* connect(target, up.port) };
    });

    const follower = yield* makeFollower;
    const threadId = yield* launch(client, options.model, SLEEP_PROMPT);

    yield* follow(client, threadId, follower);

    const closedMs: Array<number> = [];
    const stopMs: Array<number> = [];
    const snapshotMs: Array<number> = [];
    let slow = 0;

    let followUps = 0;

    for (let count = 1; count <= RESTARTS; count += 1) {
      // The model may end the turn after an interrupted `bash` instead of running it again; then
      // one more message asks for another run, so every restart lands during `bash sleep 20`.
      const bashOrQuiet = Effect.gen(function* () {
        const view = yield* viewOf(follower);
        const row = yield* rowOf(follower, threadId);

        return toolPending(entriesOf(view), "bash") || isQuiet(row);
      });

      yield* until(`bash to run before restart ${count}`, bashOrQuiet, 120_000);

      if (isQuiet(yield* rowOf(follower, threadId))) {
        followUps += 1;
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
          `bash to run again before restart ${count}`,
          Effect.map(viewOf(follower), (view) =>
            toolPending(entriesOf(view), "bash")
          ),
          120_000
        );
      }

      yield* Effect.sleep("500 millis");

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

    const outcome = yield* converge(target, port, threadId, follower);
    const restartsAfter = yield* Unit.restarts(target.unit);

    const parked = Option.match(outcome.row, {
      onNone: () => 0,
      onSome: (row) => row.parkedTaskIds.length,
    });

    const failed = Option.exists(
      outcome.row,
      (row) => row.activity === "failed"
    );

    notes.push(...NO_TOOL_ERRORS(outcome.row));

    if (options.keep !== true) {
      yield* remove(client, threadId);
    }

    const worstClosed = Math.max(...closedMs);

    const checks = {
      closedUnder5s: closedMs.every((ms) => ms < CLOSED_LIMIT_MS),
      noShutdownSlow: slow === 0,
      nRestartsUnchanged: restartsAfter === restartsBefore,
      nothingParked: parked === 0,
      turnEnded: !failed,
      snapshotsUnder2s: snapshotMs.every((ms) => ms <= CONVERGE_MS),
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
      bashCalls: outcome.entries.filter((entry) => toolPending([entry], "bash"))
        .length,
      notes,
    };
  }).pipe(Effect.scoped);

/** One `kill -9` of the main pid while the reply streams. */
export const streaming = (options: Options) =>
  Effect.gen(function* () {
    const target = yield* readTarget(options.unit);
    const notes: Array<string> = [];
    const restartsBefore = yield* Unit.restarts(target.unit);
    const up = yield* portAfter(target, "");
    const client = yield* connect(target, up.port);
    const follower = yield* makeFollower;
    const threadId = yield* launch(client, options.model, STREAM_PROMPT);

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

    notes.push(...NO_TOOL_ERRORS(outcome.row));

    if (options.keep !== true) {
      yield* remove(next.client, threadId);
    }

    const checks = {
      committedKept: lost === 0,
      noClaudeOutsideCgroup: orphans.length === 0,
      snapshotUnder2s: next.snapshotMs <= CONVERGE_MS,
      equalUnder2s: outcome.quietToEqualMs <= CONVERGE_MS,
      unitBack: active === "active" && restartsAfter === restartsBefore + 1,
      turnEnded: !Option.exists(
        outcome.row,
        (row) => row.activity === "failed"
      ),
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
  }).pipe(Effect.scoped);
