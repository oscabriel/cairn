// Ported from github.com/pingdotgg/t3code, apps/server/src/orchestration-v2/ThreadSettlementService.ts
// (isAutoSettlementCandidate, isSnoozed, threadHasQueuedTurnStart, resolveAutoSettlementAt and the
// sweep) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the candidate rules (not archived, no
// manual settle state, not pinned, auto-settle on, no pending request, not running, no queued turn
// within a 2 minute grace, not snoozed), the snooze that a failure wakes early, the inactivity rule
// measured from the latest activity or snooze wake, and a sweep that commits a guarded
// `ThreadAutoSettle` per thread. Changed: every pull request branch is gone, the sweep runs every 5
// minutes, a second fiber ends snoozes when their time comes, and the inactivity window is one
// server setting (`autoSettleDays`, 0 turns it off).
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { hasLiveChildren } from "@cairn/client-logic/SubagentTally";
import type { ThreadShell } from "@cairn/protocol/Shell";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Schedule,
} from "effect";

import { SettingsStore } from "../models/SettingsStore.ts";
import { EventSink } from "./EventSink.ts";
import { EventStore } from "./EventStore.ts";
import {
  isThreadBusy,
  ThreadAutoSettle,
  ThreadSnoozeExpire,
} from "./ShellCommands.ts";
import type { ShellStoreError } from "./ShellStoreError.ts";
import { isLiveThread, ThreadRows } from "./ThreadRows.ts";
import type { ThreadRow } from "./ThreadRows.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A user message this recent with no run after it counts as a turn about to start. */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1000;

/** How often the settlement sweep runs. */
export const SETTLEMENT_SWEEP_INTERVAL = Duration.minutes(5);

/** The longest the snooze fiber sleeps before looking again, whatever the next wake time. */
const SNOOZE_CHECK_CEILING = Duration.minutes(5);

/** How long the snooze fiber waits after a failed pass before trying again. */
const SNOOZE_RETRY_DELAY = Duration.seconds(30);

const millis = (value: Option.Option<DateTime.Utc>) =>
  Option.map(value, DateTime.toEpochMillis);

const latestMillis = (values: ReadonlyArray<Option.Option<number>>) =>
  Option.reduceCompact(values, Number.NEGATIVE_INFINITY, Math.max);

const hasAny = (values: ReadonlyArray<Option.Option<number>>) =>
  values.some(Option.isSome);

/**
 * Whether the user sent a message within the grace window that no run has picked up yet. An
 * absolute age bound keeps clock skew and stale rows from blocking settlement forever.
 */
export const threadHasQueuedTurnStart = (
  shell: ThreadShell,
  nowMs: number
): boolean => {
  if (shell.activity === "failed") {
    return false;
  }

  return Option.match(millis(shell.latestUserMessageAt), {
    onNone: () => false,
    onSome: (messageAtMs) => {
      if (Math.abs(nowMs - messageAtMs) > QUEUED_TURN_START_GRACE_MS) {
        return false;
      }

      const runTimes = [
        millis(shell.latestRunRequestedAt),
        millis(shell.latestRunStartedAt),
        millis(shell.latestRunCompletedAt),
      ];

      return (
        !hasAny(runTimes) ||
        runTimes.every((value) =>
          Option.match(value, {
            onNone: () => true,
            onSome: (at) => at < messageAtMs,
          })
        )
      );
    },
  });
};

/**
 * Whether a thread is snoozed at `nowMs`. A pending request wakes it, and so does a run that failed
 * after the snooze began, so a broken thread never hides.
 */
export const isSnoozed = (shell: ThreadShell, nowMs: number): boolean => {
  const until = millis(shell.snoozedUntil);

  if (Option.isNone(until) || until.value <= nowMs) {
    return false;
  }

  if (Option.isSome(shell.pendingRuntimeRequest)) {
    return false;
  }

  const snoozedAt = millis(shell.snoozedAt);
  const completedAt = millis(shell.latestRunCompletedAt);

  const wokeOnFailure =
    shell.activity === "failed" &&
    (Option.isNone(snoozedAt) ||
      (Option.isSome(completedAt) && completedAt.value > snoozedAt.value));

  return !wokeOnFailure;
};

