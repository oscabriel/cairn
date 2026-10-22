// The bridge's projector signals: what only the bridge knows about a thread's sidebar row.
//
// - `waitingFor: claude_slot` while one of the thread's Claude conversations waits for a generation
//   permit (`Claude.offered`, which names the thread the `bridge-cwd` hook noted), and `none` again
//   when its last waiting conversation gets one. Only changes are sent.
// - `usageLimitResetAt` when a thread's run failed on a spent plan window (`RunTerminal` with the
//   `usage_limit` class, from the bridge's "Claude plan quota exceeded" text): the time the spent
//   windows reset, from the plan windows `ClaudeUsage` merged (the rejecting `rate_limit_event`
//   carries it, and the probe it starts confirms it). Plan windows are the account's, not the
//   thread's, so the latest reset of every spent window is when a resend can work.
//
// With the bridge off there are no signals.
import type { ClaudeUsageReading } from "@cairn/bridge/ClaudeUsage";
import { ThreadId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import {
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect";

import { HarnessSeam } from "../brain/HarnessSeam.ts";
import type { HarnessEvent } from "../brain/HarnessSeam.ts";
import { BridgeProvider } from "../models/BridgeProvider.ts";
import { ProjectorSignals } from "../shell/ProjectorSignals.ts";
import type { ProjectorSignal } from "../shell/ProjectorSignals.ts";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** How long a usage-limited run waits for the probe it started before giving up on a reset time. */
const PROBE_WAIT = Duration.seconds(15);

/**
 * When the spent plan windows of `reading` reset: the latest reset among windows that are spent
 * (refused or at 100 percent); none when no spent window has a known reset.
 */
export const spentWindowsResetAt = (
  reading: ClaudeUsageReading
): Option.Option<DateTime.Utc> => {
  const resets = reading.windows.flatMap((window) =>
    (window.exhausted || window.usedPercent >= 100) &&
    Option.isSome(window.resetsAt)
      ? [window.resetsAt.value]
      : []
  );

  return resets.length === 0
    ? Option.none()
    : Option.some(DateTime.makeUnsafe(Math.max(...resets)));
};

/** The thread ids whose waiting state changed when `sessionId` started or stopped waiting. */
export const applyWait = (
  waiting: ReadonlyMap<ThreadId, ReadonlyArray<string>>,
  threadId: ThreadId,
  sessionId: string,
  isWaiting: boolean
): readonly [
  Option.Option<ThreadShell["waitingFor"]>,
  ReadonlyMap<ThreadId, ReadonlyArray<string>>,
] => {
  const before = waiting.get(threadId) ?? [];

  const others = before.filter((id) => id !== sessionId);
  const after = isWaiting ? [...others, sessionId] : others;

  const next = new Map(waiting);

  if (after.length === 0) {
    next.delete(threadId);
  } else {
    next.set(threadId, after);
  }

  const changed = (before.length === 0) !== (after.length === 0);

  return [
    changed
      ? Option.some(after.length === 0 ? "none" : "claude_slot")
      : Option.none(),
    next,
  ];
};

const isUsageLimited = (event: HarnessEvent) =>
  Predicate.isTagged(event, "RunTerminal") &&
  event.status === "failed" &&
  Option.exists(event.failure, (failure) => failure.class === "usage_limit");

/** `ProjectorSignals` from the bridge. Needs `BridgeProvider` and `HarnessSeam`. */
export const ClaudeSignals = Layer.effect(
  ProjectorSignals,
  Effect.gen(function* () {
    const bridge = yield* BridgeProvider;
    const harness = yield* HarnessSeam;

    if (Option.isNone(bridge.claude) || Option.isNone(bridge.usage)) {
      return ProjectorSignals.of({ signals: Stream.empty });
    }

    const claude = bridge.claude.value;
    const usage = bridge.usage.value;

    const waiting = yield* Ref.make<
      ReadonlyMap<ThreadId, ReadonlyArray<string>>
    >(new Map());

    const slotSignals = claude.offered.pipe(
      Stream.mapEffect((offer) =>
        Option.match(Option.flatMap(offer.threadId, decodeThreadId), {
          onNone: () => Effect.succeed(Option.none<ProjectorSignal>()),
          onSome: (threadId) =>
            Effect.map(
              Ref.modify(waiting, (all) =>
                applyWait(all, threadId, offer.sessionId, offer.waiting)
              ),
              Option.map((waitingFor) =>
                ProjectorSignals.waiting(threadId, waitingFor)
              )
            ),
        })
      ),
      Stream.filter(Option.isSome),
      Stream.map((signal) => signal.value)
    );

    const resetAt = Effect.gen(function* () {
      const known = spentWindowsResetAt(yield* usage.current);

      if (Option.isSome(known)) {
        return known;
      }

      yield* usage.probe.pipe(Effect.timeoutOption(PROBE_WAIT));

      return spentWindowsResetAt(yield* usage.current);
    });

    const limitSignals = harness.events.pipe(
      Stream.filter(isUsageLimited),
      Stream.mapEffect((event) =>
        Effect.map(resetAt, (reset) =>
          Option.map(reset, (at): ProjectorSignal => ({
            threadId: event.threadId,
            patch: {
              waitingFor: Option.none(),
              usageLimitResetAt: Option.some(Option.some(at)),
            },
          }))
        )
      ),
      Stream.filter(Option.isSome),
      Stream.map((signal) => signal.value)
    );

    return ProjectorSignals.of({
      signals: Stream.merge(slotSignals, limitSignals),
    });
  })
);
