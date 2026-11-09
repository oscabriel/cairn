# Cairn phase 3 build plan

Decisions 1 to 5 in section 3 answered by the user on 2026-11-04, all yes, with M0 starting at one or two snapshots; decisions 6 to 9 stand as recommended unless the user objects. Written from the four area notes in `docs/phase-3/notes/` (`arms.md`, `bases.md`, `results.md`, `surfaces.md`), the kickoff's phase 3 section and Targets (`~/Developer/agent-artifacts/cairn/v2/KICKOFF.md`), ADRs 0001 to 0043 and `GLOSSARY.md`, at commit `a160935`. Pins are phase 2's: pi (`@earendil-works/*`) 1.4.0, Effect 4.0.5, Node 26.11, alchemy `2.0.0-beta.83`.

The notes are the evidence, and this plan is the decision. Where they disagree, section 2 rules and the plan wins. An implementing agent given one package should read sections 1 and 2, its package row, the note the row cites, the ADRs it names and the installed source of every library it touches. Package ids are the notes' own: `A` is `arms.md`, `B` is `bases.md`, `RES` is `results.md` and `U` is `surfaces.md`.

Nothing here has run on Cloudflare since spike 1. Every dollar figure is arithmetic on list prices read on 2026-11-04, not a measurement.

## Summary

Phase 3 gives a thread arms on Cloudflare. A stone is a pi-durable conversation in the brain, on the Beelink, whose tools run in a container with its own branch, started from a prepared base. Its work comes home as a validated git bundle, an explicit node integrates many stones into one branch, and the user ships the result as a push or a PR.

Its gate (kickoff) is four targets, plus the user having used it:

- **Fan-out.** Ten stones on one project, each on its own branch and each verified by an outside judge, integrated into one branch with zero cross-contamination, with cost shown before launch and after.
- **Stone start.** A prepared base to the first tool call in under 5 s.
- **Idle cost.** Under $6 a month with no stones running.
- **Tools.** Every MCP server answers a tool call through Executor from a stone. Playwright's server is gone (ADR 0044), so that leaves `convex` and whichever others remain.

The notes propose 49 packages. That is exactly the breadth-first shape that sank v1, so this plan cuts them into vertical milestones, each one a thing the user can use before the next starts:

| Milestone | The user can | Ends with |
| --- | --- | --- |
| **M0 Measured** | Nothing yet: the unknowns get numbers | Spike notes, and the user's call if a gate fails |
| **M1 One stone** | Start a stone from the phone, talk to it, and see its work come home | Stone start and Tools targets pass; look round 12; the user works in one |
| **M2 A stone's life** | Leave it asleep, wake it with a message, and ship a PR from it | Idle cost target passes; the user ships one real change |
| **M3 Fan-out** | Launch ten stones and get one integrated branch | Fan-out target passes |
| **M4 The gate** | See a stone's dev server on the phone | Look round 13, the phone run, the phase 3 gate |

## 1. Architecture

### What phase 3 adds

