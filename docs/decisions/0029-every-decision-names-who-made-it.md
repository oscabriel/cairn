---
status: proposed
gate: a migration test over a version 1 fixture, and `judges/thread-states.test.ts` with the new statuses
---

# Every decision names who made it

Approval records move to version 2 of `cairn.approvals`. Every record carries `decidedBy` (the user, an envelope, later a proxy), a `reason`, the `answer`, and a frozen `payload` that never changes after the record is written. New kinds `brief` and `criteria` join `executor-call`, `tool-call` and `user-input`, and a new status `revised` covers a brief sent back with notes. A status leaves `pending` once. Stopping a thread now writes `cancelled` on its pending records, where phase 1 left them `pending`.

This is hard to reverse because record kinds and shapes are protocol, and hands-off goals (after phase 2, ADR 0026) build on `decidedBy`. A settled record shows in the transcript as one line naming who decided and why (`docs/phase-2/notes/briefs.md`).

Decided by the user on 2026-10-27, from the phase 2 area notes.
