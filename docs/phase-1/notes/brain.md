# Phase 1 notes: the brain (pi-durable host API and its siblings)

Scope: everything Cairn's brain needs from `@earendil-works/pi-durable` 1.4.0 and its siblings (chord, pi-ai, pi-codemode, pi-mcp, pi-env, and the loaders in pi-coding-agent), the footguns of the host API, and the scripted harness for the seam conformance suite. Written for whoever builds `apps/server/src/brain/`. Nothing in this file was written to source; the probes it quotes ran in `/tmp/brain-probe` against the published 1.4.0 packages and are described well enough to rerun.

## Summary

- pi-durable 1.4.0 is enough for the whole Phase 1 brain. One `Harness` over one SQLite file can carry every thread as an ownerless conversation. Measured on the Beelink: 300 conversations streaming at once commit 3,640 times a second at 268 MiB RSS, and a reopen of that store takes 1 ms.
- The thread stream of ADR 0007 is `conversation.watch()`: its `value` is the snapshot, its `start()` listener gets chord delta ops. The view holds the whole active transcript, so a 2,000 entry thread is an 8.3 MB snapshot and a 1 MB pasted image rides inside it. Cairn must window the view and elide image bytes before anything reaches a client, and page older history with `conversation.entries()`.
- `ModelRuntime.create()` with its defaults writes into `~/.pi/agent` (lock directories, `models-store.json`), and `SettingsManager.create()` and `DefaultResourceLoader` write or install too. Cairn can use all of them read-only by passing its own `CredentialStore`, `ModelsStore` and `SettingsStorage`, and by calling `DefaultPackageManager.resolve(async () => "skip")`. Measured: no change anywhere under `~/.pi/agent`, no process spawned, 263 ms to build the runtime and 417 ms to resolve skills.
- A provider (the bridge) sees only `options.sessionId`, the conversation's `pi.provider` UUID, and the harness-wide `settings.stream`. There is no conversation id or cwd on the provider call. Key every bridge side table by session id.
- The four coding tools carry no `replay` flag, so all of them, `read` included, are `unsafe` and come back `interrupted` after a crash. Wrap `read` as safe.
- The crash-loop guard, parked tasks and `retryTask()` are in 1.4.0 and behave as the spikes recorded. Cairn must surface `restart_limit` tasks and retry waiting approvals at boot.
- Footguns: spec section 12 lists 39; each is mapped to a Cairn rule below, plus 13 more found in the installed source and by probes.
- The scripted harness: define it as a second implementation of Cairn's `HarnessSeam` that replays golden transcripts, with the goldens recorded from pi-durable plus pi-ai's faux provider. One scenario suite then judges both.
- Open risks worth the user's attention: a store cannot delete a conversation (retention is permanent, so image size and tombstoning matter), forking and compaction on the Claude bridge, and the next pi-durable release migrating SQLite irreversibly (back up on every version change).

## Facts with evidence

### Sources and pins

| Thing | Where | Pin |
| --- | --- | --- |
| pi-durable, chord, pi-ai, pi-codemode, pi-mcp, pi-env | `pnpm-workspace.yaml` catalog | 1.4.0 (installed under `spikes/*/node_modules/@earendil-works/`; only `pi-mcp` is hoisted to the repo root today) |
| pi source for 1.4.0 | `github.com/earendil-works/pi`, tag `v1.4.0` | commit `4a080252` (2026-10-22). Shallow clone used for this note: `/tmp/pi-src-1.4.0/src` (ephemeral) |
| pi-durable spec | `packages/durable/docs/spec.md` at `4a080252` (5,618 lines; section 12 "API footguns" at line 5460) | Not in the npm tarball (`files` is `dist`, `README.md`, `CHANGELOG.md`). The shared clone `~/Developer/clones/github.com/earendil-works/pi` has `origin/main` at `bdd9f039` (1.3.0 era), before 1.4.0, so it is stale for this work. Ported files should cite `earendil-works/pi@4a080252` |
| pi-coding-agent 1.4.0 | Not installed in the repo. Unpacked with `npm pack` at `/tmp/pi-ca-pack/x/package` | Not in the catalog yet. Add `"@earendil-works/pi-coding-agent": 1.4.0` when the server needs it |
| v1 reference code | `~/Developer/projects/cairn-v1` at `1a5cd4a` (`apps/server/src/{Harnesses,Models,PiConfig,Skills,PiContext,Registry,visible}.ts`) | Port with headers |
| t3code | `~/Developer/clones/github.com/pingdotgg/t3code` | `fe27e8e3` (ADR 0015) |

The 1.4.0 changelog (`packages/durable/CHANGELOG.md`) is the diff that matters against research 01 (written on 1.3.0): `TaskRuntime.sleepUntil()` replaces `sleep()`, `sleeping` is a task status, `ToolExecutionApi.now()`, `HarnessOptions.now/setTimer/onWake/identity/telemetry`, `settings.restartLimit` (default 5), `Harness.retryTask()`, `onReport(error, info)`, `settings.afterFailedRun`, `settings.compaction.modelOverrides`, `HarnessOptions.models` and `settings` accept functions, `defineDoc` requires `checkpointWhen`, and SQLite migrates to schema 2 on open (`CURRENT_SQLITE_SCHEMA_VERSION` is 2) with no way back to 1.3.0.

### Imports (from the installed 1.4.0 `package.json` exports and `.d.ts`)

```ts
// pi-durable
import { Harness, createRegistry, defineExtension, defineTool, defineTask, defineDoc, defineDocFamily,
         hook, section, wrapTool, wrapSection, configure, watchEvents, ROOT_CONVERSATION_ID,
         MemoryStorage, createSession, GenerationTask, ToolTask, CompactionTask,
         UserEntry, AssistantEntry, ToolResultEntry, defineEntry, LiveDoc, InboxDoc, UsageDoc, AgentDoc,
         ProviderDoc, NestedCallDoc, ConversationBusy, SessionFailed, StorageRequestError, ReadAfterWrite,
         DEFAULT_RESTART_LIMIT, DEFAULT_HARNESS_IDENTITY, DURABLE_TELEMETRY_SCHEMA } from "@earendil-works/pi-durable";
import type { HarnessOptions, HarnessSettings, Conversation, Submission, SubmissionDraft, ConversationView,
              ToolRegistration, ToolExecutionApi, Extension, Registry, AgentChange, ReportInfo,
              TaskGraph, TaskGraphNode, HarnessInspection, Wake, Tx, Storage, EntryRecord } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { type ExecutionEnv, FileError, ExecutionError, getOrThrow } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage, NodeSqliteDatabase, openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage, CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { CodingTools, createCodingTools, createReadTool, createWriteTool, createEditTool, createBashTool,
         DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension, createCodemodeTool, CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { registerEnvConformance, registerStorageConformance } from "@earendil-works/pi-durable/testing";

// chord (the Context every call takes, and the delta ops the wire carries)
import { BACKGROUND_CONTEXT, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { applyImmutable, applyImmutableBatches, diffRevisions, encoder, decoder, assertValidOp } from "@earendil-works/chord/delta";

// pi-ai
import { Type, InMemoryModelsStore } from "@earendil-works/pi-ai";                             // Type is typebox
import { createModels } from "@earendil-works/pi-ai/models";                                  // also exported from the root
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

// pi-codemode
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";

// pi-coding-agent (only these)
import { ModelRuntime, SettingsManager, DefaultPackageManager, loadSkills, formatSkillsForPrompt,
         loadProjectContextFiles, getAgentDir } from "@earendil-works/pi-coding-agent";

// pi-mcp, pi-env
import { McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { LocalExecutionEnv, RemoteExecutionEnv, Connection } from "@earendil-works/pi-env";
```

