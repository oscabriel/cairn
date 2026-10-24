# Daily-use review: hangs, performance and display

2026-10-23. The user's first day using Cairn as a daily driver turned up three symptoms: a Claude thread that hung on "Working" until stopped, "This thread does not exist." right after launching a thread from the hero, and a pasted image showing two chips plus a model-facing path line in the user's bubble. A review workflow ran five read-only area reviewers (bridge hangs, brain hangs, client state, client performance, server performance), each followed by a skeptic that tried to refute every finding against the code, the live stores and the journal. 41 findings came back: 29 confirmed, 11 plausible, 1 refuted. After merging duplicates (the launch race was found by four reviewers, the attachment display by three) they come to the tasks below, in the order to do them.

Every symptom the user saw has a confirmed cause. Task 1 is critical: any Claude turn where the model calls two tools at once hangs.

## What was checked and found sound

So the next look starts elsewhere:

- **Bridge:** result and child-exit handling, abort classification, retry texts, slot permits on normal paths, transcript reads (170 to 220 ms on a 108 MB transcript), event decoding.
- **Brain:** commit feed, the shell projector's lock, window, rebase and boot reconcile. Every thread row in `cairn.sqlite` was idle with an empty queue.
- **Client:** outbox dedup and acknowledgement across epochs, the reconnect state machine. Foldkit freezes the model and records history only in dev. Subscription fan-out is about 49 µs per model change.
- **Server:** thread stream projection is cheap on a synthetic 2,000-entry thread (snapshot 3.9 ms, 0.06 ms per tick).

The reviewers' throwaway reproductions and benchmarks are in `/tmp/cairn-review`, `/tmp/cairn-skeptic` and `/tmp/cairn-bench`. They are not kept.

## Before the working day

### 1. Parallel tool calls hang a Claude thread (critical, medium)

Merges `parallel-tool-use-split`, `watchdog-suppressed-by-pending-call` and `orphan-tool-call-never-answered`. Ship these together: once the first fix lands, a parked call during an open turn is legitimate until `message_stop`, so the watchdog and orphan changes are what make any remaining desync fail fast.

- **Cause.** `ClaudeConversation.ts:439` calls `stream.toolCallArrived()`, which is `#endToolUse(true)` (`ClaudeStream.ts:303-325`). It ends the turn with only the tool calls seen so far. Claude Code runs a tool as soon as its block closes, while the rest of the message is still streaming. Once the turn has ended, later blocks are dropped (`ClaudeStream.ts:363`, `:589-591`). On thread `01a169e8`, entry 1589 in `brain.sqlite` holds one tool call (`read`). The `codemode` block was written 1 ms after the turn ended and never reached pi.
- **Why nothing caught it.** The stall predicate (`ClaudeConversation.ts:469-474`) requires `pendingCalls.size === 0`, so a parked orphan switches the watchdog off, and it stays off for that child on every later turn. pi-ai and pi-durable have no timeouts, and the MCP timeout is 4 h.
- **Fix:**
  - **Streaming path.** `toolCallArrived` only records activity. A tool-use turn ends on `message_stop`, once every id in the assistant events has been seen. The stamp's `ccUuid` then becomes the last tool_use block's uuid, which keeps resume correct (ADR 0018).
  - **Fallback path** (`:624-633`, no stream events). Gather assistant events that share a message id. End on `toolCallArrived` only when no streamed message is open. Do not use a quiet-gap timer.
  - **Watchdog.** Drop the `pendingCalls.size === 0` clause and log the pending ids when it fires. J14's held tools are unaffected, because the provider stream is closed while pi runs a tool.
  - **Orphans.** In `deliverTo`, after the previous turn has fully ended, a parked call whose id pi never received kills the child as `failed`, which is retryable and resumes from the stamp. This is better than answering it with an error the model sees. Make `piToolName` an exact match, as the MCP server already is (`ClaudeMcp.ts:303-309`).
- **Judge.** Three new vitest cases:
  - Add a `parallelToolTurn` to `ClaudeScriptKit`, using the real event order: per block, stream events then the assistant event, with the first MCP call before block 2 streams. pi's reply must hold both calls, both `callTool` fibers resolve, and the turn ends `done`. It must fail on today's code.
  - The same turn on the fallback path.
  - A watchdog case: an orphan plus silence fails the turn with `STREAM_STALLED_TEXT` after `stallAfter`.

  Live:
  - Add a `judges/claude-live.ts` case where haiku reads three files in parallel in one turn.
  - Rerun J2, since this touches the held query.

### 2. A just-launched thread says it does not exist (high, medium)

