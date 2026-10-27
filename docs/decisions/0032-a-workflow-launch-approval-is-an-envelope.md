---
status: proposed
gate: a five-node scripted workflow where four node briefs fit the envelope and one raises a card, and ADR 0026's gate run from the phone
---

# A workflow's launch approval is an envelope for its nodes' briefs

Resolves the question ADR 0026 left open. Go on a workflow approves an envelope: the script's hash, the roles and arms per call site, a node cap and a budget. A node brief that fits the envelope is approved by it and recorded with `decidedBy` envelope; a node outside it raises its own brief card. Every row of the workflow's dispatch ledger names an accepted brief, so "no child without an approved brief" is checkable in code.

The alternatives were a Go card per node, which buries a fan-out in cards, and a launch approval that replaces node briefs, which loses the per-node record. "Run on 1 item first" is a separate run with no caching.

Decided by the user on 2026-10-27, from the phase 2 area notes.
