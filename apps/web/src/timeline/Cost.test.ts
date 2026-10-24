// The transcript's cost per streamed frame with a long history (T47): the recorded streaming-tools
// frames replayed over a thread holding about 3,000 entries, against deriving that transcript from
// objects never seen before. A share, not a time, so the budget holds on any machine; a frame that
// re-derives everything costs close to the whole.
import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { EntryId } from "@cairn/protocol/Ids";
import type { Entry } from "@cairn/protocol/Thread";
import { ConversationView, ThreadStreamItem } from "@cairn/protocol/Thread";
import { Option, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import coding from "../../../../judges/fixtures/transcripts/coding.json" with { type: "json" };
import frames from "../../../../judges/fixtures/transcripts/streaming-tools.frames.json" with { type: "json" };
import { freshUi } from "./Model.ts";
import { transcriptForKeys, transcriptOf } from "./Rows.ts";

const codingView = Schema.decodeSync(ConversationView)(coding);

const items = Schema.decodeUnknownSync(Schema.Array(ThreadStreamItem))(frames);

/** `count` entries of history, the recorded coding transcript repeated with fresh ids. */
const history = (count: number): ReadonlyArray<Entry> =>
  Array.from({ length: count }, (_, index): Entry => {
    const source = codingView.entries[index % codingView.entries.length] ?? {
      id: EntryId.make(0),
      conversationId: codingView.conversation.id,
      kind: "pi.system",
    };

    return { ...source, id: EntryId.make(1_000_000 + index) };
  });

/** Milliseconds to derive the transcript after every frame, with `older` paged in front. */
const replayMs = (older: ReadonlyArray<Entry>, rounds: number): number => {
  const ui = freshUi(Option.some("thread-cost"));
  let total = 0;

  for (let round = 0; round < rounds; round += 1) {
    let state = Option.none<ThreadViewState>();

    for (const item of items) {
      const next = applyThreadStreamItem(state, item);

      if (Result.isFailure(next)) {
        throw new Error("a recorded frame did not apply");
      }

      const withOlder = Option.some({ ...next.success, older });
      const started = performance.now();

      transcriptOf("thread-cost", withOlder, ui, Option.none());
      total += performance.now() - started;
      state = Option.some(next.success);
    }
  }

  return total;
};

/** Milliseconds to derive the transcript of the last frame from objects it has never seen. */
const coldMs = (older: ReadonlyArray<Entry>, rounds: number): number => {
  let state = Option.none<ThreadViewState>();

  for (const item of items) {
    const next = applyThreadStreamItem(state, item);

    if (Result.isFailure(next)) {
      throw new Error("a recorded frame did not apply");
    }

    state = Option.some(next.success);
  }

  let total = 0;

  for (let round = 0; round < rounds; round += 1) {
    // Fresh copies: no cache keyed on an entry or a page can answer for them.
    const fresh = Option.map(state, (current) => ({
      ...current,
      older: older.map((entry) => ({ ...entry })),
      view: {
        ...current.view,
        entries: current.view.entries.map((entry) => ({ ...entry })),
      },
    }));

    const ui = freshUi(Option.some(`thread-cold-${round}`));
    const started = performance.now();

    transcriptOf(`thread-cold-${round}`, fresh, ui, Option.none());
    total += performance.now() - started;
  }

  return total / rounds;
};

describe("the transcript's cost per streamed frame", () => {
  it("is a small share of deriving the whole transcript, with 3,000 entries of history", () => {
    const large = history(3000);

    // Warm the JIT before measuring.
    replayMs(large, 3);
    coldMs(large, 3);

    const frameMs = replayMs(large, 10) / (10 * items.length);
    const fullMs = coldMs(large, 10);

    // Measured 2026-10-24: 2.2 ms a frame against 23 ms whole (0.1); 16.3 against 19.1 (0.85) before
    // the per-turn rows and the kept entries. Both sides run in one process, so a busy machine
    // slows them alike.
    expect(frameMs / fullMs).toBeLessThan(0.35);
  });
});

describe("a snapshot's transcript", () => {
  it("is derived once for the list's keys and the view, whatever root the view passes", () => {
    let state = Option.none<ThreadViewState>();

    for (const item of items) {
      const next = applyThreadStreamItem(state, item);

      if (Result.isSuccess(next)) {
        state = Option.some(next.success);
      }
    }

    const ui = freshUi(Option.some("thread-keys"));
    const root = Option.some("/home/owner/project");

    // The view of the previous state set the thread's root; the next snapshot's keys reuse it.
    transcriptOf("thread-keys", state, ui, root);

    const snapshot = Option.map(state, (current) => ({
      ...current,
      view: { ...current.view, entries: [...current.view.entries] },
    }));

    const forKeys = transcriptForKeys("thread-keys", snapshot, ui);

    expect(transcriptOf("thread-keys", snapshot, ui, root)).toBe(forKeys);
  });
});