| Area | Shape | Note |
| --- | --- | --- |
| A stone as a thread | A `cairn.arms` document names a thread's arms (absent means host); a `stones` table holds lifecycle; `ThreadShell.stone` and lineage `stone` carry it to the UI. `Arms.placeOf` becomes the only reader of a thread's place. About 20 sites treat a thread's folder as a local path, and three fail silently (`git/Diffs.ts:186-192`, `brain/CodingTools.ts:248`, project skills and `AGENTS.md`). A `FakeStone` and a lint rule fence them. | `arms.md` 1, 2 |
| The link | One relay process and one socket per awake stone, with no multiplexer and no Hub object. Newest pipe wins; boot reconcile over HTTPS. `apps/stones`, `packages/link`, `ops/stones`, all in the root stack. | `arms.md` 4 |
| Claude on a stone | The `claude` child runs at home in a stable empty folder per stone, so stamps and native resume do not change (amends ADR 0017). Tools still run in the container through pi's MCP path. | `arms.md` 3 |
| Bases | A base is a container snapshot, recorded in `cairn.sqlite`, reused by lockfile hash, setup hash and image digest. The base commit decides what a stone fetches, not whether the base is reused. The brain builds on a miss, with single flight by unique index. There is no `Quarry` object. | `bases.md` 1, 2, 5 |
| Code in | A git bundle over the link. No git credential exists on Cloudflare in any form. | `bases.md` 3 |
| Work home | Section 2, ruling 2. | `results.md` 1, 2 |
| Integration | A new `integrate` prelude verb. A pure pick with `merge-tree`, `commit-tree` under a frozen date and a compare-and-swap ref, with no worktree, so a replay computes the same sha instead of recovering. One resolver attempt, then a conflict card. | `results.md` 3, 4 |
| Check runs | A project's checks against a stone's commits run in throwaway arms on Cloudflare, read their config from the base rather than the stone's tree, and never run on the Beelink. | `results.md` 3 |
| Ship | An approved push from the result repo with hooks off, never forced. Trunk or PR per project. | `results.md` 5 |
| Workflow verb | `stone(prompt, opts)` in prelude version 4, over the one `agent` node path with `arms: "stone"`. Arms enters the plan keys, the envelope check and the row. | `surfaces.md` 1 |
| A single stone | A managed thread under the project thread: `isolation: "stone"` on `subagent_spawn` for a model, and a New stone button in the managed list for the user, whose Send is the Go. | `surfaces.md` 2 |
| Lifecycle | The brain sleeps a stone at the later of 5 minutes agent idle and 20 minutes human idle, where only interaction counts as human. The object holds a 60 s alarm and a 30 minute watchdog as the last resort. Long work is a durable job. | `arms.md` 5 |
| Portals | One fixed Caddy handle with its own owner guard, outside porch, to a Worker preview route that strips secrets and allows only opened ports. | `surfaces.md` 4 |
| Spend | Compute is Cairn's own awake intervals times the list rate, labelled as a ceiling, and counts in a workflow's dollar limit. | `surfaces.md` 5 |

### Durability rules every package keeps

Phase 2's hold (`docs/phase-2/plan.md`, section 1). Phase 3 adds:

- **A stone is untrusted.** Nothing from a stone's tree runs at home: no hook, no config, no check. A bundle passes the validator before any ref lands. Stone refs never enter the project's own repo.
- **The brain never trusts its own socket.** A kill between any two steps of start, cut, fetch, sleep or wake reconciles from the object's storage and the row at boot.
- **A foreground command that dies with an eviction is reported lost, never rerun** (spike 1). Long work runs as a job.

## 2. Integrator rulings

The notes were written in parallel. These are the places they disagreed or each left the question to the other.

