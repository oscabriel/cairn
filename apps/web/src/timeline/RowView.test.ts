// Scene tests for the user message row, rendered from a thread's view through the transcript's own
// derivation, as the thread page draws it.

import { AttachmentId } from "@cairn/protocol/Ids";
import { ConversationView, ProjectedImage } from "@cairn/protocol/Thread";
import { Option, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";
import { describe, expect, it } from "vitest";

import { rowView as nextRowView } from "../next/timeline/RowView.ts";
import type { Message } from "./Message.ts";
import { freshUi } from "./Model.ts";
import { transcriptOf, withPendingSends } from "./Rows.ts";
import type { ListItem } from "./Rows.ts";
import { rowView } from "./RowView.ts";

const THREAD_ID = "01890a5d-ac96-774b-bcce-b302099a8057";

const [AttachmentImageRef] = ProjectedImage.fields.ref.members;

/**
 * Entry 1563 of the live store as the wire projects it: one photo (pointing at its attachment), the
 * words typed with it, and the brain's path line.
 */
const photoTurn = Schema.decodeSync(ConversationView)({
  conversation: { id: 1 },
  entries: [
    {
      id: 1563,
      conversationId: 1,
      kind: "cairn.user",
      model: [
        {
          role: "user",
          content: [
            { type: "text", text: "what word does this show?" },
            {
              type: "image",
              mimeType: "image/jpeg",
              bytes: 116_512,
              ref: Schema.encodeSync(ProjectedImage.fields.ref)(
                AttachmentImageRef.make({
                  attachmentId: AttachmentId.make("EIyYlN6GUR-MCvmobE_-Rg"),
                })
              ),
            },
            {
              type: "text",
              text: '[Attached image "IMG_0606.jpg" (image/jpeg, 85 KB) is saved at: /home/oscargabriel/.local/share/cairn/attachments/EIyYlN6GUR-MCvmobE_-Rg]',
            },
          ],
          timestamp: 1_760_000_000_000,
        },
      ],
      data: {
        from: "owner@github",
        attachments: [
          {
            id: "EIyYlN6GUR-MCvmobE_-Rg",
            name: "IMG_0606.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 87_384,
            kind: "image",
            sha256:
              "8759d29e20eaa904b78a2018e270ef8baead56d353642bf5394c4349db7e454f",
          },
        ],
      },
    },
  ],
  docs: {},
});

const userRow = (view: ConversationView): ListItem => {
  const transcript = transcriptOf(
    THREAD_ID,
    Option.some({
      seq: 0,
      view,
      entriesOffset: 0,
      hasMoreHistory: false,
      older: [],
    }),
    freshUi(Option.some(THREAD_ID)),
    Option.none()
  );

  const row = transcript.items.find(
    (item) => item.kind === "message" && item.message.role === "user"
  );

  if (row === undefined) {
    throw new Error("the transcript has no user row");
  }

  return row;
};

const config = (item: ListItem) => ({
  update: (model: null) => ({ model }),
  view: (_model: null, h: HtmlBuilder<Message>): Html =>
    rowView(h, item, {
      threadId: THREAD_ID,
      workspaceRoot: Option.none(),
      highlightedLanguages: [],
      highlightedCode: 0,
      copiedRowId: Option.none(),
      expanded: false,
      retryPrompt: Option.none(),
      history: "idle",
      historyCursor: Option.none(),
      subagents: Option.none(),
    }),
});

/** A wake and the brief that starts a child, as the brain writes them: `pi.user` entries. */
const brainInputs = Schema.decodeSync(ConversationView)({
  conversation: { id: 1 },
  entries: [
    {
      id: 7,
      conversationId: 1,
      kind: "pi.user",
      model: [
        {
          role: "user",
          content:
            'Subagent "Probe the bridge" reported; its result is in the note above.',
          timestamp: 1_760_000_000_000,
        },
      ],
    },
  ],
  docs: {},
});

const pendingRow = (): ListItem => {
  const item = withPendingSends(
    transcriptOf(
      THREAD_ID,
      Option.none(),
      freshUi(Option.some(THREAD_ID)),
      Option.none()
    ),
    [
      {
        requestId: "req-1",
        text: "keep the budget under $5",
        attachments: [],
        attachmentNames: [],
        skillRefs: [],
      },
    ]
  ).items.at(-1);

  if (item === undefined) {
    throw new Error("the transcript has no pending row");
  }

  return item;
};

const nextConfig = (item: ListItem) => ({
  update: (model: null) => ({ model }),
  view: (_model: null, h: HtmlBuilder<Message>): Html =>
    nextRowView(h, item, {
      threadId: THREAD_ID,
      workspaceRoot: Option.none(),
      highlightedLanguages: [],
      highlightedCode: 0,
      copiedRowId: Option.none(),
      expanded: false,
      retryPrompt: Option.none(),
      history: "idle",
      historyCursor: Option.none(),
      subagents: Option.none(),
    }),
});

describe("a brain input row", () => {
  it("is a quiet line naming the subagent row, never the user's bubble or copy button", () => {
    const transcript = transcriptOf(
      THREAD_ID,
      Option.some({
        seq: 0,
        view: brainInputs,
        entriesOffset: 0,
        hasMoreHistory: false,
        older: [],
      }),
      freshUi(Option.some(THREAD_ID)),
      Option.none()
    );

    const [row] = transcript.items;

    if (row === undefined) {
      throw new Error("the transcript has no row");
    }

    Scene.scene(
      nextConfig(row),
      Scene.given(null),
      Scene.expect(Scene.testId("brain-input")).toHaveText(
        /Subagent "Probe the bridge" reported; its result is on its subagent row above\./u
      ),
      Scene.expectAll(Scene.all.testId("user-message")).toHaveCount(0),
      Scene.expectAll(Scene.all.testId("message-copy")).toHaveCount(0),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });
});

describe("a pending row", () => {
  it("draws the queued words in the user's bubble, marked not yet sent, with no copy button", () => {
    Scene.scene(
      nextConfig(pendingRow()),
      Scene.given(null),
      Scene.expect(Scene.selector("[data-user-message-body]")).toHaveText(
        "keep the budget under $5"
      ),
      Scene.expect(Scene.testId("not-sent")).toHaveText("Not sent yet"),
      Scene.expectAll(Scene.all.testId("pending-message")).toHaveCount(1),
      Scene.expectAll(Scene.all.testId("user-message")).toHaveCount(0),
      Scene.expectAll(Scene.all.testId("message-copy")).toHaveCount(0),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });
});

describe("the user message row", () => {
  it("shows the typed words and one chip for one photo", () => {
    Scene.scene(
      config(userRow(photoTurn)),
      Scene.given(null),
      Scene.expectAll(Scene.all.testId("user-message-chip")).toHaveCount(1),
      Scene.expect(Scene.testId("user-message-chip")).toHaveText(
        "IMG_0606.jpg"
      ),
      Scene.expect(Scene.selector("[data-user-message-body]")).toHaveText(
        "what word does this show?"
      ),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });
});
