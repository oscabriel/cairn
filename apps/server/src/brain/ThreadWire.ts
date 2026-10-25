// The wire projection of a thread (ADR 0020): what a client sees of pi-durable's conversation view.
//
// - Documents: only those in `VISIBLE_DOCUMENTS` (`pi.agent`, `pi.live`, `pi.inbox`, `pi.usage`,
//   `cairn.approvals`). `pi.provider` carries the Claude session id and stays in the brain.
// - Entries: `pi.system` entries (prompt and tool-set deltas) become a bare `cairn.hidden`
//   placeholder in the same position, so entry indices still line up and the prompt never leaves.
// - Assistant messages lose their `cairn.claude` diagnostics (the bridge's stamp, ADR 0018).
// - Images keep their type and size and lose their bytes; a reference says where to fetch them:
//   the user's attachment when the entry carries one, else the entry image route.
// - Strings over 32 KiB are cut, end with the truncation marker, and the object holding them gets
//   `truncated: true` (t3code's limits). `thread.entry` projects without the cut.
//
// Frames are computed, not translated: each pi-durable revision is projected (entries are
// immutable, so their projections are cached by identity) and diffed against the previous
// projection with chord's `diffRevisions`. A client applying the ops therefore converges on the
// projection of the newest revision by construction, root replacements included, and a slow
// client simply receives one larger diff. `ThreadWindow.ts` projects only the newest entries of a
// long thread the same way (`projectViewJson` with an offset, `entryWireBytes` for its budget).
//
// Ported in part from cairn-v1, apps/server/src/visible.ts at 1a5cd4a (the document whitelist);
// the truncation marker and limits follow t3code's apps/server/src/orchestration-v2/WireProjection.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import {
  ConversationView,
  Entry,
  Op,
  TRUNCATION_MARKER,
  VISIBLE_DOCUMENTS,
  WIRE_STRING_LIMIT_BYTES,
} from "@cairn/protocol/Thread";
import type { JsonValue } from "@earendil-works/chord";
import { isJsonValue } from "@earendil-works/chord";
import { diffRevisions } from "@earendil-works/chord/delta";
import type {
  EntryRecord,
  ConversationView as PiConversationView,
} from "@earendil-works/pi-durable";
import { Option, Predicate, Result, Schema } from "effect";

/** The kind a hidden entry is projected as: its id and position stay, its content does not. */
export const HIDDEN_ENTRY_KIND = "cairn.hidden";

/** Entry kinds that never reach a client. */
const HIDDEN_KINDS: ReadonlySet<string> = new Set(["pi.system"]);

/** Diagnostics that never reach a client: the Claude bridge's stamp. */
const HIDDEN_DIAGNOSTIC = "cairn.claude";

const VISIBLE: ReadonlySet<string> = new Set(VISIBLE_DOCUMENTS);

/** A JSON object as chord and pi-durable hold it. */
export interface JsonRecord {
  [key: string]: JsonValue;
}

/** The projection met a value that is not JSON or not a conversation view. */
export class ThreadWireError extends Schema.TaggedError<ThreadWireError>()(
  "ThreadWireError",
  {
    message: Schema.String,
  }
) {}

/** How strings are cut: the stream cuts at 32 KiB, `thread.entry` keeps them whole. */
export type ProjectionMode = "stream" | "full";

/** Where a projected image's bytes are fetched. */
const AttachmentImageRef = Schema.TaggedStruct("Attachment", {
  attachmentId: Schema.String,
});

const EntryImageRef = Schema.TaggedStruct("EntryImage", {
  entryId: Schema.Finite,
  index: Schema.Finite,
});

interface Walk {
  readonly mode: ProjectionMode;
  /** The reference for the `index`th image met in this value. */
  readonly imageRef: (index: number) => Option.Option<JsonRecord>;
  images: number;
}

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const MARKER_BYTES = encoder.encode(TRUNCATION_MARKER).length;

