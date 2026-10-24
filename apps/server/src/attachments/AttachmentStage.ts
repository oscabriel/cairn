// The turn-content stage for attachments (it runs after skill expansion): each attachment the turn
// names becomes model content in the order the user attached them, its reference goes on the
// `cairn.user` entry, and the turn claims them so the sweep keeps their files.
//
// - An image is the prepared bytes as `ImageContent`, then a line saying where the original is.
// - Text and documents are one `attachmentText` block naming the file, its type and the path of its
//   full text, with at most 40,000 characters inline (120,000 across the turn) and a line saying
//   where the rest is when it is cut. A PDF with no text layer, or a document whose text could not
//   be read, says so and gives the original's path, so the agent can open it with a tool.
// - XLSX and PPTX files are a line with the path and a note to open them with a tool.
//
// Claims are `INSERT OR IGNORE`, so a send retried with the same request id claims nothing new and
// builds the same content. A check (a launch's, before its thread exists) only looks the
// attachments up: it reads no file and claims nothing. `turn.submitted` is logged by the caller,
// after the submit (`logTurnSubmitted`).
//
// The path line (`attachmentPathLine` in @cairn/protocol, after t3code's
// `providerMessageTextWithAttachmentPaths`) is its own text part, so the transcript can drop it;
// t3code sends documents as the path only, and Cairn sends their text.
import {
  attachmentPathLine,
  attachmentText,
  MAX_INLINE_CHARS_PER_ATTACHMENT,
  MAX_INLINE_CHARS_PER_TURN,
} from "@cairn/protocol/Attachments";
import type { AttachmentRef } from "@cairn/protocol/Attachments";
import type { AttachmentId } from "@cairn/protocol/Ids";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Effect, Option } from "effect";

import { TurnContentError } from "../threads/TurnContent.ts";
import type { TurnContentStage, TurnDraft } from "../threads/TurnContent.ts";
import { AttachmentStore } from "./AttachmentStore.ts";
import type {
  AttachmentStoreError,
  AttachmentVariant,
  StoredAttachment,
} from "./AttachmentStore.ts";

const STAGE = "attachments";

const utf8 = new TextDecoder("utf-8");

/** One attachment's content and how many inline characters it used. */
interface Built {
  readonly content: ReadonlyArray<TextContent | ImageContent>;
  readonly inlineChars: number;
}

const unavailable = (failure: AttachmentStoreError) =>
  new TurnContentError({
    message: `The attachments could not be read: ${failure.message}`,
    stage: STAGE,
    reason: "unavailable",
    field: Option.some("attachments"),
    cause: failure,
  });

const notReady = (what: string) =>
  new TurnContentError({
    message: `${what} Attach the file again, then send.`,
    stage: STAGE,
    reason: "attachment",
    field: Option.some("attachments"),
  });

const text = (value: string): TextContent => ({ type: "text", text: value });

/** The line that tells the agent where an attachment's original is. */
const pathHint = (ref: AttachmentRef, path: string, note: string) =>
  text(
    attachmentPathLine({
      kind: ref.kind === "image" ? "image" : "file",
      name: ref.name,
      mimeType: ref.mimeType,
      sizeBytes: ref.sizeBytes,
      path,
      note,
    })
  );

/**
 * At most `budget` characters of `full`, and the line saying where the rest is when it was cut.
 * `extractionCut` adds that the stored text itself stops early.
 */
export const inlineText = (
  full: string,
  budget: number,
  path: string,
  extractionCut: boolean
) => {
  const shown = full.slice(0, Math.max(0, budget));
  const notes: Array<string> = [];

  if (shown.length < full.length) {
    notes.push(
      shown.length === 0
        ? `[Not shown inline: this turn's attachments already fill ${MAX_INLINE_CHARS_PER_TURN.toLocaleString("en-US")} characters. The full text (${full.length.toLocaleString("en-US")} characters) is at ${path}.]`
        : `[Truncated after ${shown.length.toLocaleString("en-US")} of ${full.length.toLocaleString("en-US")} characters. The full text is at ${path}.]`
    );
  }

  if (extractionCut) {
    notes.push(
      "[The extracted text stops at 500 pages or 2,000,000 characters; the original has more.]"
    );
  }

  return {
    text: notes.length === 0 ? shown : `${shown}\n\n${notes.join("\n")}`,
    inlineChars: shown.length,
  };
};

