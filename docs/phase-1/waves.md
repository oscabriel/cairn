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
- **`judges/typing.ts` reported fewer menus seen under throttle** (none on desktop, path only on mobile) while still reporting the menu case ok and losing no keys. The menus open later than the judge samples under 4x throttle; the unthrottled run saw all three.
- **No regenerated titles, no project setup script, no worktree cleanup on archive or delete** (2B's gaps), the protocol's `ProviderUsage` has no plan or reason (2F), and the hover card, drag reorder and custom snooze are not built (2D). All carried.
- **J7 used a stand-in system prompt** (2F); rerun `judges/claude-eligibility.ts` once 3E's sections exist.
- **The WebKit tier of the typing judge** is wave 5.

### Deviations from the plan

- **`thread_launches` is written before `thread.created`, not in one transaction with it** (2B): `EventSink` publishes inside its own transaction, so an outer one could hand clients events a rollback removes. Boot repairs a launch row with no thread row.
- **The pixel comparison lives in `judges/capture.ts cairn`**, not `judges/parity.ts`, which is 4F's (2D).
- **The migration file is `db/migrations/0002Launches.ts`** (key `0002_Launches`), following `Migrations.ts`'s convention rather than the plan's `0002_Launches.ts`.
- **The typing judge runs an in-process brain** (AppLayer, scripted harness, echo model) with Vite, rather than `dev-main.ts` itself (2E); `--url` points it at a running page instead.
- **One extra integration judge**, `judges/live-chat.ts`, and one deployed-page browser check, beyond the plan's list.