/** Whether the sweep may consider settling `row` at `nowMs`. */
export const isAutoSettlementCandidate = (
  row: ThreadRow,
  nowMs: number
): boolean => {
  const { shell } = row;

  return (
    isLiveThread(row) &&
    Option.isNone(shell.settledOverride) &&
    Option.isNone(shell.pinnedAt) &&
    Option.isNone(shell.autoSettleDisabledAt) &&
    Option.isNone(shell.pendingRuntimeRequest) &&
    !isThreadBusy(shell) &&
    shell.queueLength === 0 &&
    !threadHasQueuedTurnStart(shell, nowMs) &&
    !isSnoozed(shell, nowMs) &&
    // A subagent's row is its parent's to shelve, and a parent waits for its children (ADR 0028).
    Option.isNone(shell.lineage) &&
    !hasLiveChildren(shell.subagents)
  );
};

/**
 * When `row` went quiet, if it has been quiet for longer than `autoSettleDays` at `nowMs`; none
 * when it should stay or auto-settle is off (`autoSettleDays` 0).
 */
export const resolveAutoSettlementAt = (input: {
  readonly row: ThreadRow;
  readonly nowMs: number;
  readonly autoSettleDays: number;
}): Option.Option<DateTime.Utc> => {
  const { row, nowMs, autoSettleDays } = input;
  const { shell } = row;

  if (autoSettleDays <= 0 || !isAutoSettlementCandidate(row, nowMs)) {
    return Option.none();
  }

  const activity = [
    millis(shell.latestUserMessageAt),
    millis(shell.latestRunRequestedAt),
    millis(shell.latestRunStartedAt),
    millis(shell.latestRunCompletedAt),
  ];

  const activityAtMs = hasAny(activity)
    ? latestMillis(activity)
    : DateTime.toEpochMillis(shell.createdAt);

  const timerWake = Option.filter(
    millis(shell.snoozedUntil),
    (until) => until <= nowMs
  );

  const inactivityAtMs = latestMillis([
    Option.some(activityAtMs),
    millis(row.lastSnoozeWakeAt),
    timerWake,
  ]);

  return inactivityAtMs < nowMs - autoSettleDays * DAY_MS
    ? Option.some(DateTime.makeUnsafe(inactivityAtMs))
    : Option.none();
};

/** Settles quiet threads and ends snoozes on time, on the server, so every device agrees. */
export class Settlement extends Context.Service<
  Settlement,
  {
    /** Settles every quiet candidate once. Returns how many settled. */
    readonly sweep: Effect.Effect<number, ShellStoreError>;
    /** Ends every snooze whose time has come. Returns how many woke. */
    readonly wakeSnoozed: Effect.Effect<number, ShellStoreError>;
  }