/** Builds the content of each attachment, keeping the turn's inline budget. */
const buildOne = Effect.fnUntraced(function* (
  store: AttachmentStore["Service"],
  stored: StoredAttachment,
  budget: number
) {
  const { ref } = stored;
  const original = store.path(ref.id, "original");

  const readFile = (variant: AttachmentVariant) =>
    store.read(ref.id, variant).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap(Effect.fromOption),
      Effect.catchTag("NoSuchElementError", () =>
        Effect.fail(notReady(`The ${variant} file of ${ref.name} is missing.`))
      )
    );

  const block = (full: string, path: string, extractionCut: boolean) => {
    const inline = inlineText(
      full,
      Math.min(MAX_INLINE_CHARS_PER_ATTACHMENT, budget),
      path,
      extractionCut
    );

    return {
      content: [
        text(
          attachmentText({
            name: ref.name,
            mimeType: ref.mimeType,
            path,
            text: inline.text,
          })
        ),
      ],
      inlineChars: inline.inlineChars,
    } satisfies Built;
  };

  const note = (message: string): Built => ({
    content: [
      text(
        attachmentText({
          name: ref.name,
          mimeType: ref.mimeType,
          path: original,
          text: message,
        })
      ),
    ],
    inlineChars: 0,
  });

  if (ref.kind === "image") {
    const bytes = yield* readFile("prepared");

    return {
      content: [
        {
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: Option.getOrElse(
            stored.preparedMimeType,
            () => ref.mimeType
          ),
        },
        pathHint(ref, original, ""),
      ],
      inlineChars: 0,
    } satisfies Built;
  }

  if (ref.kind === "text") {
    return block(utf8.decode(yield* readFile("original")), original, false);
  }

  if (ref.kind === "file") {
    return {
      content: [
        pathHint(
          ref,
          original,
          ". Its contents are not shown inline; open it with a tool"
        ),
      ],
      inlineChars: 0,
    } satisfies Built;
  }

  if (Option.isNone(stored.textChars)) {
    return note(
      `[Cairn could not read this document's text. The original is at ${original}; open it with a tool.]`
    );
  }

  if (stored.textChars.value === 0) {
    return note(
      `[This PDF has no text layer (it may be a scan). The original is at ${original}; open it with a tool to read it.]`
    );
  }

  const path = store.path(ref.id, "text");

  return block(
    utf8.decode(yield* readFile("text")),
    path,
    stored.textTruncated
  );
});

/** The stage: attachments as content, their references on the entry, and the turn's claims. */
export const attachmentStage: TurnContentStage<AttachmentStore> = {
  name: STAGE,
  run: Effect.fn("AttachmentStage.run")(function* (draft: TurnDraft) {
    const store = yield* AttachmentStore;
    const ids = draft.input.attachments;

    if (new Set(ids).size !== ids.length) {
      return yield* new TurnContentError({
        message:
          "The turn names the same attachment twice. Remove the duplicate, then send.",
        stage: STAGE,
        reason: "invalid_input",
        field: Option.some("attachments"),
      });
    }

    const found = yield* Effect.forEach(ids, (id: AttachmentId) =>
      store.get(id).pipe(
        Effect.mapError(unavailable),
        Effect.flatMap(Effect.fromOption),
        Effect.catchTag("NoSuchElementError", () =>
          Effect.fail(
            notReady(
              `Attachment ${id} is not on the server: its upload did not finish, or it was discarded.`
            )
          )
        )
      )
    );

    const refs = found.map((stored) => stored.ref);

    if (draft.check) {
      return { ...draft, attachments: [...draft.attachments, ...refs] };
    }

    const content: Array<TextContent | ImageContent> = [];
    let budget = MAX_INLINE_CHARS_PER_TURN;

    for (const stored of found) {
      const built = yield* buildOne(store, stored, budget);

      content.push(...built.content);
      budget -= built.inlineChars;
    }

    yield* store
      .claim(ids, draft.threadId, draft.input.requestId)
      .pipe(Effect.mapError(unavailable));

    return {
      ...draft,
      content: [...draft.content, ...content],
      attachments: [...draft.attachments, ...refs],
    };
  }),
};
