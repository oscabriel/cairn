// The dispatch ledger's document (ADR 0012 as amended, ADR 0032): one `cairn.workflows` document
// on the thread whose model launched the script, `{ items: { [workflowId]: WorkflowRecord } }` as
// plain JSON (S23), with the rules the approval ledger applies to it. Its shapes are the protocol's
// `WorkflowsDocument` (packages/protocol/src/Workflows.ts); the kind is protocol and never changes,
// and a fork starts with no workflows. Declared here, with the brain's other documents, because the
// brain reads it (the crash limit, the spend feed) and so does the approval ledger (a cancelled
// launch declines its row); the workflow tools write it (`workflows/WorkflowDocs.ts` holds their
// rules).

import { WorkflowLaunch } from "@cairn/protocol/Policy";
import type { DocumentState } from "@cairn/protocol/Thread";
import { WORKFLOWS_DOCUMENT } from "@cairn/protocol/Workflows";
import type {
  WorkflowRecord,
  WorkflowsDocument,
} from "@cairn/protocol/Workflows";
import { defineDoc } from "@earendil-works/pi-durable";
import { Option, Schema } from "effect";

import type { ApprovalRecord } from "./CairnDocs.ts";
import { migrateWorkflows } from "./RolesRetired.ts";

/** One workflow: the protocol's `WorkflowRecord` as its writer holds it. */
export type WorkflowItemState = DocumentState<typeof WorkflowRecord>;

/** `cairn.workflows` state: the protocol's `WorkflowsDocument` as its writer holds it. */
export type WorkflowsState = DocumentState<typeof WorkflowsDocument>;

/**
 * `cairn.workflows`: every workflow a thread launched, by id (the dispatch ledger). Version 2
 * retired the nodes' `role` (ADR 0052).
 */
export const WorkflowsDoc = defineDoc<WorkflowsState>({
  kind: WORKFLOWS_DOCUMENT,
  version: 2,
  migrate: migrateWorkflows,
  scope: "conversation",
  history: "latest",
  // A fork is another thread, which launched nothing.
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/**
 * Moves a `proposed` row to `declined`, from its launch approval settled any way but Go: Decline,
 * an expiry, or a stop that cancelled it. False when the row is not `proposed`.
 */
export const declineRow = (
  row: WorkflowItemState,
  record: ApprovalRecord
): boolean => {
  if (row.state !== "proposed") {
    return false;
  }

  const at = record.answeredAt ?? record.askedAt;

  row.state = "declined";
  row.decidedBy = record.decidedBy === null ? null : { ...record.decidedBy };
  row.decidedAt = at;
  row.endedAt = at;

  return true;
};

/** The record tool of a workflow node's own brief, one per node kind. */
export const NODE_BRIEF_TOOLS: ReadonlySet<string> = new Set([
  "agent",
  "verify",
]);

const decodeLaunch = Schema.decodeUnknownOption(WorkflowLaunch);

/** The launch a record's frozen payload holds; none when it holds another kind. */
export const launchOf = (
  record: ApprovalRecord
): Option.Option<WorkflowLaunch> =>
  record.payload === null ? Option.none() : decodeLaunch(record.payload);
