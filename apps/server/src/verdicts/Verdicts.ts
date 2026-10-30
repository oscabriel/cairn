// The verdict writer (ADR 0026, briefs note section 3): the one module that opens `cairn.goal` for
// writing. A criterion's `state` and `verdict` move only here, from a judge run the server made
// (`JudgeRun.ts`) or a user's mark on a `user` judge, so the model can ask for a check and never
// write a result. Criteria enter here too: the user binds them (`goal.setCriteria`), or accepts a
// `criteria` approval the model's `goal_criteria` asked (the answering commit's hook), so a judge a
// model proposed is read by the user before it binds. `Verdicts.test.ts` fails if any other module
// in the server writes the goal document, sets `met` or writes a verdict.
//
// "Met" means the criterion's latest verdict is ok and was recorded after the criterion last
// changed. A criterion changes when it is bound anew with other words or another judge; a run
// queued before that finds its criterion changed and records nothing (`stale`).

import { CriteriaPayload } from "@cairn/protocol/Policy";
import type { CriterionProposal } from "@cairn/protocol/Policy";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { Data, Option, Schema } from "effect";

import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { GoalDoc, judgeState } from "./GoalDocs.ts";
import type {
  CriterionStateDoc,
  GoalState,
  JudgeRefState,
  VerdictState,
} from "./GoalDocs.ts";

/** The most criteria one goal holds (the protocol's `SetCriteriaInput`). */
export const MAX_CRITERIA = 32;

/** What identifies a criterion across a rebinding: its words and its judge. */
export const criterionKey = (text: string, judge: JudgeRefState): string =>
  JSON.stringify([text.trim(), judge]);

/** How criteria are bound: the user's whole list replaces the goal's; an approval adds to it. */
export type BindMode = "replace" | "append";

/** Criteria to bind, from the user or an accepted `criteria` approval. */
export interface BindInput {
  readonly objective: Option.Option<string>;
  readonly criteria: ReadonlyArray<CriterionProposal>;
  readonly mode: BindMode;
}

/** How a binding landed: the criteria it kept as they were, added and dropped. */
export type BindOutcome = Data.TaggedEnum<{
  Bound: {
    readonly kept: ReadonlyArray<string>;
    readonly added: ReadonlyArray<string>;
    readonly removed: ReadonlyArray<string>;
  };
  TooMany: { readonly total: number };
}>;

/** Constructors and matchers of `BindOutcome`. */
export const BindOutcome = Data.taggedEnum<BindOutcome>();

/** The next unused `c<n>` id. */
const nextId = (taken: ReadonlySet<string>): (() => string) => {
  let counter = 0;

  for (const id of taken) {
    const match = /^c(?<n>\d+)$/u.exec(id);
    const n = Number(match?.groups?.n ?? "0");

    counter = Math.max(counter, n);
  }

  return () => {
    counter += 1;

    return `c${String(counter)}`;
  };
};

/**
 * Binds criteria into a goal, in place. A criterion whose words and judge match one the goal holds
 * keeps its id, state and verdict; any other is new and open, changed now. `replace` drops the
 * goal's criteria the list leaves out; `append` keeps them. Refused past `MAX_CRITERIA`.
 */
export const applyBind = (
  goal: GoalState,
  input: BindInput,
  now: number
): BindOutcome => {
  const existing = new Map(
    goal.criteria.map(
      (criterion) =>
        [criterionKey(criterion.text, criterion.judge), criterion] as const
    )
  );

  const mint = nextId(new Set(goal.criteria.map((criterion) => criterion.id)));

  const next: Array<CriterionStateDoc> =
    input.mode === "append" ? [...goal.criteria] : [];

  // Each key once per binding: a proposal repeated in one list binds one criterion.
  const seen = new Set<string>();
  const kept: Array<string> = [];
  const added: Array<string> = [];

  for (const proposal of input.criteria) {
    const judge = judgeState(proposal.judge);
    const text = proposal.text.trim();
    const key = criterionKey(text, judge);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    const found = existing.get(key);

    if (found !== undefined) {
      // Appending keeps every criterion already; replacing keeps only those listed again.
      if (input.mode === "replace") {
        next.push(found);
      }

      kept.push(found.id);
      continue;
    }

    const id = mint();

    next.push({
      id,
      text,
      judge,
      state: "open",
      verdict: null,
      tries: 0,
      changedAt: now,
    });
    added.push(id);
  }

  if (next.length > MAX_CRITERIA) {
    return BindOutcome.TooMany({ total: next.length });
  }

  const staying = new Set(next.map((criterion) => criterion.id));

  const removed = goal.criteria
    .map((criterion) => criterion.id)
    .filter((id) => !staying.has(id));

  goal.criteria = next;

  if (Option.isSome(input.objective)) {
    goal.objective = input.objective.value.trim();
  }

  // A goal whose criteria changed is open again until its judges say otherwise.
  if (added.length > 0 || removed.length > 0) {
    goal.closedAt = null;
    goal.closedBy = null;
  }

  return BindOutcome.Bound({ kept, added, removed });
};

