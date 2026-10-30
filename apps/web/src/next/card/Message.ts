// The request card's Messages.

import { ApprovalId } from "@cairn/protocol/Ids";
import { RoleCheck } from "@cairn/protocol/Roles";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

/** The answers a click on an approval or a brief gives; `accept_sample` is Run on 1 first. */
export const Decision = Schema.Literals([
  "accept",
  "accept_for_thread",
  "accept_sample",
]);

export type Decision = typeof Decision.Type;

/** Everything the request card reacts to. */
export const Message = defineMessageUnion({
  /** An option of question `index` was picked, by a click, a tap or its digit. */
  PickedOption: {
    approvalId: ApprovalId,
    index: Schema.Int,
    label: Schema.String,
  },
  /** The question's own-words field changed. */
  ChangedCustom: {
    approvalId: ApprovalId,
    index: Schema.Int,
    value: Schema.String,
  },
  /** The pause after a single pick ended; it advances if the card is still where it was. */
  ElapsedAdvance: {
    approvalId: ApprovalId,
    index: Schema.Int,
    timer: Schema.Int,
  },
  ClickedNext: { approvalId: ApprovalId },
  ClickedBack: { approvalId: ApprovalId },
  /** Send the question card's answers, after the undo window. */
  ClickedSend: { approvalId: ApprovalId },
  ClickedUndo: {},
  ElapsedUndo: { approvalId: ApprovalId, timer: Schema.Int },
  /** Approve, Allow for this thread, Go, or Run on 1 first. */
  ClickedAccept: { approvalId: ApprovalId, decision: Decision },
  /** Opens the Decline reason field. */
  ClickedDecline: { approvalId: ApprovalId },
  ChangedReason: { approvalId: ApprovalId, value: Schema.String },
  ClickedCancelDecline: {},
  /** Decline, with the reason typed (none when blank). */
  ClickedConfirmDecline: { approvalId: ApprovalId },
  /** Opens a brief's Send back notes field. */
  ClickedSendBack: { approvalId: ApprovalId },
  ChangedNotes: { approvalId: ApprovalId, value: Schema.String },
  ClickedCancelSendBack: {},
  /** Send back, with the notes typed (required: the parent writes a new brief from them). */
  ClickedConfirmSendBack: { approvalId: ApprovalId },
  /** Asks `roles.check` again about a brief's or a launch's roles. */
  ClickedCheckRoles: { approvalId: ApprovalId },
  ReceivedRoleChecks: {
    approvalId: ApprovalId,
    generation: Schema.Int,
    checks: Schema.Array(RoleCheck),
  },
  FailedRoleChecks: {
    approvalId: ApprovalId,
    generation: Schema.Int,
    message: Schema.String,
  },
  SucceededRespond: { approvalId: ApprovalId },
  FailedRespond: { approvalId: ApprovalId, message: Schema.String },
  DismissedClosed: {},
});

/** A request card Message. */
export type Message = typeof Message.Type;
