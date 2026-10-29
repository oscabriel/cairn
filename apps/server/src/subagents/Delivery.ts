// The pieces of subagent delivery that run inside one pi-durable transaction (ADR 0028): whether a
// parent is halted (the wake rule), the child's thread id, a settlement as the reporter's
// checkpoint keeps it and a registry status change. The escalation that turns a child's question
// to the user is the question route's (approvals/QuestionRoute.ts). None of them awaits anything
// outside the transaction, and the table reads are named, so a caller can make them before its
// first table write.

import { createHash } from "node:crypto";

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
import { DEFAULT_RESTART_LIMIT } from "@earendil-works/pi-durable";
import { Option } from "effect";

import { RUN_TASK } from "../brain/CommitFeed.ts";
import { piConversationId, piTaskId } from "../brain/PiIds.ts";
import { EscalationWhy } from "../brain/SubagentText.ts";
import type { SubagentItemState, SubagentsState } from "./SubagentDocs.ts";

/** A stored conversation id as pi-durable types it. */
export const conversationOf = (id: number): PiConversationId =>
  piConversationId(ConversationId.make(id));

/** A stored task id as pi-durable types it. */
export const taskOf = (id: number) => piTaskId(TaskId.make(id));

/**
 * Why a parent cannot take a child's result or question now (table reads): its newest run ended by
 * a stop or a failure, or the crash-loop guard parked it (cut off `DEFAULT_RESTART_LIMIT` times in
 * a row), and no input started another since. None while it runs or idles after a completed run.
 * Nothing restarts a thread the user stopped and a parked run waits for a retry, so a halted
 * parent is not woken and its child's questions go to the user (ADR 0027, ADR 0028).
 */
export const parentHalt = async (
  tx: Tx,
  conversationId: PiConversationId
): Promise<Option.Option<string>> => {
  const page = await tx.scanTasks(
    { conversationId, kind: RUN_TASK, order: "descending" },
    1
  );

  const [last] = page.items;

  if (last === undefined) {
    return Option.none();
  }

  if (last.state.status === "terminal") {
    return last.state.outcome.status === "completed"
      ? Option.none()
      : Option.some(EscalationWhy.parentStopped);
  }

  return last.state.status !== "completing" &&
    !last.abortRequested &&
    (last.restarts ?? 0) >= DEFAULT_RESTART_LIMIT
    ? Option.some(EscalationWhy.parentParked)
    : Option.none();
};

/** Whether a parent is halted (`parentHalt`): the wake rule's read. */
export const parentHalted = async (
  tx: Tx,
  conversationId: PiConversationId
): Promise<boolean> => Option.isSome(await parentHalt(tx, conversationId));

const hex = (value: number, width: number) =>
  value.toString(16).padStart(width, "0").slice(-width);

/**
 * A child's thread id: a UUIDv7 from the moment its brief was answered (`at`) and a hash of the
 * parent's conversation and the brief's approval id, which no other brief in the store has. It is
 * the same on every attempt, so the brief task mints it before its workspace and its creating
 * commit: a rerun after a crash prepares the same worktree and creates the same thread.
 */
export const childThreadIdOf = (
  at: number,
  parent: PiConversationId,
  approvalId: string
): ThreadId => {
  const time = hex(at, 12);

  const tail = createHash("sha256")
    .update(`${parent}:${approvalId}`)
    .digest("hex")
    .slice(0, 18);

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