1. **Sleep keeps no disk.** `arms.md` asked `bases.md` to choose a capture mechanism and `bases.md` said arms decides, so nobody had. Ruling: a sleeping stone has no snapshot. Sleep is cut, then destroy; wake is the base, plus the last cut, plus `.agents/resume`. Snapshots cannot be deleted and have no published price, so one per sleep across ten stones is an unbounded bill for the sake of a convenience. This path is also the one a lost container and a writer child already need, so it gets exercised daily rather than only in a disaster. The cost is real: ignored files changed since the base are gone on wake (a dev database, build output, a generated `.env`), a lockfile changed since the base makes the wake run the install, and Amp's "files and services intact" does not hold. This is user decision 3.
2. **One cut, one path, one repo.** `arms.md` carried checkpoints over the link into the project's `refs/cairn/checkpoints`; `results.md` sent results through R2 to a separate bare repo. Ruling: at each run's end when the tip moved or the tree is dirty, the `Workspace` object cuts one bundle holding the branch and its checkpoint refs. It goes through R2, the brain validates it, and it lands in the per-project result repo. `Diffs` reads a stone's checkpoints from there. Only a cut made by the object survives a long brain outage (`results.md` 1), and a stone's refs in the project's repo would break the rule above. Spike 12 measures it: the card appearing late is acceptable, a second path is not.
3. **The image carries what the notes asked for together:** `rg`, `fd`, `sqlite3`, git 2.54 or later, Node 24 and 26, Bun, corepack and build tools, with Chromium unless spike 11 shows a cold start penalty over 1 s. One generic image. The brain still stamps `Cairn-Thread` at each pick, so nothing depends on the stone's own hook.
4. **Project secrets are out of phase 3.** `bases.md` recommends a named exception to "credentials never leave the Beelink". Ruling: don't take it until a project needs it. Every stone runs with `enableInternet: false` behind one handler from day one, open and logged, so an allowlist can be added without a redesign. B6, the allowlist half of B7, and B11 are deferred. This is user decision 5, because a dev server needing a real key cannot run in a stone until then.
5. **Sizes.** Stones default to `standard-2`, set per project. Check runs and builders take the size spike 11 measures. A base's key holds the instance size only if spike 11 part B shows a snapshot cannot restore across sizes.
6. **Caps.** A brain-wide cap on awake stones (default 10, a setting, ceiling 32) replaces the per-workflow limit of 8 (`Workflows.ts:35`) for stone nodes. Past it, a node queues with a row and a place. `bridgeGenerationCap` gets wired to `slotsFor`, staying at 4 until spike 15.
7. **The coordinator rethink stays separate.** ADR 0042 is scrapped and nothing here assumes its design. Phase 3 uses only what is on `main` today: a project thread, and managed threads under it. A stone is never a project thread. If the rethink changes what a project thread is, the New stone button and the one lineage rule are all that move.

### Phase 2 gaps the notes found

Checked against the code on 2026-11-04.

| Gap | Evidence | Plan |
| --- | --- | --- |
| A workflow's writer nodes share the launching checkout, with no worktree | `WorkflowTools.ts:449` | Stone nodes fix it for stones. Host nodes are left as they are: user decision 8 |
| `readonly` removes no tool, so "reads only" on a launch card is a promise the model keeps | `WorkflowLaunch.ts:214`, `:306` | Same decision |
| "Run on 1 first" limits `pipeline()` and not `parallel()` | `Prelude.ts:325` | Fixed in U4, since a fan-out's first run has to be honest |
| A node waiting for a slot has no row, and the limit of 8 misses the ten-stone target | `Workflows.ts:35` | Fixed in U5 |
| The Claude generation cap in Settings has no reader on the server | `models/SettingsStore.ts` is the only server file naming it | Fixed in A12 |

### Deferred out of phase 3

Project secrets and allowlists (ruling 4), the home gate for private registries (B11), the agent that writes and proves `.agents/setup` (phase 4), Files, Evidence, Terminal and Desktop panes, the diff panel (stays off), "Update my checkout", and host portals through porch (ADR 0038 stays shelved).

## 3. Decisions for the user

The user answered yes to decisions 1 to 5 on 2026-11-04, with decision 1 staged: the restore test runs first on one or two snapshots, and the rest of M0 follows only if it passes. Decisions 6 to 9 stand as recommended unless the user objects. Also decided the same day: Playwright is removed, with its MCP server, and WebKit leaves automated judging in favour of the user's iPhone by hand (ADR 0044).

