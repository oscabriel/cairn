// Faults a harness can plant in its subagent delivery, so the conformance suite's mutation check
// can prove its subagent scenarios fail when delivery breaks (ADR 0024, ADR 0028), and the crash
// points `judges/subagent-durability.ts` kills a judge brain at. Production and dev never set one:
// the defaults plant none. Each fault breaks one promise of the delivery:
//
// - dropNote: a child's settlement never reaches its parent as a note.
// - deliverTwice: the reporter mints fresh request ids, so its report runs twice and lands twice.
// - freshIds: the reporter mints a fresh request id for each submit it makes (the child's input,
//   a nudge, a wake) on every attempt, so a rerun after a crash submits it again. Without a crash
//   it delivers once: only the kill judge catches it.
// - seamOwnIds: the seam submits a user's input under a request id of its own (`<id>-seam`), not
//   the one its steer reporter submits under, so a subagent's steer is admitted twice. The kill
//   judge's steer control.
// - wakeStoppedParent: a parent the user stopped (or whose run failed) is woken anyway.
// - routeApprovalToParent: a child's gated call is offered to the parent model, which may answer it.
// - freshQuestionIds: a child's `ask_parent` question is offered to its parent under a fresh request
//   id on every attempt, so a rerun after a crash offers it again. Without a crash it routes once:
//   only the kill judge's question control catches it.

import { readFileSync, writeFileSync } from "node:fs";

import { Context, Function } from "effect";

/** Which delivery faults are planted. */
export interface SubagentFaultSet {
  readonly dropNote: boolean;
  readonly deliverTwice: boolean;
  readonly freshIds: boolean;
  readonly seamOwnIds: boolean;
  readonly wakeStoppedParent: boolean;
  readonly routeApprovalToParent: boolean;
  readonly freshQuestionIds: boolean;
}

/** No fault: the setting everything but the mutation check runs with. */
export const NO_SUBAGENT_FAULTS: SubagentFaultSet = {
  dropNote: false,
  deliverTwice: false,
  freshIds: false,
  seamOwnIds: false,
  wakeStoppedParent: false,
  routeApprovalToParent: false,
  freshQuestionIds: false,
};

/** The faults a harness plants in subagent delivery; none unless a test provides some. */
export const SubagentFaults = Context.Reference<SubagentFaultSet>(
  "cairn/server/brain/SubagentFaults",
  { defaultValue: () => NO_SUBAGENT_FAULTS }
);

/**
 * Where a judge brain may die in a subagent's delivery, each right after the durable step its name
 * says landed (subagents note, section 10):
 *
 * - steer-recorded: a user's steer to a child has its reporter, and the seam has not submitted it.
 * - reporter-submitted: the reporter's input is admitted to the child; the reporter still delivers.
 * - reporter-answered: the child's run that ended the input settled; nothing of the reporter's is.
 * - reporter-settled: the settlement is committed; no note is written.
 * - reporter-noted: the note is written; the wake is not submitted.
 * - reporter-woken: the wake is submitted; the settlement is not marked delivered.
 * - nudge-marked: a typed child's nudge is decided and marked; the nudge is not submitted.
 * - nudge-submitted: the nudge is admitted to the child; the reporter still delivers.
 * - question-recorded: a child's `ask_parent` question is recorded (its record, the parent's
 *   registry mark); it is not offered to the parent.
 * - question-routed: the question's input to the parent is admitted; the tool does not wait yet.
 * - question-answered: the parent's `subagent_reply` answer is committed; the tool has not
 *   returned, and the child's wait has not resumed.
 * - question-escalated: the parent's `subagent_reply` escalation (the child's record turned to the
 *   user, the parent's mirror and index entry) is committed; the tool has not returned.
 */
export const SUBAGENT_CRASH_POINTS = [
  "steer-recorded",
  "reporter-submitted",
  "reporter-answered",
  "reporter-settled",
  "reporter-noted",
  "reporter-woken",
  "nudge-marked",
  "nudge-submitted",
  "question-recorded",
  "question-routed",
  "question-answered",
  "question-escalated",
] as const;

export type SubagentCrashPoint = (typeof SUBAGENT_CRASH_POINTS)[number];

/** Called at each crash point; a judge brain's kills its own process there. */
export interface SubagentCrashHooks {
  readonly at: (point: SubagentCrashPoint) => void;
}

/** No crash anywhere. */
export const NO_SUBAGENT_CRASHES: SubagentCrashHooks = {
  at: Function.constVoid,
};

/** The crash points a judge brain plants; none unless its root provides some. */
export const SubagentCrashes = Context.Reference<SubagentCrashHooks>(
  "cairn/server/brain/SubagentCrashes",
  { defaultValue: () => NO_SUBAGENT_CRASHES }
);

const isCrashPoint = (name: string): name is SubagentCrashPoint =>
  SUBAGENT_CRASH_POINTS.some((point) => point === name);

/** How many times a marker file says its fault fired; 0 for a missing or unreadable one. */
const firedCount = (marker: string): number => {
  try {
    const count = Math.trunc(Number(readFileSync(marker, "utf-8")));

    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
};

/**
 * A judge brain's crash points (`judges/subagent-durability.ts`): for `spec` a
 * `subagent:<point>` or `subagent:<point>*<times>`, the brain kills itself with SIGKILL at that
 * point, as a `kill -9` there would, until `marker` counts `times` kills (1 by default), so the
 * next life runs on. Any other `spec` plants none. Synchronous, because pi-durable's task code
 * calls it between its awaits. Judge brains only: production and dev roots never provide it.
 */
export const judgeSubagentCrashes = (
  spec: string,
  marker: string
): SubagentCrashHooks => {
  const found = /^subagent:(?<point>[a-z-]+)(?:\*(?<times>\d+))?$/u.exec(spec);
  const point = found?.groups?.point ?? "";
  const times = Number(found?.groups?.times ?? 1);

  if (!isCrashPoint(point)) {
    return NO_SUBAGENT_CRASHES;
  }

  return {
    at: (reached) => {
      const fired = firedCount(marker);

      if (reached !== point || fired >= times) {
        return;
      }

      // Without its marker the fault would fire in every life the judge restarts, a crash loop.
      try {
        writeFileSync(marker, String(fired + 1), { flush: true });
      } catch {
        return;
      }

      // The judge reads the marker to know the kill landed.
      process.kill(process.pid, "SIGKILL");
    },
  };
};
