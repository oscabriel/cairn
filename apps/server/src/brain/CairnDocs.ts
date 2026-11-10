// Cairn's documents and entry kinds inside pi-durable's store. Kinds are protocol: a `cairn.*` name
// never changes, and a shape change is a `version` bump with `migrate`.
//
// - `cairn.thread` (session family keyed by thread id) is the creation receipt: one commit creates
//   the conversation, configures it and records it here, so a raced `ensureThread` lands once.
// - `cairn.thread-meta` (conversation) names the thread and project, so the store describes itself
//   and a lost cairn.sqlite can be re-linked. A fork starts empty: it is another thread.
// - `cairn.permissions` (conversation) holds the thread's permission mode and the tools "Allow for
//   this thread" added (ADR 0031); gated tools read it at call time (Permissions.ts).
// - `cairn.approvals` (conversation) holds decision records, version 2 (ADR 0029): spike 4's
//   shape plus who decided (`decidedBy`), why (`reason`), the `answer` and a `payload` frozen at
//   ask time. Version 1 records migrate on first access. It is a conversation document so the
//   thread's own view carries its approvals.
//
// The approval ledger that writes `cairn.approvals` and `cairn.permissions` records, with its answer
// path and its boot repairs, is `approvals/ApprovalLedger.ts`.

import {
  APPROVALS_DOCUMENT,
  APPROVALS_VERSION,
  ApprovalStatus,
  DEFAULT_RUNTIME_MODE,
  PERMISSIONS_DOCUMENT,
  RuntimeRequestKind,
} from "@cairn/protocol/Policy";
import type {
  ApprovalAnswer,
  ApprovalPayload,
  ApprovalRecord as ApprovalRecordSchema,
  ApprovalsDocument,
  Decider,
  PermissionsDocument,
  RuntimeMode,
} from "@cairn/protocol/Policy";
import type { DocumentState } from "@cairn/protocol/Thread";
import type { JsonValue } from "@earendil-works/chord/json";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import {
  defineDoc,
  defineDocFamily,
  defineEntry,
} from "@earendil-works/pi-durable";
import { Option, Predicate, Schema } from "effect";

import { approvalsFromV2 } from "./RolesRetired.ts";

/** The creation receipt of one thread: the conversation it lives in, 0 until created. */
export interface ThreadReceiptState {
  [key: string]: JsonValue;
  conversationId: number;
}

/** `cairn.thread`: thread id to conversation id, written in the commit that creates it. */
export const ThreadReceipt = defineDocFamily<
  ThreadReceiptState,
  ThreadReceiptState
>({
  kind: "cairn.thread",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({ conversationId: seed.conversationId }),
  // One write per thread, ever.
  checkpointWhen: () => false,
});

/** Which thread and project a conversation is. Empty strings before the creating commit sets them. */
export interface ThreadMetaState {
  [key: string]: JsonValue;
  threadId: string;
  projectId: string;
}

/** `cairn.thread-meta`: the thread a conversation is, so the store describes itself. */
export const ThreadMeta = defineDoc<ThreadMetaState>({
  kind: "cairn.thread-meta",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ threadId: "", projectId: "" }),
  // Written once, in the creating commit.
  checkpointWhen: () => false,
});

/** A JSON object as a document holds it. */
export interface JsonRecord {
  [key: string]: JsonValue;
}

/** A record's payload as the record keeps it: the protocol's `ApprovalPayload`. */
export type ApprovalPayloadState = DocumentState<typeof ApprovalPayload>;

/** What the decider answered: the protocol's `ApprovalAnswer` as its writer holds it. */
export type ApprovalAnswerState = DocumentState<typeof ApprovalAnswer>;

/**
 * One decision record (ADR 0013, ADR 0029): a gated tool call, a question, a brief or proposed
 * criteria, and who decided it and why; the protocol's `ApprovalRecord` as its writer holds it.
 * `payload` never changes after the ask; `status` leaves `pending` once, and every status past
 * `pending` has `decidedBy` set.
 */