/** `text` cut to the wire limit with the marker, or none when it fits. */
const cut = (text: string): Option.Option<string> => {
  // A UTF-16 code unit is at most three UTF-8 bytes, so short strings need no measuring.
  if (text.length * 3 <= WIRE_STRING_LIMIT_BYTES) {
    return Option.none();
  }

  const bytes = encoder.encode(text);

  if (bytes.length <= WIRE_STRING_LIMIT_BYTES) {
    return Option.none();
  }

  const kept = decoder
    .decode(bytes.subarray(0, WIRE_STRING_LIMIT_BYTES - MARKER_BYTES))
    .replace(/�$/u, "");

  return Option.some(`${kept}${TRUNCATION_MARKER}`);
};

const isRecord = (value: JsonValue): value is JsonRecord =>
  Predicate.isObject(value) && !Array.isArray(value);

/** Decoded size of base64 `data`. */
const base64Bytes = (data: string) => {
  let padding = 0;

  if (data.endsWith("==")) {
    padding = 2;
  } else if (data.endsWith("=")) {
    padding = 1;
  }

  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
};

const projectImage = (value: JsonRecord, data: string, walk: Walk) => {
  const index = walk.images;

  walk.images += 1;

  const { mimeType } = value;

  const image: JsonRecord = {
    type: "image",
    mimeType: Predicate.isString(mimeType)
      ? mimeType
      : "application/octet-stream",
    bytes: base64Bytes(data),
  };

  const ref = walk.imageRef(index);

  if (Option.isSome(ref)) {
    image.ref = ref.value;
  }

  return image;
};

const isStamp = (item: JsonValue) =>
  isRecord(item) && item.type === HIDDEN_DIAGNOSTIC;

/** Projects any JSON value. Returns the same object when nothing in it changed. */
const projectValue = (value: JsonValue, walk: Walk): JsonValue => {
  if (Array.isArray(value)) {
    let changed = false;

    const next = value.map((item) => {
      const projected = projectValue(item, walk);

      changed ||= projected !== item;

      return projected;
    });

    return changed ? next : value;
  }

  if (!isRecord(value)) {
    return value;
  }

  const { data, type } = value;

  if (type === "image" && Predicate.isString(data)) {
    return projectImage(value, data, walk);
  }

  let changed = false;
  let truncated = false;
  const next: JsonRecord = {};

  for (const [key, field] of Object.entries(value)) {
    if (key === "diagnostics" && Array.isArray(field) && field.some(isStamp)) {
      const kept = field.filter((item) => !isStamp(item));

      changed = true;

      if (kept.length > 0) {
        next[key] = kept;
      }

      continue;
    }

    const shortened =
      Predicate.isString(field) && walk.mode === "stream"
        ? cut(field)
        : Option.none<string>();

    if (Option.isSome(shortened)) {
      changed = true;
      truncated = true;
      next[key] = shortened.value;

      continue;
    }

    const projected = projectValue(field, walk);

    changed ||= projected !== field;
    next[key] = projected;
  }

  if (truncated) {
    next.truncated = true;
  }

  return changed ? next : value;
};

/** The ids of an entry's image attachments (`data.attachments`), in order. */
const imageAttachments = (data: JsonValue | undefined) => {
  if (data === undefined || !isRecord(data)) {
    return [];
  }

  const { attachments } = data;

  if (!Array.isArray(attachments)) {
    return [];
  }

  const ids: Array<string> = [];

  for (const attachment of attachments) {
    if (isRecord(attachment)) {
      const { id, mimeType } = attachment;

      if (
        Predicate.isString(id) &&
        Predicate.isString(mimeType) &&
        mimeType.startsWith("image/")
      ) {
        ids.push(id);
      }
    }
  }

  return ids;
};

const attachmentRef = (ids: ReadonlyArray<string>, index: number) =>
  Option.map(Option.fromUndefinedOr(ids[index]), (attachmentId) =>
    AttachmentImageRef.make({ attachmentId })
  );

