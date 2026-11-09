# Phase 3 notes: arms

Scope: the stone as a thread, and its arms in production. How a stone is represented and created, which tools run where, the bridge on a stone, the production link, lifecycle and the dual idle timer, compute cost, and the judges for all of it. Written 2026-11-04 for the phase 3 plan. Cairn is read at `a160935`. Nothing in the repo changed apart from this file; no Cloudflare call was made and no money spent. The one local probe is described under "What I measured".

Sibling notes: `bases.md` (a stone's disk, snapshots, `.agents/setup`, seeding, egress during setup), `results.md` (bundle home, integration, ship), `surfaces.md` (the `stone` workflow verb, the launch envelope, UI, portals, compute spend). "Needs from sibling notes" lists what this note asks of each. ADR 0042's coordinator is scrapped and being rethought; nothing here assumes it. Roles are gone (ADR 0043): a stone's child names `provider/modelId[:level]` or runs on its parent's model.

Words: "task" is pi-durable's. A stone's lifecycle states are new words, listed for the glossary in section 1.

## Summary

1. **The spike's path holds, and the brain is not ready for it.** `RemoteExecutionEnv` plus a relay is the right arms (spike 1: 29 of 29, exec p50 37 ms). But the brain treats a conversation's cwd as a local path in about 20 places. Most fail loudly. Three fail silently and are the phase's first bugs: a stone's checkpoints would be captured in the user's home checkout (`Diffs.ts:186-192`), the stone's `bash` would run with the Beelink's `HOME` and `PATH` (`CodingTools.ts:71,248`), and project skills and `AGENTS.md` would vanish from its prompt with no error (`SkillCatalog.ts:145`, `ProjectContext.ts:203-205`).
2. **Representation.** A `cairn.arms` conversation document (`fork: "current"`, absent means host) names the stone; a `stones` table in `cairn.sqlite` holds its lifecycle; the shell row gains `stone` and keeps `worktreePath` none; lineage gains the relationship `stone`. One `Arms.placeOf` replaces every direct reading of `agent.cwd`, and a lint rule keeps it that way.
3. **Tools.** Every tool's code stays in the brain and reaches the stone only through `api.env`, so most tools move with no change. Reference material (skills, the clone shelf, attachments) is served by a routed env, read-only, from named home roots. The image lacks `rg` and `fd`, and its git is too old for the `Cairn-Thread` trailer (needs 2.54, `CommitTrailer.ts:41`).
4. **Bridge.** A Claude child cannot run at `/workspace`: that folder is not on the Beelink. It gets a stable empty folder at home per stone (`<data>/stones/<stoneId>`), so stamps, resume and ADR 0025's fork work unchanged across sleep and restart. The child's preset says the wrong working directory, so the Cairn section corrects it, and a judge checks the model obeys.
5. **The Beelink is not the fan-out bottleneck; two settings are.** Ten children and ten relays need about 3.5 GB of the 14 GiB free, but `cairn.service` sets `MemoryHigh=1.5G`, and its peak has already reached that line. The generation semaphore holds 4 permits, and the setting that should raise it has no reader. `MAX_CONCURRENT_NODES` and `MAX_LIVE_CHILDREN` are both 8, under the target's ten.
6. **Link.** One relay process and one socket per awake stone. pi-env's `Connection` can only spawn a process (`connection.js:208`), and a relay costs about 43 MB. A shared socket would mean a mux process plus a Hub object, and gains about 400 MB on a machine with 14 GiB free. Relays stay dependency-free: importing Effect takes a bare Node from 41 MB to 95 MB RSS.
7. **Sleep is the brain's decision; the object is the last resort.** The brain sleeps a stone at the later of 5 minutes of agent idle and 20 of human idle. A 60 second alarm in the `Workspace` object re-arms the inactivity timeout that a restart clears, and if the brain is gone for 30 minutes the object captures and destroys on its own. A forgotten stone costs $42 a month, so this is not optional.
8. **Uncommitted work has a floor and a ceiling.** Floor: every run's end checkpoint (tracked and untracked, not ignored) comes home as a bundle, so a lost container loses at most the current run. Ceiling: a full disk capture at sleep (mechanism in `bases.md`). This also makes per-turn diffs readable while a stone sleeps, with `Diffs` unchanged.
9. **Long work is a durable job.** Spike 1 showed that an eviction ends the foreground command and spares `setsid` work. `job_start`, `job_status` and `job_stop` run through `api.env`, keyed by the task id so a rerun cannot start twice, with a watcher that holds the stone awake and leaves a note at the end.
10. **Cost.** Idle floor $5.00 a month (Workers Paid minimum), leaving about $1 for storage. Recommended default `standard-2`: $0.057 an hour idle, about $0.064 at typical load, $0.129 flat out. Ten stones for an hour: about $0.64.

## Facts with evidence

### Pins and sources

| Thing | Where | Pin |
| --- | --- | --- |
| pi-env, pi-durable | `apps/server/node_modules/@earendil-works/*`; spec from `git show v1.4.0:packages/durable/docs/spec.md` in the pi clone (not in the installed package) | 1.4.0 |
| Alchemy | `node_modules/alchemy/src/Cloudflare` | `2.0.0-beta.83` |
| `Container` type | root `node_modules/.pnpm/@cloudflare+workers-types@5.20261019.1`, `index.d.ts:3983-4000` |  |
| `@cloudflare/sandbox` | The brief's `spikes/1-stones/node_modules` does not exist at this commit. I read v1's `node_modules/.pnpm/@cloudflare+sandbox@1.0.0` and the clone `cloudflare/sandbox-sdk` at `f9e972a1`; the spike and image pin 1.0.2 | see "Not verified" |
| Live Cloudflare pages | read 2026-11-04; each page's own date is in section 6 |  |

### What spike 1 settled (`spikes/1-stones/NOTES.md`)

- Conformance 29 of 29, exec p50 22 to 37 ms, new stone `start` to first exec 1.0 to 1.2 s, first start after a new image 10.7 s, 10 MB transfers at about 15 MB/s, `readTextFile` three round trips (`NOTES.md:28-36`).
- An eviction ends the foreground command, and the tool reports `pi-env connection lost` without a rerun; `nohup` and `setsid nohup` work outlives it (`NOTES.md:50`).
- The container outlives the object (`NOTES.md:52`), but only ever measured with a request arriving soon after. See spike A.
- No relay left behind after any run (`NOTES.md:48`), under a plain process, with a healthy network.

### What the installed sources say

- **Env per use.** `HarnessOptions.env` may be async (`dist/harness/types.d.ts:566`), gets `{conversationId, cwd, read}` (`types.d.ts:541-546`) and is called for every tool execution (`dist/harness/tool.js:309`) and once per generation prepare for the section renderers (`dist/harness/generation.js:60`). A throw there is reported and sections render with `env: undefined`. So `Arms.env` must never touch the network: building it at generation prepare must not wake a stone. No Cairn section reads `input.env` today (grep), and I found no built-in that does.
- **The spec names this design.** Spec 918-956: an application that needs more than a directory "keeps that in its own document and reads it through `target.read`", absent means local, and "Subagents do not copy it: their creator writes it too". Footguns that bite here: "Environment on recovery" (5582), "Copies are one-time" (5579), "Moving default selections" (5585), "Non-cooperative code at close".
- **Connection.** Spawns only (`connection.js:208`); its `command` may be an async function run at each start, before the 60 s start timer (`connection.js:196`, `connection.d.ts`), which makes it the natural wake hook. It pings every 5 s and gives up after 30 s of silence (`:11,13`). `close()` is permanent (`#closed = true`), so a new wake needs a new `Connection`.
- **Workspace.** `setInactivityTimeout` in the constructor only if already running (`workspace.ts:83`), 15 minutes today (`:43`); a pipe never starts a container (`:90`); at most 4 pipes, then 429 (`:44,119`); `enableInternet: false` (`:95`); `server.accept()` (`:121`), so an open pipe keeps the object active.
- **Relay.** Ends on an exit frame, a socket close or a signal (`pipe.ts:118,132,155-162`). On stdin end it only sends `eof` (`:103-105`), and has no timer of its own: with the brain gone and the network stalled, nothing ends it. A systemd cgroup covers production; judge brains and dev brains have none.
- **Live lifetime page** (updated 2026-10-22): `setInactivityTimeout` maximum 6 hours; a request in the window reaches the same instance; a Durable Object restart clears the timeout, and "the restarted object has no timeout, so the instance stops shortly after the object becomes inactive"; the object is active while it holds a WebSocket accepted with `accept()`, runs an alarm or handles a request; code in the instance does not count; a deploy restarts every object but a running instance keeps running; no minimum runtime is guaranteed; a running instance is billed for memory and disk whether or not it works.

### What I measured

Local, on the Beelink, against a loopback WebSocket acceptor, no TLS. Ten copies of `spikes/1-stones/relay/pipe.ts` connected and idle, Node 26.11.1.

| Measure | Result |
| --- | --- |
| Relay RSS | 88 to 89 MB (37 MB anonymous) |
| Ten relays, PSS total | 430 MB, so about 43 MB each once shared pages count once |
| Bare Node, RSS | 41 MB; with `import("effect")`, 95 MB |
| `cairn.service` now | `MemoryCurrent` 706 MB, `MemoryPeak` 1,612,034,048 B, `MemoryHigh` 1,610,612,736 B: the peak has reached the ceiling |
| Machine | 27 GiB, 14 available, 16 threads |
| Brain's environment, names only | `HOME`, `PATH`, `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_*`, `NIRI_SOCKET`, `PNPM_HOME` and similar. No credential by name today |

## 1. How a stone is represented

Four pieces, each holding what it alone can hold.

**The `cairn.arms` document** (promised at `Arms.ts:3-4`). Kind `cairn.arms`, version 1, `scope: "conversation"`, `history: "latest"`, `fork: "current"`, `checkpointWhen: () => false`, written once. Shape `{ kind: "stone", stoneId, instance }`. Absent means host (spec 941-955), so no existing conversation migrates and `read.snapshot` returns `undefined` for it. `fork: "current"` is deliberate where `ThreadMeta` is `initial` (`CairnDocs.ts:117-122`): a fork that resumes a node (`agent(prompt, { resume })`) stays in the same stone. The creating commit writes it, beside `firstAgent` (`PiDurableHarness.ts:427`); `EnsureThread` (`HarnessSeam.ts:82-94`) gains `arms`.

**`Arms.env`** becomes one read and one branch:

```ts
env: async (target, context) => {
  const arms = await target.read.snapshot(
    ArmsDoc,
    target.conversationId,
    context
  );
  if (arms !== undefined) return stones.env(arms); // lazy: no network until the first request
  return target.cwd === undefined
    ? undefined
    : new NodeExecutionEnv({ cwd: target.cwd, shellEnv: shellEnv() });
};
```

`stones.env` returns the routed env of section 2 over the stone's current `Connection`. Waking happens in that `Connection`'s `command` function, so it happens at the first real request and never at generation prepare.

**The `stones` table** in `cairn.sqlite` (ADR 0016's split; the kickoff names stones as Cairn's own state). One row per container: `stone_id`, `owner_thread_id`, `project_id`, `base_key`, `instance`, `image_digest`, `state`, `generation`, `sleep_record`, `last_agent_at`, `last_human_at`. Written before anything remote happens, following ThreadLaunch's T18 pattern (`ThreadLaunch.ts:479-481`). States: `planned`, `waking`, `awake`, `sleeping`, `asleep`, `lost`, `destroyed`. A `stone_intervals` table records each awake stretch for compute spend (`surfaces.md`).

**The shell row.** `ThreadShell` (`Shell.ts:153-202`) gains `stone: added(Schema.OptionFromNullOr(ThreadStone), null)`, with `{ stoneId, state, instance }`, committed through a `ThreadStoneUpdate` command as `ThreadWorkspaceUpdate` does now. `branch` holds the stone's branch. `worktreePath` stays none, and that forces section 2's fixes: every consumer that falls back to the project root must first ask whether the thread is a stone. `WaitingFor` (`Shell.ts:106`) gains `stone`, for a turn held by a wake.

**Lineage.** `RelationshipToParent` (`Subagents.ts:60`, whose comment already says stones arrive in phase 3) gains `"stone"`. A spawned stone is a subagent whose arms are a stone: same anchor, brief, reporter and settlement (ADR 0028), hidden row, tally.

**The stone id.** A branded `StoneId`, the owner thread's id, so a resumed launch finds the same object (S46) and needs no mint. `SANDBOX_ID` (`frame.ts:29`, 12 hex) widens to fit.

**`Arms.placeOf`.** One function, `Host { cwd } | Stone { stoneId, cwd: "/workspace", bridgeDir, homeRoot }`, is the only reader of `agent.cwd` and of `worktreePath`-or-root. `/workspace` stays the cwd: the image links it to `/cairn/workspace` (`images/stone/Dockerfile`), because a restore swaps beside its target and `/` is not writable (v1 `apps/cloud-sandbox/src/backup.ts`).

### How a stone gets created

| Path | How | What changes |
| --- | --- | --- |
| The user, from the hero | `WorkspaceStrategy` (`Launch.ts:64`) gains `Stone { baseRef, branch, instance }`. `prepareWorkspace` (`ThreadLaunch.ts:482`) gets a `Stone` case: plan the row, ask `bases.md` for the base, derive the cwd. `ensureThread` (`:713`) writes the arms in its commit. The first run wakes it | A launch in a folder project makes or refreshes the project thread today (`Launch.ts:85-90`, `ShellCommands.ts:1017`), so a stone launched from the hero would replace it. User decision 2. Scratch project: refused, since it has no repository |
| A thread, through a tool | `subagent_spawn` with `isolation: "stone"` (`SubagentTools.ts:297`), and `BriefWorkspace` (`Policy.ts:251`) gains `stone`. The brief goes through Go as now (ADR 0026, 0030); the start task (`SubagentTasks.ts:2926`) calls `Stones.plan` where it calls `workspaces.prepare`, and its commit writes the child's arms | Glossary's "from an approved brief" holds. The workflow verb is `surfaces.md`'s; `NodeArms` and `EnvelopeModel.arms` already exist (`Policy.ts:301,313`), with `ARMS` fixed at `"host"` (`WorkflowPlan.ts:225`) and the gate requiring it (`WorkflowLaunch.ts:200`) |
| A subagent a stone spawns | **Reader (`shared`, the default): the same stone.** The start task and `childAgentOf` (`WorkflowTools.ts:612-617`) copy `cairn.arms` and the cwd, because a task-owned conversation copies `pi.agent` but not this document. **Writer: a new stone,** seeded from the parent's newest home checkpoint. `isolation: "worktree"` on a stone is refused with the reason | Departs from research 06 §3.1 (a sub-worktree in the same container). A worktree on a stone means porting `ChildWorkspaces` (home git throughout, `ChildWorkspaces.ts:278,487,513,686`) and its release and repair rules, and two writers sharing RAM, for a saving of about $0.06 an hour. User decision 6 |

The depth cap (`MAX_SUBAGENT_DEPTH` 2) and the rule that a node cannot spawn stay. Glossary additions in the same change as this code: stone states, sleep capture, stone job, host root, link state.

## 2. Which tools run on the stone

The principle that does most of the work: a tool's code runs in the brain, and pi-durable hands it `api.env` (spec 3283). So "runs on the stone" means "its files and processes are the stone's".

Order keys are `Extensions.ts:12-39`.

| Feature | Runs on a stone | What has to change |
| --- | --- | --- |
| `bash` (100) | Code at home, command on the stone | **Bug.** `prepare` forwards the Beelink's whole environment with inheritance off (`CodingTools.ts:248,257`), so a stone's `HOME` is `/home/oscargabriel`, and any secret ever added to `brain.env` would leave the machine. Stone arms: pass only `execution.env` plus the trailer, inherit the daemon's. Section says long work uses jobs |
| `read`, `write`, `edit` (100) | Through env, on the stone | None for the stone's files. `read` reaches host roots through the routed env. Photon runs at home on the bytes |
| `grep`, `find` (100) | `rg`, `fd` on the stone | **Bug.** Same environment leak (`CodingTools.ts:71`). The image has neither binary (`Dockerfile:20` installs git, ca-certificates, procps), so both tools fail. Debian's `fd-find` installs as `fdfind`, so link it. `runSearch` takes the host root's env when the path lies inside one |
| `ls` (100) | On the stone | Environment only |
| Commit trailer | Hook on the stone | **Silent bug.** The hook needs git 2.54 (`CommitTrailer.ts:41`); the version check asks the Beelink's git (`CodingTools.ts:304-313`), while the image takes bookworm's git, 2.39 from memory. Commits would simply lack the trailer. Build a pinned git in the image's own stage and judge it live |
| `cairn` section (200) | Home | Says "the folder" (`CairnSectionExtension.ts:23`). A stone's text says where it is, what `bash` can and cannot see, that long work uses jobs, and that processes end at sleep |
| Skills (300) and `$skill` expansion | Catalog and `read` at home | **Silent bug.** `cwdOf` (`SkillsExtension.ts:44`) passes `/workspace` to `SkillCatalog`, which stats local paths (`:43,145`) and finds no project skills. Use `homeRoot`. `SkillExpansionStage` already falls back to the project root (`:195-196`) and reads locally (`:253`), so it works once the row is right. A skill's scripts are unreachable by the stone's `bash`: user decision 7 |
| `project_context`, `addendum` (400) | Home | **Silent bug.** `context.read(cwdOf(input))` (`ContextExtension.ts:36`) walks a local tree (`ProjectContext.ts:203-205`) and reads nothing. For a stone, read `git show <baseSha>:<path>` for each context file from the home repository, pinned per run as now. It never wakes a stone and is byte-stable, so the prompt cache holds. A stone that edits `AGENTS.md` keeps the base's text in its prompt; the file on disk is right |
| Code mode (500) | Home. Nested tools take the conversation's env | None. `MAX_WORKERS` 4 (`CodeMode.ts:53`) is shared across every thread: see section 3 |
| Executor proxies (600) | Home, over the brain's grant | None, by construction. No local path (grep). The tools target needs a stone run of `judges/tools.ts` |
| Budget gate (640) | Home | None here. Compute spend is `surfaces.md`'s |
| Subagent tools (650) | Home | `prepare` takes `parentCwd: agent.cwd` (`SubagentTasks.ts:2929`) and runs home git in it (`ChildWorkspaces.ts:278`). Branch on arms per section 1. `ChildWorkspaceRepair` skips stone children |
| Workflow tools (660) | Script at home | `childAgentOf` copies the cwd only (`WorkflowTools.ts:612-617`), so a node would run with `/workspace` on host arms: write the arms as well. `plan.projectRecipe(agent.cwd)` reads locally (`WorkflowPlanTool.ts:288-291`): use `homeRoot`. Verb and envelope: `surfaces.md` |
| Goal judges (670) | Through env, on the stone | Already right (`JudgeRun.ts:306-337`). A judge run wakes a sleeping stone and counts as agent work |
| Bridge cwd (700) | Home | Section 3 |
| Provider request log (750), model health (850), `models` (860), `ask_user` (870), result tool (950) | Home | None. A settlement's `branch` is null today (`SubagentTasks.ts:2075-2079`); `results.md` fills it for a stone |
| Artifacts (760) | Home, publishing | `path.resolve(request.cwd, request.path)` and local reads (`Artifacts.ts:433,453`, `ArtifactPublisher.ts:171`) would fail or, worse, publish a home file of the same path. Stone arms: pull the tree through env into a temp folder first, then publish as now. Size cap as today |
| Portals (760) | Dev server on the stone | `PortalTools.ts:110,179,188,251` read cwd and run home git. `PortalArms` exists (`Reach.ts:82`). `surfaces.md`'s; this note asks only that a portal request counts as human activity and wakes, as v1's spike 7 rule 4 found |
| Pi host: `web_search` and friends (800) | Home, one instance per brain | None |
| Pi host: `ffgrep`, `fffind` (800) | Cannot work | **Bug.** `PiToolAdapter.ts:147-161` passes `/workspace`, and the host builds a folder instance there (`PiHost.ts:12-16`). The adapter asks `Arms.placeOf` and returns "use `grep` and `find` on a stone" as a tool error. The tool list stays fixed, so no prompt cache misses (footgun 5585) |
| Checkpoints and changed-files card | Capture on the stone, diffs at home | **Silent, and the worst one.** `workspaceOf` falls back to the project root when `worktreePath` is none (`Diffs.ts:186-192`), so `CheckpointCapture` (`:236-246`) writes refs and reads the user's home checkout, and shows the user's own dirty files as the stone's work. Add `{ kind: "stone" }`. Capture through env, then bring the refs home (below), and `Diffs` runs at home with no other change |
| Checkpoint boot repair | Home | `repair` (`CheckpointCapture.ts:431`) sweeps scratch indexes in `folderOf`. A stone is skipped when asleep, and an awake one captures through env. A run end missed in a kill is covered by the next run's end |
| Worktree code | None on a stone | `Worktrees` and `ThreadLaunch.renameBranch` (`:379-388`). A stone's temporary branch is renamed through env at launch, or named before it. `thread.configure` refuses a cwd change (`PiDurableHarness.ts:506`) |
| Title generation | Home | None. `ThreadTitles`, `TitleModel` and `BranchNames` read no cwd (grep) |
| Attachments | Stored at home | The path line names a home path (`AttachmentStage.ts:73,123`). `read` works through the attachments host root. `bash` cannot see the file, which matters for XLSX and PPTX, offered only by path (`:10`). User decision 7 |
| Composer `@` menu, skills list | Home | `ProjectHandlers.ts:52`, `SkillHandlers.ts:57`: the project root. Lists home files, not what the stone created. Accepted |
| Clone shelf | Home, read-only | New: a host root. `bash` cannot see it, and the section says so. This is what fixes v1's re-cloning |

### Routed env and host roots

A small `ExecutionEnv` that wraps `RemoteExecutionEnv`. For a path-taking read, it resolves the absolute path; if the path lies inside a host root, it canonicalizes at home, checks again that it is inside (symlinks: `~/.claude/skills` links into `~/.agents/skills`), and answers from a `NodeExecutionEnv`. Writes into a host root fail with a clear `FileError`. `exec` always goes to the stone.

Host roots are named, never broad: the `SkillCatalog` view's skill directories, `~/Developer/clones`, the attachments folder. Never the agent dir, since `auth.json` lives there. Its judge reads `~/.pi/agent/auth.json` through a link and must be refused, without printing anything.

### Bringing checkpoints home

The recipe in `Checkpoints.ts:394-630` runs through a `Git` and a `FileSystem`. Give it a place seam: the host one as now, and a stone one over `env.exec` and env's file methods (about ten link round trips at 37 ms, plus git). After a run's end capture, make an incremental bundle (`git bundle create <tmp> <new refs> ^<known refs>`), read it through env (v1 `apps/server/src/sandbox/Bundles.ts` chunks it, checks the header and caps the size), and `git fetch` it into the home repository under the same `refs/cairn/checkpoints/<thread>/turn/<n>`. Refs are thread-keyed, so children never collide, and everything downstream is the existing code. Then the `cairn.checkpoint` entry is written. A failed capture logs and never fails a run (`CheckpointCapture.ts:173-184`), and the next run's end covers it.

Turn 0 needs the base commit at home. That is a requirement on `bases.md`.

## 3. The bridge on a stone

**The bug.** `placeOf` reads `agent.cwd` (`BridgeCwdExtension.ts:55-75`), `noteConversation` tries `realpath` and falls back to the raw string (`Claude.ts:308-310`), and the child starts there (`ClaudeSdk.ts:251`). `/workspace` is not on the Beelink, so the first Claude turn on a stone fails to spawn. Not run; this is what Node's `spawn` does with a missing cwd.

**The cwd.** The child gets `<data>/stones/<stoneId>`: an empty folder at home, made before every note, and no other. Its reasons:

- It cannot change for the life of the stone, and `stamp.cwd !== input.cwd` forces a fresh session (`ClaudeResume.ts:173-174`, `ClaudeStamp.ts:49-50`). So it is derived from the stone, never from a wake or a container.
- With `tools: []`, `settingSources: []` and `claudeMdExcludes` (`ClaudeSdk.ts:254-261`) the child reads nothing from it. It is only where `~/.claude/projects/<escaped>/` files transcripts (ADR 0017).
- Not the project root: Claude Code would then describe a git checkout the model cannot reach, and stones would share a session folder.
- Not the same path inside the container: a real empty folder at home with the stone's own path would hide every local-path bug in section 2.

`BridgeCwdExtension.placeOf` asks `Arms.placeOf` and passes `bridgeDir`. Shared subagents on one stone share the folder; their sessions are keyed by provider session id, so they do not collide.

**Stamping and resume.** Nothing else changes, because the transcripts, stamps and child are all at home.

- ADR 0018: the stamp commits with the reply and names the session; resume is SDK-native. A stone's sleep is invisible to it: a Claude Code session has no knowledge of the arms, so the cache holds for its TTL across a sleep.
- ADR 0025: the compaction fork runs at home through `fork-stamped` with the same `base.cwd` (`ClaudeConversation.ts:1030-1033`), and needs no stone.
- ADR 0017: the kill cases are the same, plus a tool held on a link that died. The tool settles as lost or "may have run"; the held query then gets a tool result as for any failed tool. `judges/claude-kill.sh`'s three windows need a stone run.
- A one-shot takes `place.cwd` too (`Claude.ts:241`), so it gets `bridgeDir`.
- A deleted stone leaves its transcripts to Claude Code's own sweep.

**The preset tells the model the wrong folder.** `{ type: "preset", preset: "claude_code" }` (`ClaudeSdk.ts:268`) states the working directory. `excludeDynamicSections` does not help: it moves that text to the first user message (`sdk.d.ts:2359-2363`) and would change the prefix for a resume. So a stone's `cairn` section says plainly that the environment block's folder is not where tools run, and names `/workspace`. Spike D measures whether every model obeys.

**Guardrails hold.** A stone gets Claude only through the brain, and the child has no tools of its own. A stone's output reaches the model like any tool result, and the model's reach is the permission mode's business, as on a thread.

### Fan-out against the semaphore, and the Beelink

Spike 0 measured 258 MB per generating child and 232 MB parked, flat from 1 to 6 children, no helper processes.

| Ten Claude stones at once | Amount | Against |
| --- | --- | --- |
| Children | about 2.6 GB (10 x 258 MB) | 14 GiB available, so RAM is fine |
| Relays | about 430 MB, measured |  |
| Brain | some hundreds of MB; the unit reads 706 MB now with children in it |  |
| **Unit total** | **about 3.5 GB** | **`MemoryHigh=1.5G` (`ops/cairn/cairn.service:37`)**, whose cgroup holds all of it. Past it the kernel reclaims and throttles the unit. The peak already reached that line, before any stone |
| Generation | 4 permits (`ClaudeSlots.ts:8`) | **A wall-clock limit, not a failure.** A child holds no permit across a tool call, so a stone in a long build costs nothing. With 10 stones each generating a share g of its time, a queue forms above g = 0.4, and at g = 0.7 total throughput is 4/7 of uncapped. g is unmeasured: spike C |
| `bridgeGenerationCap` | Up to 16 (`Settings.ts:18`), default 4 | **I found no reader outside `SettingsStore` and the web client.** Meanwhile `slotsFor` sets 4 or 2 on every usage reading (`ClaudeUsage.ts:800-806,995-1002`). The setting does nothing today; wire it in |
| Code mode workers | 4 (`CodeMode.ts:53`) | A script past that waits, and Stop ends the wait. Fine unless scripts run long; spike C reads it |
| Node and child caps | `MAX_CONCURRENT_NODES` 8 (`Workflows.ts:35`, up to 32 in `Policy.ts:327`), `MAX_LIVE_CHILDREN` 8 (`Subagents.ts:38`, refused at `SubagentTools.ts:401`) | **Under the target's ten.** A stone workflow's default needs 10 or more (`surfaces.md`). Brain-wide 32 is fine |

**Conclusion.** The Beelink as a machine is not the bottleneck. Its unit file and 4 permits are. The real limit on ten Claude stones is the plan window, which is why the permit count stays the user's call (decision 3). A non-Claude stone touches none of this but the relay.

## 4. The production link

### One relay per stone

|  | One relay per awake stone | Shared socket |
| --- | --- | --- |
| Fits pi-env | Yes: `Connection` spawns a command | No. A process per `Connection` is still needed, talking to a mux, unless pi-env is forked |
| Beelink at ten stones | 10 processes, 430 MB | 11 processes, more code, 1 failure domain |
| Cloudflare | One object per stone, the natural unit | A Hub object every byte crosses, single threaded |
| Backpressure | Per socket (`pipe.ts:65,93`) | Must be rebuilt |
| Kill behaviour | Judged, spike 1 | New |

Choose one relay per stone. Research 02 Q10's reconnect-storm worry is smaller than it looked: nothing dials at boot, since `Connection` is lazy, and a boot's reconcile is ten HTTPS calls at 66 ms.

A relay exists only while its stone is awake and recently used. An open pipe keeps the object active, and so the container (live lifetime page), which is why sleep closes it first. That is also v1's spike 7 rule 2 ("closes the connection before pausing") and the rule in v1's `apps/cloud-sandbox/src/sandbox.ts:34`, never stop under an open connection.

### Process lifetime and what stops orphans

`Stones` holds `Map<StoneId, Connection>`, one `Connection` per awake period.

```ts
new Connection({
  command: async () => {
    await stones.ensureAwake(stoneId); // waits out a sleep, then starts and restores
    return ["node", PIPE, "--credentials", FILE, stoneId];
  },
  onLog,
});
```

| Event | What happens | Evidence |
| --- | --- | --- |
| Brain restarts cleanly | A close hook calls `Connection.close()` on each, relays get SIGTERM and close their sockets, and each daemon dies. Foreground commands end and report as interrupted | `pipe.ts:155-162`; `ShutdownHooks.ts` gets one entry |
| `kill -9` of the brain mid-turn | stdin ends and the relay sends `eof`. systemd then kills the cgroup (`KillMode=mixed`). The socket closes, the object's `closed` kills the daemon. On restart pi-durable reports the call interrupted, or the gated wrapper says "may have run" (ADR 0031) and never reruns. The container stays | Spike `brainkill` case: 1.5 to 1.7 s, on the stock `bash`. Not yet on Cairn's gated `bash` |
| After any restart | A boot repair reads every non-`destroyed` row, calls status, and reconciles: awake but not running is `lost`; `sleeping` finishes or re-reads the object's record; `waking` is redone. No relay starts until a tool needs one | New, ordered after the harness opens, before `startEventReactors` (`BootRepairs.ts:95-120`) |
| Network dies, brain alive | `SILENCE_LIMIT_MS` tears down at 30 s and kills the relay; the next request redials | `connection.js:13,254` |
| Brain gone and network stalled | **Today nothing ends the relay.** Add: on stdin end, exit within 3 s whatever the socket does | The one code change the relay needs |
| Eviction or Worker deploy | Socket closes, the relay exits 255, `Connection` reports lost, and the next request reconnects to the same container | Spike `inflight` and `between` cases. A deploy ends every stone's foreground command, so `ops` refuses to deploy the Worker while a stone is awake unless forced |
| A new pipe while an old one lingers | **Today: 429 at four** (`workspace.ts:119`), so quick restarts can lock a stone out. Production: exactly one pipe, newest wins, older closed | A stale pipe's daemon would die anyway |

Three layers stop orphans: stdin end with a timer, the cgroup, and a judge that counts. There is also a cloud-side orphan, the running container, which section 5's watchdog covers.

### What moves from spike to kept

| Spike | Kept as | Notes |
| --- | --- | --- |
| `src/worker.ts`, `workspace.ts` | `apps/stones/src/` (`worker.ts`, `WorkspaceServer.ts`, `WorkspaceApi.ts`) | A port of intent to S44 to S49: `HttpApi` from the object's `fetch`, not RPC, routes under `/v1`, `getByName(stoneId)`, an `XClient`. S43's `ManagedRuntime` at the class. Drop `computer.ts` and the `/computer` routes. `evict` is present only on non-prod stages. Header naming coil and v1, MIT notice kept |
| `src/pump.ts`, `frame.ts` | `packages/link/src/` | Web-standard types, tested in Node. Shared by the Worker and the relay. v1's `packages/link` is another thing, a JSON protocol for a stone brained in an object: do not port it |
| `src/auth.ts`, `access-jwt.ts` | `apps/stones/src/` | Plain port |
| `relay/pipe.ts` | `packages/link/src/relay.ts`, plain TypeScript, no Effect | Measured: Effect adds 54 MB per relay. A process boundary with no library behind it; S42 does not fit, so one line in the header and in the ADR |
| `stone.ts` | `apps/server/src/stones/StoneControl.ts`, `Stones.ts` | Sandbox SDK use stays in `apps/stones` only (S42) |
| `alchemy.run.ts` | Root stack yields `apps/stones/Stones.ts` (S51, S52, ADR 0006) | Stages per S54; judges use `test_$USER`, never prod |
| `conformance.test.ts`, `judge.ts`, `bench.ts`, `coldstart.ts` | `judges/stone-*` | "Kept code, not spikes" |
| `images/stone`, `stone-image.yml` | Stay | Add `rg`, `fd`, git 2.54 or later. The digest moves to a committed file the stack reads, replacing `STONE_IMAGE` from the environment |
|  | `apps/server/src/stones/` new: `Stones`, `StoneArms` (routed env), `StoneSleep`, `StoneJobs`, `StoneRepair` |  |
|  | `ops/stones/` | Deploy guard, token rotation. Any human step joins one `ops/wizards/phase-3.sh` |

### Secrets

No credential in the repo. Spike 1's `.env` is git-ignored, and production does not need one:

- **Shared secret.** `Alchemy.Random` (`node_modules/alchemy/src/Random.ts:14-31`, persisted in state, redacted), bound to the Worker. Not verified that a `Random` binds like `Config.Redacted` does in the spike.
- **Access service token.** `Cloudflare.Access.ServiceToken` in the stack (`spikes/1-stones/alchemy.run.ts:53`). It has a `duration` and reports `expiresAt` (`ServiceToken.ts:29,67`), and bumping `clientSecretVersion` rotates it (`:165`). An expired token looks like a dead link, so the brain reads `expiresAt`, logs under 30 days and rotates through `ops/stones`.
- **On the Beelink.** `~/.config/cairn/stones-<stage>.json`, 0600, written by the stack's action (`alchemy.run.ts:25-47`), read and checked by the relay (`pipe.ts:21-37`), never an argument. It sits with the other keys under `~/.config/cairn`. A host thread's tools run as the user and can read it (`FolderRules.ts:35-38`), which is the existing trust; a stone cannot.
- **Link state.** Like reach state: unknown, ready, refused (401 or 403), unreachable. Shown so a bad token never reads as a model failure.

## 5. Lifecycle and the dual idle timer

### Facts that shape it

- Disk and memory go with the instance. Nothing is restored unless the application asks (live page).
- The container outlives the object (spike 1), but a restart clears the timeout, and the instance then stops "shortly" after the object goes inactive (live page). Deploys restart every object. How short is unknown: spike A. Until measured, assume minutes.
- `setInactivityTimeout`'s limit is 6 hours, and it counts only object inactivity, with code in the container not counting.
- Foreground commands die with an eviction; `setsid` work does not (spike 1).

### Sleep and wake

The brain decides, because only it knows runs, approvals and people. The check runs every 30 s per awake stone:

```
agent idle = no live run on any conversation with this stone, or the live run is held
             (pending approval, plan limit, parked), and no job lease, and no judge run
human idle = time since the last message, steer, stop or portal request on this stone's threads
sleep when  now >= max(last agent work + 5 min, last human interaction + 20 min)
```

**Keep-awake reasons,** each visible on the row and in the log: a live, unheld run on this stone; a shared child's run on this stone; a job lease; a goal judge run; a capture in progress; a user's explicit keep-awake (time-boxed, `surfaces.md`'s control).

**Not reasons:**

- A dev server alone (Amp's rule, kept).
- A child working on another stone: the parent sleeps and wakes on the note. Amp keeps a parent awake for this. I do not, because a parent that is only waiting does no work, and a wake costs seconds.
- A pending approval, even with the run live: a brief may wait 7 days (`BRIEF_EXPIRY_DAYS`), and that wait must not bill.
- `Presence` (`push/Presence.ts`). A tab left open must not keep a stone awake. Only interaction counts; decision 5.

Opening a thread does not wake its stone. Its transcript and diffs are at home.

**Sleep:**

1. Refuse new work under the per-stone lock, and wait for the run-end capture to settle.
2. Close the `Connection`.
3. `POST /v1/stones/<id>/sleep { sleepId }`: the object runs the capture (`bases.md`), records it in its storage, destroys the container and clears its alarm, idempotent by `sleepId`.
4. The row goes `asleep` with the record.

A kill between any two is reconciled from the object's storage at boot. A failed capture leaves the stone awake and retries; three failures and it sleeps on the floor (below), with a notice.

**Wake,** in `ensureAwake`, under the same lock, so a tool call arriving mid-sleep waits and then wakes:

1. Budget check.
2. `POST /start { restore, generation }`.
3. Run `.agents/resume` (`bases.md`'s).
4. Row `awake`, new `Connection`.

The run's start triggers it eagerly so the first tool call is not the one that waits. Lazily, the `command` function does it. A failed wake is a tool error the model reads, and the next call tries again.

### The object's last resort

A `setAlarm` every 60 s while the container runs, stored, so it survives restarts and deploys:

- The constructor re-arms `setInactivityTimeout` (`workspace.ts:83`), and the alarm is what runs the constructor when no request comes. This closes the gap the live page describes.
- **Watchdog.** No pipe and no control call for 30 minutes: the object captures and destroys by itself, and records it. The brain finds that at its next boot. A Beelink outage therefore costs at most 30 minutes per stone, about $0.03, and loses no work.
- `setInactivityTimeout` at 45 minutes stays as the platform's floor if the alarm itself fails. Live page: a timeout's window starts only after the object leaves memory, so frequent alarms may keep it from ever firing, and the watchdog is the real stop.
- No `container.monitor()`: pending I/O bills the object for up to 15 minutes each.

### What survives

|  | Sleep (capture, destroy) | Eviction, deploy | Brain restart | Container lost (platform) |
| --- | --- | --- | --- | --- |
| Transcript, approvals, stamps, Claude session | Yes, home | Yes | Yes | Yes |
| Tracked and untracked files | Yes (capture) | Yes, still running | Yes | Up to the last run's end, from the home checkpoint |
| Ignored files (`node_modules`, build output, `.env`) | Yes (capture) | Yes | Yes | Last capture, or the base; `.agents/resume` and the model rebuild |
| Foreground command | Not running by rule | Ends, reported lost | Ends, reported interrupted | Ends, reported lost |
| Jobs (`setsid`) | Never asleep while one runs | Yes | Yes; the watcher reattaches | Lost, and told so |
| Dev servers, shells, all memory | **No** | Yes | Yes | No |

**Uncommitted files, stated plainly.** A sleeping stone's uncommitted files are safe twice: the disk capture holds every file, ignored ones included, and the home checkpoint holds every tracked and untracked file as of the last run's end. A platform loss mid-run loses that run's work since the previous checkpoint, and the model is told. If spike F shows losses are not rare, add a checkpoint every few minutes during a run.

**Requirement on `bases.md`, not a design:** a sleep capture of `/cairn/workspace` that holds tracked, untracked and ignored files; is callable from the object with no brain present; has a record the brain can store; restores on the same image digest; and has p95 wake at most 10 s on a Cairn-sized tree. It also needs a way to seed "prepared base plus a commit from home" for a lost stone and a writer child. Which mechanism is its call. Snapshots (public beta, tied to the image version, 30 days, no published price) carry a real idle-cost risk; R2's price is known.

### What the model and the user see

**The model.** The `cairn` section says this is a stone: a container at `/workspace`, read-only reference paths at home, processes end when it sleeps, commands over about 2 minutes go through `job_start`. Sleep itself is invisible to a run, which keeps a stone awake. After a wake, one `cairn.stone-woke` note (a model-visible `write`, placed at the next boundary): "Your stone slept and woke; files are as you left them; processes are not running." After a loss, the note names the checkpoint restored and what is gone. A failed wake is a tool error with the reason.

**The user** (`surfaces.md` draws it). `ThreadStone.state` on the row, `WaitingFor: stone` while a turn waits on a wake, a Notice in the transcript on a loss, and the composer always works. A message to a sleeping stone wakes it.

**Archive and delete.** Archive sleeps immediately. Delete destroys the container and its capture. A capture past its retention leaves the floor only (decision 8).

### Jobs: background long work

Three tools in `cairn.stones`, gated like `bash`, working on any arms (a host thread too), so the installed set stays fixed:

- `job_start { name, command }`: `mkdir /cairn/jobs/<taskId>` as the atomic claim (a rerun after a kill finds the folder, starts nothing, and reports the existing job), then `setsid nohup sh -c '...; echo $? > exit' > log 2>&1 &`. `taskId` is pi-durable's, stable across reruns. `replay: "safe"`.
- `job_status { name, tail }`: running or exit code, and the log's tail.
- `job_stop { name }`: signals the process group.

A background `cairn.stone-job-watch` task, created in the tool's commit, polls every 30 s through env (no keep-alive needs its own request), holds the lease, and on exit writes a note and a wake (ADR 0028's vocabulary). After a restart it resumes as any task. A job's maximum runtime is the budget's concern.

## 6. Idle cost and running cost

Live pages read 2026-11-04. Each page's own date: Containers pricing 2026-10-05, limits 2026-11-02, Durable Objects 2026-10-18, Workers 2026-10-02, R2 2026-10-30, lifetime 2026-10-22, scheduling policy 2026-11-04 (the `durable_object` policy is still public beta and has no `max_instances`), snapshots 2026-09-30.

Rates: memory $0.0000025 per GiB-s (25 GiB-h included a month), CPU $0.000020 per vCPU-s on active use (375 vCPU-min included), disk $0.00000007 per GB-s (200 GB-h included). Billed per 10 ms. Prices below ignore the allowance, which is small: 25 GiB-h is about 4 hours of `standard-2`.

| Instance | vCPU / RAM / disk | Idle $/h (memory + disk) | Flat out $/h | Typical hour, 360 vCPU-s |
| --- | --- | --- | --- | --- |
| basic | 1/4, 1 GiB, 4 GB | 0.0100 | 0.0280 | 0.0172 |
| standard-1 | 1/2, 4 GiB, 8 GB | 0.0380 | 0.0740 | 0.0452 |
| **standard-2** | **1, 6 GiB, 12 GB** | **0.0570** | **0.1290** | **0.0642** |
| standard-3 | 2, 8 GiB, 16 GB | 0.0760 | 0.2200 | 0.0832 |
| standard-4 | 4, 12 GiB, 20 GB | 0.1130 | 0.4010 | 0.1202 |

The object: 450 GB-s per stone-hour at 128 MB, with 400,000 included (889 stone-hours a month), then $0.0056 an hour. Requests: the pipe's pings (720 an hour at 20:1) and the alarm (60 an hour) are about 96 of the included million. Effectively free.

**Recommendation: `standard-2` as the default,** per project with a per-stone override.

- `standard-1`'s 8 GB disk does not hold a big repository: v1's t3code base was 8.2 GiB apparent (v1 spike 8), and Cairn's own `node_modules` is 2.7 GB.
- Half a vCPU makes a verifier slow, and CPU-bound work is not cheaper on a small instance, since memory bills on wall clock. A 600 vCPU-s build, assuming it scales, costs $0.0247 and 20 minutes on `standard-1`, $0.0215 and 10 on `standard-2`, $0.0183 and 5 on `standard-3`.
- The extra $0.019 an hour is well under any model's spend.
- Spike B checks this with real builds before it is frozen. Only `standard-1` has ever run; the spike's size goes to `start()` (`workspace.ts:95`).

Fan-out and sessions at `standard-2`, typical load:

| Case | Cost |
| --- | --- |
| Ten stones, one hour | $0.64, or $1.29 flat out |
| Human tail after a session (20 min) | $0.019 |
| Node tail after settling (5 min) | $0.005 |
| Research 02's envelope, 450 instance-hours a month | $28.18 + $5 = $33.18 (memory is $24.08 of it) |
| One stone forgotten awake for a month | $41.61 |
| Amp's comparison | `a1.small` (2 CPU, 4 GB) $0.17/h; Cloudflare is cheaper per hour, with no memory retained |

**Idle target, under $6 a month with no stones.**

| Item | Monthly |
| --- | --- |
| Workers Paid minimum | $5.00 |
| Containers with none running | $0 ("a stopped instance is not billed") |
| Object duration and requests with none awake | $0: no alarm runs while nothing is awake |
| Object SQLite | 5 GB-month included |
| Workers requests, logs | Well within 10 million and 20 million. Logs move to Observability pricing on 2026-12-01; re-read then |
| R2 (bases, captures) | 10 GB free, then $0.015 a GB. The $1 left buys 66 GB more |
| Snapshots, registry images | **No published price on the pages I read.** 50 GB image limit |
| Total | **$5.00 plus storage: the target holds,** provided captures are retained on a schedule and nothing leaks |

Two honest risks. Snapshot storage has no price, so if `bases.md` chooses snapshots the target cannot be proved until a bill shows it. And the target says nothing of a stone asleep beyond storage, which is the point of sleeping it. I did not check whether this account's $5 also covers other work.

## 7. Judges

### What exists

No judge touches a stone: `grep -l stone judges/` finds only UI text. These become relevant.

| Judge | Measures | For phase 3 |
| --- | --- | --- |
| `apps/server/src/smoke.test.ts` | `registerEnvConformance` on local env | Same suite, deployed |
| `apps/server/src/brain/conformance/` | Harness seam scenarios | Stone scenarios on fake arms |
| `judges/durability.ts`, `claude-kill.sh` | `kill -9` windows, on faux and the bridge | Need a stone mode |
| `judges/subagent-durability.ts`, `workflow-kill.sh` | Delivery and node matrices | Rerun on fake arms, once live |
| `judges/relay-orphans.sh` | Stdio relay orphans (ADR 0014), a different relay | Pattern for the link's |
| `judges/shutdown.sh`, `reconnect.ts` | Clean stop, client convergence | Rerun with stones awake |
| `judges/tools.ts` | Executor tools on a deployed brain | `--stone`, for the tools target |
| `judges/pi-host.ts`, `pi-readonly.sh` | Pi host; agent dir untouched | Rerun; host roots must not write |
| `judges/reach-restart.sh` | Portals through a kill | `surfaces.md` |
| `spikes/1-stones/{conformance.test,judge,bench,coldstart}.ts` | Spike's measures | Port as kept judges |

### What phase 3 needs in this area

Costs are at `standard-2`, on the `test_$USER` stage.

| Judge | Measures | Broken control | Rough cost |
| --- | --- | --- | --- |
| `judges/stone-conformance.ts` | `registerEnvConformance` over the real relay and routed env, 29 cases; exec p50 at most 150 ms; the Access matrix (spike's four refusals) | A routed env whose `writeFile` silently drops bytes fails the suite | Under $0.01 |
| `apps/server/src/stones/FakeStone.test.ts`, in `pnpm check` | A whole stone thread on fake arms (path-mapped env at a temp folder, `/workspace` nowhere on disk): turn, tool, checkpoint, diff, skills, context, subagent. The home repository's refs, HEAD and status are byte-identical after; `project_context` and skills are present | `workspaceOf` without its stone branch fails by a new ref in the home repository | Free |
| A new probe in `judges/lint-boundaries.test.ts` | `agent.cwd` read outside `Arms.placeOf` is refused | The probe file itself | Free |
| `judges/stone-routes.test.ts`, in `pnpm check` | Host roots read; writes refused; `~/.pi/agent/auth.json` through a symlink refused, nothing printed | A prefix check without canonicalizing lets the symlink through | Free |
| `judges/stone-image.ts` | On a live stone: `rg`, `fd` run; a commit carries `Cairn-Thread`; `env` shows no Beelink `HOME`, `PATH` or a planted canary | Today's image fails by the missing trailer; today's `prepare` fails on the canary | Under $0.01 |
| `judges/stone-kill.sh` | Real judge brain, faux model: `kill -9` and evict in foreground `bash`, between `mkdir` and spawn of a job, during wake, during sleep's capture, during the checkpoint bundle, and a Worker deploy mid-run. Each: one start mark, "may have run" or interrupted, no rerun, no relay left, client converged within 2 s | A job without its atomic claim starts twice; a `bash` without its effect mark reruns | About $0.03 |
| `judges/stone-kill.sh --bridge` | The same windows that matter on Haiku: same session across restart, sleep and wake, cache read at least 10 times write, tool ran once | A bridge folder derived per wake forces `cwd-changed` and fails on cache | About $0.03, plus plan use |
| `judges/link-orphans.sh` | Ten relays against the deployed stage and a stalled local acceptor: gone within 5 s of `kill -9` and SIGTERM; pipes at 0 within 30 s; ten quick restarts never meet a 429 | The spike's relay stays alive against the stalled acceptor | About $0.01 |
| `judges/stone-idle.ts`, plus a scripted-clock unit test of every reason | Shortened timers, live: sleeps at the later of both timers; each keep-awake reason holds it; an open tab does not; nothing billable left after | A relay held open past sleep keeps the container running, which it must catch | About $0.02 |
| `judges/stone-sleep.ts` | A tracked edit, an untracked file, an ignored file and a deletion survive sleep and wake byte-identical; a process does not; the note is placed; a `destroy` with no capture restores the home checkpoint and says so; the watchdog stops a stone with the brain stopped | Sleep with the capture skipped fails on the ignored file | About $0.05 |
| `judges/stone-start.ts` (with `bases.md`) | First tool call under 5 s from a prepared base, 20 runs, in a real thread; wake p95 | A cold image start is reported over target | About $0.02 |
| `judges/stone-load.ts` | Ten stones on Haiku on the deployed unit: `memory.events` `high` count unchanged, peak, relay count, slot wait share, tool p95 against one stone | The current `MemoryHigh` raises `high` events | About $0.15, plus plan use |
| `judges/stone-idle-cost.ts` | Monthly floor: zero running containers (Cloudflare analytics), R2 bytes, snapshot count, computed bill under $6. Runs from the nightly unit | A fixture with one running container fails | Free |
| `judges/tools.ts --stone` | Every MCP server answers from a stone | Existing rule, a call from outside a script | Cents |

The kickoff's fan-out judge is `surfaces.md`'s and `results.md`'s; `stone-load` feeds it.

## Needs from sibling notes

- **`bases.md`:** `Bases.ready(project, baseRef, instance)`, safe to resume; the capture requirement above; seeding from a home commit, with the base commit present at home; a key that includes instance size, as Amp's does per size; `.agents/resume` run by `ensureAwake`; run-time egress follows its decision (see decision 4).
- **`results.md`:** one bundle path for run-end checkpoints and results, with whichever of the link or R2 fits a small transfer every run. Fills the settlement's `branch` and `commit` for a stone. Knows that branch commits and checkpoints are already home after each run, which may simplify its bundle.
- **`surfaces.md`:** the `stone` verb and `ARMS` in the launch envelope; `MAX_CONCURRENT_NODES` of at least 10 for a stone workflow; a portal request calls `Stones.touch` and wakes; drawing `ThreadStone.state` and `WaitingFor: stone`; reading `stone_intervals` for compute spend, where memory and disk are exact and CPU is estimated unless analytics say otherwise; the keep-awake control; a budget that refuses a wake.

## (a) Recommended design

1. **Representation:** `cairn.arms` (identity), `stones` table (lifecycle), `ThreadShell.stone`, lineage `stone`, `Arms.placeOf` as sole reader of a thread's place. Readers share a stone; writers get a new one.
2. **Tools:** code at home, effects through `api.env`. A routed env serves named host roots read-only. Fix the 20 local-path sites, with `FakeStone` and a lint rule as the fence. Image gains `rg`, `fd`, git 2.54 or later.
3. **Bridge:** a stable empty `<data>/stones/<stoneId>` per stone. Resume untouched. Raise `MemoryHigh` to 6G, wire `bridgeGenerationCap` into `slotsFor`, keep 4 permits until spike C.
4. **Link:** one plain relay per awake stone, exit within 3 s of stdin end, newest pipe wins, lazy dial, boot reconcile over HTTPS, `~/.config/cairn/stones-<stage>.json` written by the stack, `Alchemy.Random` for the secret, link state shown. `apps/stones`, `packages/link`, `ops/stones`, root stack.
5. **Lifecycle:** the brain sleeps at the later of 5 and 20 minutes, counting interaction and never presence. A 60 s alarm plus a 30 minute watchdog in the object. Run-end checkpoints home as the floor, disk capture as the ceiling. Durable jobs for long work.
6. **Cost:** `standard-2` by default. Idle floor $5.00 plus storage.
7. **Judges:** as in section 7, the first three in `pnpm check` before any Cloudflare work.

## (b) Proposed ADRs

- **A stone's arms are named by a `cairn.arms` document.** Absent means host; `Arms.placeOf` is the only reader of a thread's place, and `worktreePath` stays none on a stone.
- **One relay process and one socket per awake stone.** pi-env's `Connection` spawns a process, a relay costs 43 MB, so no mux and no Hub object; the relay stays plain TypeScript, outside S42.
- **The brain decides sleep; the object is the last resort.** Later of 5 minutes agent idle and 20 minutes human idle, with a 60 second alarm and a 30 minute watchdog in the `Workspace` object.
- **Every run's end comes home.** A stone's checkpoint refs are captured on the stone and bundled home, so a lost container loses at most the current run, and diffs run at home.
- **Host roots are read-only and named.** Skills, the clone shelf and attachments are served by a routed env with canonical paths; never the agent dir, and never to `bash`.
- **A stone's Claude child runs in a stable empty folder at home.** Derived from the stone, so stamps and resume are unchanged (amends ADR 0017's "children run in the thread's real folder").
- **Long work on a stone is a durable job.** Claimed atomically by task id, started with `setsid`, watched by a background task that holds a keep-awake lease.
- **Readers share a stone; writers get their own.** A worktree inside a stone is refused (departs from research 06).
- **Stones default to `standard-2`** (`status: proposed`, gate: spike B).

## (c) User decisions

1. **Default instance.** Recommend `standard-2`, per-project override: $0.064 against $0.045 a typical hour, with 12 GB of disk and twice the CPU.
2. **What a stone launched from the hero is,** given that a launch in a folder project makes or refreshes the project thread today. Recommend a managed child of the project thread when there is one, so a stone never replaces it, with the user's own message as its consent. This touches the coordinator rethink, so the call may move there; this note needs only the answer.
3. **Claude permits at fan-out.** Recommend wiring the setting, keeping 4 as default and raising it per spike C's number, because it trades plan window for wall clock, and only you know what the window is for.
4. **Run-time egress.** `bases.md` covers setup; nobody owns it while a stone runs. Recommend open HTTPS on ports 80 and 443 with no credentials inside, as Amp does, and an allowlist later. Risk accepted: injected content could send repo code out. The stricter choice costs `npm install` in a stone.
5. **What counts as human.** Recommend interaction only, so an open tab does not bill. And opening a thread does not wake its stone, like Amp's Orb Saver mode made the default.
6. **Writer subagents on a stone.** Recommend a new stone rather than a worktree in the same one.
7. **Limits accepted at first:** a skill's scripts and uploaded files are readable by `read`, not by `bash`, on a stone. Recommend accepting; if a real skill needs it, copy that skill's folder in on demand.
8. **Retention of a sleeping stone's capture.** Recommend until archive, and at most 30 days (snapshots' limit either way), after which it wakes from base plus home checkpoint and says so.
9. **Raising `MemoryHigh` to 6G on `cairn.service`.** Recommend yes; it stays soft, with no `MemoryMax`.

## (d) Spikes needed before deciding

| Spike | What it decides | Gate | Rough cost |
| --- | --- | --- | --- |
| **A. Restart with no request** | The alarm's interval | `ctx.abort()`, then no request for 1, 2, 5 and 10 minutes, with and without a pending alarm: the container must still run at the end with an alarm at the chosen interval, same boot id | $0.05 |
| **B. Instance size** | Default instance (decision 1) | `pnpm install` and `pnpm check` of Cairn, and a t3code-sized install, on `standard-1`, `-2`, `-3`: the default is the smallest that fits on disk and finishes `pnpm check` within 2 times the best | $0.30 |
| **C. Ten at home** | `MemoryHigh`, permits, code mode workers | Ten Haiku stones on real work: no `high` events at the new line, generation share g measured, and stones' p50 turn time within 1.5 times one stone's at the chosen permit count | $0.15 plus plan use |
| **D. Preset's wrong folder** | The section's text, or a change of plan | Haiku, Sonnet and Opus, ten turns each on a stone: no tool call names the home folder, and cache read at least 10 times write | Plan use |
| **E. Run-end bundle** | Link or R2 for checkpoints (with `results.md`) | A bundle at 1 MB and 100 MB through env: capture plus bundle plus fetch p95 at most 2 s at the typical size | $0.02 |
| **F. Soak** | Whether to checkpoint during a run | 24 hours of a stone under the alarm, counting evictions and container losses. No loss: run-end only. Any loss: every 5 minutes during a run | $1.40 |

Capture and restore times are `bases.md`'s spike; its result gates the wake target here.

## (e) Packages for the plan

| Package | What | Depends on | Judge |
| --- | --- | --- | --- |
| **A1 Arms seam** | `cairn.arms`, `Arms.env` branch, `Arms.placeOf`, `stones` table, `ThreadShell.stone`, lineage `stone`, fake arms | none | `FakeStone`, seam conformance |
| **A2 Local-path audit** | Section 2's fixes: bash and search env, section, skills, context, pi host refusal, recipes, artifacts pull, checkpoint gate, lint rule | A1 | `FakeStone` with its control, lint probe |
| **A3 Routed env** | Host roots | A1 | `stone-routes` |
| **A4 Image** | `rg`, `fd`, git 2.54 or later, digest in a committed file | none | `stone-image` |
| **A5 Worker and link** | `apps/stones`, `packages/link`, root stack, Access, secrets, stages, relay changes, newest pipe wins | A4 | `stone-conformance`, Access matrix |
| **A6 Live arms** | `Stones` with lazy `Connection`, `StoneControl`, close hook, boot reconcile, link state | A1, A5 | `link-orphans`, `stone-kill` (bash windows) |
| **A7 Bridge on a stone** | `bridgeDir`, section text, `MemoryHigh`, cap wiring | A2, A6, spike D | `stone-kill --bridge` |
| **A8 Checkpoints** | Capture over env, bundle home, repair | A2, A6, spike E, `results.md` | `FakeStone` diffs; `stone-kill` (bundle window) |
| **A9 Creation** | Launch `Stone` strategy, `isolation: stone`, shared child arms, writer rule | A6, `bases.md` `Bases.ready`, decisions 2 and 6 | Seam scenarios, `subagent-durability`, `brief-go` on fake and live |
| **A10 Lifecycle** | Sleep, wake, dual timer, keep-awake reasons, alarm, watchdog, notes | A6, A8, spike A, `bases.md` capture | `stone-idle`, `stone-sleep`, `stone-kill` (wake and capture windows) |
| **A11 Jobs** | `job_*`, watcher, lease | A6 (A10 for the lease) | `stone-kill` (job windows) |
| **A12 Capacity** | Permits, caps with `surfaces.md`, `stone-load` | A7, A9, spike C | `stone-load` |
| **A13 Idle watch** | Nightly floor check, deploy guard | A10 | `stone-idle-cost` |
| **A14 Tools target** | Run every MCP server from a stone | A9 | `tools.ts --stone` |

A1 to A3 need no Cloudflare and belong first, because they fence every later package. Spikes A and B run as soon as A5 deploys.

## Not verified

- **Nothing ran on Cloudflare.** Spike 1's numbers are from 2026-10-21 and 22. `standard-2`, the alarm's interplay with the inactivity timeout, an eviction with no following request, and `Alchemy.Random` as a Worker binding are all unrun.
- **`@cloudflare/sandbox`:** `spikes/1-stones/node_modules` is absent. I read 1.0.0 from v1's install and the clone at `f9e972a1`, not the pinned 1.0.2.
- **Live pages** came through a summarizing fetch, so wording marked as a quotation is the tool's report of the page. Access's free tier was not re-read (research 02).
- **Inferred, not run:** the first Claude turn on a stone failing at `/workspace`; bookworm's git being older than 2.54; home-fallback checkpoints landing in the home checkout (from reading the code); `fd-find`'s binary name; `setsid` work surviving a clean `Connection.close()` as it survived an eviction (spike 1 tested only the latter; `stone-kill` covers it); systemd's kill of the relay on `kill -9` (from `KillMode=mixed` and the children's measured exits, not judged for relays).
- **Measured only locally:** relay memory over loopback, no TLS.
- **Unmeasured:** generation share g; wake time, which depends on `bases.md`; the rate of platform container loss; Beelink CPU at ten stones (16 threads and children idle in tools, so I do not expect a limit).
- **Not checked:** whether `standard-2` CPU reports and bills as the table says (spike 1 saw 1 CPU on `standard-1`, with half a vCPU listed); how Cloudflare analytics expose per-instance CPU for spend.
