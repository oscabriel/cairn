---
status: proposed
gate: J-spend and J-budget from `docs/phase-2/notes/models.md`
---

# Dollar figures are list prices, labelled, and unknown is not zero

pi-ai's cost is a list price, not a bill, and every provider the user has is a plan: the bridge records zero, OpenCode Go and Codex are subscriptions. So every dollar figure on screen is labelled "at API list price" unless a provider is metered, and Claude's tokens are shown as that labelled equivalent so one dollar budget spans every role. A model without a price counts tokens only and is shown as unpriced, never as zero.

Spend is a derived cache recomputed from each conversation's `pi.usage` document, so a `kill -9` cannot double count. When a budget is reached, a workflow aborts its running nodes, keeps their partial results and offers a raise as an approval; a goal thread's own subagents stop taking new work and let running children finish. Overshoot is at most one response per running child, and the card says so.

Decided by the user on 2026-10-27, from the phase 2 area notes.
