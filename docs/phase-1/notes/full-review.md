# Cairn full review: task list

Commit 4b28529. Built from `merged.json` (164 kept findings, 8 refuted) across 14 slices plus the x-turn-path and x-security reviews, and mapped onto `docs/phase-1/notes/daily-use-review.md` (cited below as DU 1 to DU 13). Where a reviewer and its verifier disagree, the verifier's location, severity and fix notes win.

How to read a task. "Findings" lists `area:id`. "Judge" is the outside judge that says the task is done; it must fail on 4b28529 where that is possible. "Rerun" lists existing judges to run after the change. J numbers follow `docs/phase-1/plan.md`: J2 is the bridge `kill -9` (streaming, held tool, answer), now run as the bridge windows of `judges/durability.ts` and by `judges/claude-kill.sh`; J8 is bridge concurrency on the fake; J9 is no `claude` process outside the unit's cgroup; J10 is abort classification; J14 is the 20 minute held approval (`durability.ts --slow`). Size is S (under half a day), M (a day or so) or L (several days). Confidence is "confirmed" when the verifier traced it end to end, "plausible" when it is reachable but unproven; a task with mixed findings says which.

The order is the one asked for: hangs and lost work, then security, then wrong state the user sees, then performance, then judges that pass vacuously, then standards, design and test gaps. Within a group, tasks go by severity tier (critical and high, then medium, then low), and inside a tier cheap and certain comes before costly and speculative, unless a dependency says otherwise. Plausible-only tasks close each group. A practical batching, closer to DU's, is at the end.

## How this list maps onto the daily-use review

| DU task | Tasks here | Note |
| --- | --- | --- |
| 1 Parallel tool calls hang | T1, T2, T3 | Same fix; this review adds the open-block rule and the held-child kill. |
| 2 Launched thread does not exist | T5 | Same two-ended fix; T8 adds the permanent-failure sibling. |
| 3 Two chips and the path line | T27, T31, T54 | T27 is DU 3; T31 adds `data.text` for new rows; T54 is DU 3's thumbnail step. |
| 4 Spike 8 carry-overs | T12 | Not re-reviewed (seed 4). |
| 5 Streaming code re-highlight | T45 | Adds the late-language mount and the transcript-scroll gate. |
| 6 Diff panel per frame | T46 | Same. |
| 7 Memo boundaries at the root | T48 | DU said plausible; web-shell confirmed it applies to every message. Still measure first. |
| 8 Thread stream backlog | T49 | Same. |
| 9 Long-thread costs | T44, T47, T50 | client-logic measured linear growth with history paged in, so the memo and row work no longer wait for a long thread. |
| 10 Bridge edge cases | T13 | Three DU items (stop-during-slot-wait, attach-over-open-turn, kill-answers-before-interrupt) were not re-found but stay in T13. |
| 11 Brain edge cases | T16, T18, T11, T35 | bash timeout, failure after submit, stop handover, double build. |
| 12 Client stream and outbox | T5, T9, T10, T17, T34, T41 | Failed-stream retry, refused send, outbox and LaunchWait, working timer, paging. |
| 13 Identity recheck | T21 | Not re-found. |

The one priority disagreement: DU puts the attachment display (DU 3) in the first batch, while the order asked for here puts wrong state after security. It is cheap and high; batch it with T5 as DU does (see the batches at the end).

## Group 1: hangs and lost work

### T1. Bridge test kit can script real child shapes

- **Why.** Seed 1 slipped through because `ClaudeSdk.layerTest` and `ClaudeScriptKit` cannot express per-block assistant events, an MCP call landing between two blocks, a script that owns the prompt pump, or a cancelled `tools/call`; `ClaudeStream` has no unit test at all. T2 and T13 need these fixtures to have a red test first.
- **Findings.** bridge:test-kit-cannot-model-real-child-shapes.
- **Files.** `packages/bridge/src/ClaudeSdk.ts` (layerTest, ~:854), `packages/bridge/src/ClaudeScriptKit.ts`, new `packages/bridge/src/ClaudeStream.test.ts`.
- **Fix.** Let a script own prompt consumption (`io.takePrompt`, eager pump opt-in). Add `toolTurnBlocks` fixtures that emit, per block, the stream events and then the per-block `assistant` event, in the real order. Add a `callToolDuring` helper that fires the MCP `tools/call` between block events, and expose cancellation on `callTool`. Add one fixture where the second `tool_use` block has started streaming (partial `input_json_delta`) when the first `tools/call` arrives, to catch the partial-arguments delivery the verifier found. Write direct `ClaudeStream` tests for the force-end, the non-streaming fallback and the rejection label.
- **Judge.** The new parallel fixtures reproduce seed 1 on 4b28529: pi's reply holds one tool call instead of two, and the second `callTool` never resolves (bounded by the test clock).
- **Rerun.** `pnpm vitest run packages/bridge`.
- **Size.** M. **Confidence.** confirmed.
- **DU.** The judge half of DU 1.

### T2. Parallel tool calls end the turn on `message_stop`, not on the first call (seed 1)

- **Why.** Seed 1, the confirmed hang: any Claude turn where the model emits two `tool_use` blocks in one message (Haiku and Fable do it for independent reads) runs the first tool and then waits up to the 4 h MCP timeout, with the stall watchdog quiet. Live repro on thread 01a169e8 (read plus codemode at 17:58:11Z). Also: a held child that pi never answers is kept for the brain's lifetime.
- **Findings.** bridge:parallel-tool-calls-hang (critical), bridge:per-block-assistant-resets-toolCallIds (medium; the fallback path has the same truncation), bridge:watchdog-silenced-by-leaked-pending-call (plausible, same ignored signal), bridge:held-child-unbounded (medium).
- **Files.** `packages/bridge/src/ClaudeStream.ts` (:301-326 `#endToolUse`, :323 `toolCallArrived`, :362-365 and :589-594 drops while closed, :624-633 fallback, :754 heldWait), `packages/bridge/src/ClaudeConversation.ts` (:427-450 toolHandler, :469-474 stall predicate), `packages/bridge/src/ClaudeSdk.ts` (:353 CallTool handler ignores `extra.signal`), `packages/bridge/src/ClaudeMcp.ts` (exact tool-name match).
- **Fix.**
  - Streaming path: `toolCallArrived` only records activity. A tool-use turn ends on `message_stop` once every `tool_use` id seen in the per-block `assistant` events has been seen; the stamp's `ccUuid` is then the last block's uuid, so the cut stays message-aligned (ADR 0018).
  - Never end a turn while a block is open. Today `#done` ships an unfinished block with `{}` or partial arguments, so pi would run codemode or edit on truncated input.
  - Fallback path (no stream events): gather `assistant` events that share a message id; end on the `result` or the first block of the next message, or on `toolCallArrived` only when no streamed message is open. Recounting `toolCallIds` from `#output.content` alone is not enough. No quiet-gap timer.
  - Watchdog: drop the `pendingCalls.size === 0` clause and log the pending ids when it fires. J14 is unaffected because the provider stream is closed while pi runs a tool.
  - Orphans: in `deliverTo`, once the previous turn has fully ended, a parked call whose id pi never received kills the child as `failed` (retryable, resumes from the stamp). Honour `extra.signal` in the CallTool handler (delete from `pendingCalls`, resolve isError). Clear `pendingResults` at each `begin`/`done`. Make `piToolName` an exact match.
  - Held child: a `result` (or a new `message_start`) while `heldWait` is pending and no sink is open means the round ended without pi; kill as `failed`. Any bridge-side ceiling on `heldWait` must stay at or above `TOOL_TIMEOUT_MS`, because held approvals wait 20 minutes or more (J14).
- **Judge.** T1's fixtures, all red before and green after: parallel turn on the streaming path (pi's reply holds both calls, both `callTool` fibers resolve, the turn ends `done`); the same on the fallback path; second block mid-stream when the first call lands (no partial arguments reach pi); orphan plus silence fails with `STREAM_STALLED_TEXT` after `stallAfter`; a `result` while held and unattached leaves `hasChild` false. Live: T3's parallel case.
- **Rerun.** J2 (it touches the held query), J10, J14 once, `judges/claude-live.ts`.
- **Size.** L. **Confidence.** confirmed (watchdog part plausible).
- **Depends on.** T1. T3 can be built alongside.
- **DU.** DU 1 in full.

### T3. A live parallel-call case, with a deadline on every bridge judge

- **Why.** No judge drives a Claude turn with two `tool_use` blocks in one message, and bridge judges wait on the SDK with no deadline, so the new case would hang for 4 h on 4b28529 instead of failing.
- **Findings.** judges:no-parallel-tool-judge, judges:bridge-judges-no-deadline, judges:claude-kill-rm-before-stop (the verifier says fix it with the deadline, since timeouts make that early-failure path common).
- **Files.** `judges/claude-live.ts` (:232, :322, cleanup at :733-736), `judges/claude-reminder.ts`, `judges/claude-ttft.ts`, `judges/claude-eligibility.ts`, `judges/claude-kill.ts` (:221), `judges/load.ts` (:292-296), `judges/durability.ts`.
- **Fix.** Add a `parallel` case: 30 synthetic tools, prompt asking for two named tools in one response, `send` wrapped in a 120 s timeout that fails with the case name. Before judging results, read the session log or SDK transcript and confirm one assistant message carried two `tool_use` blocks; if Haiku serialised them, report inconclusive, not pass. Check two results committed and the reply quotes both tokens. Give every case of claude-live, claude-reminder, claude-ttft and claude-eligibility the same per-case bound, record a per-case verdict so later cases still print, and run scratch cleanup on the timeout path. In claude-kill.ts, register the cleanup finalizer before `Unit.start`. Bound load.ts's wait for the SIGTERMed brain and SIGKILL after. Optionally add a `bridge-parallel-tools` window to durability.ts so the nightly covers it.
- **Judge.** The `parallel` case fails within its bound on 4b28529 and passes after T2. `claude-live --case tools` against a bridge that drops the call prints a failed line inside the bound. After `claude-kill.ts --case streaming`, `ls ~/.claude/projects | grep claude-kill` is empty.
- **Rerun.** J2.
- **Size.** M. **Confidence.** confirmed.
- **DU.** The live judge of DU 1.

### T4. Deleting a thread (or its project) stops its run

- **Why.** ThreadDelete, ThreadArchive and ProjectDelete never stop the thread's run. The natural reaction to a hung Claude thread (seed 1) is to delete it, which keeps the held query and its slot for up to 4 h.
- **Findings.** server-shell:delete-leaves-run-alive (high).
- **Files.** `apps/server/src/rpc/ShellHandlers.ts` (:78), `apps/server/src/threads/Threads.ts` (stop), `apps/server/src/threads/StopHooks.ts`.
- **Fix.** For ThreadDelete and ProjectDelete, call `Threads.stop({clearQueue: true})` (seam stop plus stop hooks) for every targeted live thread before committing the row change, ignoring `thread_not_found`. ThreadArchive does the same (decided: archive stops the run).
- **Judge.** A ShellHandlers or Threads test over the ScriptedHarness: start a run, dispatch ThreadDelete, `seam.inspect` shows no run and a `RunTerminal{status: interrupted}` was emitted. Live: a claude-live case that deletes a thread mid tool call, and no `claude` child survives.
- **Rerun.** J9, J2.
- **Size.** S. **Confidence.** confirmed.
- **DU.** Not in DU.

### T5. A just-launched thread never shows "This thread does not exist." (seed 2)

