// Judges the windowed thread stream the way a client meets it: random revisions of a conversation
// view (appends, streaming, tool images, prompt deltas, compactions that move the head, resets,
// whole-view replacements) go through the windowed projector with a small policy, so windows open
// and move often, and a client built on @cairn/client-logic's ThreadView applies every frame. After
// every frame the client's window must equal the matching slice of the full projection, and what it
// keeps before the window must be the full projection's entries right before it.

import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { ConversationId, EntryId } from "@cairn/protocol/Ids";
import { ThreadOpsItem, ThreadSnapshotItem } from "@cairn/protocol/Thread";
import type { ThreadStreamItem } from "@cairn/protocol/Thread";
import type {
  EntryRecord,
  ConversationView as PiConversationView,
} from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { piConversationId, piEntryId } from "./PiIds.ts";
import {
  WINDOW_POLICY,
  WindowFrame,
  windowedProjector,
  windowStart,
} from "./ThreadWindow.ts";
import type { WindowedView, WindowPolicy } from "./ThreadWindow.ts";
import { projectView } from "./ThreadWire.ts";

/** A small deterministic generator (Park and Miller), so a failure reproduces from its seed. */
const random = (seed: number) => {
  let state = seed % 2_147_483_647 || 1;

  return () => {
    state = (state * 48_271) % 2_147_483_647;

    return (state - 1) / 2_147_483_646;
  };
};

const PNG_BASE64 = `iVBORw0KGgo${"A".repeat(2000)}`;

let nextId = 10;

const entry = (kind: string, fields: Partial<EntryRecord>): EntryRecord => {
  nextId += 1;

  return {
    id: piEntryId(EntryId.make(nextId)),
    conversationId: piConversationId(ConversationId.make(1)),
    kind,
    ...fields,
  };
};

const userEntry = (text: string) =>
  entry("pi.user", {
    model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
  });

const assistantEntry = (text: string) =>
  entry("pi.assistant", {
    model: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "faux",
        provider: "faux",
        model: "scripted",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    ],
  });

const toolResultEntry = () =>
  entry("pi.tool-result", {
    model: [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [
          { type: "text", text: "a screenshot" },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        ],
        isError: false,
        timestamp: 1,
      },
    ],
  });

const systemEntry = () =>
  entry("pi.system", {
    model: [{ role: "system", content: "The prompt.", timestamp: 1 }],
  });

const compactionEntry = () =>
  entry("pi.compaction", { data: { summary: "what happened so far" } });

const emptyView = (): PiConversationView => ({
  conversation: { id: piConversationId(ConversationId.make(1)) },
  entries: [],
  docs: {
    "pi.agent": { model: { provider: "faux", modelId: "scripted" } },
    "pi.live": {},
    "pi.inbox": { items: [] },
    "pi.usage": { input: 0 },
  },
});

const append = (view: PiConversationView, ...added: Array<EntryRecord>) => ({
  ...view,
  entries: [...view.entries, ...added],
});

/** One random change; pi-durable never mutates a revision, so neither does this. */
const step = (
  view: PiConversationView,
  draw: () => number
): PiConversationView => {
  const choice = Math.floor(draw() * 40);

  if (choice < 8) {
    return append(view, userEntry(`ask ${draw()}`));
  }

  if (choice < 16) {
    return append(view, assistantEntry(`answer ${"word ".repeat(choice * 5)}`));
  }

  if (choice < 20) {
    return append(view, toolResultEntry());
  }

  if (choice === 20) {
    return append(view, systemEntry());
  }

  if (choice < 26) {
    // Streaming: the partial answer in pi.live grows.
    const text = JSON.stringify(view.docs["pi.live"] ?? {});

    return {
      ...view,
      docs: {
        ...view.docs,
        "pi.live": { generation: { text: `${text.slice(0, 400)} token` } },
      },
    };
  }

  if (choice === 26) {
    // A compaction moves the head: a summary, then the newest entries kept.
    return {
      ...view,
      entries: [compactionEntry(), ...view.entries.slice(-12)],
      docs: { ...view.docs, "pi.live": {} },
    };
  }

  if (choice === 27 && draw() < 0.3) {
    // A reset: a new path from a new first entry.
    return { ...view, entries: [userEntry("fresh start")] };
  }

  if (choice === 28) {
    // An overflowed watch delivers `["r", view]`: the same content as all-new objects.
    return structuredClone(view);
  }

  if (choice < 32) {
    // Several appends at once, as a slow tick sees them.
    return append(
      view,
      userEntry("burst"),
      assistantEntry("one"),
      toolResultEntry(),
      assistantEntry("two")
    );
  }

  return { ...view, docs: { ...view.docs, "pi.usage": { input: draw() } } };
};

