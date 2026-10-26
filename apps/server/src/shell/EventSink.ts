// Ported from github.com/pingdotgg/t3code, apps/server/src/orchestration-v2/EventSink.ts (the publish
// lane in commitThenPublish, 253-276, and commitCommand, 615-675) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: one transaction reserves the receipt, appends the
// events and applies them to the rows; a duplicate command id returns the stored answer; events are
// published after the commit through a single-permit lane, so subscribers see them in commit order.
// Changed: no outbox, run guards or provider-thread guards; rejections are stored in the receipt
// in the same transaction; the plan comes from the pure `planShellCommand`.
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

import { CommandId } from "@cairn/protocol/Ids";
import type { DispatchResult } from "@cairn/protocol/ShellCommands";
import {
  Array as Arr,
  Clock,
  Context,
  Data,
  DateTime,
  Effect,
  Layer,
  Option,
  Random,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";

import { Projects } from "../projects/Projects.ts";
import { CommandReceipts } from "./CommandReceipts.ts";
import { EventStore } from "./EventStore.ts";
import type { StoredShellEvent } from "./EventStore.ts";
import {
  commandAggregate,
  commandTargets,
  planShellCommand,
  ServerShellCommand,
} from "./ShellCommands.ts";
import type { ShellCommandRejection } from "./ShellCommands.ts";
import { shellStoreFailure } from "./ShellStoreError.ts";
import type { ShellStoreError } from "./ShellStoreError.ts";
import { ThreadRows } from "./ThreadRows.ts";

const encodeCommand = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(ServerShellCommand))
);

/** What a commit attempt ended in: new events, or the answer an earlier attempt or a refusal gave. */
type Outcome = Data.TaggedEnum<{
  Committed: { readonly events: Arr.NonEmptyReadonlyArray<StoredShellEvent> };
  Answered: {
    readonly sequence: number;
    readonly rejection: Option.Option<ShellCommandRejection>;
  };
}>;

const Outcome = Data.taggedEnum<Outcome>();

const hex = (value: number, width: number) =>
  value.toString(16).padStart(width, "0");

/** Commits shell commands: one transaction per command, published in commit order. */
export class EventSink extends Context.Service<
  EventSink,
  {
    /**
     * Plans and commits `command`, or returns the first answer when its command id was seen
     * before. Fails with the command's rejection (also stored) or a store failure (nothing
     * committed).
     */
    commitCommand(
      command: ServerShellCommand
    ): Effect.Effect<DispatchResult, ShellCommandRejection | ShellStoreError>;
    /** A fresh UUIDv7 command id for a command the server issues itself. */
    readonly mintCommandId: Effect.Effect<CommandId>;
  }
