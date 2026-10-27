# Cairn phase 2 build plan

Written 2026-10-27 from the six area notes in `docs/phase-2/notes/` (subagents, briefs, workflows, models, reach, surfaces) and the t3code nightly addendum beside them, the kickoff's phase 2 section and Targets (`~/Developer/agent-artifacts/cairn/v2/KICKOFF.md`), `docs/phase-2/backlog.md`, ADRs 0001 to 0041 and `GLOSSARY.md`. Pins are phase 1's (`docs/phase-1/plan.md`): pi (`@earendil-works/*`) 1.4.0, Effect 4.0.5, Foldkit 0.169.0, Node 26.11, t3code `fe27e8e3`.

The notes are the evidence; this plan is the decision. An implementing agent given one package should read this plan's sections 1 and 2, its package block, the note and local id the block cites, the ADRs it names, and the installed source of every library it touches (AGENTS.md, "Before using an API").

## Summary

Phase 2 is "fan-out at home": a thread delegates to subagents, and a workflow fans work out across them, with every child starting from a brief the user approved, every result typed, every dollar labelled, and every question routed to the parent before the user. It also publishes artifacts and opens dev-server portals through porch, and loads two of the user's pi extensions as tools. Its gate (kickoff): the typed-results target on three providers; a workflow of at least five nodes across two providers run end to end from the phone; an agent publishes an artifact and opens a portal, and both load on the phone.

The build starts only after the phase 1 gate (wizard stages 3, 4, 5, 7 and 8). It runs in two tracks. The brain track is seven waves of server and `packages/client-logic` work that needs no design decisions. The look track starts after the daily-driver day and the design pass, forks the views into `next` (ADR 0040), and draws phase 2's screens there once. The tracks meet in wave 6 (surfaces) and wave 7 (cutover and the gate).

## 1. Architecture

### What phase 2 adds

| Area | Shape | ADRs | Note |
| --- | --- | --- | --- |
| Subagents | A subagent is a thread with a hidden row and a `lineage`, owned by a background anchor of its parent. Seven tools: `subagent_spawn`, `subagent_send`, `subagent_status`, `subagent_stop`, `subagent_reply` for the parent; `ask_parent` and `report` for the child. A reporter task per input delivers the result as a note and the wake as a separate input. A worktree for every writing role; the `Cairn-Thread` trailer on commits. | 0026, 0027, 0028, 0034 | subagents |
| Decisions | `cairn.approvals` version 2 with `decidedBy`, `reason`, `answer`, frozen `payload`, kinds `brief` and `criteria`, status `revised`; stop writes `cancelled`. Go is the commit that starts the child. Permission modes gate through replay-safe wrappers. A goal is a thread with a `cairn.goal` document of criteria bound to judges. Questions route to the parent model first. | 0029, 0030, 0031, 0027 | briefs |
| Workflows | Durable scripts with an injected prelude (`agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`), their own script slots, a dispatch ledger in `cairn.workflows`, a launch approval that is an envelope, per-node stop, and the council recipe. Durable events with exactly-once reactors carry facts with several consumers. | 0012 (amended), 0032, 0033 | workflows |
| Models and cost | Role aliases resolved at dispatch; a result tool with a real schema, a repair step and two attempts; a spend ledger derived from `pi.usage`; labelled list prices; budgets enforced at dispatch, before each tool and by a guard; Codex login and plan windows. | 0035, 0036, 0037 | models |
| Reach | Cairn calls the porch CLI; artifacts under `~/Developer/agent-artifacts/<project>/`, owner-only; portals as transient user units; Caddy reloaded with `docker exec`, with `stream_close_delay`. A tools-only host loads `pi-web-access` and `pi-fff` from an allowlist, one instance per folder. | 0038, 0039 | reach |
| Surfaces | The views fork into `next` behind the route seam, on one store; the transcript owns its measured list; one thread-state function; the request card, brief card, subagent rows and rollup, work panel, steps panel, meters, goal strip, artifact and portal entries, all drawn once in the new look. | 0040, 0041 | surfaces |

### Durability rules every package keeps