const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result), "the projection was refused");

  return Result.getOrThrow(result);
};

const snapshotItem = (seq: number, windowed: WindowedView) =>
  ThreadSnapshotItem.make({
    seq,
    view: windowed.view,
    entriesOffset: windowed.entriesOffset,
    hasMoreHistory: windowed.entriesOffset > 0,
  });

const apply = (state: Option.Option<ThreadViewState>, item: ThreadStreamItem) =>
  unwrap(applyThreadStreamItem(state, item));

/** The client holds exactly the full projection's slice from `offset`, and the entries before it. */
const assertSlice = (
  client: ThreadViewState,
  offset: number,
  view: PiConversationView,
  where: string
) => {
  const full = unwrap(projectView(view));

  assert.deepStrictEqual(
    client.view,
    { ...full, entries: full.entries.slice(offset) },
    where
  );

  assert.strictEqual(
    client.entriesOffset + client.older.length,
    offset,
    `${where}: held history plus the gap is the window's offset`
  );

  assert.deepStrictEqual(
    client.older,
    full.entries.slice(offset - client.older.length, offset),
    `${where}: held history is the entries right before the window`
  );
};

const SMALL: WindowPolicy = { maxUserTurns: 3, maxEntries: 8, maxBytes: 6000 };

/** What a client holds and the window offset the brain last announced. */
interface Following {
  readonly client: ThreadViewState;
  readonly offset: number;
}

/** Applies one frame the way the harness sends it. */
const follow = (held: Following, seq: number, frame: WindowFrame): Following =>
  WindowFrame.$match(frame, {
    Snapshot: (windowed) => ({
      client: apply(Option.some(held.client), snapshotItem(seq, windowed)),
      offset: windowed.entriesOffset,
    }),
    Ops: ({ ops }) => {
      assert.notInclude(JSON.stringify(ops), "iVBORw0KGgo");

      return {
        client: apply(
          Option.some(held.client),
          ThreadOpsItem.make({ seq, ops })
        ),
        offset: held.offset,
      };
    },
  });

const opsOf = (frame: WindowFrame) =>
  WindowFrame.$match(frame, {
    Snapshot: () => Option.none<ReadonlyArray<unknown>>(),
    Ops: ({ ops }) => Option.some<ReadonlyArray<unknown>>(ops),
  });

const thread = (count: number, userEvery: number) =>
  Array.from({ length: count }, (_, index) =>
    index % userEvery === 0 ? userEntry(`ask ${index}`) : assistantEntry("hi")
  );

describe(windowStart, () => {
  it("holds the last user turns", () => {
    const entries = thread(40, 4);

    assert.strictEqual(windowStart(entries, { ...SMALL, maxEntries: 100 }), 28);
  });

  it("holds at most the entry limit, starting at a turn when that keeps most of it", () => {
    const entries = thread(40, 5);

    // The last 8 entries start mid-turn at 32; the turn at 35 keeps 5 of them.
    assert.strictEqual(
      windowStart(entries, { ...SMALL, maxUserTurns: 10 }),
      35
    );

    // A turn too far in is not worth the loss: 2 of 8 would remain.
    const late = thread(40, 19);

    assert.strictEqual(windowStart(late, { ...SMALL, maxUserTurns: 10 }), 32);
  });

  it("holds at most the byte limit and always one entry", () => {
    const entries = [userEntry("a"), assistantEntry("x".repeat(5000))];

    assert.strictEqual(windowStart(entries, { ...SMALL, maxBytes: 100 }), 1);
    assert.strictEqual(windowStart([], SMALL), 0);
  });

  it("uses t3code's numbers by default", () => {
    const entries = thread(200, 2);

    assert.strictEqual(200 - windowStart(entries), 20);
    assert.deepStrictEqual(WINDOW_POLICY, {
      maxUserTurns: 10,
      maxEntries: 75,
      maxBytes: 1_048_576,
    });
  });
});

