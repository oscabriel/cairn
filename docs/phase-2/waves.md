# Phase 2 waves

Integration notes, one section per step or wave, with what later packages read and what was measured.

## Step 1.0: the contract

Every phase 2 shape is declared; later packages fill them in and ask the integrator for anything new.

### Protocol modules

| Module | Holds |
| --- | --- |
| `Policy.ts` | `cairn.approvals` version 2 (`ApprovalRecord`, `APPROVALS_VERSION = 2`): kinds `brief` and `criteria`, status `revised`, `decidedBy` (`Decider`), `reason`, `answer`, a frozen `payload`, `route`, `escalatedAt`, `supersedes`, `started`, `briefHash`, `mirrorOf`. The payloads: `Brief`, `WorkflowLaunch` with its `Envelope`, `QuestionsPayload`, `CriteriaPayload`, `BudgetRaisePayload`, `ProgramPayload`. `JudgeRef`, `Verdict`, `Criterion`, `cairn.goal`, `cairn.permissions`, `SetCriteriaInput`. Decisions `accept`, `accept_for_thread`, `accept_sample`, `decline`, `revise`. |
| `Subagents.ts` | `ThreadLineage`, `SubagentTally`, `SubagentSettlement` (entry kind `cairn.subagent-result`), `cairn.subagents`, `cairn.child`, `cairn.escalations`, `cairn.result`, `DispatchRecord`, the caps (depth 2, 8 live children). |
| `Workflows.ts` | `cairn.workflows` (`WorkflowRecord`, `NodeRecord`), the event names and `cairn.events` cursors, recipe listing and reactor status. |
| `Reach.ts` | `ArtifactRow`, `PortalRow`, `reach.list`, the tools' `details`. No shape assumes a porch command (1G is dropped). |
| `Spend.ts` | `Tokens`, `Spend`, `SpendSummary` (the row's `spend`), `SpendScope`, `Budget`, `PriceBasis`, `BudgetState`. Money is integer micros. |
| `Roles.ts` | `RoleName`, `RoleSpec`, `RoleBinding`, `RoleTable`, `ResolvedRole`, `RoleCheck`, and ADR 0035's table as `DEFAULT_ROLE_TABLE`. |

Additions elsewhere: `WaitingFor` `parent`; `ThreadShell` gains `lineage`, `subagents`, `goal`, `spend` and `pendingCount`, each decoding to a default from rows stored before it (`BARE_ROW_FIELDS` for fixtures); `PendingRuntimeRequest.origin`; `StopInput.subagents`, `ConfigureInput.runtimeMode`, `RespondInput.reason` and `answers`; `ProviderUsage.reading`; `ServerSettings.roleBindings` and `defaultBudget`; login shapes in `Models.ts`. `SubscribeThreadInput.conversationId` and `HistoryInput.conversationId` are gone: a subagent is a thread. `PROTOCOL_VERSION` is 2.

Documents are plain JSON (`null`, never Options); `JsonSchema.test.ts` refuses a transformation inside any of them and keeps `schema/cairn-documents.json` beside the RPC golden.

### RPCs declared, stubbed `Unavailable`

`roles.check`, `spend.get`, `providers.login.start` (a stream), `providers.login.cancel`, `providers.logout`, `goal.setCriteria`, `workflow.stop`, `workflow.stopNode`, `workflow.list`, `workflow.eventStatus`, `reach.list`, `artifact.revoke`, `portal.close`, `portal.start`. Each package replaces its stubs through `rpc/Handlers.ts`.

Until 1A and 2B land, `thread.respond` refuses decisions other than `accept` and `decline`, and `thread.configure` refuses `runtimeMode`, with `InvalidInput` (`notYet` in `rpc/ThreadCommandHandlers.ts`). The package that implements each lifts its refusal. `thread.stop`'s `subagents` is read by 4C; until then a stop leaves children alone, which is the default anyway.

### Migration numbers

Reserved in `apps/server/src/db/Migrations.ts`: 0007 `OAuthCredentials` (1D), 0008 `ModelHealth` (1C), 0009 `Spend` (2C), 0010 `Artifacts` and 0011 `Portals` (2F), 0012 `ChildWorkspaces` (3B).

### Dependencies and boundaries

No new npm package: every package block and note uses what is installed (pi-durable, pi-ai, pi-coding-agent's `discoverAndLoadExtensions`, pi-codemode's sandbox, Effect). 1F reads a script's `meta` with the codemode sandbox or a hand parser, not a JavaScript parser package; if it needs one, it asks. `@cairn/client-logic` moved from the server's dev dependencies to its dependencies, because `EffectiveMode` (1E) is shared by server and client.

The S42 import boundaries gained phase 2's tool folders: pi-durable and pi-ai at runtime under `subagents/`, `approvals/`, `workflows/`, `verdicts/`, `reach/` and in `models/ResultTool.ts`; those plus pi-coding-agent under `pi-host/`. `judges/lint-boundaries.test.ts` probes each.

### Judges

- `pnpm check` green.
- `judges/thread-states.test.ts` reads the five new modules; it failed on 47 status values with no row and no label before `docs/golden/thread-states.md` gained them, and passes now (5 of 5).
- `JsonSchema.test.ts` regenerates both goldens without drift; its plain-JSON check fails on a planted `OptionFromNullOr` and caught `ResolvedRole`'s Options inside `cairn.subagents` before they were made plain.
