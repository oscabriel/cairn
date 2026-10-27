---
status: proposed
gate: `judges/brief-go.sh` over all ten windows (kills before, inside and after the commit, and a three-way race) and the five-kill parked case
---

# Go is the commit that starts the child

Answering a brief with Go flips the record to `accepted` and creates the task that starts the child in the same pi-durable transaction. The start is idempotent by brief id, so however the brain dies, a brief yields one worktree, one child conversation and one first input (measured in ten cases, `docs/phase-2/notes/briefs.md`). The child's first input is built from the approved record, so edits made at Go are what the child receives.

If the start task parks after repeated crashes, it waits for a human Retry on the parent; it is not retried at boot, because a parked start means something in the spawn path is broken. A brief always waits for Go, in every permission mode, including full access. A pending brief expires after 7 days and the parent is told.

Decided by the user on 2026-10-27, from the phase 2 area notes.
