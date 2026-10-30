---
status: accepted
gate: a five-node scripted workflow where four node briefs fit the envelope and one raises a card, and ADR 0026's gate run from the phone
---

# A workflow's launch approval is an envelope for its nodes' briefs

Resolves the question ADR 0026 left open. Go on a workflow approves an envelope: the script's hash, the roles and arms per call site, a node cap and a budget. A node brief that fits the envelope is approved by it and recorded with `decidedBy` envelope; a node outside it raises its own brief card. Every row of the workflow's dispatch ledger names an accepted brief, so "no child without an approved brief" is checkable in code.

The alternatives were a Go card per node, which buries a fan-out in cards, and a launch approval that replaces node briefs, which loses the per-node record. "Run on 1 item first" is a separate run with no caching.

Decided by the user on 2026-10-27, from the phase 2 area notes.

Evidence for the first half of the gate, on `phase2/5A` (2026-10-29): the model proposes with `workflow_plan`, whose commit writes the `proposed` ledger row and the launch approval (the dry run's plan and its envelope, frozen); Go, Run on 1 first and Decline land in the answering commit (`launchAnswered`), and the card's edits travel in the answer. Every node gets its own brief record in the commit that dispatches it: accepted with `decidedBy` envelope when the envelope covers its role, whether it writes, the thread's mode and the node cap, or a pending card the node waits on otherwise. The scripted five-node workflow (four `@worker` nodes the plan shows, a fifth whose role the live data turns into `@scout`) raises exactly one card in `WorkflowLaunchFlow.test.ts` and in `judges/workflow-kill.sh`'s envelope cases (`envelope`, `envelope-declined`, `kill-in-launch-wait`, `kill-in-card-wait`: every node once, every dispatched row naming an accepted brief); the broken control, an envelope that covers every node, raises none and fails the judge. Faux model, $0. The phone half of the gate (ADR 0026's five-node, two-provider run) waits for wave 7, so the status stays proposed.

Evidence (7B, 2026-10-30): `judges/workflow-kill.sh` 22 of 22 including the envelope cases, its envelope control failing with 0 cards. Stays proposed until ADR 0026's phone run.

Evidence (phone run): on 2026-10-30 at about 19:50 UTC the user, from the phone and on the deployed brain at `29cf38d`, had the project thread launch the council recipe and answered its launch card (`decidedBy` user); six nodes ran (Advisor 1 pass 2 rerun fresh) on two providers, the bridge and OpenCode Go; with the 7B `workflow-kill.sh` envelope cases, both halves of the gate pass.
