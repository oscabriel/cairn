---
status: proposed
gate: the durability judge's mid-tool windows on a gated `bash`, and the briefs note's probe 2 (two kills, the effect never reruns)
---

# Permission modes gate through replay-safe wrappers with a memo mark

Phase 2 ships three permission modes that actually gate: Supervised, Auto-accept edits and Full access (the default). `auto` comes later. A pi-durable hook may only block or rewrite and cannot wait on a person, so the gate lives inside the tool: `write`, `edit` and `bash` become `replay: "safe"` wrappers that commit an approval, wait for its answer, then mark the effect before running it. A rerun that finds the mark reports "may have run" and never repeats the effect. This reverses phase 1's policy (D18) that those tools are `unsafe`. The mark costs 0.2 to 0.3 ms.

In Supervised mode an Executor program is approved once, with its code on the card, not per nested call. A child's mode is the narrower of its own and its parent's current mode, checked at each ask; a child never widens it. The thread's mode reaches the brain through the harness seam, and Executor's constant auto-accept gives way to the mode.

Decided by the user on 2026-10-27, from the phase 2 area notes.
