// Judges the wire projection the way a client meets it: random revisions of a conversation view
// (streaming text, tool results with images, prompt deltas, provider state, queued inputs, overlong
// strings, whole-view replacements) go through the projector, and a client built on
// @cairn/client-logic's ThreadView applies the frames. After every frame, and after a fresh
// snapshot, the client must hold exactly the projection of the newest revision, and no frame may
// carry image bytes, the provider document, prompt deltas or the bridge's stamp.

import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { ConversationId, EntryId } from "@cairn/protocol/Ids";
import {
  ConversationView,
  ThreadOpsItem,
  ThreadSnapshotItem,
} from "@cairn/protocol/Thread";
import type {
  EntryRecord,
  ConversationView as PiConversationView,
} from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Option, Result, Schema } from "effect";

import { piConversationId, piEntryId } from "./PiIds.ts";
import {
  entryImages,
  HIDDEN_ENTRY_KIND,
  projectEntry,
  projectView,
  wireProjector,
} from "./ThreadWire.ts";

/** A small deterministic generator (Park and Miller), so a failure reproduces from its seed. */
const random = (seed: number) => {
  let state = seed % 2_147_483_647 || 1;

  return () => {
    state = (state * 48_271) % 2_147_483_647;

    return (state - 1) / 2_147_483_646;
  };
};

/** A PNG's base64 starts with this; no frame may carry it. */
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
        diagnostics: [
          {
            type: "cairn.claude",
            timestamp: 1,
            details: { sessionId: "session-secret" },
          },
          { type: "note", timestamp: 1, details: { message: "kept" } },
        ],
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
    data: { diagnostics: [] },
  });

const systemEntry = () =>
  entry("pi.system", {
    model: [
      { role: "system", content: "You are the system prompt.", timestamp: 1 },
    ],
  });

const longEntry = () => userEntry("x".repeat(40_000));

const emptyView = (): PiConversationView => ({
  conversation: { id: piConversationId(ConversationId.make(1)) },
  entries: [],
  docs: {
    "pi.agent": { model: { provider: "faux", modelId: "scripted" } },
    "pi.provider": { sessionId: "provider-session-secret" },
    "pi.live": {},
    "pi.inbox": { items: [] },
    "pi.usage": { input: 0 },
  },
});

/** One random change to a view; pi-durable never mutates a revision, so neither does this. */
const step = (
  view: PiConversationView,
  draw: () => number
): PiConversationView => {
  const choice = Math.floor(draw() * 10);
  const live = view.docs["pi.live"] ?? {};

  switch (choice) {
    case 0: {
      return { ...view, entries: [...view.entries, userEntry(`hi ${draw()}`)] };
    }

    case 1: {
      return { ...view, entries: [...view.entries, assistantEntry("answer")] };
    }

    case 2: {
      return { ...view, entries: [...view.entries, toolResultEntry()] };
    }

    case 3: {
      return { ...view, entries: [...view.entries, systemEntry()] };
    }

    case 4: {
      // Streaming: the partial answer in pi.live grows.
      const previous = JSON.stringify(live).length;

      return {
        ...view,
        docs: {
          ...view.docs,
          "pi.live": {
            run: { taskId: 5, inputs: [] },
            generation: {
              attempt: 1,
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: `token ${previous} `.repeat(3) },
                ],
                diagnostics: [{ type: "cairn.claude", sessionId: "s" }],
              },
            },
          },
        },
      };
    }

    case 5: {
      return {
        ...view,
        docs: {
          ...view.docs,
          "pi.inbox": {
            items: [
              {
                id: 7,
                mode: "followUp",
                content: [
                  { type: "text", text: "queued" },
                  { type: "image", data: PNG_BASE64, mimeType: "image/png" },
                ],
                entry: {
                  kind: "cairn.user",
                  data: {
                    from: "phone",
                    attachments: [{ id: "att_1", mimeType: "image/png" }],
                  },
                },
              },
            ],
          },
          "pi.provider": { sessionId: `rotated-${draw()}` },
        },
      };
    }

    case 6: {
      return { ...view, entries: [...view.entries, longEntry()] };
    }

    case 7: {
      // A compaction: the active range restarts, which a watch delivers as a root replacement.
      return {
        ...view,
        entries: view.entries.slice(-2),
        docs: { ...view.docs, "pi.live": {} },
      };
    }

    case 8: {
      // An overflowed watch delivers `["r", view]`: the same content as all-new objects.
      return structuredClone(view);
    }

    default: {
      return { ...view, docs: { ...view.docs, "pi.usage": { input: draw() } } };
    }
  }
};

const forbidden = [
  "iVBORw0KGgo",
  "pi.provider",
  "provider-session-secret",
  "rotated-",
  "pi.system",
  "cairn.claude",
  "session-secret",
  "You are the system prompt.",
];

