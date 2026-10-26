// The banner above an open thread for what holds it up beyond the user: a parked task (pi-durable
// stopped retrying it after repeated crashes) with Retry, a turn waiting for a Claude slot, and a
// spent Claude plan window ("Limited") with its reset time. Retry calls `thread.retryTask` at once
// rather than through the outbox: retrying a task that is no longer parked does nothing, and the
// shell stream clears the banner when the thread moves.
import { TaskId, ThreadId } from "@cairn/protocol/Ids";
import { ThreadShell } from "@cairn/protocol/Shell";
import { Array, Data, Effect, Equal, Option, Schema } from "effect";
import { Command, Submodel } from "foldkit";
import type { Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { CairnConnection } from "../connection/Connection.ts";
import type {
  CairnClient,
  CairnConnectionService,
} from "../connection/Connection.ts";
import { failureMessage } from "../connection/Failure.ts";
import { formatDayTime } from "../settings/Time.ts";
import { badge } from "../ui/Badge.ts";
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

/** Asks the brain to run a parked task again, through `client`. */
export const retryParkedTask = (
  client: Pick<CairnClient, "thread.retryTask">,
  input: { readonly threadId: ThreadId; readonly taskId: TaskId }
) =>
  client["thread.retryTask"](input).pipe(
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

/** What holds the thread up, most urgent first. */
export type Hold = Data.TaggedEnum<{
  Parked: { readonly taskId: TaskId };
  Limited: { readonly resetsAt: ThreadShell["usageLimitResetAt"] };
  WaitingForSlot: { readonly threadId: ThreadId };
}>;

/** The holds' constructors and matcher. */
export const Hold = Data.taggedEnum<Hold>();

/** What the banner shows for `thread`, if anything. */
export const holdOf = (thread: ThreadShell): Option.Option<Hold> => {
  const parked = Array.head(thread.parkedTaskIds);

  if (Option.isSome(parked)) {
    return Option.some(Hold.Parked({ taskId: parked.value }));
  }

  if (
    thread.activity === "failed" &&
    Option.contains(thread.lastErrorClass, "usage_limit")
  ) {
    return Option.some(Hold.Limited({ resetsAt: thread.usageLimitResetAt }));
  }

  if (thread.waitingFor === "claude_slot") {
    return Option.some(Hold.WaitingForSlot({ threadId: thread.id }));
  }

  return Option.none();
};

const BANNER_CLASS =
  "mx-auto mt-2 flex w-full max-w-(--chat-content-max-width) items-center gap-2 rounded-xl border px-3 py-2 text-sm";

type H = HtmlBuilder<Message>;

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
    badge(h, "warning", "default", [], ["Parked"]),
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
      Option.map(holdOf(thread), (hold) => ({ thread, hold }))
    ),
    {
      onNone: () => h.empty,
      onSome: ({ hold, thread }) =>
        Hold.$match(hold, {
          Parked: ({ taskId }) => parkedBanner(model, thread, taskId, h),
          Limited: ({ resetsAt }) =>
            banner(h, "limited", "border-warning/32 bg-warning/8", [
              badge(h, "warning", "default", [], ["Limited"]),
              h.span(
                [h.Class("min-w-0 flex-1")],
                [
                  Option.match(resetsAt, {
                    onNone: () =>
                      "The Claude plan window is spent. Send again once it resets.",
                    onSome: (at) =>
                      `The Claude plan window is spent. It resets ${formatDayTime(at)}.`,
                  }),
                ]
              ),
            ]),
          WaitingForSlot: () =>
            banner(h, "claude-slot", "border-border/60 bg-card/40", [
              badge(h, "info", "default", [], ["Waiting"]),
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
