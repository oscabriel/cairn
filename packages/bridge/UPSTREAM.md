# Upstream

`@cairn/bridge` is ported, not registered (ADR 0017). It is not a fork of one repository: most files are cut from `elidickinson/pi-claude-bridge` by way of Cairn's own v1, a few take ideas from two other repositories, and a third of the package is Cairn's own. This file says which is which. The file headers in `src/` are the primary record (they name repo, path, lines and commit); this file collects them and checks them.

## Sources

| Source | Commit | What it is | License |
| --- | --- | --- | --- |
| `elidickinson/pi-claude-bridge` | `874fa7c2678456336f23b64e784e2057e608d83e` (0.9.3, "Release 0.9.3", 2026-10-13) | The upstream. Every file that says "Ported from elidickinson/pi-claude-bridge" cites this commit. | MIT, Copyright (c) 2026 Eli Dickinson (`LICENSE` at that commit) |
| `cairn-v1` (`~/Developer/projects/cairn-v1`, Cairn's own earlier build) | `1a5cd4a56e84bfb187940428d144b584d2e084b0` (2026-10-19) | The route most upstream code took here: v1 had already cut it for Effect and added the three fixes. Its own code is Cairn's own. | Cairn's own (no notice needed for v1 code); carries upstream's notice where it carries upstream code |
| `w-winter/dot314`, `extensions/pi-claude-bridge/src/` | `c157f4e6f9fda15b2d6698a12820e7118d19fbd7` (2026-10-15) | A fork of upstream with a native provider. Code from `extract-tool-results.ts` and `third-party-rejection.ts`; `native-provider.ts` and `history-digest.ts` are ideas only, as is the idea of `stream-idle-watchdog.ts`. | MIT, Copyright (c) 2026 Eli Dickinson, Warren Winter, Nico Bailon (`extensions/pi-claude-bridge/LICENSE` at that commit) |
| `pingdotgg/t3code`, `apps/server/src/provider/claudeUsageLimits.ts` | `fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92` (the pin of ADR 0015) | Source of the usage window ids, labels and naming rules in `ClaudeUsage.ts`. | MIT, Copyright (c) 2026 T3 Tools Inc. |

Every commit above exists in its repository and every path cited below exists at it (checked 2026-10-27 against `/tmp/pi-claude-bridge`, `~/Developer/clones/github.com/w-winter/dot314`, the t3code sparse clone and cairn-v1).

Two further sources are read for ideas and carry no code: `earendil-works/pi-claude-code` at `70abb65` (`docs/phase-1/notes/pi-claude-code.md`; its usage-credit guard and child environment ideas were taken, its relay and replay design refused) and `nicobailon/pi-cached-compaction` (ADR 0025).

## Import

- Imported on 2026-10-22 (`bdc53aa`, "Phase 1 wave 1, 1F: the Claude bridge core"). `ClaudeSummary.ts`, `ClaudeUsage.ts` and their tests arrived the same day in `1dba5a9` ("2F, bridge usage and safety"); `ClaudeStream.test.ts` in `8922c21` (2026-10-24). Dates are from `git log --diff-filter=A` on each file.
- Integrity: a header names the source path and commit, not a hash of the imported bytes, because nothing was copied unchanged. The pinned commits are the integrity record; a path can be re-read with `git show <commit>:<path>`.
- Where the MIT notice is carried: at the foot of each header of a file that holds code derived from an MIT source, naming the holders above. Thirteen files carry one: `Claude{Conversation, Guards, Mcp, Models, Prompt, PromptStream, Provider, Stream, Summary, Tokens, ToolResults, Transcript, Usage}.ts`. `ClaudeSdk.ts` holds the ported MCP server handlers and points to the notice in `ClaudeMcp.ts` rather than repeating it. Files that take only ideas (`ClaudeStamp.ts`, `ClaudeResume.ts`) or are Cairn's own carry none.

## Files

"Upstream" means `pi-claude-bridge` at `874fa7c` (paths below are relative to its `src/`). "v1" means cairn-v1 at `1a5cd4a`, `apps/server/src/`. "Own" means Cairn's own design or code, with no upstream origin.

| File | Origin | Delta |
| --- | --- | --- |
| `Claude.ts` | v1 `Claude.ts` and the `ClaudeBridge` class (in intent); dot314 `stream-idle-watchdog.ts` (idea only) | The service: conversations live in an `RcMap` keyed by pi's provider session id, with a cap on live children and an idle time to live; the cwd arrives through `noteConversation`; permits from `ClaudeSlots`; plan windows as a stream. |
| `ClaudeAccount.ts` | Own | The cached Claude Code login, read by the provider's availability check; never the token. |
| `ClaudeConversation.ts` | Upstream `index.ts` `streamClaudeAgentSdk` (1766-2214), `deliverToolResults`, `buildMcpServers` and the resumed-result path (1035-1089, 1631-1721); v1 `claude/conversation.ts` | An Effect state machine under one lock, one conversation per pi session id, no module state; the resume table replaces v1's native resume and rebuild; a finished child stays alive; a generation permit; a stall watchdog. |
| `ClaudeEvents.ts` | Own | The SDK messages the bridge reads, as Schemas, decoded at `ClaudeSdk`'s boundary. |
| `ClaudeGuards.ts` | v1 `claude/{query-options,prompt-safety,abort}.ts`; dot314 `third-party-rejection.ts`; upstream `index.ts` 48-64 (`CC_CHILD_ENV`, `CLAUDE_MD_EXCLUDES`) | Pure checks on a `ChildOptions` value; strips every `ANTHROPIC_*`, `CAIRN_*` and inherited `CLAUDE_CODE_*` name; adds `CLAUDE_CODE_FORK_SUBAGENT=0`; every bridge error text lives here. |
| `ClaudeInstructions.ts` | v1 `claude/system-reminder.ts` (Cairn's own code) | Replays the effective system state with pi-ai 1.4.0's `getCurrentSystemMessage`; the rebuild-only history renderer is gone. |
| `ClaudeMcp.ts` | Upstream `mcp-server.ts`; v1 `claude/mcp-server.ts` | Pure parts only (schema flattening, tool listing, pairing by `_meta["claudecode/toolUseId"]`); every listed tool carries `_meta["anthropic/alwaysLoad"]`; schema walk typed over JSON values. |
| `ClaudeModels.ts` | Upstream `models.ts`; v1 `claude/models.ts`, `claude/summary.ts` (effort mapping) | Catalog from `getBuiltinModels("anthropic")` (pi-ai 1.4.0), each model stamped with the bridge's provider and api. |
| `ClaudeOneShot.ts` | Own | The seam for sessionless requests; the default layer refuses with a fixed, non-retryable text. |
| `ClaudePrompt.ts` | Upstream `index.ts` 399-472 and the continuation prompt (see header findings); v1 `claude/prompt.ts` | Blocks are Cairn values; tool results Claude Code does not hold, and pi's whole context for a fresh session, render as prompt text. |
| `ClaudePromptStream.ts` | Upstream `prompt-stream.ts` | Effect `Queue` and `Deferred`; the consumer side is `take`, turned into the SDK's async iterable by `ClaudeSdk`. |
| `ClaudeProvider.ts` | v1 `Claude.ts` `claudeProvider` (60-90); dot314 `native-provider.ts` (ideas) | `auth.apiKey.check` and `resolve` read the cached login and never spawn a child; there is no key. |
| `ClaudeResume.ts` | Own (replaces v1 `native-resume.ts`, `native-fork.ts`, `rebuild.ts`) | The decision table: SDK `resume` with `resumeSessionAt`, `forkSession`, or a fresh session carrying pi's context; `resumeAppend` per the stamp. No transcript is ever written. |
| `ClaudeScriptKit.ts` | v1 `test/fake-claude.ts` (in intent, Cairn's own code) | Scripted children for `ClaudeSdk.layerTest`. |
| `ClaudeSdk.ts` | Upstream `mcp-server.ts` (the server wiring); otherwise Own | The only importer of the Agent SDK and the MCP SDK; handlers on the protocol server, not zod-only `registerTool`; decodes every message; reads and forks transcripts. |
| `ClaudeSettings.ts` | Own | Defaults for where children start and how many may live. |
| `ClaudeSlots.ts` | Own | The generation semaphore; a child held across a tool call holds no permit. |
| `ClaudeStamp.ts` | v1 `claude/session-map.ts` (Cairn's own code); dot314 `history-digest.ts` (ideas only) | Adds `ccUuid`, `piSessionId`, `cwd`; drops `ccMessageId`; details decoded with a Schema. |
| `ClaudeStream.ts` | Upstream `index.ts` 1139-1610 and `query-state.ts`; v1 `claude/{stream,query-state}.ts` | Reads decoded `ClaudeEvent`s; records each message's chain uuid; ends a streamed tool-use turn on `message_stop`; `pending`, `deferred` and `cacheWrite1h` from pi-ai 1.4.0; no singletons; no bash timeout default. |
| `ClaudeSummary.ts` | Upstream `index.ts` `runIsolatedSummary` (551-680); v1 `claude/summary.ts` | Goes through `ClaudeSdk` with the guards; the instructions ride as the preset's append; prior history carried as a transcript. |
| `ClaudeTokens.ts` | Upstream `usage.ts`; v1 `claude/tokens.ts` | Renamed to avoid `ClaudeUsage`; fills the one-hour cache write split. |
| `ClaudeToolResults.ts` | dot314 `extract-tool-results.ts` (identical to upstream's file of that name at `874fa7c`); v1 `claude/extract-tool-results.ts` | Typed over pi-ai's messages; the pairing id is required. |
| `ClaudeTranscript.ts` | Upstream `transcript.ts`; v1 `claude/transcript.ts` | pi-ai 1.4.0's replay helpers do the work; sections in pi-durable's replay order. |
| `ClaudeUsage.ts` | v1 `{ClaudeUsage,Usage}.ts` (Cairn's own code); t3code `claudeUsageLimits.ts` at `fe27e8e3` | Schema decoding of the probe's answer, `Clock` times, shared-`Deferred` single flight, the slot policy, projection onto `@cairn/protocol`'s `ProviderUsage`. |

Tests: `ClaudeInstructions.test.ts` and `ClaudeUsage.test.ts` are ported from v1 tests (`test/system-reminder.test.ts`, `test/usage.test.ts`); `ClaudeConversation.test.ts` is ported in intent from v1's `test/claude.test.ts` and `test/claude-resume.test.ts`. The other tests are Cairn's own.

## Kept

What the port relies on from upstream, each read in `874fa7c` (ADR 0017: "keeps upstream's tool-result state machine, MCP schema flattening and stream mapping"):

- The held query: a query parked at a tool boundary takes the turn's tool results, and the results and handlers meet in two maps whichever arrives first. A steer is written to Claude Code first so its post-tool drain sees it (`deliverToolResults`, `index.ts` 1631-1692).
- The resumed-result path (upstream fix #174): a result with no held query resumes the session with a continuation prompt (`CONTINUE_AFTER_RESUME_PROMPT`, `index.ts` 1716-1721).
- `flattenRootCombinators` (`mcp-server.ts` 108): a root `anyOf`, `oneOf` or `allOf` is flattened, because Claude Code drops such a tool. pi's JSON Schema otherwise goes out verbatim, and a call pairs with its `tool_use` by `_meta["claudecode/toolUseId"]`.
- Stream mapping (`index.ts` 1139-1610): a tool call dispatches only once its block closes (#146), unfinished blocks of an abandoned stream are dropped, a `<synthetic>` assistant message is a report, Claude Code's non-streaming fallback is delivered, a rate-limit rejection names the failure that follows (#183).
- The prompt stream (`prompt-stream.ts`): a push is acknowledged only when the consumer asks for the next message; a failure rejects every pending push.
- The isolated one-shot (`runIsolatedSummary`): routed on `cacheRetention: "none"`, stopped only by a real abort, the caller's reasoning level sent as `effort` (#184).
- `CC_CHILD_ENV` (`ENABLE_CLAUDEAI_MCP_SERVERS=0`, `DISABLE_AUTO_COMPACT=1`) and `CLAUDE_MD_EXCLUDES`.
- pi-ai's anthropic catalog as the model picker, dated snapshots hidden, cost zero (`models.ts`).

## Changed

Each departure, with what decided it. The measurements are in the ADRs and `docs/phase-1/notes/bridge.md` (section 2.2 is the table of what direct registration cannot do).

| Change | Why | Decided in |
| --- | --- | --- |
| Port instead of loading the extension | Upstream `main` (`1ae18a2`) loads and answers but kills its held query at the first tool call, rebuilds the transcript cold after a restart, runs `~/.claude` hooks, sets a process-wide env var that blinds the usage probe, keeps module-global state and has no cap on children. | ADR 0017; notes `bridge.md` 2.2, 3.1 |
| One abort signal per conversation; no module state | pi-durable aborts the first generation's signal when it parks on a tool round. Per-conversation state lives in an `RcMap`, not a module-wide `QueryContext`. | ADR 0017; notes `bridge.md` 2.2, 3.3 |
| Stamps and SDK-native resume instead of `cc-session-io` rebuild | Upstream rebuilds Claude Code's transcript from pi's history (0.07x cache read over write after a restart). Cairn records the session as a stamp on the reply and resumes with the SDK's `resume` and `resumeSessionAt`; it never writes a transcript. `ClaudeResume` replaces `sharedSessions`. | ADR 0018; notes `bridge.md` 3.3 |
| No ambient `~/.claude` and no inherited credentials | `settingSources: []`, hooks disabled, every `ANTHROPIC_*` stripped, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set on turn children only, inherited `CLAUDE_CODE_*` stripped. Upstream spreads `process.env` and leaves `settingSources` at the default. | ADR 0002; ADR 0017; notes `pi-claude-code.md` ("What Cairn should take", item 3) |
| Generation semaphore | Upstream has none. `ClaudeSlots` caps children generating at once; a child held across a tool call holds no permit. | ADR 0017; notes `bridge.md` 3.4 |
| `_meta["anthropic/alwaysLoad"]` on every served tool | Upstream's hand-rolled server returns no `_meta`. | Notes `bridge.md` 3.5 |
| Native pi-ai provider, not an extension | No `registerProvider` or nine `pi.on` events; the cwd arrives through `noteConversation`; no `~/.pi/agent` config read; models from `getBuiltinModels`, not the deprecated `compat` import. | ADR 0017; notes `bridge.md` 2.2, 3.5 |
| Effect services and Schema decoding | Standards S10, S42: the SDK is behind one service, every SDK message decodes at its boundary. | Coding standards; ADR 0004 |
| Usage-credit guard | A `rate_limit_event` with `isUsingOverage: true` ends the turn. Taken from `pi-claude-code`; the code is Cairn's own. | Notes `pi-claude-code.md` ("What Cairn should take", item 1) |
| The relay and stateless replay are refused | They route the login headers through Cairn and rewrite Claude Code's requests, a step toward the impersonation ADR 0002 refuses. | ADR 0002; notes `pi-claude-code.md` ("What not to take") |
| The bash timeout default is gone | pi-durable owns tool timeouts (upstream adds one in `index.ts` near line 949). | `ClaudeStream.ts` header |
| Dropped from upstream | `prompt-capture.ts`, `askclaude-*`, `config.ts`, `attachments.ts`, `agents-md.ts`, `session-cwd.ts`, startup notices, `piUI`. AskClaude is never registered. | Notes `bridge.md` 3.5 |

ADR 0025 (compaction forks the stamped session, `status: proposed`) adds nothing to this package beyond the `fork-stamped` path that ADR 0018 already built; the `beforeCompact` hook is outside it.

## Header findings

Checked against `874fa7c` on 2026-10-27. These are recorded, not fixed (headers are code):

- `ClaudePrompt.ts` cites "lines 399-472 and 1612-1619, the continuation prompt". Lines 1612-1619 are `steerBlocks`; the continuation prompt is `CONTINUE_AFTER_RESUME_PROMPT` at 1716-1721. `docs/phase-1/notes/bridge.md` 3.5 repeats "1612 to 1619".
- `ClaudeSummary.ts` cites `runIsolatedSummary` as lines 551-680. The function ends at 666; 667-680 is the start of the next section (`syncSharedSession` documentation, `verifyWrittenSession`). The entry point `isolatedStreamFn` (543-548) is not in the range.
- `ClaudeGuards.ts` cites `CC_CHILD_ENV` at lines 48-64. The constant is 48-51; lines 52-64 are `CLAUDE_MD_EXCLUDES` and its comment, which `ClaudeGuards.ts` also ports, so the range is loose rather than wrong.
- `ClaudeConversation.ts` cites 1766-2214. `streamClaudeAgentSdk` ends at 2212; 2213-2214 are a blank line and the next section's comment.
- No other cited line range, path or commit failed to match. Files whose header names no source commit: `ClaudeAccount.ts`, `ClaudeEvents.ts`, `ClaudeOneShot.ts`, `ClaudeSettings.ts`, `ClaudeSlots.ts` (Own, nothing to cite) and `ClaudeResume.ts` (Own; names v1 only as what it replaces, at `1a5cd4a`).

## Re-checking against a newer upstream

As of 2026-10-27 upstream `main` is `6aa276a`, nine commits past `874fa7c`. Of the files above only `index.ts` (89 lines), `prompt-stream.ts` (4) and `query-state.ts` (6) changed. The notable ones are `38980d1` and `1ae18a2` (bind each continuing run's abort signal to the parked query), `8a60b18` ("Keep finalized assistants immutable and queued steering MCP connected") and `9a0efe7` (SDK 0.3.308). None has been ported or judged against the port.

```sh
git clone https://github.com/elidickinson/pi-claude-bridge /tmp/pi-claude-bridge
cd /tmp/pi-claude-bridge
git log --format='%h %ad %s' --date=short 874fa7c..origin/HEAD
git diff 874fa7c origin/HEAD -- src/index.ts src/mcp-server.ts src/prompt-stream.ts \
  src/query-state.ts src/models.ts src/transcript.ts src/usage.ts src/extract-tool-results.ts
```

Read `CHANGELOG.md` for fixes worth porting (ADR 0017 asks for this). For each hunk, find its Cairn file in the table above and decide: port it (rewritten to our standards, header range and commit updated), or note it as not applicable. Then run the package tests and `judges/claude-kill.sh` (J2), since a change to how a resumed child is launched can move the cache prefix. Update the commit, the dates and the header findings here in the same change. Do the same for dot314 (`git -C <clone> diff c157f4e HEAD -- extensions/pi-claude-bridge/src`) when its fork changes a file named in the table above.
