# Phase 2 notes: subagents and delivery

Scope: how a thread, a goal thread or a stone spawns, steers, waits on and stops a subagent, and how the child's result and questions reach its parent exactly once, on pi-durable 1.4.0 behind the harness seam. Written 2026-10-27 for the stage 3 plan. Cairn is read at `e73dd9c`. Nothing in the repo changed; the probes under `/tmp/subagents-probe` are described in "What the probes measured". Briefs, the Go card and the question card's UI belong to the "briefs and approvals" note, workflows to the "workflows" note and role aliases to the "models and cost" note; this note names where its design depends on them.

Words: "task" is pi-durable's. A delegated unit is a subagent (or a stone). t3code's own words (`delegate_task`, "delegated task") are kept only where they name t3code things.

## Summary

1. **A subagent is a thread.** The child is a pi-durable conversation owned by a background anchor task of its parent (example 23) that also carries Cairn's thread identity (`cairn.thread`, `cairn.thread-meta`, `cairn.approvals`), with a shell row hidden from the sidebar and a `lineage` triple on it (t3code's shape). Every existing seam then works on a child unchanged: `thread.send` steers it, `thread.stop` stops it, `thread.respond` answers it, the commit feed, the shell projector, the bridge's cwd and stop hooks, the boot reconcile and `inspect()` all see it. The alternative the phase 1 protocol reserved (a `conversationId` inside the thread's RPCs, `ThreadStreamHandlers.ts:3-4`) needs conversation-keyed addressing in about 15 seam calls and blinds the feed, the projector, `inspect()` and the bridge to children (`CommitFeed.ts:16`, `PiDurableHarness.ts:995-997`, `BridgeCwdExtension.ts:1-12`). Recommended: a thread; the reserved `conversationId` fields go.
2. **Five parent tools, two child tools, one verb each.** `subagent_spawn`, `subagent_send`, `subagent_status` (list, or one with a bounded wait), `subagent_stop`, `subagent_reply` for the parent; `ask_parent` and `report` for the child. Flat parameters after Fold; one verb per tool because `replay` is a per-tool property and example 23 had to mark its whole union tool `unsafe` for the sake of `stop`.
3. **The brief is the spawn's approval.** `subagent_spawn` asks a brief approval through the existing ledger (`approvalLedger(api)`, id `call-<taskId>`), waits for Go like ADR 0013's gated calls, and builds the child's first input from the approved record, so edits at Go are honoured. One spawn call is one brief is one child.
4. **A child's result is a settlement with a closed shape**: `outcome` (`completed | stopped | failed`), `summary`, a required `divergence` ("None" allowed), a `payload` validated against the brief's JSON Schema, the child's `commit` and `branch`, turns and a note. The child ends by calling `report` (a `terminate` result), whose arguments pi-durable validates before `execute` runs. Measured: pi-ai's `validateToolArguments` accepts a raw JSON Schema (`Type.Unsafe`), rejects a wrong enum or a missing key, and coerces `"3"` to `3`.
5. **Delivery is a pi-durable reporter task per input to the child, keyed by request ids, and a result enters the parent as a model-visible note (a `write`) before any wake (an `input`).** Measured under real `SIGKILL` at five boundaries: the parent held exactly one report each time. Measured: a queued `input` is withdrawn by `Conversation.abort()` (`unanswered:aborted`) while a queued `write` stays and is placed in the next request, so a Stop on the parent can lose a wake but never a result.
6. **Wakes obey the parent's state in code.** Idle parent: note, then a wake input starts a run. Busy parent: the note is placed at the next boundary; a wake is queued only if none is queued. Stopped by the user, failed or parked parent: note only, no run. A settled parent cannot have live children (settle is refused while a child works), so settled needs no rule.
7. **ADR 0027 in code: questions route to the parent model, approvals never do.** A child's `ask_parent` is a record in the child's `cairn.approvals` waiting like an approval. The parent answers with `subagent_reply` (answer or escalate); a parent run that ends with the question still open escalates it. An escalation is written in one commit to both the child's record and a mirror in the parent's `cairn.approvals` (one store, ADR 0016), so the card shows in the parent thread and an answer from either thread settles the one child record once.
8. **Whether a parent may decide its child's approvals**: recommend no (t3code's rule; ADR 0013's gate is the user's, and a parent model approving a child model's gated call lets hostile child output steer the approval). They roll up to the parent's row and show as a card in the parent thread. Hands-off (ADR 0026) later adds `decidedBy: "proxy"` on the same record.
9. **Workspaces reuse phase 1's code.** A writer gets a worktree from the parent's HEAD through `Worktrees.create` (`apps/server/src/projects/Worktrees.ts`, the brief's `threads/` and `git/` paths hold only the launch and checkpoints), with an intent row before the git call (ThreadLaunch's T18 pattern). The `Cairn-Thread` trailer is set per bash call through `GIT_CONFIG_*` hook variables from `CodingTools`' `prepare` hook, after Ultimate; verified on git 2.56 here. Nothing deletes a dirty or unmerged worktree.
10. **Permission modes only narrow.** A child's effective mode is the narrower of its own and its parent's current mode, evaluated at each ask, and `thread.configure` refuses a widening. Depth is 2, live children per parent 8 (proposed, unmeasured).
11. **The memo-map rule from 2.6 applies to Cairn's per-child services, not to the agent loop.** pi-durable runs the child in the one Harness, so no layer is built for the loop. The services Cairn does build per child (workspace lease, budget meter, any per-child Executor narrowing) are built from inside the brain's runtime, where `Layer.build` returns the root's or the parent's instance; they go through one `ChildScope.build` using `Layer.makeMemoMap`, enforced by a scan and by extending `MemoMapIsolation.test.ts`.
12. **Conformance gets 12 scenario groups and 4 mutations**, and the kill matrix from the probe becomes a kept judge. The scripted harness must model owned conversations, reporters and routing: the largest cost in this area.

## Facts with evidence

### Pins

| Thing | Where | Pin |
| --- | --- | --- |
| pi-durable, 1.4.0 | `/tmp/pi-src` (clone of `earendil-works/pi`), `packages/durable/docs/spec.md` (5,618 lines) and `test/examples/` | tag `v1.4.0`, `4a080252f`; installed `node_modules/@earendil-works/pi-durable` is 1.4.0 |
| Fold | `/tmp/fold`, `packages/fold-core/src/Subagents/` | `4bd8c58`, MIT |
| Ultimate | `/tmp/ultimate`, `extensions/{subagents,messages,coding-tools}` | `8b263386` |
| pi-subagents | `/tmp/pi-subagents`, `src/intercom/`, `skills/pi-subagents/references/execution-controls.md` | `1a80e24e` |
| t3code nightly | `git -C ~/Developer/clones/github.com/pingdotgg/t3code show fe27e8e3:<path>` | `fe27e8e3`; summary in `docs/phase-2/notes/t3code-nightly.md` |
| Cairn | this repo | `e73dd9c` |