- **Why.** Seed 2. The hero navigates to `/t/<id>` in the same update that queues the launch. The page subscribes at once, `watchThread` finds no receipt because `ensureThread` runs in the launch's forked prepare fiber, answers NotFound, and the page sets Missing for good. A Root launch has a window of about 13 ms; a Worktree launch has seconds. The same machinery leaves a non-NotFound stream failure on screen until the next reconnect.
- **Findings.** server-brain:watch-before-ensure, server-shell:subscribe-not-found-before-ensure, server-threads:subscribe-fails-while-launching, web-composer:hero-launch-navigates-before-thread-exists, web-shell:thread-missing-is-terminal (all one root cause; best location `apps/web/src/page/thread/Update.ts:172` plus `apps/server/src/rpc/ThreadStreamHandlers.ts:60`); judges:no-hero-launch-judge; web-shell:thread-failed-is-terminal (plausible); the thread-page part of web-shell:outbox-test-enshrines-stall.
- **Files.** `apps/server/src/rpc/ThreadStreamHandlers.ts`, `apps/server/src/brain/PiDurableHarness.ts` (:711-722), `apps/server/src/threads/ThreadLaunch.ts` (:568-586, :761-765), `apps/web/src/page/thread/Update.ts` (:166-176), `apps/web/src/page/thread/Subscription.ts`, the root `PageContext`, `judges/behaviour.ts`.
- **Fix.** Both ends are required; neither closes the window alone.
  - Server: in the subscribe handler, on `thread_not_found` with a live non-failed row, wait on `seam.events` for `ThreadEnsured{threadId}` (bounded by LaunchWait) and then watch. Start listening before the first receipt read so no wake-up is lost. End NotFound only when the row is gone or the launch failed.
  - The launch row is inserted only after the validation build (`ThreadLaunch.ts:761-765`), and the outbox may not have sent the Launch yet, so the server cannot tell "not yet" from "never" in that window. That is why the client half is required.
  - Client: on `EndedThreadStream{missing: true}`, stay Loading and resubscribe with a short capped backoff while the outbox holds a Launch for the routed thread or the shell row is `preparing`; show Missing only when neither holds; stop when the row is gone or failed, so a deleted thread cannot loop.
  - On a non-missing end, resubscribe with capped backoff (250 ms, 1 s, 5 s), reset on a snapshot.
  - Keep navigation immediate, as t3code does. Navigating only after the acknowledgement still races, because the ack arrives before the forked ensure.
- **Judge.** Server vitest over ThreadsTestKit with a Worktree fake held on a Deferred: subscribe right after `launch` returns, and again before the launch RPC is handled; the first item is a Snapshot. Web Thread.test story: Missing while a Launch is in flight stays Loading and bumps `watch`; a failed end schedules a resubscribe. New `hero-launch` check in `judges/behaviour.ts`: 20 hero launches in Root and Worktree; fail if "This thread does not exist." appears at any frame in the window (the seed flash lasted under a second), wait on `[data-message-role="user"]`; read one `turn.submitted` per requestId with `judges/lib/Events.ts` once T35 lands.
- **Rerun.** `judges/live-chat.ts`, `judges/reconnect.ts`.
- **Size.** M. **Confidence.** confirmed (failed-stream retry plausible).
- **DU.** DU 2, plus DU 12 thread-stream-failed-never-retries.

### T6. The brain boots through bad config and names a slow boot step

- **Why.** An unreadable or malformed `push.json` fails `Layer.launch` and crash-loops the brain under `Restart=always`, while its message says push merely stays off. A malformed `CAIRN_BRIDGE` silently turns the bridge on. A boot step that never ends leaves `/ws` answering 503 with nothing in the journal.
- **Findings.** server-models-push:vapid-file-failure-stops-boot (medium), server-models-push:cairn-bridge-flag-malformed-silently-on, server-edge:boot-has-no-slow-step-watchdog.
- **Files.** `apps/server/src/push/Vapid.ts` (:154-160, :192-198), `apps/server/src/models/BridgeProvider.ts` (:257-260), `apps/server/src/Boot.ts` (:40).
- **Fix.** `Layer.catchTag("VapidError", ...)` in `layerChosen`, falling back to `Vapid.layerEphemeral` with a `vapid_unavailable` warning naming the file (not a WebPush answering status 0, which Notifier retries three times per device). Say in the warning that subscribed devices will get 403 until they resubscribe. Log `vapid_created` only after the `wx` write succeeds, and log a non-EEXIST write failure. For `CAIRN_BRIDGE`, fail closed to `layerOff` with a `claude_bridge_flag_invalid` warning (failing boot is the same crash-loop shape), and fix the example to `OFF` or `disabled`. Fork a `boot_slow` warning naming the step in flight at about 30 s, interrupted when the step ends.
- **Judge.** Vapid.test: a corrupt `push.json` yields a built layer and the warning; Boot.test or smoke with that file reaches `ready`. BridgeProvider.test via ConfigProvider: a malformed value yields `layerOff`. Boot.test on TestClock: a resume held on a Deferred logs `boot_slow` with `step: resume`.
- **Size.** S. **Confidence.** confirmed.

### T7. A failed deploy cannot leave the live worktree half-built

- **Why.** `deploy.sh` checks out the new commit before install and build. A failed build leaves a commit the next crash restart boots half-installed, and the dist rebuild happens under the running brain. The nightly matrix runs 40 minutes from the same worktree with nothing stopping a deploy.
- **Findings.** ops-tools:deploy-checkout-before-build (medium), ops-tools:nightly-and-deploy-share-live-worktree (plausible).
- **Files.** `ops/cairn/deploy.sh` (:57-66), `judges/fixtures/durability/nightly.sh`, `ops/cairn/deploy-check.ts`.
- **Fix.** Record `prev=$(git -C "$live" rev-parse HEAD)` and arm an ERR trap that checks it back out around install and build, keeping the existing EXIT trap for `$scratch`; clear it before the restart. Build web into `dist.next` and swap with one rename (Static.ts reads per request). Write a `deployed` marker (commit plus `hello.build`) after deploy-check passes, and have `--check` compare it with HEAD. Refuse while `cairn-nightly.service` is active, and print the same in `--check`. Have nightly.sh's first JSON line carry `git rev-parse HEAD`.
- **Judge.** A deploy with the web build forced to fail: `deploy.sh --check` says the worktree is not the running commit, and a restart comes up on the previous commit. `judges/load.ts` in a loop during a deploy sees no 404 for index.html or assets. With the nightly started by hand, the deploy refuses.
- **Size.** S. **Confidence.** confirmed (nightly overlap plausible).

### T8. A launch that fails in the background says why, and keeps the first message

- **Why.** A launch that fails after a successful acknowledgement writes its reason to `lastError`, which no client view reads. A failure before ensure leaves `/t/<id>` on "This thread does not exist." for good and the first message is gone.
- **Findings.** x-turn-path:launch-failure-reason-never-shown (medium).
- **Files.** `apps/server/src/threads/ThreadLaunch.ts` (:195 markFailed), `apps/web/src/page/thread/View.ts` and Update, the root view inputs.
- **Fix.** Pass the shell row's activity and `lastError` into the thread page and prefer them over Missing when the row is `failed`. Keep the launch's initial message on the failed row (or the launch row until dismissed) and put it back in the composer for that thread. For failures after ensure, also write a display entry so the transcript says why.
- **Judge.** ThreadLaunch.test: a launch whose worktree step fails leaves a row with `lastError`. Thread.test renders the failed row's error text, not Missing. Browser: launch into a project whose branch name collides.
- **Rerun.** T5's hero-launch check.
- **Size.** M. **Confidence.** confirmed. **Depends on.** T5. **Coordinates with.** T9: putting the first message back in the composer should use T9's `restoreTurn`.
- **DU.** Not in DU.

### T9. Refused turns give the user's text back

- **Why.** A Send or Launch refused after dispatch (for example a send to a thread deleted on another device) loses the text and attachments; t3code restores them. The notice bar it raises can never be cleared. A send that waits for uploads is lost if the user switches drafts before the last upload answers.
- **Findings.** web-composer:failed-send-or-launch-loses-the-text (medium), web-shell:notice-never-clears (medium; its second half is the same bug), web-misc:waiting-send-dropped-on-draft-switch (medium).
- **Files.** `apps/web/src/Update.ts` (:686-697), `apps/web/src/composer/Update.ts`, `apps/web/src/composer/Drafts.ts`, `apps/web/src/attachments/Update.ts` (:185).
- **Fix.** Give the root a composer capability `restoreTurn(model, item)`: a refused Send goes back to `thread:<id>` and a refused Launch to `draft:<threadId>` (navigating back to `/new/<id>`), called from FailedOutboxItem when `retryable` is false. Restore only into an empty composer; otherwise offer a restore action, as t3code does. Keep the draft record until PreparedTurn. Add `DismissedNotice`, clear the notice on the next acknowledgement and on `CompletedSaveOutbox(true)`. When ReadyToSend arrives for a draft that is not open, leave a per-draft "Not sent: press Send again" notice (or keep `waitingSend` armed until the composer acknowledges it).
- **Judge.** Composer Story: PrepareLaunch failing after a send with two ready attachments and a picked model restores text, attachments and model. Root story: a non-retryable FailedOutboxItem for a Send restores the thread draft, and the notice clears on dismiss. Tray Update.test: requestSend on draft A, switch to B, succeed the upload, the send is still reported. All red today.
- **Size.** M. **Confidence.** confirmed.
- **DU.** DU 12 refused-send-loses-prompt.

### T10. The client outbox resends on its own and stops piling up visits

- **Why.** A retryable failure on a live socket schedules no resend, so the head item waits for an unrelated shell item (on an idle brain, indefinitely). `SendOutboxItem` has no timeout. The sidebar issues a `thread.visit` for the open thread on every clock tick while the brain has not echoed it, so an offline page queues dozens of Visit dispatches ahead of the next message. The existing outbox test asserts the stall.
- **Findings.** web-shell:retryable-outbox-failure-never-resent (medium), web-shell:outbox-send-has-no-timeout (plausible), web-shell:visit-dispatch-loop-offline (medium), web-shell:outbox-test-enshrines-stall (outbox and visit parts).
- **Files.** `apps/web/src/Update.ts` (:686), `apps/web/src/Command.ts` (:104), `apps/web/src/connection/Outbox.ts` and `Outbox.test.ts` (:148-171), `apps/web/src/sidebar/Update.ts` (:635).
- **Fix.** On a retryable failure, schedule a resend with `backoffDelayMs` and an attempt counter beside `outboxInFlight`, stamped with epoch and key so a stale timer cannot double-send after an ack. Time out each send above the server's LaunchWait (so more than 60 s, or whatever T17 leaves), mapped to a retryable failure; items are idempotent by key. Plan a visit only while Live and while no Visit for that thread is outstanding (keep it outstanding until the row shows `lastVisitedAt >= at`), and coalesce queued Visits per thread.
- **Judge.** Outbox.test: after a retryable failure with no other message, a timer and then `SendOutboxItem` for the same key (change the test at :148). Command test on TestClock: a send that never resolves yields a retryable FailedOutboxItem. Sidebar.test: Backoff plus three ticks yields one Visit.
- **Size.** M. **Confidence.** mixed. **Coordinates with.** T17: the client timeout must exceed the server's wait, 60 s today; if T17 makes that wait follow the launch, give the client a generous ceiling instead.
- **DU.** DU 12 (outbox-head-of-line-no-timeout is the same issue).

### T11. Stop works during a launch and across a run handover

