// The pieces of subagent delivery that run inside one pi-durable transaction (ADR 0028, ADR 0027):
// whether a parent is halted (the wake rule), the child's thread id, a settlement as the reporter's
// checkpoint keeps it, a registry status change, and the escalation that turns a child's question
// to the user with a mirror in the parent. None of them awaits anything outside the transaction,
// and the table reads are named, so a caller can make them before its first table write.

import { ConversationId, TaskId, ThreadId } from "@cairn/protocol/Ids";
import type {
  SettlementOutcome,
  SubagentSettlement,
  SubagentStatus,
} from "@cairn/protocol/Subagents";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationId as PiConversationId,
  Tx,
} from "@earendil-works/pi-durable";
import { Option } from "effect";

import { Approvals, copyRecord, ThreadMeta } from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { RUN_TASK } from "../brain/CommitFeed.ts";
import { piConversationId, piTaskId } from "../brain/PiIds.ts";
import { markQuestion } from "./SubagentDocs.ts";
import type { SubagentItemState, SubagentsState } from "./SubagentDocs.ts";

/** A stored conversation id as pi-durable types it. */
export const conversationOf = (id: number): PiConversationId =>
  piConversationId(ConversationId.make(id));

/** A stored task id as pi-durable types it. */
export const taskOf = (id: number) => piTaskId(TaskId.make(id));

/**
 * Whether a parent is halted (table read): its newest run ended by a stop or a failure, and no
 * input started another since. A halted parent gets a child's note but no wake, and its child's
 * questions go to the user, since nothing restarts a thread the user stopped (ADR 0028).
 */
export const parentHalted = async (
  tx: Tx,
  conversationId: PiConversationId
): Promise<boolean> => {
  const page = await tx.scanTasks(
    { conversationId, kind: RUN_TASK, order: "descending" },
    1
  );

  const [last] = page.items;

  return (
    last !== undefined &&
    last.state.status === "terminal" &&
    last.state.outcome.status !== "completed"
  );
};

const hex = (value: number, width: number) =>
  value.toString(16).padStart(width, "0").slice(-width);

/**
 * A child's thread id: a UUIDv7 from the Harness clock and the child's conversation id, which no
 * other conversation in the store has, so it is unique without randomness. Minted inside the
 * commit that creates the child, so only the committed value ever exists.
 */
export const childThreadIdOf = (
  now: number,
  conversationId: PiConversationId
): ThreadId => {
  const time = hex(now, 12);
  const tail = hex(conversationId, 18);

  return ThreadId.make(
    `${time.slice(0, 8)}-${time.slice(8, 12)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18)}`
  );
};

/** A settlement as a reporter's checkpoint and a note's `data` hold it: plain JSON. */
export interface SettlementState {
  [key: string]: JsonValue;
  subagent: string;
  seq: number;
  outcome: SettlementOutcome;
  summary: string;
  divergence: string;
  payload: JsonValue;
  commit: string | null;
  branch: string | null;
  turns: { [key: string]: JsonValue; thisRun: number; total: number };
  error: string | null;
  usageLimit: boolean;
}

/** The protocol's settlement of a stored one. */
export const settlementOf = (state: SettlementState): SubagentSettlement => ({
  subagent: ThreadId.make(state.subagent),
  seq: state.seq,
  outcome: state.outcome,
  summary: state.summary,
  divergence: state.divergence,
  payload: state.payload,
  commit: state.commit,
  branch: state.branch,
  turns: { thisRun: state.turns.thisRun, total: state.turns.total },
  error: state.error,
  usageLimit: state.usageLimit,
});

/** A child's item in its parent's registry, found by the child's thread id. */
export const itemOfChild = (
  registry: Readonly<SubagentsState>,
  childThreadId: string
): SubagentItemState | undefined =>
  Object.values(registry.items).find((item) => item.threadId === childThreadId);

/** Sets a child's registry status; the commit feed turns a change into SubagentUpdated. */
export const setStatus = (item: SubagentItemState, status: SubagentStatus) => {
  if (item.status !== status) {
    item.status = status;
  }
};

/** Where one escalation happens: the child's question and the parent that mirrors it. */
export interface EscalationTarget {
  readonly parentConversationId: PiConversationId;
  readonly childConversationId: PiConversationId;
  readonly approvalId: string;
  /** Why it reached the user: the parent escalated, its run ended, or it is stopped. */
  readonly why: string;
  readonly now: number;
}

/** The id of the mirror a parent keeps of its child's escalated question. */
export const mirrorIdOf = (
  childConversationId: PiConversationId,
  approvalId: string
) => `esc-${childConversationId}-${approvalId}`;

/**
 * Escalates a child's question to the user (ADR 0027), inside the caller's transaction: the
 * child's record turns to the user and a mirror lands in the parent's `cairn.approvals`, so the
 * card shows in the parent thread and an answer to either settles both (`answerApproval`). The one
 * store makes both writes one commit. Returns whether it escalated: a record that is gone, settled
 * or already escalated is left as it is. Writes documents only.
 */
export const escalateIn = async (
  tx: Tx,
  target: EscalationTarget
): Promise<boolean> => {
  const { items } = await tx.doc(Approvals, target.childConversationId);
  const record = items[target.approvalId];

  if (
    record === undefined ||
    record.status !== "pending" ||
    record.escalatedAt !== null
  ) {
    return false;
  }

  record.route = "user";
  record.escalatedAt = target.now;

  const meta = await tx.doc(ThreadMeta, target.childConversationId);
  const mirrorId = mirrorIdOf(target.childConversationId, target.approvalId);

  const mirror: ApprovalRecord = {
    ...copyRecord(record),
    id: mirrorId,
    toolTaskId: 0,
    askedAt: target.now,
    escalatedAt: null,
    mirrorOf: { threadId: meta.threadId, approvalId: target.approvalId },
  };

  const parent = await tx.doc(Approvals, target.parentConversationId);

  parent.items[mirrorId] = mirror;

  await markQuestion(
    tx,
    target.parentConversationId,
    target.childConversationId,
    target.approvalId,
    "escalated",
    Option.some(target.now)
  );

  return true;
};
