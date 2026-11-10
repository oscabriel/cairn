// Roles retired from the brain store (ADR 0052, after ADR 0043). Documents written before then still
// say `role`: a brief's model spec, a ledger node's spec and an envelope's `roles`, with role names
// (`@worker`) where a spec goes, the resolution record's `role`, `via`, `skipped` and `family`, and
// the launch overrides `roleOverrides`. Each document that held them takes a version bump whose
// `migrate` runs these rewrites when the store hands the document out, so every reader sees only
// today's shape and no reader keeps a branch for the old one:
//
// - `role` becomes `model`, a role name in it becomes null (the parent's model, as ADR 0043 read
//   it), and a brief's old `model` (a `ModelRef`, from before specs) folds into it when `role` named
//   none;
// - an envelope's `roles` become `models`, without the entries a role name keyed: such an entry
//   granted the launching thread's model, which a stored envelope cannot name, so a node it covered
//   asks for its own brief instead;
// - a call site a role name keyed is dropped from its frozen launch, which only the card read;
// - a judge's role name becomes null, its goal thread's model, as ADR 0043 read it;
// - a resolution record's role fields go, and its `spec`, if a role name, becomes the model it
//   resolved to.
//
// The rewrites are pure (each works on a copy), change nothing else, and leave a value that is
// already today's shape as it is, so running one twice is running it once.

import { GOAL_DOCUMENT } from "@cairn/protocol/Policy";
import { SUBAGENTS_DOCUMENT } from "@cairn/protocol/Subagents";
import { WORKFLOWS_DOCUMENT } from "@cairn/protocol/Workflows";
import { copyJson } from "@earendil-works/chord/json";
import type { JsonValue } from "@earendil-works/chord/json";
import type { JsonObject } from "@earendil-works/pi-durable";
import { Predicate } from "effect";

import type { SubagentsState } from "../subagents/SubagentDocs.ts";
import type { GoalState } from "../verdicts/GoalDocs.ts";
import type { WorkflowsState } from "../workflows/WorkflowDocs.ts";
import type { ApprovalsState } from "./CairnDocs.ts";

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/** A detached copy of a stored value, for a rewrite to change. */
const copyOf = (value: JsonObject): JsonObject => {
  const copied = copyJson(value);

  return isObject(copied) ? copied : {};
};

/** Whether a stored spec is a role name (`@worker`, `@scout:high`): no provider before its slash. */
const isRoleName = (value: JsonValue | undefined): boolean =>
  Predicate.isString(value) && value.trim().startsWith("@");

/** A stored spec with a role name read as none. */
const specOrNone = (value: JsonValue | undefined): JsonValue =>
  value === undefined || isRoleName(value) ? null : value;

/** The values of an object-valued map, each an object; anything else is left as it is. */
const objectsOf = (value: JsonValue | undefined): ReadonlyArray<JsonObject> =>
  isObject(value) ? Object.values(value).filter(isObject) : [];

/** The items of an array of objects; anything else is left as it is. */
const arrayObjectsOf = (
  value: JsonValue | undefined
): ReadonlyArray<JsonObject> =>
  Array.isArray(value) ? value.filter(isObject) : [];

/** A judge, in place: a model judge's role name becomes null. */
const retireJudge = (judge: JsonValue | undefined) => {
  if (isObject(judge) && judge.kind === "model") {
    judge.spec = specOrNone(judge.spec);
  }
};

/** An envelope, in place: `roles` becomes `models`, without the entries a role name keyed. */
const retireEnvelope = (envelope: JsonValue | undefined) => {
  if (!isObject(envelope) || !Object.hasOwn(envelope, "roles")) {
    return;
  }

  const { roles } = envelope;

  delete envelope.roles;
  envelope.models = arrayObjectsOf(roles).filter(
    (entry) => !isRoleName(entry.spec)
  );
};

/** `provider/modelId` of a stored `ModelRef`, or null. */
const refSpecOf = (model: JsonValue | undefined): JsonValue =>
  isObject(model) &&
  Predicate.isString(model.provider) &&
  Predicate.isString(model.modelId)
    ? `${model.provider}/${model.modelId}`
    : null;

/** A frozen brief, in place: `role` becomes `model`, and its judges lose their role names. */
const retireBrief = (brief: JsonObject) => {
  if (Object.hasOwn(brief, "role")) {
    const named = specOrNone(brief.role);

    delete brief.role;
    brief.model = named ?? refSpecOf(brief.model);
  }

  delete brief.roleOverrides;

  for (const criterion of arrayObjectsOf(brief.doneWhen)) {
    retireJudge(criterion.judge);
  }
};

/** A frozen launch, in place: its envelope's models, and no call site keyed by a role name. */
const retireLaunch = (launch: JsonObject) => {
  retireEnvelope(launch.envelope);
  delete launch.roleOverrides;

  if (Array.isArray(launch.callSites)) {
    launch.callSites = launch.callSites.filter(
      (site) => !(isObject(site) && isRoleName(site.spec))
    );
  }
};

