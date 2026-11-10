---
status: accepted
gate: harness conformance on both sides, and the mutation check
---

# The harness seam and its replay conformance suite

The harness seam is one thread-keyed service (`HarnessSeam`): ensure a thread, configure it, submit input (idempotent by request id), stop with or without clearing the queue, withdraw a queued input, answer an approval, watch the projected view, page history, and one global stream of committed events from pi-durable's `subscribeCommits`, with `RunTerminal` as the only completion signal. It is t3code's provider adapter reduced to what a durable in-process loop needs; t3code's event vocabulary is not ported. Two implementations sit behind it: `PiDurableHarness`, the real one, and `ScriptedHarness`, an independent in-memory implementation that plays scripted transcripts and gives the UI a deterministic backend. One suite of NDJSON scenarios judges both, with expectations written by hand from the seam's contract (what t3code and the kickoff require) rather than recorded, so the suite judges pi-durable instead of replaying it; recorded goldens only detect drift.

Gate: the conformance suite passes against both harnesses, and the mutation check (a broken scripted harness, and a wrapper around `PiDurableHarness` that drops `RunTerminal`, reorders events, loses a queued input and skips the snapshot on `watch`) fails at least five scenarios on each side.

Gate passed: the conformance suite passes against both harnesses and the mutation check (with its unmutated control) fails 18 of 18 scenarios on each side, every mutation alone at least 8 (wave 1, kept in `pnpm check` since, green again at the wave 3 integration on 2026-10-22). Accepted.

Amended on 2026-11-09 (product review T-7): the seam covers the thread loop: ensure, configure, submit, stop, withdraw, answer an approval, write a passive entry, compact, watch, read a document, page history, read an entry and its images, inspect, and the event stream, with subagent delivery, routing and stop as the subagent scenarios judge them. Phase 2's features above that loop use pi-durable directly, by decision (S42 lets pi-durable into their folders), and have one implementation, so the scripted brain runs without them: a browser judge on the scripted brain proves the view over hand-written documents, not these features, and says so in its `proves` text in `judges/index.ts`. They are pi-durable only:

- workflows: launch, nodes, budgets, stop (`WorkflowStops`) and their boot repairs;
- goals: judge runs, and in the dev brain the goal service itself (`GoalBook.layerOff`; the judges' scripted brain binds and marks through `GoalBook.layerScripted`, but runs no judge);
- budgets and spend: `BudgetSources`, `SpendFeed`, the budget halt and its notices;
- subagent tasks: the reporter, start and tell tasks' boot repairs and child workspace repair, and the rows `SubagentRows` reads from pi-durable;
- durable events and their reactors (`EventReactors`, ADR 0033);
- Executor's extension and sweep, the question route's own reads, the crash limit and `CairnDocs`' boot repairs.

Amended on 2026-11-09 (product review T-5): the suite now calls every read the seam has. `expect_history`, `expect_entry`, `expect_entry_image` and `expect_inspect` lines judge `history`, `entry`, `entryImage` and `inspect` against hand-written expectations on both harnesses, and three read mutations (a history page that drops its newest entry, an `inspect` that hides each thread's oldest pending record, an entry read that returns its neighbour) must each fail at least two of the scenarios that make that read. `retry` left the seam with pi-durable 1.5 (ADR 0046), so the suite has nothing to call there.
