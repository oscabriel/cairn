# Phase 2 notes: workflows, the dispatch ledger and durable events

Scope: workflows as durable scripts on pi-durable 1.4.0 (ADR 0012): the script API, the dispatch ledger, approval before launch, budgets, stopping, the council recipe, the steps panel's data, and the durable events with exactly-once reactors that the backlog proposes as an ADR. Subagent spawning and delivery belong to the "subagents" note, briefs and the approval card to the "briefs" note, role aliases and prices to the "models and cost" note; this note says what it needs from each. Nothing in this file was written to source. Two probes ran in `/tmp/workflows-probe` against the installed 1.4.0 packages and are described under "Probes" so they can be rerun.

## Summary

- **Spike 3 proved the core and little else.** A four-node script survived `kill -9` mid fan-out with every node once, an approval waiting and a 16 minute job (`spikes/3-workflows/NOTES.md`). It used scripted models, one fixed script, raw `tools.*` calls and no budgets, schemas, UI or per-node stop. This note designs what a real workflow needs on top and says which parts are still unmeasured.
- **Stopping one node does not break replay.** In a probe (five `kill -9` cases around `abortTask` on one nested call, including a kill inside the window between the abort mark and the node seeing it) the script got a rejection ("Tool node was aborted"), the other nodes and the code after the fan-out ran, and no node reran. That answers the question carried from ADR 0012: offer per-node stop, and let the prelude turn it into `null` as Claude Code does.
- **Time and randomness are allowed, because the sandbox is deterministic by journal.** pi-codemode replays `Date.now()` from the clock of the result being processed and `Math.random()` from a recorded seed (`pi-codemode/README.md`, "Deterministic runs"). Claude Code throws instead. Cairn keeps the sandbox's behaviour and tells the model that time stands still while the script computes.
- **The API is a prelude, not new tools.** `agent`, `parallel`, `pipeline`, `phase`, `log` and `budget` are a fixed JavaScript prelude over six nested tools, injected by a `beforeTool` hook that also strips `export const meta`. A probe killed the brain mid fan-out under this rewrite: the hook ran once, every node started once, and the rewritten script was what replayed. ADR 0012's `parallel` tool stays unneeded: `parallel` and `pipeline` are plain `Promise.all` code in the prelude.
- **The ledger is not what stops double dispatch.** pi-durable already does that: a nested call is found again by key, a subagent by `scanConversations({ownerTaskId})`, a submission by request ID (spike 3, `brain.ts:147-170`). The ledger is the record that outlives them (nested results are deleted when the script's call is terminal) and holds the intent written before an effect pi-durable cannot deduplicate, which stones and `integrate` will need in phase 3. It is one conversation document, `cairn.workflows`, and it is also the steps panel's data.
- **The launch approval is the brief of every node it covers** (recommended; ADR 0026's open question). Go on a workflow approves a grant: the script by hash, the role and arms of each call site, a node cap and a budget. A node inside the grant starts without asking; one outside it raises its own brief approval. Every ledger row names an accepted brief, which the gate in ADR 0026 can judge in code.
- **Budgets are ceilings on tokens first.** The bridge reports zero cost for Claude (`packages/bridge/src/ClaudeModels.ts:5`, `:180`), so a dollar budget would not see Claude at all. A budget has `tokens` and optional `usd`; spend is the sum of the nodes' `pi.usage`. At the hard ceiling the brain refuses new nodes and aborts the running ones, and the refusal is a ledger row, so a replay reads it instead of recomputing it.
- **Durable events are worth an ADR, narrowly.** Ultimate's `server/events.ts` (MIT) keeps events as entries in one ownerless conversation and advances each reactor's cursor in the transaction of its handler. A probe of that design survived six `kill -9`s plus injected handler faults with 200 of 200 events handled exactly once. The refinement for Cairn: handlers write only through `tx` and start outside work as pi-durable tasks created in that same transaction, because a commit callback must never await anything.
- **Code mode's four script slots are the wrong shape for workflows.** `MAX_WORKERS = 4` (`apps/server/src/brain/CodeMode.ts:41`) is shared by every thread, and a workflow script holds its slot for its whole life, idle in `await`. Four long workflows would block every other thread's code mode. Workflows get their own slots.
- **The council recipe is the natural phase 2 gate workflow.** With two advisors it is five nodes: two independent reports, one claim matrix, two cross-examinations. Advisors on Claude and on OpenCode Go or Codex make it a two-provider run, and its typed reports exercise the typed-results target. It needs one thing `agent` does not yet have: `resume`, to send a second input to a settled node's conversation.
- **A pi bump while a workflow runs kills the workflow.** A rerun refuses to replay when `CODEMODE_MODULE_VERSION` (2 today) differs, or when the VM fingerprint does (`pi-durable/docs/spec.md` section 7.6). The deploy script must refuse or warn when a workflow is running and the pin moves.
- **Unmeasured:** real models writing and running workflows, a script that diverges on replay, the dry-run estimate against actual cost, and a workflow across a pi bump.

## Facts with evidence

### Pins

| Source | Pin | Notes |
| --- | --- | --- |
| Cairn | `e73dd9c` on `main` | Ground truth for what exists. |
| pi (pi-durable, pi-codemode, pi-ai, chord) | `v1.4.0`, commit `4a080252` | Installed under `apps/server/node_modules/@earendil-works/`; `packages/durable/docs/spec.md` read from a clone at the tag. |
| Ultimate (HazAT) | `8b263386`, MIT | `server/events.ts`, `shared/events.ts`. |
| pi-subagents (nicobailon) | `1a80e24`, MIT | `skills/council-mode/`, `docs/workflows.md`. |
| MonoCode (hardbeat920) | `26465c62`, MIT | `src/features/orchestration/model/orchestrationState.ts`, `orchestration.ts`. |
| t3code | `fe27e8e3` | Through `docs/phase-2/notes/t3code-nightly.md`, whose citations were re-checked. |
| Claude Code workflow semantics | `~/.agents/skills/claude-workflow-authoring/SKILL.md`; research 06 section 2.5 | The reference for the API's meaning. |

### What spike 3 proved and left out

- Proved (`spikes/3-workflows/NOTES.md`, judge cases in `judge.sh`): a script runs in `CodemodeSandbox({ timeoutMs: Infinity })`; `agent` and `approve` are `callers: ["tools"]`, `replay: "safe"` tools; `agent` creates a task-owned child conversation, finds it again by `scanConversations({ ownerTaskId })` and submits with `requestId: agent:<taskId>` (`brain.ts:147-170`); two `kill -9`s and a 16 minute job gave each effect once, with restart to reattach in 17 ms; five crashes in a row park the waiting tasks and a host `retryTask` resumes them with no node rerun; a clean SIGTERM never counts; an abort stops the job's systemd unit. Brain RSS with one workflow waiting was 123 to 150 MiB.
- Left out (its own "Not covered" and "Noticed"): a script that diverges on replay, real models writing workflows, structured results validated against a schema (the child there returns scripted JSON), budgets, any UI, per-node stop, a script's own `timeout_ms` beyond "refuse it", and a failed node cancelling the other nested calls (noticed, not judged).

### pi-codemode and pi-durable behaviour that shapes the design

- **Deadline.** `timeoutMs` defaults to 300,000 ms "including time spent in tools"; `Infinity` disables it (`pi-codemode/dist/types.d.ts:117-121`). A script's `// @options: {"timeout_ms": N}` is stored as a deadline at start, and a rerun after it fails (spec 7.6). Cairn already sets `Infinity`, parses the options line and blocks a script that sets `timeout_ms` (`apps/server/src/brain/CodeMode.ts:47-76`, `:195-225`). A wait must therefore be a nested tool, never a timer in the script; the VM has no timers (README, "Deterministic runs").
- **Replay.** The journal records each delivered result with the VM clock and the calls issued after it; a rerun delivers them in order and ends the call with a stored error when the module version, the VM fingerprint, a call's name or arguments, or an issued-call count differ (spec 7.6). Nested calls reattach by key; a nested call "interrupted by a crash before its result commits follows its own replay policy" (spec 7.3), so a node with external effects needs its own idempotency.
- **Nested results do not last.** "Every nested result is gone from storage once its caller is terminal" (spec 7.3). The nested task records stay queryable, with arguments, but nothing keeps a node's receipt or cost. This is the ledger's reason to exist.
- **Spend.** `pi.usage` is a per-conversation ledger of tokens and `Usage.cost` (`pi-ai/src/types.ts:459-480`); subtree sums are "application sums over `scanConversations()`" (spec 8.6). "A tool that runs an owned conversation must not report that conversation's usage in its result" (spec 12): the `agent` tool returns no `usage`.
- **Abort flows down.** Aborting a task marks everything it owns; an abort handler starts only after its owned work ended (spec 5.5). `abortTask(id)` on one nested call resolves when that task is terminal (the probe saw it return after a 5 second deaf window).
- **Footguns that bind this area** (spec 12): never await a model, process, network call or human inside a commit callback; reads such as `snapshot()` or `watchDoc()` inside a commit never resolve, read through `tx`; a buffered watch can omit intermediate states, so a consumer that must see every transition needs a journal; a task that owns live work stays `completing` until it ends.
- **Hooks.** `beforeTool(call, api, context)` may block or replace `arguments`, reads documents and memos, and must not wait (`pi-durable/dist/harness/types.d.ts:773-815`). `createCodemodeExtension`'s `globals` option is `@internal` (`dist/codemode/codemode.d.ts:163`), so Cairn does not use it.

### What Cairn has today

- `CodeMode.ts`: one shared `WaitingSandbox` (4 worker slots, 256 MiB VM memory), `models: false`, the `executor` namespace, and `deadlineGuard`. No workflow code exists; `apps/server/src/` has no `workflows/` folder.
- `CairnDocs.ts:84-126, 199-300`: the approval record (`toolTaskId`, `kind`, `summary`, `status`, `expiresAt`, the `started`/`done` sandwich) and `approvalLedger(api)`, an idempotent `ask`, `awaitAnswer`, `begin`, `finish` per tool task. This is the model for the launch approval and for the ledger's intent-then-effect rows.
- `CommitFeed.ts:1-22`: one `subscribeCommits` listener turns commits into harness events, "Events never replay across a process restart, so the shell projector reconciles at boot". Conversations that are not threads produce no events. Good for derived rows, wrong for "tell the parent a child finished" (Ultimate's report in the outside-lessons page).
- `ThreadWire.ts` whitelists the documents a client may see; `cairn.approvals` is on it, a `cairn.workflows` document would be added the same way.
- The bridge reports `cost: 0` on every Claude message (`ClaudeTokens.ts:81`, `ClaudeConversation.ts:213`): "the plan is the meter".

### The reference semantics

- **Claude Code workflows** (SKILL.md and research 06 section 2.5): a script opens with `export const meta = {name, description, phases}` as a pure literal; `agent(prompt, {label, phase, schema, model, effort, isolation, agentType})` returns the final text, or the schema-validated object, or `null` when the user skips it or it dies; `parallel(thunks)` is a barrier whose failed thunks become `null`; `pipeline(items, ...stages)` has no barrier between stages and is the default; `phase(title)`, `log(msg)`, `args`, `budget {total, spent(), remaining()}` as a hard ceiling that makes `agent()` throw; `workflow(name)` nests one level; limits of 16 concurrent agents, 4,096 items per call, 1,000 agents per run; the plan and raw script are shown before launch; "Large workflow" above 25 agents or 1.5M projected tokens; resume replays from cache and reruns from the first changed prompt.
- **pi-subagents** (`docs/workflows.md:56-146`): the same idea with `runs.run`, `runs.all`, `runs.lanes`, a `validate` action that checks a script without launching, `args` frozen in the sandbox, `usageBudget {tokens|costUsd: {soft, hard}}` that "rejects later child launches but does not stop children that are already running", and a structured `partial` outcome with reason `budget_exhausted` or `timeout`.
- **MonoCode's dispatch ledger** (`orchestrationState.ts:29-120`, `orchestration.ts:838-870`): a dispatch row with `state` (`starting | running | completed | failed | blocked | interrupted | cancelled | start_unknown | stop_unknown`) and `stage` (`accepted | session_prepared | turn_submitted | settled | integration_started | integrated | cleaned`), written before the external call; only the task's `activeDispatchId` may settle it, so a late result from an old attempt is dropped; a request table keyed by id with the input signature, so a resent request returns its first answer or fails if the input differs; a crash marks workers `interrupted` with a recovery prompt and replays nothing.
- **t3code's `local_workflow` rendering** (addendum, "Workflows"): a workflow is `{name, phases, agents}`; an agent has `index, label, childThreadId?, state: queued | running | completed | failed, phaseIndex?, model?, attempt?, totalTokens?, toolCalls?, durationMs?, prompt?, result?`; phases only grow; a phase is `pending` with no members, `running` while any member is live, else `done`; stop is "Stop entire workflow" only (`ThreadLineageWorkflowRow.tsx:144-169`).

### Probes

Both ran on 2026-10-27 on the Beelink, Node 26.11.1, against the worktree's installed 1.4.0 packages (a `node_modules` symlink to `apps/server/node_modules`), scripted models, loopback ports 3778 and 3779 (outside Cairn's 3773 to 3777).

| Probe | Judge | Result |
| --- | --- | --- |
| `/tmp/workflows-probe/node-stop` (`brain.ts`: spike 3's brain cut to replay-safe `node` tools; `judge.sh`) | `./judge.sh`, five cases, each in a fresh store, counting each node's `start` effect in `effects.log` outside the store | `stop`, `stop-kill` (kill -9 right after the node saw the abort), `kill-stop` (kill -9 mid fan-out, restart, then stop), `mark-kill` (kill -9 1.5 s after the abort mark, inside a 5 s window where the node ignores the signal) and `uncaught-stop-kill` (script does not catch, kill -9 after the stop) all PASS. a, b, c and d started once each; b never completed; the caught script returned `[ok, "Tool node was aborted", ok]` and ran d; the uncaught one ended "Script failed ... Tool node was aborted" and, after the kill, was not rerun. |
| Same folder, `brain2.ts`, `judge2.sh` | kill -9 mid fan-out with a `beforeTool` hook rewriting the script | The hook stripped `export const meta` and prepended `agent`, `parallel` and `phase` definitions over a nested tool; it ran once, not again on replay; six nodes (two phase markers, a, b, c, d) started once each; `Date.now()` returned a number. |
| `/tmp/workflows-probe/events` (`brain.ts`: Ultimate's core, a session document with the log conversation id, the cursor and per-event handled counts; `judge.sh`) | six `kill -9`s at 0.8 to 1.6 s while 200 events are produced at 15 ms intervals, then a clean finish; second run adds a handler that writes then throws once for every event id divisible by 7 | Both PASS: 200 events, 200 handled, every count 1; the second run logged 28 handler failures and none left a count of 2, so the rolled-back write and the cursor stayed together. |

Rerun: `cd /tmp/workflows-probe/node-stop && ./judge.sh && ./judge2.sh`, and `cd ../events && ./judge.sh`. The probes use faux nodes, not real children, and say nothing about real-model behaviour.

## Design for Cairn

### Modules

All under `apps/server/src/workflows/` unless named. Ports start with a header naming the source, path and commit, and the MIT notice (Ultimate, pi-subagents, MonoCode).

| Module | Purpose | Port source |
| --- | --- | --- |
| `WorkflowScript.ts` | Parse a script: split the options line, read `meta` as a pure literal (name, description, optional `whenToUse`, `phases[{title, detail?}]`), refuse `timeout_ms` and anything but `meta` exported, hash the source. A `validate` that never launches. | `parseCodemodeSource`; pi-subagents' `validate`; Claude's meta rules. |
| `Prelude.ts` | The fixed prelude text and its version: `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, `args`, and the constants the hook bakes in (`WORKFLOW`, `SAMPLE`). Plain JavaScript over `tools.*`. | Claude's script API. |
| `WorkflowPlan.ts` | The dry run behind the approval card: run the script in a sandbox with stub nodes (each `agent` resolves with a value built from its schema) and collect the call sites (role, label, phase, schema name, read-only or writer) and the node count; `unbounded` when it reaches a cap. Then the estimate. | `CodemodeSandbox.start` with host `tools` (README "Deterministic runs"). |
| `WorkflowDocs.ts` | `cairn.workflows` and its node rows. | `CairnDocs.ts` approvals; MonoCode's run and dispatch types. |
| `WorkflowTools.ts` | The extension: `workflow_plan` (model-callable) and the nested tools `workflow_begin`, `agent`, `verify`, `approve`, `phase`, `log`, `budget` (all `callers: ["tools"]`). | Spike 3 `brain.ts`. |
| `WorkflowGate.ts` | The `beforeTool` hook: rewrite an approved script, block nodes called from anything else. | `CodeMode.ts` `deadlineGuard`. |
| `WorkflowBudget.ts` | Spend, soft and hard ceilings, the estimate. | pi-subagents `usageBudget`; research 06 `budget {usd, tokens}`. |
| `WorkflowStop.ts` | `stopWorkflow` and `stopNode`. | t3code `orchestration.stopWorkflow`; the probe. |
| `recipes/council.js`, `recipes/index.ts` | Built-in scripts, listed and launchable by name. | pi-subagents `skills/council-mode`. |
| `brain/Events.ts` (not under `workflows/`) | Durable events: `emit(tx, token, data)`, a reactor host, cursor and status reads. | Ultimate `server/events.ts`. |

Also: a workflow slot pool next to `ScriptSlots` in `CodeMode.ts` (the sandbox's `start` is not told the thread, so the split is by script, see "Slots"); an extension entry in `ExtensionSet.ts` and `ThreadWire` whitelist entry for `cairn.workflows` (integrator-owned files).

### The script and the prelude

A workflow is a `codemode` call whose source starts with `export const meta = {...}`. The model writes the script after the user has approved its plan (below), so the shape is:

```js
export const meta = {
  name: "review-modules",
  description: "Read each module, then verify the findings",
  phases: [{ title: "Read" }, { title: "Verify" }],
};
phase("Read");
const reads = await pipeline(
  args.files,
  (f) => agent(`Read ${f}`, { role: "@reader", schema: FINDINGS }),
  (found, f) => verify(found, { role: "@verifier", claim: f })
);
return reads.filter(Boolean);
```

The hook rewrites it to a plain script body (QuickJS runs "an async function body", so `export` must go) behind the prelude. The prelude is fixed text with a version; the rewritten source is what pi-durable stores in the call's start data, so an old workflow replays with its old prelude after a Cairn upgrade (the probe: the hook ran once and the replay used the stored text).

- `agent(prompt, opts)` calls `tools.agent`. Options: `role` (an alias, resolved to provider and model at dispatch by the models note), `schema` (JSON Schema, object root), `label`, `phase`, `key` (stable label for the ledger and for `resume`), `readonly`, `resume` (a node's `nodeId`, to send it a further input: council pass 2), `effort`. It resolves with the validated value, or `null` when the node was stopped, refused or failed, as Claude Code does, so fan-outs continue. `agent.full(...)` resolves with the envelope `{status, value?, reason?, nodeId, usage}` for scripts that must tell a stop from a failure.
- `verify(result, {role, claim})` is `agent` with a fixed verdict schema, run in a fresh child with only the claim and the node's evidence; it exists so "writers get verified" (glossary) is one call and the ledger can mark a writer node verified or not.
- `approve({summary, options?})` is spike 3's approval node, built on `approvalLedger`; it is the only way a script asks the user, because a node cannot (below).
- `parallel(thunks)` is a barrier over `Promise.all` where a rejected thunk becomes `null`; `pipeline(items, ...stages)` runs each item through all stages with no barrier, a failed stage dropping the item to `null`; both are Claude Code's. In sample mode (below) `pipeline` runs the first `SAMPLE` items and `log`s what it dropped ("no silent caps").
- `phase(title)` and `log(msg)` are nested calls to `tools.phase` and `tools.log`, which write the workflow document idempotently, keyed by the call's task id. They cost a nested task each; a workflow has tens, not thousands.
- `budget` is `{ total, spent(), remaining() }`, where the two functions are nested calls to `tools.budget`, so each answer is journaled and a replay sees the value the live run saw. `total` is baked in.
- `args` is the launch arguments, frozen, plain JSON, shown in the approval.
- `Date.now()` and `Math.random()` work and are replay-safe. The model is told two things in the `codemode` section: time does not advance while the script computes, and a script that needs a real time reads it from an `args` value.
- **Limits** (Claude Code's, sized down): 8 concurrent nodes per workflow (a semaphore in the `agent` tool, in memory, reacquired after a restart), 1,000 nodes, 4,096 items per call, rejected rather than truncated.
- **Structured results.** `agent` passes `schema` to the child, which must end by calling a `submit_result` tool validated against it; two attempts, then the node fails `invalid_result`. The child spawn, the envelope and the retry loop belong to the subagents note; the workflow needs the envelope to contain `value`, `outcome`, `divergence` and `usage`, and a `resume` entry point.

### Launching: propose, approve, run

1. The model calls `workflow_plan({script, args?, budget?})`. It is a replay-safe tool and, like any gated call, its task is the wait (ADR 0013): it validates the script, runs the dry run, writes a `proposed` workflow row (`id = wf-<tool task id>`), creates the launch approval with the plan as its payload, and waits. Boot already retries tasks whose approval is pending.
2. The user sees (below) and answers Go, Run on 1 first, or Decline, from any device.
3. On Go the tool returns `{approved, workflowId, sample, budget}` and the row becomes `approved` with the decider and time. The model then calls `codemode` with the same script.
4. The hook (`beforeTool`, reads only) finds the `approved` row whose `scriptHash` equals the hash of the submitted source, rewrites it, and bakes in `WORKFLOW`, `SAMPLE` and `BUDGET`. Any other script that carries `export const meta`, or any call to a workflow node from a call whose parent is not a running workflow's script, is blocked with a plain refusal. The nodes check the same thing again, because a hook can be left out of a selection (spec 12, "guards left out of a selection").
5. The prelude's first line calls `tools.workflow_begin`, which moves the row to `running`, records the script call's task id, and fails if the stored approval or hash do not match. A forged `workflow_begin` in a raw script fails the hash check; that is a unit test.

Between 3 and 4 the model could change the script; the hash stops that. If the brain restarts between 3 and 4, the row is still `approved` and nothing is lost; nothing runs until the model calls `codemode`.

**What the user sees** (data; the look is the design pass's): the script's name, description and phases; the call-site table from the dry run (role, label, phase, schema, reads only or writes, how many times at most); the node count (or "at least N, depends on the data"); the estimate as a range with its basis ("12 nodes, about 2.1M tokens, from the last 9 `@reader` nodes"); the budget (tokens, optional dollars) and what happens at it; the folded raw script; the arguments. Three answers: Go, Run on 1 first, Decline. Run on 1 first sets `SAMPLE = 1`: `pipeline` takes one item, and `parallel` is untouched (its thunks are the script's own structure). It is a separate, full run that the user then follows with a second launch of the same script ("Run on all"); results are not carried over, because a cache of writer results is a staleness bug (an option for read-only roles is left for later). The estimate's accuracy is a judge, not a promise.

**How the launch approval relates to the nodes' briefs.** ADR 0026 says nothing delegated starts without an approved brief, and a workflow's nodes are built by code from data, so their prompts do not exist when the user decides. Options:

| Option | Gate | Cost |
| --- | --- | --- |
| A. The launch approval replaces briefs | One Go; nodes start freely | The ADR's rule ("no subagent or stone without an approved brief") becomes "except in workflows" and cannot be judged per node |
| B. Every node raises a brief | The rule is literal | Ten nodes means ten taps from a phone; fan-out stops being useful |
| C. The launch approval is a brief that grants, and nodes outside the grant raise their own | One Go for what the plan showed; the rule holds per node | A grant to define, and a node outside it waits for a person |

Recommendation: C. The brief's payload gets a `workflow` variant (script hash, call-site table, node cap, roles with mutability and arms, budget, sample). A node inside the grant records `briefId = <the workflow's approval id>`; a node that is not (a role the plan did not show, a writer where the plan said reads only, the node past the cap) creates its own brief approval as the first step of its execution and waits like any approval, with `briefId` its own. The judge is then mechanical: no ledger row without a `briefId` that names an `accepted` approval. The briefs note should carry the payload variant and the decisions `accept | accept_sample | decline`.

### The dispatch ledger

One conversation document, `cairn.workflows`, on the thread whose model launched the script (the same shape and lifetime as `cairn.approvals`), `{ items: Record<workflowId, WorkflowRecord> }`.

`WorkflowRecord`: `id`, `name`, `description`, `phases[{title, detail?}]` (declared) plus phases that appear at run time (append-only, as t3code's), `scriptHash`, `scriptRef` (an entry or file holding the source, not the source inline), `args` (cut), `state` (`proposed | approved | running | finished | failed | stopped | declined`), `outcome` (`complete | partial`, with `reason`: `budget_spent | stopped | script_error | replay_diverged`), `approvalId`, `decidedBy`, `decidedAt`, `sample`, `budget {tokens?, usd?, softFraction}`, `estimate {nodes, tokensLow, tokensHigh, basis}`, `codemodeTaskId`, `startedAt`, `endedAt`, `result` (a reference), `nodes: Record<nodeId, NodeRecord>`.

`NodeRecord` (one dispatch):

| Field | Meaning |
| --- | --- |
| `id`, `workflowId`, `key`, `label`, `phase`, `index` | `id = n-<node tool task id>`, stable across reruns of that task; `key` the script's stable label. |
| `requestId` | The idempotency key, `wf:<workflowId>:<id>`; also the submission's request ID. A resent dispatch returns the first row. |
| `briefId` | The approval that let it start (above). |
| `role`, `provider`, `modelId`, `effort` | The alias and what it resolved to at dispatch, recorded so a replay and the cost report agree after the user edits the alias. |
| `readonly`, `arms` | `host` or, in phase 3, a stone id. |
| `state`, `stage` | `state`: `reserved | running | settled | failed | stopped | refused | start_unknown | stop_unknown`; `stage`: `reserved | child_created | submitted | answered | validated | verified`. Agent nodes never reach `start_unknown`: the child and its owner are one commit and the submission is deduplicated by request ID. Stones and `integrate`start with the intent row written first, and a restart that finds`reserved`with no external proof marks it`start_unknown` and asks, as MonoCode does. |
| `childThreadId`, `conversationId`, `submissionId`, `nestedTaskId` | How to open it and how to stop it. |
| `attempt`, `schemaAttempts` | Retries of the node and of result validation. |
| `receipt` | At settle: `answerEntry`, `usage {input, output, cacheRead, cacheWrite, totalTokens, costUsd?}` summed over the node's conversation subtree, `toolCalls`, `durationMs`. |
| `result` | The typed value, or a reference when over a small cap (spec 12, "large terminal results"). |
| `refusal` | `budget_spent | outside_grant | node_cap | no_provider` for a refused node. |
| `startedAt`, `endedAt`, `error` |  |

Rules, each a test:

- The ledger row for a dispatch is committed in the same transaction that creates the child (`createConversation` with `ownership: {kind: "task", taskId}` and `configure`), so a crash leaves both or neither. Spike 3 does this in one `api.commit` already.
- `settle` is one commit: the receipt, the result, the state and the `workflow.node.settled` event (below). Only the row named by the node's own task may settle it; a late result from a dropped attempt, which cannot occur for a replay-safe task but can for a future retry, has no row to touch (MonoCode's `activeDispatchId` rule, reduced).
- Cost is read from the child's `pi.usage` over its subtree at settle, never from the tool's result.
- The document is written only by the nodes' own tools and the reactors, through `tx`; the thread stream carries it (`ThreadWire` whitelist), so the steps panel needs no second channel.

### Budgets and meters

`budget`: `{ tokens?: number, usd?: number, softFraction: 0.8, maxNodes: number, maxConcurrent: number }`, set in the launch approval (defaults from settings, edited on the card). It is a hard ceiling, as in Claude Code ("further `agent()` calls throw").

- **Spend** = Σ over the workflow's nodes of the subtree `pi.usage` (live for running nodes, from the `receipt` for settled ones). Tokens count for every provider. Dollars sum `Usage.cost.total` where the model has a price; the bridge's models have none (`cost` zero), so Claude nodes show as tokens and "plan" and add nothing to dollars. Whether to price them at a list rate is a question below.
- **At each admission** the `agent` tool checks the ceiling inside its reserve commit and writes `refused: budget_spent` into the row when over it; the script gets `null`. The check happens once, at first run, and the decision is the row, so a replay reads the row. This keeps replay deterministic against a clock that the check depends on.
- **At the soft fraction** a `workflow.budget.soft` event fires once; the reactor pushes and writes a notice in the thread. **At the hard ceiling** a `workflow.budget.spent` event fires once, and its reactor creates a stopper pi-durable task that calls `abortTask` on every running node of the workflow and marks the workflow `outcome: partial, reason: budget_spent`. Settled results, committed branches and worktrees stay; the script continues with `null`s and `budget.remaining() === 0`, so a well-written script finishes with what it has.
- **Why abort rather than let in-flight nodes finish.** pi-subagents and pi-dynamic-workflow let them finish; for a node that runs 16 minutes, or a stone that bills by the minute, that makes "hard" a soft limit by the length of the longest node. The open question below puts both to the user.
- **Meter**: a reactor on `workflow.node.settled` and on `pi.usage` commits of the workflow's conversations recomputes spend; the live number reaches clients by the thread stream (the document) and, between settles, by the projector's usage fields. At most one write per second per workflow.
- **Estimate** (pre-launch): dry-run node count times the per-role median of settled nodes in past ledgers (role alias, provider, tokens), with a fallback constant for a role with no history; shown as a range and labelled an estimate. A "Large workflow" banner above 25 nodes or a budget the estimate's high end exceeds.
- **Usage limits.** A node whose child run ends `usage_limit` (`RunFailureClass`, `docs/golden/thread-states.md`) becomes a hold, not a failure: state `held` with the reset time, the script waits, and other providers' nodes continue. Claude Code pauses the run for the same reason. The semantics of the wait belong to the models note.

### Concurrency and slots

The workflow script holds one of `CodeMode`'s four worker slots from start to result. Spike 3 measured the idle cost (123 to 150 MiB RSS with a workflow waiting, QuickJS worker included). Give workflows a second `ScriptSlots` pool (suggest 8) selected by the source starting with `export const meta`; the sandbox's `start` sees only the source, so the split is made in `WaitingSandbox.start`. Node concurrency is the per-workflow semaphore in `agent` (8, hard cap 32 as research 06 proposes) and, below it, the bridge's four Claude slots, which already show "waiting for a Claude slot".

### Hosting

Recommended for phase 2: the script runs inside the launching thread's own run, as in spike 3. The thread shows running for the workflow's length; Stop on the thread stops the workflow (abort flows down); the user can steer or queue. It is the shape proven under `kill -9`. The alternative, a workflow with its own coordinator thread that the parent hears from by delivery (t3code's shape, Claude Code's background run), needs a model to issue the `codemode` call; a deterministic "driver" provider registered with the harness (no tokens, no cost) could do it, which is untested and a spike candidate (work package W9), not a gate item.

### Stopping

- **Whole workflow.** Stop on the thread, or `workflow.stop` from the panel: `abortTask` on the run, or on the script call's task for the panel. Nodes honour `ctx.abortSignal` (spike 3's `abort` case: the job's unit stopped), their rows go `stopped`, the workflow `outcome: partial, reason: stopped`. This is t3code's "Stop entire workflow" and is judged by spike 3's `abort` case lifted into the matrix.
- **One node.** `workflow.stopNode {workflowId, nodeId}` calls `abortTask(nestedTaskId)` (the row keeps it). The probe's result is the contract: the script sees a rejection, the prelude turns it into `null`, the rest of the script continues, nothing reruns after a `kill -9` before, after or during the abort. Two caveats to build in: a node that ignores the signal keeps the stop pending until it observes it, so every node tool polls `abortSignal`; and a script that does not tolerate `null` fails with "Tool ... was aborted" and then, as ever, its other in-flight nodes are cancelled (spike 3, "Noticed"), so the workflow skill tells the model to filter nulls. A per-node restart is not offered: a rerun is a new call, which a journaled script cannot make; the user asks the thread to run the node again.
- **A node's own approvals.** A gated tool call inside a node raises an approval on the node's conversation and rolls up to the launching thread's row by the rollup rule (t3code addendum). It does not go to the script: a script is code and cannot judge (ADR 0027's "parent first" ends at code).
- **A node cannot ask the user.** Nodes get no user-question tool. A node that is blocked returns `status: "blocked"` with its questions in its typed result; the script decides, usually with `approve`. This keeps ADR 0027 honest for workflows: the parent of a node is code, and code asks through `approve`.

### Durable events with exactly-once reactors

**What and why.** The shell projector is "recomputed, never replayed" and `CommitFeed` events do not survive a restart. Several facts must cause something exactly once: a brief or launch approved starts the work, a node settled updates the meter, a budget crossed stops the nodes, a child's result is delivered to its parent, an approval answered on one device dismisses the push on the others. Today each would need its own table and its own recovery.

**Events.** An event is a typed entry `event.<name>` (`{v, at, data, context?}`) appended to one ownerless conversation titled `events`, inside the transaction of the change it describes, by `emit(tx, token, data)`. The entry id is the global order. A session document `cairn.events` holds the log's conversation id and a cursor per reactor. Catalogue for phase 2:

| Event | Emitted in the commit that | Data | Reactors |
| --- | --- | --- | --- |
| `approval.answered` | answers an approval | thread, approval, decision, decider, device | push dismiss; brief and launch reactors |
| `brief.approved` | answers a brief with Go | thread, brief, kind (`subagent`, `stone`, `workflow`) | start the child (subagents note) |
| `workflow.proposed`, `workflow.started`, `workflow.finished` | change the workflow row's state | workflow, outcome | push; the panel's notice |
| `workflow.node.settled`, `.refused`, `.stopped` | settles a node row | workflow, node, state, usage | meter; budget |
| `workflow.budget.soft`, `workflow.budget.spent` | the meter first crosses | workflow, spent, ceiling | notice and push; the stopper |
| `subagent.result` | commits a child's terminal result | child, parent, outcome | delivery to the parent (subagents note) |

**Reactors.** `react(name, tokens, handler)` registers a handler run once per event after the reactor's cursor, oldest first, serially per name. Each event is one `harness.commit`: read the cursor, scan the log for the next matching entry, run the handler with the `tx`, advance the cursor. A throw rolls back the handler's writes and the cursor together, records the failure, and the event stays pending until the next matching commit or the next open. `subscribeCommits` only enqueues a drain (the existing rule in `CommitFeed`). This is Ultimate's `drain` (`server/events.ts:174-230`) and the probe above.

**Cairn's refinement.** In Ultimate "outside effects are at least once". In Cairn a handler may not await anything: spec 12 forbids models, tools, processes, network and humans inside a commit, and the callback holds the Session's mutation line. So a handler does two things only: writes through `tx`, and creates pi-durable tasks with `tx.createTask`, whose phases do the outside work with idempotent request IDs, as example 23's `Reporter` does. Creation of the task is exactly once (same transaction as the cursor); the task is then pi-durable's: it survives restarts, parks after five crashes, and shows in the parked list. The guarantee: **database effects exactly once per (event, reactor); outside effects exactly once up to the idempotency of their request ID.**

**What does not move to events.** The shell projector stays derived. Per-feature durable work that has one producer and one consumer stays a task (the approval wait, a node). The log is for facts with several consumers and for an audit trail ("what did this workflow do, in order").

**Operations.** Reactor status (cursor, lag, last failure) is readable by an RPC and shown on the settings page; a reactor that fails repeatedly raises a notice. The log grows without bound because a conversation cannot be deleted (ADR 0016); at about 200 bytes an event and a thousand events a day that is about 70 MB a year, so the log rotates monthly (a new conversation, the cursor holds the log id and an entry id; old logs are never scanned). Reactors start after `Harness.open` and the boot repairs and before sockets accept; they stop in the close hooks before the stores close. Version events (`v`) like documents; renaming a kind is a migration.

### The council recipe

A built-in script `recipes/council.js`, listed beside the model's own workflows and launched by name with arguments `{question, scope, nonGoals, evidence, advisors: ["@advisor-1", "@advisor-2"], maxPasses: 2}`. Ported in intent from pi-subagents' council mode (`skills/council-mode/SKILL.md`, `references/pass-contracts.md`, MIT, header required); the rules carried over:

- 2 or 3 advisors, never more than four; read-only; they never see each other's reports; no advisor spawns children.
- **Pass 1** (`parallel`): independent reports against the typed schema (`recommendation`, `evidence[{claim, sources}]`, `assumptions[{assumption, status}]`, `risks`, `confidence {level, reason}`, `challengeClaims` at most three, `ownerDecisions`, `changeMyMind`), under about 600 words, one node each.
- **Claim matrix**: one `@judge` node over the reports returns agreements, disputed claims and at most five relay claims per advisor. (pi-subagents has the parent model do this; a script has no model, so it is a node, on a different family from the advisors where aliases allow, for the collusion reason in research 06.)
- **Pass 2**: each advisor is resumed (`agent(..., {resume})`) with a challenge packet of only the disputed claims, attributed to "another advisor", and answers `responses[{claimId, disposition: accept | reject | refine | owner-decision, reason, sources}]`, `recommendationChanged`, `outOfScopeFindings`. A third pass only on `maxPasses: 3` and only if the matrix says evidence can still settle a dispute.
- **Return**: `{pass1, matrix, pass2, ownerDecisions, roster}`. The launching thread's model writes the memo (recommendation, accepted and rejected feedback with reasons, owner decisions, confidence, roster), and turns owner decisions into questions on the user's question card rather than prose (briefs note).

With two advisors and `maxPasses: 2` it is exactly five nodes (2 + 1 + 2). On a Claude advisor and an OpenCode Go advisor it is the phase 2 gate's workflow, and with a Codex advisor it exercises the typed-results target on three providers. If an advisor cannot be resumed (its conversation was lost), the recipe runs the same role fresh with its pass 1 report and the packet and labels the result "fresh-context fallback, not true cross-exam", as pi-subagents does.

### The steps panel's data

The successor of `WorkflowOpeningBlock` and `ThreadLineageWorkflowRow` reads the `cairn.workflows` document from the thread stream; the look is the design pass's. What the brain must supply, per workflow:

- Header: `name`, `description`, `state`, `outcome`, `startedAt`, `endedAt`, `sample`, the launch decider and time, the folded script (by `scriptRef`) and args.
- Phases: declared plus appearing ones in order, each with its member counts; a phase is `pending` with no members, `running` while any member is live, else `done` (t3code's `deriveWorkflowGroups`, `subagentRuntime.ts:235-293`, ported as a pure function in `packages/client-logic`).
- Nodes: `index, label, phase, key, role, provider, modelId, state, stage, attempt, schemaAttempts, childThreadId, tokens, usd, toolCalls, durationMs, startedAt, endedAt`, a one-line `resultSummary` and `error`, `briefId`, `refusal`, `held {until}`; running nodes' live tokens and last activity come from the child's own shell row.
- Totals: nodes by state, tokens and dollars spent, the budget's ceiling, soft line and remaining, the estimate.
- Controls the panel needs RPCs for: `workflow.stop`, `workflow.stopNode`, and the launch approval's answer (the briefs note's answer path).
- The sidebar: node threads are children of the launching thread and have no row (t3code's rule); a node's pending approval rolls up to the launching thread.

### Protocol additions

Document `cairn.workflows` on the thread stream (a whitelist entry; node `prompt` and `result` cut by the existing 32 KiB rule); RPCs `workflow.stop`, `workflow.stopNode`, `workflow.list` (saved recipes), `workflow.eventStatus` (reactor cursors); the approval payload variant and decisions (briefs note); no new shell-row fields beyond what the launching thread already shows (its activity is `running`, its approval is the launch card or a node's request).

### Durability: what is a pi-durable task and what happens on `kill -9`

| Step | Is | `kill -9` here |
| --- | --- | --- |
| `workflow_plan` waiting | The tool's pi-durable task, replay-safe (ADR 0013) | Reruns, finds its row and approval, waits again; a crash-loop park is retried at boot like any pending approval |
| Between Go and `codemode` | Nothing (the row is `approved`) | The model's next turn proceeds; nothing was started |
| The script | The `codemode` call's task and its journal | Replays from its stored start; a changed module version or fingerprint ends it with an error and the rows `interrupted` (J7) |
| A node | A nested replay-safe tool task owning a child conversation | Reruns, finds its row, child and submission by request ID, and waits again; no second dispatch (spike 3) |
| A node's long work (stones, processes) | A handle outside the brain | Reattaches by the handle in its memo (spike 3's `job`) |
| `settle` | One commit | Either the receipt and event exist or neither does; the rerun settles again from the child's answer |
| An event | An entry in the commit that changed state | Exists exactly when the change does |
| A reactor step | One commit with the cursor | Exactly once for database writes; a task it created runs under pi-durable's rules |
| The budget stopper | A pi-durable task created by a reactor | Reruns its `abortTask` calls, which are idempotent |

## Judges

1. **Workflow kill matrix** (`judges/workflow-kill.sh`, spike 3's `judge.sh` generalised): the seven existing cases plus `kill-in-settle` (kill while a node's receipt commits), `kill-between-approve-and-codemode`, `kill-in-dry-run`, `prelude` (the probe's `judge2.sh`: hook rewrite, kill mid fan-out), and `divergence` (change the stored script's behaviour between kill and restart, e.g. a different prelude version: the call must end with an error result, rows `interrupted`, no node dispatched twice). Judge: an effects log outside the store, every node once, the ledger row count equal to the dispatch count.
2. **Node stop matrix** (`judges/workflow-stop.sh`): the probe's five cases on the real `agent` tool with a faux child, plus `stop-last-node` and `stop-then-budget`. Judge: effects once, the script's result contains `null` at the stopped node, the ledger row `stopped`.
3. **Ledger conformance** (a `registerWorkflowConformance` in the style of ADR 0024, run against `PiDurableHarness` and `ScriptedHarness`): an NDJSON scenario per rule above, hand-written. Includes "no row without a `briefId` naming an accepted approval", "a forged `workflow_begin` fails", "a model-written script calling `tools.agent` is blocked", and "a node outside the grant raises its own brief".
4. **Budget enforcement** (`judges/workflow-budget.ts`): a looped script over faux nodes with known usage and a token ceiling; assert admission refuses after the crossing, running nodes are aborted, nodes dispatched are at most `ceil(ceiling / perNode) + maxConcurrent`, `soft` fires once and `spent` fires once even with a `kill -9` at the crossing, and the final `outcome` is `partial: budget_spent`.
5. **Durable events** (`judges/events-kill.sh`, the probe made permanent and extended): N events, three reactors, at least ten `kill -9`s, injected handler faults, a reactor that creates a task; assert every (event, reactor) tx effect exactly once, every created task ran once, and reactor lag returns to zero. A second case rotates the log mid-run.
6. **Five nodes, two providers, from the phone** (`judges/behaviour.ts` extended, then the user): the council recipe with two advisors on Claude (bridge) and OpenCode Go or Codex, launched from a 390 px phone viewport: the plan card shows 5 nodes and an estimate; Go; the steps panel shows 5 nodes with providers; the run survives a `kill -9` of the brain mid pass 2; the result matches; the sum of the nodes' tokens in the ledger equals the sum of their conversations' `pi.usage`. The user then runs it from the real phone. Real models, cents.
7. **Replay across a pi bump** (unit): pin test that `CODEMODE_MODULE_VERSION` equals the number the code was written for; and a deploy-script test that refuses a version change while a workflow is `running`.
8. **Estimate** (unit and the run in 6): for a loop-free script the dry run's node count equals the nodes dispatched; the token estimate is within 2x of actual on the 5 node run, with the ratio recorded.
9. **Typed results** (the typed-results target): the council's reports validate on all three providers within two attempts; counted in the ledger's `schemaAttempts`.
10. **Slots and isolation**: a workflow holding a slot does not delay another thread's code mode; a node's layers use a fresh memo map (`MemoMapIsolation.test.ts` extended with a workflow node).
11. **The user**: opens a workflow's plan on the phone, runs on 1 first, then on all, stops one node, and sees cost before and after (the kickoff's fan-out target: "the workflow's cost is shown before launch and after").

## Proposed ADRs

1. **Durable events with exactly-once reactors** (status `proposed`). Facts with several consumers are entries in one ownerless conversation, appended in the commit of the change they describe; each reactor's cursor advances in the transaction of its handler, so database writes happen exactly once across crashes; a handler may only write through `tx` and create pi-durable tasks, and outside work is those tasks with idempotent request IDs. The shell projector stays derived. Ported from Ultimate's `server/events.ts` (MIT). Gate: `judges/events-kill.sh` (judge 5) passes with at least ten kills and injected faults, and the phase 2 gate's workflow uses it for its meter and its push.
2. **A workflow's launch approval is a brief that grants** (status `proposed`; resolves the question left open in ADR 0026). Go on a workflow approves a grant (script hash, roles and arms per call site, node cap, budget); a node inside the grant starts without asking and a node outside it raises its own brief; every ledger row names an accepted brief. Gate: ledger conformance (judge 3) and ADR 0026's own gate, a five-node two-provider workflow from the phone that starts no subagent without an approved brief.

An amendment to ADR 0012, not a new ADR: per-node stop is supported and surfaces as `null`; workflows have their own script slots; workflow scripts carry a fixed prelude injected by a hook; `parallel` remains a prelude function, not a tool.

## Open questions for the user

1. **Node briefs.** Option C (a launch approval that grants, out-of-grant nodes ask) over A (the launch approval replaces briefs) or B (every node asks). Recommend C. Changes ADR 0026's wording and the brief schema.
2. **At the hard budget, abort the running nodes or let them finish?** Recommend abort, with the partial results kept: otherwise "hard" means "plus the longest node". Letting them finish is cheaper to build and gentler on half-done writer work.
3. **What is a dollar budget on a subscription?** The bridge reports zero cost. Options: tokens only; tokens plus dollars on metered providers only; or also a list-price estimate for Claude and Codex. Recommend tokens always, dollars on metered providers, and a "plan" label with token counts for Claude; the models note owns any price table.
4. **Where does a workflow run?** In the launching thread's run (proven, recommended for phase 2) or in its own coordinator thread that reports back (the likelier end state, needs a spike on a driver provider).
5. **May the user stop a single node?** Recommend yes: it is replay-safe, and the script sees `null`. The cost is that scripts must tolerate `null`, which the workflow skill and the prelude already encourage.
6. **Is "run on 1 first" a separate run?** Recommend yes and no cache; the alternative (reuse read-only results by content hash) saves tokens on the second launch and risks stale answers.

## Risks

- **Real models writing scripts.** Nothing here has seen one. The first live run may show scripts that ignore `null`, loop without bound or build prompts too large; the dry run's node cap and the node cap in the grant are the backstops. Judge 6 is the first evidence.
- **The prelude and the hook are unproven beyond one probe.** One extension's `beforeTool` rewrite is relied on for the gate; if a pi release changes what is stored for a rewritten call, replay changes. Judge 1's `prelude` and `divergence` cases and the version pin are the guard.
- **A pi bump kills running workflows.** Mitigated only by the deploy refusing while one runs (judge 7); a forced bump loses them.
- **The dry run is only an estimate.** Stub results differ from real ones, so data-dependent fan-out is wrong; the card says so, and a workflow that reaches its cap is shown as `at least N`.
- **Workflow scripts keep four slots busy** until the separate pool exists (high if forgotten; first thing to build).
- **Unbounded event log.** Mitigated by monthly rotation; the cost is a cursor shape that must be right the first time.
- **Reactor handlers hold the Session's mutation line.** Every handler is a commit; a slow handler stalls every other write. Handlers are kept to a few reads and writes, and the brain note's footgun lint (its judge 9) is extended to flag an `await` of anything but `tx` inside a `commit(` callback.
- **Double-counted spend.** If a node tool ever returns `usage` in its result, subtree sums double count (spec 12). A conformance case asserts a node's tool result has no `usage`.
- **Quality of null handling in `verify`.** A stopped or refused verifier returns `null`; a script that treats `null` as "verified" ships unverified writer output. The prelude's `verify` returns `{verdict: "unverified"}` instead of `null` for that reason, and the ledger records `stage: answered`, not `verified`.

## Work packages

Sized like phase 1's; each is done when `pnpm check` is green and its judges pass. Dependencies on other notes are on their schemas, not their code.

| Package | Scope | Depends on | Judge |
| --- | --- | --- | --- |
| W1 Durable events | `brain/Events.ts`, the `cairn.events` document, the reactor host and boot/close wiring, the status RPC, monthly rotation, a migration test | None | Judge 5 |
| W2 Script and plan | `WorkflowScript.ts`, `Prelude.ts`, `WorkflowPlan.ts` (dry run, call-site table, estimate), `validate` | None | Parser and refusal unit tests; the dry run on council and on a looped script; judge 8 |
| W3 Ledger and nodes | `WorkflowDocs.ts`, `WorkflowTools.ts` (`workflow_begin`, `agent`, `verify`, `approve`, `phase`, `log`, `budget`), `WorkflowGate.ts`, the workflow slot pool, the `ThreadWire` whitelist entry | W1, W2, the subagents note's child spawn and result envelope, the briefs note's approval payload | Judges 1 to 3, 10 |
| W4 Launch approval | `workflow_plan`, the grant and its checks, `accept_sample`, the answer path, `brief.approved` and `approval.answered` events | W3, the briefs note | Judge 3 (grant cases); ADR 2's gate |
| W5 Budgets and meter | `WorkflowBudget.ts`, admission checks, soft and hard reactors, the stopper task, usage holds | W1, W3, the models and cost note | Judge 4 |
| W6 Stop | `WorkflowStop.ts`, the RPCs, abort-signal polling in every node tool | W3 | Judge 2 |
| W7 Recipes | `recipes/council.js`, saved-recipe listing and launch by name, `agent` `resume` | W3, the subagents note | Council on faux (structure, null handling, fallback) and judge 9 |
| W8 Steps panel data | The pure panel functions in `packages/client-logic` (`deriveWorkflowGroups` port), protocol schemas, conformance scenarios | W3 | `ThreadWire` convergence with the new document; panel function tests against t3code's cases |
| W9 Coordinator-thread spike (optional) | A driver provider that issues the `codemode` call, and a delivery of the result to the parent | W3, the subagents note | `spikes/` notes and `kill -9` of the brain mid workflow with the parent idle |
| W10 The gate run | Judge 6 on real models, the phone run, the kill during pass 2, judge 7's deploy guard | W1 to W8 | Judge 6, then the user |

Suggested order: W1 and W2 in parallel (neither touches pi-durable's task code), then W3, then W4 to W7 in parallel, W8 beside them, W10 last. Foundations (stage 4, step 1) should carry W1 and the approval payload variant before any subagent work, so the events log exists when the first reactor needs it.
