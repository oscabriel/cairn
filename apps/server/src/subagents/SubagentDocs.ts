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
// - `cairn.escalations` (on the parent) indexes the child questions escalated to the user, by the
//   child's approval id, written in the escalation commit beside the parent's mirror record
//   (approvals/QuestionRoute.ts) and resolved when the question is answered or ends.

import { DEFAULT_RUNTIME_MODE } from "@cairn/protocol/Policy";
import {
  CHILD_DOCUMENT,
  ESCALATIONS_DOCUMENT,
  SUBAGENTS_DOCUMENT,
} from "@cairn/protocol/Subagents";
import type {
  ChildDocument,
  EscalationsDocument,
  RunMark,
  SettlementMark,
  SubagentQuestionState,
  SubagentRecord,
  SubagentsDocument,
} from "@cairn/protocol/Subagents";
import type { DocumentState, PlainJson } from "@cairn/protocol/Thread";
import type { JsonValue } from "@earendil-works/chord/json";
import { copyJson } from "@earendil-works/chord/json";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import { Option, Predicate } from "effect";
import type { Schema } from "effect";

import { migrateSubagents } from "../brain/RolesRetired.ts";

/** A JSON object as a document holds it. */
export interface JsonRecord {
  [key: string]: JsonValue;
}

/** One delivered settlement, as the registry keeps it: the protocol's `SettlementMark`. */
export type SettlementMarkState = DocumentState<typeof SettlementMark>;

/** One child run nudged or settled: the protocol's `RunMark`. */
export type RunMarkState = DocumentState<typeof RunMark>;

/** The inputs a run mark names: a nudge mark's own, a settled mark's settlement's. */
export const markInputs = (
  item: SubagentItemState,
  mark: RunMarkState
): ReadonlyArray<string> =>
  mark.phase === "nudge"
    ? mark.inputs
    : (item.settlements.find((settled) => settled.seq === mark.seq)?.inputs ??
      []);

/** One child in its parent's registry: the protocol's `SubagentRecord`. */
export type SubagentItemState = DocumentState<typeof SubagentRecord>;

/** Whether a JSON value is an object. */
export const isJsonRecord = (
  value: JsonValue | undefined
): value is JsonRecord => Predicate.isObject(value) && !Array.isArray(value);

/** A detached copy of `value` when it is a JSON object; none otherwise. */
export const jsonRecordOf = (value: Schema.Json): JsonRecord | null => {
  const copied = copyJson(value);

  return isJsonRecord(copied) ? copied : null;
};

/**
 * A detached copy of `value` as its writer holds it (`PlainJson`): the same JSON, alias-free and
 * mutable, safe to keep past its transaction or to write into another document. `value` is plain
 * JSON already: a document's value, or what a protocol schema encoded.
 */
export const plainCopy = <T>(value: T): PlainJson<T> =>
  // SAFETY: `copyJson` copies a strict-JSON tree into an alias-free tree of the same shape, and
  // `PlainJson<T>` is `T` with its readonly modifiers dropped; a value that is not strict JSON throws.
  // Verified by: SubagentsPiDurable.test.ts, CairnDocs.test.ts and WorkflowLedger.test.ts (each
  // document a real writer built decodes with its protocol schema).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  copyJson(value) as PlainJson<T>;

/** `cairn.subagents` state: the protocol's `SubagentsDocument`. */
export type SubagentsState = DocumentState<typeof SubagentsDocument>;

/**
 * `cairn.subagents`: every child a thread started, by the brief's approval id (ADR 0028). Version 2
 * retired the dispatch records' roles (ADR 0052).
 */
export const SubagentsDoc = defineDoc<SubagentsState>({
  kind: SUBAGENTS_DOCUMENT,
  version: 2,
  migrate: migrateSubagents,
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
 * `cairn.child` state: the protocol's `ChildDocument`. `attempts` stays 0: a typed result's attempts
 * are derived from the child's transcript (`readAttemptState`, models/ResultTool.ts), and `report`'s
 * `payload` stays null: a typed result is `submit_result`'s, in `cairn.result`.
 */
export type ChildState = DocumentState<typeof ChildDocument>;

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

/** `cairn.escalations` state: the protocol's `EscalationsDocument`. */
export type EscalationsState = DocumentState<typeof EscalationsDocument>;

/**
 * `cairn.escalations`: a parent's index of its children's questions escalated to the user (ADR
 * 0027), by the child's approval id. A `thread.respond` on the parent's mirror resolves through an
 * open entry here.
 */
export const EscalationsDoc = defineDoc<EscalationsState>({
  kind: ESCALATIONS_DOCUMENT,
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork is another thread, which escalated nothing.
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** `cairn.wake-hold` state: whether a Stop all holds the thread's wakes, and from which run on. */
export interface WakeHoldState {
  [key: string]: JsonValue;
  held: boolean;
  /**
   * The last generation of the run the stop ended, else the thread's newest run task when the stop
   * held it; null when it had none.
   */
  afterRun: number | null;
}

/**
 * `cairn.wake-hold`: a Stop all's mark on the thread it stopped (ADR 0028). A thread whose last run
 * had completed is not halted by its run, so without the mark the stopped children's results would
 * wake it, and a removed thread would start a run with no row to stop it from. The mark lasts until
 * a run starts after `afterRun` (`parentHalt`), so the user's next input clears it.
 */
export const WakeHoldDoc = defineDoc<WakeHoldState>({
  kind: "cairn.wake-hold",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork is another thread, which nobody stopped.
  fork: "initial",
  initial: () => ({ held: false, afterRun: null }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

/** Whether a stored `cairn.child` names a parent: the creating commit sets every field at once. */
export const isLinked = (
  child: Readonly<ChildState> | undefined
): child is Readonly<ChildState> =>
  child !== undefined && child.parentConversationId > 0;

/**
 * Records where a child's question stands in its parent's registry, inside the caller's
 * transaction (`at` is when it escalated, kept once set). A question answered or cancelled also
 * resolves its open entry in the parent's `cairn.escalations`, so the index never shows a question
 * that is no longer the user's. An answer or a cancellation only ends a question already marked:
 * a record that never went to the parent (the child's own `ask_user`) gets no mark.
 * `childConversationId` must be a subagent's: `tx.doc` would create an empty link on any other
 * conversation. Writes documents only.
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

  // Only a question that was escalated has an entry: opening the index otherwise would create it.
  const escalated =
    (item?.questions[approvalId]?.escalatedAt ?? null) !== null ||
    Option.isSome(at);

  // An answer or a cancellation ends a question the parent was asked; a record of the child that
  // never reached the parent (an `ask_user` question) has no entry and gets none.
  const ends = state === "answered" || state === "cancelled";

  if (
    item !== undefined &&
    (!ends || item.questions[approvalId] !== undefined)
  ) {
    item.questions[approvalId] = {
      state,
      escalatedAt: Option.getOrElse(
        at,
        () => item.questions[approvalId]?.escalatedAt ?? null
      ),
    };
  }

  if (escalated && (state === "answered" || state === "cancelled")) {
    const index = await tx.doc(EscalationsDoc, parentConversationId);
    const entry = index.items[approvalId];

    if (entry?.status === "open") {
      entry.status = "resolved";
    }
  }
};
