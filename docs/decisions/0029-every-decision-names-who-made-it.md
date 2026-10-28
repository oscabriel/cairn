---
status: proposed
gate: a migration test over a version 1 fixture, and `judges/thread-states.test.ts` with the new statuses
---

# Every decision names who made it

Approval records move to version 2 of `cairn.approvals`. Every record carries `decidedBy` (the user, an envelope, later a proxy), a `reason`, the `answer`, and a frozen `payload` that never changes after the record is written. New kinds `brief` and `criteria` join `executor-call`, `tool-call` and `user-input`, and a new status `revised` covers a brief sent back with notes. A status leaves `pending` once. Stopping a thread now writes `cancelled` on its pending records, where phase 1 left them `pending`.

This is hard to reverse because record kinds and shapes are protocol, and hands-off goals (after phase 2, ADR 0026) build on `decidedBy`. A settled record shows in the transcript as one line naming who decided and why (`docs/phase-2/notes/briefs.md`).

Decided by the user on 2026-10-27, from the phase 2 area notes.

Gate evidence so far (package 1A, 2026-10-28): `apps/server/src/brain/CairnDocs.test.ts` opens a store written by phase 1's version 1 definition (five records in `fixtures/approvals-v1.json`), reads them back as version 2 with every version 1 field kept, the new fields null and `route` `user`, `decidedBy` read from the status (full access where `answeredAt` equals `askedAt`, else the user; `expiry`; none while pending), decodes the result with the protocol's `ApprovalsDocument`, and after one answer finds phase 1's definition refused by the store ("newer version 2 than 1"). A migration that passes version 1 through fails it. Conformance `approval_declined_with_reason` and `approval_cancelled_on_stop` failed on both harnesses before the change (4 of 4) and pass on both after it. `judges/thread-states.test.ts` passes. Left for the integration to accept.
