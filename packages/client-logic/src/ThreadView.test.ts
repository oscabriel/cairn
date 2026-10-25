import { ConversationId, EntryId } from "@cairn/protocol/Ids";
import { ThreadOpsItem, ThreadSnapshotItem } from "@cairn/protocol/Thread";
import type { ConversationView, Op } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";

import {
  applyThreadStreamItem,
  historyCursor,
  prependHistory,
  prependHistoryAt,
  threadEntries,
} from "./ThreadView.ts";
import type { ThreadViewState } from "./ThreadView.ts";

const conversationId = ConversationId.make(1);

const entry = (id: number, text: string) => ({
  id: EntryId.make(id),
  conversationId,
  kind: "message",
  model: [{ role: "user", content: [{ type: "text", text }] }],
});

const view = (ids: ReadonlyArray<number>): ConversationView => ({
  conversation: { id: conversationId },
  entries: ids.map((id) => entry(id, `entry ${id}`)),
  docs: { "pi.live": { run: null } },
});

const snapshot = (entriesOffset = 0, ids: ReadonlyArray<number> = [1, 2]) =>
  ThreadSnapshotItem.make({
    seq: 0,
    view: view(ids),
    entriesOffset,
    hasMoreHistory: entriesOffset > 0,
  });

const ops = (seq: number, batch: ReadonlyArray<Op>) =>
  ThreadOpsItem.make({ seq, ops: batch });

const start = (item = snapshot()): ThreadViewState =>
  Result.getOrThrow(applyThreadStreamItem(Option.none(), item));

const apply = (
  state: ThreadViewState,
  item: Parameters<typeof applyThreadStreamItem>[1]
) => applyThreadStreamItem(Option.some(state), item);

const failureReason = (result: ReturnType<typeof applyThreadStreamItem>) =>
  Result.match(result, {
    onFailure: (error) => error.reason,
    onSuccess: () => "applied",
  });

describe(applyThreadStreamItem, () => {
  it("takes a snapshot whole, replacing any earlier view and history", () => {
    const first = prependHistory(start(snapshot(3, [4, 5])), {
      entries: [entry(3, "older")],
      hasMore: true,
    });

    const replaced = Result.getOrThrow(apply(first, snapshot(0, [9])));

    assert.deepStrictEqual(replaced.view, view([9]));
    assert.deepStrictEqual(replaced.older, []);
    assert.strictEqual(replaced.entriesOffset, 0);
  });

  it("applies ops without mutating the previous view", () => {
    const state = start();

    const next = Result.getOrThrow(
      apply(
        state,
        ops(1, [
          ["a", ["entries", 1, "model", 0, "content", 0, "text"], " and more"],
          ["p", ["entries"], 2, 0, [entry(3, "new")]],
          ["s", ["docs", "pi.live", "run"], { id: 7 }],
        ])
      )
    );

    assert.deepStrictEqual(
      next.view.entries.map((row) => row.id),
      [1, 2, 3]
    );
    assert.deepStrictEqual(next.view.docs["pi.live"], { run: { id: 7 } });
    assert.include(JSON.stringify(next.view.entries[1]), "entry 2 and more");
    assert.deepStrictEqual(state.view, view([1, 2]));
    assert.strictEqual(next.seq, 1);
  });

  it("addresses entries from the window's start when the view is a window", () => {
    // Five older entries are left out; index 0 is entry 6.
    const state = start(snapshot(5, [6, 7]));

    const next = Result.getOrThrow(
      apply(state, ops(1, [["s", ["entries", 0, "kind"], "edited"]]))
    );

    assert.strictEqual(next.view.entries[0]?.kind, "edited");
    assert.strictEqual(next.view.entries[0]?.id, 6);
    assert.strictEqual(next.entriesOffset, 5);
  });

  it("refuses hostile and malformed paths and leaves the view as it was", () => {
    const state = start();

    const hostile: ReadonlyArray<Op> = [
      ["s", ["__proto__", "polluted"], true],
      ["s", ["entries", 0, "__proto__", "polluted"], true],
      ["s", ["docs", "constructor", "prototype", "polluted"], true],
      ["s", ["entries", 9, "kind"], "x"],
      ["p", ["entries"], 3, 0, [entry(3, "past the end")]],
      ["p", ["entries"], 1, 5, []],
      ["p", ["docs"], 0, 0, []],
      ["m", ["entries"], [0, 0]],
      ["m", ["entries"], [1]],
      ["d", ["missing", "key"]],
    ];

    for (const op of hostile) {
      assert.strictEqual(
        failureReason(apply(state, ops(1, [op]))),
        "unsafe_path",
        JSON.stringify(op)
      );
    }

    assert.isFalse(Object.hasOwn(Object.prototype, "polluted"));
    assert.deepStrictEqual(state.view, view([1, 2]));
  });

  it("refuses ops that would break the view's shape", () => {
    const state = start();

    for (const op of [
      ["r", 5],
      ["s", ["entries"], "not a list"],
      ["d", ["docs"]],
    ] satisfies ReadonlyArray<Op>) {
      assert.strictEqual(
        failureReason(apply(state, ops(1, [op]))),
        "malformed_view",
        JSON.stringify(op)
      );
    }

    const replaced = Result.getOrThrow(
      apply(state, ops(1, [["r", view([5])]]))
    );

    assert.deepStrictEqual(replaced.view, view([5]));
  });

  it("refuses ops before a snapshot and ops whose seq does not move forward", () => {
    assert.strictEqual(
      failureReason(applyThreadStreamItem(Option.none(), ops(1, []))),
      "no_snapshot"
    );

    const state = Result.getOrThrow(apply(start(), ops(2, [])));

    assert.strictEqual(failureReason(apply(state, ops(2, []))), "out_of_order");
    assert.strictEqual(failureReason(apply(state, ops(1, []))), "out_of_order");
    assert.strictEqual(failureReason(apply(state, ops(3, []))), "applied");
  });
});

describe("history", () => {
  it("drops a page asked from a window a snapshot has since replaced", () => {
    // Asked before 100; a snapshot then moved the window to start at 180.
    const asked = start(snapshot(99, [100, 101]));
    const moved = Result.getOrThrow(apply(asked, snapshot(179, [180, 181])));
    const page = { entries: [entry(98, "a"), entry(99, "b")], hasMore: true };

    assert.isTrue(
      Option.isNone(prependHistoryAt(moved, EntryId.make(100), page))
    );
    assert.deepStrictEqual(
      historyCursor(moved),
      Option.some(EntryId.make(180))
    );
    assert.isTrue(
      Option.isSome(prependHistoryAt(asked, EntryId.make(100), page))
    );
  });

  it("prepends older pages without moving the indices ops address", () => {
    const state = prependHistory(start(snapshot(4, [5, 6])), {
      entries: [entry(3, "three"), entry(4, "four")],
      hasMore: true,
    });

    assert.strictEqual(state.entriesOffset, 2);
    assert.isTrue(state.hasMoreHistory);
    assert.deepStrictEqual(historyCursor(state), Option.some(EntryId.make(3)));

    const next = Result.getOrThrow(
      apply(state, ops(1, [["s", ["entries", 0, "kind"], "edited"]]))
    );

    assert.deepStrictEqual(
      threadEntries(next).map((row) => [row.id, row.kind]),
      [
        [3, "message"],
        [4, "message"],
        [5, "edited"],
        [6, "message"],
      ]
    );
  });
});
