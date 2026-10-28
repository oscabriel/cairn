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