- **Why.** The composer shows Stop while a thread is `preparing`, but `thread.stop` knows nothing of launches: before ensure it answers "does not exist", after ensure it is a no-op and the launch then starts the run anyway. Separately, `stop` reads `pi.live.run` and then aborts that task; if the run handed over to a new generation in between, the abort answers `terminal` and the stop does nothing. Both read to the user as "Stop did nothing".
- **Findings.** x-turn-path:stop-during-launch-ignored (medium, confirmed), x-turn-path:stop-lost-on-run-handover (plausible).
- **Files.** `apps/server/src/threads/Threads.ts` (:132), `apps/server/src/threads/ThreadLaunch.ts` (FiberMap of prepare fibers), `apps/server/src/brain/PiDurableHarness.ts` (:446, :459-471).
- **Fix.** Make `Threads.stop` launch-aware: with a pending launch, interrupt its prepare fiber, run clean-up and mark the row idle or `failed("stopped before start")`, keeping the first message for the composer (T8's restore path). For the handover, after `abortTask` answers `terminal`, re-read `pi.live.run` and abort again while the task id changed, bounded; retry only when the new run is the same generation's handover, so a run started for a queued follow-up survives a stop that keeps the queue.
- **Judge.** Threads.test: stop during the workspace phase leaves no RunStarted and a non-running row. PiDurableHarness test with a scripted handover on a tool round and the stop injected between read and abort: the run ends `RunTerminal{interrupted}`. Web test: Stop during `preparing` raises no NotFound notice.
- **Rerun.** J2 (stop path reaches BridgeStopHook).
- **Size.** M. **Confidence.** mixed (launch half confirmed, handover plausible).
- **DU.** DU 11 stop-races-generation-handover.

### T12. Spike 8 carry-overs

- **Why.** Known from spike 8 and excluded from this review by the brief, but on the DU list and in the same files as T2 and T13.
- **Findings.** None in this review (seed 4).
- **Files.** `packages/bridge/src/ClaudeConversation.ts` (:742 fork), `ClaudeSummary.ts`, `ClaudeGuards.ts` (childEnv), the usage-credit guard.
- **Fix.** As DU 4: log `claude fork failed` with the reason and poll `sdk.entries` for the stamp's uuid before forking (bounded, under the lock); read one-shot output tokens from the `result` event; strip `CLAUDECODE` and `CLAUDE_CODE_*` from the child env; port the `isUsingOverage` guard with no opt-out on the bridge: a bridge turn that spills into paid credits ends with a non-retryable error; paid use means picking an `anthropic` provider model (see decisions).
- **Judge.** As DU 4: unit tests per item, and J7 after the env change.
- **Rerun.** J2, J4.
- **Size.** S. **Confidence.** confirmed (spike 8).
- **DU.** DU 4.

### T13. Bridge hardening against rarer hangs

- **Why.** Each item can wedge a conversation, leak a slot or hide why a child died. A child that never pulls stdin deadlocks the conversation under its lock and hangs shutdown; a wedged child is never killed because the interrupt has no timeout; one-shot children (compaction, titles) have no watchdog; a dead child's exit code and stderr are dropped; a stale rejection labels a later failure a spent plan window.
- **Findings.** bridge:route-lock-held-across-prompt-ack (plausible), bridge:slot-permit-release-only-on-interrupt (plausible), bridge:interrupt-without-timeout-blocks-close (plausible), bridge:one-shot-no-watchdog (plausible), bridge:events-error-swallowed (confirmed), bridge:orphaned-result-after-abort-delivered (plausible), bridge:stale-rejection-label (confirmed).
- **Files.** `packages/bridge/src/ClaudeConversation.ts` (:343, :597, :858, :927, :1017-1030), `packages/bridge/src/ClaudeSummary.ts` (:388), `packages/bridge/src/ClaudeStream.ts` (:786).
- **Fix.** Push resolves on enqueue; await the acknowledgement outside the lock or not at all; `onEnded` calls `child.query.input.fail` before taking the lock. Release the slot permit with `Effect.onExit` unless the route returned Some. Interrupt with a few-second timeout, then close; for `abort` and `failed`, close without waiting. One-shot: fail when no event arrived for `stallAfter` (honouring `api_retry`), for session-less calls too. `Effect.tapError` logging "claude child stream failed" before the ignore; if a `stderr` tail is added, cap it, since it can echo prompt text. Check `isRealAbort` with a trailing tool result before the deliver branch. Clear `#rejection` in `begin()` and on success.
  Also carry DU 10's items that this review did not re-find: stop-during-slot-wait (race `slots.acquire` with the abort, check again in `route`), attach-over-open-turn-leaks-permit, kill-answers-before-interrupt (check `resumePlan`'s `answered` first).
- **Judge.** One scripted vitest per item in `ClaudeConversation.test.ts` / `ClaudeStream.test.ts`, each red on 4b28529: the route deadlock needs the script-owned pump from T1 and a child killed between turns (pointing `executable` at a missing path proves nothing).
- **Rerun.** J2, J8, J9.
- **Size.** M. **Confidence.** mixed (2 confirmed, 5 plausible; the tests are the repro). **Depends on.** T1, T2.
- **DU.** DU 10.

### T14. Loading and searching indicators that end

- **Why.** Each leaves a spinner up with no way out but a reload or another keystroke: a failed `@` file search keeps "Searching workspace files...", a stalled diff fetch or grammar import shows Loading forever, and `/t/<malformed-id>` shows "Loading the thread..." forever.
- **Findings.** web-composer:path-search-pending-sticks-after-failure (confirmed), web-timeline:no-timeouts-on-diff-fetch-and-grammar-load (plausible), web-shell:malformed-thread-id-loads-forever (confirmed).
- **Files.** `apps/web/src/composer/Update.ts` (:1163), `apps/web/src/diff/Command.ts` (:28-53), `apps/web/src/timeline/markdown/Highlight.ts` (:143-163), `apps/web/src/Update.ts` (:98).
- **Fix.** `FailedPathSearch({projectId, query, message})` clears `pending` only when the query matches, and the menu shows the error; include the epoch in the search subscription key. A 30 s timeout on FetchDiff mapped to FailedDiff with Retry; on a grammar timeout, delete the `grammarLoads` entry so a later block retries. A Thread route whose id fails to decode resolves to NotFound.
- **Judge.** Story tests: a failed search clears pending; FetchDiff past the timeout shows Failed with Retry; a never-settling grammar import is forgotten; `/t/not-an-id` shows NotFound.
- **Size.** S. **Confidence.** mixed.

### T15. ShellProjector stops spinning when the store refuses commits

- **Why.** `flushAll` loops forever and forks unbounded retry fibers while the store fails: a CPU spin, log flood and fiber leak instead of a clean not-ready.
- **Findings.** server-shell:projector-flushall-spins-on-store-failure (low).
- **Files.** `apps/server/src/shell/ShellProjector.ts` (:933).
- **Fix.** Iterate over `[...pending.keys()]` and let `schedule` own retries; keep `scheduled` set across a failed flush so `schedule` stays idempotent.
- **Judge.** ShellProjector test with an EventSink layer that fails `commitCommand`: after events on two threads, `flushAll` returns in one pass (TestClock) and one retry fiber exists per thread. The current code never returns.
- **Size.** S. **Confidence.** confirmed.

### T16. Code mode waits for a worker, and bash has a default timeout

- **Why.** Code mode refuses the fifth concurrent script outright and scripts have no deadline, so stuck scripts in one thread deny code mode to every thread. DU also found `bash` has no default timeout.
- **Findings.** server-brain:codemode-pool-starvation (low, confirmed); DU 11 bash-no-default-timeout (not re-found here).
- **Files.** `apps/server/src/brain/CodeMode.ts` (:81), `apps/server/src/brain/CodingTools.ts`.
- **Fix.** A bounded wait for a worker honouring the abort signal, plus a per-thread cap (1 or 2). No finite default deadline on scripts (it breaks rerun after a crash, a recorded decision); if wanted, a host-side watchdog that aborts. Default `bash` timeout 120 s, capped at 600 s, stated in the tool description.
- **Judge.** CodingTools.test: five concurrent scripts all complete, the fifth after one finishes; a sixth in one thread is queued or refused per the cap; bash without a timeout argument is killed at 120 s on TestClock.
- **Size.** S. **Confidence.** confirmed.
- **DU.** DU 11 bash-no-default-timeout.

### T17. `Threads.send` follows a launch to its end

- **Why.** A turn sent during a slow launch is refused Unavailable after a fixed 60 s, and each in-flight send holds the whole outbox, other threads included. A launch interrupted between the launch-row insert and ThreadCreate is acknowledged as resumed on resend but never creates the thread, and its orphan row makes every send to that id wait the full 60 s, forever.
- **Findings.** server-threads:send-wait-timeout-parks-outbox (plausible), server-threads:interrupted-launch-ack-without-thread (plausible).
- **Files.** `apps/server/src/threads/Threads.ts` (:100-117), `apps/server/src/threads/ThreadLaunch.ts` (:763), `apps/server/src/threads/LaunchStore.ts`.
- **Fix.** Expose a per-thread settled signal from ThreadLaunch that `send` awaits (poll only after a restart), and refuse at once with a specific non-retryable error when the launch row has no live fiber and no thread row. Wrap insert, ThreadCreate and the fiber start in `Effect.uninterruptible` (or `onInterrupt(launches.remove)`). Do not split the outbox into lanes; a thread's Launch, Dispatches and Sends stay in order.
- **Judge.** Threads.test with LaunchWait 250 ms and a launch finishing at 400 ms: the send lands (today ThreadNotReady). A test that interrupts `launch` after the insert and resends: one thread row and one user entry exist.
- **Size.** M. **Confidence.** plausible (the two tests are the repro).
- **DU.** DU 12 outbox-blocked-by-launch-wait.

### T18. Launch clean-up only removes what it made

- **Why.** Launch clean-up deletes the planned worktree folder recursively even when git never registered it for this repo, and worktree paths collide across repos that share a folder name: possible loss of another repo's worktree. A scratch folder is left behind when a later phase fails. DU found a failure after submit removes a worktree the run is using.
- **Findings.** x-security:launch-cleanup-removes-unowned-worktree-folder (plausible), server-threads:scratch-folder-not-released-on-failure (confirmed); DU 11 launch-failure-after-submit-removes-worktree.
- **Files.** `apps/server/src/projects/Worktrees.ts` (:562), `apps/server/src/threads/ThreadLaunch.ts` (:613-647, :643).
- **Fix.** Key the worktree folder by project id or a short hash of the repo's common dir, not its basename. In `Worktrees.remove`, delete only when git lists the folder for this repo. Record `worktreeCreated` only after `git worktree add` succeeds. Track a `submitted` flag and skip clean-up and `markFailed` once set; retry `launches.remove`. Release a scratch folder only when the failure came before `ensured`, and persist the planned folder before the mkdir.
- **Judge.** Worktrees/ThreadLaunch test: two temp repos with the same basename, a worktree in the first, a forced-resume launch in the second on the same branch; the first folder survives and the launch uses a distinct path. A scratch launch whose second build fails leaves no folder. A failure after submit leaves the worktree.
- **Size.** M. **Confidence.** mixed (the cross-repo deletion is plausible; the test is the repro).
- **DU.** DU 11 launch-failure-after-submit-removes-worktree.

### T19. One RPC boundary in the client: defects become failures, error text is capped

- **Why.** Every web Command maps RPC failures with `Effect.match`, so a server defect or an undecodable response becomes a foldkit crash view; a persisted outbox item that triggers it crash-loops every reload. Handlers pass unbounded brain text into `DisplayText` error fields (one way to get an undecodable response) and mislabel NotFound ids; attachment routes answer with cause text.
- **Findings.** x-turn-path:rpc-defect-crashes-client (plausible), server-shell:rpc-error-text-unbounded-and-mislabelled (plausible), server-edge:public-errors-carry-store-cause-text (confirmed, S35).
- **Files.** `apps/web/src/Command.ts` (:97) and every Command calling the client, `apps/server/src/rpc/ThreadCommandHandlers.ts` (:41), `apps/server/src/rpc/ShellHandlers.ts` (NotFound.id = refused.path), `apps/server/src/attachments/AttachmentStore.ts` (:153), `apps/server/src/attachments/AttachmentStage.ts` (:51).
- **Fix.** A shared `rpc(...)` helper that catches defects and decode failures into a non-retryable CallFailure ("The brain answered with an internal error"), so FailedOutboxItem drops the item with a notice; a lint or grep check that Commands use it. Server: a `publicText` helper that slices to 4,096 and strips newlines before constructing any protocol error; pass the thread id for `thread_not_found` in respond and withdraw; give AttachmentStoreError a fixed message per operation and keep the cause in the log annotation.
- **Judge.** Command test: SendOutboxItem against a layer whose `thread.send` dies yields FailedOutboxItem{retryable: false}, not a defect. Unit: `fromHarnessError` with a 10,000-char message encodes through the RPC error union. UploadTokens.test's 500 case contains no path segment.
- **Size.** M. **Confidence.** mixed (the crash-loop is plausible; the Command test is the repro).

### T20. A hung Executor connect cannot block every thread

- **Why.** A hung connect holds the one-session semaphore for 6 minutes and blocks every Executor call in every thread; interrupting leaks the connect. One rejected grant write poisons pi-mcp's provider for the process lifetime and then burns the rotated refresh token. A transient token failure is reported as needs-sign-in and pushed to the phone. A concurrent failed refresh during sign-in overwrites the PKCE verifier. None of the risky paths has a test.
- **Findings.** server-tools:connect-holds-link-six-minutes (plausible, medium), server-tools:grant-write-failure-poisons-provider (plausible, medium), server-tools:transient-refresh-failure-reads-as-sign-in (plausible), server-tools:sign-in-verifier-race-and-state-wipe (plausible), server-tools:executor-risky-paths-untested (confirmed).
- **Files.** `apps/server/src/executor/ExecutorLink.ts` (:154, :372, :449, :458), `ExecutorGrant.ts`, `GatedCall.ts` (:253), `ExecutorTools.test.ts`, `FakeExecutor.ts`.
- **Fix.** A short `Effect.timeout` on connect with `onInterrupt`/`onExit` calling `client.close()`; hold the semaphore only for the check and publish of `current`. Split timeouts (about 30 s discovery, 6 min call/execute/resume) as a follow-up. `store.save` never rejects: memory first, then SQL, log and retry on failure. Classify a failure from `token()`/`headers()` as `sent: false`. After `McpOAuthAuthorizationRequiredError`, a surviving `refresh_token` means unreachable, not needs-sign-in, and no push. Run signIn's and callback's `authorizeMcp` under the opening semaphore. Whether `takeSignIn` clears only on a matching state reverses a tested decision; leave it for the user.
- **Judge.** On ExecutorTools.test with FakeExecutor knobs (`/mcp` initialize that hangs, `failTokenOnce(502)`, a grant save that fails once): a second concurrent call fails within the connect budget; the next call after a failed save succeeds and `invalidGrants` stays 0; a 502 refresh leaves status not needs-sign-in and sends no push; the user-stop decline (write first), the sweep's background retry and a refused consent each fail when their guarded line is removed.
- **Size.** M. **Confidence.** plausible (the tests are the repro).

