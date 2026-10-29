// The transcript alone, for judges/transcript-scroll.ts: two synthetic threads (2,100 rows and a
// short one) shown through the real transcript submodel, with buttons to switch threads and to
// stream replies at the end of the long one. No brain, no socket: the thread views are built here.
//
// Two more buttons change thread A above the reader: `insert-above` puts a turn in front of a prompt
// a few rows above the first visible row, as an escalated question's card lands; `arrive` lands a
// checkpoint for a settled turn above it, so that turn's answer gains its changed-files card late.
//
// `?broken=` turns on one of the list's broken controls (ListModel.ts), so the judge can show a
// check fails without what it guards: `estimate` lays rows the list never drew out at an estimate
// (the range check), `reflow` keeps the raw `scrollTop` through a width change (the reflow check),
// and `anchor` lets a change above the reader move what they see (insert-above and arrive).

import { Duration, Effect, Option, Predicate, Schema, Stream } from "effect";
import { ManagedResource, Runtime, Subscription, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

import { CairnConnection } from "../../connection/Connection.ts";
import type { CairnConnectionService } from "../../connection/Connection.ts";
import { ThreadViewModel } from "../../page/thread/Model.ts";
import type { BrokenControl } from "../list/Model.ts";
import { Message as TimelineMessage } from "../Message.ts";
import {
  initial as timelineInitial,
  Model as TimelineModel,
} from "../Model.ts";
import { transcriptOf } from "../Rows.ts";
import {
  afterView,
  switchThread,
  update as updateTimeline,
} from "../Update.ts";
import { view as timelineView } from "../View.ts";
import {
  commitReply,
  growReply,
  insertTurn,
  landCheckpoint,
  startReply,
  streamedReply,
  syntheticThread,
  turnOfUserEntry,
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
  /** The next id for an entry the harness adds above the reader. */
  nextId: Schema.Int,
  /** How many changes `insert-above` and `arrive` made. */
  landed: Schema.Int,
});

type Model = typeof Model.Type;

const Message = defineMessageUnion({
  GotTimelineMessage: { message: TimelineMessage },
  ClickedThread: { id: Schema.Literals(["a", "b"]) },
  ClickedStream: { on: Schema.Boolean },
  ClickedInsertAbove: {},
  ClickedArrive: {},
  Ticked: {},
});

type Message = typeof Message.Type;

const LONG_TURNS = 700;

const Broken = Schema.Literals(["estimate", "reflow", "anchor"]);

const broken: BrokenControl = Option.getOrElse(
  Schema.decodeUnknownOption(Broken)(
    new URLSearchParams(location.search).get("broken")
  ),
  () => "none" as const
);

/** Ids for added entries, clear of the synthetic threads' own. */
const FIRST_ADDED_ID = 1_000_000;

/** How many rows above the first visible one a change lands, at least: wholly off screen. */
const ROWS_ABOVE = 3;

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

/** The timeline's update, with the list's broken control the page asked for, if any. */
const updateChild = (model: Model, message: TimelineMessage): Return => {
  const next = foldTimeline(model, message);
  const { list } = next.model.timeline.ui;

  return list.broken === broken
    ? next
    : {
        ...next,
        model: {
          ...next.model,
          timeline: {
            ...next.model.timeline,
            ui: { ...next.model.timeline.ui, list: { ...list, broken } },
          },
        },
      };
};

/**
 * The turn a change lands in: the prompt (`prompt`) or answer (`answer`) of thread A's first
 * original turn at least `ROWS_ABOVE` rows above the first visible row, walking up.
 */
const turnAbove = (
  model: Model,
  wanted: "prompt" | "answer"
): Option.Option<number> => {
  const { place } = model.timeline.ui.list;

  if (model.current !== "a" || !Predicate.isTagged(place, "Row")) {
    return Option.none();
  }

  const { items } = transcriptOf(
    "a",
    Option.some(model.a),
    model.timeline.ui,
    Option.none()
  );

  const first = items.findIndex((item) => item.id === place.key);

  for (let index = first - ROWS_ABOVE; index >= 0; index -= 1) {
    const item = items[index];

    if (item?.kind === "message") {
      const userEntryId = Number(item.message.turnId.replace("turn:", ""));

      const fits =
        userEntryId < FIRST_ADDED_ID &&
        (wanted === "prompt"
          ? item.message.role === "user"
          : item.message.role === "assistant" &&
            Option.isNone(item.changedFiles));

      if (fits) {
        return Option.some(turnOfUserEntry(userEntryId));
      }
    }
  }

  return Option.none();
};

const landAbove = (
  model: Model,
  wanted: "prompt" | "answer",
  change: (state: Model["a"], turn: number, id: number) => Model["a"]
): Return =>
  Option.match(turnAbove(model, wanted), {
    onNone: () => ({ model }),
    onSome: (turn) => ({
      model: {
        ...model,
        a: change(model.a, turn, model.nextId),
        nextId: model.nextId + 2,
        landed: model.landed + 1,
      },
    }),
  });

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
    GotTimelineMessage: ({ message: child }) => updateChild(model, child),
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
    ClickedInsertAbove: () => landAbove(model, "prompt", insertTurn),
    ClickedArrive: () => landAbove(model, "answer", landCheckpoint),
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
      nextId: FIRST_ADDED_ID,
      landed: 0,
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
          button(
            h,
            "insert-above",
            "Insert above",
            Message.ClickedInsertAbove()
          ),
          button(h, "arrive", "Arrive", Message.ClickedArrive()),
          h.span(
            [
              h.DataAttribute("testid", "landed"),
              h.DataAttribute("count", String(model.landed)),
              h.Class("self-center text-xs text-muted-foreground"),
            ],
            [`${String(model.landed)} landed`]
          ),
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