/** Binds criteria into a conversation's goal, inside the caller's transaction (`applyBind`). */
export const bindCriteria = async (
  tx: Tx,
  conversationId: ConversationId,
  input: BindInput,
  now: number
): Promise<BindOutcome> =>
  applyBind(await tx.doc(GoalDoc, conversationId), input, now);

const decodeCriteria = Schema.decodeUnknownOption(CriteriaPayload);

/**
 * What a `criteria` approval's answer binds, inside the answering transaction (`answerApproval`'s
 * `answered` hook): accepted, its proposed criteria join the goal (`decidedBy` user, recorded on the
 * record); declined or expired, nothing. Any other record binds nothing.
 */
export const criteriaAnswered = async (
  tx: Tx,
  conversationId: ConversationId,
  record: ApprovalRecord
): Promise<void> => {
  if (record.kind !== "criteria" || record.status !== "accepted") {
    return;
  }

  const payload = decodeCriteria(record.payload);

  if (Option.isNone(payload)) {
    return;
  }

  await bindCriteria(
    tx,
    conversationId,
    {
      objective: Option.none(),
      criteria: payload.value.criteria,
      mode: "append",
    },
    record.answeredAt ?? record.askedAt
  );
};

/** One verdict for the criterion a run was queued for, as it stood when queued. */
export interface VerdictInput {
  readonly criterionId: string;
  /** The criterion's `changedAt` when the run was queued. */
  readonly changedAt: number;
  readonly verdict: VerdictState;
}

/**
 * How a verdict landed: recorded; already recorded by this run (a rerun after a crash); or stale,
 * because the criterion is gone or changed since the run was queued, so its verdict judges words
 * the goal no longer holds.
 */
export type VerdictOutcome = "recorded" | "duplicate" | "stale";

/** Whether `criterion` is still the one a run was queued for. */
const isSameCriterion = (
  criterion: CriterionStateDoc,
  input: VerdictInput
): boolean =>
  criterion.changedAt === input.changedAt &&
  JSON.stringify(criterion.judge) === JSON.stringify(input.verdict.judge);

/**
 * Records a verdict in place: the criterion's verdict, its state (`met` when ok, `failed` when not)
 * and one more try. A run records once; a stale run records nothing.
 */
export const applyVerdict = (
  goal: GoalState,
  input: VerdictInput
): VerdictOutcome => {
  const criterion = goal.criteria.find((item) => item.id === input.criterionId);

  if (criterion === undefined || !isSameCriterion(criterion, input)) {
    return "stale";
  }

  if (criterion.verdict?.runId === input.verdict.runId) {
    return "duplicate";
  }

  criterion.verdict = input.verdict;
  criterion.state = input.verdict.ok ? "met" : "failed";
  criterion.tries += 1;

  return "recorded";
};

/** Records a judge run's verdict inside the run's completing transaction (`applyVerdict`). */
export const recordVerdict = async (
  tx: Tx,
  conversationId: ConversationId,
  input: VerdictInput
): Promise<VerdictOutcome> =>
  applyVerdict(await tx.doc(GoalDoc, conversationId), input);

/** The user's mark on a criterion a `user` judge decides. */
export interface UserMark {
  readonly criterionId: string;
  readonly ok: boolean;
  readonly note: Option.Option<string>;
  readonly at: number;
}

/** How a user's mark landed. */
export type MarkOutcome = VerdictOutcome | "not_found" | "not_user_judge";

/**
 * Records the user's mark in place, as a verdict with `decidedBy` the user (its judge is `user` and
 * its run id `mark-<at>`). Only a criterion its user judges takes one: a command or model judge is
 * decided by its run, never by hand.
 */
export const applyMark = (goal: GoalState, mark: UserMark): MarkOutcome => {
  const criterion = goal.criteria.find((item) => item.id === mark.criterionId);

  if (criterion === undefined) {
    return "not_found";
  }

  if (criterion.judge.kind !== "user") {
    return "not_user_judge";
  }

  return applyVerdict(goal, {
    criterionId: criterion.id,
    changedAt: criterion.changedAt,
    verdict: {
      at: mark.at,
      ok: mark.ok,
      judge: { kind: "user" },
      evidence: {
        exit: null,
        tail: null,
        sha: null,
        model: null,
        note: Option.getOrNull(mark.note),
      },
      runId: `mark-${String(mark.at)}`,
    },
  });
};

/** Records the user's mark inside the caller's transaction (`applyMark`). */
export const markByUser = async (
  tx: Tx,
  conversationId: ConversationId,
  mark: UserMark
): Promise<MarkOutcome> =>
  applyMark(await tx.doc(GoalDoc, conversationId), mark);
