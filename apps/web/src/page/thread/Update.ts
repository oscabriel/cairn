// The thread page's update. Items go through client-logic's `applyThreadStreamItem`, which checks
// every op before applying it; a refused item opens a fresh subscription, whose first item is
// always a snapshot.
import {
  applyThreadStreamItem,
  prependHistory,
} from "@cairn/client-logic/ThreadView";
import type { ThreadId } from "@cairn/protocol/Ids";
import { Equal, Option, Result } from "effect";
import { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { CairnConnectionService } from "../../connection/Connection.ts";
import { OutMessage as TimelineOutMessage } from "../../timeline/Message.ts";
import type { Message as TimelineMessage } from "../../timeline/Message.ts";
import * as Timeline from "../../timeline/Update.ts";
import { Message, OutMessage } from "./Message.ts";
import type { Model } from "./Model.ts";
import { ThreadStatus } from "./Model.ts";

type InformReturn = Update.Return<Model, Message, CairnConnectionService>;

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  CairnConnectionService
>;

const readTimeline = (model: Model) => Option.some(model.timeline);

const writeTimeline = (model: Model, timeline: Model["timeline"]): Model =>
  modifyFields(model, { timeline: () => timeline });

const toGotTimelineMessage = (message: TimelineMessage): Message =>
  Message.GotTimelineMessage({ message });

/** Runs one of the transcript's own calls (`switchThread`, `afterView`) as a step of the page. */
const timelineStep = (
  step: (
    timeline: Model["timeline"]
  ) => Update.Return<Model["timeline"], TimelineMessage, CairnConnectionService>
) =>
  Update.foldChildStep({
    update: step,
    read: readTimeline,
    write: writeTimeline,
    toParentMessage: toGotTimelineMessage,
  });

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
export const inform = (model: Model, context: PageContext): InformReturn => {
  if (!Equal.equals(model.threadId, context.threadId)) {
    return timelineStep((timeline) =>
      Timeline.switchThread(timeline, Option.map(context.threadId, String))
    )(
      modifyFields(model, {
        threadId: () => context.threadId,
        epoch: () => context.epoch,
        hasClient: () => context.hasClient,
        status: () => ThreadStatus.Loading(),
        view: () => Option.none(),
      })
    );
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
        onSuccess: (view) =>
          timelineStep((timeline) =>
            Timeline.afterView(timeline, model.view, Option.some(view))
          )(
            modifyFields(model, {
              view: () => Option.some(view),
              status: () => ThreadStatus.Ready(),
            })
          ),
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
    GotTimelineMessage: ({ message: child }) =>
      Update.foldChild({
        update: Timeline.update,
        read: readTimeline,
        write: writeTimeline,
        toParentMessage: toGotTimelineMessage,
        foldOutMessage: (out) =>
          TimelineOutMessage.match(out, {
            ReceivedHistory:
              ({ page }) =>
              (next: Model): UpdateReturn => {
                const after = Option.map(next.view, (state) =>
                  prependHistory(state, page)
                );

                return timelineStep((timeline) =>
                  Timeline.afterView(timeline, next.view, after)
                )(modifyFields(next, { view: () => after }));
              },
            RequestedSend:
              ({ item }) =>
              (next: Model): UpdateReturn => ({
                model: next,
                outMessage: OutMessage.RequestedSend({ item }),
              }),
          }),
      })(model, child),
  });
