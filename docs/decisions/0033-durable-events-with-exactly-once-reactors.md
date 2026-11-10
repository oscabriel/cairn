---
status: accepted
gate: `judges/events-kill.sh` with at least ten kills and injected handler faults, and the phase 2 gate's workflow using events for its meter and its push
---

# Durable events with exactly-once reactors

Facts with several consumers (a node finished, a child's result, an approval answered, a brief approved) are entries in one ownerless pi-durable conversation, appended in the commit of the change they describe. Each reactor keeps a cursor that advances in the transaction of its handler, so the reactor's database writes happen exactly once across crashes. A handler may only write through the transaction and create pi-durable tasks; outside work is those tasks, with idempotent request ids. The shell projector stays derived, as ADR 0020 has it.

Ported in intent from Ultimate's `server/events.ts` (HazAT/ultimate `8b263386`, MIT). Measured on a probe: six `kill -9`s plus injected handler faults, 200 of 200 events handled exactly once (`docs/phase-2/notes/workflows.md`).

Decided by the user on 2026-10-27, from the phase 2 area notes.

Evidence (7B, 2026-10-30): `judges/events-kill.sh` passes, 12 kills with 112 injected faults and 10 kills across a rotation, every (event, reactor) once, 200 tasks once, the in-memory control failing by duplicates. Its events no longer use `workflow.budget.soft`, which the production budget reactor (5B) now reads. Stays proposed: the second half, the gate workflow using events for its meter and push, is judged by the phone run on the deployed brain, which is the user's.

Phone run (2026-10-30, deployed brain at `29cf38d`): the council ran from the phone, but whether its locked-phone approval push arrived is not yet recorded, so the gate's push half is unshown and the status stays proposed.

Evidence (locked-phone push, 2026-10-30): the user confirmed that the council's approval push arrived on the locked iPhone during the phone run, the push half of the gate; with `events-kill.sh` above, the gate passes.

Amended 2026-11-09 (review fix C2, finding O-4): exactly-once holds for events that can be handled; an event that cannot is dead-lettered once. After five failed steps in a row on one event (about 1.5 s of backoff), or at once when the step throws `UnreadableEvent` (an entry that is not a well-formed event, or data a handler cannot read at its version), the host moves the reactor's cursor past the event in one commit that writes a dead letter with the error (`cairn.event-dead-letters`), and the reactor goes on. Each dead letter is logged (`event_dead_lettered`), shows as the reactor's last failure in `workflow.eventStatus` (read back from the letters after a restart; the newest 200 letters are kept), and is pushed through the notifier: a reactor's letters within five seconds of the first go out as one push that counts them, so a run of bad events is one notification and none is left out. The budget reactor reads its events by version (`event.v`), so one it cannot read is passed at once, never retried. Judged by `EventReactors.test.ts`: the 7B incident replayed (50 budget events the reactor cannot read, then a real soft line: each passed on its first failure and the line handled) and a handler that never passes an event (dead-lettered after five failures, the next event handled); the status line after a restart there, and the push batching in `WorkflowPushes.test.ts`.
