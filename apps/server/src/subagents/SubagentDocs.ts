// The subagents' documents inside pi-durable's store (ADR 0028), as plain JSON (S23): the parent's
// `cairn.subagents` registry and the child's `cairn.child` link. Their shapes are the protocol's
// `SubagentsDocument` and `ChildDocument` (packages/protocol/src/Subagents.ts); kinds are protocol
// and never change. Both start empty in a fork, which is another thread.
//
// - `cairn.subagents` (on the parent) holds one item per child, keyed by the brief's approval id,
//   written by the commit that starts the child and changed by its reporters and its questions.
// - `cairn.child` (on the child) is written in the commit that creates it: the child's tools find
//   their parent here, the permission gate narrows the child's mode by walking it, and the result
//   tool reads the brief's schema from it.

import { DEFAULT_RUNTIME_MODE } from "@cairn/protocol/Policy";
import type { RuntimeMode, WakeMode } from "@cairn/protocol/Policy";
import { CHILD_DOCUMENT, SUBAGENTS_DOCUMENT } from "@cairn/protocol/Subagents";
import type {
  SettlementOutcome,
  SubagentQuestionState,
  SubagentStatus,
} from "@cairn/protocol/Subagents";
import type { JsonValue } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import { Option, Predicate } from "effect";
import type { Schema } from "effect";

/** A JSON object as a document holds it. */
export interface JsonRecord {
  [key: string]: JsonValue;
}

/** One delivered settlement, as the registry keeps it: the answer is an entry id, never its text. */
export interface SettlementMarkState {
  [key: string]: JsonValue;
  seq: number;
  outcome: SettlementOutcome;
  answerEntry: number | null;
  reportedAt: number;
  /** The request ids of every input the settled run answered or ended. */
  inputs: Array<string>;
}

/**
 * One child run nudged or settled: the protocol's `RunMark` as plain JSON. `run` is the run's
 * identity: its answer entry, or for a run that ended unanswered the entry of its first input, read
 * from the committed transcript.
 */
export type RunMarkState =
  | {
      [key: string]: JsonValue;
      run: string;
      phase: "nudge";
      seq: number;
      /** The request ids of every input the nudged run ended. */
      inputs: Array<string>;
      /** Whether every one of them was a user's own steer: the run's settlement wakes no one. */
      quiet: boolean;
    }
  | {
      [key: string]: JsonValue;
      run: string;
      phase: "settled";
      /** Its settlement's, whose `inputs` are the run's. */
      seq: number;
    };

/** The inputs a run mark names: a nudge mark's own, a settled mark's settlement's. */
export const markInputs = (
  item: SubagentItemState,
  mark: RunMarkState
): ReadonlyArray<string> =>
  mark.phase === "nudge"
    ? mark.inputs
    : (item.settlements.find((settled) => settled.seq === mark.seq)?.inputs ??
      []);

/** Where a child's question stands, from the parent's side. */
export interface QuestionMarkState {
  [key: string]: JsonValue;
  state: SubagentQuestionState;
  escalatedAt: number | null;
}

/** One child in its parent's registry: the protocol's `SubagentRecord` as plain JSON. */
export interface SubagentItemState {
  [key: string]: JsonValue;
  threadId: string;
  conversationId: number;
  anchorTaskId: number;
  briefApprovalId: string;
  description: string;
  /** The protocol's `DispatchRecord`. */
  dispatch: JsonRecord;
  isolation: "worktree" | "shared";
  worktree: JsonRecord | null;
  status: SubagentStatus;
  wake: WakeMode;
  settlements: Array<SettlementMarkState>;
  /** Every child run nudged or settled, so a run settles once whichever reporter gets there first. */
  runs: Array<RunMarkState>;
  /** The last settlement whose note (and wake, when due) was written. */
  delivered: number;
  questions: { [approvalId: string]: QuestionMarkState };
  /** Each input's request id to the reporter task delivering it, so a resent input lands once. */
  inputs: { [requestId: string]: number };
}

/** Whether a JSON value is an object. */
export const isJsonRecord = (
  value: JsonValue | undefined
): value is JsonRecord => Predicate.isObject(value) && !Array.isArray(value);