export type ApprovalRecord = DocumentState<typeof ApprovalRecordSchema>;

/** `cairn.approvals` document state: the protocol's `ApprovalsDocument`. */
export type ApprovalsState = DocumentState<typeof ApprovalsDocument>;

const isJsonRecord = (value: JsonValue | undefined): value is JsonRecord =>
  Predicate.isObject(value) && !Array.isArray(value);

/** A record as version 1 of `cairn.approvals` stored it. */
const ApprovalRecordV1 = Schema.Struct({
  id: Schema.String,
  toolTaskId: Schema.Finite,
  tool: Schema.String,
  kind: RuntimeRequestKind,
  summary: Schema.String,
  status: ApprovalStatus,
  askedAt: Schema.Finite,
  expiresAt: Schema.Finite,
  answeredAt: Schema.NullOr(Schema.Finite),
  run: Schema.NullOr(Schema.Literals(["started", "done"])),
  executorRequestId: Schema.NullOr(Schema.String),
});

type ApprovalRecordV1 = typeof ApprovalRecordV1.Type;

const decodeRecordV1 = Schema.decodeUnknownOption(ApprovalRecordV1);

/**
 * Who decided a version 1 record, read from what it kept. Phase 1 wrote `accepted` at ask time
 * only for full access, with `answeredAt` equal to `askedAt`; the user's answers and the expiry
 * came later. No phase 1 brain wrote `cancelled`, so one comes from a scripted store's stop.
 */
const v1Decider = (record: ApprovalRecordV1): Decider | null => {
  const deciders: Record<ApprovalStatus, Decider | null> = {
    pending: null,
    accepted:
      record.answeredAt === record.askedAt
        ? { kind: "mode", mode: "full-access" }
        : { kind: "user" },
    declined: { kind: "user" },
    revised: { kind: "user" },
    expired: { kind: "expiry" },
    cancelled: { kind: "system", why: "run-stopped" },
  };

  return deciders[record.status];
};

/** The answer a version 1 status implies: accept or decline, with nothing else recorded. */
const v1Answer = (record: ApprovalRecordV1): ApprovalAnswerState | null =>
  record.status === "accepted" || record.status === "declined"
    ? {
        decision: record.status === "accepted" ? "accept" : "decline",
        answers: null,
        note: null,
        launch: null,
      }
    : null;

/** The version 2 fields a version 1 record gains: nothing it never kept. */
const V1_GAINS = {
  payload: null,
  reason: null,
  route: "user",
  escalatedAt: null,
  supersedes: null,
  started: null,
  briefHash: null,
  mirrorOf: null,
} as const satisfies Partial<ApprovalRecord>;

/** A version 1 record as version 2 keeps it: every field kept, the decider read from the status. */
const fromV1 = (record: ApprovalRecordV1): ApprovalRecord => ({
  ...record,
  ...V1_GAINS,
  answer: v1Answer(record),
  decidedBy: v1Decider(record),
});

/** How much of an unreadable record its summary keeps. */
const UNREADABLE_SUMMARY_MAX = 500;

/** The one field an unreadable record may still say: when it was asked. */
const decodeAskedAt = Schema.decodeUnknownOption(
  Schema.Struct({ askedAt: Schema.Finite })
);

/**
 * A stored record no version can read, kept rather than dropped: cancelled at the migration
 * (`decidedBy` system `boot`) with what it kept in `summary`, so nobody can answer it and the loss
 * shows on the card instead of vanishing.
 */
const unreadable = (id: string, raw: JsonValue | undefined): ApprovalRecord => {
  const at = Option.match(decodeAskedAt(raw), {
    onNone: () => 0,
    onSome: (kept) => kept.askedAt,
  });

  return {
    id,
    toolTaskId: 0,
    tool: "unknown",
    kind: "tool-call",
    summary:
      `Unreadable record kept at migration: ${JSON.stringify(raw ?? null)}`.slice(
        0,
        UNREADABLE_SUMMARY_MAX
      ),
    status: "cancelled",
    askedAt: at,
    expiresAt: at,
    answeredAt: at,
    run: null,
    executorRequestId: null,
    ...V1_GAINS,
    answer: null,
    decidedBy: { kind: "system", why: "boot" },
  };
};

