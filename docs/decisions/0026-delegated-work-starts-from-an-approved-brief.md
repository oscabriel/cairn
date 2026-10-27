---
status: proposed
gate: phase 2's five-node workflow, run from the phone, starts no subagent or stone without an approved brief, and a brief left pending across a brain restart is answered exactly once
---

# Delegated work starts from an approved brief

Phase 2 adds subagents and workflows. Every outside source read for it (pi-subagents, HumanLayer, MonoCode, Ultimate, Fold and Greg Schier's screenshot; `agent-artifacts/cairn/v2/outside-lessons/`) lands on two tiers: a long-lived conversation where the user discusses and decides, and short delegated units that do the work from a written brief. The alternative was pi-durable's example 23, where any thread spawns subagents with no brief and no goal. That would have needed a gate added later, once delegated work already ran without one.

So a subagent or stone starts only from a brief: what to do, why, and how its result will be judged. The brief is an approval (ADR 0013) with a typed payload, so "Go" can be answered from the phone and survives a restart.

A goal is a thread with stated criteria that owns the subagents and stones working toward them. It is still a thread, as a stone is, not a separate kind of row. A thread without criteria can still delegate, and its children still start from briefs.

Consequences:

- Every approval records who decided it and why. Hands-off goals, where something other than the user answers a brief, come after phase 2; with those fields and criteria that name outside judges, they need no schema change. Nothing but an outside judge marks a criterion met.
- "Task" stays pi-durable's word; the delegated unit is a subagent or a stone.
- A workflow's launch approval is an envelope: node briefs that fit it are approved by it and recorded as such, and a node outside it asks (ADR 0032).
- The brief, its Go and its record are specified in ADRs 0029 and 0030; a brief waits for Go in every permission mode.

Decided by the user on 2026-10-27.
