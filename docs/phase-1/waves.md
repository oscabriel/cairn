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
  - Tests for the Brain supervisor's reopen and for `JudgeTools` (1C).
  - The live-child cap and idle TTL tests (1F).
  - J2 and J4's compaction and provider-switch cases (3F).
  - The real Tailscale layer has no automated test (gate.sh covers it at the first deploy).
- **The old spike relay directory** `spikes/5-stdio-bridges/` is no longer used by the unit. It is left in place as a spike record.

### Deviations from the plan

- **The dev demo thread** is not in the plan. It is how the plan's dev smoke ("shows a scripted thread streaming") can be met before thread launch exists. The scripted echo model answers whole messages, so "streaming" is judged as the transcript growing live on the thread stream, not as token deltas.
- **pi-durable over the faux model in `main.ts` and `judge-main.ts`**, until 2A, rather than leaving production without a harness.