| # | Decision | Recommendation | The cost of the recommendation |
| --- | --- | --- | --- |
| 1 | Approve M0's spend, including about 10 snapshots that cannot be deleted | Yes | Under $2 of compute. The snapshots' storage is unpriced: a guess of $0.45 to $5.40 over their 30 days |
| 2 | Build bases on snapshots: public beta, no published price, no delete call | Yes, with a stored-bytes meter and a capture cap, if spike 11 passes | Exposure to a later price. Cairn's `DirectoryBackup` is 525 MiB and takes at least 12.6 s to extract, so nothing else can meet Stone start on a real project |
| 3 | Sleep keeps no disk (ruling 1) | Yes | Ignored files changed since the base are gone on wake. The alternative keeps them and buys an undeletable snapshot per sleep |
| 4 | A stone's code never runs at home: checks run on Cloudflare | Yes | About $0.25 and several minutes for a Cairn-sized `pnpm check`, on top of the stone. A probe showed lefthook running a stone-edited `lefthook.yml` on `git push` at home, so this one is not paranoia |
| 5 | No project secrets in phase 3 (ruling 4) | Yes, unless a project you want on stones needs a real key at once | Dev servers needing real keys, and private registries, fail until then. Run-time egress stays open, so a dependency could send source away; the seen-hosts log shows it afterwards |
| 6 | Stone portals are a fixed Caddy handle outside porch | Yes | Overrides kickoff decision 6 for stones. One wizard edit and one container recreate |
| 7 | Ship defaults to PR for a new project, and every ship waits for you, even in full access | Yes. Cairn itself can be set to trunk | One tap per ship |
| 8 | Fix host workflow writers (worktree per writer, `readonly` that removes tools) in this phase | No, later | They stay a known risk on `main`, as they are today |
| 9 | Which projects prove the targets | Cairn for Stone start and a small Bun repo beside it; a zero-dependency fixture for the Fan-out judge | Cairn's check in a stone is unproven until spike 11 |

Defaults taken unless you object, each from a note's decision list: `standard-2` by default; `MemoryHigh` raised from 1.5G to 6G, still soft; opening a thread does not wake its stone and an open tab does not count as human; a writer subagent on a stone gets a new stone; a sleeping stone's portal shows an asleep page rather than waking; no `.agents/setup` gets a default by lockfile; a failed real setup holds workflow stones and offers one interactive stone "Start anyway"; a hard limit of $2 per stone at list when a launch names none; uncommitted work gets one nudge, then is kept on a ref that is never integrated; shipped commits carry your identity with provenance trailers; result refs live until the thread is deleted and R2 keeps a bundle 14 days; bundle caps of 512 MiB, 200,000 paths, 100 MiB a blob and 1,000 commits; a dirty main is a note rather than a refusal, since ship never touches the checkout; home threads and subagents do not gain ship. Words: "result repo", "check run", "pick", "base".

## 4. Waves

### Rules every package follows

Phase 2's hold unchanged (`docs/phase-2/plan.md`, section 3): ownership, integrator-only seams, dependencies only on earlier waves, done means `pnpm check` green plus the package's judges, an integration note per wave in `docs/phase-3/waves.md`, scenarios before code, the cheapest model that answers the question. Phase 3 adds:

- **No Cloudflare until wave 2,** apart from M0's throwaway stacks, each destroyed in its own run.
- **A real-money run is announced with its estimate first,** and its cost is recorded in the wave note.
- **Tests against a deployed dev stage, never `alchemy dev`,** whose local container runtime is Docker (kickoff).

### Wave 0: measure (M0)

Throwaway code under `spikes/`, each with a `NOTES.md`. Nothing below is settled until these report.

| Spike | Merges | Gate |
| --- | --- | --- |
| `11-bases` | `bases.md` A to F, `arms.md` B, `results.md` B | Launch to first tool call p95 under 5 s on Cairn's tree: warm, 24 h unused, and ten at once. Snapshot lifetimes and restore across sizes answered. Cairn's `pnpm check` green in a container within 20 minutes and $0.25 a run. Chromium's cold start penalty measured. A number for snapshot storage, or a recorded "not billed" |
| `12-stone-life` | `arms.md` A and E, `results.md` A and C | The container still runs after an abort with no request at the chosen alarm interval. A cut at 1 MB home with p95 at most 2 s, and 100 MB within 60 s. No partial object after an eviction; a wrong checksum stores nothing. A check run adds at most 10 s per pick |

**Order inside `11-bases`:** part A first, on one snapshot, with the object recording its id and refusing a second capture. The other parts, and their further snapshots, follow only if part A passes.