/** An entry as JSON, or a placeholder when pi-durable handed over something that is not JSON. */
const entryJson = (entry: EntryRecord): JsonValue =>
  isJsonValue(entry)
    ? entry
    : {
        id: entry.id,
        conversationId: entry.conversationId,
        kind: HIDDEN_ENTRY_KIND,
      };

/** An image inside an entry: its media type and its base64 bytes. */
export interface EntryImage {
  readonly mimeType: string;
  readonly data: string;
}

/** Collects images in the order `projectValue` meets them, skipping what it drops unwalked. */
const collectImages = (value: JsonValue, images: Array<EntryImage>) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectImages(item, images);
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const { data, mimeType, type } = value;

  if (type === "image" && Predicate.isString(data)) {
    images.push({
      mimeType: Predicate.isString(mimeType)
        ? mimeType
        : "application/octet-stream",
      data,
    });

    return;
  }

  for (const [key, field] of Object.entries(value)) {
    if (
      !(key === "diagnostics" && Array.isArray(field) && field.some(isStamp))
    ) {
      collectImages(field, images);
    }
  }
};

/**
 * An entry's images, numbered as the projection numbers its `EntryImage` refs: every image part
 * anywhere in the entry (its model messages, a tool's `data.details`), in the order the walk meets
 * them. The entry image route serves `entryImages(entry)[index]` (T24).
 */
export const entryImages = (entry: EntryRecord): ReadonlyArray<EntryImage> => {
  if (HIDDEN_KINDS.has(entry.kind)) {
    return [];
  }

  const images: Array<EntryImage> = [];

  collectImages(entryJson(entry), images);

  return images;
};

const projectEntryJson = (entry: EntryRecord, mode: ProjectionMode) => {
  if (HIDDEN_KINDS.has(entry.kind)) {
    return {
      id: entry.id,
      conversationId: entry.conversationId,
      kind: HIDDEN_ENTRY_KIND,
    };
  }

  const attachments = imageAttachments(entry.data);

  return projectValue(entryJson(entry), {
    mode,
    images: 0,
    imageRef: (index) =>
      Option.orElse(attachmentRef(attachments, index), () =>
        Option.some(EntryImageRef.make({ entryId: entry.id, index }))
      ),
  });
};

/** Stream projections of entries, by identity: pi-durable never changes an entry it published. */
const streamCache = new WeakMap<EntryRecord, JsonValue>();

const projectEntryCached = (entry: EntryRecord) => {
  const cached = streamCache.get(entry);

  if (cached !== undefined) {
    return cached;
  }

  const projected = projectEntryJson(entry, "stream");

  streamCache.set(entry, projected);

  return projected;
};

/** `pi.inbox`: each queued item's images point at the attachments its entry will carry. */
const projectInbox = (doc: JsonRecord): JsonValue => {
  const { items } = doc;

  if (!Array.isArray(items)) {
    return projectValue(doc, {
      mode: "stream",
      images: 0,
      imageRef: () => Option.none(),
    });
  }

  const projected = items.map((item) => {
    if (!isRecord(item)) {
      return item;
    }

    const { entry } = item;

    const attachments = imageAttachments(
      entry !== undefined && isRecord(entry) ? entry.data : undefined
    );

    return projectValue(item, {
      mode: "stream",
      images: 0,
      imageRef: (index) => attachmentRef(attachments, index),
    });
  });

  return { ...doc, items: projected };
};

/** The client-visible documents of a view, projected. */
const projectDocs = (docs: PiConversationView["docs"]) => {
  const visible: JsonRecord = {};

  for (const [kind, doc] of Object.entries(docs)) {
    if (VISIBLE.has(kind)) {
      visible[kind] =
        kind === "pi.inbox"
          ? projectInbox(doc)
          : projectValue(doc, {
              mode: "stream",
              images: 0,
              imageRef: () => Option.none(),
            });
    }
  }

  return visible;
};

