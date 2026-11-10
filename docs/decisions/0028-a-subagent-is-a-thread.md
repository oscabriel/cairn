---
status: accepted
gate: phase 2's subagent scenario groups pass on both harnesses, and `judges/subagent-durability.ts` passes on a faux model and once on the bridge
---

# A subagent is a thread, and its result reaches the parent as a note

A subagent is a pi-durable conversation owned by a background anchor of its parent's conversation. It carries Cairn's thread identity and a shell row with a `lineage` (parent, root, relationship), hidden from the sidebar; the sidebar resolves it to its nearest ancestor that has a row, as the t3code nightly does. Steering, stopping, answering, the commit feed, the shell projector, `inspect()` and the bridge's hooks then work on a child unchanged. The alternative, conversations inside a thread, is what phase 1 reserved a `conversationId` for in the thread commands; it would leave the feed, `inspect()` and the bridge blind to children, so those reserved fields are removed.

A child's result is a closed settlement (outcome `completed`, `stopped` or `failed`; a required `divergence`; a payload validated against the brief's schema; the child's commit and branch). It enters the parent as a model-visible note, and waking the parent is a separate input that follows the parent's state in code: a parent the user stopped, or one that failed or parked, gets the note without the wake. Both are written by one reporter task per input to the child, keyed by request ids derived from the child and its settlement, so each lands exactly once across `kill -9` (measured at five crash points, `docs/phase-2/notes/subagents.md`). A stop can lose a wake, never a result.

Stopping a parent does not stop its children; its row offers Stop all. A completion wakes the parent by default. Depth is capped at 2 and live children at 8 per parent until the fan-out judge measures them.

Decided by the user on 2026-10-27, from the phase 2 area notes.

Accepted at the wave 4 integration (2026-10-29). Gate evidence on `main` after the merges: the subagent scenario groups pass on both harnesses (green `pnpm check`); `node judges/subagent-durability.ts` passes 10 of 10 on the faux model with all 5 controls failing rightly (by double delivery only), and `--bridge` (bridge-reporter-answered) passes on claude-haiku-5-5 in 11 s, 2 lives and 1 kill, on the Claude Code plan.

Amended on 2026-11-09 (review finding O-2): archiving or deleting a thread, like clearing a scratch thread and refreshing a project thread, stops its working subagents first (Stop all, `subagents: "stop"` in `ShellHandlers.ts`), and so does deleting a project for each thread it removes. Stopping keeps its children working because the parent's row stays to offer Stop all; a removed thread's row is gone, and a child cannot be archived on its own. Judged by `ShellHandlers.test.ts` (each removal passes `stop`) and the conformance scenario `subagent_stop_all` (a stop with `stop` ends the working child's run and settles its row).

Amended on 2026-11-09 (review of O-2): a Stop all also holds the stopped thread's wakes (`cairn.wake-hold`, written before any child stops) until a run starts after its newest one. A parent whose last run had completed was not halted, so its stopped children's results woke it, and a removed thread started a run with no row to stop it from. The results still land as notes; the user's next input ends the hold. Judged by the conformance scenarios `subagent_stop_all_idle_parent` and `subagent_removed_idle_parent_not_woken` (the child settles, the parent never runs again).
