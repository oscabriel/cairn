---
status: proposed
gate: `judges/brief-go.sh` over all ten windows (kills before, inside and after the commit, and a three-way race) and the five-kill parked case
---

# Go is the commit that starts the child

Answering a brief with Go flips the record to `accepted` and creates the task that starts the child in the same pi-durable transaction. The start is idempotent by brief id, so however the brain dies, a brief yields one worktree, one child conversation and one first input (measured in ten cases, `docs/phase-2/notes/briefs.md`). The child's first input is built from the approved record, so edits made at Go are what the child receives.

If the start task parks after repeated crashes, it waits for a human Retry on the parent; it is not retried at boot, because a parked start means something in the spawn path is broken. A brief always waits for Go, in every permission mode, including full access. A pending brief expires after 7 days and the parent is told.

Decided by the user on 2026-10-27, from the phase 2 area notes.

Gate evidence, on `phase2/4A` (2026-10-29): `judges/brief-go.sh` over the production seam, brain and subagents extension in a judge brain (a scratch data folder and git repository, never `cairn.service`), killed with SIGKILL. All ten windows pass with one worktree, one plan row, one child conversation, one first input and one answer to the parent, or none of them when the brief stays pending or is declined: no kill; killed with the brief pending, then Go; killed inside the Go commit (still pending, no start task); Go again after that; killed after the commit, after the worktree, after the creating commit and after the first input; Go, Decline and Go at once (accepted once); Decline. The five-kill case parks the start task (`restart_limit`), a clean boot leaves it parked, and Retry starts the child once; with the start task put back into the boot retry, that case fails. The broken control, Go committed without its start and the start left to a second commit, leaves an accepted brief that never starts, and fails the judge as it must. Faux model, $0. The status moves to accepted at integration.
