# Phase 2 waves

Integration notes, one section per step or wave, with what later packages read and what was measured.

## Step 1.0: the contract

Every phase 2 shape is declared; later packages fill them in and ask the integrator for anything new.

### Protocol modules

| Module | Holds |
| --- | --- |
| `Policy.ts` | `cairn.approvals` version 2 (`ApprovalRecord`, `APPROVALS_VERSION = 2`): kinds `brief` and `criteria`, status `revised`, `decidedBy` (`Decider`), `reason`, `answer`, a frozen `payload`, `route`, `escalatedAt`, `supersedes`, `started`, `briefHash`, `mirrorOf`. The payloads: `Brief`, `WorkflowLaunch` with its `Envelope` and the model's proposed `roleOverrides`, `QuestionsPayload`, `CriteriaPayload`, `BudgetRaisePayload` (record kind `tool-call`, tool `budget_raise`), `ProgramPayload` (capped at `PROGRAM_CODE_LIMIT_BYTES`). `ApprovalAnswer.launch` (`LaunchEdits`: the budget and role overrides the user edited on a launch card, sent as `RespondInput.launch` with Go). `JudgeRef`, `Verdict`, `Criterion`, `cairn.goal`, `cairn.permissions`, `SetCriteriaInput`. Decisions `accept`, `accept_for_thread`, `accept_sample`, `decline`, `revise`. |
| `Subagents.ts` | `ThreadLineage`, `SubagentTally`, `SubagentSettlement` (entry kind `cairn.subagent-result`), `cairn.subagents`, `cairn.child`, `cairn.escalations`, `cairn.result`, `DispatchRecord`, `SubagentSpawnDetails` (the `subagent_spawn` call's `details`), the caps (depth 2, 8 live children per parent, 32 per brain) and `BRIEF_EXPIRY_DAYS` (7). `SubagentStatus` is `working`, `waiting` or `settled`: the registry item is written at Go, so a declined or expired brief lives only on its approval record. |
| `Workflows.ts` | `cairn.workflows` (`WorkflowRecord`, `NodeRecord`): `log` keyed by the `tools.log` nested task id, and the run's meter (`spent`, with `softAt` and `spentAt` set once in the commit that emits `workflow.budget.soft` or `.spent`). The event names and `cairn.events` cursors, recipe listing and reactor status. |
| `Reach.ts` | `ArtifactRow`, `PortalRow`, `reach.list`, the tools' `details`. No shape assumes a porch command (1G is dropped). |
| `Spend.ts` | `Tokens`, `Spend`, `SpendSummary` (the row's `spend`), `SpendScope`, `Budget`, `PriceBasis`, `BudgetState`. Money is integer micros. |
| `Roles.ts` | `RoleName`, `RoleSpec`, `RoleBinding` (Options, for settings), `RoleBindingJson` and `RoleOverrides` (plain, for documents), `RoleTable`, `ResolvedRole`, `RoleCheck`, and ADR 0035's table as `DEFAULT_ROLE_TABLE`. |

Additions elsewhere: `WaitingFor` `parent`; `ThreadShell` gains `lineage`, `subagents`, `goal`, `spend` and `pendingCount`, each decoding to a default from rows stored before it (`BARE_ROW_FIELDS` for fixtures); `PendingRuntimeRequest.origin`; `StopInput.subagents`, `ConfigureInput.runtimeMode`, `RespondInput.reason`, `answers` and `launch`; `ProviderUsage.reading` (the bridge derives it from the probe's state: `read`, `unreadable` for a failed probe or a logged-out CLI, `unsupported` for a login with no plan windows); `ServerSettings.roleBindings` and `defaultBudget`; login shapes in `Models.ts`. `SubscribeThreadInput.conversationId` and `HistoryInput.conversationId` are gone: a subagent is a thread. `PROTOCOL_VERSION` is 2.

Documents are plain JSON (`null`, never Options); `JsonSchema.test.ts` refuses a transformation inside any of them and keeps `schema/cairn-documents.json` beside the RPC golden. S23 in `docs/coding-standards.md` now says so. `Shell.test.ts` decodes a phase 1 `threads.shell_json` row (no phase 2 keys, a pending request without `origin`) to the defaults and writes the keys back.

### Rules later packages follow

- **An edited launch is an answer, not a new proposal.** The launch card's budget and role overrides travel as `RespondInput.launch` with Go and are stored as the answer's `launch`; the frozen `WorkflowLaunch` payload stays as the model proposed it. The workflow runs on the answer's values when present, the payload's otherwise (5A writes them into `WorkflowRecord.budget`). Briefs keep "Edit and Go is not in phase 2".
- **A program is shown whole or not asked.** `ProgramPayload.code` is capped at the wire's string limit (`PROGRAM_CODE_LIMIT_BYTES` equals `WIRE_STRING_LIMIT_BYTES`, held by `Policy.test.ts`), so the card never shows a cut program; the gate (2B) refuses a longer one at ask time instead of asking.
- **Request ids the brain mints match the protocol's `RequestId`** (`[A-Za-z0-9_-]{1,128}`), so a submission's id decodes wherever a client reads it. Where the notes write `:` as the separator, use `-`: `wf-<workflowId>-<nodeId>`, `subagent-note-<child>-<seq>`, `subagent-wake-<child>-<seq>`.
- **Listing a kind in `VISIBLE_DOCUMENTS` does not put it on the wire.** `PiDurableHarness.watch` adds `cairn.approvals` through its own `watchDoc` (`apps/server/src/brain/PiDurableHarness.ts`, "watch-approvals") and nothing else. `cairn.permissions` (2B), `cairn.goal` (3A), `cairn.subagents` and `cairn.child` (4B), `cairn.escalations` (4D) and `cairn.workflows` (5F) each need a watch there. The first of them asks the integrator to turn the one approvals watch into one loop over every visible `cairn.*` kind; later packages then need no edit. Hand-off owner: the integrator, since every package would otherwise edit the same function.

### RPCs declared, stubbed `Unavailable`

`roles.check`, `spend.get`, `providers.login.start` (a stream), `providers.login.cancel`, `providers.logout`, `goal.setCriteria`, `workflow.stop`, `workflow.stopNode`, `workflow.list`, `workflow.eventStatus`, `reach.list`, `artifact.revoke`, `portal.close`, `portal.start`. Each package replaces its stubs through `rpc/Handlers.ts`.

Until the package that implements each lands, these are refused with `InvalidInput` naming the field (`notYet` in `rpc/ThreadCommandHandlers.ts`), so nothing is silently dropped: `thread.respond`'s decisions other than `accept` and `decline` (2B), its `reason` and `answers` (1A), its `launch` (5A); `thread.configure`'s `runtimeMode` (2B); `thread.stop`'s `subagents: "stop"` (4C; `keep` is the default and passes). `ThreadCommandHandlers.test.ts` has one red-to-be test per guard; the package that lifts a refusal turns its case around.

### Migration numbers

Reserved in `apps/server/src/db/Migrations.ts`: 0007 `OAuthCredentials` (1D), 0008 `ModelHealth` (1C), 0009 `Spend` (2C), 0010 `Artifacts` and 0011 `Portals` (2F), 0012 `ChildWorkspaces` (3B).

### Dependencies and boundaries

No new npm package: every package block and note uses what is installed (pi-durable, pi-ai, pi-coding-agent's `discoverAndLoadExtensions`, pi-codemode's sandbox, Effect). 1F reads a script's `meta` with the codemode sandbox or a hand parser, not a JavaScript parser package; if it needs one, it asks. `@cairn/client-logic` moved from the server's dev dependencies to its dependencies, because `EffectiveMode` (1E) is shared by server and client.

The S42 import boundaries gained phase 2's tool folders: pi-durable and pi-ai at runtime under `subagents/`, `approvals/`, `workflows/`, `verdicts/`, `reach/` and in `models/ResultTool.ts`; those plus pi-coding-agent under `pi-host/`. `judges/lint-boundaries.test.ts` probes each.

### Judges

- `pnpm check` green.
- `judges/thread-states.test.ts` reads the five new modules; it failed on 47 status values with no row and no label before `docs/golden/thread-states.md` gained them, and passes now (5 of 5).
- `JsonSchema.test.ts` regenerates both goldens without drift; its plain-JSON check fails on a planted `OptionFromNullOr` and caught `ResolvedRole`'s Options inside `cairn.subagents` before they were made plain.
- Review fixes: `ThreadCommandHandlers.test.ts` (3 cases, one per guarded command), `Policy.test.ts` (the program cap equals the wire limit and counts UTF-8 bytes), `Shell.test.ts` (a phase 1 row decodes with the defaults), and a `ClaudeUsage.test.ts` case for `reading` over a failed probe, a fresh brain, a read, a third-party login and a logged-out CLI. `SubagentStatus` lost `declined` and `expired` and their two golden rows.

## Step 1.0 integration

Integrated on 2026-10-28 on `main`.

### Packages

| Package      | Branch       | Commit    | Status                    |
| ------------ | ------------ | --------- | ------------------------- |
| 1.0 Contract | `phase2/1.0` | `13d0f5f` | done, merged as `37f9404` |

The branch merged with `--no-ff` and no conflicts: `main` had not moved since the branch started.

### Integration judges

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` from a clean install (every `node_modules` removed, `pnpm install --frozen-lockfile`), since the lockfile changed | pass | ok in 75 s: fmt, lint, typecheck, 1,330 tests. `pnpm why -r effect`: one `effect@4.0.5`. |
| `judges/thread-states.test.ts`, `judges/lint-boundaries.test.ts`, `JsonSchema.test.ts` (both goldens), `ThreadWire.test.ts` | pass | 4 files, 35 tests (21 root, 8 protocol, 6 server). Goldens regenerated with 0 drift. |
| Real-model judges | not applicable | none run; cost $0. |

### Hand-offs applied

- **`ThreadWire` against the new `VISIBLE_DOCUMENTS`.** The projection reads the protocol list, so the six new `cairn.*` kinds pass its filter with no code change. Its header comment now names them, and says that listing a kind does not watch it.
- **The stale package worktree.** `.claude/worktrees/wf_f64abd35-692-1` had `phase2/1.0` checked out with `15f213e`'s files staged over `13d0f5f`. It was reset to `phase2/1.0`, so nobody commits a reversal from it.

### Hand-offs held for later packages

These stay open and are recorded under "Rules later packages follow" above or in the package blocks: lifting the `notYet` refusals (1A, 2B, 4C, 5A) and turning their test cases around; replacing stubs through `rpc/Handlers.ts`; each package's migration line (0007 to 0012); and turning the one approvals watch in `PiDurableHarness.watch` into a loop over every visible `cairn.*` kind when the first of 2B, 3A, 4B, 4D or 5F lands (the integrator does it then).

### What differs from the plan

The package's own deviations are in its review record; the ones later packages read are above: `PROTOCOL_VERSION` 2 and the second golden `schema/cairn-documents.json`, one merged `Budget` in `Spend.ts`, the workflow launch as approval kind `brief` with a `WorkflowLaunch` payload and the decision `accept_sample`, request ids using `-` as the separator, and `RespondInput.reason` refused until 1A.

### Left for the user

- Nothing to do now: no brain is deployed in this step. When the next deploy happens, the web build and the brain must ship together, because the protocol moved from 1 to 2. A page still on protocol 1 is refused with 426 and reloads.

## Wave 1 integration

Integrated on 2026-10-28 on `main`.

### Packages

| Package | Branch | Commit | Status |
| --- | --- | --- | --- |
| 1A Decision record | `phase2/1A` | `2ebf9ea` | done, merged as `d7585ed` |
| 1B Durable events | `phase2/1B` | `a73c6ef` | done, merged as `e671f91` |
| 1C Prices, families and model health | `phase2/1C-seam`, then `phase2/1C` | `2a75839`, `141dba1` | done, merged as `c6cc174` and `8368a9e` (after the others, with its seam commit) |
| 1D OAuth store and the Codex login | `phase2/1D` | `ec2f77b` | done, merged as `88db786`; the user's login is still to come |
| 1E One thread-state function | `phase2/1E` | `0c4f39c` | done, merged as `2de14c9` |
| 1F Workflow script and plan | `phase2/1F-r2` | `0c44caa` | done, merged as `26ec31f` |
| 1G porch changes | none | none | dropped in 1.0 |
| 1H Tools-only pi host | `phase2/1H` | `2176229` | done, merged as `b0044be` |

Each branch merged with `--no-ff` in the order A, B, D, E, F, H, with no conflicts. Every builder had reset its branch to `e1232ec` (step 1.0 integrated) before working. 1F's review rounds live on `phase2/1F-r2`, which contains `phase2/1F` and `phase2/1F-fixes`; `phase2/1F` was fast-forwarded to it. The stale package worktrees of 1A, 1B and 1C (`wf_25b03501-c51-1`, `-2`, `-3`), whose indexes held reversals of later commits, were reset to their branch heads.

**1C merged last, with its seam change.** Its review had one blocking finding: on `phase2/1C` alone, OpenCode Go and Codex limits become `usage_limit`, so the web Limited banner named the Claude plan window on an OpenCode Go thread, and `ClaudeSignals.isUsageLimited` started a Claude probe for any plan's limit and could overwrite a Codex or Go thread's reset time with Claude's. The integrator approved the seam change, and `phase2/1C-seam` (1C's three commits plus `2a75839`) merged with `--no-ff` as `c6cc174`, with no conflicts: `RunFailureInfo.plan` (`claude`, `codex` or `opencode-go`) in `HarnessSeam.ts`, `ClaudeSignals` patching a thread only for a `claude` limit, and the Limited banner and `docs/golden/thread-states.md` naming the model plan's usage limit instead of the Claude window. The new required `RunFailureInput.at` reached both callers (`CommitFeed.ts`, and `ScriptedHarness.ts` as 1A left it) without a textual conflict, and the merge typechecked as it stood. `phase2/1C-seam` had branched from 1C's second review round (`a811284`), so 1C's third round (`141dba1`, `ModelHealth.ts` and its test only) was not in it; `phase2/1C` merged after it as `8368a9e`, with no conflicts, so 1C lands whole.

What 1C brings: `models/ModelPrice.ts` (a model's list price from pi-ai's catalog, tiers by whole input as `calculateCost` does, a bridge model priced as its anthropic twin and labelled at API list price, plan providers `list_on_plan` and keyed ones metered, an all-zero or missing price unpriced and never $0), `models/ModelFamily.ts` (after Fold's table), `models/ModelHealth.ts` (after Ultimate's store: failing on an auth failure or three transient failures inside five minutes, limited under a plan's limit until the reset it names or, naming none, for an hour; a transient streak lapsing fifteen minutes after its newest failure (`TRANSIENT_HOLD_MS`); pi-ai's credential sentences as auth failures and a spent quota, budget or billing as a limit naming no reset; request-specific failures never count; errors kept to a fixed vocabulary; `reset` for a login change), migration 0008 `model_health`, and `classifyRunFailure` taking Codex's and OpenCode Go's limits as `usage_limit`, with Codex's reset from the minutes it names.

### Integration judges

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | ok in 82 s: fmt, lint, typecheck, 1,481 tests. No dependency changed (only two fixture `package.json` files under `pi-host/fixtures/`), so `pnpm install --frozen-lockfile` over the existing `node_modules`. |
| `judges/events-kill.sh` (1B, on main) | pass | kills case: 12 kills, 300 events, 118 faults injected, every (event, reactor) handled once (count 250, meter 150, spawn 200), 200 tasks, 11 s. Rotation: 10 kills, 111 faults, log ended in `2999-11`, 9.3 s. Control failed rightly by duplicates only (count 45, meter 38, spawn 44 handled more than once, up to 5 times; 0 missing). The kills case counted 201 outside effects for 200 tasks: a task's outside effect is at least once across a kill, which the judge allows. $0. |
| `node judges/codex-login.ts` (1D) | pass | 5 of 5: sign-in (1 exchange), kill-poll (0 exchanges, next brain holds the lock), rotation (3 refreshes, 0 reuses), second brain (no lock, 0 refreshes while held; after `kill -9` 0 reuses), control caught (2 reuses). 7.6 s, $0. |
| `judges/pi-readonly.sh`, now with the real `PiHost.layer` | pass | 62,151 agent-dir entries identical before and after; the host loaded pi-web-access 0.45.0 (4 tools) and @ff-labs/pi-fff 0.11.0 (2 tools); 1 child (the OAuth lock's `flock`); opencode-go=ready, anthropic=refused, openai-codex=missing; one real turn on opencode-go/minimax-m3 in 1,972 ms, well under a cent on the OpenCode Go plan. |
| `node judges/durability.ts --no-page` (faux windows, the judge brain with the new boot repair, reactors and close hook) | pass | 10 of 10. Kill to up 1,234 to 1,393 ms, up to converged 5 to 12 ms; approval-parked accepted once after the restart; kill-six 1,180 to 1,235 ms; sigterm-six 3,064 to 3,084 ms (phase 1's last runs: 3,059 to 3,067). 1 min 51 s. |
| `judges/shutdown.sh` | pass | closing 7 and closed 7, worst closed 2,014 ms, 0 `shutdown_slow`; systemd stops worst 2,034 ms; kill-six restarts 1,234 to 1,389 ms; control: the stubborn stop took 3,179 ms and systemd killed it. |
| `judge-main.ts` boot on a throwaway port | pass | boot repairs in order: sweep attachment uploads, executor-sweep, cancel abandoned approvals, retry-parked-approval-waits, resume interrupted launches, checkpoint repair, start event reactors; then `event_reactors_started` and `ready`; SIGTERM gave `closing` and `closed`. |
| `node judges/dev-smoke.ts` (scripted brain with `EventReactors.layerOff` and the empty pi host) | pass | Live after 2,737 ms; the demo thread grew from 2 to 8 entries; 0 page errors. |
| Real-model judges | pass | only pi-readonly's one OpenCode Go turn (minimax-m3); under a cent. |
| `pnpm check` after 1C and its hand-offs | pass | ok in 78 s: fmt, lint, typecheck, 1,530 tests. No dependency changed. |
| `judges/pi-readonly.sh --no-turn` and a `judge-main.ts` boot, after 1C | pass | pi-readonly: the brain built with the health feed, agent dir identical (62,151 entries), 1 child (`flock`), opencode-go=ready, anthropic=refused, openai-codex=missing. judge-main on a throwaway port: migration 0008 created `model_health`, boot repairs in order, `ready`, then `closing` and `closed` on SIGTERM. $0. |
| 1C's unit judges, on `main` after its merge | pass | `ModelPrice.test.ts` 11 (tiers, the bridge's labelled equivalent priced from the runtime's own anthropic catalog, all-zero and missing unpriced, "<$0.0001"), `ModelFamily.test.ts` 4 over the family table (14 broken rule controls, every one failing its judge), J-health `ModelHealth.test.ts` 20 (on a migrated in-memory `cairn.sqlite`, surviving a restart; each round-3 rule has a case whose broken control fails it), `RunFailure.test.ts` 13 (pi-ai's retry rule held against the limit texts each provider writes), `ClaudeSignals.test.ts` 5 (a spent Claude window leaves a Codex and an OpenCode Go limit their own reset), `ShellProjector.test.ts` 14, `judges/thread-states.test.ts` 5. $0. |
| The health feed (`ModelHealthExtension.test.ts`, integrator) | pass | 4 of 4 on a real Harness over pi-ai's faux provider with two retries: a transient failure a retry mended records only the success (2 attempts, 1 outcome); a request whose retries ran out records one failure (3 attempts, 1 outcome); a revoked key and a transient failure with retries off each record one failure after 1 attempt. Control: with the retry check removed, 2 of 4 fail (2 and 3 outcomes recorded). `LoginHandlers.test.ts` gains 2 (a stored sign-in and a logout reset Codex's health; a refused logout does not): 5 of 5. |

### Hand-offs applied

- **`BootRepairs.ts`**: `cancel abandoned approvals` (1A) after the Executor sweep and before `retryParkedApprovalWaits`; `startEventReactors` (1B) last, as the raw `BootRepair` 1B wrote (a defect from start is not caught as `boot_repair_failed`). The header names both.
- **`ShutdownHooks.ts`**: `stopEventReactors` after `bridgeClosingHook`; the list is `ShutdownHook<EventReactors>`.
- **`AppLayer.ts`**: `PiDurableBrain` builds `ReactorSet.layer` beside its resume; `ScriptedBrain` provides `EventReactors.layerOff`. Three judges that build their own scripted harness for `AppLayer` (`judges/typing.ts`, `judges/paste-client.ts`, `judges/fixtures/parity/CairnApp.ts`) also take `EventReactors.layerOff`.
- **`rpc/Handlers.ts`**: `EventHandlers` (replaces the `workflow.eventStatus` stub) and `LoginHandlers` over `CodexLogin.layer` (replaces `providers.login.start`, `providers.login.cancel` and `providers.logout`).
- **`db/Migrations.ts`**: `0007_OAuthCredentials`. 1D's tests still spread it over `migrations` themselves; that is now redundant and harmless.
- **`main.ts`**: one `OAuth` constant (`OAuthStore.layer` over `DatabaseLive`) given to the models and to `MainLayer`, so one store and one flock; and `PiHost.layer`. `judge-main.ts` and `dev-main.ts` take `PiHost.layerEmpty` and no OAuth store, so judge and dev brains never take the real lock or load the user's pi packages.
- **`Extensions.ts`**: `ExtensionOrder.piTools: 800`; `PiHost.ts` uses it and `PI_TOOLS_ORDER` is gone. **`ExtensionSet.ts`**: the host's extension is in `production`, with `PiHost` left in the layer's requirements for each root to choose. Every test and judge that builds `ExtensionSet` or `PiDurableBrain` now provides `PiHost.layerEmpty`; `PiHostTestKit.brainLayer` uses the production set, whose `cairn.pi-tools` comes from the host under test (it had added the extension a second time through `withExtra`). `CodingTools.test.ts` expects `cairn.pi-tools` last: its key, 800, sorts after the provider request log's 750, not right after `cairn.bridge-cwd` as the hand-off said.
- **`GLOSSARY.md`**: event conversation, durable event, reactor (1B); pi host (1H); recipe, prelude, dry run, call site (1F); model family and provider health, and Hold naming every plan's limit (1C).
- **1C, `db/Migrations.ts`**: `0008_ModelHealth`. `ModelHealth.test.ts` still spreads it over `migrations` itself; redundant and harmless, as 1D's.
- **1C, `AppLayer.ts`**: `ModelHealthLive`, `ModelHealth.layerNoDeps` over `DatabaseLive`, provided beside the shell store. It is one exported reference: `AppLayer` uses it for the login RPCs, and `main.ts`, `judge-main.ts` and `dev-main.ts` give the same reference to `PiDurableBrain`, which leaves `ModelHealth` in its requirements (as it leaves `ExecutorLink` and `PiHost`), so the memo map builds one store whose memory both sides see. Tests and judges that build `ExtensionSet` or `PiDurableBrain` themselves take `ModelHealth.layerTest`, a new layer over a fresh migrated in-memory `cairn.sqlite` (`Boot.test.ts`'s scale brain takes `layerNoDeps` over its own database).
- **1C, the health feed**: `brain/ModelHealthExtension.ts` (`cairn.model-health`, `ExtensionOrder.modelHealth: 850`, in `ExtensionSet`'s `production`, with `ModelHealthFeed.layer` over `ModelHealth` and `ModelSource`). Its `afterResponse` hook takes `outcomeOfResponse(message)` and records one outcome per request, its last attempt: pi-durable 1.4.0 fires `afterResponse` for every attempt before `classify` decides to retry (`harness/generation.js`), so the hook skips an error pi-durable is about to retry, by pi-durable's own rule (not a context overflow, `isRetryableAssistantError`, retries enabled, `pi.live`'s `generation.attempt` at most `maxRetries`, the policy read from `ModelSource.settings()` over `DEFAULT_RETRY_POLICY`). It runs `ModelHealth.record` through one runtime from the layer's scope (S43) and logs a failed write as `model_health_record_failed`, never throwing into the run. Adding the extension appends `pi.system` entries to each conversation once (footgun "moving default selections"). `CodingTools.test.ts` now expects `cairn.model-health` last.
- **1C, `rpc/LoginHandlers.ts`**: `providers.login.start` resets the provider's `ModelHealth` when its `SignedIn` step passes (the credential is stored by then), and `providers.logout` after the delete succeeds. A reset that cannot be written is logged as `model_health_reset_failed`, not answered, since the credential change did happen.
- **ADR 0029** is accepted. ADR 0033 needs no change. ADR 0037 and 0039 stay proposed (below).

### Rules later packages follow

- **`apps/server/src/brain/ReactorSet.ts` is integrator-only**, like `ExtensionSet.ts`. A package that adds a reactor hands off its source for the `production` list and registers the task definitions its handler creates through its own extension's `tasks`. A reactor with outside effects (pushes, child starts) takes `from: "now"`.
- **Emitting and reacting.** Call `emit` after the commit's table reads: pi-durable throws `ReadAfterWrite` on a table read after a table write. Pass `at` from the Harness clock (`runtime.now()` in a task). Reactor names are stable: renaming one starts it over at the current log. A handler never awaits anything outside `tx`.
- **Approvals (for 2B, 3C, 4A).** `ApprovalRequest` still takes `autoAccept: boolean`, recorded as `decidedBy` mode `full-access`, and has no `payload`. The first package that asks with a payload or a real mode replaces it with `payload: Option<JsonRecord>` and an accepting `Option<RuntimeMode>`, written once in `ask`; callers are `ConformanceTools.ts`, `GatedCall.ts`, `ExecutorExtension.ts`, `ExecutorTools.test.ts`, `ExecutorTestKit.ts` and `judges/fixtures/JudgeTools.ts`. When Executor gating goes live (2B), `GatedCall.ts` switches to `ledger.awaitSettlement` and puts `settlementText(settlement)` in its refusal. `HarnessSeam.respond` takes an `ApprovalAnswerInput` (`decision`, `reason`, `answers`); `launch` is 5A's.
- **Workflows (for W3, 4D, 5A, 5D).** The gate calls `parseWorkflowScript` then `rewriteScript`, and decides by the approved row's hash, never by `isRewrittenWorkflow`; the slot pool is chosen with `isRewrittenWorkflow` on stored text (`isWorkflowSource` is for scripts as the model submits them). The node tools accept and answer the schemas in `Prelude.ts`; `agent` defaults to `DEFAULT_NODE_ROLE` and `verify` to `DEFAULT_VERIFY_ROLE`, and neither answers usage. A workflow script that calls a non-node tool is refused in the plan, so the run-time gate refuses one too. `PRELUDE_VERSION` is 2 and pinned by a hash test. `DryRun.sitesComplete` false should make the card say the call-site table may be incomplete (a `WorkflowLaunch` field, if wanted, is an integrator change to `Policy.ts`). `estimateRun` gets only history from each role's current binding. With `maxNodes` none, `toLaunch` caps the envelope at the dry run's happy-path count, so a fallback path the stubs never take raises its own brief: 5A and 5D decide whether to add headroom. A `.js` recipe under `src/` needs ignore patterns in `oxlint.config.ts` and `oxfmt.config.ts` (seams); the fixtures use `.workflow`. The model's workflow docs (W3) say that a node without a `schema` answers placeholder text in the dry run, and that `agent()` and `verify()` resolve null when a node is refused, stopped or failed. `WorkflowPlan.layer` joins `AppLayer.ts` when 4D or 5A first uses it.
- **Pricing (for 2C).** Price each assistant response's own usage, never `pi.usage`'s per-model sums: a tier is chosen by one request's whole input, so a long-context tier applied to a sum overprices a bridge thread about fivefold. `listMicrosOf` says so in its doc.
- **Health (for 2D).** Role resolution reads `ModelHealth.stateOf` and passes over `limited` and `failing`. Only the per-response feed records today; a run's `RunFailureInfo` is not fed in, so a failure that never reached a provider response (no model, a compaction failure) does not count. The login reset fires as the `SignedIn` step is pulled, so a client that leaves before that step arrives skips it; the next success or the hour's lapse heals the record.

### What differs from the plan

- **1C merged after the others**, once its seam change was approved (above). Nothing reads prices, families or health yet; 2C and 2D are the first.
- **`pi-readonly.sh` loads the real pi host.** The judge says it builds the brain as deployed, and the deployed brain now loads the user's pi packages, so it does too. 3G still owns its ADR 0039 additions.
- **Not taken:** 1B's optional cache of known non-thread conversations in `CommitFeed.learn` (one extra metadata read per commit that emits an event; no package emits yet), and 1H's suggested process-level `unhandledRejection` logger. Both are small and can come with the first package that needs them.
- Each package's own deviations are in its review record. The ones later packages read: 1A moved `HarnessSeam.respond` to `ApprovalAnswerInput` and regenerated every conformance golden with a `decisions` key; 1B made `from` a required field of every reactor and chains monthly logs by a marker entry rather than a document field; 1D's sign-in calls pi-ai's Codex `oauth.login` directly and stores through `OAuthStore.signIn`, with no settings card yet (ADR 0040's look track); 1E made an idle row with queued input read "Working"; 1F puts the prelude where `export` was so script lines keep their numbers; 1H drops `sendMessage` and friends with a `pi_host_dropped` log once their call has returned, instead of throwing.

### Left for the user

- **The Codex login**, after the next deploy of the phase 2 brain: `ops/wizards/phase-2.sh 1`. ADR 0037 stays proposed until it passes; the recorded fallback is opencode-go/gpt-6-luna. Nothing is deployed by this integration; when it is, the web build and the brain ship together (protocol 2).
- ADR 0039 stays proposed until 3G's `judges/pi-host.ts` and its `pi-readonly.sh` additions pass.