const projectConversation = (record: PiConversationView["conversation"]) => {
  const conversation: JsonRecord = { id: record.id };

  if (record.parent !== undefined) {
    conversation.parent = {
      conversationId: record.parent.conversationId,
      at: record.parent.at,
    };
  }

  if (record.owner !== undefined) {
    conversation.owner = {
      conversationId: record.owner.conversationId,
      taskId: record.owner.taskId,
    };
  }

  return conversation;
};

/**
 * The projected view as plain JSON, the tree ops address. With `offset`, only the active entries
 * from that index on (a window, `ThreadWindow.ts`); the documents are always whole.
 */
export const projectViewJson = (
  view: PiConversationView,
  offset = 0
): JsonRecord => ({
  conversation: projectConversation(view.conversation),
  entries: (offset === 0 ? view.entries : view.entries.slice(offset)).map(
    projectEntryCached
  ),
  docs: projectDocs(view.docs),
});

/** Encoded sizes of stream projections, by identity like the projections themselves. */
const sizeCache = new WeakMap<EntryRecord, number>();

/** The bytes of an entry's stream projection as JSON, which the window budgets. */
export const entryWireBytes = (entry: EntryRecord): number => {
  const cached = sizeCache.get(entry);

  if (cached !== undefined) {
    return cached;
  }

  const size = encoder.encode(JSON.stringify(projectEntryCached(entry))).length;

  sizeCache.set(entry, size);

  return size;
};

const decodeView = Schema.decodeUnknownResult(ConversationView);

const decodeEntry = Schema.decodeUnknownResult(Entry);

const decodeOps = Schema.decodeUnknownResult(Schema.Array(Op));

const wireError = (what: string) => (cause: Schema.SchemaError) =>
  new ThreadWireError({
    message: `The thread projection built ${what} the protocol refuses: ${cause.message}`,
  });

/** A projected JSON view checked against the protocol's `ConversationView`. */
export const decodeProjectedView = (
  json: JsonRecord
): Result.Result<ConversationView, ThreadWireError> =>
  Result.mapError(decodeView(json), wireError("a view"));

/** Chord ops between two projected JSON views, checked against the protocol's `Op`. */
export const diffProjected = (
  previous: JsonRecord,
  next: JsonRecord
): Result.Result<ReadonlyArray<Op>, ThreadWireError> =>
  Result.mapError(decodeOps(diffRevisions(previous, next)), wireError("ops"));

/** The projected view of a pi-durable conversation view. */
export const projectView = (
  view: PiConversationView
): Result.Result<ConversationView, ThreadWireError> =>
  Result.mapError(decodeView(projectViewJson(view)), wireError("a view"));

/** One entry projected; `full` keeps strings whole (for `thread.entry`). */
export const projectEntry = (
  entry: EntryRecord,
  mode: ProjectionMode
): Result.Result<Entry, ThreadWireError> =>
  Result.mapError(
    decodeEntry(
      mode === "stream"
        ? projectEntryCached(entry)
        : projectEntryJson(entry, mode)
    ),
    wireError("an entry")
  );

/**
 * Projects successive revisions of one conversation view: the first is a snapshot, each later one
 * becomes the ops that turn the previous projection into its projection.
 */
export interface WireProjector {
  snapshot(
    view: PiConversationView
  ): Result.Result<ConversationView, ThreadWireError>;
  /** Ops from the last projection to this revision's; empty when the projection did not change. */
  advance(
    view: PiConversationView
  ): Result.Result<ReadonlyArray<Op>, ThreadWireError>;
}

/** A projector for one subscription. */
export const wireProjector = (): WireProjector => {
  let previous: JsonRecord = {};

  return {
    snapshot: (view) => {
      previous = projectViewJson(view);

      return decodeProjectedView(previous);
    },
    advance: (view) => {
      const next = projectViewJson(view);
      const ops = diffProjected(previous, next);

      previous = next;

      return ops;
    },
  };
};