- Every cross-boundary step has an idempotency key and a receipt: request ids derived from the child and its settlement (delivery), the brief id (start), the ledger row (dispatch), the reactor cursor (events).
- Nothing waits inside a hook or a script call that holds a timeout. A wait is a replay-safe tool that finds its record after a restart (ADR 0013).
- Every new pi-durable task names its `replay` policy, and every `unsafe` effect is behind a mark (ADR 0031).
- Every package that adds a crash window adds it to a kill judge: `judges/events-kill.sh`, `judges/brief-go.sh`, `judges/subagent-durability.ts`, the workflow matrix, `judges/reach-restart.sh`.
- A pi version change refuses to deploy while a workflow runs (ADR 0012, amended).

## 2. Decisions

Decided by the user on 2026-10-27 (stage 1 of the backlog, then the thirty questions from the notes, all taken as recommended).

| Question | Decision | Where |
| --- | --- | --- |
| Shape of phase 2 | Two tiers: goal threads coordinate; every subagent or stone starts from an approved brief | ADR 0026 |
| Who sits at the top | The user; a child asks its parent; routing in code | ADR 0027 |
| Design pass | After the daily-driver day, as the look track; new screens built once in `next` | ADR 0011, 0040 |
| Port or rebuild | Port the nightly's behaviour, draw it in the new look; new surfaces from scratch | ADR 0011 |
| Sidebar | Decided in the design pass, from the daily-driver day | ADR 0011 |
| Hands-off goals | After phase 2; phase 2 adds `decidedBy`, reason and judge-bound criteria | ADR 0026, 0029 |
| Subagent model | A thread with a hidden row; the reserved `conversationId` is removed | ADR 0028 |
| Stop on a goal thread | Children keep working; the row offers Stop all | ADR 0028 |
| Child approvals | The user's only; only questions route to the parent | ADR 0027 |
| Completion wakes the parent | Yes, by default | ADR 0028 |
| Brief in full access | Always waits for Go | ADR 0030 |
| Isolation | A worktree for writing roles; shared checkout for read-only roles | subagents note |
| Caps | Depth 2, 8 live children per parent, fixed until measured | ADR 0028 |
| Workflow launch vs node briefs | An envelope; fitting node briefs are approved by it | ADR 0032 |
| Modes | Supervised, Auto-accept edits, Full access; `auto` later | ADR 0031 |
| Executor in Supervised | The program is approved once | ADR 0031 |
| Criterion judges | `command`, `user` and `model` (another family) | briefs note |
| Pending briefs | Expire after 7 days; the parent is told | ADR 0030 |
| Brief card on the phone | In the composer slot, then a transcript line | surfaces note |
| Single node stop | Allowed; the script sees `null` | ADR 0012 (amended) |
| Where a workflow runs | In the launching thread's run; a coordinator thread is a later spike | ADR 0012 (amended) |
| Run on 1 first | A separate run, no cache | ADR 0032 |
| Third typed-results provider | Codex login; `opencode-go/gpt-6-luna` the fallback | ADR 0037 |
| Role table | `@worker` Opus 5.5 medium, `@scout` Sonnet 5.5 high, `@judge` `opencode-go/gpt-6-luna`, `@verifier` Codex `gpt-6-luna`; global, with a per-launch override | ADR 0035 |
| Claude in dollars | Labelled "at API list price" | ADR 0036 |
| At a budget | Workflows abort running nodes and offer a raise; a goal's own subagents stop taking new work | ADR 0036 |
| Codex usage endpoint | Used, with "unreadable" on change | ADR 0037 |
| Caddy | Stays in Docker; reload with `docker exec`; add `stream_close_delay` | ADR 0038 |
| `plans.gneiss.run` | Owner-only | ADR 0038 |
| Artifacts | `~/Developer/agent-artifacts/<project>/` | reach note |
| `ffgrep`, `fffind` | Beside `grep`, `find`; revisit after the daily-driver week | ADR 0039 |
| Portals | 12 h, six at once | ADR 0038 |
| Exa counter | Shared with the TUI | ADR 0039 |
| New screens | Only in `next`; the phone on `next` before the gate | ADR 0040 |
| Transcript list | The look track's first package, confirmed after the daily-driver day | ADR 0041 |
| Themes | Tokens for dark and light; preview rounds in dark | ADR 0040 |

## 3. Waves

### Rules every package follows