### T21. The identity recheck keeps a socket on a lookup failure

- **Why.** From DU 13, not re-found here: `Identity.stillAdmitted` treats `lookup_failed` as a refusal, so a Tailscale LocalAPI hiccup closes admitted sockets and forces a reconnect.
- **Findings.** None in this review.
- **Files.** `apps/server/src/http/Identity.ts` (:157-169).
- **Fix.** Keep an admitted socket on `lookup_failed`; refuse only on a definite answer or two consecutive failures.
- **Judge.** Identity.test: one `lookup_failed` keeps the socket, two close it, a definite refusal closes it.
- **Size.** S. **Confidence.** plausible (DU).
- **DU.** DU 13.

## Group 2: security

### T22. Write down that Executor scoping is advisory until threads are sandboxed

- **Why.** ExecutorScope's per-project GitHub scoping holds only for a model that uses `executor_call`. Any thread's `bash` can read the plaintext Executor grant from `cairn.sqlite` and call Executor at 127.0.0.1:4400 directly. Thread processes inherit the brain's whole environment minus a `CAIRN_` prefix, and the ops review notes pi-durable spreads `process.env` wherever `inheritEnv` is true.
- **Findings.** x-security:executor-scope-bypassable-by-thread-bash (medium), server-brain:child-env-denylist (plausible, same root: threads are not confined).
- **Files.** `apps/server/src/executor/ExecutorScope.ts` (:2), `apps/server/src/brain/Arms.ts` (:25), `apps/server/src/projects/FolderRules.ts` (wording), ADR 0003 and 0013.
- **Fix.** Option (a), now: say in ExecutorScope's header and the two ADRs that the scoping is advisory, and drop FolderRules' confinement wording. Option (b), not taken (see decisions): run thread tool processes under bubblewrap or a second uid with Cairn's data, `~/.pi/agent/auth.json` and `~/.claude` masked, and keep the grant where only the brain can read it. Strip or allowlist secret-bearing env names when OTEL headers land (S58), and keep that token where tools cannot read it either.
- **Judge.** For (a): review of the ADR text. For (b): a conformance step running a scripted thread's bash as `sqlite3 $CAIRN_DATA_DIR/cairn.sqlite 'select count(*) from executor_grant'` and `curl -s 127.0.0.1:4400`, both expected to fail; today both succeed.
- **Size.** S for (a), L for (b). **Confidence.** confirmed.

### T23. The guard applies one rule to every spelling of `/api`, and keeps routes' cache headers

- **Why.** The guard's cross-site rule and `no-store` header match the raw URL while the router matches case-insensitively, collapses slashes and percent-decodes, so `/API/...`, `//api/...` and `/%61pi/...` reach `/api` handlers without either. The same blanket `no-store` replaces the year-long private cache the attachment and entry-image routes set, so every thumbnail is refetched.
- **Findings.** x-security:guard-path-differs-from-router-path (low), server-edge:guard-no-store-overrides-route-cache (perf, same lines).
- **Files.** `apps/server/src/http/Guard.ts` (:73-84), `apps/server/src/http/Static.ts` (isReserved).
- **Fix.** Refuse every cross-site request unless `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`, so no subresource or fetch of any spelling gets through. Set `no-store` only when the route set no `cache-control`. Optionally pass `{caseSensitive: true, ignoreDuplicateSlashes: false}` to the router, or share one normaliser with `Static.isReserved`.
- **Judge.** Guard.test: GET `/API/shell`, `//api/shell` and `/%61pi/shell` with `sec-fetch-site: cross-site` each answer 403; a same-origin GET of each carries `no-store`; a stand-in `/api` route that sets `private, max-age=...` keeps it.
- **Size.** S. **Confidence.** confirmed.

### T24. The entry image route serves only image types, under a sandbox CSP, by the projection's index

- **Why.** EntryImageRoute serves an entry image under whatever `mimeType` the transcript stored, with no allowlist and no sandbox CSP, unlike AttachmentRoute. The projection and the route also number entry images differently, so a ref can point at the wrong image.
- **Findings.** x-security:entry-image-route-trusts-stored-mime (low), server-brain:entry-image-index-mismatch (plausible).
- **Files.** `apps/server/src/brain/EntryImageRoute.ts` (:49), `apps/server/src/brain/ThreadWire.ts` (:145).
- **Fix.** Serve `image/(png|jpeg|gif|webp)` inline and anything else as `application/octet-stream` with `content-disposition: attachment`; add `content-security-policy: default-src 'none'; sandbox`. Export one image walker from ThreadWire and use it in the projection and both `entryImage` implementations.
- **Judge.** Unit test with a stubbed seam returning `text/html`: octet-stream, attachment, sandbox CSP. Unit test projecting an entry with an image in `data.details` and one in content: the route serves the bytes the ref points at.
- **Size.** S. **Confidence.** mixed.

### T25. `/_cairn/auth` stops dumping headers for proxied requests

- **Why.** Unlike `/_cairn/health`, the auth route is reachable through Caddy and logs a header dump per hit.
- **Findings.** server-edge:auth-route-reachable-through-caddy (low).
- **Files.** `apps/server/src/http/Identity.ts` (:222), possibly `~/caddy/conf/Caddyfile`.
- **Fix.** Not the reviewer's `isDirectLoopback` 404: `forward_auth` is `reverse_proxy` shorthand and adds X-Forwarded-For, so it would refuse Caddy's own subrequest and lock the owner out. Log the headers of one real forward_auth subrequest first. Then skip the dump and answer 404 when the request came through the main proxy (X-Cairn-User or Via present, no X-Cairn-Peer), or keep `/_cairn/*` out of the reverse_proxy in the Caddyfile (back it up first).
- **Judge.** Identity test: GET `/_cairn/auth` shaped like a main-proxy request answers 404 and logs nothing; a forward_auth-shaped request still admits. Live: the owner still loads the app.
- **Size.** S. **Confidence.** confirmed.

### T26. Ops credential hygiene

