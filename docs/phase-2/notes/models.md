# Phase 2 notes: role aliases, cost and the Codex login

Scope: which model runs each subagent and workflow node (`@worker`, `@judge`, `@verifier`), how a child returns a schema-checked result on each provider, what a response costs and how that becomes a meter and a hard budget, and the Codex login (ADR 0009). Written 2026-10-27 against Cairn at `e73dd9c`, pi 1.4.0 and the sources pinned below. Subagent dispatch is the "subagents" note's; a workflow's use of budgets inside a script is the "workflows" note's. This note provides the data and interfaces they call. Probes are in `/tmp/models-probe/` and are described in "Probes" so they can be rerun.

## Summary

1. **A role alias is a name in a table, resolved when the child is created, and the concrete model is what history keeps.** Fold's rule (`Session/Profiles.ts`, `SubagentEngine.ts` `resolveModelBinding`) fits pi-durable exactly: the dispatching commit calls `configure(tx, child.id, { model, thinkingLevel })`, so the child's `pi.agent` is the record. A scripted workflow holds only the name (`"@worker"`), never a model, so changing the table later changes new nodes and never rewrites a finished one.
2. **The table lives in `cairn.sqlite`, globally, in `ServerSettings`.** Built-in roles are `@worker`, `@scout`, `@judge` and `@verifier`; the user may add more (the council recipe needs several advisors on different families). Each binding is a primary model, a thinking level and an ordered fallback list used only at dispatch, never mid-run. A literal `provider/model[:thinking]` is accepted wherever an alias is.
3. **Check at Go, not at write time.** The brief card shows each role's resolved model, whether its provider is ready, and whether `@judge` and `@verifier` are on a different model family from `@worker`. An unbound role blocks the Go button; it does not fail a node later. v1 lost four children to a guessed model id (`research/09-v1-retrospective.md` line 13), so tool descriptions list role names (stable text, so the prompt cache survives) and an unknown spec returns an error result that lists the valid ones.
4. **Typed results: v1's 1 of 8 was an untyped tool, and a real schema fixes it.** v1's `submit_result` took `{additionalProperties: true}` with the schema only in the prompt. Reproduced on three OpenCode Go models (8 trials each): that shape passes 0 of 8 on every model (all three send arrays as JSON strings; pi-ai's validator then says only `files.0: must be object`). The same task with the schema on the tool passes 8 of 8 on the first attempt on all three, and the old shape plus a `prepareArguments` repair also passes 8 of 8. Claude through the bridge and Codex are not measured (see "Not verified").
5. **One accepted-but-wrong case needs the repair.** pi-ai's validator turns a JSON string where `string[]` belongs into a one-element array holding the JSON text, and accepts it (`["[\"pnpm check passed\"]"]`). The result tool's `prepareArguments` must parse such strings first, and the schema should be `additionalProperties: false`, because extra keys pass today.
6. **Schema rules fall out of three providers.** A flat root object (the bridge flattens root `anyOf`, `ClaudeMcp.ts:94-190`; Fold: "schema unions confuse models"), fields all required or nullable, no nested unions. Such a schema also qualifies for pi-ai's strict constrained sampling (`resolveJsonSchemaStrictSampling` returned `true` for flat and optional-field objects and `undefined` for root and nested unions), and pi-durable keeps `constrainedSampling` in the tool declaration (`pi-ai utils/transcript.ts:128`), so Codex and OpenAI-shaped models can be decoded against the schema.
7. **Cost: pi-ai records a dollar figure on every response, and it is a list price, not a bill.** `calculateCost` multiplies tokens by the catalog rate (`pi-ai models.ts:1236`). OpenCode Go and Codex are plans with limits, so their figure is notional; the bridge registers zero cost by design (`ClaudeModels.ts:180`, `ClaudeTokens.ts:39`); `opencode-go/beam-free` records `0` because it is free. A zero in `pi.usage` therefore means free, plan-billed or unpriced, and the meter must tell them apart.
8. **Spend is a derived cache, like the shell row.** `pi.usage` is per conversation and keyed by `provider/model`; pi-durable stores no total across conversations and warns against double counting a child (spec §12). A `SpendLedger` projector recomputes each conversation's rows from the `pi.usage` document on every commit that touches it and rolls up by scope with SQL. It can be rebuilt at boot, so a `kill -9` cannot double count. Calls that run outside any conversation (the title model, branch names, summaries) are in no `pi.usage`; they go to an idempotent `spend_events` table.
9. **Budgets are part of the brief and the workflow launch approval, enforced in three places, and honest about overshoot.** Dispatch refuses to create a child in an exhausted scope, `beforeTool` blocks the next tool call there, and a guard fiber aborts the scope's subtree when the ledger crosses the line. `beforeRequest` cannot block (an ordinary throw is "report, continue", spec §7.2), so the overshoot is at most one response per running child.
10. **Plan windows: Claude exists, Codex is portable, OpenCode Go has no reader.** MonoCode reads Codex windows from `https://chatgpt.com/backend-api/wham/usage` (`src-tauri/src/pi_usage.rs`); that is an unofficial endpoint and decodes to unknown on any shape change. pi-ai only classifies OpenCode Go's `GoUsageLimitError` and "Monthly usage limit reached" as terminal (`utils/retry.ts:7-20`); no windows can be read, so the meter says "limits unknown" for it.
11. **The Codex login does not exist in Cairn yet, and the fix is a store plus a device-code flow.** `CairnCredentialStore` hides `openai-codex` and refuses every OAuth entry (`CredentialStore.ts:31-38,142-147`); `cairn.sqlite` has no credentials table. pi's `auth.json` holds an `openai-codex` OAuth entry (access token not yet expired, 2026-10-30), but ADR 0009 forbids using it, and a phase 1 note says the Codex login is revoked (not verified here). pi-ai ships a headless device-code flow (`openai-codex.ts:341-358`) that fits "from any device".
12. **Provider health is needed before aliases can fall back.** Port Ultimate's rule (`extensions/health/store.ts`: one auth failure, or three transient failures within five minutes with no success between, turns a provider failing) over `RunTerminal` failures, and extend `classifyRunFailure`, which today recognises only the Claude quota text (`RunFailure.ts:12`), to Codex's "You have hit your ChatGPT usage limit" and OpenCode Go's limit errors.

## Facts with evidence

### Sources and pins

| Source | Pin | Read for |
| --- | --- | --- |
| Cairn | `e73dd9c` (main) | models, usage, settings, protocol, bridge |
| pi (`earendil-works/pi`) | `v1.4.0`, `4a080252` at `/tmp/pi-src`; installed 1.4.0 | pi-ai catalog, `calculateCost`, OAuth, validation; pi-durable `docs/spec.md` §7, §8.6, §12, `test/examples/23-subagent-background.ts` |
| Fold (`humanlayer/fold`) | `4bd8c58` at `/tmp/fold` | `Session/Profiles.ts`, `Subagents/SubagentEngine.ts` |
| Ultimate (`HazAT/ultimate`) | `8b26338` at `/tmp/ultimate` | `agents/*.md`, `extensions/subagents/README.md`, `extensions/health/store.ts`, `lib/rate-limit.ts` |
| pi-subagents (`nicobailon`) | `1a80e24e` at `/tmp/pi-subagents` | `docs/models.md` |
| HumanLayer | `f16f286`, partial clone at `/tmp/models-probe/humanlayer` | `apps/docs/reference/subagent-models.md`, `riptide-api/.../usage/record.effect.ts`, `lib/reliable-language-model.ts` |
| MonoCode (`hardbeat920`) | `26465c6` at `/tmp/monocode` | `src-tauri/src/pi_usage.rs` |
| t3code | `fe27e8e3` via `docs/phase-2/notes/t3code-nightly.md` | `delegate_task` takes a `modelSelection`; plan windows only, no money |
| v1 | `research/09-v1-retrospective.md`, `spikes/02-providers/NOTES.md` | the 1 of 8 and the unrun Codex spike |

### What exists in Cairn

- **Catalog and credentials.** `PiModelSource` builds pi's `ModelRuntime` over `CairnCredentialStore` (`PiModelSource.ts:483-505`) and registers `ExtraProviders` (the bridge) at `:77`. The store reads pi's `auth.json` per call, passes literal API keys only, hides `anthropic` and `openai-codex`, and its `modify` and `delete` reject (`CredentialStore.ts:31-38,100,142-147,200-208`). The provider panel says "Cairn does not use pi's Codex login; its own Codex sign-in is not available yet" (`PiModelSource.ts:224`). `ProviderStatus.credential` is `api-key | subscription | none` (`protocol/Models.ts`), and the bridge is the only `subscription`.
- **`auth.json` today, by kind only.** `opencode-go` is an `api_key`; `anthropic` is an `api_key` (neither Anthropic prefix; ADR 0002 hides it anyway); `openai-codex` is an `oauth` entry whose access token expires 2026-10-30. Cairn has no OAuth store: `cairn.sqlite` tables are `executor_grant`, `settings`, `threads`, `projects` and the launch, push, receipt and attachment tables. A phase 1 note (`notes/client.md:234`) says the Codex login is revoked and `parity-review.sh` uses `opencode-go/gpt-6-luna` for that reason; I did not test the token.
- **Settings.** `ServerSettings` has four fields (`protocol/Settings.ts:9-18`), stored as one JSON row per key (`SettingsStore.ts`). `titleModel` is a `ModelRef` or none. There is no role table, no budget and no price.
- **Usage.** `UsageFeed` streams `ProviderUsage` (windows with `used: Option`, `resetsAt`, `exhausted`) and today only the bridge fills it (`usage/UsageFeed.ts`). `ClaudeUsage` merges the probe and `rate_limit_event`s and already has a `monthly_spend` percent window (`ClaudeUsage.ts:496`). The composer meter shows only for `claude-bridge` (`apps/web/src/composer/UsageMeter.ts`, `BRIDGE_PROVIDER`). `UsageUpdated` carries input and output tokens only (`CommitFeed.ts:150-165,361-370`); no cost reaches any client.
- **Run failures.** `classifyRunFailure` returns `usage_limit` only for text starting `Claude plan quota exceeded` (`RunFailure.ts:12,39`), then `transport_error` or `provider_error`. A Codex or OpenCode Go limit would read `provider_error`.
- **Stream guard.** Every non-bridge stream passes `guardModels` (`PiModelSource.ts:587`, `StreamGuard.ts`): 1,000 whitespace characters in tool arguments abort as retryable.
- **Spike 9** (`spikes/9-http-idle/NOTES.md`): HTTP streams cut at 301.9 s of silence, Codex's default WebSocket does not. No dispatcher change; a Codex login adds no new timeout work.

### What each provider records and costs

Measured by `usage-shape.mjs` (one 3-word call per API shape) and read from the installed catalog (`pi-ai/dist/providers/data/*.json`).

| Provider (api) | Billing | `usage.cost` | Plan windows | Notes |
| --- | --- | --- | --- | --- |
| `claude-bridge` (SDK query, tools over MCP) | Claude plan | always `0` (`ClaudeTokens.ts:39`), tokens real | probe plus `rate_limit_event` (`ClaudeUsage`) | SDK `total_cost_usd` is a list-price estimate, "do not show as spend" (`notes/bridge.md:308`). Catalog price of the same id is in pi-ai's `anthropic` data (`claude-opus-5-5` 4 and 20 per Mtok, `claude-sonnet-5-5` 2 and 10, `claude-haiku-5-5` 0.1 and 0.5). |
| `opencode-go` (`anthropic-messages`, `openai-completions`, `openai-responses`, `google-generative-ai`) | Go plan with rolling, weekly and monthly limits and an overflow balance (`retry.ts:7-20`) | catalog list price, nonzero (`claude-haiku-5-5` 16 in and 10 out recorded `0.0000066`); `beam-free` and the other `-free` ids record `0` | none readable | needs the `x-opencode-session` header, which `sessionId` supplies (the first probe run got `400 MissingSessionID` without it). Holds `gpt-6-luna` and `claude-haiku-5-5`, so two families are reachable here. |
| `openai-codex` (`openai-codex-responses`, SSE or WebSocket) | ChatGPT plan | catalog price with tiers over 272k input, times 0.5 flex or 2 priority (`openai-codex-responses.ts:624-651`) | `wham/usage` (unofficial), `usage_limit_reached` errors carry `plan_type` and `resets_at` (`:1625-1635`) | seven models in the catalog (`gpt-6-luna` 0.1 and 0.5 per Mtok up to `gpt-6-astra` 10 and 50); ADR 0009 says only `gpt-6-luna` is available on this login. |
| metered key providers (`openrouter`, `openai`, ...) | pay per token | list price, a real bill within rounding | none | none configured today. |

`Usage` also carries `reasoning` (a subset of `output`), `cacheWrite1h` (Anthropic only) and `totalTokens` (`pi-ai types.ts:459-481`). A tool result may carry its own `usage`, kept in `pi.usage.tools`.

### pi-durable: where usage lives

- `pi.usage` per conversation: `models` keyed `provider/modelId` and `tools` keyed by tool name, written in the same commit as the entry (spec §8.6, lines 4404-4437). A fork starts at zero. `Harness.usage()` sums all conversations; "other totals, such as an ownership subtree, are application sums over `scanConversations()`" (`ConversationQuery.ownerConversationId`, `types.ts:768`). Failed and aborted compaction attempts count.
- Footgun: "a tool that runs an owned conversation must not report that conversation's usage in its result" (spec §12, line 5499). Our delegating tools set no `usage` on their results.
- `ToolRegistration` is pi-ai's `Tool` plus `replay`, `prepareArguments` ("repair arguments models commonly get wrong ... such as a JSON string where an array belongs", `harness/types.ts:304-313`), `structuredOutputSchema` and `callers`. Invalid arguments become an `invalid_arguments` error result with the validator's text and the run continues, so the model's next call is the retry (spec lines 3440-3454, 4336-4341). `control.terminate` ends the run when every result in the round asks for it (spec lines 3586-3590).
- Hooks: `beforeRequest` is a replacement chain and "ordinary throw: report, continue"; `beforeTool` is the only hook that blocks (spec §7.2). `afterResponse` observes every provider message.
- A child is `tx.createConversation({ ownership: { kind: "task", taskId } })` then `configure(tx, child.id, { model, thinkingLevel, extensions, tools, cwd, instructions })` (example 23, lines 187-196; `AgentState` in `harness/types.ts:412`). The model is a `ModelRef` of names, not an object.

### How the sources pick a model per role

| Source | Mechanism | Take or leave |
| --- | --- | --- |
| Fold | `ProfileRole = orchestrator \| smart \| fast`, a session-wide map; `defineSubagent({ model: 'smart' })`; resolved at each dispatch or resume; `orchestrator` falls back to `smart`; session start dies if a roster names an unbound role; "role bindings resolve to concrete models before any log row exists" (`Profiles.ts`, `SubagentEngine.ts:219-222,275,706`) | **Take**: resolve at dispatch, record the concrete model, check coverage up front. **Leave**: re-resolving on a later resume (a swap logs a model change). Cairn keeps a child on its model, because a Claude session resumes natively and a swap costs a cache write (ADR 0018). |
| Ultimate | model pinned in each agent's frontmatter (`worker` is `openai-codex/gpt-6.1-sol` with `fast: true`, `scout` and `watcher` are `gpt-6-luna`, `designer` is `claude-code/claude-opus-5-5`, `reviewer` inherits); overlays by name; reports `Returned model: provider/model` from the stored assistant message, "not the configured profile or self-report" (`extensions/subagents/README.md:13,17,92`) | **Take**: the returned model comes from the answer, not the table. A `fast` flag is a Codex priority tier at 2x cost. |
| pi-subagents | precedence per-run, provider-scoped role, role override, frontmatter, default, parent; `model: inherit`; "each launch resolves one model", errors are returned, never retried on another model (`docs/models.md`) | **Take**: no mid-run failover. Its four tiers (fast workhorse, standard, deep but bounded, taste and intent) are a good default table. |
| HumanLayer | fixed model family per sub-agent role, `inherit` for one; an `alias -> primary/secondary` reliable model for server calls; usage recorded append-only, idempotent on `(session, report_key, model)` (`record.effect.ts`) | **Take**: an idempotency key on usage that does not come from a conversation. |
| MonoCode | reads Codex windows from `wham/usage` with the pi OAuth token and `ChatGPT-Account-Id`; never refreshes ("pi owns token rotation") | **Take** the endpoint and field names; **leave** the no-refresh rule, since ADR 0009 makes Cairn the owner of its own token. |

### Typed results: what failed in v1 and what I measured

v1: `submit_result` was `Type.Object({}, {additionalProperties: true})` with the schema in the prompt, 7 of 8 failed on `opencode-go/claude-haiku-5-5` ("the model sent arrays as JSON strings"), and the parent guessed model ids (`research/09`, line 13).

Offline (`typed-offline.mjs`, pi-ai 1.4.0 `validateToolArguments` against a flat TypeBox result schema):

| Input | Verdict |
| --- | --- |
| valid; `"4"` for an integer; `null` for an optional field; a bare string for `string[]` | accepted, as intended |
| `files` (array of objects) as a JSON string | rejected with `files.0: must be object` |
| `evidence` (`string[]`) as a JSON string | **accepted, as `["[\"pnpm check passed\"]"]`**, which is wrong data |
| extra property | accepted and kept |
| missing required, bad enum, out of range | rejected with a path and reason |

Live (`typed-live.mjs --n=8`, three OpenCode Go models, up to two attempts with an `invalid_arguments` tool result between, strict check = schema plus counts of files, evidence and confidence):

| Model (api) | Schema on the tool | Open tool, schema in the prompt (v1) | Open tool plus `prepareArguments` repair |
| --- | --- | --- | --- |
| `claude-haiku-5-5` (`anthropic-messages`) | 8/8 first attempt | 0/8, 0/8 within two | 8/8 |
| `deepseek-v4.1-flash` (`openai-completions`) | 8/8 | 0/8, 0/8 within two | 8/8 |
| `qwen3.8-flash` (`anthropic-messages`) | 8/8 | 0/8, 0/8 within two | 8/8 |

All 72 trials (up to two calls each) cost about $0.021 at list price. In v1 mode the two-attempt retry did not help: the error text (`files.0: must be object`) does not name the real mistake. Samples are small (8), one task, one prompt; read them as a reproduction of the v1 failure and of its fix, not as a pass rate.

Strict mode (`strict-offline.mjs`): `resolveJsonSchemaStrictSampling` is `true` for a flat object with all fields required, with an `Optional` field, and with a nullable field; `undefined` (non-strict fallback) for a root union, a nested union and an open object.

## Design for Cairn

Terms: a role alias (`@worker`) is a name in the role table; a binding is what it points to; a dispatch is the commit that creates a child conversation. Module paths are under `apps/server/src` unless they start with `packages/`. Placement of the delegating tools is the subagents note's; I name the interface they call.

### 1. Role aliases

**Schema** (`packages/protocol/src/Roles.ts`, then `ServerSettings.roleBindings`):

- `RoleName`: `@` plus 1 to 24 of `[a-z0-9-]`. Built-ins that always exist: `@worker` (writes in its own worktree or stone), `@scout` (reads, searches, summarizes; cheap, read-only tools), `@judge` (judges a result against criteria), `@verifier` (drives a project's verification recipe, phase 4).
- `RoleBinding`: `{ model: ModelRef, thinkingLevel: Option<ThinkingLevel>, fallbacks: ReadonlyArray<ModelRef>, note: Option<DisplayText> }`.
- `RoleSpec` (what a tool or script passes): `"@worker"`, `"@worker:high"` or `"provider/modelId[:level]"`, parsed by one function. An alias may not point to another alias.
- `ResolvedRole`: `{ spec, role: Option<RoleName>, model: ModelRef, thinkingLevel, via: "primary" | "fallback" | "literal", skipped: ReadonlyArray<{ model, reason: "missing_credential" | "unknown_model" | "limited" | "failing" }>, family, priced: boolean }`.

**Storage.** One more row in the `settings` table, `roleBindings`, the whole record as JSON, so `settings.get` and `settings.update` and their client plumbing carry it (`SettingsStore.ts` pattern). A row that no longer decodes reads as the defaults. First boot seeds the table from the user's stated tiering (kickoff "How to work": Sonnet 5.5 high for reading, Opus 5.5 medium for implementing); the user edits it in settings. Project-level overrides are not in phase 2 (open question 2).

**Resolution** (`models/RoleAliases.ts`, service `RoleAliases`): `resolve(spec) : Effect<ResolvedRole, RoleError>` walks `[model, ...fallbacks]` and takes the first that (1) is in the catalog and its provider is `ready` (`PiModelSource.providers`), (2) is not marked limited or failing by `ModelHealth`, and (3) for the bridge, is not behind a spent plan window (`ClaudeUsage` windows with `exhausted`, the `usage_limit` signal). `check(specs) : Effect<ReadonlyArray<RoleCheck>>` runs the same walk for the brief card without side effects. Pure helpers: `models/ModelFamily.ts` (provider and id to `anthropic | openai | google | other`, after Fold's `Model/ModelFamily.ts`), used for the rule below.

**When it runs.**

- The brief (ADR 0026) carries role specs, not models. When the brief is proposed, `check` fills the card (resolved model, readiness, family, list price per Mtok). At Go, the answering commit and the dispatch resolve again and write the result into the child in one commit: `configure(tx, child.id, { model, thinkingLevel })` plus a `cairn.dispatch` item on the parent's document (`role`, `spec`, `via`, `skipped`, the resolved model). The Go answer approves a role, not a model. The delegating tool is the waiting tool of ADR 0013: it wakes on the answer, resolves, then commits the dispatch. If the model differs from the card's preview (the table moved while the brief waited), the dispatch record keeps `previewed` beside `resolved` and the child's row says "ran on X, preview said Y".
- A workflow script passes `agent({ model: "@judge", ... })`. The deterministic sandbox sees only the string. The `agent` tool resolves at call time, so a restart between script start and node dispatch uses the table as it is then, and a replay returns the journaled result without resolving.
- Replay safety: resolution happens before the dispatching commit and is not stored anywhere until that commit. After a crash before it nothing exists and the rerun resolves again (correct: nothing ran). After it, the tool finds its child by owning task (ADR 0012) and never resolves. A later `send` to a child never re-resolves; the child keeps its model for life, as any thread does.

**Rules.**

- `@judge` and `@verifier` should not share `@worker`'s family ("a verifier on another model family", kickoff). `check` marks a violation as a warning on the card, not a block, because the user has one Claude plan and a small catalog.
- Fallbacks are tried at dispatch only. No failover mid-run (pi-subagents; a provider switch mid-conversation is a bridge divergence, ADR 0018, and costs a cache write). A fallback taken is recorded (`via: "fallback"`, `skipped`) and shown in the node's row.
- Tool descriptions for `agent`, `subagent` and `stone` list role names, not models: the declaration is in the cached prompt, and "unstable prompt text defeats caching" (spec §12). `roles` (a read-only tool, also a slash command) returns names with their current model, readiness and price. An unknown or unready spec returns an error result that lists the valid specs, so a parent's guess costs one call instead of four children.
- `thinkingLevel` is clamped with the existing `clampThinking` (`PiModelSource.ts:158`).

**Provider health** (`models/ModelHealth.ts`, after Ultimate `extensions/health/store.ts`): per provider, `lastOk`, `lastAuth`, the last three transient failures and a sanitised error word list (fixed vocabulary, so no credential text ever reaches storage). Failing = an auth failure newer than the last success, or three transient failures inside five minutes with no success between. Fed from `RunTerminal` failures and `afterResponse`. In memory plus a row in `cairn.sqlite` so a restart does not forget a revoked login. `classifyRunFailure` grows a pattern for Codex (`You have hit your ChatGPT usage limit`, with the minutes it prints) and OpenCode Go (`GoUsageLimitError`, `Monthly usage limit reached`, `available balance`) so those become `usage_limit`, show the Hold "Limited" and mark the provider limited until the reset (Codex) or until the next success (OpenCode Go).

### 2. Typed results

**Mechanism** (`brain/ResultTool.ts`, extension `cairn.results`, installed only in children whose brief names a result schema):

- One tool, `submit_result`, whose `parameters` are the node's schema made strict-friendly. Root: `{ result: <node schema>, divergence: string }` with `additionalProperties: false`. `divergence` is required: how the work differs from the brief (Ultimate's worker report ends `Divergence: ... or None.`; the backlog asks for it). The node schema arrives as JSON Schema from a script (`Type.Unsafe`) or as TypeBox from a Cairn recipe. Cairn rejects at brief time a schema whose root is a union or whose depth or size is over a cap, and says so, instead of discovering it on a provider.
- `constrainedSampling: { type: "json_schema", strict: "prefer" }`. Providers whose API supports strict function tools (Codex, `openai-responses`, `openai-completions` models that allow it) decode against the schema; others ignore it. It stays `prefer` so a schema that does not qualify still works.
- `prepareArguments` parses a JSON string where an array or object belongs (the measured v1 failure and the silent wrap of `string[]`). Pure, as the contract requires.
- Attempt 1 is the first call. A failed validation returns `invalid_arguments` with the path and reason, and the same run continues, so attempt 2 is the model's next call. No new run, no new brief. The cap is two: a `beforeTool` hook on `submit_result` counts earlier failed results in the child's transcript and blocks the third with "the result was rejected twice; reply in plain text with what you found". The attempt count is derived from the transcript when read (calls to `submit_result` up to the first valid one), never kept as a second counter.
- On success the tool writes the validated value to a child document `cairn.result` (large values live in documents, spec §12 "Large terminal results"), returns it as `structuredOutput`, and sets `control.terminate`. The delegating tool reads that document. A child that ends without a valid result is a result, not a failure of the parent (Fold): the dispatcher's reporter gets one nudge ("call submit_result"; it counts as attempt 2 if attempt 1 was never made) and then closes with outcome `error`, `errorMessage` set exactly then, and the child's last text kept as `resultText`.
- The envelope the parent sees (Fold's `SubagentResult` plus Cairn's): `{ agentId, threadId, outcome: completed | stopped | interrupted | error, role, returnedModel, turns, resultAttempts, result: Option<Json>, divergence, errorMessage: Option<string>, resultText, spend }`. `returnedModel` is read from the child's last stored assistant message (Ultimate), not from the table. `spend` is the child's own subtree (section 3), not a field the tool reports to pi-durable.

**Per provider.** Claude through the bridge gets the tool over the in-process MCP server with the JSON Schema verbatim (root combinators flattened, which a flat root never needs); pi-durable validates the call as for any tool. Codex gets strict decoding when the schema qualifies. OpenCode Go's three API shapes get the schema as an ordinary function tool; measured above. The bridge's one-shot path serves no tools (`ClaudeOneShot.ts`), so a typed result is never asked of a one-shot.

### 3. Spend: ledger and meters

**Price** (`models/ModelPrice.ts`, pure): `priceOf(model) : Priced { rates, tiers } | Unpriced`. A bridge model borrows the rates of the `anthropic` catalog entry with the same id (the bridge registers zero; the entry is still in pi-ai's data), tagged `basis: "list_on_plan"`. A model whose catalog rates are all zero is `Unpriced`, shown as "no price listed", never `$0.00`. `basis` per provider is a small code table: `claude-bridge` `list_on_plan` with plan windows, `opencode-go` and `openai-codex` `list_on_plan`, anything with a key `metered`. Real money appears in two places only: `metered` providers (none today) and the Claude `monthly_spend` window; stones' compute cost is a phase 3 `compute` part reserved in the schema.

**Schema** (`packages/protocol/src/Spend.ts`):

- `Tokens { input, output, cacheRead, cacheWrite, reasoning: Option }`.
- `Spend { tokens: Tokens, listMicros: int (millionths of a dollar, summed over priced models), unpricedTokens: int, unpricedModels: string[], byModel: Record<"provider/model", { tokens, listMicros: Option }>, compute: Option<{ seconds, micros }> }`. A figure with `unpricedTokens > 0` renders as "at least $0.42, plus 120k tokens with no price", so unknown is never shown as zero.
- `ProviderUsage` gains `reading: "read" | "unreadable" | "unsupported"`, so an empty `windows` list stops meaning two things (`protocol/Usage.ts`).

**Ledger** (`usage/SpendLedger.ts`, a fiber beside the shell projector, coalescing at 50 ms):

- Table `spend_totals(thread_id, model_key, input, output, cache_read, cache_write, reasoning, list_micros NULL, priced INTEGER, updated_seq)`. On each commit of a `pi.usage` document (CommitFeed already receives `change.value`, `CommitFeed.ts:361`), replace that thread's rows from the document in one transaction. Derived and idempotent: a replayed or doubled event writes the same rows. Boot reconcile recomputes every thread's rows from `inspect()` and the documents, the way the shell projector rebuilds rows.
- Table `spend_events(source, key, model_key, thread_id NULL, tokens..., list_micros NULL, at, PRIMARY KEY (source, key, model_key))` for calls outside a conversation: `ModelSource.completeSimple` takes a `source` and `key` and inserts with `INSERT OR IGNORE`, after HumanLayer's `(session_id, report_key, model)`. The title model and branch naming are today unmetered anywhere.
- Roll-up: `rollup(scope) : Effect<Spend>` with scope `thread` (a thread and its lineage subtree), `goal`, `workflow_run`, `all`. Lineage comes from the subagents note's thread lineage; workflow membership from the workflows note's ledger. Both are joins on `thread_id`; this module owns no membership.
- Estimate (`estimate(plan)`): per role, the median and 90th percentile of completed children's spend, grouped by `cairn.dispatch.role`. With fewer than five samples the card says "no estimate yet" (unknown) and the launch approval offers "run on 1 item", whose measured spend then seeds the estimate. No made-up default per-node figure.

**Meters.** The existing plan-window stream stays `usage.subscribe`. Codex joins it through `usage/CodexUsage.ts`: `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access>` and `ChatGPT-Account-Id`, decoding `rate_limit.primary_window` and `secondary_window` (`used_percent`, `limit_window_seconds`, `reset_at`), read only while watched and on the bridge's 60 s stale and 5 minute cadence, with a Schema decode so any other shape is `unreadable`. OpenCode Go reports `unsupported` (it has no windows to read; `unreadable` is for windows that could not be read). A spent window or a classified limit sets `exhausted`. Spend travels on the shell stream: the thread row gets `spend: Option<Spend>` (coarse: tokens and `listMicros`) updated by the projector, and `spend.get { scope, byModel }` is a unary RPC for the detail panel. UI draws, from scratch in the design pass: a plan-window bar for plan providers, a "≈ $ at list price" figure with the unpriced note, and budget bars.

### 4. Budgets

- **Where they come from.** A `Budget { maxListMicros: Option, maxTokens: Option, planGuard: Option<{ provider, windowId, maxUsedFraction }>, warnAt: 0.8 }` is a field of the brief payload (the lessons page: a brief has "a budget") and of the workflow launch approval; the server setting `defaultBudget` applies when none is given. The approval document is the authority (ADR 0001, 0013); the ledger keeps an in-memory map `scope -> limits` rebuilt at boot from `inspect()`. Raising a budget is a new approval ("Raise to $X?"), answered like any, with `decidedBy` and a reason (ADR 0026).
- **What a dollar budget can bind.** Priced tokens only. A workflow whose `@worker` runs on the bridge is bound by `maxTokens` and `planGuard` for that role; the launch card says which roles each limit covers, so a $5 budget over a Claude-heavy workflow never looks like it protects the plan.
- **Enforcement**, three points, in order of cheapness. (a) Dispatch: `Budgets.admit(scope, estimate)` runs in the delegating tools before they create a child and refuses with `BudgetExhausted { scope, limit, spent }` (a result the parent sees, replay-safe because it creates nothing). (b) `beforeTool` in every conversation of an exhausted scope blocks the next tool call with the same text, so a run winds down without a model call it cannot afford. (c) `BudgetGuard`, a fiber on ledger updates, aborts the scope's subtree (`conversation.abort({ background: true })` reaches past background owners, example 23) when spend crosses the limit, writes a `cairn.notice` ("Stopped at $X of $Y"), sets `spend.budget: exhausted` on the row and sends a push. Aborted nodes close with outcome `stopped` and reason `budget`.
- **Overshoot is bounded and shown.** Spend lands only when a response completes, and `beforeRequest` cannot refuse a request, so the most a scope can pass its line by is one response per running conversation, capped by each request's `maxTokens`. The card says "may pass by up to one response per running child". The bridge's plan-window guard (`planGuard`) is checked on the 5 minute probe and on each `rate_limit_event`, and already shrinks the slot count above 80% weekly use (`ClaudeUsage.ts:83,776`).

### 5. The Codex login

- **Store** (`models/OAuthStore.ts`, migration `0007`): table `oauth_credentials(provider_id PK, credential_json, signed_in_at, refreshed_at, updated_at)`. Tokens stay out of logs and events (`event` names only). `~/.local/share/cairn` is `0700`. A composite pi-ai `CredentialStore`: API keys from pi's `auth.json` as today (read-only), OAuth credentials from this table. `modify(provider, fn)` is what pi-ai calls under its refresh lock (`resolve.ts` `refreshStoredOAuthCredential`); it runs `fn` inside an exclusive hold so a rotated refresh token is persisted before anyone else reads it (ADR 0009's reason). One holder: the `flock` child of `ExecutorGrant.ts` (a second lock file, `~/.local/state/cairn/oauth.lock`). A brain that does not hold it, such as a judge brain, reports Codex as unavailable instead of refreshing.
- **Login** (`models/CodexLogin.ts`): `Models.login("openai-codex", "oauth", interaction)` with pi-ai's device-code method selected (`openaiCodexOAuth.login`, method id `device_code`, `openai-codex.ts:341-358,409-428`). The interaction maps `notify({ type: "device_code", userCode, verificationUri, expiresInSeconds })` to a `login.progress` stream message and a settings-page card ("Open https://auth.openai.com/codex/device and enter ABCD-EFGH"), so it can be completed from the phone. The browser flow needs port 1455 on the same host as the redirect (`REDIRECT_URI`, line 26), which does not suit a Beelink with the browser on another device. Device-code login times out after 15 minutes (line 31). RPCs: `providers.login.start { provider }`, `providers.login.cancel`, `providers.logout`. `CredentialStore.ts` stops hiding `openai-codex`; its panel text changes to the sign-in state.
- **Wizard stage** (`ops/wizards/phase-2.sh`, one stage "Sign in to Codex"): open the settings card on any device, press Sign in, enter the code, confirm the account shows and one `gpt-6-luna` call answers. Only the user can do it. Not touching pi's own `openai-codex` entry is a judged rule (`judges/pi-readonly.sh` already runs).
- **Fallback if the login is not available** (kickoff: another pi-supported provider the user has). The third typed-result provider becomes `opencode-go/gpt-6-luna`, which uses a different API shape (`openai-responses`, strict function tools) from the other OpenCode Go models tested, with the target restated as "Claude through the bridge, OpenCode Go on three API shapes, and Codex when its login exists". That is the user's call (open question 1), and the judge keeps a Codex case that skips with the reason printed, not silently.

### Durability: `kill -9` at each step

| Step | Crash point | After restart |
| --- | --- | --- |
| Role resolution | before the dispatching commit | nothing exists; the rerun resolves again |
| Dispatch commit (create child, `configure`, `cairn.dispatch`) | atomic in pi-durable | either no child or a child with its model; the tool finds it by owning task |
| `submit_result` | mid-validation | no intent recorded; the model's call is retried by pi-durable. After the result commit: `cairn.result` exists, the tool is `replay: "safe"` (pure over its arguments) and finds the value. |
| Spend projector | mid-update | a derived cache; boot reconcile recomputes every thread from `pi.usage` |
| `spend_events` insert | around the model call | key `(source, key, model)` makes a repeated call after a crash write once; a call whose answer was lost writes nothing (spend is lost, never doubled) |
| Budget guard | after crossing, before abort | at boot the ledger recomputes, the guard sees the crossing and aborts again; abort is idempotent |
| Budget raise | approval pending across restart | an approval, so it survives (ADR 0013) |
| OAuth refresh | after the provider rotated the token, before the row is written | the lock holder persists in the same hold; a `kill -9` between the response and the write strands the grant and needs a new sign-in. This window is the provider's, not removable; the login card is the recovery, and ADR 0009 already accepts one holder. |
| Device-code login | mid-poll | nothing stored; the code expires; start again |

### Protocol additions

`models.roles.get` is part of `settings.get`; `settings.update` accepts `roleBindings`; `roles.check { specs }` (unary, for the brief card); `spend.get { scope }` (unary); `thread.spend` on the shell row; `ProviderUsage.reading`; `providers.login.start`, `providers.login.cancel`, `providers.logout`; `login.progress` (a stream message of the three auth events: `device_code`, `auth_url`, `progress`). Glossary entries to add with the change: **Role alias**, **Binding** (or fold into the alias entry), **Spend**, **Budget**, **List price** (a catalog price used as an estimate for plan-billed models), and a line under **Plan window** that a provider whose windows cannot be read is `unreadable`.

## Judges

- **J-roles (conformance and unit).** `RoleAliases.test.ts`: primary used when ready; fallback when the primary is limited, failing or missing a credential, with `skipped` filled; literal specs pass through; an unbound role makes `check` fail; the family warning; an alias pointing at an alias is rejected; the same table read at two times resolves differently while a finished child keeps its model. A conformance scenario (the subagent scenarios belong to the subagents note) asserts the child's `pi.agent.model` equals the dispatch record. Mutation check: a resolver that reads the table at script-write time fails the "alias changed between write and dispatch" scenario.
- **J-typed (`judges/typed-results.ts`, a kept judge, cents).** For each provider, N=8 trials of the probe task through a bare pi-durable harness with the real `cairn.results` extension (pattern of `judges/claude-live.ts`): OpenCode Go on `claude-haiku-5-5` (`anthropic-messages`), a `deepseek` or `qwen` model (the other shapes) and `gpt-6-luna` (`openai-responses`); Claude through the bridge on `claude-haiku-5-5`; Codex on `gpt-6-luna` when a login exists. Pass: every trial's result validates within two `submit_result` calls, counted from the transcript, and the envelope's `returnedModel` equals the dispatched model. Controls that must fail: the v1 open tool (expected 0 of 8 on OpenCode Go) and a schema with a root union. A skipped Codex case prints why and fails the target's "three providers" line until the user decides on the fallback.
- **J-validator (`ResultTool.test.ts`).** The offline table above as a test, including `evidence_as_json_string` repaired to the right array, an extra key rejected, and the third failed call blocked.
- **J-spend (`SpendLedger.test.ts`).** Replaying the same `pi.usage` commit twice leaves the totals unchanged; a fork starts at zero and is not double counted; a bridge model shows tokens and a list-price equivalent labelled `list_on_plan`; an unpriced model adds to `unpricedTokens` and leaves `listMicros` alone; boot reconcile after deleting `spend_totals` rebuilds identical rows; `spend_events` with a repeated key writes once.
- **J-budget (kill script, `judges/budget-kill.ts`, after `judges/durability.ts`).** Fan out ten faux children each costing a fixed list price under a budget of four children's worth; the guard stops the scope within one response per running child of the line; `kill -9` while the guard is aborting; after restart no child restarts, the notice appears once, the row reads exhausted, and the total does not double. A second run raises the budget by an approval answered after the restart and the children can be retried.
- **J-codex (behaviour script + `judges/pi-readonly.sh`).** A fake OAuth server (device-code endpoints and a token endpoint that rotates the refresh token) drives `CodexLogin`: login, refresh under the lock persisting the new token before release, a second brain refusing to refresh, `kill -9` during the poll leaving nothing stored. Real login: the user's wizard stage, then `gpt-6-luna` answers once. `pi-readonly.sh` shows pi's `auth.json` untouched.
- **J-health (`ModelHealth.test.ts`).** One auth failure turns a provider failing until a success; three transient failures within five minutes do; two do not; the stored error text contains only the fixed vocabulary.

## Proposed ADRs

1. **Role aliases resolve when the child is created, and the concrete model is what is kept.** Scripts and tools hold `@worker`; the dispatching commit writes the model into the child's `pi.agent` and a dispatch record; a child never re-resolves; fallbacks are tried at dispatch only. Hard to reverse because workflow scripts, briefs and recipes will be written against the names. Gate: J-roles, including the changed-table scenario, and `check` blocking Go on an unbound role.
2. **Dollar figures are list prices, labelled, and unknown is not zero.** All three providers the user has are plans, so every dollar on screen is `list_on_plan` unless a provider is `metered`; a model without a price counts tokens only; a dollar budget binds priced tokens and the card says which roles it covers. Surprising and a real trade-off against showing tokens only. Gate: J-spend and J-budget.
3. **Cairn owns OAuth credentials for the providers it logs in to, in `cairn.sqlite`, one holder at a time.** ADR 0009 decided Cairn owns the login; this records the storage and the lock (extending the Executor grant's flock), the device-code flow, and that a brain without the lock reports the provider unavailable. Status: `proposed` until the user has completed a real Codex login and the rotation test passes. Gate: J-codex.

The typed-result mechanism (real schema on the tool, repair, two attempts, strict `prefer`) is not an ADR: it is cheap to change behind `cairn.results`.

## Open questions for the user

1. **The third provider for the typed-results target.** Options: (a) do the Codex device-code login (a two-minute wizard stage) and keep the target as worded; (b) accept `opencode-go/gpt-6-luna` on its `openai-responses` shape as the substitute and reword the target. Recommend (a), with (b) as the recorded fallback so the build never waits on it.
2. **Where role bindings live.** Options: (a) global only, with a per-launch override on the workflow approval; (b) also a per-project override in `.cairn/roles.json`. Recommend (a) for phase 2: the user runs one set of plans, and (b) is additive later.
3. **Default table.** Recommend `@worker` Opus 5.5 medium, `@scout` Sonnet 5.5 high (the kickoff's reading preference), `@judge` `opencode-go/gpt-6-luna` and `@verifier` Codex `gpt-6-luna` once signed in (fallback the same OpenCode Go model), all on the user's confirmation, since the kickoff asked to re-ask the model preferences in phase 0.
4. **Show Claude tokens as a list-price equivalent?** Options: (a) yes, labelled "at API list price", so one dollar budget spans every role; (b) tokens and plan windows only for the bridge. Recommend (a); `notes/bridge.md:308` is right that it is not spend, and the label says so.
5. **Hard stop, or ask first, when a budget is reached?** Options: (a) abort the subtree and offer a raise as an approval; (b) pause new dispatches and let running children finish. Recommend (a) for a workflow, (b) for a goal thread's own subagents, because a half-finished writer is worse in a goal than in a fan-out; the guard takes a `mode` per scope.
6. **Is the unofficial Codex usage endpoint acceptable?** It is what MonoCode uses and is not documented. Recommend yes, behind a Schema decode, with "unreadable" on any change.

## Risks

- **The Codex login may not be obtainable, or the token pi holds may be revoked.** Mitigation: question 1; every Codex-dependent judge skips visibly.
- **Rotation loss.** A crash between the provider's rotation and our write strands the grant. Same exposure as Executor; recovery is a new sign-in.
- **Tool-call quality differs by provider and by schema.** Measured only for OpenCode Go with a flat schema; richer node schemas may pass less often. J-typed runs the real node schemas of the first recipes, not just the probe.
- **`wham/usage` can change without notice.** Unreadable beats wrong.
- **Overshoot.** Up to one response per running child past a hard budget; a bridge turn is long. The card says so; per-request `maxTokens` bounds it.
- **A dollar budget over a plan-billed workflow can mislead.** Mitigation: proposed ADR 2's labels and the "covers which roles" line.
- **Catalog drift.** pi-ai's prices change with its releases; a stored figure is the price at record time, because `usage.cost` is computed at response time. The ledger stores what pi-durable recorded and uses the catalog only for the bridge's equivalent.
- **Shared name `provider/model` collisions** (`gpt-6-luna` exists under `opencode-go` and `openai-codex`). Aliases always carry the provider.
- **Provider-specific pi-ai retry rules** may retry a limit error (Codex's `usage_limit_reached` is not in `retry.ts`'s non-retryable list). Unverified; J-health runs a faux limit and a real classification test.

## Work packages

Sized like phase 1's (a package a day or two for one agent). IDs are local to this note; the plan assigns waves.

| ID | Scope | Depends on | Judge |
| --- | --- | --- | --- |
| M1 Price and family | `ModelPrice.ts`, `ModelFamily.ts`, the provider `basis` table, protocol `Spend.ts` and the `Usage.ts` `reading` field | none | unit tests of pricing (tiers, bridge equivalent, all-zero is unpriced), family table |
| M2 Spend ledger | migration `0007` (`spend_totals`, `spend_events`), `SpendLedger.ts`, boot reconcile, `completeSimple` recording, `thread.spend` on the shell row, `spend.get` | M1, `CommitFeed` | J-spend |
| M3 Role aliases | protocol `Roles.ts`, `ServerSettings.roleBindings`, `RoleAliases.ts`, `roles.check`, the `roles` tool, seeded defaults | M1, the subagents note's dispatch seam | J-roles |
| M4 Model health and failure classes | `ModelHealth.ts`, `classifyRunFailure` patterns for Codex and OpenCode Go, `usage_limit` for them | none | J-health, `RunFailure.test.ts` additions |
| M5 Result tool | `ResultTool.ts` (`cairn.results`), envelope schema, `prepareArguments`, the two-attempt cap, nudge, `cairn.result` document | M3 for `returnedModel`; the subagents note's reporter | J-validator, then J-typed on OpenCode Go and the bridge |
| M6 Budgets | `Budgets.ts`, `BudgetGuard.ts`, `beforeTool` gate, `Budgets.admit` for delegating tools, notices and push, estimates | M2, the briefs note's payload, the workflows note's launch approval | J-budget |
| M7 Codex plan windows | `CodexUsage.ts`, `UsageFeed` for more than the bridge, composer and settings meter for Codex | M8, M1 | decode tests on recorded bodies; live read after login |
| M8 OAuth store and Codex login | migration `0007` (`oauth_credentials`), `OAuthStore.ts`, `CodexLogin.ts`, RPCs, settings card, `ops/wizards/phase-2.sh` stage, `CredentialStore` change | none | J-codex, `pi-readonly.sh`, the user's real login |
| M9 Typed-results judge | `judges/typed-results.ts` across providers with controls, kept in `judges/` | M5, M8 for the Codex case | the J-typed pass and both controls failing |
| M10 Role and spend UI | role table editor, brief-card role rows, spend and budget display, provider cards (from scratch in the look wave) | M3, M2, M6, the design pass | behaviour scripts and screenshots at 1440 and 390 px; no pixel baseline exists |

M1, M4 and M8 can start first and run in parallel. M5 is the critical path for the typed-results target; M9 closes it.

## Probes

All under `/tmp/models-probe/`; they read the worktree's `node_modules` and, for the live ones, the `opencode-go` key from `~/.pi/agent/auth.json` in memory (never printed). Set `CAIRN` to the worktree path if it differs.

- `typed-offline.mjs`: `node typed-offline.mjs`. Offline; the table of accepted and rejected arguments.
- `typed-live.mjs`: `node typed-live.mjs --n=8 --modes=typed,v1,v1repair --models=claude-haiku-5-5,deepseek-v4.1-flash,qwen3.8-flash`. Live, about $0.02 at list price for all modes.
- `usage-shape.mjs`: one tiny call on each of three OpenCode Go models; prints the `Usage` record.
- `strict-offline.mjs`: which schemas qualify for strict function tools.
- `lessons.txt`: the outside-lessons page with tags stripped.

## Not verified

- Claude through the bridge and Codex returning a typed result: not run (no Codex login in Cairn; the bridge case is a judge, not a probe).
- That pi-durable retries or does not retry a Codex `usage_limit_reached` or an OpenCode Go limit error.
- The `wham/usage` response, which I read from MonoCode's parser and did not call.
- Whether pi's `openai-codex` token is revoked: only its expiry (2026-10-30) was read.
- OpenCode Go's plan limits and whether it exposes them anywhere; pi-ai names the limit kinds and nothing more.
- Whether the Agent SDK's `total_cost_usd` is nonzero for a subscription turn; `notes/bridge.md:308` says to treat it as an estimate either way.
- Strict constrained decoding actually changing Codex's behaviour: only the schema's qualification was tested.