const assertClean = (frame: string) => {
  for (const needle of forbidden) {
    assert.notInclude(frame, needle, `a frame carried ${needle}`);
  }
};

const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result), "the projection was refused");

  return Result.getOrThrow(result);
};

const apply = (
  state: Option.Option<ThreadViewState>,
  item: Parameters<typeof applyThreadStreamItem>[1]
) => unwrap(applyThreadStreamItem(state, item));

describe("ThreadWire", () => {
  it("a client applying the frames converges on the projection", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const draw = random(seed);
      const projector = wireProjector();

      let view = emptyView();
      const first = unwrap(projector.snapshot(view));

      assertClean(JSON.stringify(first));

      let client = apply(
        Option.none(),
        ThreadSnapshotItem.make({
          seq: 0,
          view: first,
          entriesOffset: 0,
          hasMoreHistory: false,
        })
      );

      for (let seq = 1; seq <= 120; seq += 1) {
        view = step(view, draw);

        const ops = unwrap(projector.advance(view));

        assertClean(JSON.stringify(ops));

        client = apply(Option.some(client), ThreadOpsItem.make({ seq, ops }));

        assert.deepStrictEqual(
          client.view,
          unwrap(projectView(view)),
          `seed ${seed}, frame ${seq}`
        );
      }

      // A fresh subscription starts from a snapshot that equals what the client converged on.
      const fresh = unwrap(wireProjector().snapshot(view));

      assert.deepStrictEqual(fresh, client.view);
    }
  });

  it("snapshots decode as the protocol's view", () => {
    let view = emptyView();
    const draw = random(42);

    for (let index = 0; index < 50; index += 1) {
      view = step(view, draw);
    }

    const projected = unwrap(projectView(view));

    assert.isTrue(Schema.is(ConversationView)(projected));
  });

  it("projects every entry to a valid protocol entry", () => {
    const hidden = unwrap(projectEntry(systemEntry(), "stream"));
    const tool = unwrap(projectEntry(toolResultEntry(), "stream"));
    const assistant = unwrap(projectEntry(assistantEntry("hi"), "stream"));

    assert.strictEqual(hidden.kind, HIDDEN_ENTRY_KIND);
    assert.isUndefined(hidden.model);

    const toolText = JSON.stringify(tool);

    assert.notInclude(toolText, "iVBORw0KGgo");
    assert.include(toolText, '"_tag":"EntryImage"');
    assert.include(toolText, '"bytes":');

    const assistantText = JSON.stringify(assistant);

    assert.notInclude(assistantText, "cairn.claude");
    assert.include(assistantText, "kept");
  });

  it("cuts long strings for the stream and keeps them whole in full", () => {
    const long = longEntry();
    const cut = JSON.stringify(unwrap(projectEntry(long, "stream")));
    const full = JSON.stringify(unwrap(projectEntry(long, "full")));

    assert.include(cut, "output truncated for transport");
    assert.include(cut, '"truncated":true');
    assert.isBelow(cut.length, 34_000);
    assert.notInclude(full, "output truncated for transport");
    assert.isAbove(full.length, 40_000);
  });

  it("points a queued image at the attachment it was uploaded as", () => {
    const view = step(emptyView(), () => 5 / 9);
    const projected = JSON.stringify(unwrap(projectView(view)));

    assert.include(projected, '"_tag":"Attachment"');
    assert.include(projected, '"attachmentId":"att_1"');
  });

  it("numbers an entry's images as the image route serves them", () => {
    // A tool that returns a picture in `details` and another in its content: the walk meets
    // `data` first, so the route must count the same way or a ref fetches the other image.
    const GIF_BASE64 = `R0lGODlh${"B".repeat(40)}`;

    const both = entry("pi.tool-result", {
      data: {
        details: {
          image: { type: "image", data: GIF_BASE64, mimeType: "image/gif" },
        },
      },
      model: [
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "screenshot",
          content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
          isError: false,
          timestamp: 1,
        },
      ],
    });

    const projected = JSON.stringify(unwrap(projectEntry(both, "full")));

    // Each projected image as "type at index", in whatever order the protocol's schema lays out.
    const refs = [
      ...projected.matchAll(
        /"mimeType":"(?<type>image\/\w+)"[^}]*"_tag":"EntryImage"[^}]*"index":(?<index>\d+)/gu
      ),
    ]
      .map((match) => `${match.groups?.type} at ${match.groups?.index}`)
      .toSorted();

    const served = entryImages(both).map(
      (image, index) => `${image.mimeType} at ${index}`
    );

    assert.deepStrictEqual(refs, ["image/gif at 0", "image/png at 1"]);
    assert.deepStrictEqual(served, refs);
    assert.deepStrictEqual(
      entryImages(both).map((image) => image.data),
      [GIF_BASE64, PNG_BASE64]
    );
  });
});
