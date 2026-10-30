---
status: proposed
gate: `judges/events-kill.sh` with at least ten kills and injected handler faults, and the phase 2 gate's workflow using events for its meter and its push
---

# Durable events with exactly-once reactors

Facts with several consumers (a node finished, a child's result, an approval answered, a brief approved) are entries in one ownerless pi-durable conversation, appended in the commit of the change they describe. Each reactor keeps a cursor that advances in the transaction of its handler, so the reactor's database writes happen exactly once across crashes. A handler may only write through the transaction and create pi-durable tasks; outside work is those tasks, with idempotent request ids. The shell projector stays derived, as ADR 0020 has it.

Ported in intent from Ultimate's `server/events.ts` (HazAT/ultimate `8b263386`, MIT). Measured on a probe: six `kill -9`s plus injected handler faults, 200 of 200 events handled exactly once (`docs/phase-2/notes/workflows.md`).

Decided by the user on 2026-10-27, from the phase 2 area notes.

Evidence (7B, 2026-10-30): `judges/events-kill.sh` passes, 12 kills with 112 injected faults and 10 kills across a rotation, every (event, reactor) once, 200 tasks once, the in-memory control failing by duplicates. Its events no longer use `workflow.budget.soft`, which the production budget reactor (5B) now reads. Stays proposed: the second half, the gate workflow using events for its meter and push, is judged by the phone run on the deployed brain, which is the user's.