/** A record's frozen payload, in place, by its type. */
const retirePayload = (payload: JsonValue | undefined) => {
  if (!isObject(payload)) {
    return;
  }

  if (payload.type === "brief") {
    retireBrief(payload);
  } else if (payload.type === "workflow") {
    retireLaunch(payload);
  } else if (payload.type === "criteria") {
    for (const criterion of arrayObjectsOf(payload.criteria)) {
      retireJudge(criterion.judge);
    }
  }
};

/** `cairn.approvals` (version 2) with its roles retired: payloads and the answers' launch edits. */
export const retireApprovalRoles = (stored: JsonObject): JsonObject => {
  const value = copyOf(stored);

  for (const record of objectsOf(value.items)) {
    retirePayload(record.payload);

    if (isObject(record.answer) && isObject(record.answer.launch)) {
      delete record.answer.launch.roleOverrides;
    }
  }

  return value;
};

/** `cairn.workflows` (version 1) with its roles retired: each node's `role` becomes `model`. */
export const retireWorkflowRoles = (stored: JsonObject): JsonObject => {
  const value = copyOf(stored);

  for (const workflow of objectsOf(value.items)) {
    for (const node of objectsOf(workflow.nodes)) {
      if (Object.hasOwn(node, "role")) {
        const named = specOrNone(node.role);

        delete node.role;
        node.model = named;
      }
    }
  }

  return value;
};

/**
 * `cairn.subagents` (version 1) with its roles retired: a dispatch's role name becomes null, and
 * its resolution loses the role fields and names the model it resolved to.
 */
export const retireSubagentRoles = (stored: JsonObject): JsonObject => {
  const value = copyOf(stored);

  for (const item of objectsOf(value.items)) {
    if (!isObject(item.dispatch)) {
      continue;
    }

    item.dispatch.spec = specOrNone(item.dispatch.spec);

    const { resolved } = item.dispatch;

    if (isObject(resolved)) {
      delete resolved.role;
      delete resolved.via;
      delete resolved.skipped;
      delete resolved.family;

      if (isRoleName(resolved.spec)) {
        resolved.spec = refSpecOf(resolved.model);
      }
    }
  }

  return value;
};

/** `cairn.goal` (version 1) with its roles retired: judges, verdicts' judges and the envelope. */
export const retireGoalRoles = (stored: JsonObject): JsonObject => {
  const value = copyOf(stored);

  for (const criterion of arrayObjectsOf(value.criteria)) {
    retireJudge(criterion.judge);

    if (isObject(criterion.verdict)) {
      retireJudge(criterion.verdict.judge);
    }
  }

  retireEnvelope(value.envelope);

  return value;
};

/** Throws for a version a document's migration does not know, so nothing is skipped silently. */
const unknownVersion = (kind: string, fromVersion: number): never => {
  throw new Error(`${kind} has no migration from version ${fromVersion}`);
};

/** `cairn.approvals` version 2 to 3. */
export const approvalsFromV2 = (value: JsonObject): ApprovalsState =>
  // SAFETY: the value is the previous version's, which its typed writers wrote, with only the
  // fields this version retired rewritten above; nothing is decoded or dropped, so it is the
  // current shape, and a value that never matched stays as it was.
  // Verified by: RolesRetired.test.ts (a store built with the old shapes opens and decodes with
  // each document's protocol schema).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  retireApprovalRoles(value) as ApprovalsState;

/** `cairn.workflows` version 1 to 2, pi-durable's `migrate`. */
export const migrateWorkflows = (
  value: JsonObject,
  fromVersion: number
): WorkflowsState => {
  if (fromVersion !== 1) {
    return unknownVersion(WORKFLOWS_DOCUMENT, fromVersion);
  }

  // SAFETY: as `approvalsFromV2`'s: only the fields this version retired are rewritten.
  // Verified by: RolesRetired.test.ts.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return retireWorkflowRoles(value) as WorkflowsState;
};

/** `cairn.subagents` version 1 to 2, pi-durable's `migrate`. */
export const migrateSubagents = (
  value: JsonObject,
  fromVersion: number
): SubagentsState => {
  if (fromVersion !== 1) {
    return unknownVersion(SUBAGENTS_DOCUMENT, fromVersion);
  }

  // SAFETY: as `approvalsFromV2`'s: only the fields this version retired are rewritten.
  // Verified by: RolesRetired.test.ts.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return retireSubagentRoles(value) as SubagentsState;
};

/** `cairn.goal` version 1 to 2, pi-durable's `migrate`. */
export const migrateGoal = (
  value: JsonObject,
  fromVersion: number
): GoalState => {
  if (fromVersion !== 1) {
    return unknownVersion(GOAL_DOCUMENT, fromVersion);
  }

  // SAFETY: as `approvalsFromV2`'s: only the fields this version retired are rewritten.
  // Verified by: RolesRetired.test.ts.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return retireGoalRoles(value) as GoalState;
};
