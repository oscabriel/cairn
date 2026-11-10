---
status: proposed
gate: `judges/budget-kill.ts` and `judges/workflow-budget.ts` planting their budgets through the production paths (the first through `budget.declare`'s handler, the second through Go with the launch card's budget on `thread.respond`'s answer path), each passing with its controls failing, plus the user's phone run (a default set on the usage page, a brief and a launch whose budgets are changed on the card before Go, a thread budget set from its row, and a raise answered)
---

# The user sets the budget

ADR 0036 put a dollar meter and a hard line on every scope, and ADR 0032 made Go approve "a node cap and a budget". Both held in the judges and not in the product: the review of 2026-11-09 (finding O-1) found that nothing the user controls could set a budget. A subagent's brief always froze `DEFAULT_BUDGET` (every limit null), `subagent_spawn` took no budget, a thread or goal budget came only from `Budgets.declare`, which had no caller outside tests and judge fixtures, the server setting `defaultBudget` was stored and drawn and read by nothing, and the launch card had no field for the budget the server already accepted with Go. So a workflow had a budget only when its model volunteered one, and ADR 0036's gate passed through a path production lacked: `judges/budget-kill.ts` declared its scope straight on `Budgets`, and `judges/workflow-budget.ts` planted its line on an approved ledger row.

## How a budget is set

Three hands set a budget, each over the one before:

- The default. The server setting `defaultBudget` is the budget a brief or a launch starts from. `subagent_spawn` and `workflow_plan` read it when they propose (`usage/DefaultBudget.ts`), and the approval record freezes the result, so the card shows what will run and a later change to the default moves no budget already asked. The usage page changes it (Change default budget, through `settings.update`).
- The model. `subagent_spawn` and `workflow_plan` take `max_tokens` and `max_usd`; each limit the call names replaces the default's, the rest come from the default.
- The user. A subagent's brief card and a workflow's launch card have a budget field (Change budget). Go, and Run on 1 first on a launch, carry the changed budget as the answer's `launch` (`LaunchEdits`), beside the untouched payload. A launch's row takes it in the answering commit (`applyLaunchAnswer`, as before); a subagent's scope reads it from the answer before the payload (`BudgetSources`). This is the one edit before Go that phase 2 now has; "Edit and Go" stays out for everything else. A thread takes a budget of its own from its row on the usage page (Set budget), through the new RPC `budget.declare`: a `stop` scope over the thread and its lineage subtree, declared through the budget guard, so a thread already past the new line stops at once.

A declare replaces the raises accepted before it and declines a raise still pending for the thread, in one commit, and counts an epoch of its own, so the raise and notices asked after it have ids none asked before had. A goal's `drain` scope rides the same `declare`, but nothing calls it with `drain` yet: a goal's budget needs a goal-aware caller (the goal card or a goal tool), which is not in this change.

## What Go approves

Go approves the budget the card shows. The Budget line reads the proposal's budget, or the one the user set ("$0.75 at API list price, 120,000 tokens (changed from $2.00 at API list price)"), and it reads "No limit" only when neither the call, the default nor the user set one, which is then what runs.

## Which limits are real

Two limits are offered and enforced everywhere: dollars at API list price (priced tokens only, ADR 0036) and tokens. A raise's card names its scope by title (the thread's, or the workflow's name), reads what it had spent against its line when it was asked, and the line proposed, with Decline and Approve only; it is not a tool, so it has no "Allow for this thread".

Not offered: turns, minutes and a plan window guard. The schema keeps `maxTurns`, `maxMinutes` and `planGuard`, and a workflow's meter still enforces turns and minutes when a launch carries them, but nothing in production sets them: the default, the model's call and the card offer dollars and tokens only, and a proposal carries no turn, minute or plan-guard limit from the default. `planGuard` is enforced by no code. So no card, meter or usage line shows any of the three.

## Evidence so far

Unit level (2026-11-09, faux model, $0): `Briefs.test.ts` and `SubagentModelsPiDurable.test.ts` (a spawn's brief freezes the default, and each limit the call asks over it, through the production subagents layer and `SettingsStore`), `WorkflowLaunchFlow.test.ts` (a launch its model gives no budget carries the default in its payload and row, and the script reads it), `CairnDocs.test.ts` (Go on a subagent's brief takes a budget edit; Decline, Send back and Run on 1 first do not), `BudgetSources.test.ts` (a subagent's scope is the budget set at Go; a declare replaces earlier raises, declines a pending one and starts an epoch), `SpendHandlers.test.ts` (a thread budget set through `budget.declare` stops the thread and its subtree at its line and asks a raise), and the card and usage page scene tests (`BudgetCard.test.ts`, `Meters.test.ts`). The judges are extended in code and not yet run: `judges/fixtures/budget/BudgetBrain.ts` declares its scope through `declareBudget`, and `judges/fixtures/workflows/BudgetBrain.ts` plants its launch pending with no budget and answers it Go with the card's budget through `answerApproval` and `launchAnswered`, which `judges/workflow-budget.ts` now checks is the line the run was held to. The status moves to accepted when both judges pass on `main` and the user's phone run is done.
