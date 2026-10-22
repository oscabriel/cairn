// The thread page's update. Items go through client-logic's `applyThreadStreamItem`, which checks
// every op before applying it; a refused item opens a fresh subscription, whose first item is
// always a snapshot.
import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadId } from "@cairn/protocol/Ids";
import { Equal, Option, Result } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { ThreadStatus } from "./Model.ts";

type UpdateReturn = Update.Return<Model, Message>;

/** What the root tells the page: the routed thread and the connection streams may use. */
export interface PageContext {
  readonly threadId: Option.Option<ThreadId>;
  readonly epoch: number;
  readonly hasClient: boolean;
}

/**
 * Brings the page in line with the route and the connection. A different thread starts from
 * nothing; a new connection keeps the view on screen until its fresh snapshot replaces it.
 */
export const inform = (model: Model, context: PageContext): UpdateReturn => {
  if (!Equal.equals(model.threadId, context.threadId)) {
    return {
      model: modifyFields(model, {
        threadId: () => context.threadId,
        epoch: () => context.epoch,
        hasClient: () => context.hasClient,
        status: () => ThreadStatus.Loading(),
        view: () => Option.none(),
      }),
    };
  }

  if (model.epoch !== context.epoch || model.hasClient !== context.hasClient) {
    return {
      model: modifyFields(model, {
        epoch: () => context.epoch,
        hasClient: () => context.hasClient,
        status: (status) =>
          model.epoch === context.epoch ? status : ThreadStatus.Loading(),
      }),
    };
  }

  return { model };
};

const isCurrent = (
  model: Model,
  stamp: Readonly<{ epoch: number; watch: number }>
): boolean => stamp.epoch === model.epoch && stamp.watch === model.watch;

/** The thread page's update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ReceivedThreadItem: (received) => {
      if (!isCurrent(model, received)) {
        return { model };
      }

      return Result.match(applyThreadStreamItem(model.view, received.item), {
        onSuccess: (view) => ({
          model: modifyFields(model, {
            view: () => Option.some(view),
            status: () => ThreadStatus.Ready(),
          }),
        }),
        // The item could not be applied: resubscribe for a fresh snapshot.
        onFailure: () => ({
          model: modifyFields(model, {
            watch: (watch) => watch + 1,
            status: () => ThreadStatus.Loading(),
          }),
        }),
      });
    },
    EndedThreadStream: (ended) => {
      if (!isCurrent(model, ended)) {
        return { model };
      }

      return {
        model: ended.missing
          ? modifyFields(model, {
              status: () => ThreadStatus.Missing(),
              view: () => Option.none(),
            })
          : modifyFields(model, {
              status: () => ThreadStatus.Failed({ message: ended.reason }),
            }),
      };
    },
  });