Phase 1's rules hold unchanged (`docs/phase-1/plan.md`, section 3, "Rules every package follows"): ownership, integrator-only seams, dependencies only on earlier waves, extension points instead of edits, the standards and port headers, done means `pnpm check` green plus the package's judges, and an integration note per wave, written in `docs/phase-2/waves.md`. Phase 2 adds:

- **More seams.** `apps/server/src/brain/ExtensionOrder.ts`, `packages/protocol/src/index` exports, and `apps/web/src/next/Frame.ts` are integrator-only too.
- **Every protocol shape for the phase is written in 1.0.** Later packages fill them in; a package that needs a new field stops and asks the integrator.
- **Scenarios before code.** A package that adds conformance scenarios writes them first and shows them failing on both harnesses, then makes them pass on the scripted harness, then on pi-durable.
- **Per-scope layers** go through `ChildScope.build` (ADR 0034).
- **Real-model judges** use the cheapest model that answers the question and report their cost.

### Wave 1: foundations

Step 1.0 runs first and alone; then 1A to 1H run in parallel.

#### 1.0 Contract

Owns `packages/protocol/src/{Subagents,Workflows,Reach,Spend,Roles}.ts` and the additions to `Policy.ts`, `Thread.ts` and `Shell.ts`: the settlement and `lineage` shapes, approvals version 2 (kinds `brief` and `criteria`, status `revised`, `decidedBy`, `reason`), `WaitingFor.parent`, the workflow and ledger documents, the brief payload, the reach rows, spend and role schemas. Removes the reserved `conversationId` fields. Declares every new dependency and the migration numbers for the phase. Judge: `pnpm check`; `judges/thread-states.test.ts` with the new statuses in `docs/golden/thread-states.md`; the JSON Schema export test. Sources: subagents S1, briefs B1 (protocol half), models M1 (protocol half), reach R3 (schemas).

#### 1A Decision record

Owns `apps/server/src/brain/CairnDocs.ts` (version 2, `answer`, `cancelled` on stop), the migration of version 1 records, `ScriptedHarness.ts` parity, and the projector's `pendingCount`. Judge: the migration test over a version 1 fixture; conformance `approval_declined_with_reason` and `approval_cancelled_on_stop` on both harnesses. ADR 0029. Source: briefs B1.

#### 1B Durable events

Owns `apps/server/src/brain/Events.ts`, the `cairn.events` conversation, the reactor host, boot and close wiring, the status RPC and monthly rotation. Judge: `judges/events-kill.sh` (at least ten kills and injected handler faults, every event handled once). ADR 0033. Source: workflows W1.

#### 1C Prices, families and model health

