// The request card's state (plan wave 6, 6A and 6B; surfaces note S3 and W1; briefs note section
// 4): the open thread's `cairn.approvals` document as its stream holds it, and what the user has
// started on the card: a question's drafts and the question they are on, a Decline's reason, a
// Send back's notes, an answer waiting out its undo window, an answer in flight, what a brief's
// roles resolve to now, and a request that closed under them because it was answered somewhere
// else. The document comes from the thread page's view, never from the card.
//
// This module and `Message.ts` sit in the entry, since the root Model holds the card; the card's
// update and view come with the `next` chunk (`Update.ts`, `View.ts`, loaded by `FrameLoad.ts`), so
// the document stays plain JSON here and is decoded there.

import { ApprovalId, ThreadId } from "@cairn/protocol/Ids";
import { RoleCheck } from "@cairn/protocol/Roles";
import { Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import type { ThreadViewModel } from "../../page/thread/Model.ts";

/** One question's draft: client-logic's `DraftAnswer` (`PendingUserInput.ts`) as a schema. */
export const CardDraft = Schema.Struct({
  picks: Schema.Array(Schema.String),
  custom: Schema.String,
});

/** One question's answer as the card sends it: the protocol's `QuestionAnswer`, in plain types. */
export const CardAnswer = Schema.Struct({
  index: Schema.Int,
  picks: Schema.Array(Schema.String),
  custom: Schema.NullOr(Schema.String),
});

export type CardAnswer = typeof CardAnswer.Type;

/** A question card's answers, sent once its undo window ends unless the user takes them back. */
export const PendingSend = Schema.Struct({
  approvalId: ApprovalId,
  answers: Schema.Array(CardAnswer),
  /** The timer generation the window's end belongs to. */
  timer: Schema.Int,
});

export type PendingSend = typeof PendingSend.Type;

/** A request that left the card without this device answering it: how it ended. */
export const ClosedRequest = Schema.Struct({
  approvalId: ApprovalId,
  /** The settled line: "Approved by you", "Declined: not now", "Stopped". */
  text: Schema.String,
  /** What the user had typed on it (own-words answers, a Decline reason), kept for them; may be empty. */
  typed: Schema.String,
});

export type ClosedRequest = typeof ClosedRequest.Type;

/**
 * What `roles.check` said about the roles a brief or a launch names (6B): asked and not answered
 * yet (`generation` tells a stale answer from a fresh one), answered, or not checkable now.
 */
export const RoleCheckState = defineTaggedUnion({
  Checking: { generation: Schema.Int },
  Checked: { checks: Schema.Array(RoleCheck) },
  Unchecked: { message: Schema.String },
});

export type RoleCheckState = typeof RoleCheckState.Type;

/** The card's Model. */
export const Model = Schema.Struct({
  threadId: Schema.Option(ThreadId),
  hasClient: Schema.Boolean,
  /** The thread's `cairn.approvals` document, as plain JSON; null when it has none. */
  approvals: Schema.Json,
  /** Question drafts, by approval id. */
  drafts: Schema.Record(Schema.String, Schema.Record(Schema.String, CardDraft)),
  /** The question each question card is on, by approval id; 0 when absent. */
  questionIndex: Schema.Record(Schema.String, Schema.Int),
  /** A Decline's reason as typed, by approval id. */
  reasons: Schema.Record(Schema.String, Schema.String),
  /** The request whose Decline reason field is open. */
  declining: Schema.Option(ApprovalId),
  /** A Send back's notes as typed, by approval id (6B). */
  notes: Schema.Record(Schema.String, Schema.String),
  /** The brief whose Send back notes field is open (6B). */
  sendingBack: Schema.Option(ApprovalId),
  /** What each shown brief's or launch's roles resolve to now, by approval id (6B). */
  roleChecks: Schema.Record(Schema.String, RoleCheckState),
  /** Bumped by every role check asked, so an answer to an earlier one does nothing. */
  checkGeneration: Schema.Int,
  /** The request whose answer is in flight; the card takes no second answer meanwhile. */
  sending: Schema.Option(ApprovalId),
  /** Requests this device answered, hidden until the stream shows them settled. */
  answered: Schema.Array(ApprovalId),
  /**
   * The decision this device sent, by approval id, so a request another device settled first
   * with another decision closes with that device's line rather than silently.
   */
  sent: Schema.Record(Schema.String, Schema.String),
  undo: Schema.Option(PendingSend),
  /** Bumped by every pick, Undo and Send, so a timer from an earlier one does nothing. */
  timer: Schema.Int,
  /** Why the last answer did not go. */
  failure: Schema.Option(Schema.String),
  /** The request the card showed last, to tell when it closes under the user. */
  shown: Schema.Option(ApprovalId),
  closed: Schema.Option(ClosedRequest),
});

export type Model = typeof Model.Type;

/** No thread open. */
export const initial: Model = {
  threadId: Option.none(),
  hasClient: false,
  approvals: null,
  drafts: {},
  questionIndex: {},
  reasons: {},
  declining: Option.none(),
  notes: {},
  sendingBack: Option.none(),
  roleChecks: {},
  checkGeneration: 0,
  sending: Option.none(),
  answered: [],
  sent: {},
  undo: Option.none(),
  timer: 0,
  failure: Option.none(),
  shown: Option.none(),
  closed: Option.none(),
};

/** What the root tells the card: the open thread, its decision records, and whether a client exists. */
export interface CardContext {
  readonly threadId: Option.Option<ThreadId>;
  /** The thread's `cairn.approvals` document; the same object while it is unchanged. */
  readonly approvals: Schema.Json;
  readonly hasClient: boolean;
}

/** The `cairn.approvals` document of a thread page's view; null when there is none. */
export const approvalsDocumentOf = (
  view: Option.Option<ThreadViewModel>
): Schema.Json =>
  Option.match(view, {
    onNone: () => null,
    onSome: (state) => state.view.docs["cairn.approvals"] ?? null,
  });
