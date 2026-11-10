---
status: accepted
gate: `pnpm check` green with no role table, `roles` tool or Roles section left; a subagent brief and a workflow node that name no model run on the parent's model and level, and one that names `provider/modelId` runs on it; a brief that names a model with no usable credential is refused at the ask with the reason; the workflow judges (`workflow-kill.sh`, `brief-go.sh`, `council-typed.ts`) pass with envelopes keyed by model; a workflow from the phone whose nodes run on the launching thread's model
---

# A child names its model or runs on its parent's

Supersedes ADR 0035 and amends ADR 0032.

ADR 0035 gave Cairn role aliases: a global table from names (`@worker`, `@scout`, `@judge`, `@verifier`) to a model, a thinking level and up to four fallbacks, which briefs, workflow scripts, recipes and goal judges named instead of a model. The user decided (2026-11-02) that this is a table nobody should have to keep: a model chosen ahead of time, under a name, for work that has not been described yet.

t3code's orchestrator (upstream `main` at `3c59595`, `apps/server/src/mcp/OrchestratorMcpService.ts`) has no such table. `delegate_task` takes an optional target; with none, the child runs on the parent's provider, model and options. The agent learns what it may pick from `orchestrator_capabilities`, a live list of the parent's selection and each provider's models and options, and its instructions say to change the model only when the user asks and to say so when a model is unavailable. Its `role` field is a task kind (`review`, `test`) that only prefixes the brief, and picks no model.

## Decisions

1. **No roles.** The role table, its setting, the `roles` tool, the `roles.check` RPC and the Settings page's Roles section are removed. A brief, a workflow node, a recipe argument or a goal's model judge names a model as `provider/modelId[:level]`, or names none.
2. **None means the parent's.** A child that names no model runs on its parent's model and thinking level: a subagent on the thread that briefed it, a workflow node on the thread that launched the workflow, a goal's model judge on the goal thread's model. That includes `verify` nodes and the council's judge. A check from another model family happens when the user or the script asks for one, not by default.
3. **A named model is checked, not replaced.** A model must be in pi's catalog, have a usable credential, and be neither failing nor past a spent plan window. If it is not, the start is refused with that reason and the agent says so. There are no fallbacks and no family warning.
4. **A `models` tool replaces `roles`.** It lists the caller's own model and level and, per provider, the models a child can run on with their thinking levels and list prices, short by default with a search for the rest, after `orchestrator_capabilities`.
5. **The envelope is keyed by model** (amends ADR 0032). A launch approves, per call site, the model each node runs on (the launching thread's when the script names none), whether it writes, its arms, a node cap and a budget. A node brief fits when its model is one the launch showed for that call site.
6. **Old records still read.** Children already record their concrete model (ADR 0035 did that), so history is unchanged. A record written before this change that still holds a role name (a pending brief, a paused workflow's script) resolves as if it named no model.

Decided by the user on 2026-11-02.

Evidence: on `main` at `4c60024`, deployed 2026-11-03, `pnpm check` is green (2,670 tests) with no role table, `roles` tool or Roles section left; `SubagentModelsPiDurable.test.ts` covers a brief with no model, a named model, an unready model refused at the ask and a legacy role name; `subagent_spawn_with_model` passes on both harnesses; `workflow-kill.sh` passes and `brief-go.sh` holds 10 of 10 windows with envelopes keyed by model; look round 10 is frozen. `council-typed.ts` and the phone workflow run were not run: the user accepted this ADR on their word on 2026-11-03 without them.

Amended on 2026-11-09 (ADR 0055): decision 2 no longer holds for a goal's model judge. A judge that names no model would run on the goal thread's own model and grade its own work, so it is refused; the thread's own model judges only when the user names it for the judge. A subagent or workflow node that names no model still runs on its parent's.
