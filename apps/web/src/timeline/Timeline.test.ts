// The transcript's update and row derivation. Rendering and scrolling are judged in a browser by
// judges/transcript-scroll.ts, over the same submodel.

import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { EntryId } from "@cairn/protocol/Ids";
import { ConversationView, Entry } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import coding from "../../../../judges/fixtures/transcripts/coding.json" with { type: "json" };
import { latestCheckpointTurn } from "../diff/Toggle.ts";
import { growReply, startReply, syntheticThread } from "./harness/Fixture.ts";
import { Message } from "./Message.ts";
import { initial, isFollowingEnd } from "./Model.ts";
import type { Model } from "./Model.ts";
import { itemKeys, transcriptOf } from "./Rows.ts";
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
    assert.strictEqual(onB.ui.list.initialScroll._tag, "Pending");

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
      Message.LoadedEarlier({ threadId: "a", before, page })
    );

    assert.strictEqual(loaded.model.history, "idle");
    assert.deepStrictEqual(loaded.outMessage?._tag, "ReceivedHistory");
    assert.isUndefined(
      update(
        asked.model,
        Message.LoadedEarlier({ threadId: "b", before, page })
      ).outMessage
    );
  });

  it("prepares a Retry as a send and hands it up", () => {
    const retried = update(
      shown("01890a5d-ac96-774b-bcce-b302099a8057"),
      Message.ClickedRetry({
        threadId: "01890a5d-ac96-774b-bcce-b302099a8057",
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
          text: "x",
          attachments: [],
          skillRefs: [],
        })
      ).commands ?? [],
      0
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

  it("re-anchors the list when the first snapshot arrives, not while a reply streams", () => {
    const model = shown("synthetic");
    const state = startReply(syntheticThread(9, 30), 30);
    const anchored = afterView(model, Option.none(), Option.some(state));

    assert.strictEqual(
      anchored.model.ui.list.layoutVersion,
      model.ui.list.layoutVersion + 1
    );

    const streamed = afterView(
      anchored.model,
      Option.some(state),
      Option.some(growReply(state, 30, "Hi"))
    );

    assert.strictEqual(streamed.model, anchored.model);
    assert.isFalse(isFollowingEnd(initial));
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

  return Schema.decodeUnknownSync(Entry)({
    ...raw,
    model: [
      {
        ...message,
        content: [
          { type: "text", text: "Searching the folder." },
          ...(message?.content ?? []),
        ],
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