**Stop rule (kickoff):** if Stone start fails, the user sees the measured bottleneck before anything else moves. There is no cheap fallback: a warm pool costs about $27.70 a month, and `DirectoryBackup` is slower.

### Alongside wave 0: Playwright out

One package, in its own worktree: the browser judges move to a small driver over the Chrome DevTools Protocol on system Chromium, and the relay loses Playwright's MCP server (ADR 0044). No browser judge can run until it lands, because Playwright's browsers are gone from the machine, so it finishes before wave 1. Every judge below is written on the new driver.

### Wave 1: at home ($0, no Cloudflare)

These fence everything later, and they do not depend on M0's answers.

| Package | What | Judge |
| --- | --- | --- |
| U0 | Words and protocol: every stone shape for the phase, written once, by the integrator | `thread-states.test.ts`, `wire-budget.ts`, `JsonSchema.test.ts` |
| U1 | Fake stones (`StoneBrain.ts`), kept apart from frozen seeds | `look.ts check` still 40 shots |
| A1 | Arms seam: `cairn.arms`, `Arms.placeOf`, `stones` table | `FakeStone`, seam conformance |
| A2 | The local-path audit and its lint rule | `FakeStone` with its control, lint probe |
| A3 | Routed env: host roots, read-only and named | `stone-routes` |
| B2 | Base records and the pure key | Key tests, single-flight test |
| RES-1 | Result repo and the bundle validator | `malicious-bundle` |
| RES-5 | Pure pick engine | Faux kill matrix, rename fixtures |

### Wave 2: one real stone (M1)

| Package | What | Depends on | Judge |
| --- | --- | --- | --- |
| A4, B1 | Stone image per ruling 3, digest in a committed file | M0 | `stone-image` |
| A5 | Worker, link, root stack, Access, stages | A4 | `stone-conformance`, Access matrix |
| A6 | Live arms: `Stones`, lazy `Connection`, boot reconcile | A1, A5 | `link-orphans`, `stone-kill` (bash windows) |
| A11 | Durable jobs for long work: claimed by task id, started with `setsid`, watched by a background task. The keep-awake lease joins A10 | A6 | `stone-kill` (job windows) |
| B3 | `Workspace` starts from a snapshot, captures, sweeps; one egress handler, open and logged | A5 | Capture and egress judges |
| B4 | Builder | B2, B3, A11 | Builder and single-flight judges |
| B5, B8 | Start path, default setup by lockfile, `.agents/setup` for Cairn and a Bun repo | B3, B4 | `stone-start`, setup judges |
| Spike `15-ten-at-home`, part D | A preset's wrong folder: no tool call names the home folder across Haiku, Sonnet and Opus | A6 | Its gate |
| A7 | The bridge on a stone | A2, A6 | `stone-kill --bridge` |
| RES-2, RES-3, A8 | The one cut (ruling 2), work receipt, commit nudge, diffs from the result repo | RES-1, A6 | `results-kill`, `FakeStone` diffs |
| A9, U6 | Creation: `isolation: "stone"`, New stone, the `Stone` strategy | A6, B5 | Seam scenarios, `subagent-durability`, `brief-go`, `stone-new-<w>` |
| U2, U7 | One thread-state function; header, strip, work panel, notices | U0, A9 | `thread-state-rows.test.ts`, `rows-subagent.ts stone-row`, `work-panel.ts stone-panel` |
| A14 | Every MCP server from a stone | A9 | `tools.ts --stone` |
| Look round 12 | The new states at 1,440 and 390 px | U6, U7 | The user's approval, `look.ts freeze 12` |

**Gate M1:** `stone-start` and `tools.ts --stone` pass on the dev stage, and the user does real work in one stone from the phone. The user decides whether to go on.

### Wave 3: a stone's life (M2)