Merges `launch-subscribe-before-ensure`, `launch-subscribe-race-missing`, `launch-subscribe-race-missing-terminal` and `subscribe-races-launch`.

- **Cause.** The hero's submit queues the launch and navigates in the same update (`apps/web/src/Update.ts:518-536`). The page subscribes straight away (`page/thread/Subscription.ts:73-98`). On the server, `watchThread` (`PiDurableHarness.ts:711-722`) finds no thread receipt yet, because `ensureThread` runs in the launch's forked prepare fiber (`ThreadLaunch.ts:568-586`), and it answers NotFound. The page sets `Missing` (`page/thread/Update.ts:166-174`) and nothing reopens the stream: only a failed apply bumps `watch`. A Root launch has a window of about 13 ms. A Worktree launch has seconds, so it nearly always loses.
- **Fix, both ends.** Neither end alone closes the window:
  - **Server.** `thread.subscribe` waits while a launch for the thread is pending, polling `LaunchStore.byThread` as `Threads.send` does. It completes on a per-thread signal set after `ensureThread`, ends NotFound if the launch fails, and stays interruptible.
  - **The server's gap.** The launch row is inserted only after the validation build (`ThreadLaunch.ts:761-765`), so a subscribe during that build still misses. Either insert the row before validating, or rely on the client side.
  - **Client.** On `EndedThreadStream{missing:true}`, stay `Loading` and resubscribe with a short capped backoff while the outbox holds a Launch for the routed thread or the shell row is `preparing`. Show Missing only when neither holds. Stop when the row is gone or failed, or a deleted thread loops.
  - Keep navigation immediate, as t3code does, and don't wait for the launch acknowledgement.
- **Judge:**
  - **Server vitest** (ThreadsTestKit). A Worktree fake held on a Deferred; subscribe right after `launch` returns, and again before the launch RPC is handled. The first item must be a Snapshot.
  - **Web vitest.** Missing while a Launch is in flight leaves `Loading` and bumps `watch`.
  - **End to end.** Hero-launch 20 times, in Root and in Worktree; no frame may show "This thread does not exist.".

### 3. Image turns show two chips and the path line (medium, small)

Merges the three attachment findings.

- **Cause.** `AttachmentStage.ts:165-180` stores the image followed by the model-facing path line, as a plain text part. `readUserContent` (`packages/client-logic/src/TimelineEntries.ts:496-548`) strips only `<attachment>` blocks and skill blocks, so the path line becomes bubble text. The message row dedupes attachment names but not images (`:977-983`), so `userChips` (`RowView.ts:220-232`) draws both a file chip and an image chip.
- **Fix, client reading side only.** The model still needs the path line.
  - Put the path-line format and a parser in `protocol/Attachments.ts`, and use them in `AttachmentStage`.
  - Add one `isAddedUserPart` predicate and use it in `readUserContent`, prompt history recall and `Queue.contentText`.
  - Drop image parts whose ref is an Attachment already in `data.attachments`.
  - The parser must accept rows already stored. Entry 1563 ends at the attachment directory, not `/original`, and the line may carry a note suffix. Anchor on `[Attached image|file "` and the closing `]`.
  - Thumbnails, for t3code parity and the 3C gap, are a separate step, through the attachment route.
- **Judge:**
  - `TimelineEntries.test.ts` on entry 1563's shape: the text equals the typed text, and there is one chip.
  - Recall and Queue tests drop the line.
  - `judges/paste.ts --page` checks the bubble text.

### 4. Bridge fixes carried from spike 8 (small)

These were found earlier, in `spikes/8-cached-compaction/NOTES.md` and `pi-claude-code.md`, and are not repeated by this review except the first:

- **Fork failure logging** (`silent-fork-fallback`, `ClaudeConversation.ts:742`). Log `claude fork failed` with the reason. Before forking, poll `sdk.entries` for the stamp's uuid, bounded to a few hundred ms because it runs under the conversation lock.
- **One-shot output tokens.** Read them from the `result` event.
- **Inherited variables.** Strip `CLAUDECODE` and `CLAUDE_CODE_*` from the child environment.
- **Usage-credit guard.** Port it: `isUsingOverage` ends the turn with a non-retryable error unless a setting allows paid usage credits.

## Performance

### 5. A streaming code block is re-highlighted on every frame (medium, medium)