`@earendil-works/chord/delta` has no `node:` imports, so the browser client can use `applyImmutable` directly (v1 did: `apps/web/src/transcript.ts`). pi-coding-agent's package exports are only `.` and `./rpc-entry`, so internals such as `ReadOnlyAuthStorage` (which exists in `src/core/auth-storage.ts` and is used by `pi --no-refresh`) and `FileModelsStore` cannot be imported.

### Opening, running and closing the Harness

Signature (`dist/harness/harness.d.ts`): `Harness.open<Tool>(storage: Storage, options: HarnessOptions<Tool>, context: Context): Promise<Harness>`.

`HarnessOptions` (`dist/harness/types.d.ts`):

| Field | Meaning for Cairn |
| --- | --- |
| `models: Models \| () => Models` | Pass the `ModelRuntime`. The function form lets Cairn swap runtimes (a credential change) without reopening |
| `registry: RegistryReader` | Install every extension before `open`; a task of an extension that is not installed is blocked `missing_task` until it is |
| `settings?: HarnessSettings \| () => HarnessSettings` | Read live at each use. Not stored |
| `env?: ({conversationId, cwd, read}, ctx) => ExecutionEnv \| undefined` | Called per tool call, per section render, per `runtime.env()`. Never on the Session line. A throw becomes the call's error result |
| `conversationCreated?(tx, record)` | Runs in every commit that creates or forks a conversation, raw `tx.createConversation()` included |
| `now`, `setTimer` | Harness clock and timers. Sleep deadlines are stored on `now`; use the real clock in production and fakes in tests |
| `onWake` | For Durable Object hosts. Cairn's Node process leaves it unset, so the Harness keeps a timer for sleeps |
| `onReport(error, info)` | `info.type`: `session_failed`, `task_faulted`, `task_parked`, `migration_failed`, `task_outdated`, `task_error`, `extension_error`, `host_error`, `listener_error`. Its own throw is dropped |
| `identity?: ClientIdentity` | Default `{ attribution: PI_ATTRIBUTION }` names pi in OpenRouter, NIM and OpenCode attribution headers; `{ attribution: null }` sends none |
| `telemetry?: TelemetryContext` | Optional pi-telemetry adapter, content-free spans (`DURABLE_TELEMETRY_SCHEMA`) |

Lifecycle facts, all confirmed in `spikes/3-workflows/brain.ts`, `spikes/4-approvals/brain.ts` and the 1.4.0 README:

- `Harness.open` does not schedule work. `harness.resume()` does (also submit, wait and abort calls). Open, install, then resume.
- `harness.closed: Promise<SessionEnd>` is `{reason:"closed"}` after `close()` or `{reason:"failed", error}` after a storage error. A failed Session closes itself and every held watch ends with `session_failed`. Reopen from storage.
- `close()` joins every invocation. A task that ignores its signal keeps close pending. A clean close writes stopped tasks back `pending` without counting a restart (spike 3: six SIGTERM restarts parked nothing; five `kill -9`s parked four tasks, and one `retryTask` pass finished the workflow with every effect once).
- Every promise the host holds on the Harness (`waitForIdle`, `watch.closed`, submission waits) rejects with "Harness is closed" at close. Spike 3's first clean-stop attempt crashed on one that was not handled.
- Exactly-once submits: the same `requestId` on the same conversation returns the existing submission (`a.id === b.id`, measured), also after a restart.
- `harness.root()` creates the reserved conversation `ROOT_CONVERSATION_ID` (1). Cairn does not need it for threads.

### Conversations, submissions, steer, abort

`Conversation` (`dist/harness/types.d.ts`): `id`, `agent(ctx)`, `configure(change, ctx)`, `submit(draft, ctx): Promise<Submission>`, `reset(handoff, ctx)`, `compact(instructions, ctx): Promise<TaskId>`, `commit(fn, ctx)`, `context(ctx, {at?})`, `entries(query, limit, cursor, ctx): Promise<Page<EntryRecord, Cursor>>`, `fork(at, options, ctx)`, `abort(ctx, {background?})`, `waitForIdle(ctx)`, `viewState(ctx)`, `watch(ctx)`.

`SubmissionDraft`: `{type:"input", content: string | (TextContent|ImageContent)[], whenBusy?: "steer"|"followUp"|"reject", entry?: {kind, data?}, requestId?}` or `{type:"write", entry: EntryDraft, requestId?}`. `entry.kind` must not start with `pi.`; the model still sees `content`. User content has no document or PDF block, only text and image, so documents reach the model as extracted text blocks (plus a path for `read`).

`Submission`: `id`, `status(ctx)`, `wait(ctx): {status:"done"|"unanswered", answer?, reason?}`, `abort(ctx): "aborted"|"already_placed"|"settled"`. `Harness.abortSubmission(id, ctx, conversationId?)` adds `"not_found"`. Queue editing in the t3code sense (cancel, edit, reorder, promote to steer) is therefore withdraw plus resubmit with a fresh `requestId`; `already_placed` is the race to handle.

Probed abort behaviour (faux model at 40 tokens/s, two queued follow-ups):

| Call | Run | Queued inputs |
| --- | --- | --- |
| `conversation.abort(ctx)` | aborted in 82 ms | all withdrawn, `unanswered` reason `aborted`; queued writes stay |
| `harness.abortTask(runTaskId, ctx)` where the id is `pi.live.run.taskId` | aborted (`marked`), input `unanswered aborted` | stay queued; the next submit's boundary places the oldest first |
| `whenBusy:"reject"` while busy | none | `ConversationBusy` thrown, nothing written |

So a "stop" button that should keep the user's queued messages is `abortTask` on the run task, and one that clears them is `conversation.abort`. t3code's stop semantics decide which; pick when porting `Sidebar`/composer logic.

### The thread stream: `viewState()`, `watch()`, `entries()`

