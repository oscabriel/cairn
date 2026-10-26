// Ported from github.com/pingdotgg/t3code, apps/server/src/orchestration-v2/ShellStream.ts
// (bufferShellLiveStream, coalesceShellApplicationEvents, skipUnchangedThreadShells,
// shellStreamItemFromThreadShell) and the shell subscription in apps/server/src/ws.ts (955-1176,
// canReplayPersistedRange at 703, the limits at 549-553) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
// Kept: a fresh subscription gets a snapshot, the completion marker, then the live tail from the
// snapshot's sequence; a resume within 1,000 events and 8 MiB of payload replays the range and goes
// live from the high-water mark; events are grouped (512 or 50 ms), coalesced per row, refetched
// and sent as whole rows; an unchanged row is skipped unless its last send is 5 s old (comparing `updatedAt` too); the live
// tail coalesces queued rows under the live stream budget. Changed: no enrichment, archived stream
// or analytics; a resume above the high-water mark or below the pruned floor gets a snapshot; an
// archived or deleted thread leaves the shell as a removal.
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

import type { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import {
  ProjectRemovedItem,
  ProjectUpdatedItem,
  ShellSnapshotItem,
  ShellSynchronizedItem,
  ThreadRemovedItem,
  ThreadShell,
  ThreadUpdatedItem,
} from "@cairn/protocol/Shell";
import type {
  ShellDelta,
  ShellStreamItem,
  SubscribeShellInput,
} from "@cairn/protocol/Shell";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
  Stream,
} from "effect";

import { Projects } from "../projects/Projects.ts";
import { EventStore } from "./EventStore.ts";
import type { StoredShellEvent } from "./EventStore.ts";
import {
  bufferLatestLiveStream,
  DEFAULT_LIVE_STREAM_LIMITS,
  initialItems,
} from "./LiveStreamBudget.ts";
import type {
  LiveStreamBufferError,
  LiveStreamLimits,
} from "./LiveStreamBudget.ts";
import { ShellSnapshot } from "./ShellSnapshot.ts";
import type { ShellStoreError } from "./ShellStoreError.ts";
import { isLiveThread, ThreadRows } from "./ThreadRows.ts";

/** Past this many events a resume sends a snapshot, which is cheaper than refetching each row. */
export const SHELL_RESUME_MAX_GAP = 1000;

/** Past this many stored payload bytes a resume sends a snapshot. */
export const SHELL_REPLAY_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024;

/** An unchanged row is sent again once its last send is this old, so client cursors keep up. */
export const UNCHANGED_THREAD_SHELL_RESEND_MS = 5000;

/** How events are grouped before their rows are refetched. */
const GROUP_SIZE = 512;

const GROUP_WINDOW = Duration.millis(50);

/** Keeps the newest event per row, in sequence order. */
export const coalesceShellEvents = (
  events: ReadonlyArray<StoredShellEvent>
): ReadonlyArray<StoredShellEvent> => {
  const latest = new Map<string, StoredShellEvent>();

  for (const event of events) {
    latest.set(`${event.aggregateKind}:${event.aggregateId}`, event);
  }

  return [...latest.values()].toSorted(
    (left, right) => left.sequence - right.sequence
  );
};

const deltaKey = (item: ShellDelta) =>
  Match.valueTags(item, {
    ProjectUpdated: ({ project }) => `project:${project.id}`,
    ProjectRemoved: ({ projectId }) => `project:${projectId}`,
    ThreadUpdated: ({ thread }) => `thread:${thread.id}`,
    ThreadRemoved: ({ threadId }) => `thread:${threadId}`,
  });

/** Buffers live shell rows for a slow client, keeping only the newest queued state of each row. */
export const bufferShellLiveStream = <E, R>(
  source: Stream.Stream<ShellDelta, E, R>,
  limits?: LiveStreamLimits
) => bufferLatestLiveStream(source, deltaKey, limits);

const sameThreadShell = Schema.toEquivalence(ThreadShell);

/**
 * Drops a thread row identical to the last one sent within `UNCHANGED_THREAD_SHELL_RESEND_MS`.
 * Unlike t3code, `updatedAt` counts: a row that changed and changed back between two grouped sends
 * differs only there, and skipping it would leave the client's row stale for good. A skipped row leaves the client's cursor behind, and a resume
 * replays from that cursor, so an unchanged row is still sent once its last send is old.
 */
export const skipUnchangedThreadShells = <E, R>(
  stream: Stream.Stream<ShellDelta, E, R>
): Stream.Stream<ShellDelta, E, R> =>
  Stream.suspend(() => {
    const lastSent = new Map<
      ThreadId,
      { readonly thread: ThreadShell; readonly sentAt: number }
    >();

    return stream.pipe(
      Stream.filterEffect((item) =>
        Effect.map(Clock.currentTimeMillis, (now) =>
          Match.valueTags(item, {
            ThreadRemoved: ({ threadId }) => {
              lastSent.delete(threadId);

              return true;
            },
            ThreadUpdated: ({ thread }) => {
              const previous = lastSent.get(thread.id);

              if (
                previous !== undefined &&
                now - previous.sentAt < UNCHANGED_THREAD_SHELL_RESEND_MS &&
                sameThreadShell(thread, previous.thread)
              ) {
                return false;
              }

              lastSent.set(thread.id, { thread, sentAt: now });

              return true;
            },
            ProjectUpdated: () => true,
            ProjectRemoved: () => true,
          })
        )
      )
    );
  });

