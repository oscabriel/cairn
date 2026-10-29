// Faults a harness can plant in its subagent delivery, so the conformance suite's mutation check
// can prove its subagent scenarios fail when delivery breaks (ADR 0024, ADR 0028). Production and
// dev never set one: the default plants none. Each fault breaks one promise of the delivery:
//
// - dropNote: a child's settlement never reaches its parent as a note.
// - deliverTwice: the reporter mints fresh request ids, so its report runs twice and lands twice.
// - wakeStoppedParent: a parent the user stopped (or whose run failed) is woken anyway.
// - routeApprovalToParent: a child's gated call is offered to the parent model, which may answer it.

import { Context } from "effect";

/** Which delivery faults are planted. */
export interface SubagentFaultSet {
  readonly dropNote: boolean;
  readonly deliverTwice: boolean;
  readonly wakeStoppedParent: boolean;
  readonly routeApprovalToParent: boolean;
}

/** No fault: the setting everything but the mutation check runs with. */
export const NO_SUBAGENT_FAULTS: SubagentFaultSet = {
  dropNote: false,
  deliverTwice: false,
  wakeStoppedParent: false,
  routeApprovalToParent: false,
};

/** The faults a harness plants in subagent delivery; none unless a test provides some. */
export const SubagentFaults = Context.Reference<SubagentFaultSet>(
  "cairn/server/brain/SubagentFaults",
  { defaultValue: () => NO_SUBAGENT_FAULTS }
);