/**
 * `cairn.approvals` to version 3, pure as pi-durable's `migrate` must be.
 *
 * Version 1 to 2: every record keeps its fields and gains version 2's: `payload`, `reason` and the
 * brief and question fields are null and `route` is `user`, because version 1 held only tool calls
 * and kept no words; `decidedBy` and `answer` are read from the status, so every status past
 * `pending` names a decider (invariant 8 of `docs/golden/thread-states.md`). A record that is not
 * version 1's shape is kept as cancelled (`unreadable`), never dropped. Such a record held no
 * payload, so it has no role to retire.
 *
 * Version 2 to 3 retires the roles its payloads and answers still hold (ADR 0052, `RolesRetired.ts`).
 *
 * A version this code does not know throws: a later version adds its own case here, so nothing is
 * lost by a migration that skipped it.
 */
export const migrateApprovals = (
  value: JsonRecord,
  fromVersion: number
): ApprovalsState => {
  if (fromVersion === 2) {
    return approvalsFromV2(value);
  }

  if (fromVersion !== 1) {
    throw new Error(
      `cairn.approvals has no migration from version ${fromVersion} to ${APPROVALS_VERSION}`
    );
  }

  const items: ApprovalsState["items"] = {};
  const stored = isJsonRecord(value.items) ? value.items : {};

  for (const [id, raw] of Object.entries(stored)) {
    items[id] = Option.match(decodeRecordV1(raw), {
      onNone: () => unreadable(id, raw),
      onSome: fromV1,
    });
  }

  return { items };
};

/** `cairn.approvals`: every decision record of one conversation, by id (ADR 0029). */
export const Approvals = defineDoc<ApprovalsState>({
  kind: APPROVALS_DOCUMENT,
  version: APPROVALS_VERSION,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
  migrate: migrateApprovals,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** `cairn.permissions` state: the protocol's `PermissionsDocument`. */
export type PermissionsState = DocumentState<typeof PermissionsDocument>;

/** `cairn.permissions`: the mode gated tools read at call time (ADR 0031). */
export const Permissions = defineDoc<PermissionsState>({
  kind: PERMISSIONS_DOCUMENT,
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork is another thread, which starts in the default mode.
  fork: "initial",
  initial: () => ({ mode: DEFAULT_RUNTIME_MODE, allow: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

/** Writes the thread's mode into its permissions, inside the caller's transaction. */
export const writeMode = async (
  tx: Tx,
  conversationId: ConversationId,
  mode: RuntimeMode
): Promise<void> => {
  const doc = await tx.doc(Permissions, conversationId);

  if (doc.mode !== mode) {
    doc.mode = mode;
  }
};

/** Adds `tool` to the thread's "Allow for this thread" list, inside the caller's transaction. */
export const allowTool = async (
  tx: Tx,
  conversationId: ConversationId,
  tool: string
): Promise<void> => {
  const doc = await tx.doc(Permissions, conversationId);

  if (!doc.allow.includes(tool)) {
    doc.allow.push(tool);
  }
};

/** Data of a `cairn.user` entry: who sent it, and the attachments it carries. */
export type CairnUserData = Readonly<{
  from: string;
  attachments: Array<{ [key: string]: JsonValue }>;
}>;

/** A user input recorded with its sender and attachments; the model still sees its content. */
export const CairnUserEntry = defineEntry<CairnUserData>("cairn.user");

/** A display-only marker where a checkpoint was captured, for the turn's diff. */
export const CairnCheckpointEntry = defineEntry<{
  ref: string;
  turn: number;
}>("cairn.checkpoint");
