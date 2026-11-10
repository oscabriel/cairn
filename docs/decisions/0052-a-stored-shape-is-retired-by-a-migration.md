---
status: accepted
gate: `pnpm check` green, with `RolesRetired.test.ts` (a store written with the old shapes opens and reads as the new ones, each document decoding with its protocol schema; each rewrite is safe to run twice), `0016RolesRetired.test.ts` (the role table's row goes, the rest stays, and a second run changes nothing) and `StreamDocuments.test.ts` (the stream's documents are exactly the visible `cairn.*` kinds) passing; no `isRoleName`, `role_removed`, `ROLE_OPTION`, `roleNameRead` or `roleBindings` reader left in the code
---

# A stored shape is retired by a migration, and a shim carries its date

Cairn keeps its state in two stores: pi-durable's documents (`brain.sqlite`) and `cairn.sqlite`'s rows. Their shapes change as the product does, and until now nothing said how an old shape leaves. Each change added a tolerant reader instead: an optional field so an old row decodes, a branch that reads a removed value as something else. ADR 0043 removed roles on 2026-11-02, and a week later the word was still a field name in three protocol structs (`Brief.role`, `Envelope.roles`, `NodeRecord.role`), and a dozen readers kept a branch for "a record written before ADR 0043" (review findings C-9 and V-19). The same review found every pi-durable document declared twice, once as the protocol's schema and once as a hand-written server interface tied to it only by sample tests (Q-5), and five client readers restating the subagent registry's fields (C-6).

The product has one user and one database, so a shim costs every future reader of the code and buys almost nothing.

## Decisions

1. **One declaration per document.** A pi-durable document the protocol describes has one declaration, its protocol schema. The writer's state type is derived from it (`DocumentState<typeof X>`, `PlainJson` of the schema's `Encoded` type, in `packages/protocol/src/Thread.ts`), so a field added, renamed or retyped on one side and not the other is a compile error. A brain-only document (`cairn.thread-meta`, `cairn.budget`, `cairn.wake-hold`, `cairn.judge-runs`, `cairn.workflow-sources`, `cairn.workflow-launch-runs`, `cairn.subagent-parents`, `cairn.event-dead-letters`, `cairn.result-call`, `cairn.thread`) has no protocol schema, and its interface is its one declaration. A value a writer builds from a protocol type is encoded by the protocol's schema (`plainCopy(encode(value))`), never rebuilt by hand. A reader picks its fields from the protocol's struct (`X.mapFields(Struct.pick([...]))`) instead of restating them, down to the leaves it reads (a nested struct is picked too, `Struct.evolve`), so a refinement on a field it never reads cannot hide the record. The thread stream's tokens (`STREAM_DOCUMENTS`) are held to the visible `cairn.*` kinds by a test.
2. **A document's shape change bumps its version and migrates when it is read.** The definition's `version` goes up and its `migrate` rewrites the old shape. pi-durable runs `migrate` whenever it hands out a stored value of an older version and stores the result at the next write, so every reader that goes through the document's token sees only the current shape. A reader therefore goes through the token (`snapshot`, `tx.doc`), never the store's raw value (`Storage.document`), which skips `migrate`. A migration is pure, works on a copy, never drops a record (one it cannot read is kept in a form that says so, as `cairn.approvals` version 2 did), leaves a value already in the current shape as it is, and is tested on a store written with the old definitions.
3. **A `cairn.sqlite` JSON row's shape change gets a numbered migration** in `apps/server/src/db/migrations/`, tested on rows built in the old shape and safe to run twice.
4. **A wire change an older client cannot read bumps `PROTOCOL_VERSION`.** The server then refuses the old page's dial, and the page reloads (`StaleBuild.ts`), so an open page needs no shim across a deploy.
5. **A shim carries its date.** A reader that still tolerates an old shape (an optional field "absent on records written before", a fallback, a version kept runnable) says in its comment the date after which it goes; the shims that predate this ADR have theirs in the table below. When the date comes, a shim is replaced by a migration under decisions 2 or 3, or deleted when nothing can still hold the old shape.