| Package | What | Depends on | Judge |
| --- | --- | --- | --- |
| A10 | Sleep and wake per ruling 1, dual timer, keep-awake reasons and the job lease, alarm, watchdog with a safety cut | A8, spike 12 | `stone-idle`, `stone-sleep`, `stone-kill` (wake windows) |
| U8 | Compute: intervals, ledger, meter, a budget stop that sleeps | A10 | `budget-stones`, `spend-kill.sh compute` |
| Spike `14-compute-reconcile` (SP2) | The ceiling against Cloudflare's per-instance dataset | U8 | Never under the dataset, over it by at most what full CPU explains |
| RES-4 | Check runs | B5, spike 12 | Decoder tests, lazy-judge control, isolation |
| RES-8a | Ship for one stone, PR and trunk; a conflict on trunk refuses with its reason until wave 4 | RES-4, RES-5 | `ship`, with one real PR on a throwaway repo |
| U10, U11, B9, A13 | Settings' Stones section, usage page, stored-bytes meter, nightly idle check | U8, B4 | `behaviour.ts` rows, `meters-compute`, `idle-cost.ts` |
| Spike `16-soak` (F) | 24 h of one stone under the alarm, counting evictions and losses | A10 | No loss keeps run-end cuts. Any loss adds a cut every 5 minutes during a run |

**Gate M2:** a stone sleeps, wakes on a message with its files, and ships a PR the user merges; the idle check holds under $6 on the dev stage. The user's own bill is the second judge, once a month has passed.

### Wave 4: fan-out (M3)

| Package | What | Depends on | Judge |
| --- | --- | --- | --- |
| U3 | `stone()` verb, prelude version 4, envelope | U0, A9 | `Prelude.test.ts`, `WorkflowPlan.test.ts`, `workflow-kill.sh stone-envelope` |
| U4 | Launch card: stones, compute, base, an honest Run on 1 | U3 | `launch-stones` |
| U5 | Row before slot, awake cap, durable queue | U3, A6 | `steps-stones`, `workflow-kill.sh` |
| Spike `15-ten-at-home`, part C | Ten Haiku stones on real work | U5 | No `high` memory events; p50 turn time within 1.5 times one stone's |
| A12 | Permits and caps per that number | Spike 15 | `stone-load` |
| RES-6 | `integrate` verb, check loop, events, stop | RES-3, RES-4, RES-5, U3 | `integrate-kill` |
| RES-7, RES-8b | Resolver, conflict card, conflicts on trunk ship | RES-6 | `resolver`, `ship` |
| RES-9 | `judges/fanout.ts`: checks X1 to X6, ten zero-dependency tasks, one planted conflict, seven controls | All above | `fanout`, under $0.50 a run by arithmetic |

**Gate M3:** `fanout` passes against its controls with cost shown before and after, and the user runs one fan-out on real work.

### Wave 5: reach and the gate (M4)

| Package | What | Depends on | Judge |
| --- | --- | --- | --- |
| Spike `13-stone-portal` (SP1) | A Vite app through Caddy, the Worker and the object | Wave 2 | HMR under 1 s p50, survives a `caddy reload`, no secret seen by the container |
| U9 | Portals: migration, Worker route, `ops/wizards/phase-3.sh` edit, first portal UI | Spike 13 | `owner-guard.ts`, `stone-portal.ts` |
| U12 | Look round 13 | U4, U9, U10, U11 | The user's approval, `look.ts freeze 13` |
| U13 | The phone gate | Everything | The user |

## 5. Where each target is judged

| Target | Judge | Package |
| --- | --- | --- |
| Stone start | `judges/stone-start.ts`, 20 sequential and ten at once, with a 24 h unused case, on Cairn | B5 |
| Tools | `judges/tools.ts --stone` | A14 |
| Durability, on a stone | `judges/stone-kill.sh`, `results-kill`, `integrate-kill`, `link-orphans` | A6 onward |
| Idle cost | `idle-cost.ts` on the dev stage, then the user's bill | U11, A13 |
| Fan-out | `judges/fanout.ts`, then the user | RES-9 |
| Untrusted stones | `malicious-bundle`, `owner-guard.ts` | RES-1, U9 |
| Use | The user, from the phone, at M1, M2, M3 and M4 |  |

