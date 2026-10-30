// The banner above an open thread for what holds it up beyond the user: a parked task (pi-durable
// stopped retrying it after repeated crashes) with Retry, a turn waiting for a Claude slot, and a
// spent Claude plan window ("Limited") with its reset time. Retry calls `thread.retryTask` at once
// rather than through the outbox: retrying a task that is no longer parked does nothing, and the
// shell stream clears the banner when the thread moves. Which hold stands, and its badge's word and
// tone, come from the one thread-state function (`threadHold`, `HOLD_LABELS` in `ThreadState.ts`).

import {
  HOLD_LABELS,
  ThreadHold,
  threadHold,
} from "@cairn/client-logic/ThreadState";
import type { ThreadTone } from "@cairn/client-logic/ThreadState";
import { TaskId, ThreadId } from "@cairn/protocol/Ids";
import { ThreadShell } from "@cairn/protocol/Shell";
import { Effect, Equal, Option, Schema } from "effect";
import { Command, Submodel } from "foldkit";
import type { Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { CairnConnection, withBoundary } from "../connection/Connection.ts";
import type {
  CairnClient,
  CairnConnectionService,
} from "../connection/Connection.ts";
import { failureMessage } from "../connection/Failure.ts";
import { formatDayTime } from "../settings/Time.ts";
import { badge } from "../ui/Badge.ts";
import type { BadgeVariant } from "../ui/Badge.ts";
import { button, buttonDefaults } from "../ui/Button.ts";

/** The banner's Model: the open thread's row, and the retry in flight. */
export const Model = Schema.Struct({
  thread: Schema.Option(ThreadShell),
  hasClient: Schema.Boolean,
  /** The task whose retry was sent and not answered yet. */
  retrying: Schema.Option(TaskId),
  /** Why the last retry failed. */
  failure: Schema.Option(Schema.String),
});

export type Model = typeof Model.Type;

/** No thread open. */
export const initial: Model = {
  thread: Option.none(),
  hasClient: false,
  retrying: Option.none(),
  failure: Option.none(),
};

/** Everything the banner reacts to. */
export const Message = defineMessageUnion({
  ClickedRetry: { threadId: ThreadId, taskId: TaskId },
  SucceededRetry: {},
  FailedRetry: { message: Schema.String },
});

export type Message = typeof Message.Type;

/** The banner's Retry for the parked task `taskId` of `threadId`, for any view of the banner. */
export const retryMessage = (threadId: ThreadId, taskId: TaskId): Message =>
  Message.ClickedRetry({ threadId, taskId });

/** Asks the brain to run a parked task again, through `client`. */
export const retryParkedTask = (
  client: Pick<CairnClient, "thread.retryTask">,
  input: { readonly threadId: ThreadId; readonly taskId: TaskId }
) =>
  withBoundary(client["thread.retryTask"](input)).pipe(
    Effect.match({
      onSuccess: () => Message.SucceededRetry(),
      onFailure: (failure) =>
        Message.FailedRetry({
          message: failureMessage(
            failure,
            "The task could not be retried. Try again."
          ),
        }),
    })
  );

/** Retries a parked task on the current epoch's client. */
export const RetryParkedTask = Command.define("RetryParkedTask", {
  args: { threadId: ThreadId, taskId: TaskId },
  messages: [Message.SucceededRetry, Message.FailedRetry],
  execute: (input) =>
    CairnConnection.get.pipe(
      Effect.flatMap((client) => retryParkedTask(client, input)),
      Effect.catchTag("ResourceNotAvailable", () =>
        Effect.succeed(
          Message.FailedRetry({
            message: "Cairn is reconnecting. Retry once it is back.",
          })
        )
      )
    ),
});

type UpdateReturn = Update.Return<Model, Message, CairnConnectionService>;

/** Takes the open thread's row; another thread forgets the last retry's outcome. */
export const inform = (
  model: Model,
  context: {
    readonly thread: Option.Option<ThreadShell>;
    readonly hasClient: boolean;
  }
): UpdateReturn => {
  const sameThread = Equal.equals(
    Option.map(model.thread, (thread) => thread.id),
    Option.map(context.thread, (thread) => thread.id)
  );

  return {
    model: modifyFields(model, {
      thread: () => context.thread,
      hasClient: () => context.hasClient,
      retrying: (retrying) => (sameThread ? retrying : Option.none()),
      failure: (failure) => (sameThread ? failure : Option.none()),
    }),
  };
};

/** The banner's update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedRetry: ({ taskId, threadId }) =>
      Option.isSome(model.retrying)
        ? { model }
        : {
            model: modifyFields(model, {
              retrying: () => Option.some(taskId),
              failure: () => Option.none(),
            }),
            commands: [RetryParkedTask({ threadId, taskId })],
          },
    SucceededRetry: () => ({
      model: modifyFields(model, { retrying: () => Option.none() }),
    }),
    FailedRetry: ({ message: text }) => ({
      model: modifyFields(model, {
        retrying: () => Option.none(),
        failure: () => Option.some(text),
      }),
    }),
  });

type H = HtmlBuilder<Message>;

/** A badge's variant for a hold's tone. */
const BADGE_VARIANTS: Readonly<Record<ThreadTone, BadgeVariant>> = {
  info: "info",
  muted: "secondary",
  attention: "warning",
  question: "info",
  warning: "warning",
  error: "error",
  success: "success",
};

const holdBadge = (h: H, tag: ThreadHold["_tag"]): Html => {
  const label = HOLD_LABELS[tag];

  return badge(h, BADGE_VARIANTS[label.tone], "default", [], [label.word]);
};

const BANNER_CLASS =
  "mx-auto mt-2 flex w-full max-w-(--chat-content-max-width) items-center gap-2 rounded-xl border px-3 py-2 text-sm";

const banner = (
  h: H,
  kind: string,
  tone: string,
  children: ReadonlyArray<Html | string>
): Html =>
  h.div(
    [
      h.DataAttribute("testid", "thread-hold"),
      h.DataAttribute("hold", kind),
      h.Role("status"),
      h.Class(`${BANNER_CLASS} ${tone}`),
    ],
    children
  );

const parkedBanner = (
  model: Model,
  thread: ThreadShell,
  taskId: TaskId,
  h: H
): Html =>
  banner(h, "parked", "border-warning/32 bg-warning/8", [
    holdBadge(h, "Parked"),
    h.span(
      [h.Class("min-w-0 flex-1")],
      [
        Option.getOrElse(
          model.failure,
          () =>
            "Work on this thread stopped after it was cut off several times in a row."
        ),
      ]
    ),
    button(
      h,
      {
        ...buttonDefaults<Message>(),
        variant: "outline",
        size: "sm",
        onClick: Option.some(
          Message.ClickedRetry({ threadId: thread.id, taskId })
        ),
        isDisabled: !model.hasClient || Option.isSome(model.retrying),
      },
      [Option.isSome(model.retrying) ? "Retrying" : "Retry"]
    ),
  ]);

const content = (model: Model, h: H): Html =>
  Option.match(
    Option.flatMap(model.thread, (thread) =>
      Option.map(threadHold(thread), (hold) => ({ thread, hold }))
    ),
    {
      onNone: () => h.empty,
      onSome: ({ hold, thread }) =>
        ThreadHold.$match(hold, {
          Parked: ({ taskId }) => parkedBanner(model, thread, taskId, h),
          Limited: ({ resetsAt }) =>
            banner(h, "limited", "border-warning/32 bg-warning/8", [
              holdBadge(h, "Limited"),
              h.span(
                [h.Class("min-w-0 flex-1")],
                [
                  Option.match(resetsAt, {
                    onNone: () =>
                      "The model plan's usage limit was reached. Send again once it resets.",
                    onSome: (at) =>
                      `The model plan's usage limit was reached. It resets ${formatDayTime(at)}.`,
                  }),
                ]
              ),
            ]),
          WaitingForSlot: () =>
            banner(h, "claude-slot", "border-border/60 bg-card/40", [
              holdBadge(h, "WaitingForSlot"),
              h.span(
                [h.Class("min-w-0 flex-1 text-muted-foreground")],
                ["This thread is waiting for a Claude slot."]
              ),
            ]),
        }),
    }
  );

/** The banner, as the root embeds it with `h.submodel` above the thread. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [h.DataAttribute("slot", "thread-hold-slot"), h.Class("contents")],
    [content(model, h)]
  )
);
