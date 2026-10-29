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

## Wave 2 integration

Integrated on 2026-10-28 on `main`.

### Packages

| Package | Branch | Commit | Status |
| --- | --- | --- | --- |
| 2A Seam and scripted semantics | `phase2/2A` | `1a12e83` | done, merged as `626825d` |
| 2B Permission modes | `phase2/2B` | `db0bd0f` | done, merged as `de02a7e` (conflicts with 2A resolved, below) |
| 2C Spend ledger | `phase2/2C`, then `phase2/2C-seam` | `914d46b`, `679f820` | done, merged as `d98cc16` and `0dbbe63` (the seam branch is 2C's hand-offs, one commit) |
| 2D Role aliases | `phase2/2D` | `bbe2bf4` | done, merged as `bd087a9` |
| 2E Result tool | `phase2/2E` | `6f992bd` | done, merged as `7ebc3f0`; J-typed's 8 of 8 is the user's call (below) |
| 2F porch client and machine setup | `phase2/2F` | `e9ecf32` | done, merged as `2799c12`; the user's wizard stage is still to come |

Each branch merged with `--no-ff` in the order A, B, C, C-seam, D, E, F. Every builder had reset its branch to `781dc38` (wave 1 integrated) before working. Only 2B conflicted, with 2A, in three files; the rest merged clean. The hand-offs are one commit, `06abbfc`, and this note is the next.

**2A and 2B both built permission modes in the scripted harness.** 2A gave `ScriptedThread` a `mode`, a scripted-only `ScriptedModes.set` that refuses a child's widening, a conformance `mode` step through a target `setMode` capability, and an `act` tool asking below full access (`ScriptedToolApi.ask(summary, autoAccept)` and `mode`). 2B gave it `permissions` (`cairn.permissions`: mode and allow list), `configure`'s `runtimeMode` refused while running, `accept_for_thread`, the `configure` step and the gated writers `touch` and `run` (`ask(summary)` and `permissions()`). The merge keeps one state and one path, which is 2A's hand-off to 2B done by the integrator:

- `ScriptedThread.permissions` holds the mode (2A's `mode` field is gone); `freshThread` takes the mode, a child's from its brief. `effectiveMode` narrows `permissions.mode` by every ancestor's.
- `ScriptedHarness.configure` refuses a child's widening first, then a change while running; `ScriptedModes`, `ConformanceTarget.setMode` and `SetMode` are gone, and the conformance `mode {mode}` step calls `seam.configure` on its thread, so it runs on pi-durable as well once the subagent scenario does.
- `ScriptedToolApi` has `ask(summary, autoAccept)`, `mode` and `permissions()`; `permissions()` gives the effective mode with the thread's own allow list. `accept_for_thread` adds the tool to the answered thread's allow list in `respond`.
- On pi-durable, `act` reads the thread's own `cairn.permissions` and is accepted by `full-access` only in that mode; before, it was always accepted. 1A's `autoAccept` had become 2B's `payload` and `acceptedBy` in `ApprovalRequest`, so `act` and `gate` pass those.
- `Transcript.ts` keeps both `runtimeMode` (ensure and configure) and `mode` (the mode step), and `decision` takes every `ApprovalDecision`.

### Integration judges

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | ok in 158 s: fmt, lint, typecheck, 1,692 tests. No dependency changed, so `pnpm install --frozen-lockfile` over the existing `node_modules`. |
| Conformance (`Conformance.test.ts`, inside `pnpm check`, also alone after the 2A and 2B merge and after the watch loop) | pass | 79 passed, 2 skipped (the scripted pending check, with nothing pending; pi-durable's subagent mutation check, with no passing subagent scenario). Goldens unchanged by the merge, the mode fold and `cairn.permissions` in the scripted view. |
| `judge-main.ts` boot on a throwaway port, with `CAIRN_DATA_DIR` a folder that did not exist | pass | The data folder was made; migrations 0009 to 0011 created `spend_totals`, `spend_events`, `artifacts` and `portals`; boot repairs in order, `spend reconcile` after the checkpoint repair and before `start event reactors`; `ready`; `closing` and `closed` on SIGTERM. |
| `node judges/durability.ts --no-page` (judge brain with the roles and results extensions installed) | pass | 13 of 13, including 2B's three gated windows (`bash` started once in each, "may have run" as expected). Kill to up 1,181 to 1,433 ms; up to converged 5 to 19 ms; sigterm-six 3,065 to 3,139 ms. |
| `judges/spend-kill.sh` (2C, J-spend under `kill -9`) | pass on the second run | Run 2: kills case 12 kills, 48 turns, 88 responses, 0 failures in 21 s, ledger 1,079,008 micros against 1,311,730 had each thread's sum been priced as one request; control failed rightly (double counts only). Run 1 failed the kills case with no `done` in 180 s: all four threads' generation tasks had `restarts: 5`, so pi-durable parked them (five kills landed while each sat at its request) and the judge brain never retries a parked task. A judge flake, not a ledger fault; the control failed rightly in both runs. Handed to 4E (below). |
| `judges/pi-readonly.sh --no-turn` (the brain as deployed, now with `cairn.roles` and `cairn.results`) | pass, after a fix | It first failed to boot: its embedded brain lacked `SettingsStore`, which the roles tool now needs. With `SettingsStore.layerTest` given beside `ModelHealth.layerTest`: agent dir identical (62,151 entries), 1 child (`flock`), opencode-go=ready, anthropic=refused, openai-codex=missing, boot 871 ms. No turn, $0. |
| `node judges/porch-contract.ts --porch /tmp/reach-probe/porch-bin` (2F, after migrations 0010 and 0011 were registered) | pass | 14 of 14 scenarios on the real binary, served 200, hand-written file intact, control failed. `~/.local/state/porchlight/published.json` mtime unchanged (17:39:03). |
| `node judges/dev-smoke.ts` (scripted brain) | pass | Live after 2,621 ms; the demo thread grew from 2 to 8 entries; 0 page errors. |
| `Database.test.ts` (the missing data folder, integrator) | pass | New case: a database under `fresh/data/` that does not exist opens and migrates. Control: with the old `Database.ts` it fails. |
| `RoleHandlers.test.ts` and `packages/protocol/src/Roles.test.ts` (integrator) | pass | `roles.check` with `overrides` resolves `@judge`, which the table cannot here; a literal spec `cloudflare-workers-ai/@cf/...` decodes, a spec without a provider or with an upper-case alias does not. |
| Real-model judges | not run | None at integration. The package runs: 2E's J-typed about $0.075 at list price over five runs plus bridge plan usage; the others $0. |

### Hand-offs applied

- **`db/Migrations.ts`**: `0009_Spend` (2C, through its seam branch), `0010_Artifacts` and `0011_Portals` (2F). `PorchClient.test.ts`, `ReachTables.test.ts` and `judges/porch-contract.ts` no longer spread 0010 and 0011 themselves; 2C's tests and `SpendBrain.ts` still add 0009, which is redundant and harmless.
- **2C's seam branch** (`AppLayer.ts`, `BootRepairs.ts`, `rpc/Handlers.ts`, `Boot.test.ts`, three judges), as 2C listed: `SpendFeed.layer` in `PiDurableBrain`, `SpendFeed.layerOff` in `ScriptedBrain` and the judges that build their own, `SpendLedger.layerNoDeps` below `ThreadsLive`, the `spend reconcile` boot repair before the event reactors, `SpendHandlers`.
- **`Extensions.ts`**: `ExtensionOrder.roles: 860` and `results: 950` (the plan's `ExtensionOrder.ts` seam is the `ExtensionOrder` constant in this file). **`ExtensionSet.ts`**: `RolesTool` (over `RoleAliases.layerNoDeps`) and `ResultTool` in `production`. `ResultTool.layerAt(order)` became `ResultTool.layer` over `ExtensionOrder.results` (S38); its two callers changed. Installing both appends `pi.system` entries to every conversation once (footgun "moving default selections"); `CodingTools.test.ts` expects `cairn.roles` and `cairn.results` last.
- **Settings for the brain**: `AppLayer.ts` exports `SettingsLive` (`SettingsStore.layerNoDeps` over `DatabaseLive`), used by `AppLayer` and given by `main.ts`, `judge-main.ts` and `dev-main.ts` to `PiDurableBrain`, as `ModelHealthLive` is. `SettingsStore.layerTest` (over a fresh migrated in-memory database) serves tests and judges that build the extension set; those whose models had no catalog also take `PiModelSource.layerFromModelSource` (the roles tool reads it). `BridgeProvider.layer` already reaches both the app and the brain from `main.ts`'s root, so the plan-window check is on in production; `judge-main.ts` gives `layerOff` unless `--models real`.
- **`rpc/Handlers.ts`**: `RoleHandlers` over `RoleAliases.layerNoDeps` (replaces the `roles.check` stub).
- **Protocol** (integrator seam): `RolesCheckInput.overrides` (optional `RoleOverrides`), passed through by `RoleHandlers.ts`; `@` allowed in `RoleSpec`'s literal model id; `ResultDocument.attempts`'s comment counts a nudge before any call. Both JSON Schema goldens regenerated (the pattern and the new field only). `PROTOCOL_VERSION` stays 2: the field is optional and the pattern only widens.
- **The thread stream's documents** (the waves rule from step 1.0, due with 2B): `PiDurableHarness.watch` now watches each token in `STREAM_DOCUMENTS` (`Approvals`, `Permissions`) and adds every one that exists to the view, instead of one approvals watch. `cairn.subagents`, `cairn.child` and `cairn.escalations` have no pi-durable token yet; 3A, 4B and 4D add theirs to that list, and that line is their only edit there. `ScriptedHarness.viewOf` carries `cairn.permissions` for parity (always present, as pi-durable writes it at ensure).
- **`Database.ts`** (2B's report of a bug on `main`): opening a file database makes its folder first, so a first boot on a fresh `CAIRN_DATA_DIR` no longer fails with "unable to open database file".
- **`judges/pi-readonly.sh`**: its embedded brain takes `SettingsStore.layerTest`.
- **ADR 0031 is accepted**, with 2B's gate evidence appended.
- **`GLOSSARY.md`**: note, wake, reporter, mirror (2A); permission mode amended and effect mark (2B); spend ledger (2C); role table and binding (2D); result tool, typed result, nudge, divergence (2E); the artifact entry's overwrite rule (2F).

### Rules later packages follow

- **Visible documents.** A package that defines a `cairn.*` document listed in `VISIBLE_DOCUMENTS` adds its token to `STREAM_DOCUMENTS` in `PiDurableHarness.ts`, and the scripted harness's `viewOf` shows it under the same condition pi-durable keeps it.
- **Notes (2A, for 3A and 4C).** `PiDurableHarness.write` admits a note (a `PassiveNote`, a write with `model`) in its own host commit instead of `Conversation.submit`: idle with no queued reset, an append plus a `done` write submission; otherwise a queued write submission plus an `InboxDoc` write item. It reads pi-durable's exported `LiveDoc` and `InboxDoc` and copies `hasQueuedReset`'s check (`item.mode === "write" && entry.head === "self"`). Recheck it on any pi-durable upgrade past 1.4.0. A stopped or failed run's queued notes are placed by the stop, by a reactor on every non-completed `RunTerminal`, and by an idle write, in one host commit each, with queued inputs left queued.
- **Seam additions (2A).** `PassiveNote extends PassiveEntry { model }` (not an Option field on `PassiveEntry`, which would have touched `AppLayer.ts`), `ThreadEnsured.parent`, `SubagentUpdated`, and `StopOptions.subagents` (`keep` or `stop`, required). `Threads.stop` passes `input.subagents` (default `keep`); `subagents: "stop"` is still refused by `notYet`, and `PiDurableHarness.stop` ignores the field until children exist there. `ShellProjector` ignores `SubagentUpdated`; it may repeat an unchanged status after a restart, so whoever reads it (4C's tally) treats it as idempotent.
- **3A (subagents extension).** In `conformance/Targets.ts`, `piDurableTarget` maps a faux request to its thread through the provider session id joined to `cairn.thread-meta` (2A's review round); 3A provides `SubagentFaults` to the extension and removes each subagent scenario from `PENDING["pi-durable"]` as it passes, then reruns with `CAIRN_UPDATE_GOLDENS=1` (a subagent golden switches from the scripted record to pi-durable's on its own; the subagent mutation check then runs on pi-durable too). Tool texts come from `SubagentText.SubagentToolText` word for word. The extension does not place queued notes itself. It narrows a child's mode inside `readPermissions` (`Permissions.ts`) by walking `cairn.child.parentConversationId`, and `act` then follows the effective mode. `cairn.child` is version 1, scope conversation, history latest, fork initial, which `ResultTool.ts`'s private `ChildSchemaDoc` mirrors; 3A exports its token and `ResultTool.ts` switches to it. The spawn merges `offerResultTool.modelTools.add` into the `AgentChange` it writes (`modelTools` replaces the whole filter). The reporter, when a child's run ends with no result, reads `readAttemptState(tx, child)`: if `nudgeDue`, it sends `NUDGE_TEXT` verbatim once as a plain input (request id `subagent-nudge-<child>-<seq>`), otherwise it settles failed with `CAP_TEXT` or "not reported"; it reads the value with `readResult`. Use `submit_result` for typed payloads, not the subagents note's `report` tool. Still to model: a faux handle exposing the requests it saw (a child's first input and tool list) and `subagent_status`'s bounded `wait_seconds` with its early return.
- **Dispatch (2D, for 3A, 4A, 4D, 5A, 6B).** Call `RoleAliases.resolve(spec, overrides)` right before the commit that creates the child, then write `configure(tx, child, { model, thinkingLevel })` and the `DispatchRecord` in that same commit. A `RoleError`'s message lists the roles that resolve now, ready to return as a tool error. The brief card reads `roles.check`; a launch card passes its overrides in `RolesCheckInput.overrides`. The conformance scenario checking a real child's `pi.agent.model` against its dispatch record is 3A's and 4A's.
- **Briefs (2A, for 4A).** Brief answers reach the parent differently from briefs note B4: Go as a note (kind `cairn.brief-answer`, request id `<briefId>-answer`, `SubagentRequestIds.briefAnswer`); Decline and Send back as a follow-up input, or as a note when the parent is halted. B4 says every answer is a follow-up with id `brief:<id>:answer`. The goldens fix 2A's choice; 4A either keeps it and amends B4, or changes both harnesses and regenerates the goldens. 4A also adds the expired-brief scenario (S2 group 2's third case: no conversation, no `ThreadEnsured`), which `subagent_brief_declined` does not cover, and calls `checkResultSchema(brief.resultSchema)` when a brief is asked, refusing with `failure.message`.
- **Kill coverage (for 3E, 3F, 4C, 4E).** `subagent_result_once_with_crash` crashes only while the child's answer and the parent's woken run are held; the windows between the child's answer, the settlement and the report belong to `judges/subagent-durability.ts` (4C). `ArtifactPublisher.publish` needs a fault hook at its two crash windows (after the claim INSERT and before porch; after porch and before the row UPDATE) for 3E's and 3F's kill judges. `judges/spend-kill.sh` should retry parked tasks (`thread.retryTask` or the Harness's retry) at the last life's boot, so a run whose kills park a generation still finishes; 4E (budgets) owns spend next.
- **Reach (2F, for 3E and 3F).** Publish only through `ArtifactPublisher.publish({ threadId, source, project })`, never `PorchClient.publish`: porch overwrites files it did not publish. A fresh claim is given back only on a porch refusal code or `bad-input`; a claim with hash NULL keeps the key for its thread until that thread publishes again; `reach.list` filters `hash IS NULL`; a revoked row still belongs to its thread, so another thread is refused `taken`. There is no `porch lease` or unpublish: 3F picks a port (the `portals_live_port` index guards it) and registers it with `PorchClient.add(name, "http://127.0.0.1:<port>")`; revoke removes the file and sets `revoked_at`. Porch's own portal handles set no `stream_close_delay`, so opening or closing a portal cuts other portals' HMR sockets on reload. `ArtifactPublisher.layer` joins `AppLayer.ts` when 3E first uses it; judge and dev brains take `PorchClient.layerFake` or a `PorchSettings` with a temp `HOME` and XDG folders. Future dry runs of the wizard set `XDG_STATE_HOME` as well as `HOME` and `XDG_CONFIG_HOME`.
- **4F** extends `judges/typed-results.ts` with a Codex provider (`--provider codex`) rather than starting a new judge.
- **Ownership notes.** `apps/server/src/brain/ResultToolHarness.test.ts` sits in `brain/` because S42's pi-durable zone for `models/` is `models/ResultTool.ts` alone; the zone was not widened. `judges/owner-guard.ts` (2F) is the guard judge 5G can fold into `judges/reach.ts --live`.

### What differs from the plan

- **The modes fold** (above): the integrator, not 2B, folded 2A's scripted modes into `configure`, because the two packages ran in parallel.
- **2A** follows the newer briefs design (ADR 0030): `subagent_spawn` records a brief and returns at once, and Go starts the child. Groups 4, 7 and 12 are split, so 18 scenario files cover the twelve groups; until 3A, the subagent goldens are the scripted harness's record, grouped per thread with a `children` key. Not built in the scripted harness, since no scenario needs them: a final answer ending in a question becoming a question, the reporter's nudge, `subagent_status`'s bounded wait. The live-children cap counts pending briefs ("subagents working or waiting for Go"). 2A edited `Threads.ts`, `ShellProjector.ts` (and its test), `PiDurableHarness.test.ts` and `judges/fixtures/transcripts/record.ts` because the compiler forced it.
- **2B** lifts only `accept_for_thread` in `thread.respond`; `revise` and `accept_sample` wait for briefs (4A) and launch approvals (5A). A child's mode is not narrowed by its parent's on pi-durable until 3A; refusing a widening in `thread.configure` on pi-durable is 4C's. The classic composer cannot change a live thread's mode (new screens go only to `next`, ADR 0040); the picker marks Supervised and Auto-accept edits enforced.
- **2C** keys `spend_totals` by `(conversation_id, model_key)` with a `thread_id` column; tokens come from `pi.usage` and dollars from each response priced alone (bridge responses recording zero cost), with compaction tokens counted unpriced; `tool:<name>` rows priced only when they recorded a cost. Calls outside a conversation are recorded in `TitleModel`. `SpendSummary.budget` is `none` until budgets (M6). The pi-durable reading lives in `brain/SpendFeed.ts` (S42).
- **2D**: the `roles` slash command is client work (6G or the look track). A seven-day window scoped to one model limits only bridge models whose id names it, and `monthly_spend` never limits a model.
- **2E**: the two-attempt cap is enforced in `execute`, not a `beforeTool` hook (pi-durable validates arguments before `beforeTool`); a `beforeRequest` hook writes each child's envelope schema into its request; the nudge is a decision function and text for 3A's reporter, not sent by the extension. A result sent at the top level is moved under `result` when that is unambiguous.
- **2F**: with 1G dropped, the overwrite refusal is Cairn's own (`reach/ArtifactPublisher.ts`), and owner-only is a site-level `forward_auth` with a CEL host matcher in the wizard's Caddyfile edit; the hand-written `@plans` handle becomes `@owner_plans` and keeps `Cache-Control: no-cache`. `PorchErrorReason` gains `busy` and `no-port`, not `bad-config`. The porch binary judged is the reach probes' build at `/tmp/reach-probe/porch-bin` (porch 0.0.0); nothing named porch is on `PATH`.
- **J-typed (2E) is not stable at 8 of 8 per model.** Its final full run passed (OpenCode Go 8 of 8 on claude-haiku-5-5, deepseek-v4.1-flash, qwen3.8-flash and gpt-6-luna; the bridge 8 of 8; v1 control 0 of 8; union control refused), but two of three full runs failed by one trial, each a wrong fact that still fit the schema (qwen wrote `path/to/README.md`), never a tool fault. Merged; the target is the user's call (below).

### Left for the user

- **J-typed's target, decided by the integrator on 2026-10-28**: the plan's target is typed results, "100 percent valid within two attempts" (4F). J-typed gates on schema validity and the attempt count; a wrong fact inside a valid result is reported as its own number (facts right per model) and does not fail the judge. 4F judges this way across the three providers.
- **The reach stage of the wizard**, after the next deploy of the phase 2 brain: `ops/wizards/phase-2.sh 2` (Caddyfile backup, porch binary and `init`, the compose mount, the `import` line, `stream_close_delay`, the owner guard, validate, reload, a probe publish), then `porch doctor` clean. `~/.local/state/porchlight` held only the registry of three probe publishes from 2F's builder's dry run (it set `HOME` and `XDG_CONFIG_HOME` but not `XDG_STATE_HOME`); the integrator moved it to `/tmp/porchlight-state-from-2F-dryrun`, so the wizard's `porch init` starts from a machine where porch never ran. Judges that run porch set `XDG_STATE_HOME` too.
- **The Codex login** from wave 1 (`ops/wizards/phase-2.sh 1`) is still to come after a deploy.
- **When deploying** (nothing is deployed by this integration): ship the web build and the brain together; migrations 0009 to 0011 run with a backup first; the two new extensions append `pi.system` entries to every conversation once. Deploy while no thread is mid-tool: a `bash`, `write` or `edit` call cut off under the old `unsafe` build and resumed by this one has no effect mark, so it would run again.

## Wave 3 integration

Integrated on 2026-10-29 on `main`.

### Packages

| Package | Branch | Commit | Status |
| --- | --- | --- | --- |
| 3A Subagents extension | `phase2/3A` | `9a1b3d7` | done, not approved: left out (below) |
| 3B Workspaces and the trailer | `phase2/3B` | `2d085de` | done, merged as `52cd4ad` |
| 3C Pending requests, server side | `phase2/3C` | `58eb5aa` | done, merged as `352659e` |
| 3D Codex plan windows | `phase2/3D` | `3a13b0f` | done, merged as `1904bfc`; the live read waits on the user's Codex login |
| 3E Artifacts | `phase2/3E` | `737f911` | done, merged as `e70a0bb` |
| 3F Portals | `phase2/3F` | `c343bf7` | done, merged as `4339bc8` |
| 3G pi host judges | `phase2/3G` | `adf947e` | done, merged as `34909a1` |
| 3H Bridge transcript lag | `phase2/3H` | `38b30d3` | done, merged as `d2a8628` |

Each branch merged with `--no-ff` in the order B to H, all from `631afb3` (wave 2 integrated), with no conflict. The hand-offs are one commit, `80171d1`; this note and the judge and doc edits are the next.

**3A is left out.** Its review holds one blocking finding: when a quiet reporter (the user's steer of an idle child) and a waking reporter (the parent's `subagent_send`) end on the same child run, pi-durable settles both inputs with that run's one answer, `settle` settles each answer once, and the reporter that commits first decides `quiet`. If that is the user's steer, the parent never wakes for its own send (reproduced 5 of 5 on pi-durable; the scripted harness has the same flaw and also disagrees with pi-durable in the followUp case). ADR 0028 allows only a stop to lose a wake. 3A's hand-offs (the `subagents: 650` order key, `Subagents` in the production set, the subagent boot repairs, `SubagentRows`, ADR 0034 accepted, `SubagentQuestionState.cancelled`, `ThreadCreate.lineage`, the glossary's subagent anchor, child scope and brief task) wait for its fix and come with its merge. So does 3B's last hand-off: the spawn calls `ChildWorkspaces.prepare` before it commits the child's receipt and gives the child that cwd.

**3A's next round (`7e30337`) is left out too.** It fixes the first wake finding for untyped runs: a mark records the inputs its run ended, and the first reporter to settle a run groups its peers, so the user's quiet steer no longer hides the parent's send. Its review holds a new blocking finding on the nudge path, in both harnesses. A settle that sends the nudge to a typed child records no mark for the run's other inputs, so which reporter commits first still decides the outcome. In the probe, a typed child is steered by the user during its brief run, ends without `submit_result`, then accepts the nudge. The scripted harness never wakes the parent. Pi-durable, depending on reporter order, settles the run twice: either `failed` with a wake and then the real result as a quiet note, or a spurious quiet `failed` note first. With the nudge run not held, it delivers `{"count":4}` twice. The fix asked for binds the run's inputs to the nudge in the commit that sends it and adds the scenario on both harnesses under both reporter orders. 3A's hand-offs and 3B's spawn step stay held, unchanged; `phase2/3A` and its worktree stay for the next round.

**3A's third round (`a87723d`) is left out too.** It fixes the nudge-path finding (a nudge mark binds the run's inputs, and a run seen live is keyed by its first input), wires 3B's spawn step (`ChildWorkspaces.prepare` after Go, before the creating commit) and passes its own judges (`pnpm check` 1,942 tests in 326 s; 147 subagent scenario cases over both harnesses and both held reporter orders; `SubagentsPiDurable.test.ts` 6 of 6). Its review holds a new blocking finding: an unanswered child run that ends with no entry of its own (a stop at an approval or between tools, or a failure before any answer) has no bounded end. `terminalAfter` in `SubagentTasks.ts` returns a later run's terminal, or nothing, and `resultPlace` then reads to the end of the transcript, so a late reporter for the stopped run takes a typed result a later run accepted. In the probe (a typed child stopped at a pending `gate` approval, then told "submit it" by the user), pi-durable with the waking reporter held 1,500 ms delivers `{"count":4}` twice, 2 runs of 2: a quiet `completed` note, then a `was stopped` settlement carrying the payload that wakes the parent. The same bound feeds the `end:<entry>` key fallback. The fix asked for ends an unanswered run at the first placed entry of a submission that is not one of its inputs, keys the fallback from that bound, matches it in the scripted harness, and adds the probe to the shared-run scenarios. 3A's hand-offs and 3B's spawn step stay held; `phase2/3A` and its worktree stay for the next round.

### Integration judges

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | ok in 166 s: fmt, lint, typecheck, 1,859 tests. No dependency changed, so `pnpm install --frozen-lockfile` was not needed over the existing `node_modules`. |
| `judges/reach-restart.sh --porch /tmp/reach-probe/porch-bin` (3F, ADR 0038's gate) | pass | restart: 15 of 15 probes through the `kill -9`, 15 of 15 through the SIGTERM, close 200, then the name 404; matrix 16 of 16 (open and close steps, rerun or left to the repair), nothing left; control 1 ok and 15 failed, as it must; no leftover unit, porch or container. No model, $0. |
| `node judges/artifacts-kill.ts --porch /tmp/reach-probe/porch-bin` (3E, with the two new cases) | pass | 40 of 40 checks over six cases: stage, claim (a claim with no hash, nothing served, then published), porch (served with its hash not filled in, then filled in, `changed: false`), publish, restore, remove. No model, $0. |
| `judge-main.ts` boot on a throwaway port and a fresh data folder | pass | Migration 0012 made `child_workspaces`; boot repairs in order: sweep uploads, executor sweep, cancel abandoned approvals, retry parked approval waits, child workspace repair, resume launches, checkpoint repair, spend reconcile, portal reconcile, start portal sweep, start event reactors; no `boot_repair_failed`; ready in 20 ms; `closing` and `closed` on SIGTERM. |
| `node judges/durability.ts --no-page` (the judge brain with `cairn.reach` and `ask_user` installed) | pass | 13 of 13. Kill to up 1,231 to 1,441 ms; up to converged 5 to 12 ms; sigterm-six 3,108 to 3,122 ms. |
| `judges/pi-readonly.sh --no-turn` (the brain as deployed) | pass, after a fix | It failed first on a second child process: 3B's coding tools ask `git version` once at boot to decide the commit trailer. The judge now counts that call apart (`git-version`, matched on its arguments) and still fails on any other child. Agent dir identical (62,151 entries), pi home identical (4 entries), children `flock` and `git-version`, opencode-go ready, anthropic refused, openai-codex missing, boot 883 ms. $0. |
| `node judges/pi-host.ts` (3G) | pass | kills: 2 kills (2.2 s and 3.2 s), `counter_safe` ran 3 times, `counter_unsafe` once; control failed rightly (`counter_safe` once); pi home unchanged. Faux model, $0. |
| `node judges/dev-smoke.ts` (scripted dev brain, now with its own portal settings and fake porch) | pass | Live after 2,583 ms; the demo thread grew from 2 to 8 entries; 0 page errors. |
| Real-model judges | not run | None at integration. The packages' own: 3H's bridge windows on `claude-haiku-5-5` on the Claude Code plan (nothing billed, about $1 to $2 at API rates); 3G's committed `--search` run, a few cents on `opencode-go/minimax-m3`; the rest $0. |

`judges/reach.ts` (3E's artifact half over a throwaway Caddy container) was not rerun: it passed 15 of 15 on the branch, the integration changed only how its services are built, and ADR 0005 keeps Docker for Executor.

### Hand-offs applied

- **`db/Migrations.ts`**: `0012_ChildWorkspaces` (3B). Its test kits and kill fixture still spread it themselves, which is redundant and harmless.
- **`Extensions.ts`**: `ExtensionOrder.reach: 760` and `askUser: 870`. The reach note's 750 is already the provider request log's private order (`PROVIDER_REQUEST_ORDER`), and the extension set refuses two entries on one key, so reach takes 760. **`ExtensionSet.ts`**: `ReachTools` (over `ExtensionOrder.reach`) and `askUserExtension(ExtensionOrder.askUser)` in `production`; the conformance target's `ask_user` extra and `ASK_USER_ORDER` are gone. `CodingTools.test.ts` expects `cairn.reach` after the request log and `cairn.ask-user` after `cairn.roles`.
- **`reach/ReachExtension.ts`** (3E's file, the 3F hand-off): `ReachTools.layerAt` also yields `PortalTools` and installs `portal_open`, `portal_close` and `portal_list` beside the artifact tools under the one `cairn.reach` name.
- **`reach/ReachLayer.ts`** (new, integrator): `ReachServices` (Artifacts, Portals, PortalTools, ReachLister over Git), needing `PorchClient`, `PortalUnits`, `SqlClient` and `ServerConfig`; `ReachMachine.layerTest` (a fake porch and fake units in a temp folder) and `layerFakePorch` (a fake porch with the real units); `judgePortalSettings(prefix, offset, PATH)`; `ReachServicesTest` for tests that build the extension set. `AppLayer.ts` exports `ReachLive` (`ReachServices` over `DatabaseLive`), which `AppLayer` merges and each entry point gives `PiDurableBrain`, as `SettingsLive` is, so one portal store serves the tools, the RPCs, the boot repairs and the close hook.
- **Porch and units are the entry point's**, so nothing but `main.ts` can reach the user's porch or production portal units: `main.ts` gives `PorchClient.layer`, `PortalUnits.layer` and `portalSettingsLayer(process.env)`; `judge-main.ts` gives `layerFakePorch`, units `cairn-judge-portal-<pid>-` on ports 38100 to 38199 and `judgePortalFaults(CAIRN_JUDGE_FAULT, <data>/portal-fault-fired)`; `dev-main.ts` gives `layerFakePorch` and `cairn-dev-portal-` on 38200 to 38299. Tests and judges that build `AppLayer` (`Boot.test.ts`, `Ws.test.ts`, `typing.ts`, `paste-client.ts`, `shell-resume.ts`, the parity `CairnApp.ts`) take `ReachMachine.layerTest`; those that build the extension set take `ReachServicesTest`, as do `judges/fixtures/transcripts/record.ts` and `judges/pi-readonly.sh`.
- **`AppLayer.ts`**: `ChildWorkspaces.layerNoDeps` over `ChildWorkspaceStore.layerNoDeps` inside `ProjectsLive`, beside `Worktrees` and `Git`.
- **`rpc/Handlers.ts`**: `PortalHandlers` and `ReachHandlers` after the stubs, replacing `reach.list`, `artifact.revoke`, `portal.close` and `portal.start`. The stubs stay in `StubHandlers.ts`, since the RPC tests build a full handler set from them. `reach.list`'s portal half was already `ReachLister`'s read of the `portals` table.
- **`BootRepairs.ts`**: `child workspace repair` after retrying parked approval waits and before resuming launches (so before the Harness resumes); `portal reconcile` then `start portal sweep` after `spend reconcile` and before the event reactors. `ReachRepair.ts`'s `portalReconcile` is now built by hand rather than through `bootRepair`, which closed an import cycle with `BootRepairs.ts`. **`ShutdownHooks.ts`**: `stop portal sweep` after the bridge's closing hook.
- **`reach/ArtifactPublisher.ts`** (2F's file, 3E's hand-off): `ArtifactFaults` read at build; `after("claim")` once the claim is held, before porch; `after("porch")` after porch, before the row is filled in. `judges/artifacts-kill.ts` gained the `claim` and `porch` cases.
- **ADR 0038 is accepted**, with this run's gate evidence. **`docs/phase-2/notes/models.md` M7** now says OpenCode Go reports `unsupported`, as the protocol and glossary do.
- **`GLOSSARY.md`**: child workspace (with the `Cairn-Thread` trailer); the portal entry says how a portal outlives a restart and when it closes.

### Hand-offs held for later packages

- **3A's**, all of them, and 3B's spawn step (above).
- **3C, for 6A**: `client-logic/PendingRequests.ts` exports `pendingRequests`, `requestBodyOf`, `settledLines` and `settledLineOf`, `answersProblem`, `answeredQuestions` and `answerText`. The card validates with `answersProblem` before `thread.respond`, since the server refuses a misfit as `invalid_input`. The t3code `pendingUserInput` card behaviour (digits, the 200 ms advance, undo) is 6A's port.
- **3D, for 6G**: `UsageFeed` has no `opencode-go` row yet. Add a ready OpenCode Go provider with `reading: "unsupported"` and `windows: []` from the feed (it then reads `PiModelSource`'s readiness) or from the wave 6 meter. `UsageFeed.layer` and `layerNoDeps` now also need `PiModelSource`, which `HandlersLayer` already has.
- **3E, for whoever next edits `reach/`**: export `StoredRow`, `decodeStoredRows` and `rowOf` from `ArtifactPublisher.ts` so `Artifacts.ts` drops its duplicate codec (S12); make the fake porch answer `changed: false` when its registry holds the same hash for that source, as porch 0.0.0 does, and drop the `registryOnly` wrapper in `Artifacts.test.ts`. Thread deletion needs a hook that removes `<data>/artifacts/<thread>/`.
- **3F, for a judge-brain case**: with `judgePortalFaults` now in `judge-main.ts`, a faux-model thread can call `portal_open`, be killed at `portal:after-unit`, and its resumed run end with the same portal open. `reach-restart` still uses its own fixture brain (`judges/fixtures/reach/PortalBrain.ts`).

### Rules later packages follow

- **Reach services come from the root.** Use `ReachLive` in an entry point and `ReachServicesTest` or `ReachMachine.layerTest` in a test; never build `PorchClient.layer` or `PortalUnits.layer` outside `main.ts`. A judge or dev brain's portal units carry its own prefix, which its reconcile and sweep keep to, and its ports sit outside 3100 to 3699.
- **Portal units** are `cairn-portal-<16 hex>` on ports 3100 to 3699; a judge's are `cairn-judge-portal-<pid>-<id>`, which `Unit.sweepOrphans` also reaps.
- **The coding tools ask `git version` once at boot** (3B's trailer); a judge that counts child processes counts it apart.

### What differs from the plan

- **3A left out** (above), three times; its fourth round merged later ("Wave 3 completion: 3A" below).
- **3B**: the spawn's workspace step is built and judged on its own (temp-repo tests, the kill between the intent row and `git worktree add`, the boot repair over a real pi-durable brain); 3A's brief task calls it since 3A merged (below).
- **3C** added a third scenario, `question_across_restart`, beyond the two the block names. The card is wave 6.
- **3D**: `CodexAccess.ts` sits in `models/` (S42 keeps pi-ai's runtime imports there); a failed read clears the windows rather than greying them; the live read is the user's (below).
- **3E**: the kill judge runs separate child processes over the real porch (`fixtures/reach/ArtifactBrain.ts`) instead of a systemd judge brain. Dot folders are refused only on the way to the source, so a site's `.well-known/` publishes.
- **3F**: no `porch lease` exists, so a portal's porch is `porch add` with a port Cairn picks; archiving a thread closes its portals through the one-minute sweep; both tools gate as the `command` action; the close fault cells are `portal:after-close-<row|unit|porch>`.
- **3G** reran `pi-readonly.sh` without a paid turn; pi-web-access 0.45.0 no longer writes `~/.pi/exa-usage.json` when an Exa key is set (ADR 0039).
- **3H** changed the convergence check every durability window uses: `sameShell` compares projects and threads, not `snapshotSequence`, because an unchanged thread row is skipped on purpose and leaves a live client one sequence behind. The skip-snapshot sabotage control still fails all 13 windows. The write-up is `spikes/10-bridge-transcript-lag/NOTES.md`.

### Left for the user

- **The live Codex usage read (3D's second judge)**, after `ops/wizards/phase-2.sh 1` and a deploy: subscribe to `usage.subscribe` on `cairn.service` (the only holder of the OAuth lock) and expect an `openai-codex` row with `reading: "read"`. Save the `wham/usage` body, with the access token, refresh token and account id removed, as `apps/server/src/usage/fixtures/wham-usage/live-<plan>.json`.
- **The reach stage of the wizard** (`ops/wizards/phase-2.sh 2`) from wave 2 is still to come; until porch is set up, the deployed brain's portal reconcile and the artifact tools answer porch's "not set up" error.
- **When deploying** (nothing is deployed by this integration): migration 0012 runs with a backup first; the `cairn.reach` and `cairn.ask-user` extensions append `pi.system` entries to every conversation once; deploy while no thread is mid-tool, as before.

## Look track L0 and L1 integration

Integrated on 2026-10-29 on `main`.

### Packages

| Package | Branch | Commit | Status |
| --- | --- | --- | --- |
| L0 Fork frame | `phase2/L0` | `d5e0b97` | done, merged as `d1079c7` |
| L0 seam (`View.ts`) | `phase2/L0-seam` | `0f62b93` | the integrator's yes, merged as `e450e8c` |
| L1 Measured transcript list | `phase2/L1` | `0439feb` | done, not approved: left out (below) |

L0 merged with `--no-ff` from `de007a5`, then its seam branch on top, with no conflict. The seam is accepted as proposed: `View.ts` keeps the classic body as `classicView` and draws the `next` frame only when the `ui` setting is `next` and its chunk has loaded, handing it the classic regions (sidebar state, sidebar, notice, page). The note, the glossary entry and the `capture.ts` exit fix are the next commit.

**L1 is left out.** Its review holds two blocking findings. First, an off-screen measuring copy and its list row share one memoized vnode: `offScreen(index)` and `row(index)` both call `itemToView`, which the timeline answers from one per-thread keyed lazy. When a render draws a row in the list and drops the probe box in the same patch, snabbdom points the shared vnode at the new element first, so the probe's destroy hooks strip the live row's click listeners and release its Mounts. In the probe (1,440 px, 1,600 px into history, narrowed to 1,000 px, then scrolled up), 5 rows that came in from the probe box lost their `click` listener, and "Worked for 3.4s" no longer opened. The fix asked for gives the off-screen copy its own cache slot (a `probe:` key or a second keyed lazy) and a judge check that clicks a fold that came in from the probe box. Second, `transcript-scroll.ts` passed 2 of 3 clean runs: a harness commit inside `scrollUp`'s 2.5 s window moves the working indicator, the list rightly corrects `scrollTop` by 43 px to hold the reader's row, and the check counts any `scrollTop` change. The fix asked for judges what the reader sees, as the land checks do, and shows several green runs in a row. L1's hand-offs (the waves numbers, the backlog line, the "measured list" glossary entry, its `capture.ts` changes) come with its merge; `phase2/L1` and its worktree stay for the next round.

### Integration judges

L0's block names no judge "at integration"; these rerun its own judges on the merged `main`.

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | ok in 166 s: fmt, lint, typecheck, 1,875 tests (16 more than wave 3: L0's `Frame`, `FrameLoad`, `Hooks` and `Fork` tests). No dependency changed; `pnpm install --frozen-lockfile` was a no-op. `Budget.test.ts` unchanged and green. |
| `node judges/behaviour.ts --ui next --strict` | pass | 22 of 22, every page showing `#root[data-ui=next]`. |
| `node judges/behaviour.ts --strict` (classic) | pass | 22 of 22, with the check that no classic page shows the next frame. |
| `node judges/capture.ts cairn --group sidebar` (after the exit fix) | pass | Printed its final JSON and exited 0 in 45 s, releasing the judge lock. |
| Real-model judges | not run | None needed. $0. |

The full before-and-after `capture.ts cairn` comparison was the package's (34 PNGs and 26 landmark files byte-identical; 10 HTML files differing only in run-to-run values: blob URLs, the settings clock, the virtual list's scroll counter, Syncing against Reconnecting). The integration added nothing to the classic path beyond the seam that comparison already covered, so it was not rerun.

### Hand-offs applied

- **`apps/web/src/View.ts`**: merged from `phase2/L0-seam` as proposed, with `next/Fork.test.ts`.
- **`apps/web/src/next/Frame.ts` is integrator-only** from now on (already listed in the plan's section 3). Its contract is `view(model, h, regions)`, where `regions` is `{ sidebarState, sidebar(), notice(), page() }`; L6 and L7 replace regions inside it.
- **`judges/capture.ts`** (L0's blocker, done by the integrator): it now calls `process.exit(0)` after its report, as `behaviour.ts` does, because a handle a cairn run left open kept the process alive and the judge lock held. A thrown error still exits non-zero.
- **`GLOSSARY.md`**: "Next (views)".
- `Route.ts` and `main.ts`: no change; `?ui=` is read by the settings `LoadClientSettings` command.

### Rules later packages follow

- **`next` reads the classic hooks through `next/Hooks.ts`.** A judge that reads a hook `Hooks.ts` does not name fails `Hooks.test.ts`.
- **Classic stays byte for byte.** A look-track package that touches a shared view proves it with `capture.ts cairn` before and after.

### What differs from the plan

- **L0**: there is no `ui` row on the classic settings page, since it would change the classic settings capture; the switch is `?ui=next` and `?ui=classic` until L7 draws the row on next's page. The chunk's load state lives in the settings submodel (`nextFrame`), not the root Model. Classic draws until the settings load and the chunk arrives, so a next page shows classic for its first frames. The entry bundle grew 861 B gzip (289,334 to 290,195 B, budget 294,912 B) for the setting, the `?ui=` read, the loader and the switch; `Frame.ts` itself is a 402 B chunk of its own. `behaviour.ts --ui next` writes `behaviour-next.json`.
- **L1 left out** (above); `range` and `reflow` stay in `KNOWN_FAILING` on `main`.

### Left for the user

- Nothing for L0: to try it, open Cairn with `?ui=next` (it looks like classic inside a marked frame until L6 and L7). Nothing is deployed by this integration.

## Wave 3 completion: 3A

Integrated on 2026-10-29 on `main`.

### Packages

| Package | Branch | Commit | Status |
| --- | --- | --- | --- |
| 3A Subagents extension | `phase2/3A` | `5ae27ba` | done and approved, merged as `23bc5e5` |

3A merged with `--no-ff` from `1b41929` (look track L0 integrated), with no conflict. Its fourth round fixes the third round's unbounded stopped-run finding: an unanswered child run's identity and extent are read from pi-durable's committed transcript, not from live `pi.live` watches (a steer shares the `byTaskId` of the tool-calling entry before it, inputs one commit placed are read as one placement by adjacent entry ids and one attribution, anything else starts a run, a reset bounds it), so `followRun` is gone and a late reporter never takes a later run's typed result, words or turns. 3B's held spawn step comes with it: the brief task calls `ChildWorkspaces.prepare` after Go and before the creating commit, and the child runs in that cwd. The hand-offs are one commit, `6687474`; this note, ADR 0034 and the glossary are the next.

### Integration judges

3A's block names no judge "at integration"; these rerun its own judges on the merged `main` and the wave 3 judges whose brains now carry `cairn.subagents`.

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | ok in 360 s: fmt, lint, typecheck, 1,965 tests (90 more than the L0 note: 3A's scenarios and tests). No dependency changed; `pnpm install --frozen-lockfile` was a no-op. `MemoMapIsolation.test.ts` and the `ChildScope.test.ts` build scan are inside it. |
| `Conformance.test.ts -t subagent` (pi-durable and scripted, both held reporter orders) | pass | 88 passed (65 other scenarios skipped by the filter) in 122 s, with `Subagents` now coming from the production set (`Subagents.layerWith`) rather than an extra extension. |
| `judge-main.ts` boot on a throwaway port and a fresh data folder | pass | Boot repairs in order: sweep uploads, executor sweep, cancel abandoned approvals, retry parked approval waits, subagent rows (0 made), retry parked subagent tasks (0), child workspace repair, resume launches, checkpoint repair, spend reconcile, portal reconcile, start portal sweep, start event reactors; no `boot_repair_failed`; `ready`; `closing` and `closed` on SIGTERM. |
| `node judges/durability.ts --no-page` | pass | 13 of 13. Kill to up 1,285 to 1,491 ms; up to converged 5 to 17 ms; sigterm-six 3,118 to 3,174 ms. |
| `judges/pi-readonly.sh --no-turn` (the brain as deployed, now opening `cairn.sqlite` for its child workspaces) | pass | Agent dir identical (62,151 entries), pi home identical (4 entries), children `flock` and `git-version`, opencode-go ready, anthropic refused, openai-codex missing, boot 1,113 ms. $0. |
| `node judges/dev-smoke.ts` | pass | Live after 2,555 ms; the demo thread grew from 2 to 8 entries; 0 page errors. |
| Real-model judges | not run | None needed. The package's own rounds used none either. $0. |

### Hand-offs applied

- **`Extensions.ts`**: `ExtensionOrder.subagents: 650`, between Executor and the bridge's cwd; `Subagents.ts` drops its `SUBAGENTS_ORDER`.
- **`ExtensionSet.ts`**: `Subagents` in `production`, left out of `dependencies`: the composition root gives it. **`AppLayer.ts`**: `SubagentsLive`, `Subagents.layer` over the app's `ChildWorkspacesLive` (with the same `Worktrees`, `Git` and `DatabaseLive` references `ProjectsLive` uses, so the memo map builds one `ChildWorkspaces`), provided inside `PiDurableBrain`, so `main.ts`, `judge-main.ts`, `dev-main.ts` and every test that builds `PiDurableBrain` get it with no edit of their own. `SubagentRows` (the row fiber) joins `AppLayer`'s `mergeAll`.
- **Tests that build the extension set** take the new `Subagents.layerTest` (no faults, children's workspaces under a fresh temporary folder), beside `ReachServicesTest`. `ChildWorkspaceRepair.test.ts` gives `Subagents.layer` over its own `workspacesAt(data)` instead, since `ChildWorkspaces.layerNoDeps` is one memoized reference and the test's repair must see the same plans. `SubagentWorkspaceCrash.test.ts` gives its hanging workspace access as its own `Subagents` layer under `ExtensionSet.layer`. `CodingTools.test.ts` expects `cairn.subagents` after `cairn-executor`.
- **`conformance/Targets.ts`**: `piDurableLayer` is `ExtensionSet.withExtra([conformanceTools])` with `Subagents.layerWith(faults, tuning)`; `childWorkspacesAt(dataDir)` stays provided under it, and the `workspaceAccess` unwrap is gone, so the extension installs once.
- **`BootRepairs.ts`**: `subagent rows` and `retry parked subagent tasks` right after retrying parked approval waits and before the child workspace repair, so before the Harness resumes; the requirement union gains `ThreadRows` and `EventSink`.
- **ADR 0034 is accepted** with its gate evidence. ADR 0028 stays proposed until 4C's `judges/subagent-durability.ts` passes.
- **`GLOSSARY.md`**: subagent anchor, brief task, run mark, child scope; Landmark's _Avoid_ now says that "anchor" is the subagent anchor's.

### Hand-offs held for later packages

- **4A**: the dispatch scenario must give the child a model or thinking level that differs from its parent's (today removing the configure in `startChild` fails no scenario); `RoleAliases.resolve` at Go and `priced`; the S3 cap of 32 live children per brain.
- **4B**: `ask_parent`'s `parentIdle` escalation (a question queued behind a parent run that fails or ends is withdrawn and escalated) stays 3A's; 4B builds its other three triggers around it. When 4B writes `cairn.escalations` on pi-durable, put `why` back into `EscalationTarget` at the three `SubagentTools.ts` call sites (`subagent_reply` passes `SubagentToolText.parentEscalated`, `ask_parent` passes `EscalationWhy.parentStopped` or `parentRunEnded`). S3's rule that a final answer ending in a question becomes a route-parent question needs a protocol `source` field, which 4B proposes.
- **4C, `judges/subagent-durability.ts` with `kill -9`**: a kill between a steer reporter's commit and the seam's submit; a kill between a reporter's settle commit and its nudge submit; a real park of a subagent task after 5 crashes. A kill between `ChildWorkspaces.prepare` and the brief task's creating commit is covered in process by `SubagentWorkspaceCrash.test.ts`, and the steer-then-stop run identity by the shared-run scenarios; 4C may add them as kills. Also for 4C and 6: a thread created before this change gets no `cairn.subagents` document until its first child starts, and a stream opened before then shows the registry only after the client resubscribes.

### Rules later packages follow

- **`Subagents` comes from the root.** An entry point gets it through `PiDurableBrain`; a test that builds `ExtensionSet.layer` gives `Subagents.layerTest`, or `Subagents.layer` over its own child workspaces when it reads them, or `Subagents.layerWith(faults, tuning)` for planted faults. Never add `subagentsExtension` through `withExtra` beside the production set: it would install twice under one name.
- **Per-child layers go through `ChildScope.build`** (ADR 0034); the scan in `ChildScope.test.ts` refuses direct builds under `subagents/` and `workflows/`.

### What differs from the plan

Protocol and document shapes beyond the plan, accepted by the integrator:

- `packages/protocol/src/Subagents.ts`: `SubagentRecord.runs: Array<RunMark>`, where a `RunMark` is `{run, phase: "nudge", seq, inputs, quiet}` or `{run, phase: "settled", seq}` and `run` is `answer:<entry>`, `run:<first input entry>` or `input:<submission>`; `SettlementMark.inputs` (the request ids of every input a settled run ended); `SubagentQuestionState` gains `cancelled` (with a row in `docs/golden/thread-states.md` and a case in `judges/thread-state-rows.test.ts`). `packages/protocol/schema/cairn-documents.json` is regenerated. No index export changed.
- `cairn.brief-answer` entry data gains `started` (true on Go, false on decline, revise, expire and `noWorkspace`) in both harnesses; `BriefAnswer` gains `noWorkspace` in `brain/SubagentText.ts`. Nothing in protocol or web decodes either.
- 2E's `models/ResultTool.ts`: a task-scoped `cairn.result-call` document (never on the wire) remembers the accepting `submit_result` call, so a rerun after a crash answers accepted again; `markOf` tells `already` from accepted by matching `ResultToolText.already` word for word.
- `shell/ShellCommands.ts`: `ThreadCreate.lineage`, optional, used by `SubagentRows`; 4C's row creation keeps it.
- 2A's conformance runner: `expect_view` gains an optional `match: "equals" | "includes"` (`Transcript.ts` schema, `HarnessConformance.ts` `viewAt`); with `includes` the array at `path` must hold an element equal to `equals`, so a scenario can assert two settlement notes whose order depends on reporter commit order. The runner also gained `picks`, `expect_request`, `requestsOf` and the normalized `model` and `questions` fields.
- Other edits outside 3A's block: `brain/NoteAdmission.ts` (new, note admission moved out of `PiDurableHarness.ts`); `PiDurableHarness.ts` (`STREAM_DOCUMENTS` gains the subagents and child documents, the subagents document is opened at ensure, `steerReporter` runs in `submit`, Stop all is `stopTree` forked into the layer scope); `Permissions.ts` (a child's mode narrowed by every ancestor's); `CairnDocs.ts`; `ScriptedHarness.ts` (subagent parity, and its idle admission places the first queued steer and follow-up in one run, as pi-durable's final boundary does); `brain/SubagentWorkspaceCrash.test.ts` (new); `Conformance.test.ts` (the shared-run scenario list) and the new scenarios and goldens.
- Limits 3A documents rather than closes: an input that no reporter's `pi.live` watch saw and that was stopped or failed before any reporter recorded it settles as a run of its own (one note more for the parent; on `runOf` and `RunSpan`); a run whose end lies past `RUN_SCAN` keeps its key with no end, and its reads are unbounded; Cairn installs no `onYield` continuation, so a generation's continuation would read as a new run. `subagent_typed_steer_then_result_stopped` is a regression guard, not a failing-first test.
- `SubagentRows` logs `subagent row fiber ended` (warning, exit `Failure`) when the brain shuts down, since the interrupt reaches its `onExit`; harmless, and worth quieting for interrupts when the file is next edited.

### Left for the user

- Nothing to do now; nothing is deployed by this integration. **When deploying**: the `cairn.subagents` extension appends one `pi.system` entry to every conversation once, so deploy while no thread is mid-tool, as before; subagents then become live on the deployed brain, with a child's worktree under the data folder when its brief asks for one.

## Look track L2 integration

Integrated on 2026-10-29 on `main`.

### Packages

| Package   | Branch      | Commit    | Status                                 |
| --------- | ----------- | --------- | -------------------------------------- |
| L2 Tokens | `phase2/L2` | `8d588ff` | done and approved, merged as `5071132` |

L2 merged with `--no-ff` with no conflict: two new files, `apps/web/src/next/tokens.css` and `judges/contrast.test.ts`. The hand-offs and this note are the next commit.

### Integration judges

L2's block names no judge "at integration"; these rerun its judge and L0's on the merged `main` with the hand-offs applied.

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | ok in 398 s: fmt, lint, typecheck, 1,975 tests (10 more than wave 3's completion: `judges/contrast.test.ts`). No dependency changed. `Budget.test.ts` green. |
| `judges/contrast.test.ts` (in `pnpm check`) | pass | 10 of 10; 726 pairs per candidate and theme, all AA; lowest text 4.51 (stone dark `--ink-3` on `--surface-overlay` + `--select-5`), lowest non-text 3.67. The package's planted runs (a 40 percent ink, a palette utility, `bg-[red]` in `next/`) each failed it. |
| `vite build`, with and without the seam edits | pass | The entry CSS is byte-identical (`index-zvzowL-O.css`, 231.99 kB, 34.50 kB gzip), so the theme names add nothing to classic. The tokens ship as the next chunk's `Frame-*.css`, 8.70 kB (2.25 kB gzip); the entry JS grew 30 B (its preload list names the new CSS). |
| Chromium probe over the parity fixture (temporary script, removed) | pass | On `?ui=next`, `#root` resolves `--ink-1` to `#f5f5f5` in dark and `#27272a` in light (graphite); on classic, `--ink-1` and `--select-1` are unset and the page loads one stylesheet fewer. |
| `node judges/behaviour.ts --ui next --strict` | pass | 22 of 22. |
| `node judges/behaviour.ts --strict` (classic) | pass | 22 of 22. |
| Real-model judges | not run | None needed. $0. |

### Hand-offs applied

- **`apps/web/src/next/Frame.ts`**: `import "./tokens.css";` as its first import. Classic never loads the chunk, and nothing in classic carries `data-ui`, so the tokens apply nowhere there.
- **`apps/web/src/styles.css`**: the integrator's answer to L2's Tailwind question is to register the names. `@theme inline` gains `--color-<name>: var(--<name>)` for the inks, surfaces (ground, rail, sidebar, sunken, overlay), strokes and focus ring, the five ladder steps, the accent (`accent-fill`, `accent-ink`, `accent-text`, `accent-wash`) and the four tones with their washes, so `next` views write `text-ink-2`, `bg-select-1` or `border-stroke-1`. `--color-surface-raised` was already classic's and serves both. The arbitrary-property form (`text-(--ink-2)`) still works for the size, space, duration and layer tokens.
- **`data-look`**: set nowhere, so graphite draws. Once the user chooses, the winner's values become the default blocks and the other candidates go, or a `look` client setting sets `data-look` on both `<html>` and `#root` beside `data-ui` (in `ClientSettings.applyClientSettings` and `Frame.ts`).
- **`GLOSSARY.md`**: "Design token" and "Look" (with its candidates). L2's other proposed wordings ("Tokens (next)", "Look candidate", "Candidate (look)") are folded into those two.

### Rules later packages follow

- **`next` draws only with design tokens.** `judges/contrast.test.ts` fails any palette utility, arbitrary colour or colour literal in `next/` outside `tokens.css`, and holds every text pair to AA; a new token joins its pairs there.
- **Tokens scope to `[data-ui="next"]`**, and dark to `.dark [data-ui="next"]` and `.dark[data-ui="next"]`; the bridge maps classic's semantic names onto them, so a classic region inside the next frame takes the look but is not held to AA.

### What differs from the plan

- The package's own deviations stand as accepted: tokens scope to `[data-ui="next"]` rather than `:root[data-ui="next"]`; the accent fill is `--accent-fill` (classic's `--accent` is a hover ground); font and easing tokens are `--font-ui`, `--font-code` and `--ease-motion`; the appearance contrast boost does not reach inside `next`; `--stroke-2` has no 3:1 floor, since no control relies on its stroke alone; the type scale has six steps; the palette lint lives in `contrast.test.ts` rather than a file of its own.
- Three look candidates rather than one chosen set: the plan expected the design pass to have chosen values first. Round 0 is published at `plans.gneiss.run/cairn/v2/look/round-0/`; its generator stays scratch until L5 builds the look tool.

### Left for the user

- **Choose a look** in round 0 at `https://plans.gneiss.run/cairn/v2/look/round-0/` (graphite, ink or stone). Until then `?ui=next` draws graphite. Nothing is deployed by this integration.

## Look track L1 integration

Integrated on 2026-10-29 on `main`, after L1's third review round.

### Packages

| Package | Branch | Commit | Status |
| --- | --- | --- | --- |
| L1 Measured transcript list | `phase2/L1` | `5148064` | done and approved, merged as `8cde02e` |

L1 merged with `--no-ff` with no conflict. It replaces `@foldkit/ui`'s virtual list with the transcript's own measured list in `apps/web/src/timeline/list` (ADR 0041, accepted), folds `FollowEnd.ts` into `list/Place.ts`, and carries its `judges/capture.ts` changes (below). The hand-offs and this note are the next commit.

Both blocking findings of the round that left L1 out (in the L0 and L1 note) are closed. A row's off-screen copy is drawn from its own cache slot (`itemToOffScreenView`, a second per-thread keyed lazy), so dropping the measuring box no longer strips the live row's listeners and Mounts; a new `probeClick` check clicks a fold that came in from the box. `scrollUp` now judges what the reader sees (the first visible row changed, or moved more than 1 px) and only reports `scrollTop` changes.

### Integration judges

L1's block names no judge "at integration"; these rerun its judges on the merged `main` with the hand-offs applied, each under the judge lock.

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | ok in 368 s: fmt, lint, typecheck, 1,994 tests (19 more than L2's integration: L1's `List.test.ts` and the timeline tests). No dependency changed; `pnpm install --frozen-lockfile` was a no-op. |
| `node judges/transcript-scroll.ts` | pass | `KNOWN_FAILING` empty, every check true. 2,100 rows, 328 elements on load and after the range walk; follow 0 px over 358 frames; 0 long tasks; range 6,400 px up and down with 0 px range steps and 0 reversals; reflow worst 0.5 px (at 390 px); insert-above, arrive, insert-far, arrive-far and remove-far 0 anchor moves (worst offset shift 0.7 px); extend 18,149 and 18,573 px joined at 1,440 and 390 px, 0 key changes; range-after-reflow (400 ms) 0 px steps; at-once reflow reported, not judged: 216 px steps, 6 `scrollTop` reversals, 0 content reversals; nested-wheel end 0 px, pill hidden; scroll-up 0 anchor moves, 0 `scrollTop` changes; probe-click 12 rows in the box, 0 listeners lost, `turn-fold:turn:2761` opened. |
| `transcript-scroll.ts --broken estimate` | fails, as it should | range (305 px steps), arrive, extend, rangeAfterReflow and probeClick fail. |
| Package's own controls and mutation (on `5148064`) | each fails its checks | anchor: reflow, insertAbove, arrive, insertFar, arriveFar, removeFar, extend; wheel: nestedWheel; estimate: range, arrive, extend, rangeAfterReflow, probeClick, longTasks; reflow: reflow; bookmark: reflow, longTasks; extend: extend. The shared lazy slot put back fails probeClick with 5 live listener removals and the fold closed (restored by trap, not committed). Over 14 clean runs the package saw one pill miss at 69 px (not seen in the next 10) and one longTasks miss at 51 ms under load 9.8 (ok on rerun). |
| `node judges/typing.ts chromium` | pass | 1,200 of 1,200 keys, match, IME ok, menus ok (path, skill, slash command); 0 slow views (the package saw 6, max 19.8 ms). |
| `node judges/behaviour.ts --strict` (classic) | pass | 22 of 22. |
| `node judges/behaviour.ts --ui next --strict` | pass | 22 of 22. |
| `node judges/capture.ts cairn --group thread` | pass | All thread states entered, including 390 thread-turn, thread-fold-open and thread-changed-files; no "no turn-fold row" log; exit 0 in 79 s. |
| Real-model judges | not run | None needed. $0. |

### Hand-offs applied

- **`judges/capture.ts`**, taken as is from the branch: `enterThreadState` scrolls Cairn's `[data-testid="timeline-scroll"]` up in 600 px steps (at most 40) until a drawn turn-fold appears, for thread-turn, thread-fold-open and thread-changed-files (the changed-files search uses the same helper); thread-end returns early and is captured as loaded; row locators skip only the off-screen probe copies, with `sel:not([data-list-probe] sel)`, so t3code's half (which has no `timeline-scroll` test id) finds its rows as on `main` before.
- **`docs/phase-2/backlog.md`**: the "Carried in from stage 2" transcript bullet is marked fixed by L1; `KNOWN_FAILING` is empty.
- **`GLOSSARY.md`**: "Measured list".

### Rules later packages follow

- **The transcript's rows go through `timeline/list`.** A row view must be safe to draw twice (once in the off-screen measuring box, once in the list); its off-screen copy comes from `itemToOffScreenView`, never the list's own lazy slot. 6C's subagent rows build on it.
- **`transcript-scroll.ts` keeps `KNOWN_FAILING` empty**, and a change to the list keeps every `--broken` control failing its checks.

### What differs from the plan

- The package's deviations stand as accepted: `FollowEnd.ts` is gone and following lives in `list/Place.ts` (the surfaces note had kept FollowEnd as the follow mount), so one Mount owns `scrollTop`; history the list never drew is measured off-screen ahead of the reader rather than mounted at once as MonoCode does; MonoCode's pause counter for sliding panes is not built, since nothing slides yet; the broken controls are a `broken` field on the list Model, shown as `data-broken` only when set; the probe-click check fires its own scroll event after setting `scrollTop`, matching the reviewer's probe; listener removals count only for elements still connected afterwards.
- A row coming on screen is now rendered twice (box and list) where the list used to reuse the box's copy; typing stays at 1,200 of 1,200.
- Typing ran on Chromium only; WebKit is L7's gate.
- The at-once reflow case (a range walk starting in the same frame as a width change) still steps the range by up to 216 px. ADR 0041 records it as a measured cost; 400 ms after the change the range holds at 0 px.

### Left for the user

- Nothing to do now; nothing is deployed by this integration. On the next deploy the classic transcript scrolls on the measured list, so the daily-driver day is when to watch for content moving under you.

## Wave 4 and look track L3 integration

Integrated on 2026-10-29 on `main`. Every package merged with `--no-ff`: 4A `73ffc09` as `32fe7fa`, 4B `3911764` as `6e076c4`, 4C `a07c70a` as `9e87d81`, 4D `5edcf33` as `25caeac`, 4E `37d4733` as `4de2e9d`, 4F `c00ca85` as `022dd71`, 4G `b95245a` as `a2abf81`, 4H `c535853` as `c38e1a1`, L3 `579aedc` as `b8682f5`. Conflicts kept both sides: 4A with 4B and 4C in `SubagentTasks.ts`, `SubagentTools.ts` (`questionRecord` now 4B's, in `QuestionRoute.ts`), `Subagents.ts` (`crashes` after `briefFaults` and `roles`), `CairnDocs.ts` and `PiDurableHarness.ts`; 4G's `Notifier.ts` badge (`badgeOf`). The hand-offs are `ab5deb5`; this note and the ADRs are the next commit.

### Integration judges

No block names a judge "at integration"; the brain's wiring changed, so these ran on `main` with the hand-offs, each under the judge lock.

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | ok in 422 s: fmt, lint, typecheck, 2,244 tests. No dependency changed. |
| `judge-main.ts` boot, fresh data folder | pass | Repairs in order: sweep uploads, executor sweep, subagent rows, spend reconcile, budget boot repair, cancel abandoned approvals, retry parked approval waits, retry parked subagent tasks, child workspace repair, resume launches, checkpoint repair, portal reconcile, portal sweep, event reactors; no `boot_repair_failed`; ready in 20 ms; `closing`, `closed` on SIGTERM. |
| `node judges/durability.ts --no-page` | pass | 13 of 13; kill to up 1,280 to 1,542 ms; up to converged 5 to 19 ms; sigterm-six 3,168 to 3,171 ms. |
| `judges/brief-go.sh` (ADR 0030) | pass | windows 10 of 10, parked true, control failed. $0. |
| `node judges/subagent-durability.ts` (ADR 0028) | pass | faux 10 of 10, 5 controls failed rightly; `--bridge` on claude-haiku-5-5 passed in 11 s (Claude Code plan). |
| `node judges/budget-kill.ts`, `judges/spend-kill.sh` (ADR 0036) | pass | J-budget kills 32,300 micros over against 39,500 allowed, both controls fail; J-spend 12 kills, 48 turns, 0 failures, control fails by double counts. $0. |
| Package judges not rerun | as reported | 4B relay and mirror tests, 4D kill matrix and ledger suite, 4G `push.ts --fake`, L3 `look-rules.ts`: unit parts inside `pnpm check`. 4F's J-typed: 119 of 120 over three runs, gpt-6-luna 23 of 24 (about $0.05 a run). |

### Hand-offs applied

`ExtensionOrder` gains `budgets: 640` and `workflows: 660`; `ExtensionSet` installs `cairn.budgets` (over `BudgetBook.layer`, the reference `AppLayer` gives `SpendLedger`, `Budgets` and `BudgetGuard`, so the memo map builds one book) and `cairn.workflows`; `AppLayer` adds `QuestionRoutes`, the guard, `Budgets`, `WorkflowPlan`, and `BudgetSources` under each brain; boot repairs reordered as above (4E). 4A's `Boot.ts` skip of `HUMAN_RETRY_TASKS` and 4B's `QuestionSource` in `Policy.ts` are accepted. A workflow node's child no longer gets the subagent tools (`nodeChildTools`, ledger test fails without it). Six 4B goldens take 4A's `thinkingLevel`. ADRs 0027, 0028, 0030 and 0036 accepted. Glossary updated.

### What differs from the plan

- 4B: `answer_child` and `escalate` are actions of `subagent_reply`; only `escalate` takes a reason (accepted; the briefs note asked a reason of both). Window and park triggers are judged on pi-durable only.
- 4D: judge 3 runs on pi-durable only; nodes share the launching cwd until 5A; whole-workflow abort, decline and park cases are not yet in the kill matrix.
- 4E: J-budget's bound is N responses; its no-stop control now keeps the gate (it is in the production set), and still fails by overshoot.
- 4H: until porch is set up the portal reconcile logs `reach_porch_not_set_up` once at info, not `boot_repair_failed`.
- Held for later packages: `Budgets.admit` at Go in the start task, with a `budget` brief answer (5A or 5F); a boot retry for parked `cairn.workflow-watch` tasks (5B or 5C); a `HarnessSeam` one-document read for `RequestRecords` (4G); kill windows for the routing commits (4B, 4C); `report` pre-empting `submit_result` in typed children (3A owner, 4F); envelope modes, readonly nodes, writer worktrees (5A); list pricing and subtree usage of nodes (5B).

### Left for the user

- Decide 4F's target: J-typed through children stays at every trial (blocked on the `report` fix) or becomes a rate such as 23 of 24 per model over three runs. gpt-6-luna stands in for Codex.
- Decide whether a supervised child's approval pushes under the root thread's tag with a "<child> asks:" prefix (4G pushes under the hidden child's today).
- When deploying: no brief pending or just answered (4A's new start and tell tasks); `cairn.budgets` and `cairn.workflows` each append one `pi.system` entry to every conversation once; wizard stage 3 (approval push on the locked phone) waits for that deploy.
