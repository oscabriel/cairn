# Phase 2 notes: briefs, goals and approvals (the records and screens through which the user decides)

Written 2026-10-27 for the stage 3 planner. Scope: the brief and its Go approval, goals and their criteria, approvals and user questions on one card, permission modes that gate, a child's question reaching its parent and then the user, approval push, and `decidedBy` with a reason on every approval. Spawning, delivery and the child's lineage belong to the "subagents" note; a workflow's launch approval belongs to the "workflows" note. Where the three meet is in "Seams with the other notes". Cairn is read at `e73dd9c`; paths are repo-relative. No Cairn code was changed. The two probes behind the measured numbers are under `/tmp/briefs-probe` and described in "Facts".

## Summary

1. **Phase 1 has a ledger and no screens.** `cairn.approvals` records, a tool-owned wait and a one-commit answer exist (`apps/server/src/brain/CairnDocs.ts:84-408`), but no client reads the document, the only gated tools are Executor's `call` and `execute`, and their gate is a constant: `AUTO_ACCEPT = true` (`apps/server/src/executor/ExecutorExtension.ts:81`). The thread's `runtimeMode` is stored on the shell row and never reaches the brain (`HarnessSeam.ts` has no mode in `EnsureThread` or `ThreadAgentChange`; `ConfigureInput` has none, `packages/protocol/src/Thread.ts:298`). Three modes are listed "Applies in a later phase".
2. **Go can be one commit.** Answering a brief is a host commit that flips the record `pending` to `accepted` and, in the same transaction, creates a conversation-owned background start task. Probe 1 (pi-durable 1.4.0, ten cases): one worktree, one child conversation and one input in every window; a kill inside the commit leaves the brief pending with no task; three concurrent answers (go, decline, go) take effect once. This beats ADR 0013's in-memory wait for briefs, because a brief holds no run.
3. **The start task can park, and must not be retried blindly.** Five kills in a row inside the start task's first phase left it `blocked`; `retryTask` finished it with one child. A start that crashes the brain would loop under a boot auto-retry, so it shows Parked with Retry on the parent (existing hold banner) and is not in `retryParkedApprovalWaits`.
4. **A brief is a frozen payload plus an answer.** Kind `brief` in `cairn.approvals` (version 2, migrated), written by a flat-parameter `brief` tool that returns at once. The user answers Go, Send back (with notes, status `revised`, a new revision supersedes) or Decline (with a reason). The child's first input is rendered from the approved payload, whose hash is stored.
5. **A goal is a thread plus a `cairn.goal` document.** Criteria are `{text, judge}` pairs; only a verdict writer inside the server may set `met`, from a judge run (a command's exit code, a user mark, a verifier on another model family, later a `.cairn/verify` recipe). The model can request a check and cannot write a result. Criteria enter through the user or through a `criteria` approval the user answers, so a model cannot write itself a judge of `true`.
6. **One decision record serves everyone.** `decidedBy` (user, thread, mode, envelope, judge, expiry, system) and `reason` on every record. Hands-off goals then add a decider and a grant; the stored shape does not change. `cancelled` is written when a stop ends the run that asked (today nothing does; stale `pending` records survive a stop).
7. **One card, three bodies.** Approval (t3code's panel plus Decline with a reason, after HumanLayer), question (t3code's panel plus "my pick" and an undo window, after Ultimate) and brief (the plan card's reading view, "Implement in a new thread" becoming Go). It docks above the composer; settled records collapse to one transcript line that says who decided and why.
8. **A child's question goes parent first, in code.** `ask_user` in a child sets route `parent`; a reactor delivers it to the parent as a queued input; the parent has `answer_child` and `escalate`; the question escalates to the user when the parent calls `escalate`, ends its run without answering, fails, parks or is archived, or 15 minutes pass after the parent's model saw it (pi-subagents lost questions to a clock that ran before the parent looked, `CHANGELOG.md:141-142`). The escalated card is mirrored into the parent's own documents in the same commit, so either thread answers the same record once.
9. **Approvals stay the user's.** Only questions route to the parent; approvals go straight to the user, shown in the parent. A child inherits its parent's mode and may only narrow it, so a full-access goal's children ask nothing. This keeps ADR 0013 and t3code's rule (`apps/server/src/mcp/toolkits/thread/tools.ts:169-173`); the schema allows the parent to decide later.
10. **Modes gate through safe wrappers with a memo mark.** Probe 2: a `replay: "safe"` writer that commits `api.memo("effect","started")` before its effect reports "may have run" after a kill at either point and never reruns it; the memo costs 0.2 to 0.3 ms. The wait for approval sits before the mark, as in spike 4. Phase 1's unsafe `write`, `edit` and `bash` become such wrappers. `auto` stays disabled (t3code's pi provider does not list it either).
11. **Push follows the pending request.** The notifier's existing loop gains a rule beside run ends: a user-routable pending request is claimed once and pushed unless a visible page shows the thread, its home thread or an ancestor. A suppressed claim is re-checked after 60 seconds, because a Go left pending must not be lost to a glance. One notification per thread (`ask:<threadId>`), counted.
12. **Workflow launch against node briefs: recommend an envelope.** The launch approval carries limits (node cap, allowed roles and modes, writes, budget); a node whose brief fits is recorded `accepted` with `decidedBy {kind: "envelope"}` and the launch approval's id; one that does not raises an ordinary brief card. Every child still has an approved brief. This is the plan's first question for the user, because it reads ADR 0026's gate in a specific way.

## Facts with evidence

### Pins and method

| Source | Pin | Read how |
| --- | --- | --- |
| Cairn | `e73dd9c` | repo files |
| t3code nightly | `fe27e8e3` (ADR 0015) | `git -C ~/Developer/clones/github.com/pingdotgg/t3code show fe27e8e3:<path>` |
| pi, pi-durable | tag `v1.4.0` (`4a080252`) | `/tmp/pi-src/packages/durable/docs/spec.md`, installed `node_modules/@earendil-works/pi-durable/dist/*.d.ts` |
| HumanLayer | `f16f286` | `git -C /tmp/hl show f16f286:<path>` (the clone's working tree is at `0dbe4f5`) |
| Ultimate | `8b263386` | `/tmp/ultimate` |
| Fold | `4bd8c58` | `/tmp/fold` |
| MonoCode | `26465c62` | `/tmp/monocode` |
| pi-subagents | `1a80e24` | `/tmp/pi-subagents` (changelog) |

Probes, three, run on 2026-10-27 against the installed pi-durable 1.4.0 with a faux model, `/tmp/briefs-probe` (its `node_modules` is a symlink to the repo's): `go.ts` with `go-judge.sh` (output `go-judge.out`) `gate.ts` with `gate-judge.sh` (output `gate-judge.out`), and `two.ts`.

### What exists in Cairn

- **The record.** `ApprovalRecord` has `id`, `toolTaskId`, `tool`, `kind`, `summary`, `status`, `askedAt`, `expiresAt`, `answeredAt`, `run` (the effect sandwich) and `executorRequestId`; no `decidedBy`, `reason`, answer or payload (`CairnDocs.ts:84-101`). The document is conversation-scoped, version 1, `history: "latest"` (`:110-118`). The id is `call-<taskId>`, one per tool task (`:199`); pi-durable task ids are store-wide unique (ADR 0016), so an id names one record in the whole store.
- **Ask, wait, answer.** `ask` is idempotent and records `accepted` at once when `autoAccept` (`:222-249`); `awaitAnswer` watches the document in memory and commits `expired` at `expiresAt` (`:308-336`); `answerApproval` flips only a `pending` record in one transaction and reports `answered | already_settled | not_found` (`:381-408`). `PiDurableHarness.respond` calls it for the thread's own conversation only (`PiDurableHarness.ts:535-560`).
- **Kinds and statuses.** `RuntimeRequestKind` is `executor-call | tool-call | user-input | sign-in`, `ApprovalStatus` is `pending | accepted | declined | expired | cancelled`, `ApprovalDecision` is `accept | decline` (`packages/protocol/src/Policy.ts:42-65`). `user-input` and `sign-in` have no producer. `docs/golden/thread-states.md` records that nothing but the scripted harness writes `cancelled`.
- **Stop leaves the record pending.** `PiDurableHarness.stop` aborts the run and does not touch `cairn.approvals` (`PiDurableHarness.ts:461-504`); no code path marks a record `cancelled` (`grep '"cancelled"'` hits only the scripted harness and the schema). Read in code, not run: after a stop a stale `pending` record keeps the row's `pendingRuntimeRequest` set (`ShellProjector.ts:284-306`) and a late accept answers nothing.
- **Gating today.** Only `executor_call` and `executor_execute` use the ledger (`ExecutorExtension.ts:374, 393`), with `AUTO_ACCEPT` constant; a program that pauses for a nested call is declined outside full access (`GatedCall.ts:136-145`). The coding tools are replay-`unsafe` writers by design (`CodingTools.ts:1-8`; `CodingTools.test.ts` asserts it).
- **Mode plumbing.** `runtimeMode` rides `thread.launch` into the shell row (`ThreadLaunch.ts:951`, `ShellCommands.ts:679`), the footer lists four modes with `isEnforced` false for three (`packages/client-logic/src/RuntimeMode.ts:43-70`), and nothing past the row reads it.
- **Clients.** The thread stream projects `cairn.approvals` (`Thread.ts:57-63`) and no client code reads it. The shell row carries the oldest pending request only (`PendingRuntimeRequest {id, kind, createdAt}`, `Shell.ts:89-95`). The sidebar says "Input" for `user-input` and `sign-in`, "Approval" for the rest (`packages/client-logic/src/Sidebar.ts:186-192`); settle and snooze are blocked by a pending request (`ShellCommands.ts:599-605`, `Settlement.ts:117-128`), so a held request needs no new rule there.
- **Idle with a request.** `activityOf` returns `waiting` only while a run is live (`ShellProjector.ts:159-175`); a request with no run leaves `idle`, which is what a pending brief is.
- **Push.** The notifier reads `thread.activity-updated` events after a durable cursor and pushes a run end once, claimed in `notified_runs` before it is sent, unless `presence.isWatched(thread)` (a visible page showed the thread within 30 seconds) (`Notifier.ts:134-175, 403-419, 432-470`; `Presence.ts:12, 61-78`). A suppressed claim is permanent. There is no push for a request (v1 pushed approvals from its queue; the port dropped them, header `Notifier.ts:1-14`). The badge counts unseen results (`:183-192`).

### Probe 1: does Go start a child exactly once

`go.ts` models the design: a pending record in a conversation document; the answer is one `harness.commit` that sets `accepted`, `decidedBy` and creates `StartChild` (conversation-owned, background); `StartChild` has three phases (make a worktree directory if absent, create the child conversation once and record its id on the brief, submit the brief with request id `brief:<id>`). `CRASH_AT` sends `SIGKILL` at a named point.

| Case | After the kill | After restart | Worktrees, conversations, inputs |
| --- | --- | --- | --- |
| no kill |  | accepted, submitted | 1, 1, 1 |
| kill inside the Go commit | pending, no task | (not applicable; Go again below) | 0, 0, 0 |
| then Go again |  | accepted, submitted | 1, 1, 1 |
| kill right after Go | accepted, nothing started | accepted, submitted | 1, 1, 1 |
| kill after the worktree effect | worktree exists | submitted | 1, 1, 1 |
| kill after the child was created | child exists, no input | submitted | 1, 1, 1 |
| kill after the input | input exists | submitted (the phase reran, request id returned the first input) | 1, 1, 1 |
| answers go, decline, go at once |  | accepted once | 1, 1, 1 |
| decline | declined |  | 0, 0, 0 |
| five kills in the first phase, then a plain start | task `blocked` | `retryTask` finishes it | 1, 1, 1 |

### Probe 2: a gated writer as a safe tool with a memo mark

`gate.ts` registers a `replay: "safe"` tool that reads `api.memo("effect")`, returns "may have run" if set, else writes the memo, then appends a line (the effect). Kill after the mark: effect lines 0, the model sees "Interrupted after it started, so it may have run. Not retried."; kill after the effect: effect lines 1, same message; no kill: 1 and "touched". The memo commit took 0.19 to 0.34 ms. This is the sandwich of ADR 0013 without a record, so full access can keep writers unrecorded.

### Probe 3: one commit across two conversations

`two.ts` writes a conversation document in a parent and in a child inside one host commit. A throw after both writes leaves both documents absent; a clean commit lands both (`[1,1]`). The escalation mirror of section 4 relies on exactly this.

### pi-durable facts that constrain the design

- A hook may replace arguments or block, and has `HookApi`, which reads and memoizes but cannot commit (`spec.md` §7.2); so a hook cannot write an approval record, and gating lives in the tools.
- A host commit's `Tx` can create tasks, conversations, submissions and documents in one transaction (`spec.md:1710-1722`; `types.d.ts:858`). A conversation-owned `background` task is outside idle waits and aborts (`spec.md` §5.5).
- Five crashes in a row without progress block a task; `retryTask` runs it again (`types.d.ts:757-760`; probe 1).
- A document's shape changes by `version` bump with a pure `migrate`; migration is access-driven and the first `tx.doc()` writes a new base (`spec.md` §3.6).
- Footguns that bite here (§12): a commit callback must not await humans or a nested Session call; "double-counted subagent spend"; a child copies its owner's `pi.agent` once, and `{add, remove}` written to such a child replaces the copied selection.

### t3code at `fe27e8e3`

Behaviour is read as in `docs/phase-2/notes/t3code-nightly.md` (its lines re-checked here for the panels).

- One composer top drawer, warning-toned for an approval, otherwise info-toned, shows the first pending approval, else the first pending question, else "Plan ready" (`ChatComposer.tsx:6505-6562`).
- Approval panel: a label by request kind, the app name, "1/N", the detail in a scrollable mono block (`ComposerPendingApprovalPanel.tsx:11-68`). Actions: Decline (outline) and Approve (default) as buttons, `cancel` and `acceptForSession` in a "More approval options" menu (`ComposerPendingApprovalActions.tsx:25-45`).
- Question panel: one question at a time with "i/N", options with digits 1 to 9, a single-select answer advances after 200 ms, a custom answer typed in the composer, Dismiss when dismissible (`ComposerPendingUserInputPanel.tsx:141-168, 213-228`; draft logic in `apps/web/src/pendingUserInput.ts`). A question has `id, header, question, options[{label, description}], multiSelect?` (`orchestrationV2.ts:1130-1146`).
- Plan card: "Expand plan", a menu with Copy, "Download as markdown" and "Save to workspace" (`ProposedPlanCard.tsx:175-190`); the send button becomes Implement with "Implement in a new thread" in its menu (`ComposerPrimaryActions.tsx:217-258`).
- Modes: ranks `approval-required` 0, `auto-accept-edits` 1, `auto` 2, `full-access` 3; a child's mode may not outrank its parent's (`OrchestratorMcpService.ts:575-620`; `DispatchModeLimit.ts:26-35`). The pi provider lists three modes, no `auto` (`provider-pi/src/server/status.ts:54`). Its gate: full access passes; `read`, `grep`, `find`, `ls` pass; in `auto-accept-edits` `edit` and `write` pass; everything else asks (`mcpExtensionSource.ts:18, 311-326`).
- A child's question wakes the parent with a queued message naming the read and respond tools, keyed by parent and request id, and cancels that queued run if the question is answered first (`DelegatedTaskQuestionReactor.ts:32-59, 112-125`). Approvals are not routed; the respond tool "cannot approve a permission request" (`tools.ts:169-173`).

### What the outside sources add

- **HumanLayer.** The approval is idempotent and keeps `comment` and `approved_by_user_id`; a denial's comment reaches the model as "The user denied this tool call with feedback: ..." (`apps/riptide-api/src/orpc/api/approvals/resolve.effect.ts`). Everything the agent waits on docks above the composer; Enter approves, D denies and opens a mode where what you type becomes the reason (`AskCard.tsx:65-72, 160-175`). Source: `git show f16f286:<path>`.
- **Ultimate.** The assessment is the brief in prose: verdict, complexity, delta, reuse, recommended, alternative, risks, then numbered decisions with lettered options and "My picks" (`agents/coordinator.md:18-30`), enforced only by prompt. The question card has kinds choice, multi, confirm, text, scale; "my pick" pills; "Something else" last; Accept picks; a 3 second undo window; and `answer` admits atomically so two devices produce one reply (`extensions/questions/README.md`, `questions/server.ts:60-91`). Hands-off goals record `{question, picked, reason}` per decision, but `met {n}` is written by the working agent (`extensions/goal/server.ts:165-167`), the weakness ADR 0026 names.
- **MonoCode.** A proposal is a card with `planning | ready | invalid | starting | approved`; each task carries its files (write scope) and `dependsOn` (`orchestrationPlan.ts:20-50`). Its lead answers workers' approvals and puts a call to the user only "when the call is genuinely theirs" (`orchestration.ts:833`); Cairn takes the first half for questions only.
- **Fold.** The subagent tool's wire parameters stay flat "because schema unions confuse models" and parse into a typed command at one boundary (`packages/fold-core/src/Subagents/Schemas.ts:4-8, 94-176`).
- **pi-subagents.** A child's `contact_supervisor` question could expire before a busy parent saw it, and a coordinator stuck waiting never saw its own child's question; both fixed by moving the deadline until the parent's model has seen it and waking the waiter (`CHANGELOG.md:141-142`). `contact_supervisor` and `subagent` cannot be called from codemode scripts because they block the script (`:135, 417`); Cairn's `brief`, `ask_user` and `escalate` are `callers: ["model"]`.

## Design for Cairn

### 1. The decision record (`cairn.approvals` version 2)

One record per decision, in the conversation that asked. Version 2 adds, with `migrate` filling `null` for v1 records:

```
ApprovalRecord v2 = v1 fields
  kind        : executor-call | tool-call | user-input | sign-in | brief | criteria
  status      : pending | accepted | declined | expired | cancelled | revised
  payload     : JSON | null     // frozen at ask time: Brief, questions, criteria; tool calls keep `summary`
  answer      : { decision, answers?, note? } | null
  decidedBy   : Decider | null  // null only while pending
  reason      : string | null   // the user's words on Decline or Send back; a rule's text for envelope or mode
  route       : "user" | "parent"        // questions only; others are always "user"
  escalatedAt : number | null
  supersedes  : string | null            // briefs: the revision this replaces
  started     : { childThreadId } | null // briefs: set once, by the start task
  briefHash   : string | null            // briefs: hash of the rendered input the child received
Decider = {kind:"user"} | {kind:"thread", threadId} | {kind:"mode", mode} | {kind:"envelope", approvalId}
        | {kind:"judge", runId} | {kind:"expiry"} | {kind:"system", why: "run-stopped" | "boot"}
```

- `payload` never changes after the ask (a test asserts it); only `status`, `answer`, `decidedBy`, `reason`, `route`, `escalatedAt`, `answeredAt`, `started` and `briefHash` move, and `status` only out of `pending`.
- `accepted` by the permission mode at ask time records `{kind:"mode"}` and no reason; `expired` records `{kind:"expiry"}`; a stop records `cancelled` with `{kind:"system", why:"run-stopped"}`. So every status past `pending` says who and why, and the UI never has to guess.
- `answerApproval` becomes `answer(record, decision, by, reason, answers)`; the same transaction writes the status, `decidedBy`, `reason` and any mirrors (section 4). `ApprovalDecision` becomes `accept | accept_for_thread | decline | revise` (`accept_for_thread` writes the tool name into `allow` in `cairn.permissions`, section 5; `revise` is briefs only and needs a reason). `RespondInput` gains `reason` and `answers` as optional keys. The decoder is a union by `kind` so a brief cannot be answered with a question's `answers`.
- **Stop cancels.** `PiDurableHarness.stop` (and RunTerminal `interrupted`) commits `cancelled` for each pending record whose `toolTaskId` belongs to the aborted run. Briefs and escalated questions are not tied to a run and are untouched. On kill, nothing changes: the boot rerun finds the record and waits again (ADR 0013).
- **Transcript line.** A settled record renders as one row: "Approved by you", "Declined: <reason>", "Answered by <parent title>: <reason>", "Accepted by full access", "Expired", "Stopped". Rows are ordered by `askedAt` among the entries; this is where outcomes finally reach the UI.

### 2. The brief

**Record.** Kind `brief`, in the proposing (parent) thread's `cairn.approvals`, id `brief-<tool task id>`. Payload:

```
Brief = { title<=80, task, why, avoid: string[],
          doneWhen: [{ text, judge: JudgeRef }]   // >= 1: how the result will be judged
          workspace: "worktree" | "shared"        // "stone" arrives in phase 3
          base: string | null, writes: string[]    // write scope, project-relative, no ".."
          role: string | null, model: ModelRef | null, thinking: ThinkingLevel | null
          mode: RuntimeMode                         // never wider than the parent's
          mayCommit: boolean                        // commit yes, push and merge never in phase 2
          budget: { maxTurns?, maxMinutes?, maxUsd?, maxTokens? }
          result: "text" | JSON Schema              // the typed-results target
          decisions: Question[] }                   // optional numbered decisions with picks, after Ultimate
JudgeRef = {kind:"command", argv, expectExit, timeoutSec} | {kind:"user"}
         | {kind:"model", role|model, rubric} | {kind:"verification", recipe}   // the last arrives in phase 4
```

**The `brief` tool** (`apps/server/src/approvals/BriefTool.ts`, `callers: ["model"]`, `replay: "safe"`): flat parameters, one boundary parse into the typed brief (Fold), refusals that name the field (Ultimate). It refuses a mode wider than the parent's, an unresolvable role or model, `..` in a write scope, no `doneWhen`, and `revises` unless that brief is `revised`. It commits the pending record and returns at once: "Brief 3 is waiting for the user's Go. You will be told when it is answered." The parent ends its turn or carries on. Retrying the same tool task finds its record (the ledger's rule).

**Answers.** Go, Send back (notes required, status `revised`, the parent writes a revision with `revises`), Decline (reason optional, status `declined`). Expiry is 7 days (`expired`; unlike an Executor call, nothing waits on it). Each answer is delivered to the parent as a follow-up input with request id `brief:<id>:answer` through the subagents note's delivery primitive; the text says what happened and quotes the reason.

**Go starts the child once.** `answerBrief` is one host commit: set `accepted`, `decidedBy`, `reason`; create `StartChild { briefId }` as a conversation-owned background task of the parent's conversation. `StartChild`'s phases are idempotent by `briefId` (probe 1): prepare the workspace, create the child thread's launch (a `thread_launches` row keyed by a thread id derived from the brief id, `ThreadLaunch` already resumes from its recorded phase), record `childThreadId` in the record's `started`, submit the rendered brief with request id `brief:<id>`. The child's first input is rendered from the frozen payload plus the user's note; the record keeps `briefHash`, which a conformance scenario compares with the input. Phase bodies belong to the subagents note; this note fixes the contract (created in the Go commit, idempotent by brief id, parked shows on the parent, not auto-retried at boot).

**Kill windows** (each a judge case, all but the first measured in probe 1): before the commit (pending, still answerable), inside it (pending, no task), after it (task resumes), mid-prepare, after the child exists, after the input, five kills (blocked, Retry on the parent finishes it once).

**As built (4A, 2026-10-29).** The delivery and the tasks changed when the package landed, and the brief tool is narrower than the record above; the rest stands.

- _Delivery._ Answers keep 2A's choice, which the conformance goldens fixed, rather than one follow-up per answer: Go reaches the parent as a note (entry kind `cairn.brief-answer`, data `started: true` and the child's thread id), written in the commit that creates the child; Decline, Send back and expiry reach it as a follow-up input, or as a note when the parent is halted (stopped, failed or parked) as the brief settles. Every answer uses request id `<briefId>-answer` (`SubagentRequestIds.briefAnswer`, `-` as the separator, as the protocol's `RequestId` requires), so a rerun lands it once. An accepted brief whose role resolves to no ready model, or whose workspace cannot be made, starts nothing and tells the parent so.
- _The tasks._ `subagent_spawn` is the brief tool; it commits the pending record and an expiry task (`cairn.subagent-brief`) that sleeps on pi-durable's clock until `expiresAt` and holds nothing in memory. The answering commit creates `StartChild` (`cairn.subagent-start`) for Go, or a tell task (`cairn.subagent-brief-tell`) for Decline and Send back; the expiry commit creates the tell task for an expired brief. `StartChild` resolves the brief's role at Go (ADR 0035), makes the workspace, then creates the child in one commit that also records `started`; the child is a thread with a hidden row (3A), not a `thread_launches` row. It is left out of the boot retry of parked subagent tasks. `briefHash` is not written yet.
- _The brief tool is narrow._ `subagent_spawn` takes `description`, `brief`, `why`, `isolation`, `result_schema`, `wake` and `role` (flat, as the subagents note has it), and fixes the rest of the brief: `doneWhen` is always one criterion, "The parent accepts the result.", judged by the user; `avoid`, `writes` and `decisions` are empty, so there is no `..` refusal on `writes` yet; `base` is null (the child's worktree branches from the parent's head); `mode` is always the parent's effective mode; `mayCommit` is false; `budget` is always `DEFAULT_BUDGET`. There is no `revises`, so a Send back's revision is a fresh spawn and never sets `supersedes`. `briefHash` is not written. Package 4E (budgets) picks up `budget`, 5A (goals and the envelope) picks up `doneWhen`, `writes` with its refusal, `mode` and `decisions`, and `revises` and `supersedes` go with the Send back's revise flow; each adds its parameter with its refusal and a table test.
- _Roles and the brain's cap._ The ask checks the role (`RoleAliases.resolve`): a role nothing ready answers to is refused with the roles that resolve now, and a role table that cannot be read is refused with a text that says to call again. `StartChild` resolves the role again at Go; a role that no longer resolves starts nothing and tells the parent once, while an unreadable table is reread every 30 seconds for ten minutes before the parent is told. A brief with no role resolves its parent's model as a literal spec, so its dispatch record carries a real `priced` and `family`. Beside the parent's cap of 8, the whole brain holds at most 32 children live (S3's `MAX_LIVE_CHILDREN_PER_BRAIN`): pending briefs, start tasks that can still run (parked ones too) and unsettled registry items, across the parents listed in the session document `cairn.subagent-parents`. The spawn refuses at the cap and the start's creating commit counts again, so two threads' spawns racing cannot start a 33rd. A start parked by the crash-loop guard is never retried at boot, by neither the parked subagent repair nor the parked approval-wait repair (`HUMAN_RETRY_TASKS`), even when its parent has another approval pending.
- _Upgrade from 3A._ The expiry task is version 2 of `cairn.subagent-brief`. A version 1 task (3A's, which started the child itself) found in `wait` with its brief already answered creates the start (or the tell) in its completing commit, so a brief between Go and its child when 4A is deployed still starts once.
- _Judged by_ `judges/brief-go.sh`: the ten windows of probe 1 on the real code (the three-way race and Decline among them), the five-kill parked case, and a broken control that answers Go in one commit and creates the start in a second; and the scenarios `subagent_brief_expired`, `subagent_brief_expired_across_restart`, `subagent_brief_go_twice`, `subagent_brief_go_across_restart`, `subagent_brief_schema_refused` and `subagent_spawn_with_role` on both harnesses.

**Card.** Header "Brief" and the title, parent thread link; Do, Why, Avoid; "Judged by" with one chip per criterion and its judge; Where (workspace, base, writes); Who (role or model, mode, "inherits" when equal to the parent's); Budget; optional decisions with the proposer's picks. Actions: **Go** (primary), **Send back** (opens a note field), **Decline** (optional reason); menu Copy and "Download as markdown" (the plan card's menu, without "Save to workspace"). "Edit and Go" is not in phase 2: a changed brief is a different approval.

### 3. Goals and criteria

**A goal is a thread with criteria.** Conversation document `cairn.goal` on the goal thread (version 1, `fork: "initial"`):

```
Goal = { objective: string,                       // the user's words
         criteria: Criterion[],
         envelope: Envelope | null,               // limits for briefs the goal may approve by rule (section 7)
         closedAt, closedBy: Decider | null }
Criterion = { id, text, judge: JudgeRef, state: "open" | "met" | "failed",
              verdict: Verdict | null, tries, changedAt }
Verdict = { at, ok, judge: JudgeRef, evidence: { exit?, tail?, sha?, model?, note? }, runId }
```

The shell row gains `goal: Option<{total, met, failed}>`; "is a goal" is `criteria.length > 0`, not a row kind (ADR 0026).

**Who may write what.** Criteria enter by the user (`goal.setCriteria`, `decidedBy` user) or by the model's `goal_criteria` tool, which writes a `criteria` approval the user answers (so the judge a model proposes is read by the user before it binds). `state` and `verdict` are written only by `apps/server/src/verdicts/Verdicts.ts`, the verdict writer, called from a judge run. The model's `goal_check {criterion}` creates a durable `JudgeRun` task (conversation-owned, background); it returns "queued", never a result. An architecture test fails if `state = "met"` or a write of `verdict` appears outside that module, in the style of `brain/Footguns.test.ts`.

**What "met" means.** The criterion's latest verdict is `ok`, recorded after the criterion last changed, by a judge run the server made. A `command` judge runs `argv` in the goal thread's checkout (or a named child's worktree) and records exit code, output tail and `sha`; rerunning is safe, so the run task is `replay: "safe"`. A `user` judge is a mark in the UI (`decidedBy` user). A `model` judge is a one-shot call to a model of a different family than the thread's, recorded with the model id and reply; it is not a subagent, so it needs no brief. A `verification` judge waits for phase 4. The same `JudgeRef` and `Verdict` types judge a brief's `doneWhen`; those verdicts attach to the subagent's result (subagents note).

**Progress.** `packages/client-logic/src/GoalProgress.ts` is a pure function over the goal document, the children's shell rows and the pending records: "2 of 4 criteria met, 1 subagent working, 1 brief waiting for Go". No percentage and no model-written status line. The goal strip lists criteria with their state glyph, judge chip and an evidence popover (exit code, tail, sha), then the children by lineage, then pending briefs.

### 4. One card, and a child's question

**The card.** `apps/web/src/composer/RequestCard/` (Foldkit submodel) docks above the composer, one request at a time with "i/N", ordered approvals first (they hold a run), then questions, then briefs. The pure logic is `packages/client-logic/src/PendingRequests.ts`, ported from `pendingUserInput.ts` and the panel logic at `fe27e8e3` with a port header. Behaviour: approval Approve/Decline with Decline opening a reason field (HumanLayer; the text reaches the model), "Allow for this thread" in the menu; question one at a time, digits 1 to 9, single-select advances after 200 ms, "Something else" last, a note field, "my pick" and Accept picks, 44 px targets on touch, and Send opening a 3 second undo bar before `thread.respond` (client-side, Ultimate); brief as in section 2. Single-key shortcuts act only when no text field has input and the card has focus.

**`ask_user`** (`callers: ["model"]`, `replay: "safe"`): questions with `header, question, options[{label, description, recommended?}], multiSelect?, allowCustomAnswer?`; writes a `user-input` record and waits like an approval; the answer text returns as the tool result in the numbering t3code and Ultimate use. In a thread with no parent it routes to the user.

**Routing, in code** (`apps/server/src/approvals/QuestionRoute.ts`, a reactor on the commit feed):

1. `ask_user` in a child (its `cairn.subagent` document names a parent; subagents note) writes `route: "parent"`. The child's row shows `waitingFor: parent` ("Asked its parent"), not an Input status.
2. The reactor submits the question to the parent as a follow-up input, request id `question:<approvalId>`, text "A subagent asked: ... Answer with `answer_child` if the task or your instructions settle it, otherwise `escalate`." It cancels that queued input if the record settles first (t3code).
3. `answer_child {approvalId, answer, reason}` (reason required) commits the answer to the child's record with `decidedBy {thread: parent}`. `escalate {approvalId, why}` sets `route: "user"`, `escalatedAt`, `reason`.
4. The reactor escalates by itself when the parent's RunTerminal arrives with the record still `parent`-routed, when the parent fails, parks, is archived or deleted, or 15 minutes after the parent's model first saw the input (the input's placement time, not the question's age).
5. At escalation, one transaction sets the route and writes `cairn.escalations[approvalId] = {childThreadId, kind, payload, askedAt, status}` in the parent's conversation. The parent's projection, its row's `pendingRuntimeRequest` and its card read only the parent's own documents; the child's record stays the source.
6. The user may answer a parent-routed question from the child at any time (the user is the top); the parent's later `answer_child` fails "already answered by the user".

**Exactly once from either thread.** `thread.respond {threadId, approvalId}` with the parent's `threadId` resolves the record through the escalation entry (the entry must exist and be unresolved, which is also the authorization check), then calls the same `answer` on the child's conversation. The transaction updates the record and the mirror together; a second answer, from either thread, gets `already_settled` carrying `decidedBy`, and the loser's card shows "Answered on <device> at <time>". The existing three-answers race (spike 4, rerun 2026-10-22) is the base; the new case is two threads.

**Rollup.** The client adds each descendant's escalated request to its ancestors' rows, approval over input, as t3code does (`packages/client-runtime/src/state/threadShell.ts:48-80`), minus the provider-native exception. Depth beyond one hop shows on the nearest thread the user can open from the sidebar.

### 5. Permission modes that gate

| Mode | Asks for | Notes |
| --- | --- | --- |
| Full access (default) | nothing | no records written for coding tools; Executor calls keep their audit record |
| Auto-accept edits | `bash`, Executor `call` and `execute`, Cairn tools that act (publish, portal) | `edit` and `write` pass |
| Supervised | everything except `read`, `grep`, `find`, `ls`, `executor_search`, `executor_describe`, `executor_skills` |  |
| Auto | not offered in phase 2 | t3code's pi provider does not offer it; it is the natural slot for a decider (section 7) |

`brief`, `ask_user`, `escalate` and `answer_child` are never gated by mode: a brief is the gate for delegation in every mode.

- **Where the mode lives.** `EnsureThread` and `ThreadAgentChange` gain `runtimeMode`; the harness writes conversation document `cairn.permissions {mode, allow: string[]}`; `thread.configure` gains `runtimeMode` (idle only, like `cwd`). Gated tools read it with `api.snapshot` at call time. The shell row's field stays the sidebar's copy.
- **Wrappers.** `write`, `edit` and `bash` become `replay: "safe"` wrappers: read the mode, `ask` and `awaitAnswer` if gated, then the memo mark, then the pi-durable tool's own `execute`. The wait sits before the mark, so a kill during it reruns and waits again; a kill after it reports "may have run" (probe 2). This changes phase 1's policy test and needs the durability judge's mid-tool windows rerun with a gated tool. Alternatives and why not: a `beforeTool` hook cannot commit a record; swapping extension selections per mode needs per-conversation selection Cairn does not use, would give every conversation both sets by default, and misses the prompt cache on each switch.
- **Executor.** `autoAccept` comes from the mode. A program (`executor_execute`) is approved once, as the program: its record shows the code (`CODE_MAX` 64 KiB, the user "approves exactly what the record shows"), and its nested prompts are accepted under that approval instead of declined (`GatedCall.ts:136-145`).
- **Inheritance.** A child's mode is the brief's `mode`, default the parent's, never wider (t3code's rank rule). The child's `cairn.permissions` is written when its conversation is created. A supervised child's approvals reach the user, shown in the parent (section 4); a parent model cannot answer them.
- **Allow for this thread.** `accept_for_thread` appends the tool name to `allow`; wrappers skip the ask for it. It exists because supervised without it asks on every `bash`.

### 6. Approval push

Extend `Notifier.handleEvent` (`apps/server/src/push/Notifier.ts:432-470`): on the same `thread.activity-updated` events, if the row has a user-routable `pendingRuntimeRequest`, claim `req:<approvalId>` in `notified_runs` and push, unless `Presence.isWatched` is true for the row's thread, for the request's home thread, or for any ancestor (the card shows on all of them). A suppressed claim is retried by a sweep every 30 seconds: still pending, unclaimed as sent and not watched now, at least 60 seconds old, claim `req:<id>:late` and push. One reminder at 15 minutes (`req:<id>:remind`). The message: title the thread's title; body by kind ("Go? <brief title>", "Approve <summary>", "<header>: <question>", prefixed "<child> asks:" when escalated); `tag: ask:<threadId>` so a second request replaces the first and the body counts ("3 things need you", from a new row field `pendingCount`); `url: /t/<threadId>`. The badge becomes unseen results plus threads with a pending request.

Limits to state, not fix: a push is claimed before it is sent, so a crash between the two loses it (the sweep covers a pending request, not a lost first send); iOS requires a visible notification for every push, so an answered request's notification cannot be cleared silently, and the card says who answered and when.

### 7. `decidedBy`, and what hands-off goals need later

Phase 2 writes `user`, `mode`, `expiry`, `system`, `thread` (a parent answering a question) and, if the workflow question resolves that way, `envelope`. Later, hands-off goals add only: a `grant` in `cairn.goal.envelope` (user-signed limits and an expiry), a decider service that answers pending records inside the grant (a parent thread, a rule, or a verifier on another model family) with `decidedBy {kind:"proxy", grantId}` and a reason, and a report listing every such decision. Needed from phase 2 for that: the record fields (done), criteria bound to judges (done), `route` and `escalatedAt` so a decider sits where the parent sits, the `auto` mode slot, and the envelope field reserved on the goal document. Adding a `Decider` member is additive for stored data; clients ship with the brain (boot data), so decoding stays in step.

### 8. Thread states and glossary changes

- `docs/golden/thread-states.md` and `judges/thread-states.test.ts`: add statuses `revised`, kinds `brief` and `criteria`, `WaitingFor` `parent`; amend invariant 1 (a pending request with no run leaves the row `idle`), invariant 7 (the row names the oldest user-routable request, escalations included) and 8 (`revised` too is reached only from `pending`); label map rows for "Go" (brief), "Asked its parent", Revised and Cancelled; mark `cancelled` as written by stop. The sidebar's unreachable "Waiting" label is dead code; remove it in the same package.
- **Glossary check (2026-10-27 text).** **Goal** fits the design; amend to "A thread with stated criteria, each naming the outside judge that decides it, that owns the subagents and stones working toward them." **Brief** needs "It is an approval (kind `brief`) the user answers with Go, Send back or Decline; nothing delegated starts until it is approved". **Approval** should read "holds one gated tool call, question or brief ... and records who decided and why". **Permission mode** should say what the other modes ask for (section 5). Proposed new terms: **Question card** ("The one card above the composer through which an approval, a question or a brief is answered; settled, it becomes one line saying who decided and why."), **Go** ("The answer that approves a brief; one commit that also starts the child."), **Criterion** ("One stated, checkable condition of a goal, naming its judge; met only by a verdict."), **Verdict** ("An outside judge's recorded result for a criterion: ok or not, with its evidence."), **Escalate** ("To move a child's question from its parent to the user."). **Envelope** only if the workflow question resolves that way.

### Seams with the other notes

- **Subagents.** Needs from them: `StartChild`'s phase bodies and the launch of the child thread; the subagent record (`briefId`, outcome, divergence, verdicts); the delivery primitive (answers and the question input go to the parent as follow-ups with request ids); `cairn.subagent` on the child (parent id, brief id); lineage on the shell row; the rule that a child cannot spawn in phase 2. Gives them: the brief record to read, the start contract (section 2), `Verdict` and `JudgeRef`.
- **Memo maps and the runtime.** `StartChild` and `JudgeRun` call back into Cairn from task phases, so they run through the one `ManagedRuntime` (S43); a layer built for a child thread needs a fresh memo map (stage 2.6, `MemoMapIsolation.test.ts`), which the subagents note owns.
- **Workflows.** A node is an `agent(...)` call that must have an approved brief. Options: (A) every node raises a Go card (literal, and a ten-node fan-out is ten cards on a phone); (B) the launch approval approves every brief the script will issue, bound to the script's hash (fails for briefs computed from earlier results); (C) the launch approval carries an envelope, and a node brief inside it is recorded `accepted` with `decidedBy {kind:"envelope", approvalId}` and a reason naming the limits, while one outside it raises an ordinary card. **Recommend C**: every child has an approved brief record, the audit trail is the same, and it is the same mechanism hands-off goals will use. This note supplies `briefWithin(envelope, brief)` and the `Envelope` type `{maxNodes, roles, modes, writes, budget}`; the workflows note owns the launch card and the node tool. It needs the user's decision (question 1).

## Judges

| Piece | Outside judge |
| --- | --- |
| Decision record v2 | A migration test over a real v1 store fixture (records read back with `null` fields); `thread-states.test.ts` fails if a status, kind or `WaitingFor` value is missing; a property test that `payload` is unchanged by any answer |
| Go starts once | Promote probe 1 to `judges/brief-go.sh` (the table above, on the brain with the scripted model); conformance scenarios `brief_go`, `brief_declined`, `brief_sent_back`, `brief_across_restart`, `brief_double_go`, `brief_expired`; a mutation that starts twice must fail at least five scenarios on each side (ADR 0024) |
| Brief tool | Table tests of every refusal; a faux-model eval that a wider mode, a missing judge and `..` come back as errors naming the field |
| Gating | `CodingTools.test.ts` rewritten to assert the wrapper policy; probe 2 promoted to a durability window (kill during the wait, after the mark, after the effect) on `bash`; conformance scenarios `mode_supervised_gates_bash`, `mode_auto_accept_edits`, `child_mode_never_wider`, `approval_cancelled_on_stop`, `approval_declined_with_reason` (the model sees the reason) |
| Criteria and verdicts | The architecture test above; a planted false claim (the model says done, the command judge exits 1, the criterion stays open); a kill during a `JudgeRun` reruns it once with one verdict; a `criteria` proposal that names `true` as its judge is visible on the card |
| Question routing | The two ADR 0027 scenarios (`question_answered_by_parent`: no `RuntimeRequestUpdated` reaches the user; `question_escalated`: the user answers in the parent), plus `question_parent_run_ends`, `question_answered_from_child`, a two-thread race that resolves once, and kill windows around the escalation commit |
| Card | A behaviour script `judges/request-card.ts` (Playwright on the dev client over the scripted harness): approve and decline with reason by keyboard, digits and the 200 ms advance, Accept picks and the undo bar, Go and Send back at 390 px with 44 px targets, two devices answering (one wins, the other shows who answered). No pixel baseline exists; the look is drawn in the design pass |
| Push | `Notifier.test.ts` cases: one push per request, none while watched, a late push after 60 seconds, none when answered first, one per thread tag with a count, no duplicate after a brain restart, escalated question names the child; the user then confirms on the phone once (wizard step) |
| Phase 2 gate | ADR 0026's gate: the five-node workflow from the phone starts no subagent or stone without an approved brief, and a brief pending across a restart is answered once |

## Proposed ADRs

1. **Every decision names who made it.** `cairn.approvals` version 2: `decidedBy`, `reason`, `answer`, frozen `payload`, kinds `brief` and `criteria`, status `revised`; `payload` is immutable and a status leaves `pending` once. Hard to reverse because document kinds and shapes are protocol and the hands-off decider builds on it. Gate: the migration test over a v1 fixture and the thread-states test.
2. **Go is the commit that starts the child.** A brief's answer and the creation of its start task are one transaction; the start is idempotent by brief id and, if it parks, waits for a human Retry. Gate: `judges/brief-go.sh` over all ten windows and the five-kill case.
3. **Modes gate through replay-safe wrappers with a memo mark.** `write`, `edit` and `bash` change from `unsafe` to `safe` with an effect mark, reversing a phase 1 policy (D18), because a hook cannot hold a wait. Gate: the durability judge's mid-tool windows on a gated `bash`, and probe 2's two kills.
4. **Amend ADR 0027**, not a new ADR: add the routing rules of section 4 (questions route, approvals do not; the four automatic escalation triggers; the mirror in the parent), with its existing gate.

## Open questions for the user

1. **Workflow launch against node briefs.** (A) a Go card per node; (B) the launch approves all briefs by script hash; (C) the launch carries an envelope and fitting node briefs are approved by it, recorded as such. Recommend C. It reads ADR 0026's gate as "every child has an approved brief", which A reads more strictly.
2. **May a parent answer its child's approvals?** (A) no, only questions (t3code, ADR 0013); (B) routine ones through a tool with `decidedBy` thread and a reason. Recommend A for phase 2; the schema allows B, and children inherit the parent's mode so a full-access goal never raises one.
3. **Which modes ship.** (A) Supervised, Auto-accept edits and Full access, `auto` listed as later; (B) only Full access plus the gate for Executor. Recommend A, because the gating change is the same work either way.
4. **Supervised and `executor_execute`.** (A) approve the program once (its code is on the card); (B) one card per nested call. Recommend A.
5. **Which judges a criterion may name in phase 2.** (A) `command` and `user`; (B) also `model` (a one-shot verifier on another family). Recommend B, with the family rule enforced in code; `verification` waits for phase 4.
6. **Pending briefs: expire or wait?** 7 days, then `expired` and the parent is told; or never, shown with their age. Recommend 7 days.

## Risks

- **The writer wrappers change phase 1's most tested policy** (`unsafe` to `safe` with a mark). Probe 2 is one tool with a faux model; the real `bash` with streaming output, truncation and the 120 second cap needs the durability judge's windows before the ADR is accepted.
- **Stale `pending` records exist today** (stop leaves them); the migration should cancel records whose task is gone, or the new card will show ghost approvals from phase 1 threads.
- **Idle with a pending request** is a new row shape; sidebars, settle and the badge already key on `pendingRuntimeRequest`, but the thread-states doc and its test must change first.
- **`pendingCount` and `cairn.escalations`** add a document and a row field the shell projector and `ThreadWire` must carry (`VISIBLE_DOCUMENTS`, `Thread.ts:57-63`).
- **Judge commands run as the user** in the worktree, with the thread's trust (like `bash`). The criteria approval shows `argv`; a criterion the user approved without reading is the user's.
- **A pi-durable bump** can change `blocked` and `retryTask` behaviour; the probes are the check (rerun both after any bump).
- **Parent attention.** A parent that never wakes (parked, failed) must not hold a question: triggers 4 to 6 cover it, and the 15 minute window is a default to tune after the first week of use.
- **Notification fatigue** from a ten-node fan-out is bounded by the thread tag and the envelope, not solved by either.

## Work packages

Sized like phase 1's blocks (Owns, Builds, Judge; inputs listed). Names are for the plan to renumber.

- **B1 Decision record and protocol.** Owns `packages/protocol/src/{Policy,Thread,Shell}.ts` additions, `apps/server/src/brain/CairnDocs.ts` (version 2, `answer`, cancel on stop), `ScriptedHarness.ts` parity, `docs/golden/thread-states.md` and its test, `ShellProjector` (`pendingCount`, escalation mirrors, `waitingFor: parent`). Judge: migration test, thread-states test, conformance `approval_declined_with_reason`, `approval_cancelled_on_stop`. Inputs: none. Do first.
- **B2 Permission modes.** Owns `cairn.permissions`, the seam's `runtimeMode`, `thread.configure`, the gated wrappers, Executor `autoAccept` and program approval, the footer's `isEnforced`. Judge: gating row above. Inputs: B1.
- **B3 Request card.** Owns `PendingRequests.ts`, `apps/web/src/composer/RequestCard/`, `ask_user`, the transcript line for settled records, `judges/request-card.ts`. Judge: the card row. Inputs: B1; works for approvals and questions before B4.
- **B4 Briefs.** Owns the `brief` tool, the `answerBrief` commit, the `StartChild` contract and its judge, delivery of answers to the parent, the brief card body. Judge: Go rows. Inputs: B1, B3, the subagents note's launch and delivery.
- **B5 Question routing.** Owns `QuestionRoute.ts`, `answer_child`, `escalate`, `cairn.escalations`, the rollup in client-logic, the parent's card. Judge: question rows (the ADR 0027 gate). Inputs: B1, B3, the subagents note's lineage.
- **B6 Goals and judges.** Owns `cairn.goal`, `Verdicts.ts`, `JudgeRun`, `goal_check`, `goal_criteria`, `GoalProgress.ts`, the goal strip, the shell summary. Judge: criteria row. Inputs: B1, B3 (the criteria card), B4 (the types).
- **B7 Approval push.** Owns the notifier rules, the late-check sweep, the reminder, the badge, the service worker copy. Judge: push row and the phone check. Inputs: B1 (`pendingCount`).
- **B8 Envelope** (only if question 1 is answered C). Owns `Envelope`, `briefWithin`, the `envelope` decider, the scenario `workflow_node_within_envelope`. Judge: a five-node scripted workflow where four briefs fit and one raises a card. Inputs: B4 and the workflows note.
