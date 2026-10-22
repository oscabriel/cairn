// The thread page's one stream: `thread.subscribe` for the routed thread, opened while the root's
// client exists and opened again for every new epoch, every new watch number and every new thread.
// Each subscription starts with a fresh snapshot.
import { ThreadId } from "@cairn/protocol/Ids";
import { Cause, Effect, Option, Predicate, Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { CairnConnection } from "../../connection/Connection.ts";
import type { CairnConnectionService } from "../../connection/Connection.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";

const describe = (cause: Cause.Cause<unknown>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "The thread stream was interrupted.",
    onSome: (failure) =>
      Predicate.hasProperty(failure, "message") &&
      Predicate.isString(failure.message)
        ? failure.message
        : "The thread stream failed.",
  });

const isMissing = (cause: Cause.Cause<unknown>): boolean =>
  Option.exists(Cause.findErrorOption(cause), (failure) =>
    Predicate.isTagged(failure, "NotFound")
  );

const threadStream = (
  threadId: ThreadId,
  epoch: number,
  watch: number
): Stream.Stream<Message, never, CairnConnectionService> =>
  Stream.unwrap(
    CairnConnection.get.pipe(
      Effect.map((client) =>
        client["thread.subscribe"]({
          threadId,
          conversationId: Option.none(),
        }).pipe(
          Stream.map((item) =>
            Message.ReceivedThreadItem({ epoch, watch, item })
          ),
          Stream.concat(
            Stream.make(
              Message.EndedThreadStream({
                epoch,
                watch,
                missing: false,
                reason: "The thread stream ended.",
              })
            )
          ),
          Stream.catchCause((cause) =>
            Stream.make(
              Message.EndedThreadStream({
                epoch,
                watch,
                missing: isMissing(cause),
                reason: describe(cause),
              })
            )
          )
        )
      ),
      Effect.catchTag("ResourceNotAvailable", () =>
        Effect.succeed(Stream.empty)
      )
    )
  );

/** The page's subscriptions. */
export const subscriptions = Subscription.make<
  Model,
  Message,
  CairnConnectionService
>()((entry) => ({
  thread: entry(
    {
      threadId: Schema.Option(ThreadId),
      epoch: Schema.Int,
      hasClient: Schema.Boolean,
      watch: Schema.Int,
    },
    {
      modelToDependencies: (model) => ({
        threadId: model.threadId,
        epoch: model.epoch,
        hasClient: model.hasClient,
        watch: model.watch,
      }),
      dependenciesToStream: ({ epoch, hasClient, threadId, watch }) =>
        Option.match(threadId, {
          onNone: () => Stream.empty,
          onSome: (id) =>
            hasClient ? threadStream(id, epoch, watch) : Stream.empty,
        }),
    }
  ),
}));
