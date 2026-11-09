---
status: accepted
gate: a migration test over a version 1 fixture, and `judges/thread-states.test.ts` with the new statuses
---

# Every decision names who made it

Approval records move to version 2 of `cairn.approvals`. Every record carries `decidedBy` (the user, an envelope, later a proxy), a `reason`, the `answer`, and a frozen `payload` that never changes after the record is written. New kinds `brief` and `criteria` join `executor-call`, `tool-call` and `user-input`, and a new status `revised` covers a brief sent back with notes. A status leaves `pending` once. Stopping a thread now writes `cancelled` on its pending records, where phase 1 left them `pending`. The stop commits its abort marks first and the cancellations after; a crash in between is repaired at boot, which cancels every held record whose tool task is gone, ending or abort-marked (`decidedBy` system `boot`).

This is hard to reverse because record kinds and shapes are protocol, and hands-off goals (after phase 2, ADR 0026) build on `decidedBy`. A settled record shows in the transcript as one line naming who decided and why (`docs/phase-2/notes/briefs.md`).

Decided by the user on 2026-10-27, from the phase 2 area notes.

Gate evidence so far (package 1A, 2026-10-28): `apps/server/src/brain/CairnDocs.test.ts` opens a store written by phase 1's version 1 definition (five records in `fixtures/approvals-v1.json`), reads them back as version 2 with every version 1 field kept, the new fields null and `route` `user`, `decidedBy` read from the status (full access where `answeredAt` equals `askedAt`, else the user; `expiry`; none while pending), decodes the result with the protocol's `ApprovalsDocument`, and after one answer finds phase 1's definition refused by the store ("newer version 2 than 1"). A migration that passes version 1 through fails it. Conformance `approval_declined_with_reason` and `approval_cancelled_on_stop` failed on both harnesses before the change (4 of 4) and pass on both after it. `judges/thread-states.test.ts` passes. The stop's crash window is judged in `PiDurableHarness.test.ts`: an abort mark committed with no cancellation leaves the record `pending` after a reopen, and the boot repair cancels it; a stop whose caller is interrupted after its abort still cancels. Accepted at the wave 1 integration (2026-10-28): on `main` the same tests pass inside `pnpm check`, the boot repair (`cancel abandoned approvals`) is listed in `BootRepairs.ts` after the Executor sweep and runs on every boot of the judge brain, and the durability judge's ten faux windows pass, approval-parked included.

## Amendment: a superseded launch (2026-11-08)

The system decider gains a third reason, `superseded`, beside `run-stopped` and `boot` (`packages/protocol/src/Policy.ts`, `Decider`). It is written on a workflow row only: a newer Go of the same script declines an older approved launch that never ran (`supersedeRow` in `apps/server/src/workflows/WorkflowDocs.ts`), so the gate, which runs one approved row per script hash, runs the launch the user approved last. A reader that knew only the first two reasons refuses a document holding the third, so the protocol schema and `packages/protocol/schema/cairn-documents.json` changed together. Judged by `WorkflowLaunchFlow.test.ts` ("a second Go on a script with an approved launch left over runs the newer launch and supersedes the older").

## Amendment: records nothing waits on expire (2026-11-08)

A record no task waits on now expires at its `expiresAt` like every other record (`decidedBy` `expiry`), with one exception. Proposed criteria have no waiter (`goal_propose_criteria` returns at once): an answer that arrives after `expiresAt` expires them in the answering commit and reports `already_settled` (`applyAnswer`), and a boot repair (`expireLapsedApprovalsAtBoot`, listed in `BootRepairs.ts`) expires any still pending past it. The same repair ends a parent's pending mirror whose child's question already ended, which a stop of the child's run can leave behind.

A budget raise (`toolTaskId` 0, tool `budget_raise`, a thread scope's or a workflow's) never lapses (`neverLapses` in `CairnDocs.ts`), decided by the user on 2026-11-08. A raise is asked once per epoch (`budget-raise-<epoch>`, `budget-raise-<workflowId>-<epoch>`) and is the way out of a halted scope or workflow, so an expired raise would leave it halted until its budget changed in settings, and a late answer is the user's current choice, not a stale one. Its `expiresAt` stays on the record and is not enforced.

Judged by `CairnDocs.test.ts` ("an answer after a record's expiry", including "takes an answer to a budget raise past its expiresAt") and `PiDurableHarness.test.ts` (the boot sweep tests, where a lapsed raise stays pending).
