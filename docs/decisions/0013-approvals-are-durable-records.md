---
status: accepted
gate: S4
---

# Approvals are durable records

pi-durable has no "wait for a human" primitive, and its hooks may only block or rewrite. So an approval is a record in a session document (`cairn.approvals`), modelled on t3code's `runtime_request`. The gated tool commits the record, then waits until a host commit answers it or it expires. The answer is that one commit, from any device.

In pi-durable 1.3.0 the waiting task is the tool task itself, declared `replay: "safe"`: 1.3.0 has no durable sleep and no external wait, so the wait lives in memory, and a restart reruns the tool, which finds its record and waits again. 1.3.0 has no restart limit either, so a long wait across many restarts is never parked. When pi-durable gains durable sleep, the wait can move into a sleeping task without changing the record.

The effect after an accept is an intent, effect, outcome sandwich: the record is marked `started` before Executor is called, and a rerun that finds the mark reports "may have run" without calling again.

Cairn's approval is the only question the user sees. When Executor asks for approval on a call Cairn already approved, or in full access, Cairn answers Executor's prompt in the same tool call, so Executor's 10 minute window never waits on a person. Its request ID is recorded first, and on boot Cairn declines every one whose call never finished, so a late accept can't run it. Executor's own approval policies stay for its other clients.

Permission modes follow t3code's, defaulting to full access, which asks for nothing.

Gate S4: an approval pending across a brain restart can still be answered from the phone and runs exactly once. Passed on 2026-10-21; measured in `spikes/4-approvals/NOTES.md`.