- `ConversationView` = `{conversation: ConversationRecord, entries: readonly EntryRecord[], docs: Record<kind, JsonObject>}` (`dist/harness/view.d.ts`). Docs present: `pi.agent`, `pi.live`, `pi.inbox`, `pi.provider`, `pi.usage` (probed), plus any conversation doc Cairn defines.
- `watch(ctx)` returns `WatchHandle<ConversationView>`: `.value` is the acquisition snapshot, `.start(async (value, ops, ctx) => ...)` installs the sole listener (never invoked inline), `.stop()`, `.closed`. The listener is awaited per frame, so a slow client back-pressures only its own watch. At most 100 undelivered frames are kept; overflow collapses into one `["r", fullView]` frame, so the client must accept a root replacement at any time. There is no replay for late joiners: snapshot first, always (ADR 0007).
- Views are shared: at most one mount per conversation, dropped with its last observer, so N devices on a thread cost one mount.
- Ops are chord delta tuples `r s d a t p m` (`@earendil-works/chord/delta`). Probed frame sizes for a streamed turn on a 2,000 entry thread: 19 frames, 6.7 KB total. Streaming is cheap; snapshots are the expense.
- `entries` in the view is the active range only (from the newest head marker: a reset or a compaction). Probed after a reset: view `pi.reset,pi.user,pi.assistant,pi.system`, `entries()` returns all 10 entries newest first. History before the head, and any older page, comes from `conversation.entries({maxEntryId?, minEntryId?, order?}, limit, cursor, ctx)`. Cursor is `{after, order}`; entry ids are global to the store (13, 16, 17 in one conversation), so "older than X" is `maxEntryId: X - 1` with `descending` (the default).
- `pi.system` entries (prompt and tool-set deltas) are in the view; the UI hides them. `pi.provider` carries the session id; hide it (v1: `VISIBLE_DOCS = pi.agent, pi.live, pi.inbox, pi.usage`, `apps/server/src/visible.ts`).
- Measured sizes: 2,000 entries of 4 KB: 8.26 MB snapshot, `watch()` mount build 10 ms. One 1 MB pasted image: 1.34 MB in the snapshot and in a single `s` op.
- `watchEvents(harness, conversationId, ctx)` (coding-agent style `AgentEvent`s: `run_start`, `message_update` with `changes`, `tool_execution_*`, `inbox_update`, `compaction_*`) is marked experimental and not needed for the client. It is a convenient server-side feed if a notifier wants "turn ended".
- `harness.subscribeCommits(listener)` gets every `CommitPublication {seq, changes}`: table changes (`entry`, `submission`, `task`, `conversation`) and document changes with `conversationId`, `value` and `ops`. A streamed turn produced, per run: 1 `pi.user` entry, 2 submission records, 4 task records, 11 `pi.live` doc changes, 1 `pi.assistant` entry, 1 `pi.usage` change. The listener runs synchronously after adoption and "must not block or call Session APIs", so it should only enqueue. This is the right feed for Cairn's shell stream (thread status, last activity, unread, push triggers) because it covers all threads with one subscription. A `submission` change with `status:"done"` is the turn-ended signal.
- `harness.inspect(ctx)` returns live tasks with a scheduling `kind` (`running|ready|waiting|sleeping|completing|blocked`, blocked has `reason`) and every unsettled submission; use it at boot to find busy conversations. `harness.taskGraph(ctx)` and `watchTaskGraph(ctx)` give the same live set as a chord state or watch, with `TaskGraphNode.blocked`, `owner`, `conversations`, `background`, `abortRequested` (v1's `graphStream` is the port source, `apps/server/src/Harnesses.ts` lines 167 to 239).

### Documents, tasks, sleep, restart limit, reports

- `defineDoc<T>({kind, version, scope: "session"|"conversation"|"task", history?: "latest"|"rewindable", fork?: "current"|"initial"|"asOf", initial, migrate?, checkpointWhen})`. 1.4.0 requires `checkpointWhen`; use `(_v, _ops, info) => info.deltasSinceBase >= 50` for ordinary documents and `() => false` only for tiny ones. `defineDocFamily` adds `family: true` and `initial(seed)`; the first acquisition of a key picks the seed.
- Read: `harness.snapshot(token, [ownerId], [key], ctx)`, `documentState`, `watchDoc`. Write: only in a commit, `tx.doc(token, ...)` returns a Draft. `harness.commit(fn, ctx)` and `conversation.commit(fn, ctx)` run the callback on the Session mutation line.
- Tasks: `defineTask({name, version, initial, phases, abort, migrate?, hooks?})`; states `pending|running|waiting|sleeping|completing|terminal`. A phase ends by committing a next state through `runtime.commit`, or by `runtime.sleepUntil(until, checkpoint, ctx)`; there is no sleep inside a phase. A sleeping task cannot be woken early by an event (spike 4 therefore kept the approval wait inside a replay-safe tool).
- Crash-loop guard: a task cut off by a crash 5 times in a row without committing new state is parked: `inspect()` and the task graph show `blocked: "restart_limit"`, `wake()` ignores it, `onReport` receives `task_parked` once, `harness.retryTask(taskId, ctx)` runs it again. Closes do not count. Spike 3 `kill-six` and spike 4 `kill-six-times` confirm both directions.
- `settings.afterFailedRun`: `keep` (default), `continue`, `withdraw`.
- Subagents are owned conversations (README "Abort and Subagents", examples `22-subagent-foreground.ts` and `23-subagent-background.ts`; `spikes/3-workflows/brain.ts` `agent` tool is a working 1.4.0 version). `tx.scanConversations({ownerTaskId})` finds the child after a restart. Task-owned conversations copy their owner's `pi.agent` once at creation.
- Idempotent creation receipt, probed: a session family doc keyed by thread id plus `tx.createConversation` plus `configure(tx, id, change)` in one commit. Three concurrent calls (two for the same key) gave one conversation for the key and one for the other; `conversationCreated` ran twice. Table reads must precede the first table write, documents stay usable after it.

### Settings (read live, never stored)

`HarnessSettings` and resolved defaults (`dist/harness/agent.js`): `retry {enabled true, maxRetries 3, baseDelayMs 2000, maxAgentDelayMs 60000}`, `compaction {enabled true, reserveTokens 16384, keepRecentTokens 20000, backgroundTokens 32768, modelOverrides}`, `progress {partialIntervalMs 100, outputIntervalMs 100}`, `toolExecution "parallel"`, `steeringMode` and `followUpMode "one-at-a-time"`, `contextRetentionMs` and `documentRetentionMs` 10 minutes, `afterFailedRun "keep"`, `restartLimit 5`, `stream {transport, timeoutMs, maxRetries, maxRetryDelayMs, headers, metadata, cacheRetention, deferred}`, `extensions` (absent means every installed extension in install order).

- The stream options are copied into the generation task's checkpoint when a request is prepared (`dist/harness/generation.js` line 100), so they are JSON and fixed per request.
- `documentRetentionMs` frees documents nothing observes (Infinity keeps them); observed documents and busy contexts stay. Defaults are fine at Beelink scale (268 MiB for 300 active conversations); revisit only if idle memory grows.
- Per-model compaction override is the knob for the Claude bridge: `modelOverrides["claude-bridge/<id>"] = {enabled: false, backgroundTokens: 0}` stops pi-durable summarizing a transcript that Claude Code already manages natively. Without it, a background compaction of a bridge conversation spends a summarization request through a `claude` child.
- pi's own `settings.json` already holds compaction, retry, steering, follow-up and transport choices (`SettingsManager.getCompactionSettings(model)`, `getRetrySettings()`, `getSteeringMode()`, `getFollowUpMode()`, `getTransport()`, `getProviderRetrySettings()`); a small adapter maps them to `HarnessSettings` getters so the TUI and Cairn agree.

### Tools, code mode, tool search, MCP

- `defineTool({name, description, parameters: TypeBox, execute(args, api, ctx), replay?: "safe"|"unsafe", callers?: ("model"|"tools")[], deferred?, structuredOutputSchema?, outputLimits?, executionMode?, prepareArguments?})`. Result `{output?, structuredOutput?, isError?, details?, diagnostics?, usage?, control?: {addTools?, terminate?: boolean, handoff?}}`. `ToolExecutionApi` (plain object, spreadable): `taskId, conversationId, callId, registry, agent(ctx), models, env, now(), output(chunk), retainedOutput(), diagnostic(), details(v, ctx), commit(), memo(), createTask(), getTask(), waitForTask(), conversation(id, ctx), executeTool(name, args, ctx, {key?, progress?})` plus the document readers.
- Coding tools: `createCodingTools({images})` returns the extension named `coding-tools` with `bash`, `edit`, `read`, `write`. `CodingTools` is the same without an image processor. No grep, find or ls (the user has `rg` and `fd` at `/usr/bin`). Individual factories are exported (`createBashTool({commandPrefix, prepare})`, `createReadTool({images})`, ...), and `prepare(execution, api, ctx)` can edit the command, cwd and env of every shell call. Default output limits: 2,000 lines, 50 KiB (`DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`).
- None of the four tools sets `replay` (no match in `dist/tools/*.js`), so each is `unsafe`: a crash during `read` yields an `interrupted` error result to the model.
- `createNodePhotonImages()` (`/images/node`) prepares images for `read` in a worker thread (limits 2000x2000 px, 4.5 MB base64) and exits after 30 s idle. Its WASM is read from the installed `@silvia-odwyer/photon`; it also suits shrinking pasted screenshots before they are submitted.
- Code mode: `createCodemodeExtension({sandbox, namespaces?: [{name, description?, instructions?, prefix}], inlineBudget? = 3000, models? = true})` installs the `codemode` tool (`callers:["model"]`, `replay:"safe"`) and a `codemode` prompt section. Each `tools.x()` is a nested durable tool task journaled in `pi.codemode.journal`. `CodemodeSandbox` (`@earendil-works/pi-codemode`) options: `timeoutMs` (default 300,000 including tool time; `Infinity` allowed), `memoryLimitBytes`, `tools`, `globals`, `wasm`, `workerUrl`, `acquireWorker()` (reserve capacity per worker thread, return a release), `onWorkerStarted(exited)`. A script's own `// @options: {"timeout_ms": N}` line stores a deadline that makes a post-crash rerun fail (spike 3); `parseCodemodeSource(code)` from `/source` returns `{code, options: {timeoutMs?, maxOutputTokens?}}` and throws `CodemodeSourceError` if the options line is not first (probed).
- `createToolSearchExtension()` provides `tool_search` over `deferred: true` tools (BM25), which write `modelTools.add`.
- pi-durable has no MCP integration. pi-mcp (`McpClient`, `StreamableHttpTransport({url, headers, authProvider, fetch, reconnect})`, `AuthProvider {token(), onUnauthorized?()}`, `toLlmContent(result)`) is the client; the Executor proxy tools are defined by the Executor notes, and attach to the brain as one `cairn-executor` extension whose tools are `callers:["tools"]` under a codemode namespace, so the model's list stays fixed.

### ExecutionEnv, host arms and worktrees

- `ExecutionEnv = FileSystem & Shell` (`dist/env/index.d.ts`): `id`, `cwd`, `absolutePath`, `joinPath`, `readTextFile`, `readTextLines`, `readBinaryFile`, `openTextLineReader`, `openBinaryReader`, `writeFile`, `appendFile`, `truncateFile`, `flushFile`, `renameFile`, `fileInfo`, `listDir`, `openDirReader`, optional `listFiles`, `watch`, `canonicalPath`, `exists`, `createDir`, `remove`, `createTempDir`, `createTempFile`, `exec(cmd: string | readonly string[], {cwd, env, inheritEnv, timeout, onOutput, spill, window}, ctx): Result<{exitCode, spillPath?}, ExecutionError>`, `cleanup`. Every call takes a chord `Context` and returns a `Result`; an argv array runs without a shell, which is how Cairn runs `git` safely.
- `NodeExecutionEnv({cwd, shellPath?, shellEnv?, watch?})`: all local instances share one `id`, so `edit` and `write` serialize per path across threads. It has no `listFiles`. pi-env's `LocalExecutionEnv` adds it through a local daemon `Connection`. The Phase 1 `@` completion can use `git ls-files` and `fd` through `env.exec` without the daemon.
- A host thread's arms = a `NodeExecutionEnv` whose `cwd` is the conversation's `pi.agent.cwd`: the project root, or a git worktree Cairn created first. A new env object per call is fine. Cairn passes `shellEnv` without Cairn-private variables (v1: `shellEnv()` drops `CAIRN_*`).
- Per-conversation arms for stones (Phase 3): a conversation document read in `env({conversationId, read})`, as in pi-durable's `test/examples/29-sandbox-per-conversation.ts`, with `fork: "initial"`. Child conversations need the document copied in `conversationCreated`. Spike 1 returns pi-env's `RemoteExecutionEnv` this way, and reference material (skills, `~/Developer/clones`) needs a path-routed read-only env in front of it.
- `registerEnvConformance({describe, expect, it}, name, withEnv, {shell?, symlinks?, listFiles?})` from `/testing` judges any env (29 cases in spike 1).

### Storage

- `openNodeSqliteStorage(path, {prefix?, walAutoCheckpointPages?, busyTimeoutMs?})` uses built-in `node:sqlite` (Node 26.11 here), WAL, `synchronous = NORMAL`, `BEGIN IMMEDIATE` (`chord/dist/sqlite/node.js` lines 112 and 159 to 161). No native module. `SqliteStorage.open(database, {prefix})` shares a database with host tables.
- One process owns a store; there is no cross-process lock. Any storage error is fatal to the Session.
- `Storage` also exposes read scans (`scanConversations`, `scanTasks`, `scanSubmissions`, `scanDocuments`, `entry`, `document`) for read-only viewers; keep the `Storage` object that `openNodeSqliteStorage` returns. `scanDocuments` takes an exact scope object (`{kind:"session"}` or `{kind:"conversation", conversationId}`), so "all conversations' `pi.live`" is a scan of conversations then per-conversation reads, or `inspect()`.
- `registerStorageConformance` exists for custom storages. Cairn uses the shipped one.
- Node's `sqlite.backup(db, path)` exists in 26.11.1 and takes a consistent copy of a live WAL database.
- Measured scale (faux model, 300 tokens/s per conversation): 50 conversations x 3 turns: 1.22 s wall, 2,292 commits (1,879/s), 143 MiB peak RSS, 0.8 MB file. 300 conversations x 5 turns: 6.7 s wall, 24,332 commits (3,640/s), 268 MiB, 6.7 MB. Reopen with 300 conversations: 1 ms; `resume()` plus `waitForIdle` on a quiescent store: 0 ms. 2,000 entries of 4 KB appended in one commit: 64 ms.

### Models, auth and pi's loaders

- `Models` (`@earendil-works/pi-ai`) is the interface; `ModelRuntime implements Models` (`dist/core/model-runtime.d.ts` in pi-coding-agent) adds `models.json` providers, remote catalogs, `registerProvider(id, ProviderConfigInput)` (`streamSimple`, `models`, `apiKey`, `oauth`, ...), `registerNativeProvider(provider)`, virtual models, `getProviderAuthStatus`, `isUsingSubscription`. `Provider` and `createProvider({id, auth, models, api})` are in pi-ai; `createModels({credentials, modelsStore, authContext, identity})` returns a `MutableModels` with `setProvider`.
- `CredentialStore` (pi-ai `auth/types.d.ts`): `read(id, opts)`, `list(opts)`, `modify(id, fn, opts)`, `delete(id, opts)`. `ModelRuntime.create(options)`: `credentials`, `authPath`, `modelsPath: string | null`, `modelsStore`, `modelsStorePath`, `allowModelNetwork`, `modelRefreshTimeoutMs`, `catalogBaseUrl`, `signal`, `refreshOnCreate`.
- The defaults write into the agent directory: `DefaultAuthStorage.create(authPath)` locks `auth.json` with `proper-lockfile` (a `.lock` directory beside it) on every reload, and `ensureFileExists` writes `{}` if missing; `FileModelsStore` writes `models-store.json` there; `FileSettingsStorage.withLock` locks `settings.json` even to read.
- Probed (`/tmp/brain-probe/models.mjs`, `models2.mjs`): `ModelRuntime.create({credentials: ownReadOnlyStore, modelsPath: null, modelsStore: new InMemoryModelsStore(), ...})` with a 20-line store that returns only `api_key` entries from `~/.pi/agent/auth.json`. Import of pi-coding-agent 316 ms (141 MiB RSS afterwards), `create` with `refreshOnCreate:false` 2 ms, `create` with `allowModelNetwork:true` 263 ms, `getAvailable()` 6 ms; 1,599 models known; available: `anthropic` 17 (the user's `anthropic` api key, which ADR 0002 says Cairn does not use) and `opencode-go` 29; `openai-codex` shows `configured:false` because its OAuth entry was filtered out (ADR 0009: Cairn keeps its own store for OAuth providers). The directory listing and mtimes of `~/.pi/agent` were identical before and after.
- `auth.json` today holds three entries (checked by shape only): `opencode-go` api_key literal, `anthropic` api_key literal, `openai-codex` oauth. Key values can be literals, `!command` or `$ENV` templates in pi's format (`resolveConfigValue`, not exported); Cairn's store should accept literals and reject the others until needed.
- Skills and context (probed in `/tmp/brain-probe/skills.mjs`): `SettingsManager.fromStorage(readOnlyStorage, {projectTrusted:false})` with a `withLock(scope, fn)` that reads the file and throws if `fn` returns a value; `new DefaultPackageManager({cwd, agentDir, settingsManager}).resolve(async () => "skip")` gave 142 skill entries and 12 extension entries in 417 ms with nothing spawned (a `child_process` tracer saw no calls); `loadSkills({cwd, agentDir, skillPaths: enabledPaths, includeDefaults:false})` gave 75 skills in 17 ms with 0 diagnostics; `formatSkillsForPrompt(skills, "read")` is 27,334 characters, roughly 7,000 tokens, in every conversation's system prompt (the same as the TUI).
- `DefaultResourceLoader.reload()` calls `packageManager.resolve()` with no `onMissing`, which runs `npm install` for any missing package unless `PI_OFFLINE=1`; `PI_OFFLINE` also turns off `ModelRuntime` network refresh (`modelNetworkEnabled = process.env.PI_OFFLINE === undefined`). So do not use `DefaultResourceLoader`, and do not set `PI_OFFLINE`. v1 solved this by fencing the package manager (`apps/server/src/PiConfig.ts`).
- `/skill:name args` expands to `<skill name="N" location="PATH">\nReferences are relative to BASEDIR.\n\nBODY\n</skill>` plus `\n\nARGS` (`agent-session.ts` line 2224, frontmatter stripped); `parseSkillBlock` reverses it. Cairn's `/` and `$` triggers should produce exactly this so a thread continues in pi.
- Provider call surface: the generation task passes `{...settings.stream, signal: runtime.signal, telemetry, sessionId: <pi.provider sessionId>, reasoning: thinkingLevel}` to `Models.stream` (`generation.js` lines 125 to 133). `runtime.signal` is per generation, which is the abort fix v1 spike 1 found for the bridge. The session id survives reopen, retries, reset, compaction and model changes; forks and children get a fresh one.

### Faux provider and the scripted test harness

- `fauxProvider({provider?, api?, models?: [{id, input?, contextWindow?, cost?}], tokensPerSecond?, tokenSize?: {min,max}, deferred?})` returns `{provider, models, getModel(), state, setResponses, appendResponses, getPendingResponseCount}`; a response step is an `AssistantMessage` (`fauxAssistantMessage(content, {stopReason?, errorMessage?, ...})`) or a factory `(transcriptContext, options, state, model) => AssistantMessage` (so a script can branch on the last message, on `options.sessionId` or on the call count). `fauxToolCall(name, args, {id})` and `fauxText`. `tokensPerSecond` makes it stream, which is what exercises `pi.live` partial commits. Used throughout the probes and by spikes 1, 3 and 4.
- Deterministic time: `Harness.open` takes `now` and `setTimer`, and the README says tests can pass fake timers. Sleep, retry backoff and deferred polls all go through them.
- `@earendil-works/pi-durable/testing` ships conformance for storage and envs only. There is no harness-level replay kit, so the seam suite is Cairn's.
- t3code's style (`apps/server/src/orchestration-v2/testkit/OrchestratorReplayFixtures.contract.test.ts` at `fe27e8e3`): a named scenario of commands and awaits is run once per provider variant against a recorded transcript, with per-provider output assertions. The adapter interface it judges (`packages/provider-core/src/server/ProviderAdapter.ts`) is much larger than Cairn needs, because the thread stream is pi-durable's own view and not an adapter event vocabulary.

### Footguns

Spec section 12 (`packages/durable/docs/spec.md`, 39 items) with what each means for Cairn:

| Footgun | Consequence for Cairn |
| --- | --- |
| Detached draft work | Never leave a `tx` or draft in a fire-and-forget promise; all document edits finish inside the commit callback |
| Read after write | In a commit, read table rows (conversations, entries, tasks) first, then write. `ensureThread` reads nothing and then creates, which is why it works |
| Writing to a busy conversation | Never `tx.appendEntry` into a conversation with an active run. Notes and system messages use `submit({type:"write"})`; display-only writes (kind and data only) append at once |
| Queued items after a failed run | A failed turn leaves follow-ups queued and silent. Set `afterFailedRun` deliberately (recommend `keep`, shown in the UI as "queued, will run when you send again") and show queue contents from `pi.inbox` |
| Compaction spend | Each manual or background compaction costs a model request. Disable for bridge models, show spend from `pi.usage` |
| Heads and edits during compaction | Do not place edits or head writes while a compaction is live (Cairn has none in Phase 1); place before compacting |
| Summary timestamps | Do not judge staleness from message timestamps in Cairn code; use entry order |
| Raw head writes into the past | Never `tx.appendEntry` with a `head`; use write submissions |
| Double-counted subagent spend | A subagent tool never puts the child's usage in its own result (Phase 2 `agent` tool) |
| Owned work holds its owner | A tool that runs a child holds the run; background anchors are for children that must outlive Esc |
| Work created by hooks | Hooks that start work must finish creating it before the task commits its outcome; Cairn's hooks only block or rewrite |
| Compensation in abort handlers | Abort handlers of Cairn tasks cannot create owned children; clean up inline or via background conversation-owned tasks |
| Hook memo names | Prefix hook memo names (`cairn.guard.*`) |
| Long transactions | Never await a model, tool, process, network, human or another commit inside `commit()`. `ensureThread` does only document and table ops. Git worktree creation happens before it |
| Reads inside a commit | Inside `commit`, read through `tx`. Never call `harness.snapshot`, `documentState`, `watchDoc` or `getTask` there; it hangs intermittently |
| Explicit creation | Only `tx.doc(token)` creates a document; `snapshot` returns `undefined` for an absent one. Every reader of a Cairn doc handles `undefined` |
| Family initialization | The seed of a family key is read once. `cairn.thread` receipt seeds `{conversationId: 0}` and the creator sets it in the same commit |
| Checkpoint starvation | Every Cairn doc gets a real `checkpointWhen`; `() => false` only for tiny, rarely changed docs |
| Wrong fork setting | Choose `fork` per doc on purpose: thread metadata `initial`, pi docs as shipped |
| Schema stability | Doc kinds and entry kinds are protocol: `cairn.*` names are permanent; migrate with `migrate`, never rename |
| Trusted immutable revisions | Never mutate a snapshot, state or watch value. The wire projector copies |
| Watch activation | Initialize the wire stream from `watch.value`, then `start()` |
| Buffered watches | Expect root replacement frames; the client reducer and the wire schema must allow `["r", view]` at any time. Do not build audit features on watch frames; use entries |
| Watch stop | `await stop()` in the stream finalizer; a running callback is not joined |
| Durable progress cadence | At most 100 ms of streamed text can be lost to a crash. The UI never claims more |
| Large terminal results | Task outcomes carry ids, not payloads; workflows put big results in entries or docs |
| Raw transcript | View entries are not model context; the UI reducer must apply edits, hide `pi.system`, and filter display-only kinds |
| Reserved `pi.` names | Cairn kinds are `cairn.*` only, task names `cairn.*` |
| Early resource disposal | When reloading an extension (skills, MCP), do not close the old client while calls still run; drain first |
| Guards left out of a selection | Never write a `extensions: [...]` array on a conversation. Leave selection to the default (every installed extension) and vary behaviour by document, not by selection. Subagent selections are computed from the resolved agent |
| Selection edits and copies | `{add, remove}` on a child replaces the owner's copied selection with the host default plus the edit; compute the array from `await owner.agent(ctx)` |
| Copies are one-time | A child copies its owner's `pi.agent` at creation; later model changes on the parent do not reach it |
| Environment on recovery | A rerun after a crash builds the env from the conversation's current `cwd`. Change `cwd` (worktree handoff) only while idle, in one `configure` |
| Moving default selections | Installing or uninstalling an extension, or changing `settings.extensions`, appends `pi.system` entries to every conversation on the default selection and misses the cache once. Install the full set in a fixed order at boot, then never churn the registry |
| Unstable prompt text | Section renderers must be pure over committed state. No clock, no counters. Skills render sorted (v1) so an unchanged tree gives identical text |
| Non-cooperative code at close | Every Cairn tool honours `ctx.abortSignal`. Close with a timeout (v1 used 5 s) and accept a counted restart if it expires |
| Objects outliving the Harness | Dispose watches, task graph watches and view states before `close()` |
| Fatal storage errors | A supervisor reopens the Harness after `closed` resolves `failed`, with backoff, and every client stream restarts from a fresh snapshot |
| JSONL durability | Not used (SQLite only) |

Additional hazards found in the installed 1.4.0 source and by probes:

| Hazard | Consequence |
| --- | --- |
| `ModelRuntime.create()` defaults lock and write `auth.json`, `models-store.json` in the agent dir | Always pass `credentials` and `modelsStore`, and `modelsPath: null` or a read-only path. Never pass `authPath` |
| `SettingsManager.create(cwd, agentDir)` locks `settings.json` even to read; setters and `getOrCreateDeviceId()` write it | Use `fromStorage` with a read-only storage; call no setters |
| `DefaultResourceLoader` and `DefaultPackageManager.resolve()` install missing packages | Use `resolve(async () => "skip")` only |
| `PI_OFFLINE=1` is the pi switch for "do not install" and also kills catalog refresh | Leave it unset |
| Coding tools default `replay: "unsafe"` | Wrap `read` safe; keep `write`, `edit`, `bash` unsafe |
| Provider calls carry only `sessionId` | Bridge side tables key by session id; derive its empty `cwd` from it (`<data>/claude-cwd/<sessionId>`) |
| `settings.stream` is harness-wide and frozen into each request checkpoint | No per-thread provider options through settings; use `pi.agent` and docs |
| `view.entries` is the whole active range | Window it and elide image bytes before it reaches a client (8.3 MB for 2,000 entries, 1.3 MB per 1 MB image) |
| `abortTask(run)` and `conversation.abort` differ on queued inputs | Choose per UX and test both |
| Default codemode deadline is 300 s including tool time | One sandbox with `timeoutMs: Infinity`, plus a `beforeTool` guard that blocks scripts carrying `timeout_ms` (ADR 0012) |
| Pi compaction applies to bridge models | Per-model override `{enabled: false, backgroundTokens: 0}` |
| A store has no delete for conversations, entries or documents | Threads are archived by Cairn (tombstone in Cairn's DB, never opened again); data stays until the file is rebuilt |
| `ExecutionEnv.id` is one constant for every `NodeExecutionEnv` | Fine for path-keyed mutation queues; a routed env must set its own id |

## What Cairn should build

Layout: `apps/server/src/brain/` as a composition-local folder (S6: move to a package when a second consumer appears). Modules are PascalCase named after their main export (S5), each an Effect service with a `static readonly layer` (ADR 0004) around the promise APIs; v1's `Harnesses.ts` shows the `Effect.tryPromise`, `Stream.callback` plus `Effect.acquireRelease` wrapping to re-cut. Wire schemas shared with the web client go to `packages/protocol` (v1 `packages/protocol/src/view.ts` shows `Op`, `Entry`, `ConversationView` as Effect schemas; the JSON Schema export for a later GPUI client comes from there).

| Module | Purpose | Port source |
| --- | --- | --- |
| `brain/BrainStore.ts` | Opens `<data>/brain.sqlite` (NVMe under `/home`, not the NAS) with `openNodeSqliteStorage`, keeps the `Storage` handle for scans, stamps the pi-durable version in Cairn's DB, and before `open` copies the file with `sqlite.backup` to `<data>/backups/brain-<version>-<timestamp>.sqlite` whenever the stamped version differs (the migration to schema 2 is one-way; ADR 0001 consequence), plus a daily rolling backup | New |
| `brain/Brain.ts` | Owns the Harness: registry install, `Harness.open`, `resume()`, boot repairs (`retryTask` for tasks whose approval is pending), `closed` supervisor with backoff, SIGTERM close with a 5 s timeout, `onReport` to Effect logs and the parked list | `cairn-v1/apps/server/src/Harnesses.ts` (open and close), `spikes/3-workflows/brain.ts`, `spikes/4-approvals/brain.ts` |
| `brain/HarnessSeam.ts` | The seam service interface and its errors (below) | t3code `ProviderAdapter.ts` only as a shape reference; do not port its event vocabulary |
| `brain/PiDurableHarness.ts` | Layer implementing the seam over `Brain` | v1 `Harnesses.ts` (`submitInput`, `watch`, `abort`) |
| `brain/ScriptedHarness.ts` | Layer implementing the seam from golden transcripts, no pi-durable | New |
| `brain/CairnDocs.ts` | Document definitions: `cairn.thread` (session family, key thread id, `{conversationId}`) as the creation receipt; `cairn.thread-meta` (conversation, `fork:"initial"`, `{threadId, projectId}`) so the store is self-describing and a lost Cairn DB can be re-linked; `cairn.claude-session` (session family keyed by pi session id, Claude `session_id`, ADR 0002); later `cairn.approvals` (ADR 0013, shape from spike 4), `cairn.child` | Spike 4 `Approvals` doc; v1 `ChildDoc` |
| `brain/Registry.ts` | Installs, once and in a fixed order: `coding-tools` (wrapped, below), `cairn` identity section, `skills`, `context`, `codemode`, `tool-search`, the Executor proxy, the permission guard. No per-thread registries: hooks and sections get `conversationId` and read `cairn.thread-meta` | v1 `Registry.ts` (order and comments), minus `withThreadExtensions` which only existed for store-per-thread |
| `brain/CodingTools.ts` | `defineExtension({name: "coding-tools", tools: [createReadTool({images}), createWriteTool(), createEditTool(), createBashTool({prepare})]})` with `read` wrapped `replay:"safe"` via `wrapTool`; `prepare` strips Cairn-private env; add thin `grep`, `find`, `ls` tools over `env.exec(["rg" | "fd", ...])` (argv, `replay:"safe"`) because the user's TUI has them and a model without them shells out through `bash` | New |
| `brain/CodeMode.ts` | One `CodemodeSandbox({memoryLimitBytes, timeoutMs: Infinity, acquireWorker})` (a semaphore on worker threads), `createCodemodeExtension({sandbox, models: false, inlineBudget: 1500, namespaces})` as v1 did, and a `hook(ToolTask, {beforeTool})` that blocks a `codemode` call whose source has `timeout_ms` (`parseCodemodeSource`) | v1 `Registry.ts` `codemode` block, spike 3 |
| `brain/Arms.ts` | `HarnessOptions.env`: `NodeExecutionEnv({cwd, shellEnv})` from the conversation's `cwd`; Phase 3 reads a `cairn.arms` doc and returns the routed remote env | v1 `Harnesses.ts` env, spike 1 `stone.ts`, pi-durable example 29 |
| `brain/Models.ts` | `CairnCredentialStore` (reads `api_key` entries of `~/.pi/agent/auth.json` read-only, hides `anthropic` per ADR 0002, adds Cairn's own OAuth store per ADR 0009), `ModelRuntime.create` with it and an in-memory or Cairn-file `ModelsStore`, `allowModelNetwork: true, modelRefreshTimeoutMs: 3000`, bridge registration (`registerNativeProvider` or `registerProvider(id, {streamSimple, models})`), model listing, defaults and thinking-level clamps | v1 `Models.ts` (`listing`, `defaultsOf`, `clampTo`, `fitDown`), v1 `providers.ts` (refused providers) |
| `brain/PiConfig.ts` | Read-only view of `~/.pi/agent`: `SettingsManager.fromStorage`, `DefaultPackageManager.resolve(skip)`, cached against mtimes (a resolve is 417 ms), default model and thinking, `HarnessSettings` getters mapped from pi's settings | v1 `PiConfig.ts` (trim extension hosting) |
| `brain/Skills.ts`, `brain/ProjectContext.ts` | The `skills` and `context` sections: user skills from `PiConfig`, project skills first, sorted by name, 27 KB budget watched; AGENTS.md files via `loadProjectContextFiles`, plus `APPEND_SYSTEM.md`; the Claude preamble filter; `expandSkillCommand` producing the exact `<skill ...>` block | v1 `Skills.ts`, `PiContext.ts`, `claude/prompt-safety.ts` |
| `brain/ThreadWire.ts` | The wire projection: whitelist docs (`pi.agent`, `pi.live`, `pi.inbox`, `pi.usage`, and chosen `cairn.*`), hide `pi.provider` and `pi.system`, window `entries` to the last N with `hasMoreBefore`, elide image bytes to `cairn-image:<entryId>/<msg>/<block>` refs served by a signed GET, and emit frames as `diffRevisions(prevWindow, nextWindow)` (an unchanged 80 entry window diffs in about 10 µs; measure a changing one before relying on it) with a periodic or on-overflow `["r", ...]` base | v1 `visible.ts` as the starting point, new windowing |
| `brain/ThreadFeed.ts` | Pages older history through `conversation.entries({maxEntryId}, limit, cursor)` for the same projection; a `subscribeCommits` reducer feeding the shell stream (status, last activity, queue length, unread, parked), with a boot reconcile from `inspect()` | New; v1 `statuses` is the idea |
| `brain/Parked.ts` | `onReport` `task_parked` plus `watchTaskGraph` `blocked: "restart_limit"` into a list for the UI, and `retry(taskId)` calling `harness.retryTask` | Spike 3 `/retry` |
| `brain/AttachmentContent.ts` | Turns an upload into model content: images shrunk with the Photon processor to `DEFAULT_IMAGE_LIMITS`, documents to extracted text blocks with a path hint | New |

The seam (`HarnessSeam`), minimal and thread-keyed. Names follow the glossary; each operation maps to the pi-durable call in brackets:

- `ensureThread({threadId, projectId, model, thinking, cwd, instructions?})` [session family receipt + `createConversation` + `configure` in one commit, idempotent]
- `configure(threadId, change)` [`conversation.configure`; `cwd` only when idle]
- `submit(threadId, {requestId, content, entry, whenBusy})` and `settled(submission)` [`submit`, `wait`]
- `stop(threadId, {clearQueue})` [`conversation.abort` or `abortTask(run)`], `withdraw(threadId, submissionId)` [`abortSubmission`]
- `watch(threadId): Stream<ThreadFrame>` where a frame is `Snapshot(view)` or `Ops(ops)` [`watch`, then `ThreadWire`], `page(threadId, {before, limit})` [`entries`]
- `fork(threadId, atEntry, {cwd})`, `reset`, `compact` [`fork`, `reset`, `compact`]
- `statuses: Stream<ThreadStatus>` [`subscribeCommits`], `parked: Stream<ParkedTask>`, `retry(taskId)`
- `usage(threadId?)` [`pi.usage` doc, `harness.usage`]
- Phase 2 additions: `spawn`, `answerApproval`, workflows; each is a tool plus a doc, not a new loop (ADR 0001).

Boot order (from the spikes, in this sequence): back up if the version changed, open `Storage`, build `Models` and `PiConfig`, register the bridge, build the registry, `Harness.open`, boot repairs (`inspect()`, `retryTask` for pending approvals, decline orphaned Executor approvals), `resume()`, start the commit feed, then accept connections. Shutdown reverses it: stop accepting, dispose watches and views, tell the bridge it is closing (v1 `claude.beginClosing`) so aborts do not mark Claude sessions for rebuild, `harness.close` with a timeout.

Dependencies to add to `apps/server/package.json` (all `catalog:`): `@earendil-works/pi-durable`, `pi-ai`, `pi-codemode`, `chord`, `pi-mcp` (already at the root), and `pi-coding-agent` once added to the catalog. `pi-env` waits for Phase 3 unless `LocalExecutionEnv` is chosen for host threads.

Every ported file starts with the source header: `cairn-v1` path at `1a5cd4a` (the user's own repo), and for anything taken from pi (examples 22, 23, 29, `skills.ts` format, `_expandSkillCommand`) `earendil-works/pi@4a080252` with the MIT notice.

## Risks and open questions

Each has my recommendation; the first two shape everything else.

1. One store or one store per thread? Recommend one: `brain.sqlite`, every thread an ownerless conversation created through the receipt. Evidence: 300 concurrent streaming conversations commit 3,640 per second and use 268 MiB; boot is one `Harness.open` plus one `inspect()`, where per-thread stores would need N opens at every boot just to resume work and retry approvals; approvals, usage totals and commit-fed shell state are single-document or single-subscription; hooks need no per-thread closures. Cost: no deletion (tombstone threads in Cairn's DB and never open them), a fatal storage error stops all threads (same disk either way, so no real loss), and a thread cannot be backed up alone (use whole-file backups). Revisit only if the file passes a few GB.
2. Same SQLite file as Cairn's own tables? Recommend separate files (`brain.sqlite`, `cairn.sqlite`). Reason: pi-durable's `NodeSqliteDatabase` serializes on one connection with `BEGIN IMMEDIATE`; a second connection from Effect SQL would contend, and a pi bump needs only `brain.sqlite` backed up and restored. The `prefix` option exists for hosts that cannot have two files (Durable Objects).
3. Depend on pi-coding-agent? Recommend yes, narrowly (ModelRuntime, SettingsManager, DefaultPackageManager, loadSkills, formatSkillsForPrompt, loadProjectContextFiles, getAgentDir). Import costs 316 ms and 141 MiB RSS and 26 MB on disk, accepted by v1. Without it Cairn would copy model-runtime (1,049 lines), provider-composer, skills and package-manager code. Add it to the catalog so it moves with the others. pi-ai alone (`createModels`, `builtinModels`) is the fallback for models if the dependency becomes a problem.
4. How does the bridge get a cwd and persist the Claude session id with only a `sessionId`? Recommend `cairn.claude-session` as a session-scoped family doc keyed by the pi session id (committed with `harness.commit` from provider code, outside any commit) and a deterministic empty cwd `<data>/claude-cwd/<sessionId>`. A per-thread cwd is not needed because the child runs `tools: []` and `settingSources: []`. Per-generation abort signals still need one signal per conversation held by the bridge, keyed by session id.
5. Wire size. Recommend the `ThreadWire` projection above, with a budget judge: a 2,000 entry thread with 20 pasted images loads as one snapshot under 200 KB and the first interactive frame under 1 s on the tailnet. Fallback if diffing windows proves wrong: keep the pi ops stream and window by sending only the snapshot's tail plus `entries` ops with a client-side index offset. Images: shrink at upload (Photon, limits 2000x2000 px and 4.5 MB base64), then elide on the wire. A phone screenshot as base64 JPEG is a few hundred KB; a day of 50 screenshots is tens of MB in the store, which is acceptable on NVMe but not free.
6. Stop button semantics. Recommend following t3code at `fe27e8e3`: read how its interrupt treats queued messages, then choose `abortTask(run)` (keeps the queue) or `conversation.abort` (clears it); keep both in the seam as `stop({clearQueue})`.
7. Pi compaction versus Claude Code's native context. Recommend per-model override that disables pi compaction for every `claude-bridge/*` model, and leave pi compaction on for API models. The bridge notes should confirm Claude Code's own limits are surfaced.
8. Forks on the bridge. `conversation.fork` gives the fork a fresh pi session id, which loses Claude's native transcript (v1 `claude/native-fork.ts`, 944 lines, rebuilt it natively). Recommend: Phase 1 forks work for API models; for bridge models either fork Claude's session natively (port v1) or start the fork with a handoff summary, decided in the bridge notes.
9. Approvals in Phase 2 versus the crash-loop guard. Spike 4's design stays; the boot repair is `inspect()` then `retryTask` for each parked task whose approval record is still pending. A gated `bash` is a replay-safe wrapper around the unsafe inner tool with a `started` memo, written with `wrapTool`. Guards must live in the default selection (footgun "guards left out of a selection").
10. Which `identity`? Recommend leave the default (pi attribution) for OpenRouter and OpenCode Go: the user runs pi, and attribution affects free-tier routing in unknown ways. Revisit if a provider objects.
11. Meaning of "scripted test harness". The kickoff and ADR 0001 do not say whether it is a fake loop or pi-durable with scripted models. Recommend both layers: pi-durable plus faux is the real implementation's scripted mode, and `ScriptedHarness` is an independent implementation of `HarnessSeam` that replays golden transcripts. The goldens are normalized projections (entry kinds and roles, tool names and error flags, submission statuses, inbox contents, agent model, `pi.live` run presence; ids and timestamps masked), recorded by running each scenario on pi-durable plus faux. The same scenario then runs against `ScriptedHarness`, and a mismatch on either side fails. This also gives the screenshot harness and the web client a deterministic backend.
12. Shell stream versus pi state. Recommend deriving it from `subscribeCommits` into Cairn's event-sourced tables (sequence numbers, `afterSequence` resume as in ADR 0007), never from polling watches per thread; reconcile at boot from `inspect()` and thread rows.
13. File completion (`@`). Recommend `git ls-files` with an `fd` fallback via `env.exec` argv in Phase 1; adopt `LocalExecutionEnv.listFiles` only when Phase 3 wants identical host and stone code.
14. Memory and retention. Keep the defaults (10 minutes) for now. A reopen is cheap enough that nothing needs a thread-count cap. Re-measure with real thread sizes after a week of use.
15. Pi version bumps. Stamp the version, back up automatically, and read the new `CHANGELOG.md [Unreleased]` and section 12 diff on every bump. Do not allow `pnpm update` to move the `@earendil-works/*` catalog without that; a test can assert `CURRENT_SQLITE_SCHEMA_VERSION` equals the number the code was written for.
16. Skills prompt weight. 27 KB (about 7,000 tokens) in every thread. Recommend keeping pi's behaviour for parity, and showing the size in a settings view; if cost matters, the lever is the user's own `settings.skills` filters, which Cairn already honours.
17. Clocks. S8 forbids `Date.now()`; pass `now` and `setTimer` backed by Effect's `Clock` in tests so sleeps, retries and approval expiry run on `TestClock`. pi-durable itself uses the supplied `now` for sleep deadlines, so production must pass the real clock consistently across restarts.
18. Unverified here: the Claude bridge under pi-durable 1.4.0 (spike 0 measured the SDK child, not the full path), real-model behaviour of `read` as safe (a rerun after a crash is harmless by construction but is not covered by a run), and a `kill -9` of the brain with 300 live conversations (spikes 3 and 4 killed a handful).

## Judges

Each claim needs an outside judge; these are the ones this area owns. Commands are suggestions for names under `judges/` and `apps/server/test/`.

1. Harness seam conformance (`pnpm test`, vitest with `@effect/vitest`): `HarnessSeam.conformance.ts` exports `registerHarnessConformance(runner, name, makeHarness)` in the shape of pi-durable's `registerStorageConformance`; one test file runs it against `PiDurableHarness` (real Harness, `MemoryStorage` or temp SQLite, faux provider with fake `now` and `setTimer`) and against `ScriptedHarness`. Scenarios: plain turn, tool call, steer while busy, follow-up queue and withdraw, `whenBusy:"reject"`, stop with and without clearing the queue, reset, fork, duplicate `requestId`, attachments as image content, failed model run with `afterFailedRun: keep`, thread creation raced twice. Pass: both implementations match the committed goldens.
2. Durability (`judges/kill-brain.sh`, generalizing `spikes/3-workflows/judge.sh` and `spikes/4-approvals/judge.sh`): `kill -9` while streaming, mid `bash`, mid `read`, with a queued follow-up, with a pending approval, during `ensureThread`; restart; assert no committed work lost, `bash` reported `interrupted` and not rerun (effect log outside the store), `read` rerun silently, queue intact, and the web client's view converges to `viewState()` within 2 s (the target). Add the five-kill case (parked, then retried) and the six clean-SIGTERM case (nothing parked).
3. Wire convergence (`apps/server/test/ThreadWire.test.ts`): feed random op streams including overflow `["r"]` frames through `ThreadWire` and a client reducer built on `applyImmutable`; assert the client equals the server's windowed view after every frame, after reconnects (fresh snapshot), and after `entries()` paging.
4. Wire budget (same file or `judges/wire-budget.ts`): a 2,000 entry thread with 20 images produces a snapshot under 200 KB with no base64 payloads; image GET returns the original bytes; cold load measured on the phone against the load target.
5. Read-only config (`judges/pi-readonly.sh`): list and stat everything under `~/.pi/agent` before and after a full brain boot, a model listing, a skills render, a turn on an API model and a clean shutdown; assert identical, and assert no `.lock` entries and no child process named `npm`. This is the check the probes ran by hand.
6. Auth shape (unit test): the credential store returns `api_key` entries only, hides `anthropic`, never returns `openai-codex` from pi's file, and its `modify` and `delete` throw on the pi-backed half. Never print values; assert on provider ids and `type`.
7. Backup on bump (unit test): with a stamped older version, `BrainStore.open` writes a backup that passes `PRAGMA integrity_check` and opens under the stamped version's expectations before migrating.
8. Tool replay policy (unit test over the registry snapshot): `read`, `grep`, `find`, `ls` safe; `write`, `edit`, `bash` unsafe; a `codemode` call with `timeout_ms` is blocked; scripts without it run.
9. Footgun lint (`oxlint` rule or a grep test): no `Date.now()` in brain code (S8), no `harness.snapshot`, `documentState`, `watchDoc` or `getTask` inside a `commit(` callback, no `tx.appendEntry(` outside Cairn tasks, no `extensions: [` in `configure` calls, no `pi.`-prefixed kinds defined by Cairn.
10. Boot budget (judge script): cold boot to accepting connections under 3 s with 300 conversations (measured parts today: pi-coding-agent import 316 ms, `ModelRuntime.create` 263 ms, skills resolve 417 ms, `Harness.open` plus resume a few ms).
11. Scale smoke (`judges/brain-scale.ts`, the probe made permanent): 300 conversations streaming through faux commit above 2,000 per second at under 400 MiB, so a pi bump that regresses the Session line shows up before the user does.

Reproducing the probes: they were five short ESM scripts against `@earendil-works/pi-durable`, `pi-ai`, `chord` and `pi-coding-agent` 1.4.0 installed with `npm install --ignore-scripts` in a scratch directory (scale, watch and paging, abort, ensure-thread, models and skills). The model, skills and read-only checks used only provider ids, entry types and counts, never credential values.