>()("cairn/server/shell/EventSink") {
  /** Needs the shell store's tables, rows and log. */
  static readonly layerNoDeps = Layer.effect(
    EventSink,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventStore = yield* EventStore;
      const receipts = yield* CommandReceipts;
      const projects = yield* Projects;
      const threads = yield* ThreadRows;

      // Transactions commit one at a time, but each writer publishes after its commit. If a writer
      // were descheduled in between, a later commit could reach subscribers first, and clients drop
      // any event at or below the newest sequence they applied. The lane is taken inside the
      // transaction and released after publishing.
      const publishLane = yield* Semaphore.make(1);

      const commitThenPublish = <A, E, R>(
        transaction: Effect.Effect<A, E, R>,
        publish: (committed: A) => Effect.Effect<void>
      ) =>
        Effect.suspend(() => {
          let holdsLane = false;

          const takeLane = publishLane.take(1).pipe(
            Effect.andThen(
              Effect.sync(() => {
                holdsLane = true;
              })
            ),
            Effect.uninterruptible
          );

          return sql
            .withTransaction(Effect.tap(transaction, () => takeLane))
            .pipe(
              Effect.tap(publish),
              Effect.ensuring(
                Effect.suspend(() =>
                  holdsLane ? publishLane.release(1) : Effect.void
                )
              )
            );
        });

      const loadState = Effect.fnUntraced(function* (
        command: ServerShellCommand,
        now: DateTime.Utc
      ) {
        const targets = commandTargets(command);

        const project = Option.isSome(targets.projectId)
          ? yield* projects.get(targets.projectId.value)
          : Option.none();

        const workspaceOwner = Option.isSome(targets.workspaceRoot)
          ? yield* projects.activeByWorkspaceRoot(targets.workspaceRoot.value)
          : Option.none();

        const thread = Option.isSome(targets.threadId)
          ? yield* threads.get(targets.threadId.value)
          : Option.none();

        const projectThreads =
          targets.projectThreads && Option.isSome(targets.projectId)
            ? yield* threads.listByProject(targets.projectId.value)
            : [];

        return { now, project, workspaceOwner, thread, projectThreads };
      });

      const transaction = Effect.fnUntraced(function* (
        command: ServerShellCommand
      ): Effect.fn.Return<Outcome, ShellStoreError> {
        const existing = yield* receipts.find(command.commandId);

        if (Option.isSome(existing)) {
          return Outcome.Answered({
            sequence: existing.value.resultSequence,
            rejection: existing.value.rejection,
          });
        }

        const now = yield* DateTime.now;
        const state = yield* loadState(command, now);
        const plan = planShellCommand(command, state);
        const aggregate = commandAggregate(command);

        if (Result.isFailure(plan)) {
          const sequence = yield* eventStore.latestSequence;

          yield* receipts.write({
            commandId: command.commandId,
            commandType: command._tag,
            ...aggregate,
            acceptedAt: now,
            resultSequence: sequence,
            rejection: Option.some(plan.failure),
          });

          return Outcome.Answered({
            sequence,
            rejection: Option.some(plan.failure),
          });
        }

        const payloadJson = yield* encodeCommand(command).pipe(
          shellStoreFailure("EventSink.commitCommand")
        );

        const events = yield* eventStore.append({
          commandId: command.commandId,
          occurredAt: now,
          events: plan.success.events,
          payloadJson,
        });

        yield* Effect.forEach(
          plan.success.projects,
          (row) => projects.write(row),
          {
            discard: true,
          }
        );
        yield* Effect.forEach(
          plan.success.threads,
          (row) => threads.write(row),
          {
            discard: true,
          }
        );
        yield* receipts.write({
          commandId: command.commandId,
          commandType: command._tag,
          ...aggregate,
          acceptedAt: now,
          resultSequence: Arr.lastNonEmpty(events).sequence,
          rejection: Option.none(),
        });
        yield* eventStore.prune;

        return Outcome.Committed({ events });
      });

      const commitCommand = Effect.fn("EventSink.commitCommand")(function* (
        command: ServerShellCommand
      ) {
        const outcome = yield* commitThenPublish(
          transaction(command),
          Outcome.$match({
            Committed: ({ events }) => eventStore.publish(events),
            Answered: () => Effect.void,
          })
        ).pipe(
          Effect.catchTag("SqlError", (cause) =>
            shellStoreFailure("EventSink.commitCommand")(Effect.fail(cause))
          )
        );

        return yield* Outcome.$match(outcome, {
          Committed: ({ events }) =>
            Effect.succeed({ sequence: Arr.lastNonEmpty(events).sequence }),
          Answered: ({ sequence, rejection }) =>
            Option.match(rejection, {
              onNone: () => Effect.succeed({ sequence }),
              onSome: Effect.fail,
            }),
        });
      });

      const mintCommandId = Effect.gen(function* () {
        const millis = yield* Clock.currentTimeMillis;

        const random = yield* Effect.forEach([0, 1, 2, 3, 4], () =>
          Random.nextIntBetween(0, 0xff_ff)
        );

        const [a = 0, b = 0, c = 0, d = 0, e = 0] = random;
        const time = hex(millis, 12);

        // Version 7 in the high nibble of the seventh byte, variant 10 in the ninth.
        const uuid = [
          time.slice(0, 8),
          time.slice(8, 12),
          hex(0x70_00 + (a % 0x10_00), 4),
          hex(0x80_00 + (b % 0x40_00), 4),
          hex(c, 4) + hex(d, 4) + hex(e, 4),
        ].join("-");

        return CommandId.make(uuid);
      });

      return EventSink.of({ commitCommand, mintCommandId });
    })
  );

  /** The event sink with its stores, over the ambient `SqlClient`. */
  static readonly layer = EventSink.layerNoDeps.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        EventStore.layerNoDeps,
        CommandReceipts.layerNoDeps,
        Projects.layerNoDeps,
        ThreadRows.layerNoDeps
      )
    )
  );
}
