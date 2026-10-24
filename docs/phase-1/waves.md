# Phase 1 waves

One section per wave, written by the integrator after the merge: what landed, the integration judges with their measured numbers, the decisions taken at integration, the gaps and the deviations from the plan.

## Wave 1

Integrated on 2026-10-22 on `main`.

### Packages

| Package | Branch | Commit | Status |
| --- | --- | --- | --- |
| 1.0 Frame and contract | main | `bd9939a` | done |
| 1A Server skeleton and HTTP | `phase1/1-1A` | `526a3ff` | done |
| 1B Database and shell store | `phase1/1-1B` | `0ea9f32` | done |
| 1C Brain core, scripted harness and conformance | `phase1/1-1C` | `b33444f` | done |
| 1D Client shell | `phase1/1-1D` | `511d181` | done |
| 1E Ops and judge kit | `phase1/1-1E` | `0c3918f` | done |
| 1F Bridge core | `phase1/1-1F` | `bdc53aa` | done |

Each branch merged with `--no-ff` in the order A, B, C, D, E, F. No two packages touched the same file, so there were no conflicts. Every package's worktree had started at `e072229` and been reset to `bd9939a` by its builder before any work.

### Integration judges

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` from a clean install (`rm -rf node_modules`, `pnpm install --frozen-lockfile`) | pass | oxfmt clean on 278 files, oxlint 0 findings, typecheck clean in root and all 5 workspaces, vitest 43 files and 302 tests in about 50 s. `pnpm why -r effect`: one `effect@4.0.5`; one `@effect/platform-node-shared@4.0.5`; one vitest 5.0.5. |
| Harness conformance, both sides | pass | 18 of 18 scenarios on pi-durable, 18 of 18 on the scripted harness; goldens: 0 drift. |
| Mutation check, broken pi-durable | pass | all four mutations: 18 of 18 fail; alone: drop_run_terminal 17, reorder_events 8, lose_queued_input 10, skip_snapshot 18 (threshold 5). |
| Mutation check, broken scripted harness | pass | all four: 18 of 18 fail; alone: drop_run_terminal 17, reorder_events 11, lose_queued_input 10, skip_snapshot 18. |
| `judges/shell-resume.ts`, now against the integrated brain (AppLayer: guard, per-socket RPC server with the real ViewerMiddleware, `/ws?protocol=1` with the Caddy headers) | pass | 4 seeds, 24 rounds each, 2,000 ms deadline. Worst time to converge 239, 199, 252 and 240 ms; median 86, 134, 90 and 87 ms; first convergence 29 to 31 ms. 66 or 67 client sessions per run, 5 snapshots each (4 forced by 1,100-event outages), 1,873 to 2,078 items, about 7,150 to 7,550 events committed. |
| `judges/reconnect.ts` against the real dev brain (`dev-main.ts`), Chromium | pass | 3 runs of 5 `kill -9` rounds, budget 2,000 ms. First current frame after the restarted brain's listening line: 434, 676, 785, 290, 462 ms; 439, 417, 532, 49, 606 ms; 582, 386, 383, 369, 532 ms. Worst 785 ms. Final list equals the brain's snapshot (8 projects, 1 thread) every run, 0 page errors. |
| Relay switch-over (`ops/relay/install.sh --check`, then `ops/relay/install.sh`) | pass | The check showed only the planned diffs (description, PATH duplicate, paths moved from `spikes/5-stdio-bridges` to `ops/relay`). The install restarted `cairn-bridges` once, and `/healthz` answered from `ops/relay`. |
| `judges/relay-orphans.sh cairn-bridges http://172.17.0.1:3776/healthz ops/relay/warm.sh executor` | pass | 5 cases, 0 orphans in each. Healthy again after kill9-main 2,607 ms, kill9-child 1,018 ms, restart-unit 1,050 ms, stop-start-unit 1,053 ms, restart-peer (Executor) 3,878 ms. |
| The relay's stdio servers answering after the switch-over | pass (relay side) | A fresh MCP session per server through `172.17.0.1:3776` with the relay key: `tools/list` answered for playwright (25 `name` fields) and convex (12). Executor is active and answers on 4400 (HTTP 307). |
| `systemd-analyze --user verify ops/cairn/cairn.service ops/relay/cairn-bridges.service` (1E hand-off, run in the main checkout) | pass | exit 0. |
| Dev smoke: `judges/dev-smoke.ts` (`node tools/dev.ts` on throwaway ports and data dir, Chromium) | pass | 2 runs. The page was Live 1,559 and 1,573 ms after start, and listed the demo thread. On the thread page the entry count grew 6 times in 12 s (2 to 8 entries) as the scripted harness answered each demo message. Last entry: `assistant: You said: tick at ...`. 0 page errors; no process left behind. |
| `vite build` after the merge | pass | entry JS 398.7 KB (128.5 KB gzip), CSS 120.3 KB (20.2 KB gzip). |

### Decisions taken at integration

- **The harness is an entry point's choice.** `AppLayer` now needs a `HarnessSeam` and a small `HarnessBoot` service (`resume`), and exports two harness layers. `PiDurableBrain({ models, extraExtensions })` is pi-durable with the extension set, `BrainConfig` from `ServerConfig.dataDir`, and boot resuming the `Brain` after the repairs, as 1C's hand-off asks. `ScriptedBrain` is the scripted harness, which resumes itself. The inline `Boot` runs the repairs, then `HarnessBoot.resume`, then marks the brain ready. 2C's `Boot.ts` replaces this.
- **The roots until 2A.** `main.ts` and `judge-main.ts` run `PiDurableBrain` over `ModelSource.layerFaux` until 2A's `PiModelSource` layer exists. `judge-main.ts` adds `JudgeTools` through `ExtensionSet.withExtra`. `dev-main.ts` runs `ScriptedBrain` by default, and `--models real` runs pi-durable over the faux model until 2A. No brain is deployed in wave 1 (the plan's first deploy is a wave 2 judge), so the production faux model is never served.
- **The database and shell store** are built from `ServerConfig.dataDir` (`cairn.sqlite`) and provided at the bottom of `AppLayer`, so they close last. `AppLayer` also exposes them, which the dev demo and the shell-resume judge use.
- **The handler seam** merges layers: `Layer.mergeAll(BaseHandlers, ShellHandlers, ThreadStreamHandlers.layer)`, where `BaseHandlers` is 1A's stubs with `session.hello` over them. `Context.mergeAll` keeps the last service for a key, so later handler layers replace the stubs (checked in the installed effect source).
- **Routes** add `ShellSnapshotRoute` (`GET /api/shell`) and `EntryImageRoute` behind the global guard.
- **`apps/server/src/DevDemo.ts` (new, integrator).** `dev-main.ts` composes it with the scripted harness. It registers a scratch project "Dev demo" and a thread "Scripted demo" with fixed ids, so restarts dedupe them by command receipt. It opens the thread in the harness and sends it a message every 4 s. Threads cannot be launched from the page until wave 2, so this is how `pnpm dev` shows a live thread.
- **`judges/dev-smoke.ts` (new, integrator)** keeps the plan's dev smoke as a rerunnable judge.
- **Optional hand-offs taken.** The root `package.json` gained `@cairn/bridge`, so `judges/claude-reminder.ts` imports `@cairn/bridge/*`. `apps/server` gained the devDependency `@cairn/client-logic`, so the conformance runner and `ThreadWire.test.ts` import `@cairn/client-logic/ThreadView`. The bridge's test lint zone (`packages/bridge/src/**/*.test.ts` may import pi-durable) replaced the two disable comments in `ClaudeHarness.test.ts`. The bridge tsconfig is back to `"include": ["src"]`.
- **`docs/phase-1/**` is ignored by oxfmt**, as 1.0 advised, and is committed with this wave: plan, notes and this file.
- **`.claude/worktrees/` is in `.gitignore`**, so package worktrees never show as untracked. While they existed, `oxlint` in the main checkout also refused to run: it found a nested worktree's `oxlint.config.ts` with root-only options. The worktrees were removed before `pnpm check`, and the next integrator should remove them first too.
- **The glossary** gained every term handed off: Owner, Live worktree, Run, Settle, Snooze, Scripted harness, Conformance suite, Claude slot (with its Avoid line), Boot repair, Close hook, Command receipt and Events log.
- **ADR 0018** records the gate evidence so far and stays proposed until 3F's J4 cases pass.

### Fixes to package code (minimal, at integration)

- **The dev contract mismatch (1A and 1D).** In 1A's `ServerConfig`, `CAIRN_HOST` is the Host the guard expects, and `CAIRN_LISTEN_HOST` is the bind address. 1D's `tools/dev.ts` and `judges/reconnect.ts` set `CAIRN_HOST=127.0.0.1` meaning the bind address. With that, the guard answered the page's `127.0.0.1:<vite port>` Host with 421. Both now set `CAIRN_LISTEN_HOST`, so the Host comes from `CAIRN_ORIGIN`.
- **`judges/reconnect.ts`'s own protocol client** now sends the page's Host as well as its Origin. It goes straight to the brain, and the guard refuses any other Host with 421. The judge also kills its current brain on exit: three failed runs had left `dev-main.ts` processes behind, which were found and killed.
- **`judges/shell-resume.ts`** now runs against the integrated `AppLayer`, as 1B's gap asked, instead of its own `RpcServer.layerHttp` composition. It runs the scripted harness, judge-main's fixed-tailnet identity and the Caddy headers on `/ws?protocol=1`.
- **`Ws.test.ts` (1A)** gives the app the scripted harness and its own temporary data dir. Its RPC client no longer reconnects (`retryPolicy: Schedule.recurs(0)`). Under full-suite load, a reconnect still opening when the test's scope closed made `ws` throw "WebSocket was closed before the connection was established" outside any fiber, an unhandled error that failed `pnpm check` once.

### Gaps

- **No first deploy and no `judges/gate.sh` run.** The plan lists the first deploy (`ops/cairn/install.sh`, `caddy-route.sh`, `deploy.sh`, then `gate.sh`) under the wave 2 integration judges, and wave 1 has no real model source for production.
- **Executor's side of the relay check is not done.** Calling the stdio servers through Executor needs the brain's Executor grant, which only the deployed brain may hold. The relay side was judged directly with the relay key. Executor itself survived the peer restart and answers.
- **1D's suggestion to move `BootData` into `packages/protocol/src/Boot.ts` is not taken.** The boot JSON hook still injects nothing (`BootJson.layerNone`); the load package (2C or 4B) should move the schema when it fills the hook.
- **1E's Observability hand-off (`Logger.toFile` with `batchWindow: 0`) is superseded by 1A's design.** 1A appends each line synchronously to `CAIRN_EVENTS_LOG`, which keeps the kill -9 property, and its lines are the `Logger.formatJson` shape `judges/lib/Events.ts` reads.
- **Not wired yet, as planned:** the bridge (2A or 3F), `Claude.beginClosing` as a close hook (3F), and the `ProjectorSignals` consumer (2C).
- **Carried from the packages:**
  - S59 request ids (1A).
  - A dedicated test for the 503 sent before ready (1A).
  - Tests for `JudgeTools` (1C). The Brain supervisor's reopen test landed at the review (`Brain.test.ts`).
  - The live-child cap and idle TTL tests (1F).
  - J2 and J4's compaction and provider-switch cases (3F).
  - The real Tailscale layer has no automated test (gate.sh covers it at the first deploy).
- **The old spike relay directory** `spikes/5-stdio-bridges/` is no longer used by the unit. It is left in place as a spike record.

### Deviations from the plan

- **The dev demo thread** is not in the plan. It is how the plan's dev smoke ("shows a scripted thread streaming") can be met before thread launch exists. The scripted echo model answers whole messages, so "streaming" is judged as the transcript growing live on the thread stream, not as token deltas.
- **pi-durable over the faux model in `main.ts` and `judge-main.ts`**, until 2A, rather than leaving production without a harness.
- **The entry image route is unsigned.** The protocol table (plan section 1) says "signed short TTL" for `GET /api/threads/:threadId/entries/:entryId/images/:index`. 1C serves it behind the global guard instead, which admits only the owner's devices, Host and Origin, and caches each response privately for good (entries never change). Recorded at the wave 1 review. The decision: keep it unsigned. A signature adds nothing the guard does not already give, because the URL is never handed to anything but the owner's own browser. Revisit only if an image URL ever leaves the owner's session (a push payload or a share), and then reuse 3A's attachment signing key rather than a second key.

### Review

A review of `e072229..main` reported five confirmed findings and five unverified concerns. Each was checked against the code; what was done follows. `pnpm check` is green afterwards (44 files, 304 tests).

Confirmed findings:

1. **A supervisor reopen resumed the Harness before the commit feed subscribed** (`Brain.ts`, `CommitFeed.ts`). Confirmed: `supervise` called `resume()`, then published the Session, and `CommitFeed` subscribed later from a forked stream fiber, so commits in that window could be lost (a lost `RunTerminal` leaves a shell row `running`). Fixed at the source. `Brain` now owns commit listeners: `Brain.subscribeCommits(listener)` (scoped) attaches a listener to the open Session at once, and `openSession` attaches every registered listener to a new Session in the same synchronous step that creates it, before anything resumes it. `CommitFeed` registers through it while its layer builds, so the gap is gone for reopens and for boot alike. No `SessionReopened` reconcile was added: with nothing missed there is nothing to reconcile, and a process restart is still covered by 2C's boot reconcile. New `Brain.test.ts` judges the reopen path end to end, which had no test (a 1C gap): a commit fails mid-run, the supervisor reopens (generations 1 and 2), the listener hears both Sessions, and the cut-off run still ends with `RunTerminal: completed`. The test passes on the old code too, because the race window is too small to hit on demand; the ordering is guaranteed by construction, not by the test.
2. **Tool calls and prompt reads ran on the default runtime** (`ClaudeSdk.ts`, S43). Confirmed. `ClaudeSdk.open` now makes a runner with `FiberSet.makeRuntimePromise()` in the fiber that opens the child, and both the MCP `CallToolRequest` handler and the prompt iterable run through it, so the tool-call path logs through the brain's logger, level and events log, and its fibers are interrupted when the child's scope closes. No new test: the scripted SDK (`layerTest`) does not go through these callbacks, and the real SDK path needs a live child.
3. **`retry` mapped every failure to `task_not_found`** (`PiDurableHarness.ts`). Confirmed. `task_not_found` is now kept for pi-durable's own rejection of an unknown task (`Task <id> does not exist`, read in the installed `scheduler.js`; a task that is not parked is a no-op there, not an error). Every other rejection goes through `fromDurable` and keeps its reason (`unavailable`, `thread_busy`, `internal`) and cause. A task the brain does not have is also dropped from `Parked`, so the UI stops showing it. `Brain.test.ts` checks the unknown-task case.
4. **The mutation check had no control run and a weaker per-mutation threshold** (`Conformance.test.ts`). Confirmed. The check now first runs every scenario unmutated at its own 1,500 ms timeout and concurrency and requires zero failures, then requires at least five failed scenarios with all mutations and with each mutation alone (ADR 0024). Rerun: control 0 on both sides; pi-durable 18 with all, per mutation 17 / 8 / 10 / 18; scripted 18 with all, 17 / 11 / 10 / 18.
5. **The entry image route is unsigned, unrecorded** (`EntryImageRoute.ts`). Confirmed. Recorded above under "Deviations from the plan", with the decision to keep it unsigned.