describe(windowedProjector, () => {
  it("windowed frames applied by a client equal a slice of the full view", () => {
    let windows = 0;
    let inStream = 0;

    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const draw = random(seed);
      const projector = windowedProjector(SMALL);

      let view = emptyView();

      for (let index = 0; index < 30; index += 1) {
        view = step(view, draw);
      }

      const first = unwrap(projector.snapshot(view));

      let held: Following = {
        client: apply(Option.none(), snapshotItem(0, first)),
        offset: first.entriesOffset,
      };

      assertSlice(held.client, held.offset, view, `seed ${seed}, snapshot`);

      for (let seq = 1; seq <= 300; seq += 1) {
        view = step(view, draw);

        const frame = unwrap(projector.advance(view));

        if (Option.isNone(opsOf(frame))) {
          inStream += 1;
        }

        held = follow(held, seq, frame);

        if (held.offset > 0) {
          windows += 1;
        }

        assertSlice(
          held.client,
          held.offset,
          view,
          `seed ${seed}, frame ${seq}`
        );
      }

      // A fresh subscription's window is a slice of what the client converged on.
      const fresh = unwrap(windowedProjector(SMALL).snapshot(view));
      const full = unwrap(projectView(view));

      assert.deepStrictEqual(fresh.view, {
        ...full,
        entries: full.entries.slice(fresh.entriesOffset),
      });
    }

    // The random walk exercised windows and in-stream snapshots, not only offset 0.
    assert.isAbove(windows, 1000);
    assert.isAbove(inStream, 30);
  });

  it("appends grow the window instead of moving it", () => {
    const projector = windowedProjector(SMALL);
    let view = emptyView();

    for (let index = 0; index < 20; index += 1) {
      view = append(view, userEntry(`ask ${index}`), assistantEntry("hi"));
    }

    const first = unwrap(projector.snapshot(view));

    assert.strictEqual(first.entriesOffset, 34);

    for (let index = 0; index < 20; index += 1) {
      view = append(view, userEntry(`more ${index}`), assistantEntry("hi"));

      const frame = unwrap(projector.advance(view));

      assert.isTrue(
        Option.isSome(opsOf(frame)),
        `append ${index} kept the window`
      );
    }
  });

  it("a consumer that skips revisions converges from one frame", () => {
    const draw = random(99);
    const projector = windowedProjector(SMALL);
    let view = emptyView();

    for (let index = 0; index < 30; index += 1) {
      view = append(view, userEntry(`ask ${index}`), assistantEntry("hi"));
    }

    const first = unwrap(projector.snapshot(view));

    let held: Following = {
      client: apply(Option.none(), snapshotItem(0, first)),
      offset: first.entriesOffset,
    };

    // The harness keeps only the newest revision while a client withholds acks (a sliding queue of
    // one tick), so a slow client sees one frame for many revisions.
    for (let seq = 1; seq <= 10; seq += 1) {
      for (let skipped = 0; skipped < 37; skipped += 1) {
        view = step(view, draw);
      }

      held = follow(held, seq, unwrap(projector.advance(view)));

      assertSlice(held.client, held.offset, view, `slow frame ${seq}`);
    }

    assert.strictEqual(held.client.seq, 10);
  });

  it("an unchanged revision is no ops", () => {
    const projector = windowedProjector(SMALL);
    const view = append(emptyView(), userEntry("a"), assistantEntry("b"));

    unwrap(projector.snapshot(view));

    const frame = unwrap(projector.advance(structuredClone(view)));

    assert.deepStrictEqual(opsOf(frame), Option.some([]));
  });
});
