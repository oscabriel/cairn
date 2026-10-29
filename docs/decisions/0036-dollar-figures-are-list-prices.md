---
status: proposed
gate: J-spend and J-budget from `docs/phase-2/notes/models.md`
---

# Dollar figures are list prices, labelled, and unknown is not zero

pi-ai's cost is a list price, not a bill, and every provider the user has is a plan: the bridge records zero, OpenCode Go and Codex are subscriptions. So every dollar figure on screen is labelled "at API list price" unless a provider is metered, and Claude's tokens are shown as that labelled equivalent so one dollar budget spans every role. A model without a price counts tokens only and is shown as unpriced, never as zero.

Spend is a derived cache recomputed from each conversation's `pi.usage` document, so a `kill -9` cannot double count. When a budget is reached, a workflow aborts its running nodes, keeps their partial results and offers a raise as an approval; a goal thread's own subagents stop taking new work and let running children finish. Overshoot is at most one response per running child, and the card says so.

Decided by the user on 2026-10-27, from the phase 2 area notes.

Gate evidence (package 4E, 2026-10-29). J-spend: `judges/spend-kill.sh` passes (12 kills over 48 turns, 96 responses, 0 failures; control failed by double counts only); its last life now retries what the kills parked, and with `--quick` (kills 50 to 150 ms after producing) 4 parked tasks were retried and the case passed, while the same run without the retry never finished. J-budget: `node judges/budget-kill.ts` passes in each of five runs of its kills case: ten faux children under a `stop` budget of four children's worth (102,000 micros at list price, 3,950 micros a response), killed twice at random and once inside the guard's stop pass, overshot by 700 to 20,450 micros against an allowance of 43,450 (the crossing response plus one per running child); no child answered after the restart, the stopped notice appeared once, at most one push went out, the row read exhausted, and after the raise was answered as the user the row read within and a child sent more work answered. Its controls fail for their reasons: a guard that stops nothing overshot by about 210,000 micros, and a brain without the boot repair let 5 children answer after the restart. Overshoot here is "the response that crossed the line plus one in flight per running child", which is how the card should word it.