Unverified concerns:

- **`Claude.ts` `handle` forked and never joined.** Real: a defect in `route` before a child is attached would leave pi-ai's stream open forever. `call` now wraps `handle` in `Effect.onError`, which logs the cause (unless it is an interruption) and fails the sink with the new fixed text `BRIDGE_FAILED_TEXT` (not retryable; `ClaudeGuards.test.ts` checks that pi-ai reads it so). A sink that already ended ignores the push.
- **Boot ordering of `CommitFeed`'s subscription.** Real, and fixed by finding 1: the feed now attaches synchronously while its layer builds, and `PiDurableHarness.layer` (with the feed) is built before the `HarnessBoot` layer that boot resumes through. The conformance runner's 30 ms sleep stays; it waits for the runner's own stream subscriptions, not the feed's.
- **`judges/lint-boundaries.test.ts` probes left behind by a killed run.** Real. Each probe is now removed in a `finally`, probes matching the judge's own name pattern are swept from the zones before the cases run, and `**/LintProbe*.ts` is in `.gitignore`, so a leftover is never committed (oxlint and oxfmt skip it; the judge still lints its probes, which it names explicitly).
- **`GET /_cairn/auth` answers any admitted device's `X-Cairn-Peer`.** Real but owner-only. The suggested fix (refuse requests carrying `X-Forwarded-For`) would break the route: Caddy's `forward_auth` is a `reverse_proxy` and sets `X-Forwarded-For` on its own subrequest. The server cannot tell the subrequest from a proxied request by headers a client controls, so the fix is in Caddy: `ops/cairn/caddy-route.sh` now adds `header_up -X-Cairn-Peer` to the `reverse_proxy` block, so only `forward_auth`'s subrequest names a peer. `caddy-route.sh --check` validates the candidate (live Caddyfile untouched). The route is not installed yet, so the first deploy (wave 2) picks this up.
- **`ops/relay/run.sh` hard-coded `chromium-1243`.** Real, and worse than reported: the relay's own pinned playwright (from `@playwright/mcp` 0.0.83) expects `chromium-1247`, which is not installed. `run.sh` now uses the relay's pinned Chromium when it is installed, else the newest `chromium-*` under `~/.cache/ms-playwright` (playwright attaches over CDP, so the revision need not match), logs the choice, and fails with an install hint when there is none. Today that resolves to `chromium-1248`. The running unit is not restarted by this change; it picks the new Chrome up at its next restart.

## Wave 2

Integrated on 2026-10-22 on `main`, and deployed: `https://code.gneiss.run` serves the brain over the user's API models.

### Packages

| Package | Branch | Commit | Status |
| --- | --- | --- | --- |
| 2A Models and pi config | `phase1/2-2A` | `cfd53f6` | done |
| 2B Projects, worktrees, launch and thread commands | `phase1/2-2B` | `81cdc94` | done |
| 2C Shell projector, boot and recovery | `phase1/2-2C` | `ae8c858` | done |
| 2D Sidebar and inbox | `phase1/2-2D` | `eb122e4` | done |
| 2E Hero and composer | `phase1/2-2E` | `059020a` | done |
| 2F Bridge usage and safety | `phase1/2-2F` | `1dba5a9` | done |

Each branch started at `4b74744` and merged with `--no-ff` in the order A to F. No file was touched by two packages, so there were no conflicts. The six package worktrees were removed and pruned before `pnpm check`. No dependency changed (no `package.json`, lockfile or catalog edit in any branch), so `pnpm install --frozen-lockfile` was enough.

