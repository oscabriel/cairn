---
status: proposed
gate: a conformance scenario in which the project thread, asked for a code change, has no write tool and the change lands through a child it briefed; one in which a hands-on turn the user grants lets the project thread write for that turn only, and the transcript shows the grant; one in which a brief inside the standing approval starts with no Go card and names the standing approval as its decider, while one outside it raises a card; and a phase-3-sized task the user runs from the phone that ends with no write in the project thread's own turns
---

# The project thread coordinates

Today the project thread has every tool a thread has: `read`, `edit`, `write` and `bash`, code mode, Executor, the subagent and workflow tools, goals and `ask_user`. It has no instructions of its own, so it does the work itself. On 2026-10-31 the Cairn project thread built the model picker in its own turns, which filled its context with diffs and test output rather than the project's goals.

The user decided (2026-10-31, with the answers on 2026-11-01) that the project thread is a coordinator: its job is to hold the project's goals and keep that context clean, so it delegates all implementation and all review to other agents, which may launch workflows of their own, and it talks with those agents while they work. The rule is code, not a prompt. As with ADR 0027's routing, an instruction to delegate holds only until the model decides otherwise, while a tool set without writes holds every time.

This keeps ADR 0027's line. The coordinator is the user's own conversation, not a standing agent between the user and every child: the user still talks to it directly, can open, message, steer and stop any managed thread, and answers every approval that is not inside the standing approval.

## Decisions

1. **Hard, with a hands-on turn.** The project thread has no write tools: no `edit` or `write`. It keeps the read-only tools (`read`, `grep`, `find`, `ls`) and everything that delegates or asks. The user can grant a hands-on turn with an explicit word, which restores the write tools for that one turn and is recorded in the transcript; the model can never grant one itself. Rejected: instructions alone, which drift back to doing the work (the model picker), and no escape at all, which makes a one-character fix cost a subagent's round trip.
2. **A standing approval.** Each project has one: a budget, the roles the coordinator may brief, and whether each may write. A brief inside it starts without a Go card, recorded with the standing approval as its decider (ADR 0029). A brief outside it, or one past the budget, raises a card as today. Rejected: Go on every brief, which turns "always delegate" into a card per task, and no approval at all, which leaves nothing to stop a runaway.
3. **It reads diffs, children run checks.** The coordinator may read a child's diff and its verdicts to weigh the work against the goals; anything that runs checks (tests, the gate, a build) is delegated, because that output is what floods a context. Rejected: deciding on verdicts alone, which leaves it unable to see whether the work fits the goal, and reviewing as it does now.
4. **Phase 2.5.** It is built before phase 3's stones, so the coordinator drives stones from their first day: the instruction section, the filtered tools with the hands-on turn, and the standing approval. Two-way talk with workflow nodes is the large part and is a later step of its own.
5. **Only the project thread.** Scratch threads have no project to coordinate and managed threads are the coordinator's hands, so both keep every tool.

## Still to settle

- Whether `bash` stays. With it the coordinator can write after all; without it, it cannot run `git log` or `gh`, or read a diff with `git diff`, so decision 3 then needs a read-only way to see a child's diff.
- Who may change the standing approval, and whether an answer from the phone may widen it.
- A subagent may already call `workflow_plan`, untested and outside the depth cap. The later step makes the chain project thread, subagent, workflow, nodes, with the cap counting nodes, and gives two-way talk: a node's `ask_parent` reaches the subagent that launched its workflow, and that subagent can message a running node (ADR 0012's "coordinator thread of its own" spike).

Proposed on 2026-10-31; decisions recorded on 2026-11-01.