This is hard to reverse: once the brain writes a document at its new version, an older brain refuses it (pi-durable's "newer version 3 than 2"), so going back means restoring the store from a rolling copy (ADR 0016).

## Applied: roles retired (2026-11-10)

- The protocol: `Brief.role` is `Brief.model` (a model spec, null for the parent's model); the old `Brief.model`, a `ModelRef` from before specs that every writer left null, is gone. `Envelope.roles` is `Envelope.models`. `NodeRecord.role` is `NodeRecord.model`. `ModelSpec` no longer matches a role name (`@worker`), and `ModelCheckFailure` loses `role_removed`: a role name is refused as `invalid_spec`, as any text that is not `provider/modelId[:level]` is. `APPROVALS_VERSION` is 3 and `PROTOCOL_VERSION` 3. Nothing changed in meaning: each renamed field holds what it held, and a role name meant no model named since ADR 0043.
- The brain store: `cairn.approvals` (version 3), `cairn.workflows`, `cairn.subagents` and `cairn.goal` (version 2) migrate when read (`apps/server/src/brain/RolesRetired.ts`). `role` becomes `model`, a role name becomes null, a brief's old `ModelRef` folds into `model` when `role` named none, an envelope's role-keyed entries and a launch's role-keyed call sites are dropped (they granted the launching thread's model, which a stored envelope cannot name, so a node they covered asks for its own brief), a resolution loses `role`, `via`, `skipped` and `family` and names the model it ran on, and `roleOverrides` go.
- `cairn.sqlite`: migration `0016_RolesRetired` deletes the role table's `settings` row (`roleBindings`).
- The readers deleted: `isRoleName` and the role case of `parseModelSpec`, the `role_removed` words and refusals (`SubagentToolText.roleRemoved`, `goal_criteria`'s), `roleNameRead` and its `legacy_role_read` and `workflow_legacy_role` logs, the envelope's role grant (`NodeAsk.threadModel`), `ROLE_OPTION` and the node calls' `role` field, the card's and the steps panel's "this thread's model" reading of a role name, and the client's `isRoleName`. The prelude is version 4, without `role`.
- One more remnant the typed state found: the spend estimates read `resolved.role` (`BudgetSources.samples`), which no dispatch has written since ADR 0043; they are keyed by the resolved model spec. Nothing calls `Budgets.estimate` yet.

## Shims, with their dates

| Shim | Where | Goes after |
| --- | --- | --- |
| Prelude version 3 still runnable (its calls send a null `role`) | `workflows/Prelude.ts`, `RUNNABLE_PRELUDE_VERSIONS` | 2026-12-01 |
| A brief task of version 1 (`legacy` wait, `LegacyTell`) | `subagents/SubagentTasks.ts` | 2026-11-30 |
| A launch row with no run binding runs from none | `workflows/WorkflowDocs.ts` (`isLaunchOfRun`), `WorkflowLaunch.ts` (`superseded`) | 2026-11-30 |
| A budget stopper with no epoch goes by the raise alone | `workflows/WorkflowBudget.ts` | 2026-11-30 |
| A parent from before `cairn.subagent-parents` joins it at its next spawn | `subagents/BrainCap.ts` | 2026-11-30 |
| `StartFailure.at` keeps the literals `role` and `roles` that start and tell tasks persist | `subagents/SubagentTasks.ts` | 2026-12-31, renamed with a task version bump |
| `NodeRecord.thinkingLevel` optional, the row source's fallback to `effort` | `protocol/Workflows.ts`, `subagents/SubagentRows.ts` | 2026-12-31 |
| `QuestionsPayload.source` optional | `protocol/Policy.ts` | 2026-12-31 |
| `BudgetRaisePayload.title` and `spent` optional | `protocol/Policy.ts` | 2026-12-31 |
| `cairn.judge-runs` item's `changedAt` optional | `verdicts/GoalDocs.ts` | 2026-12-31 |
| `cairn.budget`'s `declares` and `raisesBefore` null on a document from before them | `brain/BudgetSources.ts` | 2026-12-31 |
| A checkpoint entry's `userEntryId` optional | `git/CheckpointCapture.ts`, `client-logic/DiffTree.ts` | 2026-12-31 |
| A thread row's phase 2 fields (`added()`: project thread, origin, lineage, tally, goal, spend, pending count) | `protocol/Shell.ts`, `shell/ThreadRows.ts`, `shell/ShellCommands.ts` | 2026-12-31 |
| `cairn.approvals` version 1 to 2 | `brain/CairnDocs.ts` (`migrateApprovals`) | a migration, kept while a store may hold version 1 |

The in-flight ones (a task, a pending record, a run) go once nothing that started before them can still be live. The history ones (a document or row kept for good) go with a migration that writes the field, which phase 3's stone fields in the same structs are the natural time for.

Decided on 2026-11-10 in the review fix program (package D7-shapes), under the user's instruction to go with the reviewer's recommendations (findings Q-5, C-6, C-9, V-19).