- **Why.** Phase-0 stage 7 deletes the admin Alchemy profile (Global API Key) only after a successful deploy; a failed deploy under `set -e` leaves the root credential on disk with no reminder. The stone image workflow pins third-party actions by mutable tag while holding a Cloudflare token.
- **Findings.** ops-tools:wizard-leaves-root-cloudflare-profile-on-failure, ops-tools:ci-actions-by-tag.
- **Files.** `ops/wizards/phase-0.sh` (:306-314, :406-420), `.github/workflows/stone-image.yml` (:18, :35, :49).
- **Fix.** An EXIT trap armed at stage 6 or the top of stage 7 that deletes the profile or adds it to SKIPPED; in stage 11 treat an empty `EXECUTOR_ORG` as "cannot check" and name the probed slug. SHA-pin the three actions with the tag in a comment, or drop the buildx setup action (the runner's docker has buildx).
- **Judge.** Stage 7 with a failing deploy still deletes the profile or lists it; `grep -E 'uses: .*@[0-9a-f]{40}' .github/workflows/stone-image.yml | wc -l` is 3.
- **Size.** S. **Confidence.** confirmed.

## Group 3: wrong state the user sees

### T27. The user's bubble shows their words and one chip (seed 3)

- **Why.** Seed 3. One image renders two chips ("IMG_0606.jpg" and "Image (image/jpeg)") and the bubble shows the model-facing "[Attached image ... is saved at: ...]" line. The same model-facing content leaks into the sidebar preview and search, the queue card, up-arrow recall, and Retry (which resends the hint, so the model gets it twice).
- **Findings.** client-logic:image-attachment-double-chip (high; best location `packages/client-logic/src/TimelineEntries.ts:541` and :975-983), web-misc:user-bubble-double-chip, web-timeline:user-image-two-chips-and-hint-text, server-shell:preview-text-is-model-facing, x-turn-path:retry-resends-model-facing-hint, x-turn-path:queue-card-shows-model-facing-text, judges:no-attachment-bubble-judge, web-timeline:user-message-row-untested.
- **Files.** `packages/protocol/src/Attachments.ts`, `apps/server/src/attachments/AttachmentStage.ts` (:165-208), `packages/client-logic/src/TimelineEntries.ts` (:496-548, :975-983), `packages/client-logic/src/ComposerPromptHistory.ts` (:60), `apps/web/src/composer/Queue.ts` (:38), `apps/server/src/brain/CommitFeed.ts` (:87, messageText and latestMessageOf), `apps/web/src/timeline/RowView.ts` (:220-238, :1008), `judges/paste.ts`.
- **Fix.** Reading side only; the model still needs the path line.
  - Put the path-line template and a parser in `protocol/Attachments.ts` and use the template in AttachmentStage. The parser covers the image form and the `file` kind's note suffix (xlsx, pptx), and accepts rows already stored: entry 1563 ends at the attachment directory, not `/original`. Anchor on `[Attached image|file "` and the closing `]`.
  - One `isAddedUserPart` predicate used by `readUserContent`, prompt-history recall, `Queue.contentText`, and CommitFeed's `messageText` and `latestMessageOf` (which also join parts with `""`, gluing the typed text to the path line). Retry reads the fixed bubble text, so it is fixed too.
  - Dedupe images: a `ProjectedImage` carries `{entryId, index}`, not an attachment id, so pair the i-th image part with the i-th image-kind ref in `data.attachments`, or drop image parts whenever `data.attachments` holds image refs. Keep `images` only for entries with no refs (imported threads).
- **Judge.** TimelineEntries.test on entry 1563's shape and on the exact `buildOne` output (image part, path line, `data.attachments` ref): `text` equals the typed text, one image, no duplicate chip source (the existing test at :388-413 feeds no hint, which is why it passes). A RowView Scene test: exactly one `[data-testid=user-message-chip]` and no "[Attached image" in the bubble. Recall, Queue and CommitFeed tests drop the line (`latestVisibleMessage.text === "look"`). `judges/paste.ts` real-bridge-image asserts one attachment element and the typed text in the last user row.
- **Rerun.** `judges/paste-client.ts`, the parity structure judge.
- **Size.** M. **Confidence.** confirmed.
- **DU.** DU 3 (its thumbnails step is T54).

### T28. Thread tools see the user's PATH

- **Why.** `cairn.service` hard-codes PATH without the user's toolchains, so every thread's bash and every Claude child lacks bun, cargo and the rest.
- **Findings.** ops-tools:unit-path-drops-user-toolchains (medium).
- **Files.** `ops/cairn/cairn.service` (:18), `ops/cairn/cairn-nightly.service` (:15), `ops/cairn/install.sh`, `ops/cairn/deploy-check.ts`.
- **Fix.** Dropping the `Environment=PATH=` line only works after a login has imported PATH into the user manager. Have install.sh write `PATH=...` from `bash -lc 'echo $PATH'` into `~/.config/cairn/brain.env` (the unit already reads it), and have deploy-check log the brain's resolved PATH.
- **Judge.** A `judges/tools.ts` case runs `command -v bun cargo` through a thread's bash on the deployed unit and finds both; `judges/deployed-unit.ts` asserts the brain's PATH holds every directory of the login PATH.
- **Size.** S. **Confidence.** confirmed.

### T29. The sidebar clock is right from the first render

- **Why.** The sidebar's clock is 0 until the first tick, which is dropped, so for up to 15 s after every load ages read "now", snooze presets are computed for 1970 and the opened thread is not marked visited.
- **Findings.** web-shell:sidebar-clock-starts-at-zero (medium).
- **Files.** `apps/web/src/sidebar/Subscription.ts` (:53), sidebar init.
- **Fix.** Seed the clock from init with a ReadClock command answering Ticked. Keep `drop(1)`: it stops the render starvation recorded at waves.md:602.
- **Judge.** Sidebar.test: from `initial`, init's commands give `nowMs > 0` before any Ticked; snooze presets fall within a day of the test clock.
- **Size.** S. **Confidence.** confirmed.

### T30. Pickers take focus, and the keyboard picks only usable models

- **Why.** Popover search fields never take focus: typing after opening the model or project picker is swallowed, Enter cannot pick and Escape does not close (mouse workaround only). Once focus works, the keyboard path can pick a provider with no key.
- **Findings.** web-composer:popover-search-never-focused (medium), web-composer:keyboard-picks-unavailable-model (land together).
- **Files.** `apps/web/src/composer/Popovers.ts` (:148, :190), `apps/web/src/composer/Update.ts`, composer Subscription.
- **Fix.** A FocusPopoverSearch command (like FocusEditor) from OpenedPopover, and a document-level Escape subscription keyed on an open popover. Check WebKit: a programmatic focus outside the gesture will not raise the iOS keyboard. Filter `pickerRows` to available listings and ignore PickedModel for an unavailable one.
- **Judge.** A `judges/behaviour.ts` case: open each picker, type two letters, ArrowDown and Enter picks, Escape closes; red today. Story: ArrowDown and Enter over an unavailable-only catalog leaves the model unchanged.
- **Size.** S. **Confidence.** confirmed.

### T31. Record the typed text on `cairn.user` entries

- **Why.** The root cause behind T27: the stored user turn keeps only the model-facing content, so every surface reverse-engineers the user's words from pi's message. T27's parser stays as the fallback for stored rows; new rows get an exact record.
- **Findings.** server-edge:user-entry-carries-no-user-text (medium), server-threads:cairn-user-entry-has-no-user-text (medium).
- **Files.** `apps/server/src/threads/TurnContent.ts` (:136-137), `apps/server/src/brain/CairnDocs.ts` (CairnUserData), readers from T27.
- **Fix.** Write `data.text` from `draft.input.text` (the raw typed text, before SkillExpansionStage's `withText` replaces the block) and keep skill refs separately. Readers prefer `data.text` for `cairn.user` entries and fall back to T27's predicate. CommitFeed prefers it for previews.
- **Judge.** AttachmentStage.test "records the references on the cairn.user entry" asserts `data.text`; TurnContent.integration.test with one image yields the typed text; T27's tests keep passing on old and new shapes.
- **Size.** M. **Confidence.** confirmed. **Depends on.** T27.

### T32. Auto-settle reads the setting the UI shows

- **Why.** The `autoSettleDays` setting is stored and shown but Settlement never reads it (a known gap, now visible in the UI). Default layers like this turn missing wiring into silent runtime behaviour.
- **Findings.** server-shell:auto-settle-setting-unwired, server-shell:defaults-mask-missing-wiring.
- **Files.** `apps/server/src/shell/Settlement.ts` (:244), `apps/server/src/rpc/Handlers.ts` (:24), `apps/server/src/rpc/StubHandlers.ts`, `apps/server/src/shell/ShellLayer.ts`.
- **Fix.** Read `SettingsStore.get` on each sweep, and remove the `SettlementConfig` Reference default so a missing wiring fails to build. Delete StubHandlers (every RPC has a real handler) and add a test comparing CairnRpcs' tags with the real handlers. Drop `ProjectorSignals.layer` from ShellLayer.
- **Judge.** Settlement test: with `autoSettleDays: 0` a 10-day-quiet thread settles 0 times, with 1 it settles; red today. The wiring test fails when a handler layer is removed.
- **Size.** S. **Confidence.** confirmed.

### T33. Copy buttons tell the truth

- **Why.** Copy shows its check mark when the clipboard write was refused, and nested code blocks share copy keys so one copy lights several checks.
- **Findings.** web-timeline:copy-check-shows-on-failure, web-timeline:nested-code-copy-key-collision.
- **Files.** `apps/web/src/timeline/Command.ts` (:75-86), `apps/web/src/timeline/markdown/View.ts` (:135, :355, :397-400).
- **Fix.** `Effect.tryPromise` with a typed error; a failure message shows no check (or a toast). Key nested blocks by `path` (`code:P${path}`) and top-level ones by start line (`code:L${line}`).
- **Judge.** WebKit Playwright with clipboard denied: aria-label never becomes "Copied". Scene test: two list items with code blocks, one copy gives one "Copied".
- **Size.** S. **Confidence.** confirmed.

### T34. Small wrong-text fixes

- **Why.** A non-decoding title answer becomes the raw thread title; back-to-back turns may show a cumulative working time; search highlighting drifts on non-ASCII case-changing letters and can split an emoji at the excerpt cut.
- **Findings.** server-threads:title-fallback-uses-raw-answer, web-timeline:working-timer-keeps-first-start (plausible), client-logic:sidebar-search-unicode.
- **Files.** `apps/server/src/threads/ThreadTitles.ts` (:141), `apps/web/src/timeline/RowView.ts` (:885-894), `packages/client-logic/src/Sidebar.ts` (:538).
- **Fix.** Return none so the placeholder stays. Before keying the timer span by `String(startedAt)`, check t3code's working indicator: if it counts the whole run, today is parity (DU 12). Search with a case-insensitive RegExp over the original text (or fold ASCII only) and step the excerpt start past a trailing high surrogate.
- **Judge.** ThreadTitles.test: a non-JSON answer keeps the placeholder. A harness story committing a reply and starting the next in one tick restarts the timer near 0 s. Sidebar.test cases for "İstanbul" and an emoji-prefixed preview.
- **Size.** S. **Confidence.** mixed.
- **DU.** DU 12 working-timer-keeps-old-start.

### T35. A launch builds its turn once and logs `turn.submitted` at submit

- **Why.** The launch's validation build runs the attachment stage for real: it claims attachments before the thread row exists, reads and base64-encodes every image twice, runs skill expansion with no cwd (logging spurious `skill_not_expanded`), and writes the `turn.submitted` line that the paste judges measure, so 44 of 47 launches logged it twice. It does not cause seed 2, but it misled seed 2's diagnosis.
- **Findings.** server-edge:launch-precheck-claims-and-double-reads, server-threads:launch-builds-turn-twice, web-composer:launch-builds-turn-twice, server-tools:launch-check-build-logs-missing-project-skills. (web-misc:turn-submitted-duplicates-journal-evidence was refuted as a client double send; the pairs come from this.)
- **Files.** `apps/server/src/threads/ThreadLaunch.ts` (:761), `apps/server/src/attachments/AttachmentStage.ts` (:267), `apps/server/src/skills/SkillExpansionStage.ts` (:227), `apps/server/src/threads/Threads.ts`.
- **Fix.** Split the stage into a pure build and its side effects. The launch's check runs without claims or logs (a check mode), or passes the planned cwd. Move the claim and the `turn.submitted` line to after `seam.submit` in both ThreadLaunch and `Threads.send`, with the submission id. Keep `store.claim` idempotent. Add a sweep rule for claims whose thread row is missing.
- **Judge.** A counting stage in `TurnContent.layerFrom`: the attachment stage runs once for a non-resumed launch. AttachmentStage.test: a launch whose ThreadCreate fails after the check leaves `attachment_claims` empty. ThreadLaunch.test with a project skill: no `skill_not_expanded`, the skill block is in the content. Journal after a hero launch: one `turn.submitted` per requestId.
- **Rerun.** `judges/paste.ts` (compare send-to-submit with the old number), `judges/phone-report.ts`.
- **Size.** M. **Confidence.** confirmed.
- **DU.** DU 11 launch-double-build-and-early-log.

### T36. Push delivery: claims, keys and body reads

- **Why.** A push is claimed as sent before delivery, then delivery gives up after about 3 s or is interrupted by shutdown, so a notification can be lost for good. Malformed subscription keys fail three times per push forever. The body read sits outside the send timeout.
- **Findings.** server-models-push:push-claim-permanent-delivery-best-effort, server-models-push:subscription-keys-not-validated, server-models-push:webpush-body-read-outside-timeout (plausible).
- **Files.** `apps/server/src/push/Notifier.ts` (:343, :457-469), `apps/server/src/push/PushSubscriptions.ts` (:120-129), `apps/server/src/push/WebPush.ts` (:429-434), `apps/server/src/ShutdownHooks.ts`.
- **Fix.** Record the claim as pending, then final; a boot pass resends pending rows younger than `staleAfter` (claiming at the first 2xx instead reintroduces resend after a crash). A `shutdownHook("push settle", notifier.settle, "5 seconds")` before the harness close. Keep Notifier.test's TestClock expectations in step if the retry schedule stretches. Validate keys at upsert with Schema (65 bytes with 0x04 prefix, 16 bytes); do not delete rows on any `WebPush.encrypt` failure, since sender-side steps share that tag. Give the text read its own short `timeoutOption` falling back to "".
- **Judge.** Notifier.test: a 503 past the retry budget then 201 delivers once; a scope closed mid-send leaves a row the next build resends. PushSubscriptions test: a 10-byte p256dh is refused. WebPush.test with `it.live` and a loopback server that holds the body: a WebPushError inside 15 s.
- **Size.** M. **Confidence.** mixed.

### T37. Push on the page: badge and storage

- **Why.** The app badge written by the service worker is never cleared when the page loads with nothing unseen. Push device state reads localStorage bare inside Commands, so a storage exception becomes a defect that crashes the app at load.
- **Findings.** web-misc:badge-never-cleared-at-load, web-misc:command-defect-crashes-app-storage (plausible).
- **Files.** `apps/web/src/push/Update.ts` (:33), `apps/web/src/push/PushDevice.ts` (:275), `apps/web/public/sw.js`.
- **Fix.** Compare against `shownBadge` and treat the first inform after CheckedDevice as dirty; consider clearing on `notificationclick`. Wrap `loadDeviceId` in `Effect.try` with a per-session fallback, or route it through KeyValueStore (add it to push's Services).
- **Judge.** Pwa.test: init, CheckedDevice, inform(badge 0) yields ShowBadge; with failing storage, CheckDevice still answers CheckedDevice.
- **Size.** S. **Confidence.** mixed.

### T38. Attachment tray and drafts: retries, restore window, pruning, tests

- **Why.** 409, 400-expired and 404 upload answers hide Retry although a new URL would succeed. Saved ready attachments are restored indefinitely although the brain sweeps unclaimed uploads after 24 h. Thread drafts stay in localStorage after their thread is deleted. Restore, discard, clearSent and object URL release have no test, and the SW test is a regex over source.
- **Findings.** web-misc:retry-hidden-for-recoverable-statuses (plausible), web-misc:restored-attachments-outlive-sweep, web-composer:thread-drafts-never-pruned, web-misc:tray-tests-miss-restore-discard-revoke.
- **Files.** `apps/web/src/attachments/UploadQueue.ts` (:104), `apps/web/src/attachments/Update.ts` (:368), `apps/web/src/composer/Drafts.ts` (:174-177), `apps/web/src/attachments/Update.test.ts`, `apps/web/public/sw.js`.
- **Fix.** Treat 400 expired, 404 and 409 as retryable (each attempt mints a new URL); keep 413, 415 and size_mismatch final. Store `readyAt` with each saved ref, drop refs older than the sweep window at LoadedSaved, and drop the dead ids from the draft. Prune `thread:<id>` drafts only once the shell snapshot is Live. Add tray tests for the five paths and evaluate sw.js in a fake `self`.
- **Judge.** Unit: `sendBytes` with 409 or expired is retryable; LoadedSaved older than 24 h restores nothing; inform without thread X removes `thread:X` only when Live; each new tray test fails when its command is removed.
- **Size.** M. **Confidence.** mixed.

### T39. A parked row clears after a retry or when its task ends

- **Why.** `thread.retryTask` leaves the row parked (ShellProjector.refresh exists for this and has no caller), a parked entry outlives a task that ends without retry, and the sidebar's Retry fails silently.
- **Findings.** server-shell:retry-task-row-stays-parked (plausible), server-brain:parked-stale-and-side-effects (plausible), the silent FailedRetry part of web-shell:duplicated-failure-and-lookup-helpers.
- **Files.** `apps/server/src/rpc/ThreadStreamHandlers.ts` (:91), `apps/server/src/brain/PiDurableHarness.ts` (:902), `apps/server/src/brain/Parked.ts`, `apps/server/src/brain/CommitFeed.ts`, `apps/web/src/sidebar` retry path.
- **Fix.** Call `ShellProjector.refresh(threadId)` after a successful retry. Drop the parked id when CommitFeed sees the task go terminal, and check the ShellProjector side too. Move `parked.add` out of `inspect` into the boot path. Route the sidebar's ClickedRetry through the hold banner's command so a failure shows.
- **Judge.** Handler test: a parked row, `thread.retryTask`, `parkedTaskIds` empty after one flush. Unit: park, stop with clearQueue, `Parked.list` empty. Parked.test covers the shared web retry.
- **Size.** S. **Confidence.** plausible.

### T40. Brain small races and silent failures

- **Why.** Low-impact correctness: configure's "cwd change while running" check is a read followed by a separate commit; CommitFeed.learn swallows metadata read failures and re-reads non-thread conversations on every commit; `normalizeWorkspaceRoot`'s regex backtracks exponentially on a path with an empty segment (latent; folders.check guards today).
- **Findings.** server-brain:configure-cwd-toctou (plausible), server-brain:commitfeed-learn-silent (plausible), server-shell:workspace-root-regex-backtracking.
- **Files.** `apps/server/src/brain/PiDurableHarness.ts` (:387), `apps/server/src/brain/CommitFeed.ts` (:585), `apps/server/src/shell/ShellCommands.ts` (:310).
- **Fix.** Check and configure in one `harness.commit` if pi-durable's configure accepts a transaction. Log the learn failure with the conversation id (a negative cache waits for subagent conversations). Replace the regex with segment checks.
- **Judge.** A conformance scenario where configure races a submit never changes cwd after RunStarted; a CommitFeed test with a snapshot that rejects once logs a warning; `normalizeWorkspaceRoot("/" + "a".repeat(40) + "//")` returns none in under 10 ms.
- **Size.** S. **Confidence.** mixed.

### T41. Transcript paging stays consistent across snapshots

- **Why.** A `thread.history` page that arrives after an in-stream snapshot is prepended onto the new window, leaving a silent hole. DU found related gaps.
- **Findings.** x-turn-path:history-page-prepended-onto-new-window (plausible); DU 12 history-page-onto-fresh-snapshot (same), history-duplicates-after-compaction and thread-stream-stamp-lacks-thread-id (not re-found).
- **Files.** `apps/web/src/page/thread/Update.ts` (:132, :188), `apps/web/src/timeline/Update.ts` (:139), `packages/client-logic/src/ThreadView.ts` (:232-238).
- **Fix.** Stamp LoadEarlier with its cursor and drop a page unless the window's oldest id still equals it, then reissue from the new cursor. Page from the smallest id in the window and use the same rule in `hasOlder`. Add the thread id to the stream stamp and compare it in `isCurrent`.
- **Judge.** ThreadView test: snapshot A from id 100, request before 100, snapshot B from 180, page 50..99 arrives: state unchanged and a new request from 180.
- **Size.** M. **Confidence.** plausible.
- **DU.** DU 12 (three items).

### T42. The changed-files card covers its own turn

- **Why.** A queued follow-up starts in the same commit that ends the run, so the feed emits no RunTerminal/RunStarted between them: the first turn gets no changed-files card and the next turn's card claims both turns' edits.
- **Findings.** x-turn-path:follow-up-joins-run-no-own-checkpoint (low).
- **Files.** `apps/server/src/brain/CommitFeed.ts` (:281), `apps/server/src/git/CheckpointCapture.ts`, `GLOSSARY.md`.
- **Fix.** Per run (decided): update the glossary to say the card covers every turn in the run, including queued follow-ups.
- **Judge.** CheckpointCapture test fed the `queued_turn` golden with writes in each turn: two checkpoints, each in its own turn (or the glossary change).
- **Size.** M (per turn) or S (glossary). **Confidence.** confirmed.

## Group 4: performance

### T43. Measure the brain's memory peak

- **Why.** The deployed brain peaked at 1,056 MB in 17 h while idling near 200 MB, with no memory accounting or alert. It is the only hard number behind "performance issues abound" on the server side, and nobody can tell which thread event caused it.
- **Findings.** ops-tools:brain-memory-peak-evidence.
- **Files.** `ops/cairn/cairn.service` (:31), `judges/deployed-unit.ts` or `ops/cairn/deploy-check.ts`.
- **Fix.** Add `MemoryHigh=1.5G` (soft, logs pressure). Do not add MemoryMax: with the unit's KillMode and the claude children an OOM kill makes a worse hang. Print `MemoryPeak` and `MemoryCurrent` with the invocation id so the next peak can be matched to the journal.
- **Judge.** A logged peak is matched to a thread event; the peak falls once that cause is fixed.
- **Size.** S. **Confidence.** confirmed.

### T44. The committed reading survives history pages and tool output

- **Why.** Once history is paged in, every streamed token rebuilds the whole committed reading; every tool-output flush invalidates it too. Nothing tests the pipeline's identity.
- **Findings.** client-logic:older-pages-defeat-committed-memo (high), client-logic:slots-key-invalidates-committed-reading (medium), client-logic:no-judge-for-timeline-identity-or-cost (identity-test half).
- **Files.** `packages/client-logic/src/TimelineEntries.ts` (:1102, :1149), `TimelineEntries.test.ts`.
- **Fix.** Key the memo on the pair (`older` identity, `view.entries` identity), not a concatenated array; the two-halves variant breaks on a turn that spans the boundary. Compute the committed reading on source identity and `running` only, then overlay live output on unanswered calls, creating new WorkEntry objects only for those.
- **Judge.** Identity tests, red today: a `pi.live`-only change with and without `older`, and a slot-output-only change, keep settled entries identical by reference. `judges/typing.ts --busy` with history paged in shows no dead stream.
- **Size.** S. **Confidence.** confirmed.
- **DU.** DU 9 stable-rows-per-frame (memo half).

### T45. A streaming code block stays plain until it closes

- **Why.** A streaming code block is re-tokenized by shiki on the main thread every delta: 12 ms at 200 lines and 25 ms at 400 per frame (DU's measure; the slice measured 49 ms at 100 and 145 ms at 300 cold). The 200-entry FIFO cache thrashes once the working set reaches its cap. A fence whose language streams in a later frame never mounts its grammar loader. transcript-scroll records long tasks but never fails on them, and its stream has no real code block.
- **Findings.** web-timeline:streaming-code-retokenize (high), web-timeline:code-block-mount-missed-when-language-arrives-later, web-timeline:judge-blind-to-streaming-stalls.
- **Files.** `apps/web/src/timeline/markdown/View.ts` (:148-180), `apps/web/src/timeline/markdown/Highlight.ts` (:226-264), `judges/transcript-scroll.ts` (:373-386), `apps/web/src/timeline/harness/Fixture.ts`.
- **Fix.** Render the streaming message's last open fence as plain text and highlight it on close or commit. Make the cache an LRU refreshed on hit, larger, and never insert the streaming block. Request grammar loads from update when the parsed blocks name a language not yet loaded (removes the Mount from the hot path), or key the Mount carrier by language. Add a 300-line TS fence to the fixture and gate the follow phase on long tasks (none over 50 ms, plus a total budget).
- **Judge.** Vitest with a counting `codeToTokens` stub: 200 renders of a growing 300-line fence tokenize at most once, then once at commit. transcript-scroll fails before and passes after. A harness test streaming "```" then "ts\n..." in separate frames ends highlighted.
- **Size.** M. **Confidence.** confirmed.
- **DU.** DU 5.

### T46. The diff panel parses once per patch

- **Why.** The open diff panel re-parses the whole patch, rebuilds the tree and every file's lines on every page render; past about 200 highlighted hunks the FIFO cache misses on every hunk every frame. That is a hang while typing with a big diff open, and every mousemove over a picker (T48) pays it too.
- **Findings.** web-timeline:diff-panel-reparse-per-render (high).
- **Files.** `apps/web/src/diff/View.ts` (:124, :369-406).
- **Fix.** Parse on LoadedDiff or in a one-slot memo keyed on the patch string, outside the Schema-typed model; a keyed lazy per file; per-file tokens through T45's LRU, sized by bytes (t3code uses 500 entries and 50 MB); a total line budget across files.
- **Judge.** Vitest rendering twice with a 300-hunk patch: the second render makes 0 parses and 0 tokenizations. Optional diff-open phase in transcript-scroll with no task over 50 ms.
- **Size.** M. **Confidence.** confirmed. **Depends on.** T45 (the LRU).
- **DU.** DU 6.

### T47. Rows compare by identity first, with a cost judge

- **Why.** Transcript rows are re-derived and deep-compared for every event, linear in entries held. Estimated heights split every unmeasured message's text each render, and `afterView` derives with no workspace root so the single-entry memo misses and rows derive twice.
- **Findings.** client-logic:per-event-full-row-derivation (high), client-logic:no-judge-for-timeline-identity-or-cost (cost-judge half), web-timeline:estimated-height-splits-text-per-render, web-timeline:afterview-derives-twice-without-root.
- **Files.** `packages/client-logic/src/TimelineRows.ts` (:958-987), `apps/web/src/timeline/Rows.ts` (:451-471), `apps/web/src/timeline/Update.ts` (:259), `apps/web/src/page/thread/View.ts`.
- **Fix.** Compare row payloads by reference first and fall back to `Equal.equals` only when references differ. Then cache rows per settled turn, including `deriveTurnFolds` and `placeChangedFiles`, which are whole-timeline passes. WeakMap line counts per TimelineMessage. Move `workspaceRoot` into the thread page Model (the page does not have it today) or derive item keys through a root-independent path.
- **Judge.** A kept cost judge replaying `judges/fixtures/transcripts/streaming-tools.frames.json` against views padded to about 3,000 entries, with a ratio budget against 100 entries (stable across machines). A unit test that `computeStableTimelineRows` reuses a settled row without calling Equal. A derivation counter: one per afterView plus view.
- **Size.** L. **Confidence.** confirmed. **Depends on.** T44.
- **DU.** DU 9 stable-rows-per-frame.

### T48. Memo boundaries at the root

- **Why.** The sidebar, composer and chat header rebuild on every frame: every delta, keystroke, shell item and tick. A hidden judges-only index of every thread row renders each time. Every mousemove over a picker row builds a new model and re-renders the app.
- **Findings.** web-shell:sidebar-render-per-shell-item (medium), client-logic:sidebar-per-render-allocations, web-composer:mousemove-highlight-rerenders-the-app (medium).
- **Files.** `apps/web/src/View.ts` (:197), `packages/client-logic/src/Sidebar.ts` (:513), `apps/web/src/composer/Update.ts` (:956).
- **Fix.** Measure first with `judges/typing.ts --throttle 4 --busy 10` and foldkit's slow-view warnings. `createLazy` around the composer, the sidebar (keyed on `model.sidebar` plus what `sidebarState` reads) and the chat header; memoise `partitionOf` and partition in one pass; hoist one Segmenter. Return `keep(model)` when the highlight is unchanged. Gate `shellIndex` behind a flag only together with the judges that read it. Do not fork `@foldkit/ui`'s scroll loop without transcript-scroll.
- **Judge.** typing.ts before and after; a vitest with `observeLazyResolutions`: thread items cause 0 sidebar and composer view calls; `update(model, MovedPopoverHighlight({id: same})).model === model`.
- **Size.** M. **Confidence.** confirmed (the size of the win is DU's "measure first").
- **DU.** DU 7.

### T49. The thread stream coalesces for a slow client

- **Why.** `watchIn`'s output queue is unbounded and the producer eager, so a starved client gets a burst of per-revision frames to replay instead of one coalesced diff; it fed the client starvation seen in wave 5.
- **Findings.** server-brain:watch-unbounded-backlog (medium), the misleading comment in server-brain:standards-brain-misc.
- **Files.** `apps/server/src/brain/PiDurableHarness.ts` (:570, :662-690).
- **Fix.** Pull-driven: compute a diff only when the consumer pulls, spanning every revision since the last frame (`Stream.fromQueue(ticks)` sliding 1, then `mapEffect(advance)`). Keep the first snapshot before ticks are wired, the end and listener-error failure, and seq numbering. A dropping or sliding buffer on frames is wrong because the ops are deltas. Fix the comment.
- **Judge.** Vitest: 100 commits while the consumer is blocked give one frame that applies to the same final view (reuse the ThreadWindow convergence helper). `judges/wire-budget.ts` with a throttled consumer reports frame count and RSS before and after.
- **Size.** M. **Confidence.** confirmed.
- **DU.** DU 8.

### T50. The row lazy cache evicts with the saved set

- **Why.** The row lazy cache keeps every row ever rendered, with its detached DOM, for the page's lifetime; `stableByThread` likewise. DU also found the view inputs walk the whole thread state three times per frame.
- **Findings.** web-timeline:row-lazy-cache-never-evicts (medium); DU 9 rowlazy-unbounded-detached-dom (same) and viewinputs-walk (not re-found).
- **Files.** `apps/web/src/timeline/View.ts` (:31), `apps/web/src/timeline/Rows.ts` (:167, :355), `apps/web/src/page/thread/View.ts` (:85).
- **Fix.** One lazy per thread, deleted when the thread leaves `saved` (SAVED_THREAD_LIMIT), or drop keys absent from the current transcript after derivation; prune `stableByThread` the same way. Pass the diff toggle only the newest checkpoint turn and big state as top-level thunks; do not thunk the virtual list's items.
- **Judge.** Playwright over the harness: 2,100 rows, 20 thread switches; CDP detached-node counts stay flat.
- **Size.** M. **Confidence.** confirmed (no heap measurement yet).
- **DU.** DU 9.

### T51. The inline parser stays linear on unmatched brackets

- **Why.** Unmatched `[` or `*` runs make the inline parse quadratic (20K `[` took 602 ms), re-paid every delta of the last block.
- **Findings.** web-timeline:inline-parser-quadratic-unmatched-brackets.
- **Files.** `apps/web/src/timeline/markdown/Inline.ts` (:110-137).
- **Fix.** One backward pass computing whether a closing bracket exists after each index, or a lookahead cap for link labels.
- **Judge.** Markdown test: 20,000 `[` parse in under 20 ms.
- **Size.** S. **Confidence.** confirmed.

### T52. Bridge: parse tool JSON once, bound session maps

- **Why.** Every `input_json_delta` re-decodes the whole accumulated tool JSON through Schema (O(n²) per argument). The `places` and `usage` maps keep an entry per session id forever.
- **Findings.** bridge:per-delta-json-reparse, bridge:unbounded-session-maps.
- **Files.** `packages/bridge/src/ClaudeStream.ts` (:514), `packages/bridge/src/Claude.ts` (:136).
- **Fix.** Check first whether pi's UI uses live partial arguments from `toolcall_delta` (pi-ai's own Anthropic provider uses a partial-JSON parser); if so use a partial parser or throttle by size, otherwise parse only at `content_block_stop`. Delete the usage entry when `inFlight` returns to 0 and the RcMap entry is released; bound `places`.
- **Judge.** A micro-benchmark feeding 60 KB in 50-byte deltas drops from tens of ms to sub-ms; 1,000 expired session ids leave the maps empty.
- **Rerun.** J2.
- **Size.** S. **Confidence.** confirmed. **Depends on.** T2 (same file).

### T53. One copy of an upload in memory

- **Why.** An upload is held whole, written, then copied again into the extract worker (four to five copies), with undrained stdout pipes.
- **Findings.** server-edge:upload-triple-buffering.
- **Files.** `apps/server/src/attachments/AttachmentStore.ts` (:326), `ExtractJob.ts`.
- **Fix.** Return `Buffer.concat` directly as a first cut, then pass bytes as a transferable; drop `stdout/stderr: true` or pipe them to the logger.
- **Judge.** RSS during a 50 MiB upload in a test, before and after: roughly one copy.
- **Size.** S. **Confidence.** confirmed.

### T54. Thumbnails for image chips

- **Why.** Restored image chips fetch the full original for a 64 px thumbnail, and t3code shows a thumbnail in the bubble (DU 3's separate step). Inline PDFs may not render under the sandbox CSP.
- **Findings.** web-misc:restored-thumbnail-loads-original, server-edge:pdf-inline-under-csp-sandbox (plausible).
- **Files.** `apps/web/src/attachments/View.ts` (:48), `apps/server/src/attachments/AttachmentRoute.ts` (:101), `apps/web/src/timeline/RowView.ts`.
- **Fix.** A server-side thumbnail variant used by the tray and the bubble; `loading="lazy"` and `decoding="async"` first. Check a PDF in real Chrome before changing the CSP; if it fails, keep `nosniff` and `default-src 'none'` without `sandbox` for PDFs.
- **Judge.** `judges/load.ts` bytes before interactive with a restored draft; Playwright opening a PDF route renders the viewer; parity screenshot of a thread with one photo.
- **Size.** M. **Confidence.** mixed. **Depends on.** T23 (cache headers), T27.
- **DU.** DU 3 thumbnails step.

## Group 5: judges that pass vacuously, and judge hygiene

### T55. Four judges that pass when the thing is broken

- **Why.** `judges/tools.ts` passes a failed Executor call when the answer shares one capitalised token with the error text. The Ws revocation test accepts a 2 s timeout as proof the socket closed. `judges/shutdown.sh` aborts silently under `set -e` on any failing window, with no FAIL line. The composer launch test checks the fixture's default instead of the command's args.
- **Findings.** judges:tools-quoted-vacuous, server-edge:ws-revocation-test-passes-on-hang, judges:shutdown-sh-set-e-abort, web-composer:launch-test-asserts-the-fixture.
- **Files.** `judges/tools.ts` (:194), `apps/server/src/http/Ws.test.ts` (:289), `judges/shutdown.sh` (:56, :93, :107), `apps/web/src/composer/Composer.test.ts` (:584).
- **Fix.** tools.ts: decode the result, require `isError !== true`, quote only from parsed result leaves, and exclude tokens in the prompt and RULES. Ws: assert the failure is not a TimeoutError and arrives well before the bound. shutdown.sh: `line=$(window X) || true` and a trap that removes the kept dirs. Composer: assert PrepareLaunch's args.
- **Judge.** Sabotage per item: `--repo` at a missing repository fails the github turn; `recheck` as `Effect.never` fails the Ws test; `limit_ms=1` makes shutdown.sh print FAIL for all three sections and exit 1; `resolvedModel` returning the server default fails the composer test.
- **Size.** S. **Confidence.** confirmed.

### T56. Judges clean up after themselves

- **Why.** A judge killed outright leaves its `Restart=always` brain unit and claude children running; DeployedUnit leaves its thread in production when a check times out; bridge judges leave scratch dirs and `~/.claude/projects` folders.
- **Findings.** judges:transient-units-outlive-judge (plausible), judges:deployed-unit-thread-left, judges:judge-scratch-leaks.
- **Files.** `judges/lib/Unit.ts` (:164), `judges/lib/DeployedUnit.ts` (:752), `judges/claude-eligibility.ts` (:50), new `judges/lib/Scratch.ts`.
- **Fix.** At `Unit.start`, sweep `cairn-judge-*-<pid>-*` units whose pid is gone; a per-call `RuntimeMaxSec` sized per judge. `remove` on `Effect.ensuring` keyed on `options.keep`, surfacing a failed delete in notes. A Scratch acquireRelease removing the tmp root and the mangled projects folder.
- **Judge.** `kill -9` durability.ts mid-window, then the next judge start leaves no `cairn-judge-*` unit. After claude-eligibility and claude-reminder, the `tmp-cairn` folder count is unchanged. `deployed-unit.ts restarts` with an unavailable model leaves no judge thread.
- **Size.** S. **Confidence.** mixed. **Depends on.** T3 (shares claude-live's cleanup path).

## Group 6: standards

### T57. File headers and comments say what runs

- **Why.** Port headers sit after imports (and RowView lacks the MIT notice); claude-eligibility reproduces pi's skills prompt text with no port header; JSDoc for `init` sits above another function in two files; seam headers describe plans that are not what runs; user-facing text and headers use planning language; "arm" and "Inbox" are used against the glossary.
- **Findings.** web-timeline:port-header-after-imports, server-models-push:header-below-import, judges:pi-text-port-header, web-composer:misplaced-jsdoc-on-init, server-edge:stale-seam-comments, server-tools:planning-language-and-glossary, the doc-comment and glossary parts of web-shell:closed-sets-as-strings-and-index-coupling.
- **Files.** `apps/web/src/timeline/RowView.ts`, `markdown/View.ts`, `Message.ts`, `apps/server/src/push/ExecutorSignInPush.test.ts`, `judges/claude-eligibility.ts` (:250), `apps/web/src/composer/Update.ts` (:83), `apps/web/src/sidebar/Update.ts` (:685), `apps/server/src/ShutdownHooks.ts` and two other seam headers, `apps/server/src/executor/ExecutorLink.ts` (:254), `GLOSSARY.md`.
- **Fix.** Move headers above the first import, add the MIT notice. Build claude-eligibility's skills section from SkillCatalog (the thing J7 judges) instead of a copy. Move the JSDoc. Rewrite the seam headers. Replace plan ids with ADR numbers ("S43" cites a standard; keep it) and say what to run. Rename the Inbox route tag to Hero (the glossary already names it) or add a term; resolve "arm" against the glossary.
- **Judge.** A lint or check that a ported file's first non-blank line is its header; `grep -E 'phase [0-9]|wave [0-9]|plan D[0-9]' apps/server/src/executor` is empty; J7 after the SkillCatalog change.
- **Size.** S. **Confidence.** confirmed.

### T58. Types follow the standard

- **Why.** Optional `?:` where S22 asks for Option (`userEntryId?: Option` is a double optional); string errors in Effect catches (S30); connection state crosses to the sidebar as `Schema.String` and a menu index is hard-coded; Buffer used without import and errorText skipped; Diffs and CheckpointCapture re-provide services inside services; `sweep` takes an optional parameter.
- **Findings.** server-threads:optional-params-in-service-shapes, web-misc:string-errors-in-load-module, web-shell:closed-sets-as-strings-and-index-coupling (types and index), server-brain:standards-brain-misc (Buffer, errorText), server-threads:provide-service-inside-services, the Option part of server-tools:planning-language-and-glossary.
- **Files.** `apps/server/src/git/Git.ts` (:59), `runEnded`, `apps/web/src/load/LoadMark.ts` (:73), `apps/web/src/sidebar/Model.ts` (:31), `apps/server/src/brain/ScriptedHarness.ts` (:1220), `apps/server/src/git/Diffs.ts` (:302), `apps/server/src/executor/ExecutorSweep.ts`.
- **Fix.** `userEntryId: Option<number>`; GitRunOptions as required fields plus a defaults constant. TaggedErrors with `cause: Schema.Defect()`. `ConnectionState["_tag"]` literals and find the snooze item by id. Import Buffer from node:buffer and use errorText. `workspaceOf(rows, projects, threadId)` as a plain function. `sweep` takes Option or splits.
- **Judge.** `pnpm check`; a Sidebar.test case opening snooze from the clock button on a pinned row.
- **Size.** S. **Confidence.** confirmed.

### T59. Dev tooling: catalog pins, pre-commit, edit hook

- **Why.** The oxlint, `@oxlint/plugins`, oxlint-tsgolint and `@effect/tsgo` pins live in root package.json, not the catalog AGENTS.md names. The pre-commit format job fails on a commit of only oxfmt-ignored files, pushing toward `--no-verify`. The autofix hook matches its ignore list against the whole hook JSON, including the written content.
- **Findings.** ops-tools:toolchain-pins-not-in-catalog, ops-tools:precommit-fails-on-ignored-only-commits, ops-tools:hook-filter-matches-file-content.
- **Files.** `package.json` (:31-40), `pnpm-workspace.yaml` (:39-42), `lefthook.yml` (:3-14), `oxfmt.config.ts`, `tools/hooks/fix-edited-file.sh` (:5-6).
- **Fix.** Move the four pins into the catalog with a comment tying oxlint-tsgolint to TypeScript. An `exclude` list in lefthook mirroring oxfmt's and oxlint's ignores, kept next to them. Extract `tool_input.file_path` with jq and match the path only, including the oxfmt-only ignores.
- **Judge.** `pnpm install --frozen-lockfile` clean with four `catalog:` refs; a commit of only `docs/phase-1/probe.md` succeeds without `-n`; a misformatted ClaudeGuards.ts piped through the hook is reformatted.
- **Size.** S. **Confidence.** confirmed.

## Group 7: design

### T60. One copy of each helper

- **Why.** Duplicates drift: `formatDuration` twice byte for byte; request helpers three times across the HTTP seam; the "message off an unknown failure" helper eight times across web; three private CallFailure/failureText copies and three shell row lookups; `gitRootOf` and `byName` with diverging behaviour.
- **Findings.** client-logic:format-duration-duplicated, server-edge:duplicated-request-helpers, web-misc:three-failure-text-helpers, web-shell:duplicated-failure-and-lookup-helpers, server-tools:duplicated-skill-helpers.
- **Files.** `packages/client-logic/src/TimelineFolds.ts` (:40), `apps/server/src/http/Guard.ts` (:20) and siblings plus `brain/EntryImageRoute.ts` (:23), `apps/web/src/attachments/UploadQueue.ts` (:201), `apps/web/src/Command.ts` (:53), `apps/web/src/composer/Command.ts` (:36), `apps/server/src/skills/ProjectContext.ts` (:199).
- **Fix.** Import `formatDuration` from Time.ts. `http/Request.ts` (`pathnameOf`, `forwardedPeer`) and `http/Problem.ts`. One `connection/Failure.ts` with `failureMessage` and `isRetryable` decoding the protocol's error schemas (build it with T19's `rpc` helper). One `routedThreadRow(model)`. One `gitRootOf`, one `byName` via `Order.mapInput`.
- **Judge.** `pnpm check`; grep shows one definition each; existing tests unchanged.
- **Size.** M. **Confidence.** confirmed. **Depends on.** T19.

### T61. Remove dead code and make silent no-ops visible

- **Why.** `PiModelSource.thinkingFor` has no caller; `liveTurnEnd` never differs from the committed end and the `results` comment is wrong; `ops/executor/grant.ts` waits for OAuth on 3774, the port the brain now holds, and is dead since the brain signs in itself; the boot sweep is a silent no-op when Brain is not in its layer context.
- **Findings.** server-models-push:thinkingfor-dead-interface, client-logic:live-turn-end-dead-and-results-comment, ops-tools:grant-script-collides-with-brain-port, server-tools:sweep-silent-without-brain.
- **Files.** `apps/server/src/models/PiModelSource.ts` (:428-443, :533-536), `packages/client-logic/src/TimelineEntries.ts` (:1176), `ops/executor/grant.ts` (:29), `ops/wizards/phase-0.sh` (:349-355), `ops/executor/NOTES.md`, `apps/server/src/executor/ExecutorSweep.ts` (:51).
- **Fix.** Remove `thinkingFor` and its test (keep `clampThinking` for `defaultsOf`). Remove `liveTurnEnd` (or extend the end with the partial if that is wanted) and fix the comment. Stage 9 ends at Settings, Executor, Sign in on the deployed brain; if grant.ts stays for bootstrap, pass no port and print the redirect. Log `executor_sweep_mode` once at layer build.
- **Judge.** `pnpm check`; `ops/wizards/phase-0.sh 9` with cairn.service active reaches Connected without EADDRINUSE; a Boot.test over PiDurableBrain with a leftover started approval sees `resume decline` at boot.
- **Size.** S. **Confidence.** confirmed.

### T62. Fold claude-kill.ts into durability.ts

- **Why.** claude-kill.ts is a stale copy of durability's bridge windows, still wired through claude-kill.sh, so J2 and J9 checks must be mirrored by hand.
- **Findings.** judges:claude-kill-duplicate-driver.
- **Files.** `judges/claude-kill.ts`, `judges/claude-kill.sh`, `judges/durability.ts`, `judges/lib/`, `docs/decisions/0017-the-bridge-is-ported-not-registered.md`.
- **Fix.** Move J9's restart and stop cgroup moves and the `answer` case into durability.ts first, then make claude-kill.sh dispatch to `durability.ts --bridge --window ...`, delete claude-kill.ts, move shared helpers into judges/lib, and update ADR 0017's gate text in the same change.
- **Judge.** `pnpm check` and one run each of claude-kill.sh and `durability.ts --bridge` reporting J2 and J9.
- **Size.** M. **Confidence.** confirmed. **Depends on.** T3, T56.

## Group 8: test gaps

### T63. Lint rules have tests and the boundary test covers every zone

- **Why.** The 23 anti-slop rules have no tests in this repo, and the boundary test probes only some zones, so a widened carve-out passes the gate.
- **Findings.** ops-tools:lint-rules-untested.
- **Files.** `tools/oxlint/anti-slop`, `judges/lint-boundaries.test.ts` (:56-150).
- **Fix.** A per-rule "one firing, one quiet" probe reusing the boundary test's CLI helpers. Add zones for `apps/server/src/models` (piAi allowed, durable refused) and `skills/*Extension.ts` first.
- **Judge.** A deliberately broken rule (`createOnce` returning `{}`) fails `pnpm test`.
- **Size.** M. **Confidence.** confirmed.

Other test gaps are folded into the task whose judge they are: the bridge test kit (T1), hero launch (T5), user row and attachment bubble (T27), outbox and thread-page stories (T5, T10), tray tests (T38), Executor risky paths (T20), timeline identity and cost (T44, T47), transcript-scroll's long-task gate (T45).

## Plausible findings that need a repro or a measurement first

These are reachable but unproven. Each is either inside a task whose judge is the repro (do the red test first and stop if it will not go red) or needs a number before any code.

Repro first, inside a task:

- bridge:route-lock-held-across-prompt-ack, bridge:slot-permit-release-only-on-interrupt, bridge:interrupt-without-timeout-blocks-close, bridge:one-shot-no-watchdog, bridge:orphaned-result-after-abort-delivered (T13): a scripted vitest each, needing T1's script-owned pump. bridge:watchdog-silenced-by-leaked-pending-call (T2): a fake that cancels a `tools/call`.
- server-threads:send-wait-timeout-parks-outbox, server-threads:interrupted-launch-ack-without-thread (T17): the LaunchWait and interrupt tests.
- web-shell:outbox-send-has-no-timeout (T10), web-shell:thread-failed-is-terminal (T5): TestClock stories.
- x-turn-path:stop-lost-on-run-handover (T11): needs a hook to inject the stop between read and abort.
- x-turn-path:rpc-defect-crashes-client, server-shell:rpc-error-text-unbounded-and-mislabelled (T19): a layer whose send dies; a 10,000-char brain error through the codec.
- server-tools:connect-holds-link-six-minutes, grant-write-failure-poisons-provider, transient-refresh-failure-reads-as-sign-in, sign-in-verifier-race-and-state-wipe (T20): FakeExecutor knobs.
- x-security:launch-cleanup-removes-unowned-worktree-folder (T18): two same-basename repos.
- server-brain:child-env-denylist (T22): only matters once OTEL headers land.
- server-brain:entry-image-index-mismatch (T24), server-brain:configure-cwd-toctou and commitfeed-learn-silent (T40), server-brain:parked-stale-and-side-effects and server-shell:retry-task-row-stays-parked (T39): unit tests.
- x-turn-path:history-page-prepended-onto-new-window (T41): ThreadView test.
- web-timeline:working-timer-keeps-first-start (T34): check t3code's indicator first; it may be parity.
- web-timeline:no-timeouts-on-diff-fetch-and-grammar-load (T14), web-misc:retry-hidden-for-recoverable-statuses (T38), web-misc:command-defect-crashes-app-storage (T37), server-models-push:webpush-body-read-outside-timeout (T36), judges:transient-units-outlive-judge (T56), ops-tools:nightly-and-deploy-share-live-worktree (T7): each task's judge.
- server-edge:pdf-inline-under-csp-sandbox (T54): open a PDF in real Chrome before touching the CSP.

Measure first, no task yet (open one only if the number is bad):

- server-threads:file-search-relists-per-keystroke: time `git ls-files` on the user's largest project; if it is slow, a short per-root TTL cache.
- server-shell:history-pages-count-bounded-only: make `judges/wire-budget.ts` report the largest `thread.history` page in bytes; budget pages like the window if it passes 1 MiB.
- server-brain:approvals-doc-unbounded (confirmed, but harmless at today's volume): extend wire-budget with 300 Executor calls through the ledger and check first-snapshot bytes and `projector.advance` p50 against ADR 0020.
- web-shell:wake-does-not-probe-live-socket: measure time to first delivered send after a phone wake with `judges/phone-report.ts`; a probe saves at most a few seconds.
- server-models-push:defaults-fall-to-first-catalog-model: a decision, not a measurement (below).
- ops-tools:brain-memory-peak-evidence is itself the measurement (T43); its result decides whether T47, T49 and T50 move up.

## Counts per area

| Area | Found | Confirmed | Plausible | Refuted |
| --- | ---: | ---: | ---: | ---: |
| bridge | 14 | 8 | 6 | 0 |
| client-logic | 12 | 9 | 0 | 3 |
| judges | 13 | 11 | 1 | 1 |
| ops-tools | 11 | 10 | 1 | 0 |
| server-brain | 11 | 5 | 5 | 1 |
| server-edge | 12 | 10 | 1 | 1 |
| server-models-push | 8 | 6 | 2 | 0 |
| server-shell | 10 | 7 | 3 | 0 |
| server-threads | 11 | 6 | 4 | 1 |
| server-tools | 9 | 5 | 4 | 0 |
| web-composer | 10 | 10 | 0 | 0 |
| web-misc | 11 | 8 | 2 | 1 |
| web-shell | 13 | 10 | 3 | 0 |
| web-timeline | 15 | 13 | 2 | 0 |
| x-security | 4 | 3 | 1 | 0 |
| x-turn-path | 8 | 5 | 3 | 0 |
| **Total** | **172** | **126** | **38** | **8** |

After merging duplicates the 164 kept findings come to 63 tasks, Two of them (T12, T21) come only from DU, and T13, T16, T18, T41 and T50 also carry DU items this review did not re-find. Seed 2 was found in five areas, seed 3 in ten findings across eight areas, and the launch double build in five areas (one of them refuted as a client double send). The refuted eight: three definitions of "working" (unreachable, the helpers are unused), per-op entry copies (chord emits one splice), a harness block cut at 32 KiB (diagnostics are a separate part), DeployedUnit journal lag (measured, the `closed` line lands first), sidecar before open (the backup already exists), boot repair swallowing interrupts (Effect 4 skips recovery on interruption), FolderRules reading `os.homedir()` (it returns `$HOME`), and the doubled `turn.submitted` as a client double send (it is T35's double build).

## Decisions (answered 2026-10-24)

- **Executor scoping: advisory.** T22 takes option (a): ExecutorScope's header and ADRs 0003 and 0013 say the per-project scoping is advisory, and FolderRules drops its confinement wording. Sandboxing thread tools (bubblewrap or a second uid) is not done: it risks breaking tools that need the user's environment, and it is an L task with its own ADR if it is ever wanted.
- **Archive stops a running thread.** Yes. T4 calls `Threads.stop({clearQueue: true})` for ThreadArchive as it does for ThreadDelete and ProjectDelete.
- **Changed-files card: per run.** T42 is the glossary change only: the card covers every turn in the run, including queued follow-ups.
- **Fallback default model: `opencode-go/glm-5.3-flash` at thinking level high.** When pi's default is unavailable, new threads take it instead of the catalog's first model; if it is unavailable too, the catalog's first model as today. The test that pins the old rule is rewritten.
- **Sign-in state on a mismatched callback: clear only on a matching state.** A callback whose state does not match the one in flight is refused and leaves the live sign-in alone. No cost to speed or reliability; the tested decision is reversed in the same change.
- **Code mode deadline: none, and no watchdog.** Scripts keep no time limit (ADR 0012). T16's worker wait and per-thread cap mean a stuck script can only hold its own thread, and Stop aborts it.
- **Paid usage credits: only by choosing them.** A Claude bridge (subscription) turn that reports `isUsingOverage: true` ends with a non-retryable error naming the cause; there is no setting to let bridge turns spill into paid credits. Paid use is a purposeful choice of an `anthropic` provider model in the picker (T12).

## Thin coverage

The verifiers read most code in full, but some parts got only names or headers. Test bodies were skimmed by title in several slices (ShellStream, LiveStreamBudget, ShellProjector, EventSink, Settlement, ThreadWire, ThreadWindow, BrainStore, Checkpoints, Worktrees, Git, most of Composer.test, BridgeProvider.test, ModelHandlers.test), so tests that pass vacuously there could have been missed. Server-brain did not read the conformance transcript, response script, T3 import fixture or goldens, nor `docs/spec.md` §12. Server-tools judged Executor's own behaviour from the fake and spike notes, and pi-durable's codemode internals only for nested-call outcome and abort. The bridge slice did not read claude-live.ts or claude-kill.ts bodies, or the server's delete path (server-shell found T4 there). x-turn-path skipped ShellStream/EventStore cursors, the sidebar reducers, ExecutorLink, CodeMode and the markdown path; x-security skipped supergateway's apiKey enforcement and push endpoint validation. No slice ran a browser against the judges or harness, and nobody measured the row lazy cache's heap or the root render cost, which is why T48 and T50 say "measure first". styles.css's 2,000 lines of t3code tokens were grepped, not read. The committed parity baseline data was not read. Phase-1 docs and the glossary were checked only where a finding touched them.

## Suggested batches

1. T1, T2, T3 and T12: one bridge change, judged by the new vitests, the live parallel case and J2. Then T4.
2. T5 and T27 (DU's batch 2), with T35 so the hero-launch judge can count `turn.submitted`.
3. Deploy (T7 first, so the deploy itself is safe), then T28.
4. T8, T9, T11, T17 and T10: launch and outbox lost work.
5. T43, then T44 to T48: client performance, judged by typing.ts and transcript-scroll before and after.
6. Security T22 to T26 once the user picks the Executor option.
7. The rest in order; T55 and T56 whenever a judge in them is next used.
