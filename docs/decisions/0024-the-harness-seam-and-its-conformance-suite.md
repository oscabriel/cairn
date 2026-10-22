---
status: accepted
gate: harness conformance on both sides, and the mutation check
---

# The harness seam and its replay conformance suite

The harness seam is one thread-keyed service (`HarnessSeam`): ensure a thread, configure it, submit input (idempotent by request id), stop with or without clearing the queue, withdraw a queued input, answer an approval, watch the projected view, page history, and one global stream of committed events from pi-durable's `subscribeCommits`, with `RunTerminal` as the only completion signal. It is t3code's provider adapter reduced to what a durable in-process loop needs; t3code's event vocabulary is not ported. Two implementations sit behind it: `PiDurableHarness`, the real one, and `ScriptedHarness`, an independent in-memory implementation that plays scripted transcripts and gives the UI a deterministic backend. One suite of NDJSON scenarios judges both, with expectations written by hand from the seam's contract (what t3code and the kickoff require) rather than recorded, so the suite judges pi-durable instead of replaying it; recorded goldens only detect drift.

Gate: the conformance suite passes against both harnesses, and the mutation check (a broken scripted harness, and a wrapper around `PiDurableHarness` that drops `RunTerminal`, reorders events, loses a queued input and skips the snapshot on `watch`) fails at least five scenarios on each side.

Gate passed: the conformance suite passes against both harnesses and the mutation check (with its unmutated control) fails 18 of 18 scenarios on each side, every mutation alone at least 8 (wave 1, kept in `pnpm check` since, green again at the wave 3 integration on 2026-10-22). Accepted.
