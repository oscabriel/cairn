// Ported from elidickinson/pi-claude-bridge, src/index.ts `streamClaudeAgentSdk` (lines 1766-2212),
// with `deliverToolResults`, `buildMcpServers` and the orphaned-result path (lines 1035-1089,
// 1631-1721), at 874fa7c2678456336f23b64e784e2057e608d83e, by way of cairn-v1
// apps/server/src/claude/conversation.ts at 1a5cd4a56e84bfb187940428d144b584d2e084b0. Behaviour kept:
// a held query takes the tool results it is waiting for (a steer written first, so Claude Code drains
// it at the tool boundary); results and handlers meet in two maps whichever arrives first; only a real
// abort kills a held query; a kill resolves every waiting handler, fails the input, interrupts and
// closes. Changed: one conversation per pi provider session id with no module state; an Effect state
// machine whose mutations run under one lock; the resume decision table (`ClaudeResume`) replaces
// v1's native resume, fork and rebuild; a finished child stays alive and takes the next prompt; a
// generating child holds a `ClaudeSlots` permit; a stall watchdog fails a silent turn.
//
// MIT License
//
// Copyright (c) 2026 Eli Dickinson
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import type { Api, Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { DoneGate } from "./ClaudeDoneGate.ts";
import type { ClaudeEvent, RateLimitInfo } from "./ClaudeEvents.ts";
import type {
  AbortKind,
  ChildOptions,
  ChildSession,
  Effort,
} from "./ClaudeGuards.ts";
import {
  CHILD_ENDED_TEXT,
  INIT_REFUSED_TEXT,
  PAID_CREDITS_TEXT,
  PROMPT_REFUSED_TEXT,
  STREAM_STALLED_TEXT,
  abortKind,
  childEnv,
  refuseInit,
  unsendableFindings,
} from "./ClaudeGuards.ts";
import type { HeldState, InstructionState } from "./ClaudeInstructions.ts";
import {
  heldOf,
  instructionState,
  priorTexts,
  reminderFor,
  renderInstructions,
} from "./ClaudeInstructions.ts";
import { MCP_SERVER_NAME, toolDeclaration } from "./ClaudeMcp.ts";
import { effortFor, servedModel } from "./ClaudeModels.ts";
import type { PromptBlock } from "./ClaudePrompt.ts";
import {
  CONTINUE_AFTER_RESUME_PROMPT,
  seedPrompt,
  toolResultsPrompt,
  userTurnBlocks,
} from "./ClaudePrompt.ts";
import type { ResumeDecision } from "./ClaudeResume.ts";
import { decideResume, resumeAppend } from "./ClaudeResume.ts";
import type { ClaudeQuery, ToolHandler } from "./ClaudeSdk.ts";
import { ClaudeSdk } from "./ClaudeSdk.ts";
import { ClaudeSettings } from "./ClaudeSettings.ts";
import { ClaudeSlots } from "./ClaudeSlots.ts";
import type { FoundStamp } from "./ClaudeStamp.ts";
import { historyDigest, stampMessage } from "./ClaudeStamp.ts";
import type { EventEffect, TurnEnd, TurnSink } from "./ClaudeStream.ts";
import { ClaudeStream } from "./ClaudeStream.ts";
import type { ClaudeToolResult } from "./ClaudeToolResults.ts";
import { extractToolResults } from "./ClaudeToolResults.ts";
import type { ConversationMessage } from "./ClaudeTranscript.ts";
import { toBridgeContext } from "./ClaudeTranscript.ts";

/** One provider call routed to a conversation. */
export interface ConversationCall {
  readonly model: Model<Api>;
  /** pi's transcript as it sent it, system messages included. */
  readonly messages: ReadonlyArray<Message>;
  readonly reasoning: Option.Option<ThinkingLevel>;
  readonly signal: Option.Option<AbortSignal>;
  readonly sink: TurnSink;
}

/** Where a conversation's children run, as the brain noted it. */
export interface ConversationPlace {
  /** The realpath of the conversation's working directory. */
  readonly cwd: string;
}

/** Why a child is being killed. `closing` (shutdown) leaves its session resumable as it is. */
export type KillKind = "abort" | "closing" | "failed";

/** What a conversation needs from the bridge that owns it. */
export interface ConversationDeps {
  readonly piSessionId: string;
  /** The conversation's place, read at each call. */
  readonly place: Effect.Effect<ConversationPlace>;
  /** Whether shutdown has begun, so an `AbortError` means `closing`. */
  readonly closing: Effect.Effect<boolean>;
  /** Every plan-window reading a child reports. */
  onRateLimit(info: RateLimitInfo): Effect.Effect<void>;
  /** Runs an Effect from a platform callback (an abort signal's listener). */
  runCallback(effect: Effect.Effect<void>): void;
}

/** One pi conversation's side of Claude Code. */
export interface ClaudeConversation {
  /**
   * Runs one provider call into its sink, which it always ends. When the turn ends on a tool call,
   * it also waits until the held query is answered or dies, so the conversation stays alive.
   */
  call(call: ConversationCall): Effect.Effect<void>;
  /** Kills the conversation's child, if it has one. */
  kill(kind: Exclude<KillKind, "failed">): Effect.Effect<void>;
  /** Whether a child is alive now. */
  readonly alive: Effect.Effect<boolean>;
}

type TurnOutcome = "tool-use" | "done" | "failed";

/** A child's state; every field is read and written under the conversation's lock. */
interface Child {
  readonly scope: Scope.Closeable;
  readonly query: ClaudeQuery;
  readonly stream: ClaudeStream;
  readonly cwd: string;
  readonly cliModel: string;
  readonly effort: Option.Option<Effort>;
  readonly thinking: "adaptive" | "disabled";
  readonly pendingCalls: Map<string, Deferred.Deferred<ClaudeToolResult>>;
  readonly pendingResults: Map<string, ClaudeToolResult>;
  ccSessionId: Option.Option<string>;
  /** The instructions the session holds once its last prompt was written. */
  held: HeldState;
  /** pi's conversation messages before the reply being produced: the stamp's history. */
  prior: ReadonlyArray<ConversationMessage>;
  killed: Option.Option<KillKind>;
  idle: boolean;
  permit: boolean;
  turn: Option.Option<Deferred.Deferred<TurnOutcome>>;
  heldWait: Option.Option<Deferred.Deferred<true>>;
  /** The current turn's gate in front of pi's sink: it holds a reply's `done` until the entry is written. */
  doneGate: Option.Option<DoneGate>;
  lastActivity: number;
  quietUntil: number;
}

/** The child a tool handler answers for, set once the child exists. */
interface ChildHolder {
  child: Option.Option<Child>;
}

/** How long a fork waits for its stamped entry to reach the transcript: 10 tries, 200 ms apart. */
const STAMP_WAIT_ATTEMPTS = 10;

const STAMP_WAIT_INTERVAL = Duration.millis(200);

/**
 * How long a reply's `done` waits for Claude Code to write the entry its stamp names. Claude Code
 * flushes its transcript every 100 ms; spike 10 saw the entry 109 to 122 ms after its event. So the
 * first look is at once (a fake, or a flush already done), the second 100 ms later, then every 20 ms
 * for about a second, after which `done` goes on anyway with a warning.
 */
const DONE_WAIT_FIRST = Duration.millis(100);

const DONE_WAIT_INTERVAL = Duration.millis(20);

const DONE_WAIT_ATTEMPTS = 47;

/**
 * How long a killed child gets to answer its interrupt before it is closed anyway: a wedged child
 * never answers, and its close must not wait on it forever (T13).
 */
export const INTERRUPT_GRACE = Duration.seconds(3);

/** How long delivering a steer waits for Claude Code to take it from stdin, under the lock. */
const STEER_WRITE_LIMIT = Duration.seconds(5);

/** A served tool call waiting for pi's result. */
interface ParkedCall {
  readonly child: Child;
  readonly deferred: Deferred.Deferred<ClaudeToolResult>;
}

/** What a routed call waits on. */
interface Routed {
  readonly turn: Deferred.Deferred<TurnOutcome>;
  readonly child: Child;
}

const errorMessage = (model: Model<Api>, text: string, timestamp: number) => ({
  role: "assistant" as const,
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error" as const,
  errorMessage: text,
  timestamp,
});

const failSink = (
  sink: TurnSink,
  model: Model<Api>,
  text: string,
  timestamp: number
) => {
  sink.push({
    type: "error",
    reason: "error",
    error: errorMessage(model, text, timestamp),
  });
  sink.end();
};

/** Ends a turn the user stopped before it started. */
const abortedSink = (sink: TurnSink, model: Model<Api>, timestamp: number) => {
  sink.push({
    type: "error",
    reason: "aborted",
    error: {
      ...errorMessage(model, "Operation aborted", timestamp),
      stopReason: "aborted",
    },
  });
  sink.end();
};

const emptyReply = (sink: TurnSink, model: Model<Api>, timestamp: number) => {
  const { errorMessage: _unused, ...failed } = errorMessage(
    model,
    "",
    timestamp
  );

  const message = { ...failed, stopReason: "stop" as const };

  const events = [
    { type: "start", partial: message },
    { type: "done", reason: "stop", message },
  ] as const;

  for (const event of events) {
    sink.push(event);
  }

  sink.end();
};

const releasedResult = (text: string): ClaudeToolResult => ({
  toolCallId: "",
  content: [{ type: "text", text }],
  isError: true,
});

/** Succeeds once `signal` aborts; never, without one. */
const abortOf = (signal: Option.Option<AbortSignal>): Effect.Effect<true> =>
  Option.match(signal, {
    onNone: () => Effect.never,
    onSome: (value) =>
      value.aborted
        ? Effect.succeed(true as const)
        : Effect.callback<true>((resume) => {
            const onAbort = () => {
              resume(Effect.succeed(true as const));
            };

            value.addEventListener("abort", onAbort, { once: true });

            return Effect.sync(() => {
              value.removeEventListener("abort", onAbort);
            });
          }),
  });

const isRealAbort = (signal: Option.Option<AbortSignal>): boolean =>
  Option.match(signal, {
    onNone: () => false,
    onSome: (value) => value.aborted && abortKind(value, false) !== "ended",
  });

/** The tool results in the tail after the reply at `index`. */
const resultsAfter = (
  messages: ReadonlyArray<ConversationMessage>,
  index: number
): ReadonlyArray<string> =>
  messages
    .slice(index + 1)
    .flatMap((message) =>
      message.role === "toolResult" ? [message.toolCallId] : []
    );

/**
 * Opens a conversation for `deps.piSessionId`. Closing the scope kills its child as `closing`, which
 * leaves the session resumable.
 */
export const openConversation = Effect.fnUntraced(function* (
  deps: ConversationDeps
) {
  const sdk = yield* ClaudeSdk;
  const slots = yield* ClaudeSlots;
  const settings = yield* ClaudeSettings;
  const clock = yield* Clock.Clock;
  const lock = yield* Semaphore.make(1);

  const locked = <A, E>(effect: Effect.Effect<A, E>) =>
    Semaphore.withPermit(lock, effect);

  const now = () => clock.currentTimeMillisUnsafe();
  const stallMs = Duration.toMillis(settings.stallAfter);

  let current: Option.Option<Child> = Option.none();
  const uncertain = new Set<string>();

  const releasePermit = (child: Child) =>
    Effect.gen(function* () {
      if (child.permit) {
        child.permit = false;
        yield* slots.release(deps.piSessionId);
      }
    });

  /**
   * Whether `uuid` is in the transcript of `sessionId` within `attempts` looks, the first at once
   * and each later one `pause(attempt)` after the one before.
   */
  const entryWritten = (
    sessionId: string,
    uuid: string,
    cwd: string,
    attempts: number,
    pause: (attempt: number) => Duration.Duration
  ) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) {
          yield* Effect.sleep(pause(attempt));
        }

        const entries = yield* sdk
          .entries(sessionId, cwd)
          .pipe(Effect.orElseSucceed(() => []));

        if (entries.some((entry) => entry.uuid === uuid)) {
          return true;
        }
      }

      return false;
    });

  /** Waits, briefly, until `uuid` is in the transcript of `sessionId`; gives up quietly. */
  const stampWritten = (sessionId: string, uuid: string, cwd: string) =>
    Effect.asVoid(
      entryWritten(
        sessionId,
        uuid,
        cwd,
        STAMP_WAIT_ATTEMPTS,
        () => STAMP_WAIT_INTERVAL
      )
    );

  /**
   * Lets the turn's held `done` through once Claude Code has written the entry the reply's stamp
   * names, so every stamp pi commits names an entry a resume can find. The gate opens whatever
   * happens: an entry that never shows costs a warning (and, after a crash, a cold rebuild), never
   * the reply.
   */
  const releaseDone = (child: Child) =>
    Option.match(
      Option.filter(child.doneGate, (gate) => gate.holding),
      {
        onNone: () => Effect.void,
        onSome: (gate) =>
          Effect.gen(function* () {
            const sessionId = Option.orElse(
              child.ccSessionId,
              () => child.stream.sessionId
            );

            if (
              Option.isNone(sessionId) ||
              Option.isNone(child.stream.lastUuid)
            ) {
              return;
            }

            const written = yield* entryWritten(
              sessionId.value,
              child.stream.lastUuid.value,
              child.cwd,
              DONE_WAIT_ATTEMPTS,
              (attempt) =>
                attempt === 1 ? DONE_WAIT_FIRST : DONE_WAIT_INTERVAL
            );

            if (!written) {
              yield* Effect.logWarning("claude stamp not written").pipe(
                Effect.annotateLogs({
                  event: "claude_stamp_not_written",
                  sessionId: deps.piSessionId,
                  ccSessionId: sessionId.value,
                  ccUuid: child.stream.lastUuid.value,
                })
              );
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                gate.release();
              })
            )
          ),
      }
    );

  const settleTurn = (child: Child, outcome: TurnOutcome) =>
    Effect.gen(function* () {
      const { turn } = child;

      child.turn = Option.none();

      if (Option.isSome(turn)) {
        yield* Deferred.succeed(turn.value, outcome);
      }
    });

  const releaseHeld = (child: Child) =>
    Effect.gen(function* () {
      const waiter = child.heldWait;

      child.heldWait = Option.none();

      if (Option.isSome(waiter)) {
        yield* Deferred.succeed(waiter.value, true);
      }
    });

  /** Kills `child`: settles everything that waits on it, then closes it on another fiber. */
  const killChild = (child: Child, kind: KillKind, text: string) =>
    Effect.gen(function* () {
      if (Option.isSome(child.killed)) {
        return;
      }

      child.killed = Option.some(kind);
      child.idle = false;
      child.stream.fail(kind === "failed" ? "error" : "aborted", text);

      for (const waiting of child.pendingCalls.values()) {
        yield* Deferred.succeed(waiting, releasedResult("Operation aborted"));
      }

      child.pendingCalls.clear();
      child.pendingResults.clear();

      yield* child.query.input.fail("Claude Code child closed.");
      yield* settleTurn(child, "failed");
      yield* releaseHeld(child);
      yield* releasePermit(child);

      if (kind !== "closing" && Option.isSome(child.ccSessionId)) {
        uncertain.add(child.ccSessionId.value);
      }

      if (Option.isSome(current) && current.value === child) {
        current = Option.none();
      }

      yield* Effect.logInfo("claude child killed").pipe(
        Effect.annotateLogs({ sessionId: deps.piSessionId, kind })
      );
      yield* Effect.forkDetach(
        Effect.andThen(
          child.query.interrupt.pipe(
            Effect.timeoutOrElse({
              duration: INTERRUPT_GRACE,
              orElse: () =>
                Effect.logWarning("claude child ignored its interrupt").pipe(
                  Effect.annotateLogs({ sessionId: deps.piSessionId, kind })
                ),
            })
          ),
          Scope.close(child.scope, Exit.void)
        )
      );
    });

  /** Parked calls pi never received: Claude Code waits on them, and nothing will ever answer. */
  const orphansOf = (child: Child) =>
    [...child.pendingCalls.keys()].filter(
      (id) => !child.stream.toolCallIds.includes(id)
    );

  /** Kills a held child with calls pi never received, so pi's next call resumes it from the stamp. */
  const killOrphaned = (child: Child, orphans: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* Effect.logWarning("claude tool call not delivered to pi").pipe(
        Effect.annotateLogs({
          sessionId: deps.piSessionId,
          toolUseIds: orphans.join(","),
        })
      );
      yield* killChild(child, "failed", CHILD_ENDED_TEXT);
    });

  const endTurn = (child: Child, end: TurnEnd) =>
    Effect.gen(function* () {
      yield* releasePermit(child);

      if (end.kind === "tool-use") {
        child.heldWait = Option.some(yield* Deferred.make<true>());
        yield* settleTurn(child, "tool-use");

        const orphans = orphansOf(child);

        if (orphans.length > 0) {
          yield* killOrphaned(child, orphans);
        }
      } else if (end.kind === "done") {
        child.idle = true;
        child.pendingResults.clear();
        yield* settleTurn(child, "done");
      } else {
        yield* settleTurn(child, "failed");
        yield* killChild(child, "failed", CHILD_ENDED_TEXT);
      }
    });

  const applyEffect = (child: Child, effect: EventEffect) =>
    Effect.gen(function* () {
      if (effect.kind === "init") {
        child.ccSessionId = Option.some(effect.sessionId);
      } else if (effect.kind === "rate-limit") {
        yield* deps.onRateLimit(effect.info);

        // A subscription turn never spills into paid credits: stop it at the first sign.
        if (effect.info.isUsingOverage === true) {
          yield* Effect.logWarning(
            "claude turn drew on paid usage credits"
          ).pipe(Effect.annotateLogs({ sessionId: deps.piSessionId }));
          yield* killChild(child, "failed", PAID_CREDITS_TEXT);
        }
      } else if (effect.kind === "api-retry") {
        child.quietUntil = now() + effect.delayMs;
      } else if (effect.kind === "ended") {
        yield* releaseDone(child);
        yield* endTurn(child, effect.end);
      } else if (
        effect.kind === "unattached-result" &&
        Option.isSome(child.heldWait)
      ) {
        // The held round finished without pi (a call Claude Code gave up on): nothing will deliver
        // into it, so free the held generation and let pi's next call resume from the stamp.
        yield* Effect.logWarning("claude held round ended without pi").pipe(
          Effect.annotateLogs({ sessionId: deps.piSessionId })
        );
        yield* killChild(child, "failed", CHILD_ENDED_TEXT);
      }
    });

  const onEvent = (child: Child, event: ClaudeEvent) =>
    locked(
      Effect.gen(function* () {
        if (Option.isSome(child.killed)) {
          return;
        }

        child.lastActivity = now();

        if (event.type === "system" && "apiKeySource" in event) {
          const refused = refuseInit(
            {
              apiKeySource: event.apiKeySource,
              tools: event.tools,
              mcpServers: event.mcp_servers.map((server) => server.name),
            },
            MCP_SERVER_NAME
          );

          if (Option.isSome(refused)) {
            yield* Effect.logWarning("claude child refused at init").pipe(
              Effect.annotateLogs({
                sessionId: deps.piSessionId,
                refusal: refused.value.kind,
              })
            );
            yield* killChild(child, "failed", INIT_REFUSED_TEXT);

            return;
          }
        }

        yield* applyEffect(child, child.stream.handle(event));
      })
    );

  const onEnded = (child: Child) =>
    locked(
      Effect.gen(function* () {
        if (Option.isNone(child.killed)) {
          yield* killChild(child, "failed", CHILD_ENDED_TEXT);
        }
      })
    );

  const toolHandler =
    (holder: ChildHolder): ToolHandler =>
    (request) =>
      Effect.gen(function* () {
        const waiting = yield* locked(
          Effect.gen(function* () {
            const child = Option.getOrUndefined(holder.child);

            // A call to a child that is gone, or going, is answered at once: nothing will deliver it.
            if (child === undefined || Option.isSome(child.killed)) {
              return Option.none<ParkedCall>();
            }

            child.lastActivity = now();

            const queued = child.pendingResults.get(request.toolUseId);
            const deferred = yield* Deferred.make<ClaudeToolResult>();

            if (queued === undefined) {
              child.pendingCalls.set(request.toolUseId, deferred);
            } else {
              child.pendingResults.delete(request.toolUseId);
              yield* Deferred.succeed(deferred, queued);
            }

            yield* applyEffect(
              child,
              child.stream.toolCallArrived(request.toolUseId)
            );

            // A call that lands after its turn went to pi without it: pi will never answer it.
            if (
              Option.isNone(child.killed) &&
              Option.isSome(child.heldWait) &&
              !child.stream.open
            ) {
              const orphans = orphansOf(child);

              if (orphans.length > 0) {
                yield* killOrphaned(child, orphans);
              }
            }

            return Option.some<ParkedCall>({ child, deferred });
          })
        );

        if (Option.isNone(waiting)) {
          return releasedResult("Operation aborted");
        }

        const { child, deferred } = waiting.value;

        // Claude Code cancels a call it stopped waiting for (its MCP timeout); forget it, so it
        // neither silences the watchdog nor waits for a result nobody reads.
        const cancelled = Effect.as(
          abortOf(request.signal),
          releasedResult("Tool call cancelled by Claude Code")
        ).pipe(
          Effect.tap(() =>
            locked(
              Effect.sync(() => {
                if (child.pendingCalls.get(request.toolUseId) === deferred) {
                  child.pendingCalls.delete(request.toolUseId);
                }
              })
            )
          )
        );

        return yield* Effect.raceFirst(Deferred.await(deferred), cancelled);
      });

  const watchdog = (child: Child) =>
    Effect.gen(function* () {
      while (Option.isNone(child.killed)) {
        yield* Effect.sleep(Duration.seconds(5));
        yield* locked(
          Effect.gen(function* () {
            const at = now();

            // A parked call does not excuse silence while a provider call is open: pi is waiting
            // on the stream, not running the tool.
            const stalled =
              Option.isNone(child.killed) &&
              child.stream.open &&
              at - child.lastActivity > stallMs &&
              at >= child.quietUntil;

            if (stalled) {
              yield* Effect.logWarning("claude child stalled").pipe(
                Effect.annotateLogs({
                  sessionId: deps.piSessionId,
                  pendingToolUseIds: [...child.pendingCalls.keys()].join(","),
                })
              );
              yield* killChild(child, "failed", STREAM_STALLED_TEXT);
            }
          })
        );
      }
    });

  const stampReply = (
    child: Child,
    reply: Parameters<typeof stampMessage>[0]
  ) => {
    const ccSessionId = Option.orElse(
      child.ccSessionId,
      () => child.stream.sessionId
    );

    if (Option.isNone(ccSessionId) || Option.isNone(child.stream.lastUuid)) {
      return;
    }

    stampMessage(
      reply,
      {
        ccSessionId: ccSessionId.value,
        ccUuid: child.stream.lastUuid.value,
        piSessionId: deps.piSessionId,
        historyDigest: historyDigest([...child.prior, reply]),
        held: child.held,
        cliModel: child.cliModel,
        cwd: child.cwd,
      },
      now()
    );
  };

  const killCurrent = (kind: KillKind) =>
    Effect.gen(function* () {
      if (Option.isSome(current)) {
        yield* killChild(current.value, kind, "Operation aborted");
      }
    });

  const bindSignal = (signal: Option.Option<AbortSignal>) => {
    if (Option.isNone(signal)) {
      return;
    }

    const onAbort = () => {
      deps.runCallback(
        Effect.gen(function* () {
          const closing = yield* deps.closing;
          const kind: AbortKind = abortKind(signal.value, closing);

          if (kind !== "ended") {
            yield* locked(killCurrent(kind));
          }
        })
      );
    };

    if (signal.value.aborted) {
      onAbort();
    } else {
      signal.value.addEventListener("abort", onAbort, { once: true });
    }
  };

  /** Starts a child; under the lock. */
  const startChild = (
    call: ConversationCall,
    options: ChildOptions,
    held: HeldState
  ) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const holder: ChildHolder = { child: Option.none() };

      const query = yield* sdk.open(options, toolHandler(holder)).pipe(
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void))
      );

      const child: Child = {
        scope,
        query,
        stream: new ClaudeStream(call.model, options.tools, (message) => {
          stampReply(child, message);
        }),
        cwd: options.cwd,
        cliModel: options.model,
        effort: options.effort,
        thinking: options.thinking,
        pendingCalls: new Map(),
        pendingResults: new Map(),
        ccSessionId:
          options.session.kind === "resume" && !options.session.fork
            ? Option.some(options.session.sessionId)
            : Option.none(),
        held,
        prior: [],
        killed: Option.none(),
        idle: false,
        permit: false,
        turn: Option.none(),
        heldWait: Option.none(),
        doneGate: Option.none(),
        lastActivity: now(),
        quietUntil: 0,
      };

      holder.child = Option.some(child);
      current = Option.some(child);

      yield* Effect.forkIn(
        Effect.andThen(
          Stream.runForEach(query.events, (event) =>
            onEvent(child, event)
          ).pipe(
            // The child's own words for why it died; the turn still ends through `onEnded` (T13).
            Effect.tapError((failure) =>
              Effect.logWarning("claude child stream failed").pipe(
                Effect.annotateLogs({
                  event: "claude_child_stream_failed",
                  error: failure.message,
                })
              )
            ),
            Effect.ignore
          ),
          onEnded(child)
        ),
        scope
      );
      yield* Effect.forkIn(watchdog(child), scope);

      return child;
    });

  /** Attaches `call` to `child` and returns what the call waits on; under the lock. */
  const attach = (
    child: Child,
    call: ConversationCall,
    prior: ReadonlyArray<ConversationMessage>
  ) =>
    Effect.gen(function* () {
      const turn = yield* Deferred.make<TurnOutcome>();

      child.turn = Option.some(turn);
      child.prior = prior;
      child.idle = false;

      // The call took a permit to get here. A child that still holds one from its last turn keeps
      // that one, so the call's goes back (T13).
      if (child.permit) {
        yield* slots.release(deps.piSessionId);
      }

      child.permit = true;
      child.lastActivity = now();
      child.pendingResults.clear();
      const gate = new DoneGate(call.sink);

      child.doneGate = Option.some(gate);
      child.stream.begin(gate, now());
      bindSignal(call.signal);

      return { turn, child } satisfies Routed;
    });

  /** The prompt blocks of a resumed session and where it cuts. */
  const resumePlan = (
    found: FoundStamp,
    messages: ReadonlyArray<ConversationMessage>,
    cwd: string
  ) =>
    Effect.gen(function* () {
      const entries = yield* sdk
        .entries(found.stamp.ccSessionId, cwd)
        .pipe(Effect.orElseSucceed(() => []));

      const at = entries.findIndex(
        (entry) => entry.uuid === found.stamp.ccUuid
      );

      if (at === -1) {
        return Option.none<{
          readonly cut: Option.Option<string>;
          readonly blocks: ReadonlyArray<PromptBlock>;
        }>();
      }

      const pending = resultsAfter(messages, found.index);

      // Claude Code may already hold the results it got over MCP before the kill (E2): cut after
      // its own tool_result entry and only ask it to go on.
      const answered = entries
        .slice(at + 1)
        .find(
          (entry) =>
            entry.role === "user" &&
            pending.length > 0 &&
            pending.every((id) => entry.toolResultIds.includes(id))
        );

      const carried =
        answered === undefined
          ? extractToolResults(messages.slice(found.index + 1))
          : [];

      const cut = answered === undefined ? found.stamp.ccUuid : answered.uuid;

      yield* Effect.logInfo("claude resume").pipe(
        Effect.annotateLogs({
          event: "claude_resume",
          sessionId: deps.piSessionId,
          ccSessionId: found.stamp.ccSessionId,
          answered: answered !== undefined,
          after: entries
            .slice(entries.findIndex((entry) => entry.uuid === cut) + 1)
            .map((entry) => entry.role)
            .join(","),
        })
      );

      // `resumeSessionAt` makes Claude Code resend the history without the prompt cache's
      // breakpoints (measured: a 22K-token prefix rewritten on every resume), so it is passed only
      // when there is something after the cut to drop.
      return Option.some({
        cut:
          entries.at(-1)?.uuid === cut
            ? Option.none<string>()
            : Option.some(cut),
        blocks: [...toolResultsPrompt(carried), ...userTurnBlocks(messages)],
      });
    });

  /** Opens a child for a decision other than deliver and reuse; under the lock. */
  const openFor = (
    call: ConversationCall,
    decision: Exclude<ResumeDecision, { readonly kind: "deliver" | "reuse" }>,
    base: Omit<ChildOptions, "session" | "append">,
    state: InstructionState,
    messages: ReadonlyArray<ConversationMessage>,
    prior: ReadonlyArray<Message>
  ) =>
    Effect.gen(function* () {
      const current_ = heldOf(state);

      const fresh = (seed: boolean, preferred: Option.Option<string>) =>
        Effect.gen(function* () {
          const taken = yield* Option.match(preferred, {
            onNone: () => Effect.succeed(false),
            onSome: (id) =>
              sdk.entries(id, base.cwd).pipe(
                Effect.map((entries) => entries.length > 0),
                Effect.orElseSucceed(() => true)
              ),
          });

          const session: ChildSession = {
            kind: "new",
            sessionId: taken ? Option.none() : preferred,
          };

          const turnBlocks = userTurnBlocks(messages);

          return {
            session,
            append: renderInstructions(state),
            reminder: Option.none<string>(),
            held: current_,
            blocks: seed ? seedPrompt(messages, turnBlocks) : turnBlocks,
          };
        });

      if (decision.kind === "fresh") {
        yield* Effect.logInfo("claude fresh session").pipe(
          Effect.annotateLogs({
            sessionId: deps.piSessionId,
            reason: decision.reason,
          })
        );

        return yield* fresh(decision.seed, decision.preferredId);
      }

      const stampHeld = decision.found.stamp.held;
      const reminder = reminderFor(stampHeld, state, priorTexts(prior));

      if (decision.kind === "fork-stamped") {
        const { ccSessionId, ccUuid } = decision.found.stamp;

        // A stamp made mid-turn can name an entry Claude Code has not written yet.
        yield* stampWritten(ccSessionId, ccUuid, base.cwd);

        const forked = yield* sdk
          .fork(ccSessionId, Option.some(ccUuid), base.cwd)
          .pipe(
            Effect.tapError((error) =>
              Effect.logWarning("claude fork failed").pipe(
                Effect.annotateLogs({
                  sessionId: deps.piSessionId,
                  ccSessionId,
                  reason: error.message,
                })
              )
            ),
            Effect.option
          );

        if (Option.isNone(forked)) {
          return yield* fresh(true, Option.none());
        }

        const carried = extractToolResults(
          messages.slice(decision.found.index + 1)
        );

        const session: ChildSession = {
          kind: "resume",
          sessionId: forked.value,
          at: Option.none(),
          fork: false,
        };

        return {
          session,
          append: resumeAppend(stampHeld, state),
          reminder,
          held: current_,
          blocks: [...toolResultsPrompt(carried), ...userTurnBlocks(messages)],
        };
      }

      const plan = yield* resumePlan(decision.found, messages, base.cwd);

      if (Option.isNone(plan)) {
        yield* Effect.logInfo("claude fresh session").pipe(
          Effect.annotateLogs({
            sessionId: deps.piSessionId,
            reason: "transcript-missing",
          })
        );

        return yield* fresh(true, Option.none());
      }

      const session: ChildSession = {
        kind: "resume",
        sessionId: decision.found.stamp.ccSessionId,
        at: plan.value.cut,
        fork: decision.fork,
      };

      return {
        session,
        append: resumeAppend(stampHeld, state),
        reminder,
        held: current_,
        blocks: plan.value.blocks,
      };
    });

  /** Delivers this turn's tool results to the held query, a steer first; under the lock. */
  const deliverTo = (
    child: Child,
    call: ConversationCall,
    messages: ReadonlyArray<ConversationMessage>,
    results: ReadonlyArray<ClaudeToolResult>
  ) =>
    Effect.gen(function* () {
      const routed = yield* attach(child, call, messages);

      const steer =
        messages.at(-1)?.role === "user" ? userTurnBlocks(messages) : [];

      yield* releaseHeld(child);

      if (steer.length > 0) {
        // The steer and the results share Claude Code's stdin; writing the steer first makes
        // Claude Code drain it at this tool boundary, so this waits for Claude Code to take it.
        // The wait is bounded, because it holds the lock a child that stopped reading stdin
        // would otherwise hold forever (T13).
        yield* child.query.input
          .push({ blocks: steer, priority: Option.some("next") })
          .pipe(Effect.timeout(STEER_WRITE_LIMIT), Effect.ignore);
      }

      for (const result of results) {
        const waiting = child.pendingCalls.get(result.toolCallId);

        if (waiting === undefined) {
          child.pendingResults.set(result.toolCallId, result);
        } else {
          child.pendingCalls.delete(result.toolCallId);
          yield* Deferred.succeed(waiting, result);
        }
      }

      return routed;
    });

  /** Writes the new user turn to the idle child; under the lock. */
  const reuseChild = (
    child: Child,
    call: ConversationCall,
    messages: ReadonlyArray<ConversationMessage>,
    state: InstructionState
  ) =>
    Effect.gen(function* () {
      const reminder = reminderFor(
        child.held,
        state,
        priorTexts(call.messages)
      );

      if (
        Option.isSome(reminder) &&
        unsendableFindings(reminder.value).length > 0
      ) {
        failSink(call.sink, call.model, PROMPT_REFUSED_TEXT, now());

        return Option.none<Routed>();
      }

      const routed = yield* attach(child, call, messages);

      child.held = heldOf(state);
      yield* child.query.input
        .send({
          blocks: [
            ...Option.toArray(reminder).map((text): PromptBlock => ({
              type: "text",
              text,
            })),
            ...userTurnBlocks(messages),
          ],
          priority: Option.none(),
        })
        .pipe(Effect.ignore);

      return Option.some(routed);
    });

  /** Routes one call; under the lock. None when the call was answered or failed here. */
  const route = (call: ConversationCall) =>
    Effect.gen(function* () {
      const place = yield* deps.place;
      const bridge = toBridgeContext(call.messages);
      const served = servedModel(call.model.id, settings.longContext);
      const effort = effortFor(call.model, call.reasoning);
      const thinking = Option.isSome(call.reasoning) ? "adaptive" : "disabled";
      const state = instructionState(call.messages);

      const live = Option.filter(current, (child) =>
        Option.isNone(child.killed)
      );

      const results = Option.isSome(live)
        ? extractToolResults(bridge.messages)
        : [];

      const owns = Option.match(live, {
        onNone: () => false,
        onSome: (child) =>
          results.some(
            (result) =>
              child.pendingCalls.has(result.toolCallId) ||
              child.pendingResults.has(result.toolCallId) ||
              child.stream.toolCallIds.includes(result.toolCallId)
          ),
      });

      const decision = decideResume({
        piSessionId: deps.piSessionId,
        messages: bridge.messages,
        cwd: place.cwd,
        cliModel: served.cliModel,
        effort,
        thinking,
        memory: {
          heldOwnsResults: owns,
          idle: Option.flatMap(live, (child) =>
            child.idle && Option.isSome(child.ccSessionId)
              ? Option.some({
                  ccSessionId: child.ccSessionId.value,
                  cwd: child.cwd,
                  cliModel: child.cliModel,
                  effort: child.effort,
                  thinking: child.thinking,
                })
              : Option.none()
          ),
          uncertain,
        },
      });

      if (
        bridge.messages.at(-1)?.role === "toolResult" &&
        isRealAbort(call.signal)
      ) {
        // An orphaned tool result after an abort: end the turn with no output. Checked before
        // delivering, or a held child would go on generating a turn the user stopped (T13).
        if (Option.isSome(live)) {
          yield* killChild(live.value, "abort", "Operation aborted");
        }

        emptyReply(call.sink, call.model, now());

        return Option.none<Routed>();
      }

      if (decision.kind === "deliver" && Option.isSome(live)) {
        return Option.some(
          yield* deliverTo(live.value, call, bridge.messages, results)
        );
      }

      if (decision.kind === "reuse" && Option.isSome(live)) {
        return yield* reuseChild(live.value, call, bridge.messages, state);
      }

      // One child per conversation: a live one that cannot take this call goes.
      if (Option.isSome(live)) {
        yield* killChild(live.value, "abort", "Operation aborted");
      }

      if (decision.kind === "deliver" || decision.kind === "reuse") {
        failSink(call.sink, call.model, CHILD_ENDED_TEXT, now());

        return Option.none<Routed>();
      }

      const base = {
        cwd: place.cwd,
        env: childEnv(settings.env, true),
        model: served.cliModel,
        builtinTools: [],
        effort,
        thinking,
        tools: bridge.tools.flatMap((tool) =>
          Option.toArray(toolDeclaration(tool))
        ),
        persistSession: true,
        maxTurns: Option.none(),
        executable: settings.executable,
      } satisfies Omit<ChildOptions, "session" | "append">;

      const opened = yield* openFor(
        call,
        decision,
        base,
        state,
        bridge.messages,
        call.messages
      );

      const unsendable = [
        ...Option.toArray(opened.append),
        ...Option.toArray(opened.reminder),
      ].some((text) => unsendableFindings(text).length > 0);

      if (unsendable) {
        failSink(call.sink, call.model, PROMPT_REFUSED_TEXT, now());

        return Option.none<Routed>();
      }

      const started = yield* startChild(
        call,
        { ...base, session: opened.session, append: opened.append },
        opened.held
      ).pipe(Effect.option);

      if (Option.isNone(started)) {
        failSink(call.sink, call.model, CHILD_ENDED_TEXT, now());

        return Option.none<Routed>();
      }

      const routed = yield* attach(started.value, call, bridge.messages);

      const prompt: ReadonlyArray<PromptBlock> =
        opened.blocks.length > 0
          ? opened.blocks
          : [{ type: "text", text: CONTINUE_AFTER_RESUME_PROMPT }];

      const blocks: ReadonlyArray<PromptBlock> = [
        ...Option.toArray(opened.reminder).map((text): PromptBlock => ({
          type: "text",
          text,
        })),
        ...prompt,
      ];

      yield* started.value.query.input
        .send({ blocks, priority: Option.none() })
        .pipe(Effect.ignore);

      return Option.some(routed);
    });

  const call = Effect.fn("ClaudeConversation.call")(function* (
    request: ConversationCall
  ) {
    // Stop while waiting for a slot ends the turn at once (T13). A call that arrives already
    // stopped goes on to `route`, which ends an orphaned tool result quietly.
    const takePermit = slots.acquire(deps.piSessionId).pipe(Effect.as(true));

    const acquired = isRealAbort(request.signal)
      ? yield* takePermit
      : yield* Effect.raceFirst(
          takePermit,
          abortOf(request.signal).pipe(Effect.as(false))
        );

    if (!acquired) {
      abortedSink(request.sink, request.model, now());

      return;
    }

    // The permit goes back however routing ends, unless a turn now holds it (T13).
    const routed = yield* locked(route(request)).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) && Option.isSome(exit.value)
          ? Effect.void
          : slots.release(deps.piSessionId)
      )
    );

    if (Option.isNone(routed)) {
      return;
    }

    const outcome = yield* Deferred.await(routed.value.turn);

    if (outcome === "tool-use") {
      const waiter = yield* locked(
        Effect.sync(() => routed.value.child.heldWait)
      );

      if (Option.isSome(waiter)) {
        yield* Deferred.await(waiter.value);
      }
    }
  });

  yield* Effect.addFinalizer(() => locked(killCurrent("closing")));

  return {
    call,
    kill: (kind) => locked(killCurrent(kind)),
    alive: locked(Effect.sync(() => Option.isSome(current))),
  } satisfies ClaudeConversation;
});