## 6. What only the user can do

In `ops/wizards/phase-3.sh`, kept short:

- Sign off this plan. Section 3's first five are answered.
- Say yes before each real-money run.
- Ask Cloudflare what snapshots cost, if you can. It would close the largest unknown.
- Create a throwaway private GitHub repo for one real PR in `judges/ship.ts`.
- Create a read-only Cloudflare analytics token, used only by `idle-cost.ts` and spike 14.
- Run the Caddy edit and container recreate for the portal handle.
- Approve look rounds 12 and 13, and use each milestone from the phone, which is now also the only WebKit check (ADR 0044).

## 7. ADRs to write after sign-off

Written once section 3 is answered, so they record your answers rather than my guesses. `proposed` until their gate passes.

| Title | Gate |
| --- | --- |
| A stone's arms are named by a `cairn.arms` document | `FakeStone`, seam conformance |
| One relay process and one socket per awake stone | `link-orphans` |
| The brain decides sleep, the object is the last resort, and sleep keeps no disk | `stone-sleep`, `stone-kill` |
| One cut per run, through R2, into a result repo | `results-kill`, `malicious-bundle` |
| A stone's Claude child runs in a stable empty folder at home (amends 0017) | `stone-kill --bridge` |
| Long work on a stone is a durable job | `stone-kill` |
| Readers share a stone; writers get their own | Seam scenarios |
| Bases are container snapshots, reused across commits (amends the kickoff's key) | Spike 11 |
| Code reaches a stone as a git bundle over the link | User's word |
| The brain builds bases, and no `Quarry` object exists | User's word |
| A stone's egress is open and logged, behind one handler | Egress matrix |
| One stone image holds the toolchains (amends 0005) | Spike 11 |
| Integration picks are pure plumbing (amends 0012) | `integrate-kill` |
| A stone's code never runs at home | `fanout`, spike 11 |
| Ship is a push the user approves | `ship` |
| A stone is a workflow verb over the one node path (amends 0012) | `workflow-kill.sh stone-envelope` |
| A stone always has a parent, and a project thread is never a stone (amends 0026) | `stone-brief-go` |
| Awake stones share one cap and queue past it | `steps-stones` |
| Stone portals are a fixed Caddy handle, outside porch (amends 0038) | Spike 13, `stone-portal.ts` |
| Compute is a labelled ceiling from Cairn's own intervals, and counts in the dollar limit (amends 0036) | Spike 14 |

## 8. Risks

- **Snapshot restores are slow when cold.** Then Stone start fails for the case that matters, a first stone after a quiet day. Spike 11 finds this before anything is built on it.
- **Cloudflare prices snapshots high, or changes the beta API.** Bases are always disposable: no Cairn data lives only in one.
- **Check runs are too slow for real projects,** with Cairn's own check as the worst case. Then the user picks between trimming `checks.full` and `bwrap` at home, with the number in hand.
- **The Beelink at ten stones.** `MemoryHigh` is 1.5G and the unit has already reached it, while ten stones need about 3.5 GB by arithmetic. Generation share is unmeasured until spike 15.
- **A trunk push of code no person read.** The ship card's diffstat and `sensitive_paths` flags must not be folded away.
- **Prompt injection through a stone's commit message** into a resolver or a card. Marked as data and escaped in the UI, but the resolver's checks are the real protection.
- **The notes were written in parallel,** and only section 2 reconciles them. Expect more seams to surface when wave 1's protocol is written.

## 9. Not verified

Each note ends with its own list, and these matter most. Nothing has run on Cloudflare since spike 1 (2026-10-22). `@cloudflare/sandbox` was read at 1.0.0 and from a clone, not at the pinned 1.0.2, and 1.0.3 is out. Live pages came through a summarizing fetch. The Caddy handle is unvalidated. `merge-tree` was probed with plain git only. Ultimate's lander was not read, since there is no clone. No real model ran any of this.
