// The transcript's update and row derivation. Rendering and scrolling are judged in a browser by
// judges/transcript-scroll.ts, over the same submodel.

import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { EntryId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import { ConversationView, Entry, SendInput } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import coding from "../../../../judges/fixtures/transcripts/coding.json" with { type: "json" };
import { OutboxItem } from "../connection/Outbox.ts";
import { latestCheckpointTurn } from "../diff/Toggle.ts";
import { Message as RootMessage } from "../Message.ts";
import { Message as ThreadMessage } from "../page/thread/Message.ts";
import { AppRoute } from "../Route.ts";
import { connectingModel } from "../TestFixtures.ts";
import { update as rootUpdate } from "../Update.ts";
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

  it("shows as a pending user row after the thread's rows until the brain acknowledges it", () => {
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
        ? [last.id, last.message.role, last.message.sender, last.message.text]
        : [],
      ["pending:req-pending-1", "user", "user", "keep the budget under $5"]
    );

    const acknowledged = rootUpdate(
      waiting,
      RootMessage.AcknowledgedOutboxItem({ epoch: 0, key: "req-pending-1" })
    ).model;

    assert.deepStrictEqual(acknowledged.thread.timeline.queuedSends, []);
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