Owns `apps/server/src/models/{ModelPrice,ModelFamily,ModelHealth}.ts`, the provider `basis` table, and `classifyRunFailure` patterns and `usage_limit` for Codex and OpenCode Go. Judge: pricing unit tests (tiers, the bridge's labelled equivalent, all-zero is unpriced), the family table, J-health, `RunFailure.test.ts` additions. ADR 0036. Source: models M1, M4.

#### 1D OAuth store and the Codex login

Owns the `oauth_credentials` migration, `OAuthStore.ts`, `CodexLogin.ts`, the login RPCs, the `CredentialStore` change, and the Codex stage of `ops/wizards/phase-2.sh`. Judge: J-codex's rotation test on a fake provider; `judges/pi-readonly.sh`; then the user's real login (wizard). ADR 0037. Source: models M8.

#### 1E One thread-state function

Owns `packages/client-logic/src/ThreadState.ts` and `SubagentRollup.ts` and `EffectiveMode.ts`, with t3code's rollup and sidebar tests ported. Replaces `resolveSidebarThreadStatus`, `resolveSidebarTopStatus` and `holdOf` as the source of a row's state, tone and word. Judge: unit tests over every row of `docs/golden/thread-states.md`; the ported tests. Source: surfaces L4, subagents S1 (client half).

#### 1F Workflow script and plan

Owns `apps/server/src/workflows/{WorkflowScript,Prelude,WorkflowPlan}.ts`: parsing `export const meta`, the injected prelude, the dry run with its call-site table and estimate, `validate`. Judge: parser and refusal unit tests; the dry run on the council recipe and on a looped script. Source: workflows W2.

#### 1G porch changes

In the porchlight repo, in its own worktree: `porch lease`, a `publish` refusal for files porch did not publish plus `unpublish`, a `guard` setting, `no-cache` on the artifacts porch, and the two `import caddy` faults filed upstream. Judge: porchlight's tests, each red first, on its throwaway Caddy. Source: reach R1.

#### 1H Tools-only pi host

Owns `apps/server/src/pi-host/` (four modules), the `PiConfig` extension list, `ExtensionOrder.piTools`, and the fixture extension. Judge: `PiToolAdapter.test.ts`; `PiHost.test.ts` with its cwd-isolation mutation control. ADR 0039. Source: reach R7.

### Wave 2: seam, gating and spend

#### 2A Seam and scripted semantics

Owns the seam additions (`PassiveEntry.model`, `ThreadEnsured.parent`, `SubagentUpdated`), `CommitFeed` document diffs, the scripted harness's owned conversations, reporters, routing and mirror, and the twelve subagent scenario groups with goldens. Judge: the scenarios fail first, then pass on the scripted harness; the four new mutations each fail at least two scenarios. Source: subagents S2.

#### 2B Permission modes

Owns `cairn.permissions`, the seam's `runtimeMode`, `thread.configure`, the gated `write`, `edit` and `bash` wrappers with their effect mark, Executor's mode-driven accept and program approval. Judge: the durability judge's mid-tool windows on a gated `bash`; the briefs note's probe 2 kept as a test. ADR 0031. Source: briefs B2.

#### 2C Spend ledger

Owns the `spend_totals` and `spend_events` migration, `SpendLedger.ts`, the boot reconcile, `completeSimple` recording, `thread.spend` on the shell row and `spend.get`. Judge: J-spend (a `kill -9` never double counts; unpriced never shows as zero). Source: models M2.

#### 2D Role aliases

Owns `apps/server/src/models/RoleAliases.ts`, `ServerSettings.roleBindings` with the seeded defaults, `roles.check` and the `roles` tool. Judge: J-roles, including the changed-table scenario. ADR 0035. Source: models M3.

#### 2E Result tool

Owns `apps/server/src/models/ResultTool.ts` (`cairn.results`): the envelope schema, `prepareArguments` repair, the two-attempt cap and nudge, the `cairn.result` document. Judge: J-validator unit tests, then J-typed on OpenCode Go (8 of 8 per model) and the bridge. Source: models M5.

#### 2F porch client and machine setup

Owns `apps/server/src/reach/PorchClient.ts`, the `artifacts` and `portals` migrations, `judges/porch-contract.ts`, `judges/caddy-reload.ts`, and the reach stage of `ops/wizards/phase-2.sh` (Caddyfile backup, porch binary and `init`, the compose mount, the `import` line, `stream_close_delay`, validate, reload, a probe publish). Judge: unit tests on the fake layer; the reload judge's control fails and its real run passes; `porch doctor` clean after the user's wizard stage. Source: reach R2, R3.

### Wave 3: subagents live

#### 3A Subagents extension

Owns `apps/server/src/subagents/` (the seven tools, anchor and reporter tasks, the router, `ChildScope`, `SubagentRows`), the extension order key, `answerApproval` mirror handling and the three boot repairs. Judge: the subagent scenario groups on pi-durable; the extended `MemoMapIsolation.test.ts` and the build scan. ADRs 0028, 0034. Source: subagents S3.

#### 3B Workspaces and the trailer

Owns the `child_workspaces` migration and store, the spawn's workspace step over `Worktrees.create`, the `bash` `prepare` trailer, the release action and the workspace boot repair. Judge: temp-repo tests, including a kill between the intent and `git worktree add`; nothing deletes a dirty or unmerged worktree. Source: subagents S4.

#### 3C Pending requests, server side

Owns `PendingRequests.ts`, `ask_user`, and the settled-record transcript line data. Judge: conformance scenarios for a question and an approval answered from another device. The card itself is wave 6. Source: briefs B3 (server half).

#### 3D Codex plan windows

Owns `CodexUsage.ts` and `UsageFeed` for more than the bridge. Judge: decode tests on recorded bodies; a live read after the user's login. ADR 0037. Source: models M7.

#### 3E Artifacts

Owns `apps/server/src/reach/Artifacts.ts`, the artifact half of `ReachExtension.ts`, the `reach.list` and `artifact.revoke` RPCs. Judge: `Artifacts.test.ts`; the artifact half of `judges/reach.ts` (publish, idempotent republish, refusal to overwrite, owner-only). Source: reach R4.

#### 3F Portals

Owns `Portals.ts`, `ReachRepair.ts`, the `portal.close` and `portal.start` RPCs, the close hook and the fault hooks for judge brains. Judge: `Portals.test.ts`; `judges/reach-restart.sh`. ADR 0038. Source: reach R5.

#### 3G pi host judges

Owns `judges/pi-host.ts` and the `pi-readonly.sh` extension for `~/.pi/exa-usage.json`. Judge: the durable kill test and `pi-readonly.sh` pass. Source: reach R8.

### Wave 4: briefs, routing and the ledger

#### 4A Briefs and Go

Owns the `brief` tool, the `answerBrief` commit, the `StartChild` contract, delivery of answers to the parent, expiry after 7 days, and `judges/brief-go.sh`. Judge: the ten Go windows and the five-kill parked case. ADRs 0026, 0030. Source: briefs B4.

#### 4B Question routing

Owns `QuestionRoute.ts`, `answer_child`, `escalate`, `cairn.escalations` and the four automatic escalation triggers. Judge: ADR 0027's gate scenario and the question rows (an answer from either thread resolves once). Source: briefs B5.

#### 4C Shell wiring and the subagent kill judge

Owns shell row creation and hiding for children, tallies, settle refusals while a child is live, push suppression for ancestors on screen, the pending-request rollup, `thread.stop` with `subagents`, no-widening in `thread.configure`; and `judges/subagent-durability.ts`. Judge: projector and command tests, the ported sidebar tests; the kill judge fails against a reporter that mints fresh request ids and passes on the real one, on a faux model and once on the bridge. Source: subagents S5, S6.

#### 4D Ledger and nodes

Owns `WorkflowDocs.ts`, `WorkflowTools.ts` (`workflow_begin`, `agent`, `verify`, `approve`, `phase`, `log`, `budget`), `WorkflowGate.ts`, the workflow slot pool and the `ThreadWire` whitelist entry. Judge: workflows judges 1 to 3 and 10 (the kill matrix extending spike 3's). Source: workflows W3.

#### 4E Budgets

Owns `Budgets.ts`, `BudgetGuard.ts`, the `beforeTool` gate, `Budgets.admit` for delegating tools, notices, push and estimates. Judge: J-budget (overshoot at most one response per running child). ADR 0036. Source: models M6.

#### 4F Typed-results judge

Owns `judges/typed-results.ts` across providers with controls. Judge: 100 percent valid within two attempts on the bridge, OpenCode Go and Codex (or the recorded fallback), with both controls failing. Source: models M9, subagents S8.

#### 4G Approval push

Owns the notifier rules, the late check after 60 seconds, the reminder, the badge and the service worker copy. Judge: the push row of the briefs note's judges; the phone check in the wizard. Source: briefs B7.

### Wave 5: workflows complete, goals, reach on the phone

#### 5A Launch approval and the envelope

Owns `workflow_plan`, the envelope and its checks, `accept_sample` for "run on 1 first", the answer path, the `brief.approved` and `approval.answered` events, and the `workflow_node_within_envelope` scenario. Judge: a five-node scripted workflow where four briefs fit and one raises a card; workflows judge 3's grant cases. ADR 0032. Source: workflows W4, briefs B8.

#### 5B Workflow budgets and meter

Owns `WorkflowBudget.ts`, admission checks, soft and hard reactors, the stopper task and usage holds. Judge: workflows judge 4. Source: workflows W5.

#### 5C Stop

Owns `WorkflowStop.ts`, the whole-workflow and single-node RPCs, and abort polling in every node tool. Judge: workflows judge 2 (a stopped node is `null` to the script and nothing reruns across `kill -9`). Source: workflows W6.

#### 5D Recipes

Owns `recipes/council.js`, saved-recipe listing and launch by name, and `agent`'s `resume` option. Judge: council on a faux model (structure, `null` handling, fallback) and workflows judge 9. Source: workflows W7.

#### 5E Steps panel data

Owns the pure panel functions in `packages/client-logic` (the `deriveWorkflowGroups` port) and the steps conformance scenarios. Judge: `ThreadWire` convergence with the new document; panel tests against t3code's cases. Source: workflows W8.

#### 5F Goals and judges

Owns `cairn.goal`, `Verdicts.ts`, `JudgeRun`, `goal_check`, `goal_criteria` and `GoalProgress.ts`. Judge: the criteria rows (only a server-side verdict writer sets `met`; a `model` judge must be from another family). Source: briefs B6.

#### 5G Reach live judge

Owns `judges/reach.ts --live`, the guard judge, and the phone nonce read-back in the wizard. Judge: the user reads both nonces on the phone. Source: reach R6.

### Look track (after the daily-driver day)

Starts when the phase 1 gate's stage 8 is done and the design pass has chosen its values. Client-only, so it runs beside waves 2 to 5.

- **L0 Fork frame.** `apps/web/src/next/Frame.ts`, the `ui` client setting, `?ui=next`, the dynamic chunk. Judge: classic unchanged byte for byte (`capture.ts cairn`), `behaviour.ts --ui next` runs, the bundle budget test unchanged.
- **L1 Measured transcript list.** Judge: `range` and `reflow` leave `KNOWN_FAILING` with their broken controls still failing; new `insert-above` and `arrive` checks with controls; `typing.ts` zero drops. ADR 0041.
- **L2 Tokens.** `next/tokens.css` for dark and light. Judge: `judges/contrast.test.ts` (a planted low-contrast token fails); no palette utility or literal in `next`.
- **L3 Primitives and gallery.** `next/ui/` and a dev-only `/__look` catalogue. Judge: scene tests per primitive; `look-rules.ts` at 390 and 1,440 px with planted violations failing.
- **L5 Look tool and rounds.** `judges/look.ts`, `look-rules.ts`, publish to `plans.gneiss.run`, freeze on approval. Judge: a sabotaged state fails the rules; a frozen round fails when a token changes.
- **L6 Shell in the new look.** The sidebar as the pass decides, the chat header, the hold banner. Judge: `behaviour.ts`'s shell checks on `next`; the user's round.
- **L7 Phase 1 surfaces redrawn.** Composer and hero; transcript rows and the fold line with tallies; diff, settings and push. Judge: all of `behaviour.ts`, `typing.ts` on Chromium and WebKit, `transcript-scroll.ts`, `load.ts`, `paste.ts`, the user's rounds.

Source for all: surfaces L0 to L7 (L4 is 1E).

### Wave 6: phase 2 surfaces in `next`

Each needs L3 and the brain packages named. Judges are behaviour scripts over the scripted harness at 390 and 1,440 px, the ported t3code logic tests, and the user's round (ADR 0040).

- **6A Request card** (approval, question, brief bodies; composer slot on the phone). Needs 3C, 4A. Judge: `card-approval`, `card-question`; the `pendingUserInput` port tests. Source: surfaces W1, briefs B3 (client half).
- **6B Brief card and Go.** Needs 6A, 4A, 2D. Judge: `brief-go` including ADR 0026's restart case; Go blocked on an unbound role.
- **6C Subagent rows and the way back.** Needs L1, 1E, 4C. Judge: `rows-subagent`; the `subagentRuntime` port tests.
- **6D Rollup and parent banner.** Needs 6A, 4B. Judge: `rollup`; ADR 0027's gate played through the page.
- **6E Work panel** (lineage and steps for a child; a bottom sheet on the phone). Needs 6C, 6D. Judge: `lineage-stop`, `steps`.
- **6F Workflow steps and launch approval.** Needs 6A, 6E, 5A, 5E. Judge: `launch-approval`, `steps` for nodes and phases.
- **6G Meters and the role table.** Needs 2C, 2D, 3D, 4E. Judge: `meters` (unknown never zero), role editor script.
- **6H Goal thread.** Needs 6B, 6E, 5F. Judge: `goal-chip`.
- **6I Artifact and portal entries.** Needs 3E, 3F. Judge: `reach`.
- **6J Subagent behaviour script** for steer, stop and escalated-question flows. Needs 6C to 6E. Source: subagents S7.

Sources: surfaces W1 to W9, models M10.

### Wave 7: cutover and the gate

- **7A Cutover.** The default flips to `next` on the user's switch; the classic views and the pixel-parity judges are deleted; ADR 0040 accepted. Judge: `pnpm check` green after deletion; `behaviour.ts` and the surface scripts green on the new default; the user. Source: surfaces W10.
- **7B The gate run.** Workflows judge 6 on real models (the council recipe, five nodes across two providers) from the phone, a `kill -9` during its second pass, the deploy guard; the typed-results judge on all three providers; the reach phone check; `events-kill.sh`; the gate page under `~/Developer/agent-artifacts/cairn/v2/phase-2-gate/`. Source: workflows W10.

The coordinator-thread spike (workflows W9) is optional and not on the gate's path.

### Where each phase 2 target is judged

| Target | Judge | First passes in |
| --- | --- | --- |
| Typed results (three providers) | `judges/typed-results.ts` | 2E (OpenCode Go), 4F (all three after the Codex login) |
| Five-node workflow, two providers, from the phone | Workflows judge 6 and the phone run | 7B |
| Artifact and portal load on the phone | `judges/reach.ts --live` and the nonce read-back | 5G |
| No child without an approved brief (ADR 0026) | Ledger conformance and `brief-go.sh` | 4A, 5A, 7B |
| A child asks its parent (ADR 0027) | The routing scenario, then through the page | 4B, 6D |
| Durability of everything new | `events-kill.sh`, `brief-go.sh`, `subagent-durability.ts`, the workflow matrix, `reach-restart.sh` | 1B, 4A, 4C, 4D, 3F |
| Content never moves under you | `transcript-scroll.ts` with `KNOWN_FAILING` empty | L1 |

The fan-out target (ten stones) is phase 3's.

## 4. What only the user can do

One script, `ops/wizards/phase-2.sh`, written with the `wizard` skill.

1. **Finish the phase 1 gate** (stages 3, 4, 5, 7 and 8 of `ops/wizards/phase-1.sh`). The build starts after it, and the daily-driver day feeds the design pass: note anything about the sidebar (inbox only, or a project rail) and any scroll jumps.
2. **Codex login.** Open the device-code link the wizard prints, from any device, and approve (about two minutes). Without it, the typed-results target runs on the recorded fallback.
3. **Caddy and porch.** The wizard backs up `~/caddy/conf/Caddyfile`, then shows each edit before applying it: porch's `import` line, `stream_close_delay`, the compose mount, owner-only `plans.gneiss.run`. Confirm each; anyone you shared a plan link with will need to be on your login to open it.
4. **The design pass.** Preview rounds of the new look, published to `plans.gneiss.run`; approve or name changes. Each approved round freezes its screenshots.
5. **Switch to `next`** on the phone and desktop when the rounds are done.
6. **The gate on the phone.** Launch the five-node workflow and answer its launch approval; read the artifact and portal nonces; confirm an approval push arrives on the locked phone.

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| The scripted harness must learn owned conversations, reporters and routing, the largest single cost | 2A comes before any pi-durable code; scenarios first; the mutation check keeps both harnesses honest |
| A pi bump kills running workflows and migrates SQLite irreversibly | The deploy refuses a version change while a workflow runs; backups on every version change (phase 1) |
| The bridge as a child's model is untested under `kill -9` | 4C's kill judge runs once on the bridge |
| Typed results on Codex untested | 4F runs after the login; the fallback model is recorded |
| A Caddy reload drops every WebSocket | `stream_close_delay` in the wizard; `judges/caddy-reload.ts` |
| porch is pre-alpha and two commands destroy data | Cairn never runs `import`; 1G adds the publish refusal before Cairn calls `publish` |
| The look track waits on the daily-driver day | The brain track needs no design decisions; 1E and the list fix (L1) do not wait for values |
| A second view tree strains the entry bundle | `next` loads as a dynamic chunk; the budget test stays in `pnpm check` |
| Too many cards bury the user in a fan-out | The envelope approves fitting node briefs; push sends one notification per thread |
| Budgets overshoot | At most one response per running child, stated on the card |
| Depth and live-children caps are guesses | Fixed until measured; phase 3's fan-out judge measures them |