/** A detached copy of `value` when it is a JSON object; none otherwise. */
export const jsonRecordOf = (value: Schema.Json): JsonRecord | null => {
  const copied = copyJson(value);

  return isJsonRecord(copied) ? copied : null;
};

/** `cairn.subagents` state. */
export interface SubagentsState {
  [key: string]: JsonValue;
  items: { [key: string]: SubagentItemState };
}

/** `cairn.subagents`: every child a thread started, by the brief's approval id (ADR 0028). */
export const SubagentsDoc = defineDoc<SubagentsState>({
  kind: SUBAGENTS_DOCUMENT,
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork is another thread, with no children.
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** `cairn.subagent-parents` state: the conversations that hold children, as keys. */
export interface SubagentParentsState {
  [key: string]: JsonValue;
  parents: { [conversationId: string]: boolean };
}

/**
 * `cairn.subagent-parents` (session scope): every thread that may hold a live child, so the
 * brain-wide cap counts them without a scan of every conversation (BrainCap.ts).
 */
export const SubagentParentsDoc = defineDoc<SubagentParentsState>({
  kind: "cairn.subagent-parents",
  version: 1,
  scope: "session",
  initial: () => ({ parents: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/**
 * A child's first `report`: the protocol's `ChildReport` as plain JSON. `payload` stays null: a
 * typed result is `submit_result`'s, in `cairn.result`.
 */
export interface ChildReportState {
  [key: string]: JsonValue;
  summary: string;
  divergence: string;
  payload: JsonValue;
  commit: string | null;
}

/** `cairn.child` state: the protocol's `ChildDocument` as plain JSON. */
export interface ChildState {
  [key: string]: JsonValue;
  key: string;
  parentThreadId: string;
  parentConversationId: number;
  rootThreadId: string;
  depth: number;
  briefApprovalId: string;
  resultSchema: JsonRecord | null;
  /**
   * Always 0: a typed result's attempts are derived from the child's transcript
   * (`readAttemptState`, models/ResultTool.ts), never kept as a counter.
   */
  attempts: number;
  report: ChildReportState | null;
  /** The mode the child started in: the narrower of its brief's and its parent's. */
  permissionMode: RuntimeMode;
}

/**
 * `cairn.child`: a subagent's link to its parent, written in its creating commit (ADR 0028). The
 * result tool reads its `resultSchema` through this token.
 */
export const ChildDoc = defineDoc<ChildState>({
  kind: CHILD_DOCUMENT,
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork of a child is another thread, which has no parent.
  fork: "initial",
  initial: () => ({
    key: "",
    parentThreadId: "",
    parentConversationId: 0,
    rootThreadId: "",
    depth: 1,
    briefApprovalId: "",
    resultSchema: null,
    attempts: 0,
    report: null,
    permissionMode: DEFAULT_RUNTIME_MODE,
  }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

/** Whether a stored `cairn.child` names a parent: the creating commit sets every field at once. */
export const isLinked = (
  child: Readonly<ChildState> | undefined
): child is Readonly<ChildState> =>
  child !== undefined && child.parentConversationId > 0;

/**
 * Records where a child's question stands in its parent's registry, inside the caller's
 * transaction (`at` is when it escalated, kept once set). `childConversationId` must be a
 * subagent's: `tx.doc` would create an empty link on any other conversation. Writes documents only.
 */
export const markQuestion = async (
  tx: Tx,
  parentConversationId: ConversationId,
  childConversationId: ConversationId,
  approvalId: string,
  state: SubagentQuestionState,
  at: Option.Option<number>
): Promise<void> => {
  const link = await tx.doc(ChildDoc, childConversationId);

  if (!isLinked(link)) {
    return;
  }

  const registry = await tx.doc(SubagentsDoc, parentConversationId);
  const item = registry.items[link.key];

  if (item !== undefined) {
    item.questions[approvalId] = {
      state,
      escalatedAt: Option.getOrElse(
        at,
        () => item.questions[approvalId]?.escalatedAt ?? null
      ),
    };
  }
};