>()("cairn/server/shell/Settlement") {
  /**
   * Starts the sweep (now, then every 5 minutes) and the snooze timer for the layer's lifetime.
   */
  static readonly layerNoDeps = Layer.effect(
    Settlement,
    Effect.gen(function* () {
      const sink = yield* EventSink;
      const threads = yield* ThreadRows;
      const eventStore = yield* EventStore;
      const settingsStore = yield* SettingsStore;

      const commitQuietly = (
        effect: Effect.Effect<
          boolean,
          ShellStoreError | Effect.Error<ReturnType<typeof sink.commitCommand>>
        >
      ) =>
        effect.pipe(
          Effect.catchTags({
            ShellTargetNotFound: () => Effect.succeed(false),
            ProjectWorkspaceConflictError: () => Effect.succeed(false),
            ShellCommandInvalid: () => Effect.succeed(false),
            ShellCommandConflict: () => Effect.succeed(false),
          })
        );

      const sweep = Effect.gen(function* () {
        // The setting the UI shows, read on every sweep (T32). Unreadable, the sweep waits for
        // the next one rather than guessing a window.
        const settings = yield* settingsStore.get.pipe(
          Effect.tapError((error) =>
            Effect.logWarning("auto-settle skipped: settings unreadable").pipe(
              Effect.annotateLogs({
                event: "settlement_settings_unreadable",
                error: error.message,
              })
            )
          ),
          Effect.option
        );

        if (Option.isNone(settings)) {
          return 0;
        }

        const { autoSettleDays } = settings.value;
        const rows = yield* threads.listLive;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        let settled = 0;

        for (const row of rows) {
          const settledAt = resolveAutoSettlementAt({
            row,
            nowMs,
            autoSettleDays,
          });

          if (Option.isSome(settledAt)) {
            const committed = yield* commitQuietly(
              sink
                .commitCommand(
                  ThreadAutoSettle.make({
                    commandId: yield* sink.mintCommandId,
                    threadId: row.shell.id,
                    snapshotAt: row.shell.updatedAt,
                    settledAt: settledAt.value,
                  })
                )
                .pipe(Effect.as(true))
            );

            settled += committed ? 1 : 0;
          }
        }

        return settled;
      }).pipe(Effect.withSpan("Settlement.sweep"));

      const wakeSnoozed = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const due = yield* threads.snoozesEndedBy(now);
        let woke = 0;

        for (const row of due) {
          if (Option.isSome(row.shell.snoozedUntil)) {
            const committed = yield* commitQuietly(
              sink
                .commitCommand(
                  ThreadSnoozeExpire.make({
                    commandId: yield* sink.mintCommandId,
                    threadId: row.shell.id,
                    snoozedUntil: row.shell.snoozedUntil.value,
                  })
                )
                .pipe(Effect.as(true))
            );

            woke += committed ? 1 : 0;
          }
        }

        return woke;
      }).pipe(Effect.withSpan("Settlement.wakeSnoozed"));

      yield* sweep.pipe(
        Effect.catchTag("ShellStoreError", (failure) =>
          Effect.logWarning("settlement sweep failed", {
            error: failure.message,
          }).pipe(Effect.as(0))
        ),
        Effect.repeat(Schedule.spaced(SETTLEMENT_SWEEP_INTERVAL)),
        Effect.forkScoped
      );

      // Wake when the earliest snooze ends, or sooner when a new snooze lands.
      const snoozeChanges = yield* eventStore.subscribe;

      const nextSnoozeChange = Effect.gen(function* () {
        while (true) {
          const event = yield* PubSub.take(snoozeChanges);

          if (event.type === "thread.snoozed") {
            return;
          }
        }
      });

      const snoozePass = Effect.gen(function* () {
        yield* wakeSnoozed;
        const next = yield* threads.nextSnoozeEnd;
        const now = yield* DateTime.now;

        return Option.match(next, {
          onNone: () => SNOOZE_CHECK_CEILING,
          onSome: (at) =>
            Duration.min(
              SNOOZE_CHECK_CEILING,
              Duration.millis(
                Math.max(
                  0,
                  DateTime.toEpochMillis(at) - DateTime.toEpochMillis(now)
                )
              )
            ),
        });
      }).pipe(
        Effect.catchTag("ShellStoreError", (failure) =>
          Effect.logWarning("snooze wake failed", {
            error: failure.message,
          }).pipe(Effect.as(SNOOZE_RETRY_DELAY))
        )
      );

      yield* Effect.gen(function* () {
        while (true) {
          const delay = yield* snoozePass;

          yield* nextSnoozeChange.pipe(
            Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.void })
          );
        }
      }).pipe(Effect.forkScoped);

      return Settlement.of({ sweep, wakeSnoozed });
    })
  );
}
