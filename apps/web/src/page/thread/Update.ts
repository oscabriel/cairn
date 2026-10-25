// The thread page's update. Items go through client-logic's `applyThreadStreamItem`, which checks
// every op before applying it; a refused item opens a fresh subscription, whose first item is
// always a snapshot. A stream that ends is opened again after a short, growing wait (`Command.ts`),
// except a NotFound for a thread with no launch on its way, which is Missing until the shell learns
// of the thread. The hero opens the page in the same update that queues the launch, so the first
// subscribe can reach the brain before the launch does.
import {
  applyThreadStreamItem,
  prependHistoryAt,
} from "@cairn/client-logic/ThreadView";
import type { ThreadId } from "@cairn/protocol/Ids";
import { Equal, Option, Predicate, Result } from "effect";
import { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { CairnConnectionService } from "../../connection/Connection.ts";
import type { Message as DiffMessage } from "../../diff/Message.ts";
import { isOpen as isDiffOpen } from "../../diff/Model.ts";
import * as DiffUpdate from "../../diff/Update.ts";
import { OutMessage as TimelineOutMessage } from "../../timeline/Message.ts";
import type { Message as TimelineMessage } from "../../timeline/Message.ts";
import * as Timeline from "../../timeline/Update.ts";
import { WaitToResubscribe } from "./Command.ts";
import { LoadDiffPanel } from "./DiffPanel.ts";
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

const readDiff = (model: Model) => Option.some(model.diff);

const writeDiff = (model: Model, diff: Model["diff"]): Model =>
  modifyFields(model, { diff: () => diff });

const toGotDiffMessage = (message: DiffMessage): Message =>
  Message.GotDiffMessage({ message });

/** Runs one of the diff panel's own calls (`open`, `close`) as a step of the page. */
const diffStep = (
  step: (
    diff: Model["diff"]
  ) => Update.Return<Model["diff"], DiffMessage, CairnConnectionService>
) =>
  Update.foldChildStep({
    update: step,
    read: readDiff,
    write: writeDiff,
    toParentMessage: toGotDiffMessage,
  });

/** Asks for the panel's view chunk the first time the panel opens. */
const loadDiffPanel = (model: Model): InformReturn =>
  model.diffPanel === "idle"
    ? {
        model: modifyFields(model, { diffPanel: () => "loading" as const }),
        commands: [LoadDiffPanel()],
      }
    : { model };

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
  /** The routed thread's launch is on its way (queued in the outbox, or its row is `preparing`). */
  readonly launching: boolean;
}

/**
 * Brings the page in line with the route and the connection. A different thread starts from
 * nothing; a new connection keeps the view on screen until its fresh snapshot replaces it. A thread
 * shown as Missing is subscribed again once its launch is known to be on its way.
 */
export const inform = (model: Model, context: PageContext): InformReturn => {
  if (!Equal.equals(model.threadId, context.threadId)) {
    const switched = timelineStep((timeline) =>
      Timeline.switchThread(timeline, Option.map(context.threadId, String))
    )(
      modifyFields(model, {
        threadId: () => context.threadId,
        epoch: () => context.epoch,
        hasClient: () => context.hasClient,
        launching: () => context.launching,
        retries: () => 0,
        status: () => ThreadStatus.Loading(),
        view: () => Option.none(),
      })
    );

    const closed = diffStep(DiffUpdate.close)(switched.model);

    return {
      model: closed.model,
      commands: [...(switched.commands ?? []), ...(closed.commands ?? [])],
    };
  }

  if (model.epoch !== context.epoch || model.hasClient !== context.hasClient) {
    return {
      model: modifyFields(model, {
        epoch: () => context.epoch,
        hasClient: () => context.hasClient,
        launching: () => context.launching,
        status: (status) =>
          model.epoch === context.epoch ? status : ThreadStatus.Loading(),
      }),
    };
  }

  if (model.launching !== context.launching) {
    const known =
      context.launching && Predicate.isTagged(model.status, "Missing");

    return {
      model: modifyFields(model, {
        launching: () => context.launching,
        watch: (watch) => (known ? watch + 1 : watch),
        status: (status) => (known ? ThreadStatus.Loading() : status),
      }),
    };
  }

  return { model };
};

/** Waits, then subscribes again; the wait grows with each attempt since the last snapshot. */
const resubscribeLater = (
  model: Model,
  status: ThreadStatus
): UpdateReturn => ({
  model: modifyFields(model, {
    status: () => status,
    retries: (retries) => retries + 1,
  }),
  commands: [
    WaitToResubscribe({
      epoch: model.epoch,
      watch: model.watch,
      attempt: model.retries,
    }),
  ],
});

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
              retries: (retries) =>
                Predicate.isTagged(received.item, "Snapshot") ? 0 : retries,
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

      if (!ended.missing) {
        return resubscribeLater(
          model,
          ThreadStatus.Failed({ message: ended.reason })
        );
      }

      // The launch may not have reached the brain yet: "not yet", not "never".
      if (model.launching) {
        return resubscribeLater(model, ThreadStatus.Loading());
      }

      return {
        model: modifyFields(model, {
          status: () => ThreadStatus.Missing(),
          view: () => Option.none(),
        }),
      };
    },
    ElapsedResubscribeWait: (elapsed) =>
      isCurrent(model, elapsed)
        ? {
            model: modifyFields(model, {
              watch: (watch) => watch + 1,
              status: (status) =>
                Predicate.isTagged(status, "Ready")
                  ? status
                  : ThreadStatus.Loading(),
            }),
          }
        : { model },
    GotTimelineMessage: ({ message: child }) =>
      Update.foldChild({
        update: Timeline.update,
        read: readTimeline,
        write: writeTimeline,
        toParentMessage: toGotTimelineMessage,
        foldOutMessage: (out) =>
          TimelineOutMessage.match(out, {
            ReceivedHistory:
              ({ before, page }) =>
              (next: Model): UpdateReturn => {
                // A page asked from a window a snapshot has since replaced is dropped (T41).
                const after = Option.map(next.view, (state) =>
                  Option.getOrElse(
                    prependHistoryAt(state, before, page),
                    () => state
                  )
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
            RequestedDiff:
              ({ path, turn }) =>
              (next: Model): UpdateReturn =>
                Option.match(next.threadId, {
                  onNone: () => ({ model: next }),
                  onSome: (threadId) =>
                    Update.combine(next, [
                      diffStep((diff) =>
                        DiffUpdate.open(diff, threadId, turn, path)
                      ),
                      loadDiffPanel,
                    ]),
                }),
          }),
      })(model, child),
    GotDiffMessage: ({ message: child }) =>
      Update.combine(model, [
        (next: Model) =>
          Update.foldChild({
            update: DiffUpdate.update,
            read: readDiff,
            write: writeDiff,
            toParentMessage: toGotDiffMessage,
          })(next, child),
        // The header's toggle opens the panel from here, so its chunk may not be loaded yet.
        (next: Model) =>
          isDiffOpen(next.diff) ? loadDiffPanel(next) : { model: next },
      ]),
    LoadedDiffPanel: () => ({
      model: modifyFields(model, { diffPanel: () => "loaded" as const }),
    }),
    FailedDiffPanel: () => ({
      model: modifyFields(model, { diffPanel: () => "failed" as const }),
    }),
  });
