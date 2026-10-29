// How a note (a write the model reads) enters a conversation without starting a run (ADR 0028).
// pi-durable's own admission treats a model write on an idle conversation with queued inputs as a
// boundary: it would place them and start a run, so a parent the user stopped with a follow-up or
// a wake still queued would restart on a child's note. A note is admitted here instead, inside the
// caller's transaction:
//
// - idle: the writes a stopped or failed run left queued are placed first, in order, then the note
//   is appended with a `done` write submission; queued inputs stay queued;
// - running: a queued write submission and a `pi.inbox` write item, which the next boundary places
//   ahead of queued inputs.
//
// The request id makes a note land once. `PiDurableHarness.write` admits a seam note through this,
// and the subagents extension its notes (a settlement, a brief's answer) inside its own commits.
// It copies pi-durable 1.4.0's inbox shapes (`LiveDoc`, `InboxDoc`, `harness/inbox.js`
// `applyBoundary`'s write half); recheck it on any pi-durable upgrade past 1.4.0.

import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
  EntryDraft,
  EntryId,
  InboxState,
  JsonObject,
  SubmissionRecord,
  Tx,
} from "@earendil-works/pi-durable";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { Predicate } from "effect";

/**
 * A queued write's entry: pi-durable admits it as an `EntryDraft` and stores it as plain JSON
 * (harness/inbox.d.ts, `InboxItem`), so its kind is the one field to check.
 */
const isEntryDraft = (entry: JsonObject): entry is JsonObject & EntryDraft =>
  Predicate.isString(entry.kind);

/**
 * Places every write still queued in an idle conversation's `pi.inbox`, in order, as the write half
 * of pi-durable's boundary does (harness/inbox.js, `applyBoundary`): each is appended and its
 * submission placed, and a head write that reaches before the active range settles `stale`. Queued
 * inputs stay. `head` is the conversation's latest head marker, read before the commit's first table
 * write. A stop, a failed run and pi-durable's abort keep writes queued, so a note written during
 * a run that never reached its boundary is placed here (ADR 0028).
 */
export const placeQueuedWrites = async (
  tx: Tx,
  conversationId: ConversationId,
  inbox: InboxState,
  head: EntryId | undefined
): Promise<void> => {
  let active = head;
  const placed: Array<number> = [];

  for (const [index, item] of inbox.items.entries()) {
    if (item.mode !== "write" || !isEntryDraft(item.entry)) {
      continue;
    }

    placed.push(index);

    const draft = item.entry;
    const target = draft.head;

    if (Predicate.isNumber(target) && active !== undefined && target < active) {
      tx.settleSubmission(item.id, { status: "unanswered", reason: "stale" });
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- writes land in the order they were queued
    const entry = await tx.appendEntry(conversationId, draft);

    if (target !== undefined) {
      active = target === "self" ? entry.id : target;
    }

    tx.placeSubmission(item.id, entry.id);
  }

  for (const index of placed.toReversed()) {
    inbox.items.splice(index, 1);
  }
};

/** A note's entry: its kind and data for the client, and the text the model reads as a user turn. */
export interface NoteDraft {
  readonly kind: string;
  readonly data: JsonValue;
  readonly text: string;
  /** The Harness clock, for the user message's timestamp. */
  readonly at: number;
}

/** The entry draft a note is appended as. */
export const noteEntry = (note: NoteDraft) => ({
  kind: note.kind,
  data: note.data,
  model: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: note.text }],
      timestamp: note.at,
    },
  ],
});

/** A note's entry draft, as `noteEntry` builds it. */
export type NoteEntry = ReturnType<typeof noteEntry>;

/**
 * A display-only entry (a notice): kind and data, nothing the model reads. pi-durable appends one
 * at once even mid-run (harness/inbox.js `isDisplayOnly`), unless a reset is queued.
 */
export interface DisplayEntry {
  [key: string]: JsonValue;
  kind: string;
  data: JsonValue;
}

/** Whether a reset (a `head: "self"` write) is queued, as pi-durable's `hasQueuedReset` reads it. */
export const hasQueuedReset = (inbox: InboxState): boolean =>
  inbox.items.some(
    (item) => item.mode === "write" && item.entry.head === "self"
  );

/**
 * The table reads one note's admission needs, read before the transaction's first table write
 * (pi-durable refuses a table read after one): the submission an earlier admission of the same
 * request id left, and the conversation's head marker.
 */
export interface NoteReads {
  readonly existing: SubmissionRecord | undefined;
  readonly head: EntryId | undefined;
}

/** Reads what `applyNote` needs; call it before any table write of the transaction. */
export const readNote = async (
  tx: Tx,
  conversationId: ConversationId,
  requestId: string
): Promise<NoteReads> => {
  const existing = await tx.submissionByRequest(conversationId, requestId);
  const marker = await tx.latestHeadMarker(conversationId);

  return { existing, head: marker?.head };
};

/**
 * Admits a note under `requestId` with the reads `readNote` made (module header). A request id
 * already admitted changes nothing, so a rerun lands once. Never starts a run.
 */
export const applyNote = async (
  tx: Tx,
  conversationId: ConversationId,
  requestId: string,
  reads: NoteReads,
  draft: NoteEntry | DisplayEntry
): Promise<void> => {
  if (reads.existing !== undefined) {
    return;
  }

  const live = await tx.doc(LiveDoc, conversationId);
  const inbox = await tx.doc(InboxDoc, conversationId);

  if (live.run === undefined) {
    await placeQueuedWrites(tx, conversationId, inbox, reads.head);

    const appended = await tx.appendEntry(conversationId, draft);

    await tx.createSubmission({
      conversationId,
      requestId,
      type: "write",
      status: "done",
      entry: appended.id,
    });

    return;
  }

  const queued = await tx.createSubmission({
    conversationId,
    requestId,
    type: "write",
    status: "queued",
  });

  inbox.items.push({ id: queued.id, mode: "write", entry: draft });
};

/** `readNote` then `applyNote`, for a transaction that makes no other table read. */
export const admitNote = async (
  tx: Tx,
  conversationId: ConversationId,
  requestId: string,
  draft: NoteEntry
): Promise<void> => {
  await applyNote(
    tx,
    conversationId,
    requestId,
    await readNote(tx, conversationId, requestId),
    draft
  );
};