### pi-durable 1.4.0's subagent model

- **Example 22 (foreground)** (`test/examples/22-subagent-foreground.ts:33-76`): one tool, `replay: "safe"`; one commit creates the child owned by the tool's task (`ownership: { kind: "task", taskId: api.taskId }`) and finds it again on rerun with `scanConversations({ ownerTaskId })`; `api.details({ conversationId })` lets a UI attach; the submission's `requestId` is derived from `api.taskId`, never from the provider's call id ("not unique across a Session", spec 3502). The tool task holds `completing` until the child's work ends, Stop on the parent cascades into the child, and a steer to the parent waits for the tool (spec 2329-2352, 5502-5507).
- **Example 23 (background)** (`23-subagent-background.ts:42-190`): one `Subagents` document on the parent (`fork: "initial"`, so a fork starts empty) maps name to conversation id and reporter ids; one transaction creates a `background: true`, conversation-owned `Anchor` task that completes at once, a child owned by the anchor, and the registry entry; each message gets a `Reporter` task created in the tool's transaction. The reporter's `deliver` phase submits to the child with `requestId: subagent:<reporter.id>` and waits; its commit decides the report and records the answer id in `reported`; its `report` phase posts to the parent with `whenBusy: "followUp"` and `requestId: subagent-report:<reporter.id>`, then ends. A parent Stop does not reach the child or the reporter (background is a boundary, spec 3544-3562). The tool is `replay: "unsafe"` because `stop` repeated could stop newer work.
- **Example 24** shows `waiting` on child tasks with `failFast` and `runtime.outcomes()`; abort is bottom-up (spec 2385).
- **Identity**: `ConversationRecord.owner` is `{conversationId, taskId}` and stays after the owner ends; `parent` (a fork) is separate. A new task-owned conversation copies the owner's `pi.agent` once (spec 779, footgun "Copies are one-time" at 5579). `{ add, remove }` written to a child whose owner has a stored selection replaces it with the host default plus the edit; compute the child's array from `(await api.agent(ctx)).extensions` (spec 5574-5578).
- **Section 12 footguns that bite here**: double-counted subagent spend (a tool must not put the child's usage in its result; `pi.usage` of the child already counts it); owned work holds its owner (foreground only); work created by hooks holds the asking task; an abort handler cannot create owned children; long transactions (never await a model, tool, process, network call, human or nested Session commit inside `commit`); reads inside a commit must go through `tx`; terminal task records are queryable so large results go to entries and only ids stay in the outcome.
- **Submissions** (spec 2540-2580): `requestId` deduplicates within one conversation before any write; a `write` never starts a run; at a boundary writes are placed first, then user items; `Conversation.abort()` withdraws queued steer and follow-up submissions and keeps writes.

### What the probes measured

Probe files: `/tmp/subagents-probe/probe.ts`, `killmatrix.sh`, `validate.ts` (a `node_modules` symlink to this worktree's). Rerun: `cd /tmp/subagents-probe && node --experimental-strip-types probe.ts <stop|wake|cascade>`; `sh killmatrix.sh`; `node --experimental-strip-types validate.ts`. They use pi-ai's faux provider and a SQLite file; the kill is `process.kill(process.pid, "SIGKILL")` at a named point, then the script is rerun until it prints `done`.

| Probe | Result |
| --- | --- |
| Reporter exactly-once, parent entries starting `[child` after recovery | 1 for each of: no crash, and `SIGKILL` (exit 137) after the child submission was admitted, after the child answered, after the deliver checkpoint committed, after the parent submission was admitted, after the terminal commit. One recovery run each. |
| `Conversation.abort()` with a busy run, one queued follow-up input and one queued `write` | input `unanswered:aborted`; write still `queued`; the next request's messages were `system | user:long | user:REPORT-WRITE | user:next`. |
| Idle parent: a `write` with a `model` user message | status `done` at once, no run started, a repeat with the same `requestId` returned the same submission; a later wake input's request showed `user:first | assistant:ok | user:NOTE child done | user:wake`. |
| Parent `abort()` with a child under a `background: true` anchor and one under a non-background task | background child still `placed` (running); the other `unanswered`. `abort(ctx, { background: true })` then ended the background child. |
| `validateToolArguments` with `Type.Unsafe(jsonSchema)` | accepts a valid payload, rejects a wrong enum and a missing required key, coerces `"3"` to `3`. |
| `git` 2.56.0 with `GIT_CONFIG_COUNT`, `hook.cairn-pcm.event=prepare-commit-msg` and `.command` set in the environment | the commit carried `Cairn-Thread: <id>`; no repo or worktree config touched. |

Not measured: a kill during the spawn commit itself (one commit, atomic by pi-durable's transaction), and Claude through the bridge as the child's model (the bridge keys sessions by `pi.provider`, so it should work per conversation; the kickoff's durability target says it must hold there too, so the kill judge below runs on the bridge once).

### Cairn today

- No subagent code exists. The words appear in comments and removals: `CommitFeed.ts:16` ("Conversations that are not threads (subagents later) produce no events"), `ThreadStreamHandlers.ts:61-65` (`noSubagents`), `T3Import.ts:19`, `RowView.ts:13`, and the protocol's `SubscribeThreadInput.conversationId` and `HistoryInput.conversationId` (`packages/protocol/src/Thread.ts:195-207`).
- The seam is keyed by `ThreadId` and finds the conversation through the `cairn.thread` receipt (`PiDurableHarness.ts:257-310`); `ensureThread` creates the conversation `ownerless` and writes receipt, meta and the `cairn.approvals` document in one commit (329-377). `inspect()` reports only conversations whose `cairn.thread-meta` decodes to a thread (993-1020), so boot's `retryParkedApprovalWaits` (`Boot.ts:125-157`) and the shell reconcile are blind to anything else.
- Approvals: a record per tool task, id `call-<taskId>` (`CairnDocs.ts:199`), written by `approvalLedger(api).ask`, awaited with a watch plus the record's expiry, answered by `answerApproval` in one commit that leaves a non-`pending` record as it is (381-408). `RuntimeRequestKind` is `executor-call | tool-call | user-input | sign-in` (`Policy.ts`); the Executor tools pass `autoAccept: true` (`ExecutorExtension.ts:81,178`), so no permission mode is read yet.
- `HarnessSeam.write` writes display-only entries (`PiDurableHarness.ts:577-595`: `entry: { kind, data }`, no `model`). `Threads.stop` runs `seam.stop` then `StopHooks` (`Threads.ts:246-256`); the default stop aborts the run task and keeps the queue, `clearQueue` calls `conversation.abort()` (`PiDurableHarness.ts:461-504`).
- Worktrees: `Worktrees.create/remove/list/isWorktreeOf` (`apps/server/src/projects/Worktrees.ts:213-262`), launched by `ThreadLaunch.prepareWorkspace` with an intent row and `worktreeCreated`, `branchCreated` flags (`ThreadLaunch.ts:448-557`, `LaunchStore.ts:36-38`). Checkpoint refs are `refs/cairn/checkpoints/<thread>/turn/<n>` (glossary), so children keyed by their own thread id never collide.
- Extensions install once in a fixed order (`Extensions.ts:12-22`: 100 coding tools to 900 judge); adding one appends a `pi.system` delta to every conversation once. `bash` has a `prepare(execution, api, context)` hook (`CodingTools.ts:222`, `bash.d.ts:22-31`) that sees `api.conversationId`.
- The conformance format is one thread, one view: `input` steps, `model` lines, `expect_event`, `expect_view` (`conformance/Transcript.ts:1-30`), with `gate` as the one tool with a ledger. `ThreadWire` projects only `pi.agent`, `pi.live`, `pi.inbox`, `pi.usage` and `cairn.approvals` (`ThreadWire.ts:3-4`).
- `golden/thread-states.md` lists two gaps this note closes: the sidebar's "Waiting" label never shows, and approval outcomes reach no UI.

### The sources compared

| Question | pi example 23 | Fold (`4bd8c58`) | t3code `delegate_task` (`fe27e8e3`) | Ultimate (`8b263386`) | pi-subagents |
| --- | --- | --- | --- | --- | --- |
| Surface | one `subagent` tool, actions spawn, send, stop, status | one flat tool: `agent \| agent_id \| fork`, `prompt`, `description` (5 to 10 words), `skill` (`Subagents/Schemas.ts:113-177`) | `delegate_task`, `task_status`, `task_cancel`, `t3_workflow_stop`, `t3_thread_send/wait/interrupt`, `t3_pending_request_read/respond` (`tools.ts`) | one `subagent` tool: `start`, `message`, `wait`, `stop`, `list`, `land`, `discard` | `subagent`, `subagent_supervisor` (reply, pending), child `contact_supervisor` |
| Wait | none; reports arrive as follow-ups | the call blocks | `mode: "async" \| "wait"`, `timeoutMs` default 10 min, a question or approval ends the wait | interruptible: a steer or another child's answer ends it, the child keeps running | `need_decision` and `interview_request` block the child until the parent replies; `progress_update` does not |
| Result | text `[subagent n answered...]` | `SubagentResult {agentId, outcome, resultText, errorMessage, turnsThisRun, turnsTotal}`, outcome `completed \| stopped \| interrupted \| error`; a failing child is a result (`Schemas.ts:30-48`) | `status`, `workState`, `summary`, `hasPendingQuestion`, `pendingApproval` (identity only), `waitTimedOut` (`orchestratorMcp.ts:198-235`) | worker text block: `Status: DONE \| PARTIAL \| BLOCKED`, per-criterion evidence, `Commit`, `Divergence`; `workspace submit` refuses an empty divergence | typed reports for council mode |
| Delivery | reporter task, request ids | none (synchronous) | wake message to the parent "reached a terminal state. Use task_status", `completionWake: always \| settled_only`, per-run cohorts with `generation`, task states `pending \| claimed \| acknowledged \| delivered \| disposed`, disposition `open \| stopped \| disposed` | durable reporter per start and message, parent request id `subagent-answer:<answer entry>`; a hook acknowledges only results already committed (`server.ts:78`, `:98-278`, `:728-775`) | file channel scoped by parent session id |
| Routing | none | children cannot ask (upward channel is the final text) | the parent is woken to read the child's question and answer it with `t3_pending_request_respond`, which "cannot approve a permission request" | a subagent messages only its parent (`addresses.ts:12-18`); an answer whose last line is a question or numbered options wakes the parent, anything else is a note (`route.ts`, `triage.ts:18-35`) | parent replies by tool |
| Stop | `abort` the child, stays usable | scope close interrupts | `task_cancel` | children outlive the parent's stop; `stop {id}` returns the uncommitted paths | n/a |
| Workspace | none | none | `isolation: shared \| worktree` from the parent's commit, dirty edits not copied | `isolate: none \| worktree`, trailer `Ultimate-Conversation` through per-call git hooks | n/a |
| Permission | inherits | none | child mode may narrow, never widen | definitions pin tools and model | n/a |

## Design for Cairn

### 1. Identity and ownership

Module `apps/server/src/subagents/` (new), plus small edits where listed.

- **Two documents** (kinds are protocol, `fork: "initial"`, `checkpointWhen: () => false` where written once):
  - `cairn.subagents` on the parent: `items[key]` with `key` = the spawn tool's approval id (`call-<taskId>`, stable across reruns), `{threadId, conversationId, anchorTaskId, briefApprovalId, description, role, model, isolation, worktree: {path, branch, baseSha} | null, status: working | waiting | settled | declined | expired, wake: answer | quiet, settlements: [{seq, outcome, answerEntry | null, reportedAt}], delivered: seq, questions: {[approvalId]: {state, escalatedAt | null}}, inputs: {[requestId]: reporterTaskId}}`.
  - `cairn.child` on the child: `{key, parentThreadId, parentConversationId, rootThreadId, depth, briefApprovalId, resultSchema: JsonSchema | null, attempts, report: {...} | null, permissionMode}`. The child's tools find their parent here, so `ask_parent` and `report` take no target: a child addresses only its parent by construction (Ultimate's rule, enforced by shape).
- **Ownership.** Goal-thread subagents hang under a background anchor (example 23), so a Stop on the parent ends only the parent's run (measured above) and the parent's run is never held by children. Workflow nodes hang under the node's tool task (example 22), so stopping the workflow cascades (ADR 0012, "a subagent by its owning task"): that is the workflows note's call; both kinds are threads.
- **Spawn commit** (one `api.commit`, no await inside): check `items[key]` (a rerun returns it); create anchor, child (`ownership: { kind: "task", taskId: anchor }`), `configure(tx, child.id, {model, thinkingLevel, cwd, tools, instructions, extensions})` with the extension array computed from the parent's resolved agent (footgun above), the `ThreadReceipt`, `ThreadMeta`, `Approvals` and `cairn.child` documents, the registry entry and the first reporter task for the brief. The child's `ThreadId` is minted before the commit by the `Ids` service and only the first committed value counts.
- **Shell row.** The child's `ThreadShell` row is created in `cairn.sqlite`, a different store, so it is a repair, not part of the commit: the commit feed already emits `ThreadEnsured` when `cairn.thread-meta` is set (`CommitFeed.ts:16`), a `SubagentRows` fiber answers it with `ThreadCreate` using a command id derived from the thread id (the command receipt makes a resend land once), and a boot repair does the same for every child with no row. The row gets `lineage {parentThreadId, relationshipToParent: "subagent", rootThreadId}` (t3code `orchestrationV2.ts:108-112`), `projectId` and `worktreePath`/`branch` from the parent and the spawn, and the sidebar filter hides it, with its ancestor highlighted when it is open (port `Sidebar.logic.ts:520-553`).
- **What the child has no use for**: settle, snooze, pin and archive refuse a row with a lineage (the parent owns its shelf); Web Push never fires for a child's run end (HumanLayer's rule, "not a subagent"); `thread.launch` never creates one.

### 2. The tools

One extension `subagents` (order key 650, between executor 600 and bridgeCwd 700; keys never move). Parameters are flat, strings and booleans only after Fold ("schema unions confuse models"), empty strings and `false` normalised as absent (`Schemas.ts:113-160`). Roughly 150 tokens of schema each, 7 tools to every thread: the judge measures the added tool tokens, and the per-conversation `tools` filter can hide the set from a role that must not delegate.

| Tool | Input | Result | `replay` | Notes |
| --- | --- | --- | --- | --- |
| `subagent_spawn` | `description` (5 to 10 words: the thread title and the steps label), `brief` (what, why, how the result will be judged), `role` (alias such as `@worker`) or `model`, `isolation` (`worktree` default for a role that writes, else `shared`), `result_schema` (JSON Schema, optional), `wake` (`answer` default, or `quiet`) | `{subagent, status: working \| declined \| expired, thread, model, workspace, parentDirty}` | `safe` | Asks the brief approval first (kind `brief`, payload = the brief fields), waits like a gated call, then spawns. `parentDirty` says uncommitted edits the child will not see (t3code's contract text). Role binding is checked at the ask (Fold, models and cost note). |
| `subagent_send` | `subagent`, `message`, `mode` (`steer` or `followUp`) | `{subagent, queued}` | `safe` | Creates a reporter task in its own commit, keyed by the tool task. Refused for a stopped-and-released child. |
| `subagent_status` | `subagent` (optional), `wait_seconds` (0 to 600, default 0) | one block per child: `status`, `workState` (`working \| asking \| settled`), last progress line, `pendingQuestion`, uncommitted paths in its worktree | `safe` | A bounded in-memory wait on the reporter (`api.waitForTask`); returns early on a pending question or a settlement. It returns status, never the result: the result arrives once, as the note. A wait that outlives a restart reruns with a fresh bound. |
| `subagent_stop` | `subagent` | `{stopped, uncommittedPaths}` | `unsafe` | `conversation.abort()` on the child (its queued inputs withdrawn, its reporter settles `stopped`). Lists dirty paths, as Ultimate does. An interrupted call comes back `interrupted` and the model checks with `subagent_status`. |
| `subagent_reply` | `subagent`, `request`, `answer` or `escalate` (a reason) | `{settled \| escalated \| already_settled}` | `safe` | Resolves or escalates a child's `ask_parent` record in one commit; a second call finds it settled. Never takes an approval id. |
| `ask_parent` (child) | `question`, `options` (optional) | the parent's answer, or "the user answered" | `safe` | Writes a `user-input` record with `route: "parent"` in the child's own `cairn.approvals` and waits like `gate` does (`ConformanceTools.ts:39-60`). A rerun finds its record. |
| `report` (child) | `summary`, `divergence`, `payload` (optional), `commit` (optional) | `terminate` | `safe` | Validates `payload` against `cairn.child.resultSchema` with `validateToolArguments`; an invalid payload is an error result (attempt n of 3); the third failure settles `failed` with the validator message. First valid report wins; a rerun finds it. |

The brief card and the Go answer are the briefs note's; the contract here is: the ledger's `ApprovalRequest` gains `payload` and kind `brief`, an accepted answer returns the stored payload, and `subagent_spawn` reads the child's first input from that stored payload, not from its own arguments. A brief is never accepted by a permission mode: `autoAccept` is false for kind `brief` (ADR 0026: nothing delegated starts until Go).

A child that ends its run without calling `report` is not an empty success (Ultimate: "ended its turn without an answer"). Its settlement is built from its last assistant answer with `divergence: "not reported"` and `payload: null`; when the brief carried a `result_schema`, the relay first sends one nudge input (`nudge:<answer entry>`, once) asking for `report`, which is the second attempt of the typed-results target.

### 3. The result

```ts
SubagentSettlement = {
  subagent: ThreadId,
  seq: PositiveInt, // 1 for the brief's run, then one per later input that produced an answer
  outcome: "completed" | "stopped" | "failed",
  summary: string,
  divergence: string, // "None" or how the result differs from the brief; "not reported" if the child never reported
  payload: Json | null, // validated against the brief's schema; null without one
  commit: string | null,
  branch: string | null,
  turns: { thisRun: number, total: number },
  error: string | null, // set exactly when outcome is failed (Fold's rule)
  usageLimit: boolean, // failed because a plan window is spent: no wake, shown as Limited
};
```

`outcome` reuses the run vocabulary: `stopped` is an aborted submission, `failed` is `model_error`, `no_model`, an empty or aborted answer, or a third invalid payload. A declined or expired brief is a spawn status, not a settlement. The parent's model gets Fold's rendering (`renderSubagentResult`: `agent_id` line with how to resume, `turns`, a `<subagent_result>` block, a `<system-information>` note on non-clean outcomes) plus `divergence`, the payload as JSON, the commit and the branch; the block is data, not instructions. The settlement's `answerEntry` is an id into the child's transcript, never the text (spec 5560-5562), and the child's usage is not repeated in any result (footgun above).

### 4. Delivery

**Mechanism.** After example 23 and Ultimate: every input to a subagent is delivered by a `cairn.subagent-reporter` task (background, conversation-owned by the parent, created in the same commit as the registry entry that names it). That covers three senders with one path: the spawn's brief, `subagent_send`, and the user's steer typed into the child's thread (`Threads.send` for a row with a lineage creates the reporter first, keyed by the client's `requestId` in `inputs`, so an outbox resend lands once, and the reporter submits the input). Phases:

1. `deliver`: submit to the child with `requestId: subagent:<reporter.id>` and `whenBusy` from the sender, wait for the settlement, then one commit builds the `SubagentSettlement`, appends it to `settlements` and checkpoints `report`. A crash before the commit reruns `deliver`, whose submit returns the admitted submission.
2. `report`: write the note, then the wake if the rules below say so, each with a request id derived from `(parent conversation, child, seq)`: `subagent-note:<child>:<seq>` and `subagent-wake:<child>:<seq>`. Then one commit sets `delivered` to `seq` and ends the task. A crash anywhere reruns the phase and both submits return what exists.

The note is a `write` carrying a `model` user message (kind `cairn.subagent-result`, `data` = the settlement, rendered by the client as a subagent row) and the wake is a short `input` ("Subagent <description> reported; its result is in the note above") with `whenBusy: "followUp"`. Writes place first at a boundary, so the note always precedes its wake. Result and wake are separate on purpose (measured): a Stop with `clearQueue` withdraws the wake and leaves the note.

**By parent state.**

| Parent is | Note | Wake |
| --- | --- | --- |
| mid-run | queued, placed at the next `postTools` boundary (all writes place there) | queued only if none from this relay is already queued; the earlier wake places after every later note, since writes place first |
| idle | placed at once, no run | submitted; starts the run |
| idle with a non-empty inbox (after a failed run) | queued behind the waiting items | submitted |
| stopped by the user after the spawn (`RunTerminal` `interrupted` not followed by a user message) | written | none; the parent's row shows an unread subagent result, nothing restarts a thread the user stopped |
| failed or parked | written | none; Retry or the next message reads the note |
| blocked in `subagent_status(wait)` | placed right after the tool returns, which the early return on settlement guarantees | not needed |
| quiet spawn (`wake: "quiet"`) | written | none; the parent collects with `subagent_status` |
| settled | cannot happen: settle and auto-settle are refused while the thread owns a child that works or a settlement with `delivered < seq` (`settleBlocker` in `ShellCommands.ts:599`, Ultimate's `conclude-landed` check) |  |
| snoozed | written | none; a snooze ends early for a pending question, not for a completion (t3code doc, `orchestrator-mcp-server.md` 394-395) |

With ten children finishing together the wake rule gives about two parent runs, not ten: each run's first boundary places every note, and at most one wake waits in the queue. A `usageLimit` failure writes the note and wakes nobody.

**What the parent's tool call holds while it waits.** Nothing durable. The children hang under background anchors, so the parent's run is never `completing` on them; `subagent_status(wait)` is an in-memory wait bounded at 600 s, ended by Stop on the parent (which does not touch the child), by a settlement or by a question. The cost of the bound is one more model turn per timeout. The alternative, a foreground child owned by the tool task (example 22), would hold the run, cascade Stop into the child and make the parent deaf to a steer until the child ends.

**Ultimate's receipt, deferred.** Ultimate also returns the result from the wait tool and acknowledges it in a `GenerationTask.afterTools` hook, writing a settled submission under the report's request id so the reporter dedupes onto it ("Tool settlement is not a receipt", `subagents/server.ts:728-775`). It saves one transcript row; it costs a hook and a recovery scan. Not worth it in phase 2; the single delivery path is easier to prove.

**Stop and the parent.** `thread.stop` on a parent stops its run and leaves children working (measured), and the row says "N subagents still working" with a Stop all. `StopInput` gains `subagents: "keep" | "stop"`; `stop` calls `conversation.abort(ctx, { background: true })`, measured to reach background children.

### 5. Child to parent routing (ADR 0027)

1. The child's `ask_parent` commits a `user-input` record with `route: "parent"`, `askedAt`, and `source: "tool" | "answer"` in its own `cairn.approvals`. Its shell row says `waiting` with `waitingFor: "parent"` (a new `WaitingFor` literal, which fixes the "Waiting" label gap in `thread-states.md`), not "Input": the user is not asked.
2. The `SubagentRouter` fiber (commit feed `RuntimeRequestUpdated` plus a boot repair that re-offers every pending `route: "parent"` record) writes a note and a wake into the parent with ids `subagent-q:<child>:<approvalId>`: the question, its options, the child's description and "answer with `subagent_reply`, or escalate". A parent blocked in `subagent_status(wait)` hears it through the early return.
3. The parent calls `subagent_reply {answer}`: one commit sets the child's record to `accepted`, stores `answer`, `decidedBy: {kind: "parent", thread, reason}` (ADR 0026's fields), and the child's waiting `ask_parent` returns it.
4. `subagent_reply {escalate}`, or a parent run that ended (any `RunTerminal`) while a woken question is still pending, escalates, in one commit: the child's record gets `route: "user"` and `escalatedAt`, and the parent's `cairn.approvals` gets a mirror `{kind: "user-input", mirrorOf: {thread, approvalId}, summary, options}`. Both documents are in the one store (ADR 0016), so no half state exists. The parent's row takes `pendingRuntimeRequest` from the mirror (the card shows in the parent thread, ADR 0027) and the child's row says `waiting`.
5. **Answered once from either thread.** `answerApproval` is extended: a record with `route: "user"` and a mirror, or a mirror with `mirrorOf`, resolves both in one commit and applies the existing rule (a record no longer `pending` is left as it is, `already_settled`). `thread.respond` on the mirror and `thread.respond` on the child's id are the same operation; whichever commit lands second reports `already_settled` and the child's tool ran once. A question a user answers directly while the parent is still deciding wins the same way.
6. **Final plain answers that end in a question** (Ultimate's rule) are treated as a question: the relay turns a settlement whose last line is a question or numbered options (port `needsDecision`, `triage.ts:22-35`) into a `route: "parent"` record with `source: "answer"` instead of a completion note; any other plain answer lands as a completion note under the wake rule. Rules decide, no triage model.
7. **Approvals.** A child's gated tool call stays a user approval. The child's row shows `waiting`, the rollup puts it on every ancestor's row with approval over input (port `threadShell.ts:48-80`, t3code's tests are the judge) and the card shows in the parent thread with an "Open subagent" link, as for an escalated question. `subagent_reply` takes no approval id and the ledger refuses a `parent` decision on a `tool-call` or `executor-call` kind.

Options for who may decide a child's approvals: **A** only the user (t3code's rule, recommended); **B** the parent model through `subagent_reply` (fast, but one model's gate on another's, and a hostile page the child read can talk the parent into approving); **C** the brief lists pre-authorised actions and code, not a model, auto-accepts matches with `decidedBy: "brief"` (a later step; needs the brief schema to carry it, so the briefs note decides). Hands-off later reuses C's field.

For a workflow node the parent is the script, which cannot answer: its questions escalate at once (the workflows note may add a handler). The user can answer any child's pending question from the child's thread whatever the route ("take over").

### 6. Workspaces, trailer and cleanup

- `isolation: "worktree"` (default for a role that writes): after Go, a `child_workspaces` row in `cairn.sqlite` (child thread id, branch, path, `baseSha`, made flags) is written before `Worktrees.create` runs, with a branch derived from the child's thread id (`cairn/sub-<8 hex>`) so a rerun finds the same path, and the flags are set only after git says it made them (ThreadLaunch's T18, `ThreadLaunch.ts:448-557`). Base is the parent's HEAD (`git rev-parse HEAD` in its cwd); dirty edits are not copied (t3code). The spawn commit sets the child's `cwd`. `isolation: "shared"` runs in the parent's cwd and is the default for read-only roles.
- **Trailer.** `CodingTools`' `bash` `prepare` hook adds three environment pairs (`GIT_CONFIG_COUNT`, `hook.cairn-prepare-commit-msg.event` and `.command`) running `git interpret-trailers --in-place --if-exists replace --trailer "Cairn-Thread: <thread id>" "$1"`, the id read from `ThreadMeta` through `api.conversationId`. It applies to every thread, not only children, so landings, checkpoints and diffs name their thread and survive a lost database (Ultimate `coding-tools/server.ts:45-80`; measured to work on git 2.56). It needs git 2.54 or later; `Git.ts` records the version at boot and the hook is skipped, with an `events` log line, below it. Commits made by tools outside `bash` carry no trailer.
- **Cleanup.** Nothing removes a dirty or unmerged worktree. A boot repair removes only a workspace row whose spawn commit never landed (no child with that thread id). A settled child whose worktree is clean and whose branch is merged into its base is released by an explicit action (and by archiving the parent), children before ancestors (Ultimate's release rule); the branch stays. Phase 3's integrate node takes over landing; in phase 2 the result's `branch` and `commit` are what the parent or the user merges.
- Checkpoints: a child records its own `refs/cairn/checkpoints/<child>/turn/<n>` from its worktree through the existing `CheckpointCapture`; the parent's diff card does not include the child's edits unless merged.

### 7. Permission inheritance and limits

- `effectiveMode(thread)` is a pure function in `packages/client-logic` (server and client share it): the narrower of the thread's stored mode and its parent's effective mode, order `approval-required` < `auto-accept-edits` < `auto` < `full-access` (t3code's `RuntimeMode` order). The ledger reads it at each `ask`, so a parent switched to `approval-required` after the spawn narrows the child's next gated call. `thread.configure` refuses a widening above the parent. The default is full access, so today a child asks for nothing but the brief and its own `ask_parent`.
- A child gets the `subagent_*` tools only when its role allows (default no): the spawn commit removes them through the child's tool filter, and the spawn tool also refuses at depth 2 by reading `cairn.child.depth`. Live children per parent 8, per brain 32 (proposed and unmeasured; the phase 2 fan-out judge sets them).
- Executor tools: a child uses the same connection and project scope as its parent (ADR 0003); their approvals are the child's.

### 8. Per-child layers and the memo map

`MemoMapIsolation.test.ts:146-196` pins that `Layer.build`, `Effect.provide` and an unwrapped `LayerMap` hand a nested or root-held scope the existing instance, and that only a fresh `Layer.makeMemoMap` per build (or `Layer.fresh`) isolates. Cairn's child needs no layer for the agent loop (pi-durable runs it in the one Harness, with `arms.env` called per conversation, `Brain.ts:187-205`, `Arms.ts:46-52`). What is built per child, from inside the brain's runtime where the root memo map is ambient, is: the `ChildWorkspace` lease (path, branch, release), the `ChildBudget` meter (turn and token caps from the cost note) and any per-child Executor narrowing. Rule: they are built with `ChildScope.build(layer)` in `apps/server/src/subagents/ChildScope.ts`, which opens a `Scope`, calls `Layer.buildWithMemoMap(layer, yield* Layer.makeMemoMap, scope)` and closes with the child's lifecycle, and nothing under `subagents/` or `workflows/` calls `Layer.build`, `Effect.provide(<layer>)` or `LayerMap.make` directly (a scan in `Footguns.test.ts`, as `Date.now` is scanned today). `MemoMapIsolation.test.ts` gains a case that opens two children at once through `ChildScope.build` against a root that holds the same layer and asserts distinct instances, and a control that fails with `Layer.build`.

### 9. Protocol and shell additions

- `ThreadShell`: `lineage: Option<{parentThreadId, relationshipToParent: "subagent", rootThreadId}>`; `subagents: {working, asking, settled, failed}` on the parent (derived by the projector from `cairn.subagents`, recomputed at boot like every derived field); `WaitingFor` adds `parent`. `RuntimeRequestKind` adds `brief`.
- Thread stream: `VISIBLE_DOCUMENTS` adds `cairn.subagents` and `cairn.child`; a `subagent_spawn` tool call carries `details: {threadId}` through `api.details` (the pi mechanism for attaching a UI, spec 3505), so the transcript row links to the child without a lookup. `SubscribeThreadInput.conversationId` and `HistoryInput.conversationId` are removed and `noSubagents` with them.
- `StopInput.subagents`; no new RPC for steering, stopping or answering a child, which are `thread.send`, `thread.stop` and `thread.respond` on the child's id.
- Seam: `PassiveEntry` gains optional `model` content; events `ThreadEnsured` carries `parent: Option<ThreadId>` and a `SubagentUpdated {threadId, child, status}` comes from the doc diff in `CommitFeed`. `HarnessSeam` gains no spawn method: spawning is a tool inside pi-durable, as the Executor tools are.
- Boot repairs (appended to `BootRepairs.ts`, after `retry-parked-approval-waits`): `subagent-rows`, `subagent-routes` (re-offer pending questions), `subagent-workspaces`, and retry of a parked reporter whose child is still working (the crash-loop guard parks a waiting reporter after 5 crashes, the same hole ADR 0013 closed for approvals).

### 10. Durability: what `kill -9` does at each step

| Step | State after the kill | Recovery |
| --- | --- | --- |
| Brief asked | record `pending`, spawn tool task waiting | card still answerable (ADR 0013); boot retries a parked wait |
| Go answered, spawn not yet committed | record `accepted` | tool reruns (`safe`), finds the record, proceeds |
| Worktree intent row or `git worktree add` | row, maybe a worktree | rerun finds the same deterministic path and flags (T18) |
| Spawn commit | all or nothing (one transaction) | a rerun finds `items[key]`; no second child |
| Child shell row | child exists, no row | `SubagentRows` on `ThreadEnsured` and the boot repair, command id derived from the thread id |
| Child run | resumes like any thread's run | pi-durable recovery (ADR 0016's durability judge) |
| Child answered, deliver not committed | submission `done` | `deliver` reruns, submit returns it (measured) |
| Note or wake admitted, task not ended | submissions exist | `report` reruns, submits return them (measured) |
| `ask_parent` record committed, parent not woken | child waits | `subagent-routes` re-offers; request ids dedupe |
| Parent answered, child not yet returned | record `accepted` | the child's tool reruns, finds it, returns the answer |
| Escalation commit | both documents or neither | one commit |
| User answers from parent and child at once | one `accepted`, one `already_settled` | the extended `answerApproval` |
| Stop on a child | run aborted, reporter settles `stopped` | note says stopped; no wake if the parent was stopped |

## Judges

| Piece | Outside judge |
| --- | --- |
| Result schema, the settlement rendering, `effectiveMode`, rollup, `needsDecision` port | unit tests; rollup and sidebar rules against t3code's `threadShell` and `Sidebar.logic` tests (the cheapest judge there is) |
| Memo-map rule | extended `MemoMapIsolation.test.ts` (control fails with `Layer.build`) and the `Footguns.test.ts` scan, each failing on a planted violation |
| Spawn, delivery, routing | the conformance scenarios below on both harnesses, with the mutation check |
| Exactly-once under `kill -9` | `judges/subagent-durability.ts`, kept code from `killmatrix.sh`: kill at each row of the table in section 10 (named crash points inside the tasks, plus kills at the spawn commit, the escalation commit and the answer commit), rerun, then count: one child, one note, one wake, one answer; run once on a faux model and once on the bridge (kickoff durability target) |
| Typed results | `judges/typed-results.ts`: a real cheap model on three providers (Claude through the bridge, OpenCode Go, Codex) with a fixed schema and 8 cases each; pass is every payload valid within two attempts (the kickoff target; it needs the user's Codex login, models and cost note) |
| Workspaces and trailer | a test on a temp repo: spawn creates the worktree from HEAD, a child commit carries `Cairn-Thread`, a kill between the intent row and `git worktree add` leaves no orphan after the boot repair, nothing deletes a dirty worktree |
| Steerable from the UI | a behaviour script (`judges/behaviour.ts` style): open a child from its parent's row, type a steer, see the parent's note arrive, stop the child, see "stopped"; the screens have no pixel baseline (ADR 0011 note) |
| Thread states | `judges/thread-states.test.ts` fails until `thread-states.md` lists `waitingFor: parent` and kind `brief` |

### Conformance scenarios to add (ADR 0024)

Format additions: `input`, `model` and `expect_view` lines take an optional `thread` alias (`"child1"`) resolved from a new `SubagentUpdated` event; a `model` line without one is consumed by whichever conversation asks next, as today. Both harnesses install the `subagent_*`, `ask_parent` and `report` tools (the scripted side as `ScriptedTools`). Scenarios, each with hand-written expectations:

1. `subagent_spawn_after_go`: no child conversation and no event before Go; after it one child thread, `lineage` set, its first input equals the approved brief text (an edit at Go shows up).
2. `subagent_brief_declined`: declined and expired both give a spawn result `declined` or `expired`, no conversation.
3. `subagent_result_once_with_crash`: the child completes, `crash` between the child's answer and the report; after restart the parent has one note and one wake.
4. `subagent_result_parent_busy`, `subagent_result_parent_idle`, `subagent_result_parent_stopped` (note, no run), three children finishing together (three notes, at most two parent runs).
5. `subagent_question_answered_by_parent`: ADR 0027's first gate. `ask_parent`, the parent model calls `subagent_reply`, the child continues; no `RuntimeRequestUpdated` ever reaches the parent's row and the parent's `pendingRuntimeRequest` stays empty.
6. `subagent_question_escalated_answered_in_parent`: ADR 0027's second gate. The parent escalates, the card is on the parent's thread, `thread.respond` on the parent's mirror settles the child once; the child's tool ran once.
7. `subagent_question_answered_from_child_twice`: two answers, one wins, the other `already_settled`; and the parent-run-ends-without-answering escalation.
8. `subagent_approval_not_routed`: a child's gated call reaches the user, the parent model is never woken, and `subagent_reply` on its id is refused.
9. `subagent_stop_child_only` and `subagent_stop_all`: parent Stop leaves the child running; `subagents: "stop"` ends it.
10. `subagent_user_steer_reports_to_parent`: a `thread.send` to the child produces a quiet note in the parent.
11. `subagent_permission_never_widens`: parent narrowed after the spawn narrows the child's next gated call; `configure` refuses a widening.
12. `subagent_typed_result_attempts`: an invalid payload is an error result, a valid second attempt settles `completed`, three invalid settle `failed`.

New mutations on each side, each required to fail at least 2 of these scenarios: drop the note, deliver twice (fresh request ids), wake a stopped parent, route an approval to the parent. The existing bar (at least 5 of the old 18 per mutation) stays. Fold's scripted-model idea applies: `FauxProviderHandle` should expose the requests it saw so a scenario can assert the first input and the tool list a child received (check the faux handle; wrap it if it does not).

## Proposed ADRs

1. **A subagent is a thread.** A subagent is a pi-durable conversation owned by a background anchor of its parent's conversation, carrying Cairn's thread identity and a shell row with a `lineage`, hidden from the sidebar. Steering, stopping, answering, the commit feed, the projector, `inspect()` and the bridge's hooks work on it unchanged. Alternative, conversations inside the thread, reverses a phase 1 reservation and needs conversation-keyed seams. Gate: the scenario groups pass on both harnesses and the kill judge passes.
2. **A subagent's result is a note, a wake is separate.** Results enter the parent as model-visible writes, wakes are inputs that obey the parent's state in code, and both are keyed by request ids derived from the child and the settlement, delivered by a reporter task per input. Gate: scenarios 3 and 4, and the kill matrix with one note and one wake after every crash point.
3. **Questions route to the parent model, approvals never do.** A child's question goes to its parent first and escalates in one commit to a mirrored record in the parent thread; an approval is only ever the user's. Amends ADR 0027, which is `proposed`. Gate: scenarios 5 to 8.
4. **Per-scope layers are built with a fresh memo map.** Anything Cairn builds per subagent, child thread or workflow node goes through `ChildScope.build`; direct `Layer.build`, `Effect.provide` of a layer and `LayerMap.make` are refused under `subagents/` and `workflows/`. The backlog names this a candidate. Gate: the extended isolation test and the scan.

## Open questions for the user

1. **Child as a thread (ADR 1), reversing the protocol's reserved `conversationId`.** Options: (a) a thread with a hidden row, recommended; (b) a conversation inside the thread. Recommendation (a): (b) blinds the feed, `inspect()` and the bridge to children.
2. **Stop on a goal thread.** Options: (a) children keep working and the row offers Stop all, recommended; (b) Stop cascades. Recommendation (a) because stopping a coordinator should not kill a writer mid-edit; (b) is one flag away (`subagents: "stop"` as default).
3. **May a parent decide its child's approvals?** Options: A user only; B parent model; C pre-authorised in the brief. Recommendation A for phase 2, C later with the hands-off work.
4. **Does a completion wake the parent by default?** Options: wake (recommended; the parent keeps working), or quiet by default (cheaper for fan-outs; the parent must poll). A spawn can set it either way.
5. **A brief in full access.** Recommendation: always waits for Go, never auto-accepted by a permission mode (ADR 0026 as written). Say so if full access should skip it for the user's own threads.
6. **Default isolation.** Recommendation: a worktree for any role that writes, shared checkout for read-only roles, and a spawn refused when the project is not a git repo and the role writes. Alternative: always shared, which is simpler and lets writers collide.
7. **Caps.** Depth 2 and 8 live children per parent are guesses. Do you want them as settings, or fixed until the fan-out judge measures?

## Risks

- **The scripted harness doubles the semantics.** It must model owned conversations, reporters, routing and the mirror. Mitigation: build the pi-durable side and the scenarios first, write the scripted side against the scenarios, and keep both behind the mutation check.
- **A child per thread row grows the shell.** A 10-node workflow adds 10 rows and 10 stream updates; the projector's 50 ms coalescing and the sidebar filter bound it, but the shell snapshot size is unmeasured; add children to `judges/wire-budget.ts`.
- **Prompt injection through results.** Child output enters the parent's context verbatim; the `<subagent_result>` block marks it as data and approvals never route to a model, but a parent can still be steered. The user's gate (briefs, approvals) is the control.
- **The wake rule is a heuristic with a race.** A note written after the parent's last boundary with no wake queued is placed but not acted on; the rule re-checks for a queued wake after every note, but a window of one boundary remains. The kill judge and scenario 4 bound it; the recovery is the next user message or `subagent_status`.
- **Reporter parking.** A reporter waiting in memory across 5 crashes parks (the ADR 0013 hole). The boot repair retries parked reporters of working children; a child that outlives many restarts needs the same repair every boot.
- **Per-call trailer needs git 2.54 or later.** The Beelink's git is not checked here (this machine's is 2.56.0); `Git.ts` must record the version and fall back to no trailer with a log line.
- **Tool count.** Seven tools in every thread add context. The per-conversation tool filter can hide the set from roles that do not delegate; measure before shipping.
- **Typed-results target needs a Codex login** the user does not have yet (kickoff); until then the judge runs on two providers.
- **Not verified:** the exact commit-feed signal for a child's `RunTerminal` (children have `ThreadMeta`, so the existing path should serve them; a test, not a probe, settles it), the bridge as a child's model under `kill -9`, and git on the Beelink.

## Work packages

Sized like phase 1's blocks; each lists Owns, depends on and the judge. Seams (`AppLayer`, `BootRepairs`, `ExtensionSet`, `TurnContentStages`, protocol exports, the glossary) are touched only by the integrator.

- **S1 Schemas and states.** Owns `packages/protocol/src/Subagents.ts` (settlement, lineage, `cairn.subagents`, `cairn.child` shapes, `brief` kind, `WaitingFor.parent`), `packages/client-logic/src/{EffectiveMode,SubagentRollup}.ts` with the t3code rollup and sidebar tests ported, `needsDecision` port. Depends on the briefs note's brief payload. Judge: unit tests and the thread-states judge.
- **S2 Seam and scripted semantics.** Owns the seam additions (`PassiveEntry.model`, `ThreadEnsured.parent`, `SubagentUpdated`), `CommitFeed` doc diffs, `ScriptedHarness` owned conversations, reporters, routing and mirror, the scenario format's `thread` alias and the 12 scenario groups with goldens. Depends on S1. Judge: the scenarios fail first against no implementation, then pass on the scripted side, then on pi-durable after S3; the new mutations fail at least 2 scenarios each.
- **S3 The subagents extension.** Owns `apps/server/src/subagents/` (tools, anchor and reporter tasks, router, relay rules, `ChildScope`, `SubagentRows`), the extension order key, `answerApproval` mirror handling, the three boot repairs. Depends on S1 and S2's scenarios. Judge: the scenario groups on pi-durable; `MemoMapIsolation.test.ts` extension and the scan.
- **S4 Workspaces and trailer.** Owns `child_workspaces` migration and store, the spawn workspace step over `Worktrees.create`, the `bash` `prepare` trailer, release action, the workspace boot repair. Depends on S3's spawn flow. Judge: the temp-repo tests, including the kill between intent and `git worktree add`.
- **S5 Durability judge.** Owns `judges/subagent-durability.ts` and its crash points. Depends on S3, S4. Judge: it fails against a mutated build (a reporter that mints fresh request ids) and passes on the real one, on a faux model and once on the bridge.
- **S6 Shell and rollup wiring.** Owns shell row creation and hiding for children, tallies, settle refusals, push suppression, the pending-request rollup, `thread.stop` `subagents`, `thread.configure` no-widening. Depends on S1, S3. Judge: shell projector and command tests plus the ported sidebar tests.
- **S7 UI behaviour script.** Owns the behaviour script for steer, stop and escalated-question flows; the screens themselves are the look wave's (briefs and UI notes). Depends on S6 and the UI work. Judge: the script, then the user.
- **S8 Typed results judge.** Owns `judges/typed-results.ts`. Depends on S3 and the models and cost note's aliases. Judge: 100% valid within two attempts on the providers available, the user's login for Codex pending.