/** The live buffer limits of each shell subscription; tests shrink them to force an overflow. */
export class ShellLiveStreamLimits extends Context.Reference<LiveStreamLimits>(
  "cairn/server/shell/ShellLiveStreamLimits",
  { defaultValue: () => DEFAULT_LIVE_STREAM_LIMITS }
) {}

/** A shell stream ended: the client's buffer filled (resubscribe) or the store failed. */
export type ShellStreamError = LiveStreamBufferError | ShellStoreError;

/** The shell stream: a snapshot or a replay, then whole-row updates as they commit. */
export class ShellStream extends Context.Service<
  ShellStream,
  {
    /**
     * Streams the shell for `input`: a snapshot when there is no cursor or the cursor cannot be
     * replayed, else the rows changed after it; then `Synchronized` when asked; then live rows.
     */
    subscribe(
      input: SubscribeShellInput
    ): Stream.Stream<ShellStreamItem, ShellStreamError>;
  }
>()("cairn/server/shell/ShellStream") {
  /** Reads through the shell store's rows, log and snapshot. */
  static readonly layerNoDeps = Layer.effect(
    ShellStream,
    Effect.gen(function* () {
      const eventStore = yield* EventStore;
      const projects = yield* Projects;
      const threads = yield* ThreadRows;
      const snapshots = yield* ShellSnapshot;

      const projectItem = Effect.fnUntraced(function* (
        event: StoredShellEvent,
        projectId: ProjectId
      ) {
        const row = yield* projects.get(projectId);

        return Option.match(
          Option.filter(row, (project) => Option.isNone(project.deletedAt)),
          {
            onNone: (): ShellDelta =>
              ProjectRemovedItem.make({ sequence: event.sequence, projectId }),
            onSome: (project): ShellDelta =>
              ProjectUpdatedItem.make({
                sequence: event.sequence,
                project: project.shell,
              }),
          }
        );
      });

      const threadItem = Effect.fnUntraced(function* (
        event: StoredShellEvent,
        threadId: ThreadId
      ) {
        const row = yield* threads.get(threadId);

        return Option.match(Option.filter(row, isLiveThread), {
          onNone: (): ShellDelta =>
            ThreadRemovedItem.make({ sequence: event.sequence, threadId }),
          onSome: (thread): ShellDelta =>
            ThreadUpdatedItem.make({
              sequence: event.sequence,
              thread: thread.shell,
            }),
        });
      });

      const itemsFor = (events: ReadonlyArray<StoredShellEvent>) =>
        Effect.forEach(coalesceShellEvents(events), (event) =>
          event.aggregateKind === "project"
            ? projectItem(event, event.aggregateId)
            : threadItem(event, event.aggregateId)
        );

      const toShellStream = <E, R>(
        events: Stream.Stream<StoredShellEvent, E, R>
      ) =>
        events.pipe(
          Stream.groupedWithin(GROUP_SIZE, GROUP_WINDOW),
          Stream.mapEffect(itemsFor),
          Stream.flatMap(Stream.fromIterable),
          skipUnchangedThreadShells
        );

      const liveFrom = (afterSequence: number) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const limits = yield* ShellLiveStreamLimits;

            return bufferShellLiveStream(
              toShellStream(eventStore.eventsAfter(afterSequence, () => true)),
              limits
            );
          })
        );

      const replayable = Effect.fnUntraced(function* (
        afterSequence: number,
        highWater: number
      ) {
        const gap = highWater - afterSequence;

        if (gap < 0 || gap > SHELL_RESUME_MAX_GAP) {
          return false;
        }

        if (gap === 0) {
          return true;
        }

        // Every event after the cursor must still be in the log.
        const floor = yield* eventStore.earliestRetainedSequence;

        if (Option.isNone(floor) || floor.value > afterSequence + 1) {
          return false;
        }

        const stats = yield* eventStore.replayStats({
          afterSequence,
          throughSequence: highWater,
        });

        return stats.payloadBytes <= SHELL_REPLAY_PAYLOAD_BUDGET_BYTES;
      });

      const subscribe = (input: SubscribeShellInput) => {
        const marker: Stream.Stream<ShellStreamItem> =
          input.requestCompletionMarker
            ? Stream.make(ShellSynchronizedItem.make({}))
            : Stream.empty;

        const fromSnapshot = Effect.gen(function* () {
          const snapshot = yield* snapshots.load;

          return initialItems<ShellStreamItem>([
            ShellSnapshotItem.make({ snapshot }),
          ]).pipe(
            Stream.concat(marker),
            Stream.concat(liveFrom(snapshot.snapshotSequence))
          );
        });

        return Stream.unwrap(
          Effect.gen(function* () {
            if (Option.isNone(input.afterSequence)) {
              return yield* fromSnapshot;
            }

            const afterSequence = input.afterSequence.value;
            const highWater = yield* eventStore.latestSequence;

            if (!(yield* replayable(afterSequence, highWater))) {
              return yield* fromSnapshot;
            }

            // A row a newer build wrote is skipped by the replay; the live tail resumes from the
            // high-water mark, so a skipped row never hides later events.
            const replay = toShellStream(
              eventStore.readRange({
                afterSequence,
                throughSequence: highWater,
              })
            );

            return replay.pipe(
              Stream.concat(marker),
              Stream.concat(liveFrom(highWater))
            );
          }).pipe(Effect.withSpan("ShellStream.subscribe"))
        );
      };

      return ShellStream.of({ subscribe });
    })
  );
}
