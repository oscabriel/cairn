// The transcript's update and row derivation. Rendering and scrolling are judged in a browser by
// judges/transcript-scroll.ts, over the same submodel.

import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { EntryId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import { ConversationView, Entry, SendInput } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { Url } from "foldkit";

import coding from "../../../../judges/fixtures/transcripts/coding.json" with { type: "json" };
import { OutboxItem, outboxKey } from "../connection/Outbox.ts";
import { latestCheckpointTurn } from "../diff/Toggle.ts";
import { Message as RootMessage } from "../Message.ts";
import type { Model as RootModel } from "../Model.ts";
import { Message as ThreadMessage } from "../page/thread/Message.ts";
import { AppRoute } from "../Route.ts";
import { connectingModel, launchItem } from "../TestFixtures.ts";
import { init, update as rootUpdate } from "../Update.ts";
import { growReply, startReply, syntheticThread } from "./harness/Fixture.ts";
import { Message as ListMessage } from "./list/Message.ts";
import { Message } from "./Message.ts";
import { initial, isFollowingEnd } from "./Model.ts";
import type { Model } from "./Model.ts";
import { itemKeys, transcriptOf, withPendingSends } from "./Rows.ts";
import { afterView, switchThread, update } from "./Update.ts";

const codingState: ThreadViewState = {
  seq: 1,
  view: Schema.decodeSync(ConversationView)(coding),
  entriesOffset: 0,
  hasMoreHistory: true,
  older: [],
};

const shown = (threadId: string): Model =>
  switchThread(initial, Option.some(threadId)).model;

describe("switching threads", () => {
  it("keeps each thread's open folds and list, and starts a new thread at its end", () => {
    const onA = update(
      shown("a"),
      Message.ToggledTurnFold({ turnId: "turn:16" })
    ).model;

    const onB = switchThread(onA, Option.some("b")).model;

    assert.deepStrictEqual(onB.ui.expandedTurnIds, []);
    assert.strictEqual(onB.ui.list.id, "timeline-b");
    assert.isTrue(isFollowingEnd(onB));

    const backOnA = switchThread(onB, Option.some("a")).model;

    assert.deepStrictEqual(backOnA.ui.expandedTurnIds, ["turn:16"]);
    assert.strictEqual(backOnA.ui.list.id, "timeline-a");
    assert.deepStrictEqual(backOnA.savedOrder, ["a", "b"]);
  });

  it("is a no-op for the thread already shown", () => {
    const model = shown("a");

    assert.strictEqual(switchThread(model, Option.some("a")).model, model);
  });
});

describe("paging and Retry", () => {
  it("asks for one page at a time and hands the page to the thread page", () => {
    const before = EntryId.make(11);

    const asked = update(
      shown("a"),
      Message.ClickedLoadEarlier({ threadId: "a", before })
    );

    assert.strictEqual(asked.model.history, "loading");
    assert.lengthOf(asked.commands ?? [], 1);
    assert.lengthOf(
      update(asked.model, Message.ClickedLoadEarlier({ threadId: "a", before }))
        .commands ?? [],
      0
    );

    const page = { entries: [], hasMore: false };

    const loaded = update(
      asked.model,
      Message.LoadedEarlier({
        threadId: "a",
        request: asked.model.historyRequest,
        before,
        page,
      })
    );

    assert.strictEqual(loaded.model.history, "idle");
    assert.deepStrictEqual(loaded.outMessage?._tag, "ReceivedHistory");
    assert.isUndefined(
      update(
        asked.model,
        Message.LoadedEarlier({
          threadId: "b",
          request: asked.model.historyRequest,
          before,
          page,
        })
      ).outMessage
    );
  });

  it("applies only the latest page request's answer, across a switch away and back", () => {
    const before = EntryId.make(11);
    const page = { entries: [], hasMore: false };

    const first = update(
      shown("a"),
      Message.ClickedLoadEarlier({ threadId: "a", before })
    );

    const away = switchThread(first.model, Option.some("b")).model;
    const back = switchThread(away, Option.some("a")).model;

    const second = update(
      back,
      Message.ClickedLoadEarlier({ threadId: "a", before })
    );

    assert.strictEqual(second.model.history, "loading");

    const requestOf = (result: typeof first): number =>
      result.model.historyRequest;

    const staleFailure = update(
      second.model,
      Message.FailedEarlier({ threadId: "a", request: requestOf(first) })
    );

    assert.strictEqual(
      staleFailure.model.history,
      "loading",
      "the first request's failure leaves the second one loading"
    );

    const staleSuccess = update(
      staleFailure.model,
      Message.LoadedEarlier({
        threadId: "a",
        request: requestOf(first),
        before,
        page,
      })
    );

    assert.strictEqual(staleSuccess.model.history, "loading");
    assert.isUndefined(staleSuccess.outMessage);

    const answered = update(
      staleSuccess.model,
      Message.LoadedEarlier({
        threadId: "a",
        request: requestOf(second),
        before,
        page,
      })
    );

    assert.strictEqual(answered.model.history, "idle");
    assert.strictEqual(answered.outMessage?._tag, "ReceivedHistory");
  });

  it("prepares a Retry as a send and hands it up", () => {
    const retried = update(
      shown("01890a5d-ac96-774b-bcce-b302099a8057"),
      Message.ClickedRetry({
        threadId: "01890a5d-ac96-774b-bcce-b302099a8057",
        turnId: "turn:3",
        text: "again",
        attachments: [],
        skillRefs: [],
      })
    );

    assert.lengthOf(retried.commands ?? [], 1);
    assert.lengthOf(
      update(
        shown("a"),
        Message.ClickedRetry({
          threadId: "a",
          turnId: "turn:3",
          text: "x",
          attachments: [],
          skillRefs: [],
        })
      ).commands ?? [],
      0
    );
  });

  it("sends a failed turn's prompt once however often Retry is pressed", () => {
    const threadId = "01890a5d-ac96-774b-bcce-b302099a8057";

    const retry = Message.ClickedRetry({
      threadId,
      turnId: "turn:3",
      text: "again",
      attachments: [],
      skillRefs: [],
    });

    const first = update(shown(threadId), retry);

    assert.lengthOf(first.commands ?? [], 1);

    const prepared = update(
      first.model,
      Message.PreparedRetry({
        item: OutboxItem.Send({
          input: SendInput.make({
            threadId: ThreadId.make(threadId),
            input: {
              requestId: RequestId.make("01890a5d-ac96-774b-bcce-b302099a8058"),
              text: "again",
              attachments: [],
              skillRefs: [],
            },
            whenBusy: "followUp",
          }),
        }),
      })
    );

    assert.strictEqual(prepared.outMessage?._tag, "RequestedSend");

    const second = update(prepared.model, retry);

    assert.lengthOf(
      second.commands ?? [],
      0,
      "a second Retry on the same failed turn queues no second send"
    );

    const away = switchThread(second.model, Option.some("b")).model;
    const back = switchThread(away, Option.some(threadId)).model;

    assert.lengthOf(update(back, retry).commands ?? [], 0);
    assert.lengthOf(
      update(back, Message.ClickedRetry({ ...retry, turnId: "turn:4" }))
        .commands ?? [],
      1,
      "a later failed turn can be retried"
    );
  });

  it("sends nothing when the failed turn's Retry already waits in the outbox, after a reload or from another tab", () => {
    const threadId = "01890a5d-ac96-774b-bcce-b302099a8057";

    const queued = OutboxItem.Send({
      input: SendInput.make({
        threadId: ThreadId.make(threadId),
        input: {
          requestId: RequestId.make("req-retry-1"),
          text: "again",
          attachments: [],
          skillRefs: [],
        },
        whenBusy: "followUp",
      }),
    });

    // The page loaded with the retry in the saved outbox; its in-memory retry mark is gone.
    const reloaded = rootUpdate(
      {
        ...connectingModel,
        route: AppRoute.Thread({ threadId: ThreadId.make(threadId) }),
        outbox: [queued],
        outboxStored: [queued],
      },
      RootMessage.DismissedNotice()
    ).model;

    const pressed = rootUpdate(
      reloaded,
      RootMessage.GotThreadMessage({
        message: ThreadMessage.GotTimelineMessage({
          message: Message.ClickedRetry({
            threadId,
            turnId: "turn:3",
            text: "again",
            attachments: [],
            skillRefs: [],
          }),
        }),
      })
    );

    assert.deepStrictEqual(
      (pressed.commands ?? []).map(({ name }) => name),
      []
    );
  });

  it("shows no check when the browser refused the copy", () => {
    const clicked = update(
      shown("a"),
      Message.ClickedCopy({ rowId: "r1", text: "x" })
    ).model;

    const refused = update(
      clicked,
      Message.CompletedCopy({ rowId: "r1", version: 1, copied: false })
    ).model;

    assert.isTrue(Option.isNone(refused.copiedRowId));
  });

  it("shows a copy check only for the latest copy", () => {
    const first = update(
      shown("a"),
      Message.ClickedCopy({ rowId: "r1", text: "x" })
    ).model;

    const second = update(
      first,
      Message.ClickedCopy({ rowId: "r2", text: "y" })
    ).model;

    const stale = update(
      second,
      Message.CompletedCopy({ rowId: "r1", version: 1, copied: true })
    ).model;

    const current = update(
      stale,
      Message.CompletedCopy({ rowId: "r2", version: 2, copied: true })
    ).model;

    assert.isTrue(Option.isNone(stale.copiedRowId));
    assert.deepStrictEqual(current.copiedRowId, Option.some("r2"));
    assert.isTrue(
      Option.isNone(
        update(current, Message.ExpiredCopied({ version: 2 })).model.copiedRowId
      )
    );
  });
});

/** The user's own `text` as the brain records it, as entry `id`. */
const userEntry = (id: number, text: string): Entry =>
  Schema.decodeSync(Entry)({
    id,
    conversationId: 3,
    kind: "cairn.user",
    data: { from: "owner@loopback", attachments: [] },
    model: [
      {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: 1_792_673_900_000 + id,
      },
    ],
  });

/** The coding thread's view with `entries` after its own. */
const viewWith = (...entries: ReadonlyArray<Entry>): ThreadViewState => ({
  ...codingState,
  view: {
    ...codingState.view,
    entries: [...codingState.view.entries, ...entries],
  },
});

/** The page after its thread's view became `state`. */
const showing = (model: RootModel, state: ThreadViewState): RootModel =>
  rootUpdate(
    { ...model, thread: { ...model.thread, view: Option.some(state) } },
    RootMessage.DismissedNotice()
  ).model;

const acknowledge = (model: RootModel, key: string): RootModel =>
  rootUpdate(model, RootMessage.AcknowledgedOutboxItem({ epoch: 0, key }))
    .model;

/** Each pending send the thread page was told of, and whether the brain has it. */
const sendsOf = (model: RootModel) =>
  model.thread.timeline.queuedSends.map((send) => [send.requestId, send.sent]);

describe("a send waiting in the outbox", () => {
  const threadId = "01890a5d-ac96-774b-bcce-b302099a8057";

  const queued = OutboxItem.Send({
    input: SendInput.make({
      threadId: ThreadId.make(threadId),
      input: {
        requestId: RequestId.make("req-pending-1"),
        text: "keep the budget under $5",
        attachments: [],
        skillRefs: [],
      },
      whenBusy: "followUp",
    }),
  });

  // The same words sent once before: the queued send is not that row.
  const sentBefore = userEntry(55, "keep the budget under $5");
  const echo = userEntry(60, "keep the budget under $5");

  /** The page on the thread showing `state`, with the send in the outbox. */
  const onThread = (state: Option.Option<ThreadViewState>): RootModel =>
    rootUpdate(
      {
        ...connectingModel,
        route: AppRoute.Thread({ threadId: ThreadId.make(threadId) }),
        thread: {
          ...connectingModel.thread,
          threadId: Option.some(ThreadId.make(threadId)),
          view: state,
        },
        outbox: [queued],
        outboxStored: [queued],
      },
      RootMessage.DismissedNotice()
    ).model;

  it("shows as a pending user row after the thread's rows", () => {
    // The socket is down: the send waits in the outbox, and the thread page is told of it.
    const waiting = rootUpdate(
      {
        ...connectingModel,
        route: AppRoute.Thread({ threadId: ThreadId.make(threadId) }),
        outbox: [queued],
        outboxStored: [queued],
      },
      RootMessage.DismissedNotice()
    ).model;

    const sends = waiting.thread.timeline.queuedSends;

    const transcript = withPendingSends(
      transcriptOf(
        threadId,
        Option.some(codingState),
        initial.ui,
        Option.none()
      ),
      sends
    );

    const last = transcript.items.at(-1);

    assert.deepStrictEqual(
      last?.kind === "pending"
        ? [
            last.id,
            last.sent,
            last.message.role,
            last.message.sender,
            last.message.text,
          ]
        : [],
      [
        "pending:req-pending-1",
        false,
        "user",
        "user",
        "keep the budget under $5",
      ]
    );
  });

  it("stays past the acknowledgement, marked sent, until its own row reaches the transcript", () => {
    const waiting = onThread(Option.some(viewWith(sentBefore)));

    assert.deepStrictEqual(sendsOf(waiting), [["req-pending-1", false]]);

    const acknowledged = acknowledge(waiting, "req-pending-1");

    assert.deepStrictEqual(sendsOf(acknowledged), [["req-pending-1", true]]);

    const echoed = showing(acknowledged, viewWith(sentBefore, echo));

    assert.deepStrictEqual(sendsOf(echoed), []);
    assert.deepStrictEqual(echoed.outboxEchoes, []);
  });

  it("goes when its own row comes before the acknowledgement, and the acknowledgement brings nothing back", () => {
    const waiting = onThread(Option.some(viewWith(sentBefore)));
    const echoed = showing(waiting, viewWith(sentBefore, echo));

    assert.deepStrictEqual(sendsOf(echoed), []);
    assert.deepStrictEqual(sendsOf(acknowledge(echoed, "req-pending-1")), []);
  });

  it("goes once acknowledged when the brain queues it behind a busy run, where the composer lists it", () => {
    const acknowledged = acknowledge(
      onThread(Option.some(codingState)),
      "req-pending-1"
    );

    const queuedByBrain = showing(acknowledged, {
      ...codingState,
      view: {
        ...codingState.view,
        docs: {
          ...codingState.view.docs,
          "pi.inbox": {
            items: [
              {
                id: 7,
                mode: "followUp",
                content: [{ type: "text", text: "keep the budget under $5" }],
              },
            ],
          },
        },
      },
    });

    assert.deepStrictEqual(sendsOf(queuedByBrain), []);
    assert.deepStrictEqual(queuedByBrain.outboxEchoes, []);
  });

  it("keeps a launch's first message past the acknowledgement while the thread prepares, until its row comes", () => {
    const launch = launchItem(threadId);

    const waiting = rootUpdate(
      {
        ...connectingModel,
        route: AppRoute.Thread({ threadId: ThreadId.make(threadId) }),
        outbox: [launch],
        outboxStored: [launch],
      },
      RootMessage.DismissedNotice()
    ).model;

    assert.deepStrictEqual(sendsOf(waiting), [[outboxKey(launch), false]]);

    const acknowledged = acknowledge(waiting, outboxKey(launch));

    assert.deepStrictEqual(sendsOf(acknowledged), [[outboxKey(launch), true]]);

    const started = showing(
      acknowledged,
      viewWith(userEntry(60, "start here"))
    );

    assert.deepStrictEqual(sendsOf(started), []);
  });

  /** The user rows of `model`'s transcript, pending ones too, that carry the send's words. */
  const rowsOfSend = (model: RootModel): number =>
    withPendingSends(
      transcriptOf(threadId, model.thread.view, initial.ui, Option.none()),
      model.thread.timeline.queuedSends
    ).items.filter(
      (item) =>
        (item.kind === "message" || item.kind === "pending") &&
        item.message.role === "user" &&
        item.message.text === "keep the budget under $5"
    ).length;

  it("shows once after a reload when its acknowledgement was lost and the brain already wrote its row", () => {
    // Sent, its row written as entry 60, the acknowledgement lost: the page reloads with the send
    // still in the saved outbox.
    const url = Option.getOrThrow(
      Url.fromString(`https://code.gneiss.run/t/${threadId}`)
    );

    const reloaded = init(
      {
        boot: Option.none(),
        outbox: [queued],
        outboxRead: Option.none(),
        outboxUnread: false,
      },
      url
    ).model;

    // The view arrives holding the row.
    const viewed = showing(
      {
        ...reloaded,
        thread: {
          ...reloaded.thread,
          threadId: Option.some(ThreadId.make(threadId)),
        },
      },
      viewWith(sentBefore, echo)
    );

    // Resent, the brain answers that it already has it.
    const acknowledged = acknowledge(viewed, "req-pending-1");

    assert.deepStrictEqual(sendsOf(acknowledged), []);
    assert.deepStrictEqual(acknowledged.outboxEchoes, []);
    assert.strictEqual(rowsOfSend(acknowledged), 2, "entries 55 and 60 only");
  });

  it("shows once when this page queued it before its thread's view came, and the view holding its row comes before the acknowledgement", () => {
    // Queued with no view (the socket down after a thread switch, or the page just loaded).
    const waiting = onThread(Option.none());

    // The send and the watch go out together; the brain writes the row as entry 60, and the
    // snapshot holding it reaches the page before the acknowledgement.
    const viewed = showing(waiting, viewWith(sentBefore, echo));
    const acknowledged = acknowledge(viewed, "req-pending-1");

    const later = showing(
      acknowledged,
      viewWith(sentBefore, echo, userEntry(61, "and the tests"))
    );

    assert.deepStrictEqual(sendsOf(later), []);
    assert.deepStrictEqual(later.outboxEchoes, []);
    assert.strictEqual(rowsOfSend(later), 2, "entries 55 and 60 only");
  });

  it("shows once when another tab queued it, its row came, and this tab's resend is acknowledged", () => {
    const viewed = showing(onThread(Option.none()), viewWith(sentBefore, echo));

    // Another tab writes the send into storage after this page started; this tab adopts it.
    const adopted = rootUpdate(
      { ...viewed, outbox: [], outboxStored: [], outboxSince: {} },
      RootMessage.CompletedSaveOutbox({
        written: [],
        stored: Option.some([queued]),
        read: Option.none(),
      })
    ).model;

    assert.deepStrictEqual(adopted.outboxAdopted, ["req-pending-1"]);

    const acknowledged = acknowledge(adopted, "req-pending-1");

    assert.deepStrictEqual(sendsOf(acknowledged), []);
    assert.deepStrictEqual(acknowledged.outboxEchoes, []);
  });

  it("is forgotten once acknowledged when the page leaves its thread", () => {
    const acknowledged = acknowledge(
      onThread(Option.some(codingState)),
      "req-pending-1"
    );

    const left = rootUpdate(
      { ...acknowledged, route: AppRoute.Hero() },
      RootMessage.DismissedNotice()
    ).model;

    assert.deepStrictEqual(left.outboxEchoes, []);
  });
});

describe("rows", () => {
  it("lists the recorded coding thread with the history control first", () => {
    const transcript = transcriptOf(
      "coding",
      Option.some(codingState),
      shown("coding").ui,
      Option.none()
    );

    const kinds = transcript.items.map((item) => item.kind);

    assert.strictEqual(kinds[0], "history");
    assert.isTrue(kinds.includes("turn-fold"));
    assert.strictEqual(
      kinds.filter((kind) => kind === "message").length >= 5,
      true
    );
    assert.deepStrictEqual(
      itemKeys(transcript).length,
      new Set(itemKeys(transcript)).size
    );
  });

  it("keeps every settled row's object while a reply streams", () => {
    const { ui } = shown("synthetic");
    const started = startReply(syntheticThread(9, 30), 30);

    const first = transcriptOf(
      "synthetic",
      Option.some(growReply(started, 30, "Hello")),
      ui,
      Option.none()
    );

    const second = transcriptOf(
      "synthetic",
      Option.some(growReply(started, 30, "Hello there")),
      ui,
      Option.none()
    );

    const settled = first.items.slice(0, -3);

    assert.isTrue(settled.every((item, index) => second.items[index] === item));
    assert.isTrue(first.timeline.isWorking);
  });

  it("forgets the heights of rows that are gone when the view changes shape, not while a reply streams", () => {
    const state = startReply(syntheticThread(9, 30), 30);

    const keys = itemKeys(
      transcriptOf(
        "synthetic",
        Option.some(state),
        shown("synthetic").ui,
        Option.none()
      )
    );

    const first = keys[0] ?? "";

    const measuredList = update(
      shown("synthetic"),
      Message.GotListMessage({
        message: ListMessage.MeasuredRows({
          width: 800,
          rows: [
            { key: first, height: 40 },
            { key: "gone", height: 30 },
          ],
          offScreen: false,
        }),
      })
    ).model;

    const kept = afterView(measuredList, Option.none(), Option.some(state));

    assert.deepStrictEqual(kept.model.ui.list.heights, { [first]: 40 });

    const streamed = afterView(
      kept.model,
      Option.some(state),
      Option.some(growReply(state, 30, "Hi"))
    );

    assert.strictEqual(streamed.model, kept.model);
    assert.isTrue(isFollowingEnd(initial));
  });
});

/** A turn-1 checkpoint entry whose turn began at `userEntryId`. */
const checkpointOf = (userEntryId: number) =>
  Schema.decodeSync(Entry)({
    id: 54,
    conversationId: 3,
    kind: "cairn.checkpoint",
    data: {
      turn: 1,
      ref: "refs/cairn/checkpoints/x/turn/1",
      headOid: null,
      capturedAt: 1,
      files: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
      moreFiles: 0,
      userEntryId,
    },
  });

/** The fixture's entry 43, which only calls tools, with a line of text first: an answer, then tools. */
const answerThenTools = ((): Entry => {
  const raw = coding.entries.find((entry) => entry.id === 43);
  const message = raw?.model?.[0];
  const content = message?.content ?? [];

  return Schema.decodeUnknownSync(Entry)({
    ...raw,
    model: [
      {
        ...message,
        content: [{ type: "text", text: "Searching the folder." }, ...content],
      },
    ],
  });
})();

describe("the changed-files card", () => {
  const checkpoint = checkpointOf(50);

  const withCheckpoint: ThreadViewState = {
    ...codingState,
    view: {
      ...codingState.view,
      entries: [...codingState.view.entries, checkpoint],
    },
  };

  it("rides inside the answer that ends its turn, as t3code draws it", () => {
    const transcript = transcriptOf(
      "checkpointed",
      Option.some(withCheckpoint),
      shown("checkpointed").ui,
      Option.none()
    );

    const last = transcript.items.at(-1);

    assert.isFalse(
      transcript.items.some((item) => item.kind === "changed-files")
    );
    assert.strictEqual(last?.kind, "message");
    assert.isTrue(
      last?.kind === "message" &&
        Option.match(last.changedFiles, {
          onNone: () => false,
          onSome: (card) => card.files[0]?.path === "src/a.ts",
        })
    );
  });

  it("rides inside its turn's answer when tool rows end the turn", () => {
    const endsOnTools: ThreadViewState = {
      ...codingState,
      view: {
        ...codingState.view,
        entries: [
          ...codingState.view.entries
            .filter((entry) => entry.id <= 47)
            .map((entry) => (entry.id === 43 ? answerThenTools : entry)),
          checkpointOf(40),
        ],
      },
    };

    const transcript = transcriptOf(
      "ends-on-tools",
      Option.some(endsOnTools),
      shown("ends-on-tools").ui,
      Option.none()
    );

    assert.isFalse(
      transcript.items.some((item) => item.kind === "changed-files")
    );
    assert.isTrue(
      transcript.items.some(
        (item) => item.kind === "message" && Option.isSome(item.changedFiles)
      )
    );
  });

  it("stays out of the turn before when a brain input started its turn and no answer ends it", () => {
    // A wake turn that edits a file and ends on a tool call: its card has no answer of its own.
    const wake = Schema.decodeSync(Entry)({
      id: 60,
      conversationId: 3,
      kind: "pi.user",
      model: [
        {
          role: "user",
          content: [{ type: "text", text: "Subagent finished." }],
          timestamp: 1_792_673_900_000,
        },
      ],
    });

    const toolsOnly = Schema.decodeSync(Entry)({
      id: 61,
      conversationId: 3,
      kind: "pi.assistant",
      model: [
        {
          ...coding.entries.find((entry) => entry.id === 43)?.model?.[0],
          content: [
            {
              type: "toolCall",
              id: "toolu_wake",
              name: "edit",
              arguments: { path: "src/wake.ts" },
            },
          ],
          timestamp: 1_792_673_900_001,
        },
      ],
    });

    const wakeCheckpoint = Schema.decodeSync(Entry)({
      ...checkpointOf(60),
      id: 62,
      data: {
        turn: 2,
        ref: "refs/cairn/checkpoints/x/turn/2",
        headOid: null,
        capturedAt: 2,
        files: [{ path: "src/wake.ts", additions: 1, deletions: 0 }],
        moreFiles: 0,
        userEntryId: 60,
      },
    });

    const wakeTurn: ThreadViewState = {
      ...codingState,
      view: {
        ...codingState.view,
        entries: [...codingState.view.entries, wake, toolsOnly, wakeCheckpoint],
      },
    };

    const transcript = transcriptOf(
      "wake-turn",
      Option.some(wakeTurn),
      shown("wake-turn").ui,
      Option.none()
    );

    assert.isFalse(
      transcript.items.some(
        (item) =>
          item.kind === "message" &&
          Option.exists(item.changedFiles, (card) =>
            card.files.some((file) => file.path === "src/wake.ts")
          )
      )
    );
    assert.isTrue(
      transcript.items.some(
        (item) =>
          item.kind === "changed-files" &&
          item.files.some((file) => file.path === "src/wake.ts")
      )
    );
  });

  it("gives the header toggle the newest checkpointed turn", () => {
    assert.deepStrictEqual(
      latestCheckpointTurn(withCheckpoint.view.entries),
      Option.some(1)
    );
    assert.deepStrictEqual(
      latestCheckpointTurn(codingState.view.entries),
      Option.none()
    );
  });
});