- **Cause.** `stream-code-retokenize`. `codeBlockView` (`apps/web/src/timeline/markdown/View.ts:148-162`) tokenizes the whole growing fence on every render, and the cache key changes with every delta. Measured with the installed shiki: 1.25 ms at 20 lines, 12 ms at 200, 25 ms at 400, per frame. The cache (`Highlight.ts:226-234`) is FIFO with no refresh on a hit.
- **Fix:**
  - Render the streaming message's last open fence as plain text, and highlight it once it closes or commits. Earlier blocks stay highlighted.
  - Keep the `OnMount(LoadHighlighting)` attribute as it is.
  - Make the cache an LRU that refreshes on a hit, and never insert the streaming block.
- **Judge:**
  - A vitest with a counting `codeToTokens` stub: 200 renders of a growing 300-line fence give at most one tokenization, then exactly one at commit.
  - Add a 300-line fence reply to the transcript-scroll fixture, and gate its longest long task.

### 6. The open diff panel re-parses and re-highlights every frame (medium, medium)

- **Cause.** `diff-panel-per-frame-parse-and-fifo-thrash`. The panel has no lazy boundary, so every root render runs `parsePatch` and `buildTurnDiffTree` (`diff/View.ts:368-384`) and builds a cache key per hunk. Past 200 highlighted hunks the FIFO cache misses every time (cyclic thrash), so every frame re-tokenizes everything. That is a hang while you type with a big diff open.
- **Fix:**
  - Memoize the parse in a one-slot module memo keyed on the patch string, as `Rows.ts` does. Keep it out of the Schema-typed model.
  - Use the same LRU as task 5, sized by bytes (t3code uses 500 entries and 50 MB).
  - Add a keyed lazy per file, rebuilt when the patch changes.
- **Judge:** a vitest that renders twice with a 300-hunk patch; the second render makes 0 tokenizations and 0 parses.

### 7. Memo boundaries at the root (medium, plausible; measure first)

- **Cause.** Merges `no-memo-boundary-feedback-renders` and `sidebar-rerenders-every-message`. `rowLazy` is the only lazy in `apps/web/src`, so the sidebar (with `partitionSidebarThreads`' filter and sort), the composer and the chat header (three `findFirst` calls over the shell's threads) are rebuilt and diffed on every frame: every delta, keystroke and tick. The skeptic found the reviewer's "three renders per delta" overstated. The measure, scroll and complete loop runs only when the streaming row's height changes, about once per wrapped line.
- **Fix:**
  - Wrap the composer in `createLazy` on `[model.composer]`.
  - Wrap the sidebar in `createLazy` on `model.sidebar` plus everything `sidebarState` reads. `model.sidebar` already carries `nowMs`, so relative times keep ticking.
  - Wrap the chat header in `createLazy` on its strings.
  - Memoize `partitionOf` by identity.
  - Don't fork `@foldkit/ui`'s scroll loop without `judges/transcript-scroll.ts`.
- **Judge:**
  - First, `judges/typing.ts --throttle 4 --busy 10` and foldkit's slow-view warnings, before and after.
  - Then a vitest using `observeLazyResolutions`: thread items and measurements cause 0 sidebar and composer view calls.

### 8. The thread stream queues a frame per commit for a slow client (low, medium)

- **Cause.** `thread-watch-unbounded-backlog`. `Stream.callback` with no buffer options (`PiDurableHarness.ts:570`) and an eager producer (`:662-690`). A starved client gets a burst of frames to replay instead of one coalesced diff, which feeds the client starvation seen in wave 5.
- **Fix.** Make it pull-driven: `Stream.fromQueue(ticks)` (sliding 1), then `Stream.mapEffect(advance)`. Keep three things: the first snapshot before ticks are wired, the end and listener-error failure, and seq numbering. A sliding buffer on the callback is wrong, because diffs are relative.
- **Judge.** A vitest with a slow consumer: 100 commits while the consumer is blocked give one coalesced frame that applies to the same final view.

### 9. Long-thread costs (low; measure on a long thread first)

None of these show at today's thread sizes. Do them when a long thread feels slow, and measure first.

- **`rowlazy-unbounded-detached-dom`** (`timeline/View.ts:31`, `Rows.ts:167`). The keyed lazy cache and `stableByThread` are never evicted. Prune both to the `SAVED_THREAD_LIMIT` set that `Model.saved` keeps.
- **`viewinputs-walk`** (`page/thread/View.ts:85`). Foldkit walks the whole thread state three times per frame. Pass the diff toggle only the newest checkpoint turn, and pass big state as top-level thunks. Don't thunk the virtual list's items.
- **`stable-rows-per-frame`** (`TimelineEntries.ts:1149-1150`, `TimelineRows.ts:958-987`). Memoize the committed reading on the pair `(older, view.entries)`, not the concatenated array. Compare rows by source identity before falling back to `Equal.equals`.

