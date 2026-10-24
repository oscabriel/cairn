// The transcript alone, for judges/transcript-scroll.ts: two synthetic threads (2,100 rows and a
// short one) shown through the real transcript submodel, with buttons to switch threads and to
// stream replies at the end of the long one. No brain, no socket: the thread views are built here.
import { Duration, Effect, Option, Schema, Stream } from "effect";
import { ManagedResource, Runtime, Subscription, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

import { CairnConnection } from "../../connection/Connection.ts";
import type { CairnConnectionService } from "../../connection/Connection.ts";
import { ThreadViewModel } from "../../page/thread/Model.ts";
import { Message as TimelineMessage } from "../Message.ts";
import {
  initial as timelineInitial,
  Model as TimelineModel,
} from "../Model.ts";
import {
  afterView,
  switchThread,
  update as updateTimeline,
} from "../Update.ts";
import { view as timelineView } from "../View.ts";
import {
  commitReply,
  growReply,
  startReply,
  streamedReply,
  syntheticThread,
} from "./Fixture.ts";
import type { StreamedReply } from "./Fixture.ts";

const Model = Schema.Struct({
  timeline: TimelineModel,
  current: Schema.Literals(["a", "b"]),
  a: ThreadViewModel,
  b: ThreadViewModel,
  streaming: Schema.Boolean,
  turn: Schema.Int,
  frame: Schema.Int,
});

type Model = typeof Model.Type;

const Message = defineMessageUnion({
  GotTimelineMessage: { message: TimelineMessage },
  ClickedThread: { id: Schema.Literals(["a", "b"]) },
  ClickedStream: { on: Schema.Boolean },
  Ticked: {},
});

type Message = typeof Message.Type;

const LONG_TURNS = 700;

const TICK = Duration.millis(40);

/** The reply of the turn streaming now, built once per turn rather than once per tick. */
const replies = new Map<number, StreamedReply>();

const replyOf = (turn: number): StreamedReply => {
  const built = replies.get(turn);

  if (built !== undefined) {
    return built;
  }

  const reply = streamedReply(turn);

  replies.clear();
  replies.set(turn, reply);

  return reply;
};

const stateOf = (model: Model) => (model.current === "a" ? model.a : model.b);

const readTimeline = (model: Model): Option.Option<Model["timeline"]> =>
  Option.some(model.timeline);

const writeTimeline = (model: Model, timeline: Model["timeline"]): Model => ({
  ...model,
  timeline,
});

const toGotTimelineMessage = (message: TimelineMessage): Message =>
  Message.GotTimelineMessage({ message });

const foldTimeline = (model: Model, message: TimelineMessage): Return =>
  Update.foldChild({
    update: updateTimeline,
    read: readTimeline,
    write: writeTimeline,
    toParentMessage: toGotTimelineMessage,
    // The harness neither pages history nor sends: OutMessages are dropped.
    foldOutMessage: () => (next: Model) => ({ model: next }),
  })(model, message);

const show = (model: Model, id: "a" | "b"): Return =>
  Update.combine<Model, Message, CairnConnectionService>(
    { ...model, current: id },
    [
      Update.foldChildStep({
        update: (timeline: Model["timeline"]) =>
          switchThread(timeline, Option.some(id)),
        read: readTimeline,
        write: writeTimeline,
        toParentMessage: toGotTimelineMessage,
      }),
      (next: Model) =>
        Update.foldChildStep({
          update: (timeline: Model["timeline"]) =>
            afterView(timeline, Option.none(), Option.some(stateOf(next))),
          read: readTimeline,
          write: writeTimeline,
          toParentMessage: toGotTimelineMessage,
        })(next),
    ]
  );

type Return = Update.Return<Model, Message, CairnConnectionService>;

const tick = (model: Model): Return => {
  const reply = replyOf(model.turn);
  const end = reply.frameEnds[model.frame];

  if (end !== undefined && end < reply.text.length) {
    return {
      model: {
        ...model,
        a: growReply(model.a, model.turn, reply.text.slice(0, end)),
        frame: model.frame + 1,
      },
    };
  }

  const turn = model.turn + 1;

  return {
    model: {
      ...model,
      a: startReply(commitReply(model.a, model.turn, reply.text), turn),
      turn,
      frame: 0,
    },
  };
};

const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    GotTimelineMessage: ({ message: child }) => foldTimeline(model, child),
    ClickedThread: ({ id }) => show(model, id),
    ClickedStream: ({ on }) =>
      on && !model.streaming
        ? {
            model: {
              ...model,
              streaming: true,
              a: startReply(model.a, model.turn),
            },
          }
        : { model: { ...model, streaming: on } },
    Ticked: () =>
      model.streaming && model.current === "a" ? tick(model) : { model },
  });

const init = (): Return =>
  show(
    {
      timeline: timelineInitial,
      current: "a",
      a: syntheticThread(1, LONG_TURNS),
      b: syntheticThread(2, 40),
      streaming: false,
      turn: LONG_TURNS,
      frame: 0,
    },
    "a"
  );

const button = (
  h: HtmlBuilder<Message>,
  testId: string,
  label: string,
  message: Message
): Html =>
  h.button(
    [
      h.Type("button"),
      h.DataAttribute("testid", testId),
      h.OnClick(message),
      h.Class(
        "rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
      ),
    ],
    [label]
  );

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex h-dvh flex-col bg-background text-foreground")],
    [
      h.div(
        [h.Class("flex gap-2 border-b border-border p-2")],
        [
          button(h, "switch-a", "Thread A", Message.ClickedThread({ id: "a" })),
          button(h, "switch-b", "Thread B", Message.ClickedThread({ id: "b" })),
          button(h, "stream-on", "Stream", Message.ClickedStream({ on: true })),
          button(h, "stream-off", "Stop", Message.ClickedStream({ on: false })),
        ]
      ),
      h.submodel({
        slotId: "timeline",
        model: model.timeline,
        view: timelineView,
        viewInputs: {
          state: Option.some(stateOf(model)),
          workspaceRoot: Option.none(),
        },
        toParentMessage: (message) => Message.GotTimelineMessage({ message }),
      }),
    ]
  );

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  tick: entry(
    { streaming: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ streaming: model.streaming }),
      dependenciesToStream: ({ streaming }) =>
        streaming
          ? Stream.tick(TICK).pipe(Stream.map(() => Message.Ticked()))
          : Stream.empty,
    }
  ),
}));

// The transcript's history Command needs a connection; the harness never pages, so none is made.
const managedResources = ManagedResource.make<Model, Message>()((entry) => ({
  connection: entry(Schema.Option(Schema.Struct({})), {
    resource: CairnConnection,
    modelToMaybeRequirements: () => Option.none(),
    acquire: () => Effect.die("The transcript harness has no brain."),
    release: () => Effect.void,
    onAcquired: () => Message.Ticked(),
    onReleased: () => Message.Ticked(),
    onAcquireError: () => Message.Ticked(),
  }),
}));

Runtime.run(
  Runtime.makeElement({
    Model,
    init,
    update,
    view,
    subscriptions,
    managedResources,
    container: document.querySelector("#root"),
  })
);