### Integration judges

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | oxfmt clean on 418 files, oxlint 0 findings, typecheck clean in root and all 5 workspaces, vitest 84 files and 794 tests (about 52 s). The known `ClaudeConversation` stall flake (fixed by 2F) did not fire. |
| `judges/pi-readonly.sh` (real `~/.pi/agent`) | pass | 62,091 entries identical before and after, 0 `.lock`, 0 children. Boot (pi config, model runtime, Harness) 895 ms. Listing 29 models, all `opencode-go`; anthropic 0. Providers: opencode-go ready, anthropic refused, openai-codex missing. Skills: 76 in 387 ms, 0 missing packages. Turn on `opencode-go/minimax-m3` completed in 1,383 ms. |
| `node judges/durability.ts` (all 8 windows, faux models, the real `thread.launch` and `thread.send`) | pass | 8 of 8. Kill to first socket / socket to converged (ms): streaming 934/6; mid-tool 732/6 (after-slow once); between-tool-and-result 932/6 (m1 once); mid-commit 830/6; send-in-flight 781/17 (in-flight once); during-launch 839/8 (launch once; a real Worktree launch with `baseRef main`); kill-six 730, 935, 982, 934, 935 / 6 to 7 (1 task parked and retried, six once); sigterm-six 2,600 to 2,655 / 6 (nothing parked, term once). |
| `node judges/durability.ts --sabotage skip-snapshot` (control) | pass | 0 of 8 windows passed, as required (each "did not converge"). |
| `judges/shutdown.sh` | pass | sigterm-six: 7 closing and 7 closed lines, worst closed 2,016 ms, 0 shutdown_slow; systemd stop times 2030, 2024, 2025, 2025, 2025, 2021 and 15 ms. kill-six restarts 888, 985, 937, 937, 940 ms, effects six=1. Control: the stubborn stop took 3,060 ms and systemd killed it. |
| `node judges/typing.ts` (Chromium 1440, 20 cps for 60 s, 512 to 518 history rows) | pass | 1200/1200 match, firstDiff -1, lateKeys 1, maxLateMs 0, 486 rows streamed, IME ok, menus seen: path, skill, slash-command, 0 page errors. |
| `node judges/typing.ts --throttle 4 --busy 10` | pass | 1200/1200 match, lateKeys 6, maxLateMs 27, 487 rows streamed, IME ok, menu ok, 0 errors. |
| `node judges/typing.ts --mobile --throttle 4 --busy 10` | pass | 1200/1200 match, lateKeys 5, maxLateMs 28, 486 rows streamed, IME ok, menu ok, 0 errors. |
| `node judges/dev-smoke.ts` | pass | Live 1,853 ms after start; the demo thread grew from 2 to 8 entries; 0 page errors. |
| First deploy: `ops/cairn/install.sh`, `ops/cairn/caddy-route.sh`, `ops/cairn/deploy.sh` | pass | install created the data and cache dirs, wrote `cairn.json` (owner `oscabriel@github`, host code.gneiss.run), added the live worktree and enabled the unit. The Caddyfile was backed up (`Caddyfile.bak-before-cairn-20261022-051259`, plus the script's own `.bak-20261022-051305`) and the route, with `header_up -X-Cairn-Peer`, validated and went live. deploy: `vite build` 682 KB JS (200 KB gzip), 206 KB CSS (31 KB gzip); deploy-check listening 1,556 ms, hello 1,577 ms on 3774. Boot log: pi config read (76 skills), boot repairs then resume then reconcile, ready in 5 ms with 0 threads. NRestarts 0. |
| `judges/gate.sh` against `https://code.gneiss.run` | pass | 0 failed of 43 cases: 8 tailnet nodes (4 admitted as the owner, 4 refused) plus the made-up-owner control; loopback and LAN refused with forged headers; the tailnet path admitted (GET 200, WebSocket 101); direct hits 403 and wrong Host 421; the Origin matrix and Sec-Fetch-Site cases. Extra check: an admitted request to `/_cairn/auth` with a forged `X-Cairn-Peer` gets 403, so Caddy drops the client's header. |
| `node judges/live-chat.ts` (new, kept) against `https://code.gneiss.run` | pass | hello 23 ms; models.list 29 opencode-go, 0 anthropic; providers opencode-go=ready, anthropic=refused, openai-codex=missing; launched a scratch thread on `opencode-go/claude-haiku-5-5` (the hello's default) and the row was idle with an assistant preview 1,219 ms after the launch; the thread was then deleted. |
| Browser check of the deployed page (throwaway Playwright script, Chromium 1440) | pass | Live 210 ms after navigation. The no-projects hero showed; its Add project opened the sidebar's folder dialog (home folders listed). "Start without a project", typing a one-word prompt and Enter launched a thread, navigated to `/t/<id>`, and the reply "ready" showed 1,589 ms after the first key; the sidebar row read Done. 0 page errors. The thread was deleted afterwards. |

### Decisions taken at integration

- **Models in every entry point.** `PiDurableBrain` now takes a models layer typed `Layer<ModelSource | Models>` and also exposes it (`provideMerge`), so `main.ts` passes `PiModelSource.layer` once and the harness, the picker (`PiModelSource`) and the title model share one pi model runtime. `ScriptedBrain` carries a faux catalog (`withCatalog(ModelSource.layerFaux(...))`), so the dev brain, the shell-resume judge and `Ws.test.ts` need no change. `judge-main.ts` runs `withCatalog(JudgeModel.layer(200))` (2C's hand-off). `withCatalog` is a new `AppLayer` export: `PiModelSource.layerFromModelSource` over a model source. `main.ts` never runs the faux model now.
- **The title model reads the setting.** 2B handed off `TitleModel.layerNone` until 2A's settings landed; both landed this wave, so `ThreadsLive` uses a new `TitleModel.layerFromSettings`: each request reads `settings.titleModel` and asks that model through `ModelSource` (same timeout, bridge refusal and stop-reason checks as `layerFixed`, now one shared `completeOn`). No setting (the default) keeps the fallback: the first line as the title and a slug as the branch. The protocol comment says none should mean "the first available small model"; that choice is left for 4E's settings page, because no rule for "small" exists yet.
- **Boot repairs**, in the planned order: `retry-parked-approval-waits` (2C), then `resume interrupted launches` (2B). `Boot.ts`'s `BootLayer` replaces the inline boot.
- **`ThreadsLive` is exported** from `AppLayer` so `Boot.test.ts`, which composes the app by hand to gate its resume, stays in step with `AppLayer`.
- **FolderRules on `ProjectCreate`** (2B's note). `shell.dispatch` now runs `FolderRules.check(workspaceRoot, "add")` first and commits the real path; a refusal is `NotFound` with resource `folder`, as `projects.browse` answers. `ShellStream.test.ts` gives its handlers an allow-all `FolderRules` (`Layer.mock`), since its projects name folders that do not exist. Because the rule admits only folders under the home, `judges/durability.ts` now gives its brain `HOME` = the run's temporary folder and `judges/reconnect.ts` gives its dev brain `HOME` = the temp directory, where their projects live.
- **The web root.** 2E's `root-wiring.patch` applied cleanly and was deleted, then 2D's hand-offs went on top. The composer's `RequestedAddProject` now opens the sidebar's Add project dialog through a new child capability `openAddProject` in `sidebar/Update.ts` (Foldkit's lint forbids a root building a child's Message). 2D's `drafts` hand-off to 2E is also done at the root: `syncSidebar` derives the sidebar's draft rows from the composer's `draft:<id>` entries (first line, or "N attachments") and keeps the same array when nothing changed, and the sidebar's `RequestedDiscardDraft` calls a new composer capability `discardDraft`.
- **`oxfmt` ignores `judges/fixtures/parity/**`** (2D's optional hand-off), so the captured baseline stays byte for byte.
- **Not taken:** 2C's optional `ShellProjector.refresh` after `thread.retryTask` (the next event of the thread clears the parked pill, and the kill-six window passes without it), and 2F's `ClaudeUsage.layerBridge` wiring, which belongs with the bridge's provider wiring in 3F.
- **`judges/live-chat.ts` (new, kept).** The plan's "the user can chat with API models" had no judge; this one chats through the deployed route and cleans up after itself. It is also the integrated RPC smoke 2B asked to keep.
- **The glossary** gained Agent dir, Server settings, Launch, Temporary branch, Title model, Usage probe, One-shot, Stop hook, Turn content stage, Shell projector, Boot reconcile (with its Avoid line), Composer and Hero.

### Fixes to package code (minimal, at integration)

- **`Ws.test.ts` (1A)** checked typed errors through `models.list`, which is no longer a stub. It now uses `skills.list`, still a stub until 3E.
- **`ops/cairn/caddy-route.sh` (1E)**: its EXIT trap named a function local, so after the route went live `set -u` failed on it and the candidate file was left in `~/caddy/conf`. The path is now expanded into the trap when it is set; the leftover was removed. The route itself was applied correctly.
- **`TitleModel.ts` (2B)**: the request body moved into a shared `completeOn` so `layerFixed` and the new `layerFromSettings` are one code path.
- **`composer/Update.ts` (2E) and `sidebar/Update.ts` (2D)** each gained one exported capability (`discardDraft`, `openAddProject`) for the root wiring above.

### Gaps

- **The Executor grant was not touched.** 3D's link does not exist yet, so the deployed brain holds no grant and has no Executor tools.
- **The bridge is not wired** (3F): Claude through the subscription is not offered, `ClaudeUsage.layerBridge` is not provided, and `usage.subscribe` is still a stub. The deployed picker shows the user's `opencode-go` models only.
- **`autoSettleDays` does not drive Settlement yet** (2A's note: `SettlementConfig` is still 1B's fixed 3 days), and `bridgeGenerationCap` is stored only.
- **The add-project dialog does not close on Escape** (seen in the browser check; Cancel closes it). Left to 2D's owner or 5C's parity pass.
- **`judges/typing.ts` reported fewer menus seen under throttle** (none on desktop, path only on mobile) while still reporting the menu case ok and losing no keys. Closed by the review below: the menu case now waits for each menu, and all three open under 4x throttle on desktop and mobile.
- **No regenerated titles, no project setup script, no worktree cleanup on archive or delete** (2B's gaps), the protocol's `ProviderUsage` has no plan or reason (2F), and the hover card, drag reorder and custom snooze are not built (2D). All carried.
- **J7 used a stand-in system prompt** (2F); rerun `judges/claude-eligibility.ts` once 3E's sections exist.
- **The WebKit tier of the typing judge** is wave 5.

### Deviations from the plan

- **`thread_launches` is written before `thread.created`, not in one transaction with it** (2B): `EventSink` publishes inside its own transaction, so an outer one could hand clients events a rollback removes. Boot drops a launch row with no thread row (added by the review below; before it, nothing checked).
- **The pixel comparison lives in `judges/capture.ts cairn`**, not `judges/parity.ts`, which is 4F's (2D).
- **The migration file is `db/migrations/0002Launches.ts`** (key `0002_Launches`), following `Migrations.ts`'s convention rather than the plan's `0002_Launches.ts`.
- **The typing judge runs an in-process brain** (AppLayer, scripted harness, echo model) with Vite, rather than `dev-main.ts` itself (2E); `--url` points it at a running page instead.
- **One extra integration judge**, `judges/live-chat.ts`, and one deployed-page browser check, beyond the plan's list.

### Review

A review of `4b74744..main` reported five confirmed findings and five unverified concerns. Each was checked against the code; all five findings were confirmed and fixed, and four of the concerns were real and fixed. `pnpm check` is green afterwards (85 files, 803 tests).

Confirmed findings:

1. **A projector flush wrote back a stale `activity`** (`ShellProjector.ts`). Confirmed: a projection copied the whole row when its first event arrived (`ThreadEnsured` changes nothing), and the flush diffed every field against the row as it stood up to 50 ms later, so a launch's `idle` or `failed` (and its `lastError`) could be overwritten with the copy. A projection now records the fields its events set (`changed`), and `write` rebases them on the fresh row (`rebase`): the row's own fields stand, the set ones lay over them, and `activity` is recomputed over the result; a projection that set nothing writes nothing. The module header's rule 3 says so. New test: `ThreadEnsured` inside an open window, then an outside `ThreadActivityUpdate` to `failed` with a `lastError` before the flush; the row stays `failed` with its error, and a later `QueueChanged` keeps both. It fails on the old code (`idle`).
2. **The stall test still raced the wall clock** (`ClaudeConversation.test.ts`). Confirmed. `advanceUntilDone` and its live sleeps are gone: the test polls with `Effect.yieldNow` until the fake SDK has recorded the child's run (the realpath is the only off-clock work, and it comes first), gives the scheduler 50 turns, then makes one `TestClock.adjust("100 seconds")`, past the 90 second limit; `adjust` wakes the watchdog's 5 second ticks in order. 24 runs of the file under six parallel runners all passed.
3. **The menu case passed with no menu open** (`judges/typing.ts`). Confirmed. The text is typed in four pieces, each ending on a trigger character, and the judge waits (5 s) for `[data-testid="composer-menu"][data-trigger=<kind>]` before typing on; `menu` is `ok` only when the text is intact and the path, slash-command and skill menus all opened (else `menus did not open: <kinds>`). Rerun below: all three open in every tier, so the wave's gap is closed. The old `MutationObserver` sampling was what missed them.
4. **A launch row with no thread row was "resumed"** (`ThreadLaunch.ts`). Confirmed: nothing checked the thread row, so a Root launch could ensure a pi-durable conversation for a thread that does not exist, and a scratch launch claimed a folder it never removed. `prepare` now checks the thread row first; with none, `discardOrphan` removes a worktree the launch made (`cleanUp`), the scratch folder when `cwd` is set (new `ScratchProject.releaseFolder`, which only removes a folder directly under the scratch root), and the launch row, and logs `launch_orphan_discarded`, without ensuring or committing anything. The same check closed an in-process race: a resent launch that finds the launch row but no thread row (the first launch is between its two inserts) no longer starts the fiber, which would have dropped the launch; the first launch starts it. Three new `ThreadLaunch.test.ts` cases (a Root orphan, a scratch orphan with a claimed folder, a resend between the inserts); the last two fail on the old code.
5. **File headers below the first import** (`FileSearch.ts`, `composer/Command.ts`, `composer/Model.ts`). Confirmed, and the same defect was in seven more files (`http/Ws.ts`, `smoke.test.ts`, `connection/Outbox.ts`, `judges/claude-eligibility.ts`, `judges/claude-reminder.ts`, `judges/typing.ts`, `ClaudeHarness.test.ts`). Every header now starts its file; oxfmt keeps them there.

Unverified concerns:

- **Git stderr in logs.** Real: `GitError` carries the end of git's stderr into the log and into a failed launch's `lastError`, which the client shows, and a remote URL there can embed a token. `Git.ts` now passes the tail through `redactUrls`, which replaces the user info of every URL with `***` (`https://***@host/...`). New `Git.test.ts`: the pure case, and a real `git ls-remote` against a closed port whose error never repeats the token.
- **Launch resume runs before `resume` and `reconcile`.** Checked, kept. pi-durable's README says submitting starts the task scheduler as `resume()` does, so a launch fiber's `ensureThread` or `submit` before the explicit resume is legal, and every other repair has run by then (launch resume is the last). The reconcile cannot undo a launch's activity any more: it goes through the same `rebase` as finding 1. The plan's boot order stays; the pi-durable path of "ensured, then submitted before resume" is still not exercised by a judge.
- **`ClaudeSdk.realProbe` retry loop.** Real in part: the SDK documents `rate_limits_available: false` for API key, Bedrock and Vertex logins, but also for a missing profile scope, and a false from a claude.ai login replaced the known windows. `readProbe` now reads an answer that names a subscription (`subscription_type` set) yet says no plan limits as unknown, so `applyReading` keeps the windows, and the probe retries that answer like a null `rate_limits`. A new `ClaudeUsage.test.ts` case checks it; the API key case is still unavailable.
- **`Threads.send` returned `Unavailable` for `ThreadNotReady`.** Real, and worse than a toast: the outbox keeps a retryable failure at its head until the next connection, so a turn sent while the thread was preparing (the composer allows it) held every later outbox item until a reconnect. `Threads.send` now waits for the thread's launch to finish (polling `LaunchStore` every 100 ms, up to `LaunchWait`, a `Context.Reference` defaulting to 60 s) and then submits, so the turn lands after the first message; only a launch that outlasts the wait is refused with `ThreadNotReady`, still mapped to `Unavailable`. `Threads.test.ts` has both cases.
- **`PiConfig` logged settings parse errors unbounded.** Real: V8's JSON errors quote a fragment of the text. `settingsErrorText` drops everything between the first and last double quote and cuts the rest to 200 characters; `PiConfig.test.ts` checks a parse error over a made-up secret.

Judges rerun after the fixes:

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | 85 files, 803 tests; oxfmt and oxlint clean. |
| `node judges/typing.ts` | pass | 1200/1200 match, lateKeys 1, maxLateMs 0, 486 rows streamed, IME ok, menu ok, menus seen: path, skill, slash-command, 0 errors. |
| `node judges/typing.ts --throttle 4 --busy 10` | pass | 1200/1200 match, lateKeys 2, maxLateMs 8, IME ok, menu ok with all three menus seen, 0 errors. |
| `node judges/typing.ts --mobile --throttle 4 --busy 10` | pass | 1200/1200 match, lateKeys 12, maxLateMs 28, IME ok, menu ok with all three menus seen, 0 errors. |
| `node judges/durability.ts` | pass | 8 of 8; kill to first socket 779 to 936 ms, socket to converged 5 to 8 ms; during-launch 827/8; sigterm-six 2,601 to 2,650 ms. |
| `node judges/durability.ts --sabotage skip-snapshot` (control) | pass | 0 of 8, as required. |
| `judges/pi-readonly.sh --no-turn` | pass | 62,091 entries identical, 0 children, 76 skills, 0 problems. |

The deployed brain on 3774 still runs the wave 2 build; these fixes reach it at the next `ops/cairn/deploy.sh`.

## Wave 3

Integrated on 2026-10-22 on `main` and deployed to `https://code.gneiss.run` (`54696bc`, then this note's commit). The deployed brain now takes attachments, shows the real transcript, reaches Executor's tools with the imported grant, offers Claude through the bridge, loads the user's skills and project context, and makes its VAPID key.

### Packages

| Package | Branch | Commit | Status |
| --- | --- | --- | --- |
| 3A Attachments, server side | `phase1/3-3A` | `d38eec9` | done |
| 3B Attachments and paste, client side | `phase1/3-3B` | `1322475` | done |
| 3C Transcript | `phase1/3-3C` | `69f7691` | done |
| 3D Executor tools | `phase1/3-3D` | `0b48afd` | done |
| 3E Skills, context and expansion | `phase1/3-3E` | `48c4971` | done |
| 3F Bridge wiring | `phase1/3-3F` | `b79d64c` | partial (J2 held case, below) |
| 3G Push and PWA | `phase1/3-3G` | `0531c91` (and `c385cd8` on `phase1/3-3G-handoff`) | done |

Every package started from `e06edf6` after an interrupted first attempt; each branch holds one clean commit. The seven worktrees were removed and pruned before `pnpm check`, then the branches merged with `--no-ff` in the order A to G without a conflict. 3G's hand-off commit was cherry-picked; 3A's `integration.patch` and 3E's `wave3-handoff.patch` applied with `git apply -3` (two conflicts in `Migrations.ts` and `Handlers.ts`, resolved by keeping every entry); 3B's `composer-wiring.patch` applied cleanly. The three patch files were deleted. No dependency changed.

### Integration judges

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | oxfmt clean, oxlint 0 findings, typecheck clean in root and every workspace, vitest 115 files and 1,040 tests. `judges/lib/Events.test.ts` "reads a replaced, shorter log" failed once under load and passed on the rerun (the flake 3D and 3G reported). |
| `apps/server/src/threads/TurnContent.integration.test.ts` (new) | pass | One turn with `$shared` and a 3-page PDF on a real pi-durable brain over the faux model, through the production stages: the model's user message is pi's `<skill name="shared" ...>` block ending in the typed text, then the attachment block with all three page nonces and `--- Page 3 of 3 ---`; exactly 1 `cairn.user` entry. |
| `ops/cairn/deploy.sh` | pass | listening 1,551 ms, hello 1,578 ms. Boot log: Executor grant imported, VAPID key pair made, attachments swept, pi config read, claude bridge ready, 0 orphaned claude processes, 7 boot repairs. |
| `node judges/tools.ts` (deployed brain, `opencode-go/claude-haiku-5-5`) | pass | Executor connected. convex 12,558 ms (`tools["cairn-bridges"].convex.status`), playwright 8,563 ms (`...playwright.browser_navigate`), github 7,542 ms (`tools.github.repos.get`), open turn 13,068 ms (search before call, then playwright). Each answer quoted a value from the tool result. |
| `node judges/live-chat.ts` | pass | hello 24 ms, launch 8 ms, reply 1,820 ms; providers opencode-go ready, claude-bridge ready, anthropic refused, openai-codex missing. |
| J7 live: `node judges/live-chat.ts --model claude-bridge/claude-haiku-5-5 --project ~/Developer/projects/cairn` | pass | The deployed brain's real sections (Cairn section, the user's skills, this repo's context) through the bridge: reply in 3,627 ms, row idle, no refusal. |
| `node judges/claude-eligibility.ts` (J6, J7) | pass | J6: probe 462 ms (209 to 462), max plan, five-hour 30 %, weekly 44 %, API key stripped, empty home not logged in. J7: 129 skills, 55,554 instruction characters, sendable, success, no third-party refusal, `isUsingOverage` false; cache read 23,086, write 345. |
| `judges/gate.sh` | pass | 0 failed of 43 cases. |
| `judges/relay-orphans.sh cairn-bridges ... executor` | pass | 5 cases, 0 orphans; healthy after kill9-main 2,819 ms, kill9-child 1,016, restart-unit 1,048, stop-start-unit 1,054, restart-peer 3,120. |
| `judges/claude-kill.sh` (J2, J9; judge brain with `--models real`) | 2 of 3 | streaming pass (run alone twice): cache read 42,067, write 0; children gone 55 ms; snapshot 5 ms. answer pass: 42,056 / 347; 56 ms; 13 ms. parked fails only `cacheKept`: 3,235 / 39,171 (marker once, interrupted result committed, children gone 57 ms, snapshot 9 ms). J9 in every case: 0 claude processes outside the unit after kill, restart and stop. |
| `node judges/durability.ts --bridge` (new windows) | 1 of 2 | bridge-streaming pass (42,064 / 0, snapshot 15 ms); bridge-tool-parked fails as the parked case above (3,235 / 39,161). |
| `node judges/claude-live.ts --case tools,paste,compaction,switch,deleted,restart` (J5, paste, J4) | pass | tools: 31 in `system:init`, no ToolSearch, `synthetic_17` called directly. paste: nonce MARLIN5309 from a 17,862 B PNG. compaction: fresh session, fact used, 1,941 / 967. switch: both facts, 1,941 / 669. deleted: fresh session, no error, 1,941 / 640. restart: native resume with no `resumeSessionAt`, 29,933 / 375 (was 8,206 / 22,095 before the fix below). |
| `node judges/durability.ts` (8 windows) | pass | 8 of 8 on the second run; kill to first socket 1,133 to 1,340 ms, socket to converged 5 to 17 ms; sigterm-six 3,004 to 3,018 ms. The first run passed 7 of 8: sigterm-six "did not converge" at the end, then passed alone and in the full rerun. |
| `node judges/typing.ts` (real transcript renderer) | pass | 1,200/1,200, lateKeys 1, maxLate 0 ms, 514 history rows, 486 rows streamed, IME ok, menus path, skill, slash-command, 0 errors. |
| `node judges/typing.ts --throttle 4 --busy 10` | pass | 1,200/1,200, lateKeys 4, maxLate 42 ms, 488 rows streamed. A run beside other judges streamed only 14 rows (keys still all arrived, maxLate 48 ms). |
| `node judges/typing.ts --mobile --throttle 4 --busy 10` | pass | 1,200/1,200, lateKeys 1, maxLate 0 ms, 486 rows streamed. |
| `node judges/dev-smoke.ts` | pass | live 2,757 ms, 3 increases, 0 page errors (reads the transcript's row count now). |
| `node judges/transcript-scroll.ts` | pass | 2,100 rows; follow 360 frames, max 1 px; scroll-up 0 moves; expand 0 moves; pill 0 px; switch offset delta 0 px; 0 long tasks; load 2,401 ms. |
| `node judges/paste-client.ts` and `--real` | pass | All five cases in both modes. 3000x1500 PNG uploaded as 1568x784 (27,441 B); 40,000 B text folded; pasteToRequestMs 42 to 44; send held 1,561 ms, fired 19 ms after release with all five ids; with `--real` the brain's own routes answered. |
| `node judges/push.ts --pwa` (3G PWA check) | pass | registered by the page at scope `/`, active `/sw.js`, manifest linked, 4 icons 200, no fetch listener, 0 errors. |
| `judges/pi-readonly.sh --no-turn` | pass | 62,091 entries identical, 0 children. |

Not rerun: `judges/claude-ttft.ts` (J13, 60 turns; 3F's numbers stand, and integration changed nothing on that path) and `judges/skills.ts` (3E's run stands; J7 and the integration test cover the wired path).

### Decisions taken at integration

- **Order of everything wired.** Turn content: text, skill expansion, attachments. Boot repairs: the attachment upload sweep, the Executor sweep, the parked approval retry, then interrupted launches. Close hooks: the bridge's `beginClosing` first. Extensions (by order key): coding tools, the Cairn, skills and context sections, code mode, the Executor proxies, bridge-cwd, the provider request log.
- **Composition.** `main.ts` alone provides `ExecutorLink.layer` (over the exported `DatabaseLive`, so one connection), `BridgeProvider.layer`, `BridgeExtraProviders` and `VapidKeyFromFile`. `dev-main.ts` and `judge-main.ts` use `ExecutorLink.layerFake`; tests and the hand-built judges use `ExecutorLink.layerDisabled`. `judge-main.ts` gained `--models real` (3F).
- **Executor sign-in pushes** (3D to 3G, which neither package could see): a new `push/ExecutorSignInPush.ts` layer in `AppLayer` follows `ExecutorLink.statusChanges` and calls `Notifier.executorNeedsSignIn` on a move into needs-sign-in and `executorSignedIn` on a move back to connected, with a test.
- **The transcript is mounted** (3C's hand-offs). The thread page keeps its title in a small header above the transcript instead of dropping it, until the page header arrives in parity work. `EntryText.ts` was deleted. The timeline root carries `data-rows` (its row count, virtualized rows included), and `dev-smoke.ts` and `typing.ts` read it instead of counting DOM rows, which the virtual list no longer renders all of.
- **`pasteToRequestMs`** is an optional field of `CreateUploadUrlInput` (3B's hand-off), sent by the tray and logged on `attachment.url_issued`.
- **`durability.ts --bridge`** runs the bridge windows through `judges/claude-kill.ts` (bridge-streaming is its streaming case, bridge-tool-parked its parked case) rather than a second copy of that driver.
- **J7 with the real sections** runs two ways: `claude-eligibility.ts` (its own render of every skill and this repo's context, checked for overage) and a turn through the deployed brain on `claude-bridge/claude-haiku-5-5` in this repo's project (`live-chat.ts` gained `--project` and accepts any available `--model`).
- **ADRs.** 0016, 0018 and 0024 are accepted (gate evidence appended to each). 0017 stays proposed: J2's held case does not keep the cache.
- **Optional hand-offs taken:** the `judges/claude-live.ts` lint zone (its five disable comments removed), the apple-touch-icon link, every glossary term offered (Turn, Fold, Executor grant, Boot sweep, Skill catalog, Skill expansion, Run pin, Context sections, Attachment tray, Prepared image). **Not taken:** `Skills.local` in `judges/typing.ts` (the menus open without it).

### Fixes to package code (minimal, at integration)

- **`packages/bridge/src/ClaudeConversation.ts` (1F), from 3F's finding:** `resumeSessionAt` is passed only when the cut is not the transcript's last entry, because with it Claude Code resends the history without cache breakpoints. Four expected `at` values in `ClaudeConversation.test.ts` and `ClaudeHarness.test.ts` became `None`.
- **`packages/bridge/src/Claude.ts` (1F), from 3F's finding:** the conversations `RcMap` counted idle entries against the 12-child cap, so a 13th conversation within 10 minutes was refused. A conversation at the cap now evicts the least recently used idle conversation (no call in flight; a held tool call keeps its call in flight) and retries once, as the idle time to live would have later. Not taken: invalidating on `abortConversation`, which broke the fork-after-abort memory. New test: "evict the least recently used idle conversation for a new one instead of refusing it" (fails without the change).
- **`judges/tools.ts` (3D):** the call-path regex stopped at the first quote inside a bracketed path, and a server name was read only from the first segment. Executor serves the stdio servers under one source (`tools["cairn-bridges"].convex.status`), so the judge now reads the first two segments, and it also finds the project by folder when its row has no repository yet (this repo's project was registered before repository identity).
- **`judges/paste-client.ts` (3B):** `--real` observed neither the upload route nor `attachments.createUploadUrl`, and counted only the stub's `att_NNNN` ids. It now records both without answering and counts the send's `attachments` list.
- **`apps/web/src/page/thread/Thread.test.ts` (1D):** two story tests drive `update` directly, because the transcript's re-anchoring Command is the virtual list's, not the page's.
- **`CodingTools.test.ts`, `Ws.test.ts`, `Boot.test.ts`, `Brain.test.ts`, `conformance/Targets.ts`, `AttachmentFlow.test.ts` and four judges** follow the new extension set and `ExecutorLink` requirement.

### Gaps

- **J2's held case** (bridge-tool-parked): after a `kill -9` during a held `bash` call, Claude Code repairs the dangling tool_use on resume and the first reply rewrites the prefix (3,235 read, 39,171 written). 3F's suggested remedy (resume at the entry before the tool_use) would need `resumeSessionAt`, which loses the cache by itself, so it needs another approach. ADR 0017 stays proposed.
- **Wizard items** (5F's `ops/wizards/phase-1.sh`): `node judges/push.ts --send --wait 300` needs the installed PWA, and the push toggle is mounted only by 4E's settings page; until then the push submodel runs headless (worker, re-check, presence, taps, badge). The Executor re-sign-in step stays as planned (the grant imported, so it is not needed now).
- **The streaming bridge case printed no result twice** when it ran first in a sequence while browser judges ran beside it; it passed both times it ran alone. Treat bridge judges as needing a quiet machine.
- **Throttled typing beside other load** streamed 14 rows in 60 s instead of about 490 (keys were all on time). Wave 4's load and wire budget work should measure the transcript's cost per streamed row.
- **Boot got slower**: the judge brain's kill to first socket rose from about 0.8 to 0.9 s to about 1.2 to 1.3 s and a clean restart from 2.6 to 3.0 s, mostly the skill catalog's cold resolve (3E measured 408 to 570 ms against 600).
- **`upload-signing.key` already existed** in `~/.config/cairn` before the deploy (made by a dev or judge brain); the deployed brain uses it. Fixed in the review below (`UploadKeySource`); the key should be deleted once before a deploy.
- **Carried from the packages:** no drag-over highlight on the composer (3B); user image attachments show as chips, not thumbnails, and t3code's new-turn anchoring, minimap and day-aware timestamps are not built (3C); `ExecutorSweep` sees only conversations with live tasks (3D); `TitleModel.completeOn` sends no session id, so an opencode-go Claude title model would fail (3E); `autoSettleDays` and `bridgeGenerationCap` still drive nothing (3F); headless push subscribe was not exercised end to end (3G).

### Deviations from the plan

- **Migration files** are `0003Attachments.ts`, `0004Executor.ts` and `0005Push.ts` (keys `0003_Attachments` and so on), following `Migrations.ts`'s convention.
- **The upload route is `POST /api/attachments/upload/*`** (3A): find-my-way refuses path parameters over 100 characters and a signed token is about 260.
- **The markdown parse is written in-house** (3C), not D30's remark port, because remark and unified are not in the catalog.
- **3D's composition test** lives at `executor/Composition.test.ts`, not `main.test.ts`; it now runs its "main.ts composes the real link" case.
- **Bridge durability windows** are run by `claude-kill.ts` through `durability.ts --bridge`, not by `durability.ts`'s own driver.
- **Extra judges and modes:** `live-chat.ts --project` for J7 on the deployed brain, `paste-client.ts --real`, `claude-live.ts --case restart`, and `ExecutorSignInPush.test.ts`.

### Review

A review of wave 3 reported eight confirmed findings and seven unverified concerns. Each was checked against the code; all eight findings were confirmed and fixed, and four concerns were real and fixed. `pnpm check` is green afterwards (115 files, 1,045 tests). None of this is deployed yet: the deployed brain picks it up at the next deploy, which also runs migration `0006_ExecutorSignal`.

Confirmed findings:

1. **A bad grant file or a missing `flock` stopped the deployed brain from booting.** Confirmed: every `ExecutorGrantError` from the grant layer failed `Layer.launch(MainLayer)`. `ExecutorLink.layer` now catches `ExecutorGrantError`, logs `executor_grant_failed` at warning, and builds a `disabled` link whose detail is the error's message (`disabledLink`, shared with `layerDisabled`). New `ExecutorGrant.test.ts` case: a malformed `executor-grant.json` gives a `disabled` link whose calls are refused unsent.
2. **An unreadable grant row read as "no grant, run the wizard".** Confirmed. The boot load logs `executor_grant_unreadable` with the cause, and the `disabled` detail says the stored grant could not be read, to delete the `executor_grant` row, then run the wizard.
3. **The needs-sign-in table had no reader.** Confirmed. The signal reaches the user through the link's status: `ExecutorSignInPush` pushes once per lapse and `executor.status` answers the client. `ExecutorGrant.needsSignIn` is gone and migration `0006_ExecutorSignal` drops `executor_sign_in_needed`. A shell event (`executor.status-changed`) is left to 4E's settings page if it wants one; `statusChanges` is the seam for it.
4. **Dev and judge brains made and read the deployed `upload-signing.key`.** Confirmed. `UploadKeySource` mirrors `VapidKeySource`: a random key in memory by default, the file only when the entry point provides `UploadKeyFromFile` (only `main.ts`; the attachment test layer also does, over its temporary directory). New `UploadTokens.test.ts` case: the default makes no file. The key now in `~/.config/cairn` was made by a dev or judge brain; delete it before a deploy so the deployed brain makes its own (only upload URLs younger than 10 minutes are lost).
5. **Concurrent calls on a forgotten session came back "may have run".** Confirmed: the first `McpSessionExpiredError` completed `session.lost` and failed its siblings as lost and sent. A request's own failure now retires its session (`retire`: no new calls get it, the client closes after the request timeout), and only the ping and a sign-in reset complete `session.lost`, so each sibling's own 404 classifies it as unsent and it is resent once. New `ExecutorTools.test.ts` case (three concurrent calls after a restart, all answered, each run once); it fails on the old code.
6. **A new grant file was renamed away when a row existed.** Confirmed. The file is renamed only after an import; beside a stored row it is left alone and `executor_grant_file_ignored` says to sign in again from settings or delete the row. New `ExecutorGrant.test.ts` case.
7. **Environment read inside service layers.** Confirmed. `ServerConfig` has `stateDir` (`XDG_STATE_HOME`, else `~/.local/state`), which `ExecutorGrant.layer` uses for the lock; `Config.ts` exports `homeDirectory` (`HOME` through `Config`, else `os.homedir()`), which `SkillCatalog.layerNoDeps`, `Skills.local` and `PiConfig.layer` use. No `process.env.HOME` or `XDG_STATE_HOME` read is left in service layers.
8. **`BridgeCwd` kept every session id since boot.** Confirmed. `rememberSession` keeps the last 8 sessions per thread and the 256 most recently used threads, so the map and the stop hook's abort list stay bounded. New `BridgeCwdExtension.test.ts` case.

Unverified concerns:

- **J2's held case.** Real, not fixed here: it needs a different resume approach, and ADR 0017 stays proposed (see Gaps). The streaming case's flakiness under load is recorded there too.
- **Boot ordering race on uploads.** Real in principle: the listener serves before boot, and a token issued before a restart stays good for 10 minutes, so an upload could stream into `attachments/.tmp` while the boot sweep removes it. The upload route now answers 503 (`unavailable`, retryable) until `Health` is ready, as `/ws` does.
- **`ExecutorSweep` sees only conversations with live tasks.** Real, kept as a gap: pi-durable's `inspect` lists live work only, and listing every conversation needs a thread-to-conversation read that the shell store does not keep. Executor expires an unanswered request after its 10 minute window, and nothing in Cairn accepts one whose task is gone.
- **`ClaudeSignals.limitSignals` was sequential.** Real: each limited run could wait 15 s on the probe before the next run's signal. It is now `mapEffect` with `concurrency: 16, unordered: true`; concurrent waits join one probe (`ClaudeUsage.probe` shares the one in flight), so it starts no extra `claude` child.
- **Hard-link refusal in `ProjectContext`.** Checked, kept: a hard link can alias a file outside the workspace, so refusing `nlink > 1` is the safe reading, and `skills.list`'s report names the skipped file.
- **`Composition.test.ts` did not scan `ops/`.** Real; it now does.
- **Judges not rerun by the reviewer.** The deployed-brain and real-Claude judges were not rerun here either: the fixes are not deployed, and the changed code is covered by the unit tests above and the judges below.

Judges rerun after the fixes:

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | 115 files, 1,045 tests |
| `judges/paste-client.ts --real` | pass | five cases ok, paste to request 42 ms, five uploads through the brain's own routes on the in-memory key |
| `judges/dev-smoke.ts` | pass | live 2,381 ms, no page errors |

## Wave 4

Integrated on 2026-10-22 on `main` and deployed to `https://code.gneiss.run` (`e338445`, then this note's commit). The deployed brain now inlines boot data and logs load reports, windows long threads, records checkpoints and shows changed-files cards with a diff panel, has a settings page, a hold banner and a usage meter, and keeps the cache when a held bridge tool call is killed.

### Packages

| Package | Branch | Commit | Status |
| --- | --- | --- | --- |
| 4B Load and paste to model | `phase1/4-4B` | `67391a6` | partial (entry budget, below) |
| 4C Thread stream windowing and wire budget | `phase1/4-4C` | `1da4128` | done |
| 4D Checkpoints and diffs | `phase1/4-4D` | `fd6e702` | done |
| 4E Settings, providers, usage and parked tasks UI | `phase1/4-4E` | `102c736` | done |
| 4F Parity harness and checklist | `phase1/4-4F` | `07adc81` | done |
| 4J2 J2 held-tool cache after a kill (extra, not in the plan) | `phase1/4-4J2` | `ce8379d` | done |

The six branches merged with `--no-ff` (J2, C, D, E, F, B) and every hand-off was applied in `e338445`, which was deployed. That integrator run was cut off by an auth failure after the deploy; this run verified `e338445` (`pnpm check` green), deleted the six package branches and the six workflow worktree branches, pruned worktrees, ran the judges below and wrote this note. No dependency changed. The old `upload-signing.key` was deleted once before the `e338445` deploy, so the deployed brain made its own (the wave 3 gap).

### Integration judges

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | oxfmt clean, oxlint 0, typecheck clean, vitest 127 files and 1,126 tests. |
| `apps/web/src/Budget.test.ts` | pass | entry JS 270,240 B gzip (ceiling 294,912, target 200,000, decision below); entry CSS 33,155 B against 35,000; lazy chunks `src/diff/View.ts` and `src/settings/View.ts`, both out of the entry's static imports. |
| `node judges/load.ts` (Chromium, deployed brain through Caddy) | pass | lan p50 176 / p95 201 ms (max 288); 4g (60 ms, 10 Mbps) p50 532 / p95 535 ms; 5 requests before interactive; 320,668 bytes transferred; boot JSON 1,937 chars. Control (`index.html` held 1,500 ms) p50 1,680 ms, failed as designed. |
| `node judges/paste.ts` (automated tier) | pass | lan paste to chip p50 70 / p95 76 ms, send to `turn.submitted` max 8 ms, sha256 20/20; throttled p50 169 / p95 172 ms, max 6 ms, 20/20; paste and send at once max 65 ms; 51 MiB PDF refused. Real models: bridge and opencode-go image nonces, 3/3 PDF page nonces, scanned 'no text layer', DOCX nonce. |
| `node judges/wire-budget.ts` | pass | 2,017 active entries, 20 images. Snapshot 41,325 bytes (4,176 deflated), 72 entries, `entriesOffset` 1,945. First frame loopback p50 15 / max 22 ms; modelled tailnet p50 258 / p95 265 ms. No base64; 20/20 images by reference; history complete in 4 pages. (4C's projection-only run: 1,133,675 bytes, over budget, which is why the window exists.) |
| `judges/claude-kill.sh` (J2, J9; quiet machine, load average under 1) | pass, 3 of 3 | streaming 42,064 read / 0 written, children gone 57 ms, snapshot 14 ms. parked (held tool, after 4J2) 42,079 / 336, 55 ms, 11 ms. answer 42,050 / 223, 56 ms, 6 ms. Marker once, interrupted result, 0 orphans after kill, restart and stop in each. |
| `node judges/durability.ts --bridge` | pass on the second run | Run 1: bridge-streaming printed no result (the known flake), bridge-tool-parked pass (42,079 / 335). Run 2: both pass (42,064 / 0 and 42,079 / 339). |
| `node judges/durability.ts` | pass | 8 of 8 windows; kill-six kill to up 1,179 to 1,281 ms, up to converged 5 to 6 ms; sigterm-six 3,059 to 3,067 ms. |
| `node judges/live-chat.ts` | pass | hello 23 ms, launch 12 ms, reply 1,424 ms; 29 models; opencode-go and claude-bridge ready, anthropic refused, openai-codex missing. |
| `judges/gate.sh` | pass | 0 failed of 43 cases. |
| `node judges/tools.ts` (deployed brain) | pass | Executor connected. convex 14,078 ms, playwright 8,050 ms, github 7,043 ms, open turn 15,081 ms; each answer quoted the tool result. |
| `node judges/capture.ts cairn`, `judges/parity.ts` | report complete | 29 states, 8 within budget (all 8 sidebar at 0 %); hero 1.40 to 12.31 %, thread 4.81 to 17.29 %; 1 missing (streaming, no t3code baseline); control 73.1 % differing. |
| `node judges/parity-structure.ts` | report complete | 21 hero and thread states, 0 pass (wave 5's work); self and sabotage controls behave. |
| `node judges/behaviour.ts` | 18 of 21 | Fails: footer-820 (t3code folds mode to icon-only at 516 px, Cairn stays full at 524 px), footer-390 (t3code hides traits and mode behind an overflow, Cairn shows them icon-only), drafts-reload (hero draft not restored). |
| `judges/parity-review.sh` (opencode-go/gpt-6-luna) | report complete | 7 batches (sidebar 2, hero 3, thread 2), joined in `review.md`. |

**Parity report:** `~/Developer/agent-artifacts/cairn/v2/phase-1-parity/` (`report.json`, `index.html`, `structure.json`, `behaviour.json`, `review.md`), served at `https://plans.gneiss.run/cairn/v2/phase-1-parity/`. Wave 5 starts from it.

Run order for the parity report: `node judges/capture.ts cairn`, `node judges/parity.ts`, `node judges/parity-structure.ts`, `node judges/behaviour.ts`, `judges/parity-review.sh`. Each exits 0 when its report is complete and its controls behave; `--strict` (every state passing) is wave 5's bar. The pixel comparison lives in `judges/parity.ts` now (`capture.ts` only captures), reversing wave 2's deviation note.

### Decisions taken at integration

- **Entry JS budget: the target is relaxed, no further splits.** The entry is 270,240 B gzip against D46's 200 KB. Effect, foldkit and its UI package are about 100 KB gzip before any Cairn code. Splitting the transcript and markdown would save about 30 KB, not enough for 200 KB, and would add a round trip to every cold load of a thread page, the cost D46 actually budgets. The load judge passes against the deployed brain with this entry (lan p95 201 ms, 4g p95 535 ms against 1,500 ms). `Budget.test.ts` enforces 288 KiB and reports 200 KB as the target; ADR 0021 is amended with these numbers and stays proposed until the phone stages of the wizard.
- **The diff and settings views load on demand** through `page/thread/DiffPanel.ts` and `SettingsPage.ts`: the update asks for the `import()`, the module is held outside the Model, and a `Loaded*` message makes the page render it. Their Model, Message and update stay in the entry, because the usage meter reads settings state on every route and the transcript opens the diff panel.
- **Checkpoint entries are written in production:** `HarnessSeam.write` (pi-durable `submit({type: "write"})`, and an idempotent append in `ScriptedHarness`) backs `CheckpointEntries`; `CheckpointCapture` is built before Boot so it subscribes before resume; its repair runs as a boot repair.
- **4J2's fix** (`ClaudeResume.resumeAppend`: a resume or fork-stamped child gets the current instructions as its append when the stamped state had one) is the J2 held-case remedy. The dangling tool_use repair was not the cause; the missing append changed Claude Code's agent line.
- **4F's hand-off taken:** the `t3-mobile-*` view-transition names became `cairn-mobile-*` and the known-leftovers entry left `judges/brand.test.ts`.
- **Glossary:** every offered term was taken (Window, Boot data, Load report, Client settings, Hold, Parity baseline, Landmark) and Checkpoint was rewritten.
- **ADRs.** 0017, 0019 and 0020 are accepted with the numbers above appended. 0021 stays proposed (phone stages).

### Fixes to package code (minimal, at integration)

- **`judges/lib/Events.ts` (1E):** `size` stats once and maps NotFound to 0 instead of exists-then-stat, which raced a replaced log. This was the "reads a replaced, shorter log" flake three packages reported.
- **`apps/web/src/diff/Update.ts` (4D):** the close step is exported as `close` so the thread page can close the panel on a thread switch.
- **`apps/web/src/timeline/Rows.ts` (3C):** a height estimate for the new `changed-files` row.
- **`packages/client-logic/src/DiffTree.ts` (4D):** `checkpointSummaryOf` takes `Entry["data"]` (typecheck after the TimelineEntries hand-off); a stray doc comment removed in this run.
- **`ShellProjector.test.ts`, `ClaudeSignals.test.ts`:** their fake seams gained `write`.

### Gaps

- **Entry JS** is 270 KB gzip, not 200 KB (decision above).
- **The streaming bridge window still flakes:** it printed no result on the first `durability.ts --bridge` run (and failed twice in 4J2's session), then passed. It needs its own investigation in 5A's matrix (the fresh-session-after-kill path or Claude Code's request fingerprint).
- **Phone halves** of load and paste (wizard stages 3 and 4) are untested: `node judges/load.ts --collect` and `node judges/phone-report.ts load|paste` are ready.
- **Client settings** other than appearance (send shortcut, follow-up behaviour, timestamp format, confirm delete, composer collapse, diff layout) are stored but not read by the composer, sidebar, timeline or diff panel. A light-theme flash is possible on load because `index.html` starts dark.
- **Two `cairn-boot` script elements** on a served page (the injected one in the head and `index.html`'s `null` placeholder); the head one is found first.
- **4D:** no turn-0 baseline for a thread whose first `RunStarted` was missed; an ignored workspace folder is refused; no streaming cap on git output; no revert, restore or ref deletion on thread delete.
- **4E:** no live Executor status event; the skills prompt size is an estimate.
- **4C:** a later snapshot drops paged history; the tailnet first frame is modelled, not measured.
- **Parity:** structure 0 of 21, behaviour 3 fails, pixel hero and thread over budget, streaming state without a baseline; all wave 5's.

### Deviations from the plan

- **4J2** was an extra package outside the plan, assigned to close wave 3's J2 gap.
- **The entry JS budget** is 288 KiB enforced, 200 KB reported (decision above); D46's transcript and markdown splits were not made.
- **`judges/load.ts`'s slow control** holds `index.html` through Playwright routing instead of a `?slow=1500` flag.
- **DERP detection** reads `tailscale status --json`, not `tailscale ping`.
- **4C's window** diffs each revision's window against the previous one instead of rewriting op paths; equivalent and correct by construction.
- **4F's fixture route** was not built: the plan's `?fixture=` route served by `dev-main` (seeding the real Model through `update`) became a real in-process judge brain seeded through the protocol (`judges/fixtures/parity/CairnApp.ts`, `judges/capture.ts`), which exercises more of the real path.

### Review

A review of wave 4 reported six confirmed findings and six unverified concerns. All six findings were confirmed and fixed; of the concerns, two were real and fixed, one was not real, and three are recorded. `pnpm check` is green afterwards (127 files, 1,127 tests). `node judges/durability.ts` (8 of 8 windows) and `node judges/claude-kill.ts --case parked` (pass, first reply after restart read 42,079 and wrote 397) were rerun. Not deployed yet.

Confirmed findings:

1. **A changed-files card landed in the next turn when that turn started before the capture finished.** Confirmed. `CheckpointCapture.layer` now tracks each thread's newest user entry from `MessageCommitted` and reads it synchronously on `RunTerminal`, before the next turn's user entry can arrive (events come in commit order). `runEnded` takes it and the `cairn.checkpoint` data records it as optional `userEntryId`; `TimelineEntries` places the card in that entry's turn and falls back to the newest turn when it is absent (older entries, boot repair). New `TimelineEntries.test.ts` case (a checkpoint after the next prompt goes to the turn its run answered) and a `Checkpoints.test.ts` assertion that the id is written.
2. **Boot repair captured `turn/1` and wrote an entry for every pre-existing git thread.** Confirmed. `missedRunEnd` answers false when the thread has no checkpoints, so boot repairs only threads this feature already checkpointed; a thread that predates it takes turn 0 on its next run. The repair test now checks that a thread without checkpoints is swept but not captured, and that one with a baseline gets its missed end once.
3. **A boot sweep could delete a scratch index mid-capture.** Confirmed. When `seedFromRealIndex` answers false, `Checkpoints.capture` now removes only the scratch files (`removeScratchFiles`) and keeps the path in `active` until the capture's own `ensuring` cleanup, so `sweepScratch` never takes the index `read-tree HEAD` recreates. No new test: the race needs a skip-worktree index at boot.
4. **`resumeAppend` dropped the append when the instructions now render empty.** Confirmed. A session stamped with an append resumes with the current instructions or, when they render empty, `HELD_APPEND_PLACEHOLDER` (Claude Code never sends the text while it holds the session's recorded prompt), so the agent line stays the same. The `ClaudeResume.test.ts` case now expects the placeholder.
5. **Two lint suppressions had no reason.** Confirmed. `judges/capture.ts` carries `-- runs in the page` on both.
6. **The `?fixture=` route deviation was undocumented.** Confirmed; listed in the deviations above.

Unverified concerns:

- **`catchCause` in `CheckpointCapture.logged` swallowing interruption:** not real. Checked on Effect 4: a fiber interrupted from outside (scope close at shutdown) does not run the `catchCause` handler; only a self-interrupt inside the effect would, and the capture has none. No change.
- **Event ordering between `runStarted` and `runEnded`:** real in principle. The layer now forks each capture with `startImmediately: true`, so a run's `runStarted` takes the thread's lock before the next event is read and before its `runEnded` exists.
- **Diff panel scroll before render:** real. foldkit renders in `requestAnimationFrame` and forks commands at once, so the scroll on `LoadedDiff` queried before the patch was in the DOM. `ScrollToFile` now uses foldkit's `Dom.scrollIntoView`, which waits for `Render.afterCommit`, and ignores a missing element.
- **4C memory under a slow consumer:** recorded, not judged. The one-tick sliding queue is bounded by construction (wave 3's design), and `ThreadWindow.test.ts` proves convergence from one frame; no memory measurement was added.
- **The phone load verdict counting warm loads:** recorded. A report is sent once per full page load (in-app navigation never reports), but a reload and a cold load look the same; wizard stage 3's instructions carry the difference.
- **`StaleBuild` and `readBootData` relying on the injected `<head>` element preceding the placeholder:** recorded (already a wave 4 gap); holds today; no change.

## Wave 5

### Step 1 (5A, 5C)

Integrated on 2026-10-22 on `main` and deployed to `https://code.gneiss.run` (`fa467b0`, then this note's commit). The durability judge now runs the full matrix with a Chromium page beside the Node client, an approval parked across a kill, an upload cut mid-stream, a bridge approval window and J14's 20 minute held approval. The sidebar frame and the new-thread hero carry t3code's page header, sidebar inset, rail and sidebar control; the thread page now uses the same header.

#### Packages

| Package | Branch | Commit | Status |
| --- | --- | --- | --- |
| 5A Durability full matrix | `phase1/5-5A` | `b30d830` | done (J14 and the bridge `--runs 3` run were unmeasured in the package run; both pass below) |
| 5C Tokens, primitives, sidebar and hero parity | `phase1/5-5C` | `a4a9e0e` | partial (hero structure, three behaviour checks; gaps below) |

Both branches merged with `--no-ff` without conflicts; no dependency changed. Worktrees were removed and the `phase1/5-*` and workflow worktree branches deleted before `pnpm check`.

#### Hand-offs applied

- **`apps/web/src/View.ts`:** 5C's patch exactly: `data-sidebar-state` from `sidebarState` on the sidebar wrapper, and `<main>` as `data-slot="sidebar-inset"` with t3code's inset classes.
- **Thread page header (integrator or 5E):** the Thread route in `View.ts` is now a chat column (`data-chat-column`, `data-chat-column-maximized-away="false"`, `CHAT_COLUMN_CLASS`) whose first child is `ui/ChatHeader.ts`'s `chatHeader` with the project crumb (non-interactive, as on the hero) and the thread title. The thread page's own `h1` header was removed (`page/thread/View.ts` takes only `workspaceRoot` now; its status line keeps the old padding). The diff panel toggle was not added: the panel opens only from a changed-files card today and has no page-level toggle message, so `controls` is empty. That toggle is 5E's (diff is its folder).
- **`apps/web/src/composer/View.ts` (5D's):** the docked composer lane dropped `px-3 sm:px-5`, so `.chat-composer-lane`'s padding applies as on the hero. Taken now because it is one class string and 5D builds on it.
- **`Composer.test.ts`:** no change needed, as 5C said.

#### Integration judges

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | oxfmt clean, oxlint 0, typecheck clean, vitest 127 files and 1,127 tests (`Budget.test.ts` and `brand.test.ts` included). |
| `ops/cairn/deploy.sh` | pass | listening 1,297 ms, hello 1,322 ms, build `b21c3c6afc81`. |
| `node judges/live-chat.ts` | pass | hello 69 ms, launch 31 ms, reply 4,864 ms (opencode-go/claude-haiku-5-5); 29 models; opencode-go and claude-bridge ready, anthropic refused, openai-codex missing. |
| `judges/gate.sh` | pass | 0 failed. |
| `nightly.sh`: `node judges/durability.ts --runs 3` (faux, Chromium page) | pass | 30 of 30. Kill to up / up to converged in ms, ranges over 3 runs: streaming 1,235 to 1,387 / 6 to 8; mid-tool 1,131 to 1,383 / 5 to 6; between-tool-and-result 1,180 to 1,332 / 8 to 9; approval-parked 1,182 to 1,331 / 5 to 6; mid-commit 1,179 to 1,335 / 6; send-in-flight 1,182 to 1,335 / 9; mid-upload 1,180 to 1,230 / 8 to 9; during-launch 1,233 to 1,437 / 17; kill-six 1,131 to 1,388 / 5 to 6; sigterm-six 3,057 to 3,069 / 5 to 6. Page kill to Live 1,388 to 1,760 ms (sigterm 3,322 to 3,750). |
| `nightly.sh`: `node judges/durability.ts --bridge --runs 3` (quiet machine, load average under 1) | pass | 9 of 9; the streaming flake did not recur. bridge-streaming kill to up 1,755 to 2,044 ms, converged 9 to 39 ms; bridge-tool-parked 1,767 to 1,880 / 11 to 17; bridge-approval-parked 1,811 to 2,015 / 10 to 17, gate accepted once and `gated` once in each. Every run: claude children gone, no orphans, marker once, cache kept, page converged 3 to 6 ms. |
| `--sabotage skip-snapshot` (control) | pass | 0 of 10 windows passed, as required. |
| `--sabotage page-text` (page control) | pass | 0 of 10 windows passed, as required. |
| J14: `node judges/durability.ts --slow` (bridge-approval-slow) | pass | Gate held 1,200,015 ms (20 min) with 1 claude child alive, 0 watchdog fires, then accepted once; `gated` ran once and the answer continued after the gate; page converged 6 ms. |
| `nightly.sh` as a whole | pass | exit 0, 0 failed steps (log `/tmp/w5-nightly.jsonl`). |
| `node judges/capture.ts cairn`, `judges/parity.ts` | report complete | 29 states, 8 within budget (all 8 sidebar at 0 %); control 72.9 %; 1 missing (streaming). Hero, wave 4 then now: 1440-hero 1.665 to 0.831; 390-hero 4.6 to 1.38; 820-footer 2.641 to 0.68; 980-footer 2.175 to 0.602; 1180-footer 1.98 to 0.962; 1440-attachments 2.117 to 1.496; 390-attachments 6.23 to 4.018; 1440-project-popover 2.674 to 1.88; 390-project-popover 8.244 to 6.607; 1440-at-menu 1.396 to 1.811; 390-at-menu 3.765 to 4.733; 1440-slash-menu 5.85 to 6.603; 390-slash-menu 12.31 to 13.949. Thread 1440 4.66 to 6.49, 390 11.50 to 17.20 (5E's). |
| `node judges/parity-structure.ts` | report complete | 0 of 21 states pass; controls behave. Hero matched landmarks rose (1440-hero 45 match, 17 differ, 24 only in t3code, was 36 and 42; 390-hero 17 / 11 / 14; 820-footer 43 / 18 / 23; 980-footer 45 / 17 / 23). Thread 1440 31 match, 18 differ, about 90 only in t3code; 390 6 / 14 / 80. |
| `node judges/behaviour.ts` | 18 of 21 | Composer width now equals t3code's at every width (1440 736, 980 628, 820 516, 390 366). Fails, all 5D's: footer-820 (mode full, t3code icon-only), footer-390 (traits and mode icon-only, t3code moves them behind an overflow), drafts-reload (hero draft empty after reload). |
| `judges/parity-review.sh` (opencode-go/gpt-6-luna) | report complete | 7 batches. Sidebar "differs" only on declared gaps (starfield, footer pills, trimmed menu items) plus the red Delete item and the hovered row's clock icon. Hero and thread "differ": composer internals, popovers, panel toggles, transcript. |

**Parity report:** `~/Developer/agent-artifacts/cairn/v2/phase-1-parity/` (`report.json`, `index.html`, `structure.json`, `behaviour.json`, `review.md`), served at `https://plans.gneiss.run/cairn/v2/phase-1-parity/`. It replaces wave 4's report; step 2 starts from it.

#### Decisions

- 5A's and 5C's own decisions stand as reported (5A: faux windows on faux and bridge windows on the bridge; bridge windows inside `durability.ts`; the streaming aim needs 80 streamed characters and a live child; the stronger skip-snapshot sabotage and the new page control; a fixed loopback port behind `judges/fixtures/durability/Proxy.ts`. 5C: `ui/ChatHeader.ts` and `ui/ProjectMark.ts` as shared primitives; t3code's sidebar width clamp without drag-resize; one sidebar control for both widths; the hero's non-interactive project crumb and no panel toggles).
- **The thread header is drawn by the root view**, above the hold banner, because the root already knows the thread's project and title from the shell; the thread page lost its `title` input.
- **The thread header has no panel toggle yet** (no page-level diff toggle exists); 5E adds it with a message on its diff panel.
- **No systemd timer for `nightly.sh`**: an hour of mostly idle CPU with bridge usage every night is the user's call, so 5F's gate page lists the command instead of installing a timer.

#### Gaps

- Parity is not "same as t3code" yet: hero structure 0 of 13, thread 0 of 8, behaviour footer-820, footer-390 and drafts-reload (5D), thread rows (5E), hero popovers and slash menu pixels slightly worse than wave 4 (5D owns the popovers).
- Declared by 5C: the header's thread details, terminal and right panel toggles (Cairn has none), which offsets later `tooltip-trigger` keys; the hero test ids that mask t3code's keys (5D's tests use them); the sidebar footer's pull requests button and update pill; the sidebar control rendered before the page.
- Fixture data differs (t3code's project "supervillain" and model "Claude Fable 5.1" against Cairn's "cairn" and "scripted").
- The skip-snapshot control was not run on the bridge windows (only on the faux windows; the mechanism is the same blind reconnect).
- The vite build prints a CSS warning for a `highlight` pseudo-element in `apps/web` styles; harmless.

#### Deviations from the plan

- The composer lane class, a 5D path, was changed at integration from 5C's hand-off.
- The thread header hand-off was applied by the integrator without its diff toggle.
- J14 and the bridge `--runs 3` run were measured by the integrator through `nightly.sh`, not by 5A.

#### Review

A review of wave 5 step 1 reported five confirmed findings, all in `judges/durability.ts`, and six unverified concerns. All five findings were confirmed and fixed; of the concerns, two were real and fixed, and four are recorded. `pnpm check` is green afterwards (127 files, 1,127 tests). Rerun: `node judges/durability.ts` (10 of 10 windows with the Chromium page; page `convergedMs` now counted from quiet, 4 to 122 ms), `--sabotage page-text --window streaming` (fails as required, "did not equal a fresh page within 2000 ms of quiet"), and `--bridge` (3 of 3: first reply after the restart read 42,082 / 0, 42,103 / 344 and 42,045 / 233; children gone 57 ms). Not rerun: `--slow` (J14, a 20 minute hold); its change is only the verdict's ordering check.

Confirmed findings:

1. **The page's 2 s budget was not judged.** Confirmed. `judgeOutcome` now completes a `Deferred` with the instant the follower sees the turn end; `capturePage`, forked in the window's scope beside it, reads the live page every 100 ms from that instant until `CONVERGE_MS` have passed (scribbling before each read under `--sabotage page-text`). `judgePage` then opens and settles the oracle and passes only if one of those reads, finished within 2 s of quiet, equals it; `convergedMs` is the time from quiet to that read.
2. **"The approval to wait again after the restart" was a no-op wait.** Confirmed. `accept` now connects a new client, follows the thread with a fresh watcher (as `kill-six` does) and reads the pending approval from that client's own shell snapshot, so the approval is established on the brain that is up now before `thread.respond`.
3. **`cacheKept` could pick a pre-kill reply when the follower lagged.** Confirmed. `Plan.verdict` now also receives what `run` answered as committed before the kill, and the first reply after the restart is the first reply whose id is not among them. `repliesBefore` stays as a reported number.
4. **J14's `answerContinued` could not fail on its own.** Confirmed. The `stop` entry must now come after the gate's `pi.tool-result` (the entry carrying `accepted`, `declined` or `expired`, shared as `GATE_RESULTS` with `gateAccepted`).
5. **`connect` said 10 s but could retry for up to 800 s.** Confirmed. The loop is bounded by elapsed time (`CONNECT_DEADLINE_MS`, 10 s, read from `Clock`; one try can add its 4 s of timeouts) and the failure reports the ms actually waited.

Unverified concerns:

- `Upload.post` had no deadline: real. The request now has a 30 s socket-silence timeout that destroys it, which reads as a broken upload (status 0) instead of hanging the window.
- The page comparison would pass a client that reloaded on every reconnect: real gap in the judge. `Page.openThread` now records every full `load` after the first, and `judgePage` fails if the live page reloaded.
- Skip-snapshot control not run on the bridge windows: recorded, unchanged (cost only; the mechanism is the same blind reconnect the faux windows prove).
- `claude-kill.ts` and the bridge windows duplicate aims and checks: recorded. `claude-kill.ts` keeps J2's `answer` case and the restart and stop cgroup moves, which the bridge windows do not cover; folding it into `durability.ts` is left for a later wave; until then a change to one judge's bridge aims or J2/J9 checks must be mirrored in the other.
- The bridge brain runs with the real `HOME`: not re-checked here; wave 3's check that `~/.pi/agent` stays read-only under it stands.
- 5C's hero and thread structure rows (0 of 13, 0 of 8): recorded; 5D and 5E own them in step 2, as the gaps above say.

### Step 2 (5D, 5E)

Integrated on 2026-10-22 on `main` (`19629b8`, then this note's commit) and deployed to `https://code.gneiss.run`. The composer now carries t3code's landmarks (drawer menus above the card, attachments inside the body, the combobox project picker, footer folding that matches t3code's widths), and a hero draft survives a reload. Transcript rows use t3code's three-level frame, the changed-files card sits inside its answer, tight lists render without paragraphs, and the thread header has a diff panel toggle. Settings rows use t3code's grid and the settings pages are a parity group.

#### Packages

| Package | Branch | Commit | Status |
| --- | --- | --- | --- |
| 5D Composer parity and the WebKit tier | `phase1/5-5D` | `7934134` | partial (WebKit tier not run; hero structure still 0 of 13) |
| 5E Transcript, diff and settings parity | `phase1/5-5E` | `870cd8c` | partial (transcript and settings rows differ on data; gaps below) |

Both branches merged with `--no-ff` without conflicts; no dependency changed. Worktrees were removed and the `phase1/5-*` and workflow worktree branches deleted before `pnpm check`.

#### Hand-offs applied

- **5D, `ModelSource.layerFaux` and `judges/fixtures/parity/CairnApp.ts`:** the faux model takes an optional display name and the parity fixture names it "Claude Fable 5.1", t3code's baseline model. Applied from 5D's diff, except that the name is set on a `FauxModelDefinition` built first rather than through a conditional spread, which the `anti-slop` lint refuses.
- **5D, `ContextStripView.ts` (optional, 5C's folder):** not applied. The 390 context-strip width is one structure row and the hero is not reopened in this step.
- **5D, wizard stage 5:** left for 5F (the WebKit tier on the MacBook).
- **5E, the diff toggle in `View.ts`:** applied in a different shape. 5E's patch built `Thread.Message.GotDiffMessage(Diff.Message.ClickedToggle(...))` in the root view, which foldkit's `no-child-message-construction-in-root` lint refuses. The toggle is now the diff panel's own view (`diff/Toggle.ts` `toggleView`, a `Submodel.defineView` with the thread id and entries as view inputs), mounted by the thread page's `headerControls` view (`page/thread/View.ts`), which the root mounts in `chatHeader`'s `controls` through `h.submodel`. The markup and messages are 5E's.
- **5E, `page/thread/Update.ts`:** exactly as handed off: `GotDiffMessage` loads the lazy diff chunk when the panel is open after the child update.
- **5E, `judges/capture.ts`, `parity.ts`, `parity-structure.ts`, `parity-review.sh`:** the settings group is captured, compared and reviewed. The t3 capture loop is an `if` chain rather than the nested ternary handed off (lint).
- **5E, `ui/Select.ts` and `settings/View.ts`:** `size: "sm"` with t3code's compact trigger classes; the settings page uses it.
- **5E, `ui/Switch.ts`:** the classes already equalled t3code's. The cause was `@foldkit/ui`'s switch, which sets `data-checked` but never `data-unchecked`, so `data-unchecked:bg-input` never applied. The track now carries `data-unchecked` when off.
- **5E, `T3Import` and the t3 export (optional):** not applied. Importing notifications and checkpoint file lists is a conformance fixture change beyond this step.
- **5E, `scrollbar-gutter-both` (optional):** not added; the arbitrary class works.

#### Integration judges

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | oxfmt clean, oxlint 0, typecheck clean, vitest 127 files and 1,134 tests (`Budget.test.ts` and `brand.test.ts` included). |
| `ops/cairn/deploy.sh` | pass | listening 1,297 ms, hello 1,334 ms, build `afadef8f33d6`. |
| `judges/gate.sh` | pass | 0 failed. |
| `node judges/live-chat.ts` | pass | hello 56 ms, launch 39 ms, reply 1,451 ms (opencode-go/claude-haiku-5-5); 29 models; opencode-go and claude-bridge ready, anthropic refused, openai-codex missing. |
| `node judges/load.ts` (deployed, Chromium) | pass | lan p50 177 / p95 183 / max 220 ms, 4g p50 540 / p95 543 ms, 5 requests, 327,169 bytes, boot JSON 1,937 chars; control failed as designed (p50 1,687). |
| `node judges/paste.ts --skip-real` | pass | lan paste to chip p50 67 / p95 82 ms, send to submitted max 9 ms, sha 20/20; throttled p50 170 / p95 173, max 5, 20/20; paste and send at once max 56 ms; 51 MiB PDF refused. |
| `node judges/durability.ts` (faux, Chromium page, once) | pass after a judge fix | First run 9 of 10: `send-in-flight` failed "the reconnected client did not converge" (Node client, not the page), and a rerun failed 1 of 3. See fixes below. After the fix: `--window send-in-flight --runs 6` 6 of 6, and the full matrix 10 of 10. Kill to up 1,129 to 1,344 ms (sigterm-six 3,058 to 3,069), up to converged 4 to 14 ms, page kill to Live 1,396 to 1,763 ms (sigterm 3,429 to 3,652), page converged 4 to 132 ms. |
| WebKit tier: `node judges/typing.ts webkit --mobile`, `node judges/load.ts --browser webkit` | not run | Playwright WebKit cannot start on this host (missing system libraries, no sudo) and `mbp-14` was offline on the tailnet. Moves to wizard stage 5 (5F); ADR 0023 stays proposed. |
| `node judges/capture.ts cairn`, `judges/parity.ts` | report complete | 33 states (4 settings states new), 8 within budget (all 8 sidebar at 0 %); control 72.938 %; 1 missing (streaming). Hero, step 1 then now: 1440-hero 0.831 to 0.679; 1440-project-popover 1.88 to 1.854; 1440-slash-menu 6.603 to 5.711; 1440-at-menu 1.811 to 0.56; 1440-attachments 1.496 to 0.685; 390-hero 1.38 to 1.11; 390-project-popover 6.607 to 2.639; 390-slash-menu 13.949 to 11.98; 390-at-menu 4.733 to 1.055; 390-attachments 4.018 to 1.138; 1180-footer 0.962 to 0.776; 980-footer 0.602 to 0.378; 820-footer 0.68 to 0.452. Thread 1440 end 4.586, turn 6.529, fold-open 6.423, changed-files 5.56; 390 12.027, 16.143, 16.138, 14.464. Settings 1440-general 4.769, 1440-appearance 10.174, 390-general 10.125, 390-appearance 17.139. |
| `node judges/parity-structure.ts` | report complete | 0 of 25 states strict; controls behave. Hero 1440-hero 58 match / 14 differ / 14 only in t3code (step 1: 45 / 17 / 24); 390-hero 24 / 11 / 7; footers 56 to 58 / 14 to 15 / 13 to 14; slash menus 59 / 18 / 338 and 25 / 19 / 331 (t3code lists 194 Claude skills). Thread 1440 37 to 41 / 24 to 25 / 77 to 78 (step 1: 31 / 18 / about 90); 390 9 to 13 / 22 to 23 / 68 to 69 (step 1: 6 / 14 / 80). Settings 1440-general 16 / 48 / 160, 1440-appearance 14 / 33 / 66, 390-general 7 / 39 / 139, 390-appearance 5 / 24 / 45. |
| `node judges/behaviour.ts` | pass | 21 of 21 (step 1: 18). footer-820 and footer-390 now equal t3code; drafts-reload restores the hero draft; soft-keyboard on Chromium's iPhone emulation. |
| `judges/parity-review.sh` (opencode-go/gpt-6-luna) | report complete | 8 batches with settings. New thread: "same as t3code" at 390; "differs" at 1440 on the project popover's anchor and on the fixture project name. Composer "differs" only on the provider mark (robot against starburst) and the send button colour, both deliberately unbranded. Shell "differs" on t3code's three panel toggles (Cairn has one, the diff toggle). Thread "differs" on transcript content and scroll position (the importer's skipped rows), the changed-files card's "Open diff" label against t3code's icon, and a session-limit notice in Cairn's fixture. Settings "differs" on content (t3code's breadcrumb, colour-scheme previews and theme grid) and slightly lighter Cairn surfaces and brighter select chevrons. |

**Parity report:** `~/Developer/agent-artifacts/cairn/v2/phase-1-parity/` (`report.json`, `index.html`, `structure.json`, `behaviour.json`, `review.md`), served at `https://plans.gneiss.run/cairn/v2/phase-1-parity/`. It replaces step 1's report.

#### Decisions

- 5D's and 5E's own decisions stand as reported (5D: the hero rewrites `/` to `/new/<draftId>` so a reload restores the draft; footer folding fixed at the fixture model's name, not the folding logic; a neutral provider mark; composer test ids that masked t3code's keys removed; the `/`, `@`, `$` menu as t3code's drawer layer; attachments inside the composer body; the project picker as t3code's combobox slots. 5E: t3code's three-level row frame; the frame carries the timeline inset because the virtual list zeroes the scroller's padding; the changed-files card folded into its answer; tight lists; assistant meta as copy then time; the diff toggle opens the whole thread diff up to the newest checkpoint and is disabled until one exists; the settings states and row keys).
- **The diff toggle is the diff panel's own view.** foldkit's lint forbids the root building a child's messages, so the toggle is mounted through two `h.submodel` levels (root, thread page, diff) and the diff panel builds its own `ClickedToggle`.
- **The switch's unchecked state is set by Cairn's primitive**, because `@foldkit/ui` marks only the checked state.
- **The two optional hand-offs were left** (the context strip width in the hero, notifications and checkpoint files in the t3 import).

#### Fixes to package code (minimal, at integration)

- `diff/Toggle.ts` (5E) gained `toggleView` and `page/thread/View.ts` gained `headerControls`, for the lint above.
- `judges/durability.ts` (5A): `send-in-flight` now waits until the resent message reaches the follower before the judge waits for quiet. Without it the first turn's quiet row could be read as the resent turn's end, so the oracle snapshot was taken mid-turn and the follower moved past it (1 failure in 4 runs here; none in step 1's 3). Not a step 2 regression: the window's client is the Node client, which nothing in this step touches.

#### Gaps

- **WebKit tier not run** (host libraries, MacBook offline). ADR 0023 stays proposed until wizard stage 5 passes it.
- **Structure 0 of 25 strict, pixels above the 0 % budget outside the sidebar.** The composer's own landmarks match. What remains: 5C's declared tooltip-trigger offsets (Cairn has one header toggle, t3code three), fixture text (project, branch, 194 Claude skills against Cairn's 1 command, 5 projects against 1), the deliberately unbranded send button and provider mark, the project popover anchored over the composer rather than on the headline's button at 1440, transcript rows the importer skips (notification, system notice, subagent, checkpoint file lists, so no changed-files card at 1440's end and about 77 t3code-only landmarks), and settings that differ by content (t3code's navigation column, scope line, appearance previews and theme grid). The structure judge has no gap mechanism and the pixel masks live in the committed t3 baseline, so these are recorded here rather than declared in fixtures.
- **The reviewer saw a session-limit notice in Cairn's thread fixture** that t3code does not show; it comes from the imported runs and is fixture content, not checked further this step.
- The 390 context-strip width hand-off (5C's folder) and the T3Import extension are open for a later pass.

#### Deviations from the plan

- 5D's judge "the composer target on Chromium and WebKit" and "Accept ADR 0023" are not met: WebKit moves to wizard stage 5.
- The diff toggle hand-off was applied as a child view instead of the root patch handed off (lint).
- The integrator changed 5A's judge (`durability.ts`) to remove a race.

#### Review

A review of wave 5 step 2 reported five confirmed findings and five unverified concerns. All five findings were confirmed and fixed. Of the concerns, the dead stream was real and its cause is fixed, the header's O(entries) work and the card fold were changed, and two are recorded. `pnpm check` is green afterwards (127 files, 1,135 tests). Rerun: `node judges/typing.ts chromium --throttle 4 --busy 10` twice at 60 s (1,200 / 1,200 both, rows streamed 486 and 486, `stream: ok`, 0 stream failures, late keys 80 and 87, max late 97 and 100 ms, IME and menus ok), ten 20 s runs of the same after the tick fix (10 of 10 `stream: ok`, 165 to 171 rows; before it 5 of 31 runs at 15 to 20 s were dead), eight 20 s runs at `--busy 0` (all ok), `node judges/transcript-scroll.ts` (all checks ok), `node judges/capture.ts t3 --group settings`, then `capture.ts cairn`, `parity.ts`, `parity-structure.ts` (0 of 25 strict, controls behave) and `behaviour.ts` (21 of 21).

Confirmed findings:

1. **`judges/typing.ts` passed with no streaming transcript.** Confirmed. The result now has `stream` (`ok`, `dead`, or `skipped` under `--url`, whose brain streams what it streams) and the exit code requires it not to be `dead`. The floor is `seconds * 4` rows, half the judge's own stream. The stream fiber no longer swallows failures: each submit has a 5 s timeout, and failed or stuck submits are reported as `streamFailures` and `lastStreamFailure`.
2. **5E's settings header was invisible to both parity judges.** Confirmed. The t3 mask is now only the "Restore device defaults" button (general pages; the appearance pages have none), with the reason updated in `Settings.ts` and the header comment. The landmark reader counts a labelled `nav` as `nav=<label>`, so `nav=Settings breadcrumb` is compared on every settings state. The t3 settings baseline was recaptured (`states.json`, landmark files; PNGs unchanged). The breadcrumb now shows as a width difference (t3code's "Settings / General" against Cairn's one crumb), a fixture-content difference. The hero and thread baselines were not recaptured, so `nav=Thread breadcrumb` is listed as only in Cairn there until the next t3 capture of those groups.
3. **`MoveHeroToDraftUrl` dropped the query and hash.** Confirmed. The command reads `location.search` and `location.hash` and appends them to `/new/<draftId>`, so `?busy=` survives the move.
4. **The overflow trigger's shortcut hook.** Confirmed. It carries `composer.mode composer.effort` when the traits block is folded into it, `composer.mode` otherwise, as t3code's `CompactComposerControlsMenu.tsx` does.
5. **`Popovers.ts` port header.** Confirmed. It now names `DraftHeroHeadline.tsx` and `components/ui/combobox.tsx` for the project combobox, with what was kept and changed (the `-top-11` hand placement, the always-highlighted first row).

Unverified concerns:

- **The dead stream: real, a client render starvation, fixed at its cause.** The brain kept streaming (a reload after a dead run showed about 210 more rows) and the page processed every `ReceivedThreadItem` during the run, but the DOM never updated. Foldkit's renderer skips a frame while a message drain is deferred to the next task (`renderFramePlain`, "rendering before a deferred drain resumes would restore stale controlled input values"). Under `--busy 10` every update spends 10 ms, over the queue's 5 ms drain budget, so at about 80 updates a second a drain was nearly always deferred and no frame painted until typing stopped. One avoidable source was the sidebar's relative-time clock: `Stream.tick` emits at once and the subscription restarts every time a row starts or stops running, so a streaming thread produced about 6 `Ticked` updates a second. The clock now drops its first tick (`sidebar/Subscription.ts`); 0 ticks during a run afterwards, and 0 dead runs in 10. The remaining load is two updates per key (`ChangedDraft` and `ChangedSelection`, since 2E) and the stream itself; merging the key messages was not done, because foldkit's controlled-input handling rides on `OnInput`. Late keys rose with a live stream (80 and 87 of 1,200 at 60 s, max 100 ms); the judge does not gate on them.
- **The step 2 table lacked the Chromium typing run and `transcript-scroll.ts`:** both rerun here and recorded above.
- **`page/thread/View.ts` rebuilt `[...older, ...entries]` on every render:** changed. The toggle view takes `older` and `entries` separately and `diff/Toggle.ts` memoizes each list's newest checkpoint turn in a `WeakMap` (lists are immutable), so a render whose lists did not change reads two map entries.
- **Retargeting `Home` reuses the unlaunched hero draft:** checked against t3code, recorded unchanged. t3code's `useHandleNewThread` also reuses the project's stored draft when it is unpromoted and empty, and mints a new one only when that draft has content; Cairn keeps the draft with its text, which loses nothing. The sidebar's "New thread" still mints fresh.
- **The card folded only into an immediately preceding answer:** changed. t3code keys the card by its turn's assistant message (`turnDiffSummaryByAssistantMessageId`), so `timeline/Rows.ts` now attaches the card to the last assistant message of its turn, walking back past tool rows and stopping at the turn's user message; a turn with no assistant text keeps a standalone card. A test covers an answer followed by tool rows.

Decisions:

- The sidebar's relative times now first update one interval after a row starts or stops running instead of at once; the times are minute-grained, so nothing visible changes.

### Step 3 (5F)

Built on 2026-10-22 on `main` (`7a43c85`, then this note's commit) and deployed to `https://code.gneiss.run`. 5F ran alone, so it touched a few judges outside its block (deviations below). The gate page is at `https://plans.gneiss.run/cairn/v2/phase-1-gate/` (`~/Developer/agent-artifacts/cairn/v2/phase-1-gate/index.html`).

#### What landed

- **`ops/wizards/phase-1.sh`**, written with the `wizard` skill: plan section 4's eight stages (PWA install, notifications with `judges/push.ts --send`, three cold loads with `tailscale ping` and `judges/phone-report.ts load`, the phone paste with `judges/paste.ts --page`, the MacBook WebKit runs only if Claude has not recorded them, the Executor re-sign-in only if Settings does not read Connected, the parity look, the daily-driver day). Each stage appends its verdict to the gate page's `runs/wizard.txt` and judge output to `runs/<name>.jsonl`; `ops/wizards/phase-1.sh <n>` reruns from a stage. It captures no secret.
- **`judges/deployed-unit.ts` and `judges/lib/DeployedUnit.ts`**: the deployed-unit durability checks (review response 14). `judges/shutdown.sh --unit cairn.service` runs `restarts`, `judges/durability.ts --unit cairn.service --window streaming` runs `streaming`. Both talk to port 3774 with Caddy's headers as `deploy-check.ts` does and delete their thread afterwards.
- **`judges/load.ts --browser webkit`** (5D's command did not exist): WebKit has no CDP, so only the `lan` profile runs and the line names skipped profiles.
- **`ops/cairn/cairn-nightly.{service,timer}`**, linked and enabled by `ops/cairn/install.sh` (step 4): `judges/fixtures/durability/nightly.sh` from the live worktree at 03:30 (10 min random delay, not persistent). Installed and started once by hand to prove the unit.
- **ADR 0022 accepted** with the deployed unit's numbers.

#### Judges

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | oxfmt clean, oxlint 0, typecheck clean, vitest 127 files and 1,135 tests. |
| `ops/cairn/deploy.sh` | pass | listening 1,044 ms, hello 1,092 ms, build `084a9ce6326c`, invocation `4301366d…`. |
| `judges/shutdown.sh --unit cairn.service` | pass | six restarts during `bash sleep 20` on `opencode-go/claude-haiku-5-5`: `closed` 2,009 / 2,006 / 2,008 / 2,007 / 2,006 / 2,004 ms, no `shutdown_slow`, `systemctl restart` 2,074 to 2,083 ms, first snapshot 7 to 13 ms after each socket, `NRestarts` 0 and 0, nothing parked, 6 `bash` calls, no follow-up needed, equal to a fresh client 61 ms after quiet. The first attempt timed out before restart 6 (the model ended its turn after an interrupted `bash`); the judge now sends one follow-up message when the turn ends early. |
| `judges/durability.ts --unit cairn.service --window streaming` | pass | `kill -9` 90 characters into a `claude-bridge/claude-haiku-5-5` reply: 2 committed entries kept, 1 `claude` child before and 0 outside the cgroup after 2 s, up 1,813 ms after the kill, first snapshot 8 ms after the socket, equal to a fresh client 60 ms after quiet, unit active, `NRestarts` 0 to 1. |
| `judges/gate.sh` | pass | 43 cases, 0 failed. |
| `judges/load.ts` (deployed, Chromium) | pass | lan p50 177 / p95 254 / max 258 ms, 4g p50 541 / p95 545 ms, 5 requests, 327,377 bytes, boot JSON 1,937 chars; control p50 1,687 (failed as designed). |
| `judges/tools.ts` | pass on rerun | First run 3 of 4: the model wrote the convex path as `"tools[\"cairn-bridges\"].convex.status"` and the judge's path pattern stopped at the escaped quote. Fixed (escaped quotes and backslashes in `CALL_PATH` and `segmentsOf`); rerun 4 of 4: convex 14,088 ms, playwright 8,553, github 8,047, open 12,572 (search before call). Executor connected. |
| `judges/relay-orphans.sh cairn-bridges http://172.17.0.1:3776/healthz ops/relay/warm.sh executor` | pass | 5 cases, 0 orphans; healthy after kill9-main 2,715 ms, kill9-child 1,015, restart-unit 1,053, stop-start-unit 1,055, restart-peer 3,593. |
| `judges/live-chat.ts` | pass | hello 25 ms, launch 37 ms, reply 1,248 ms; 29 models; opencode-go and claude-bridge ready, anthropic refused, openai-codex missing. |
| `judges/phone-report.ts load` and `paste` | incomplete | 0 phone runs in the journal (exit 2); wizard stages 3 and 4. |
| WebKit tier on `mbp-14` | not run | SSH answered once at the start of the step and once more about 40 minutes later (seen by a poll), and timed out at every attempt to use it (the MacBook sleeps; Tailscale shows it offline). Stays wizard stage 5; ADR 0023 stays proposed. |
| `cairn-nightly.service` (started once by hand) | pass | `Result=success`, exit 0: faux matrix 30 of 30, bridge 9 of 9, skip-snapshot 0 of 10 and page-text 0 of 10 (both controls fail every window, as required), J14 gate held 1,200,011 ms with 2 claude children and 0 watchdog fires, then accepted once and `gated` once. Log `~/cairn-judges/durability-2026-10-22.jsonl`. |
| Gate page renders | pass | `https://plans.gneiss.run/cairn/v2/phase-1-gate/` 200, all 66 parity images load. |

#### Parity classification

The gate page classifies every structure difference in the step 2 report (unchanged since: no client code moved in this step) by rule over `structure.json`, per state: seven declared reasons (header toggle offsets; fixture text, counted as differences in width or height only plus the extra fixture rows; Cairn-only hooks; importer-skipped transcript rows; different settings; the virtual-list scroller; the unbranded mark and send colour) and ten open items for the user's look: the thread page's composer banner drawer, its filled surface and compact 390 resting layout, the minimap, the workspace drop target, thread-page icon buttons and the "Open diff" label, the selected row highlight on the thread page, composer labels at 390, the sidebar draft row, the project popover's anchor at 1440, and settings select line-height. No state has an unclassified landmark.

#### Decisions

- **The deployed-unit checks live in a new judge**, not inside `durability.ts`'s window table and `shutdown.sh`'s body: those drive transient judge brains with judge tools, and production has neither the tools nor the faux model. The plan's command lines work as written through thin `--unit` dispatches.
- **Models for the deployed checks:** restarts on `opencode-go/claude-haiku-5-5` (cheap, no Claude child to confuse the stop timing); streaming on `claude-bridge/claude-haiku-5-5`, so "no `claude` child outside the cgroup" is judged on a real child.
- **The `bash sleep 20` prompt asks the model to rerun an interrupted call**, because `bash` is `unsafe` and comes back `interrupted` after a restart; one follow-up message covers a model that stops instead.
- **`relay-orphans.sh` against the deployed relay unit** (`cairn-bridges` with Executor as the peer), as every earlier wave ran it; the brain's own `claude` children are judged by the streaming check.
- **The nightly timer is installed** (reversing step 1's decision, as the step's brief asked), at 03:30 with no catch-up, from the live worktree so it judges the deployed commit.
- **Parity differences are classified on the gate page, not in fixtures**, because the structure judge has no gap mechanism (step 2's gap); the rules are in the page's numbers and in this note.
- **Wizard verdicts go to `phase-1-gate/runs/`** rather than an env file, so the next agent can read them and update the page.

#### Gaps

- The phone halves (wizard stages 2 to 4), WebKit (stage 5), the parity look (stage 7) and the daily-driver day (stage 8) are the user's. ADR 0021 waits on stages 3 and 4, ADR 0023 on stage 5.
- Phase 0 wizard stage 11 (revoking Claude's Executor setup token) is left to the user, as they asked.
- The ten parity open items are not fixed; they are the user's call in stage 7.

#### Deviations from the plan

- 5F's block owns `ops/**` and the gate page; it also changed `judges/shutdown.sh`, `judges/durability.ts` (a `--unit` dispatch each), `judges/load.ts` (`--browser webkit`), `judges/tools.ts` (path parsing) and added `judges/deployed-unit.ts` and `judges/lib/DeployedUnit.ts`. Step 5.3 ran alone, so nothing else owned them.
- The deployed-unit restarts use `bash sleep 20`, not `slow` and `mark` (review response 14 said so already).

### Integration (step 3)

Integrated on 2026-10-22 on `main` at `c8e9efb`. 5F worked on `main`, so there were no package branches to merge and no hand-offs to apply. The live worktree runs `7a43c85`; the only change since is this file.

#### Packages

- 5F (partial): the phase 1 wizard, the deployed-unit judges, the nightly timer, ADR 0022 accepted and the gate page. Its own judges are in the step 3 note above.

#### Judges rerun at integration

| Judge | Result | Numbers |
| --- | --- | --- |
| `pnpm check` | pass | vitest 127 files, 1,135 tests, 52.5 s; format, lint and typecheck clean. |
| Deployed unit | pass | `cairn.service` and `cairn-bridges.service` active, `cairn.service` up since 19:39:36 with `NRestarts` 0, live worktree at `7a43c85`; `https://code.gneiss.run/` 200. |
| `cairn-nightly.timer` | pass | enabled, next run Fri 2026-10-23 03:32:16 PDT. |
| `judges/gate.sh` | pass | 43 cases, 0 failed. |
| `judges/live-chat.ts` | pass | hello 24 ms, launch 6 ms, reply 1,623 ms on `opencode-go/claude-haiku-5-5`; 29 models, 0 `anthropic`. |
| Gate page | pass | `https://plans.gneiss.run/cairn/v2/phase-1-gate/` 200; 66 of 66 parity images 200. |

The parity report, the deployed-unit durability runs, `tools.ts`, `load.ts` and `relay-orphans.sh` were not rerun: nothing deployed has changed since 5F measured them.

#### Decisions

- None beyond 5F's. The step 3 note stands as the record.

#### Gaps

- Carried from 5F: wizard stages 2 to 5, 7 and 8 are the user's (ADR 0021 waits on stages 3 and 4, ADR 0023 on stage 5); the ten parity open items wait on stage 7; Phase 0 wizard stage 11 is the user's.
- The pre-commit hook still fails when only ignored markdown is staged; this commit also used `LEFTHOOK=0`.

#### Deviations from the plan

- None at integration.

#### Review (step 3)

A review of wave 5 step 3 (`e400da8..18dc9ef`) reported five confirmed findings and five unverified concerns. All five findings were confirmed and fixed; two concerns were real and fixed, three are recorded. `pnpm check` is green afterwards (127 files, 1,135 tests). Rerun: `node judges/deployed-unit.ts restarts` twice against `cairn.service` (the first, with the new checks, failed exactly as the review predicted, see 2; the second passed), `node judges/deployed-unit.ts streaming` (pass), `node judges/paste.ts --page --wait 4` (the journal window opens and the judge exits 2, incomplete, as it should with no phone), `ops/cairn/install.sh --check`, and the new `node judges/parity-classify.ts` (every landmark classified). The deployed-unit JSON lines are now in the gate page's `runs/`. Nothing was deployed: the live worktree still runs `7a43c85`, and every change here is to judges, ops scripts run from the main checkout, docs, or the nightly unit's `After=` line, which the user manager ignored and the next deploy ships.

Confirmed findings:

1. **Wizard stage 4 could never pass.** Confirmed: `journalctl --since` with a bare UTC timestamp read it as PDT, 7 h ahead (28 lines back for a 30 minute window with ` UTC` appended, 0 without). `judges/paste.ts` now appends ` UTC` to the ISO timestamp. The wizard's stage 4 now treats exit 2 as "no paste reached the model yet" and offers to run the judge again, as stage 3 does; only a real fail (over 2,000 ms, or the nonce missing) is recorded as `paste=fail`.
2. **`DeployedUnit.restarts` did not prove six interrupted calls.** Confirmed, and the rerun showed it: with the new checks the first run had six `interrupted` results and no finished run, because the model stopped after the last restart (the earlier "6 bash calls" pass had the same shape). Each restart now remembers the id of the pending `bash` call it interrupted and waits for a different one, and fails if the call it means to interrupt finished within 500 ms. After the last restart, if no run finished, one more follow-up message asks for it (and waits for the shell row to show the run, so the quiet it then waits for is that run's). The result now requires `everyRestartInterruptedBash` (six `interrupted` `bash` results) and `bashCompleted` (at least one run that is neither interrupted nor an error). The second run passed: 7 calls, 6 interrupted, 1 finished, 3 follow-ups, `closed` 2,004 to 2,010 ms. ADR 0022 now has these numbers and a sentence on the `closed` floor: `gracefulShutdownTimeout: "2 seconds"` with the judge's socket open, so the numbers bound the close under 5 s and say nothing finer.
3. **`ops/cairn/install.sh` computed a fallback and linked something else.** Confirmed. Installing now refuses (exit 1, "deploy a commit that carries it") when the live worktree lacks the nightly units, so a link can no longer dangle; `--check` verifies this checkout's copies in that case and says so. Links and `systemd-analyze --user verify` now use the same files.
4. **`DeployedUnit.streaming` passed with no `claude` child.** Confirmed. `claudeChildSeen` (`claudeBefore >= 1`) is now a check; the rerun saw 1.
5. **Style in `judges/lib/DeployedUnit.ts`.** Confirmed. `NO_TOOL_ERRORS` is `lastErrorNotes`; `Options.keep` is a required boolean; the inner `Effect.gen` in `restarts` is gone; every helper is `Effect.fnUntraced` except `until`, which stays an arrow over `Effect.gen` because it is generic in its check's error and requirements and `fnUntraced` widened them to `unknown` (typecheck caught it in `deployed-unit.ts`). `durability.ts` has the same arrow shape and was left as it is (consistency, not a gate item).

Unverified concerns:

- **The parity classification was not reproducible:** real, fixed. `judges/parity-classify.ts` holds the rules (D1 to D6 declared, R1 to R10 open; D7 is not a landmark) and prints per-reason and per-state counts from `structure.json`, failing on any landmark no rule takes. The gate page's three parity tables were regenerated from its output. The per-state open items are the same as before; some counts moved because the rules are now explicit: settings states go wholly to D5 (only 1440 select triggers with a line-height difference are R10), so D1 is 583 landmarks in 21 states, not 707 in 25; R7 is 5 per 390 hero state and 3 at 820; R9 is 4 per popover state; D4 also takes thread rows whose from-the-end keys meet a different kind of row. Every state still sums: declared plus open equals differ plus only t3 plus only Cairn.
- **The deployed-unit runs were not saved:** real, fixed. `runs/deployed-restarts.jsonl` and `runs/deployed-streaming.jsonl` beside the gate page hold the reruns.
- **`After=network-online.target` in `cairn-nightly.service`:** removed; the user manager has no such target. Left in `cairn.service`, which is not this step's and is harmless.
- **Stage 2 reading `cairn.sqlite` during a checkpoint:** checked, not real. `TestPush.ts` opens the database through SQLite read only, which reads committed WAL frames whether or not they are checkpointed, and the judge polls for up to `--wait` seconds.
- **An aborted `restarts` run leaves its thread:** recorded. The thread is titled "Deployed unit judge" in the scratch project. A scoped finalizer cannot delete it reliably, because the client it would use is closed first after each restart's reconnect.

Decisions:

- The restarts judge asks for one more run after the last restart when the model stopped, rather than counting a stopped turn as a pass; the gate is "six restarts land during `bash sleep 20` and the work finishes".

## Fix batches after the full review

The user's first day on Cairn turned up hangs, a missing-thread page and doubled attachment chips. A full review (`docs/phase-1/notes/full-review.md`, 172 findings, 63 tasks, the user's decisions of 2026-10-24) orders the fixes into batches. Each batch lands on `main` with its judges; nothing here is deployed until the batch that says so.

### Batch 1: the parallel tool call hang (T1, T2, T3, T12, T4)

| Commit | Tasks |
| --- | --- |
| `8922c21` | T1, T2: the bridge ends a streamed tool-use turn on `message_stop`, never on the first served call; fallback messages gather their per-block events; orphaned calls, unattached results and cancelled calls are handled; the watchdog no longer skips a parked call; exact served names |
| `5224ac0` | T12: no inherited `CLAUDECODE`/`CLAUDE_CODE_*`; one-shot usage from the `result`; a fork waits up to 2 s for its stamped entry and logs a failure; `isUsingOverage` ends the turn with `PAID_CREDITS_TEXT` (non-retryable) |
| `ed57f82` | T3: claude-live `parallel` case; a deadline on every bridge judge; claude-live cleans up on the timeout path and again after a killed child exits; claude-kill cleans up after the unit stops; load.ts SIGKILLs a brain that ignores SIGTERM |
| `5181c8e` | T4: `shell.dispatch` stops the runs a ThreadDelete, ThreadArchive or ProjectDelete removes, before committing |

#### Judges

| Judge | Result | Numbers |
| --- | --- | --- |
| New bridge tests (three parallel-call shapes: call between blocks, second block still streaming, non-streaming fallback) | fail on `21577e0`, pass after | on `21577e0`: one call delivered, or the second with `{}` arguments |
| New safety-net tests (orphan, unattached result, cancelled call), `ClaudeStream.test.ts` (5), T12 tests (env, result usage, paid credits for turns and one-shots, the late stamped entry) | pass | the late-entry test fails without the wait |
| `rpc/ShellHandlers.test.ts` (T4) | pass | three of its four cases fail on `ed57f82` |
| `node judges/claude-live.ts --case parallel` (Haiku) | fail before, pass after | `21577e0`'s bridge: `timedOut` at the 120 s deadline, child killed. `5224ac0`: pass in about 3 s; Claude Code's transcript shows both `tool_use` blocks in one API message; pi got both calls in one reply; cache read 5,791 against 235 written |
| `node judges/durability.ts --bridge` (J2) | pass, 3 of 3 | bridge-streaming, bridge-tool-parked, bridge-approval-parked; first reply after the restart read 42,043 against 234 written |
| `node judges/durability.ts` (J9 and the rest) | pass, 10 of 10 | |
| `pnpm check` | green | 129 files, 1,154 tests |

#### Gaps

- T4's live half (a claude-live case that deletes a thread mid tool call, then no `claude` child survives) is not built; the unit test covers the dispatch.
- The fallback path (no stream events) still loses a block Claude Code emits after the first call it dispatches; that call is treated as an orphan (the child is killed and the next turn resumes from the stamp). The per-block shape of the fallback is inferred, not observed.
- About 107 transcript folders from earlier judge runs (`-tmp-cairn-*`, 27 of them spike 8's) remain in `~/.claude/projects`; the user is asked before they are removed. T56 covers the other judges' cleanup.
- The plan's seven-day window read 92% during these runs.

### Batch 2: the launch race, the attachment chips and the single submit (T5, T27, T35)

Built in a worktree on `21577e0` by a delegated agent (branch `fix/batch2-launch-attachments`, merged as `b51c773`).

| Commit | Tasks |
| --- | --- |
| `adbca17` | T5: the seam gains `whenEnsured` (both harnesses, scenario `subscribe_before_ensure`); `thread.subscribe` waits while a launch row exists, bounded by `LaunchWait`; the thread page treats NotFound as "not yet" while the outbox holds the launch or the row is `preparing`, and retries a failed stream after 250 ms, 1 s, 5 s |
| `e851dac` | T27: attachment path lines move to `@cairn/protocol` (`attachmentPathLine`, `parseAttachmentPathLine`, `isAddedUserPart`) and are dropped from the bubble, prompt recall, the queue card and the sidebar preview; an image shows only as its attachment chip, matched by attachment id |
| `cf3cdfb` | T35: `TurnContent.check` replaces the launch's validation build (no file reads, no claims); `turn.submitted` is logged once, after `seam.submit`, with the submission id |
| `5c2430e` | `judges/behaviour.ts --only hero-launch`: 20 hero sends with each `thread.launch` frame held 500 ms on the socket |

#### Judges

| Judge | Result | Numbers |
| --- | --- | --- |
| Conformance `subscribe_before_ensure` | pass on both harnesses | fails on both with the wait stubbed out |
| Subscribe handler (3), thread page (6), reader, row view, queue, prompt recall, launch and attachment-check tests | pass | each failed before its fix (old code or the fix stubbed out) |
| `node judges/behaviour.ts --only hero-launch` | pass | branch and merged `main`: 20/20 landed, Missing seen 0 times. `21577e0`: 0/20, Missing seen 4 times. Without the 500 ms hold the old code also passed (the in-process brain answers too fast), which is why the hold is in the judge |
| Real pi-durable dev brain, 5 worktree launches with an immediate subscribe | pass | a Snapshot after 67 to 88 ms each time; one `turn.submitted` per request over 6 launches (the live journal shows two) |
| `judges/live-chat.ts`, `judges/reconnect.ts` (dev brain) | pass | reply in 1,417 ms; 5 rounds, worst first frame 1,022 ms against 2,000 |
| `pnpm check` on merged `main` | green | 131 files, 1,178 tests |

#### Decisions and deviations

- The image dedupe matches by attachment id, not by position: `ThreadWire.ts` already points a `cairn.user` image at its attachment, so the review's verifiers were wrong that a projected image carries only `{entryId, index}`.
- The attachment claim stays in the build, after the thread exists; only `turn.submitted` moved after the submit. Claiming after the submit would let a crash in between leave a submitted turn's files unclaimed, so the day-old sweep could delete them.

#### Gaps

- Not done: a sweep rule for claims with no thread row (the live store has 0, and the check no longer creates them); the `judges/paste.ts` real-bridge assertion on the user row; a per-request `turn.submitted` count in the journal judge; a worktree-mode hero launch through the browser (covered by handler tests and the real-brain script).
- Skill blocks still show in the queue card and sidebar preview (T31 records the typed text on the entry).
- For T8: `PageContext.launching` is where a failed row's activity and `lastError` should come in; Missing is still the state a launch that fails in the background reaches.