## Hardening against rarer hangs

### 10. Bridge edge cases (low, each small)

- **`stop-during-slot-wait`** (`ClaudeConversation.ts:1027`). Race `slots.acquire` with `realAbort` and release on that path. Check the abort again in `route` before starting a child.
- **`push-ack-under-lock-deadlock`** (`:1017`). Enqueue under the lock and wait for the acknowledgement outside it, raced with the child's death. Call `input.fail` in `onEnded` before taking the lock. Without this, a child dying at the wrong moment wedges the conversation until a restart.
- **`one-shot-no-watchdog`** (`ClaudeSummary.ts:388`). Add a stall timer that resets on every event and honours `retry_delay_ms`.
- **`interrupt-no-timeout-leaks-child`** (`:343`, plausible). Wrap the interrupt in `Effect.timeoutOption(2 seconds)` plus `Effect.ensuring(Scope.close)`.
- **`attach-over-open-turn-leaks-permit`** (`:618`, plausible). Fail the old sink, settle its turn Deferred and release its permit before taking a new one.
- **`kill-answers-before-interrupt`** (`:320`). Close the child before answering parked calls, which saves one full-context request per stop. Check `resumePlan`'s `answered` check first: today the "Operation aborted" result may be what satisfies it.

Judge: one scripted vitest per item in `ClaudeConversation.test.ts`, then rerun J2.

### 11. Brain edge cases (low, each small)

- **`bash-no-default-timeout`** (`CodingTools.ts:182`). Default `timeout` to 120 s, capped at 600 s, and say so in the tool description, which today says "no default timeout". Leave codemode without a deadline.
- **`launch-failure-after-submit-removes-worktree`** (`ThreadLaunch.ts:613`, `:622-647`). Track a `submitted` flag, skip cleanup and `markFailed` once it is set, and retry `launches.remove`. A leftover launch row would block `Threads.send` for that thread.
- **`stop-races-generation-handover`** (`PiDurableHarness.ts:459-471`). Retry the abort only when the new run is the same generation's handover. A run started for a queued follow-up must survive, so that stop keeps the queue.
- **`launch-double-build-and-early-log`**. Log `turn.submitted` once, after `seam.submit` succeeds, with the submission id. Keep the validation build unless a cheaper check catches everything it does, and keep `store.claim` idempotent.

### 12. Client stream and outbox robustness (low)

- **`thread-stream-failed-never-retries`** (`page/thread/Update.ts:175`, plausible). On a non-missing end, resubscribe with a capped backoff (250 ms, 1 s, 5 s), and stop on NotFound.
- **`thread-stream-stamp-lacks-thread-id`** (`:132`, plausible). Add the thread id to the stream stamp and compare it in `isCurrent`.
- **`history-page-onto-fresh-snapshot`** (`timeline/Update.ts:139`). Stamp `LoadEarlier` with its cursor, and drop a page whose cursor is stale.
- **`history-duplicates-after-compaction`** (`ThreadView.ts:232-238`). Page from the smallest id in the window, and use the same rule in `hasOlder`.
- **`working-timer-keeps-old-start`** (`RowView.ts:892`). Key the timer on `startedAt`, but check t3code's working indicator first. If it counts the whole run, today's behaviour is parity.
- **`refused-send-loses-prompt`** (`Update.ts:679`). On a non-retryable failure, hand the outbox item's input back to the composer when the composer is empty. Launch failures go back to the draft.
- **`outbox-blocked-by-launch-wait`** (`Threads.ts:102-117`). Have `Threads.send` follow the launch row to its end instead of failing after a fixed 60 s. Don't split the outbox into lanes: a thread's Launch, Dispatches and Sends must stay in order.
  - The reviewer's claim that the outbox stays parked until a reconnect was refuted: every shell item retriggers `sendNext`.
  - `outbox-head-of-line-no-timeout` (plausible) is the same issue.

### 13. The identity recheck closes sockets on a lookup failure (low, small, plausible)

`Identity.ts:157-169`: keep an admitted socket on `lookup_failed`, and refuse only on a definite answer or two consecutive failures.

## Suggested batches

1. Tasks 1 and 4: one bridge change, judged by the new vitests, the live parallel case and J2.
2. Tasks 2 and 3: launch and attachment display, judged by the vitests and the hero-launch loop.
3. Deploy, and start the working day.
4. Tasks 5 to 7: client performance, judged by `typing.ts` and `transcript-scroll.ts` before and after.
5. Tasks 8 and 10 to 13 as hardening, and task 9 when a long thread asks for it.
