# Phase 3 notes: surfaces (how the user and a workflow reach stones)

Written 2026-11-04 for the phase 3 planner. Scope: the workflow verb, a single stone with no workflow, the sidebar, header, work panel and transcript of a stone, portals, spend, the project's settings, and the judges for all of it. Arms, bases and results belong to the sibling notes `arms.md`, `bases.md` and `results.md`; this note says what it needs from them and designs none of it. The project thread coordinator (scrapped ADR 0042) is not assumed. Cairn is read at `a160935`; line numbers are at that commit. porchlight is read at `5334351`. Nothing was deployed, spent or changed; the only live reads were `dig`, the Caddyfile by `grep`, and the absence of porch.

## Summary

1. **`stone(prompt, opts)` in the prelude, over the one `agent` node tool.** The kickoff names the verb (decision 3), and a stone node differs from a host node at one branch in `startChild`, so it needs no second tool. `agent({ arms })` stays refused as an unknown option. Prelude version 4.
2. **The envelope already has the field; nothing fills it.** `arms` exists on `EnvelopeModel`, `CallSite` and `NodeRecord`, but `WorkflowPlan.ts:225` fixes it to `host`, `WorkflowTools.ts:489` writes `host`, and `WorkflowLaunch.ts:200` grants only `host`. A stone node today would raise a card every time.
3. **Workflow writers have no worktree today.** The task assumed one. A host node runs in the launching thread's cwd (`WorkflowTools.ts:449`, `:1938`) under a brief that says `workspace: "shared"` (`WorkflowLaunch.ts:298`), and `readonly` limits no tool (`SubagentTools.ts:986` ignores it). A stone is the first isolated writer a workflow has.
4. **"Run on 1 first" does not limit `parallel()`.** Only `pipeline` reads `SAMPLE` (`Prelude.ts:325`), yet the card offers the button for any launch over one node (`BriefGo.ts:148`). A ten-stone fan-out written with `parallel` would start all ten. The dry run already takes a `sample` (`WorkflowPlanTool.ts:304` passes none), so a second dry run can put the sampled count on the card.
5. **A queued node has no row today.** It takes its slot before its reserve (`WorkflowTools.ts:2084-2093`), and slots are 8 per workflow (`Workflows.ts:35`), which already fails "ten in parallel". Stones need their row first and a brain-wide cap of their own.
6. **The hero is the wrong door for a stone.** A hero launch makes or refreshes the project thread (`Launch.ts:84-91`), so "Stone" there would put the long-lived thread on a container. A single stone comes from a "New stone" button in the sidebar's managed list, which opens the same hero composer with the workspace control set to Stone. It is a managed thread under the project thread, and the user's Send is its Go.
7. **Reach is shelved, and "stone portals fit without redesign" is only true of the row.** The owner guard's regex does not match `<port>-<stone>-pv` (`reach-edits.ts:172`), porch has no `imports` or header setting, a service porch reloads Caddy per open, and four things in `Portals.ts` and its migration assume a unit and one port space. A fixed Caddy handle with its own guard needs no porch, no reload and no DNS change, and is the recommendation.
8. **Compute is an estimate Cairn computes itself, labelled as a ceiling.** Cloudflare has no per-stone bill. `containersUsageAdaptiveGroups` (GraphQL) is the closest per-instance reading and matches the dashboard's estimates; the billing usage endpoints are alpha, by service and day. Compute counts toward the hard dollar limit.
9. **Three new things on the launch card, none on a host-only launch.** Stones and how many at once, compute with its rate, the base's state. A launch with no stones draws exactly as now, so round 10's `launch-approval` shot holds.
10. **The phone's header shows no status** (`Header.ts:93`, `:110` hide role and status under `sm`). On a phone the composer's locked strip is where a stone says what it is and how it stands.
11. **Keep the diff panel off.** No phase 3 target needs line diffs, and the panel is what broke on the phone. The changed-files card already works from a transcript entry, so it needs no wake if the entry keeps its shape.
12. **Day-one settings are ship mode and base status with setup status.** Secret names follow what `bases.md` needs; egress is one read-only line.

## 1. The workflow verb

### What the code does today, from `workflow_plan` to node start

| Step | Where | What it assumes |
| --- | --- | --- |
| The model calls `workflow_plan` | `WorkflowPlanTool.ts:364`, `callers: ["model"]` `:402`; `propose` `:250` | Budget only from `max_tokens` and `max_usd` (`budgetFrom` `:117-125`), else no limit |
| Dry run with stub nodes | `plan.dryRun` `:301`, `sample` none `:304`; `Recorder` `WorkflowPlan.ts:398`, its tools `:641` | The stub answers with a schema placeholder |
| The prelude builds the call | `__cairnAgentFull` `Prelude.ts:250`; `AgentCall` `:94-118`; options `AGENT_OPTIONS` `:70-79` | No arms field; `readonly` is `o.readonly === true` `:264` |
| Recording | `RecordedNode` `WorkflowPlan.ts:367-374`, `siteKey` `:377` | No arms in the record or the key |
| Call sites | `callSitesOf` `:749`, `arms: ARMS` `:789`, `const ARMS: NodeArms = "host"` `:225` | Always host |
| Estimate | `estimateRun` `:856`, `NodeHistory` `:154` | Tokens and list dollars only; `WorkflowEstimate` `Policy.ts:353` has no compute |
| Envelope | `toLaunch` `:936`; key `${spec} | ${readonly}` `:941`; `arms: ARMS` `:971`; `maxConcurrent: MAX_CONCURRENT_NODES` `:970` | One concurrency for every node |
| Launch approval | row, record and event in one commit `WorkflowPlanTool.ts:327-358`; `awaitSettlement` `:411`; `launchAnswered` `WorkflowLaunch.ts:119` |  |
| Run | the model calls `codemode` with the same script; the gate rewrites it (`WorkflowGate.ts:1-12`, `rewriteScript` `Prelude.ts:423`); `workflow_begin` `WorkflowTools.ts:1252` | Prelude version pinned, `RUNNABLE_PRELUDE_VERSIONS` `Prelude.ts:42` |
| Node | `agent` tool `WorkflowTools.ts:2099`; `runNode` `:2066` takes a slot `:2084-2090`, in memory `:966`; `runHeld` `:1980`; `reserve` `:1398` | The slot comes before any ledger row |
| Admission | meter `:1440-1453`; `briefWithin` `WorkflowLaunch.ts:184`, `entry.arms === "host"` `:200`; `NodeAsk` `:149` has no arms | A stone grant could never fit |
| Node's brief | `nodeRecordOf` `WorkflowTools.ts:572`, `nodeBriefPayload` `WorkflowLaunch.ts:268`: `workspace: "shared"` `:298`, `base: null`, `writes: []`, `mayCommit: !readonly` `:306` | Shared checkout, always |
| Child | `startChild` `WorkflowTools.ts:1309`; `childAgentOf` `:609` sets `cwd` from the launching conversation `:1938`; `nodeChildTools` removes the delegating tools; `linkChild` `:631`; row `arms: "host"` `:489` | The child's env comes from `Arms.env` over `target.cwd` (`Arms.ts:44-50`) |
| Meter | `startMeter` `:1035` watches `UsageDoc` and one minutes timer | Spend moves only when `pi.usage` moves |

### Every place that assumes host arms

- **Protocol.** `NodeArms` is `host` or `stone` (`Policy.ts:301`), carried by `EnvelopeModel` `:313`, `CallSite` `:345`, `NodeRecord` `Workflows.ts:163`. `BriefWorkspace` is only `worktree` or `shared` (`Policy.ts:251`). `RelationshipToParent` is only `subagent` (`Subagents.ts:60`). `WorkspaceStrategy` has three host forms (`Launch.ts:64`).
- **Plan.** `WorkflowPlan.ts:225`, `:789`, `:971`; the keys at `:377` and `:941` would merge a host and a stone site on one model.
- **Envelope.** `WorkflowLaunch.ts:200` and `NodeAsk` `:149`.
- **Node.** `WorkflowTools.ts:449`, `:489`, `:609-624`, `:1938`; `ReserveInput` has a cwd and no arms.
- **`readonly`.** Recorded and used to choose between grants (`WorkflowLaunch.ts:214`) and to set `mayCommit`; no tool is removed for it. Nothing to port for a stone, and worth knowing: "reads only" on a launch card is a promise the model keeps, not a limit.
- **The worktree for writers.** There is none in a workflow. A subagent gets one only from `isolation: "worktree"` (`Briefs.ts:87`).
- **Arms.** `Arms.ts:3-4` already says stones will read a `cairn.arms` document here.
- **Rows and words.** `SubagentRows.ts:258` writes `relationshipToParent: "subagent"`; `Derived.ts:214`, `:222` say "subagent ·"; `SubagentSteps.ts:165-167` says "Started, in a worktree" or "in the project's checkout"; `ContextStrip.ts:163` and `hero/ContextStrip.ts` say "Worktree" or "Local checkout".
- **Spend.** `WorkflowSpent` `Workflows.ts:188`, `NodeReceipt` `:115` and `SpendSummary` `Spend.ts:87` have no compute. `Spend.compute` exists (`Spend.ts:66`) and is always none (`SpendLedger.ts:497`).
- **Checkpoints.** `git/CheckpointCapture.ts` and `git/Diffs.ts` run local git in the thread's folder.
- **Portals.** Section 4.

### Decision

`stone(prompt, opts)` beside `agent`, with `stone.full` beside `agent.full`. Its options are `label`, `phase`, `model`, `schema`, `key`, `effort`, `readonly` and `base` (a ref; default the launching thread's HEAD). `resume` is refused in the dry run on day one, because a fork of a conversation does not fork a container. Reasons over `agent({ arms: "stone" })`:

- The kickoff's API list and the glossary's Workflow both name it, and a script reads as what it costs: every `stone(` is a container.
- A flag invites the combinations `stone` refuses (`resume`).
- It stays one node tool: the prelude's `stone` calls `tools.agent` with `arms: "stone"`, so reserve, admit, settle, watch, stop, hold and meter are unchanged. No new entry in `NODE_TOOLS`.

Prelude version 4; `RUNNABLE_PRELUDE_VERSIONS` keeps 2 and 3, and `AgentCall.arms` is `OptionFromOptionalNullOr`, so an older script's calls read as `host`. `Recorder` records arms and `siteKey` and the envelope key include it, so one model may appear once as host and once as stone. `briefWithin` takes the node's arms: a stone where the launch showed a host node is outside the envelope and raises its own card, as a wider mode does.

`start_unknown` in `docs/golden/thread-states.md:99` names stones. If `Workspace` start is idempotent by name, as S1's `getByName` suggests, a stone node never reaches it, and the row should say integrate only. Needs `arms.md` to confirm.

### The launch card

Added after "Nodes", only when a call site has `arms: "stone"` (`LaunchCard.ts`, `launchNumbers`):

| Line | Reads | Unknown reads |
| --- | --- | --- |
| Stones | "10, up to 10 at once; the rest queue" or "At least 12" |  |
| Compute | "$0.10 to $0.37 at Cloudflare list price, before included usage (standard-1, 15 to 30 min each)" | "Compute unknown: no stone has settled on this project. $0.074 an hour per stone while awake." The rate is always known; a duration is not. Never $0.00 |
| Base | "Ready at abc1234" / "Stale: lockfile changed, about 4 min to prepare" / "None yet" | from `bases.md` |
| Run on 1 first | "2 nodes, 1 stone" from a second dry run with `sample: some(1)` | When the sampled run reaches as many nodes as the full one, the button is not offered and the line says "This script does not use pipeline(), so it cannot run on 1 item" |

A call site's detail gains the word: "Build · opencode-go/gpt-6-luna at high · stone · writes · up to 10" (`callSiteRows`). Go also blocks while stones cannot start (no Worker, link refused), through a `stones.check` next to `models.check`, in the card's existing block bar (`BriefGo.ts:153`).

The compute estimate is node count times the spread of past stones' awake seconds on this project (the same quartiles as `estimateRun`), at the idle rate for the low end and the full rate for the high end. Phase 2's token estimate ran about 5 times low on its one real run (`waves.md:782`), so the card keeps saying "estimate", and the after-figure sits beside it (section 5).

### A cap, and queueing with an ETA

- **Cap.** One brain-wide count of awake stones, a server setting, default 10, hard ceiling 32 (`Policy.ts:327`). Sleeping stones hold no slot. `MAX_CONCURRENT_NODES` stays 8 for host nodes. Cloudflare's limit is not the constraint (6 TiB of memory concurrent, about 1,500 standard-1).
- **Queue, never fail.** A stone node reserves its row and creates its child first, so its thread row exists and reads Queued; the container start then waits for a slot. `MAX_LIVE_CHILDREN` (8) and `MAX_LIVE_CHILDREN_PER_BRAIN` (32) refuse a spawn at their caps (`SubagentTools.ts:401-407`); a workflow node is not in that count, and a spawned stone past the cap keeps today's refusal, since the model can act on it.
- **ETA.** Position, and a time only with at least three settled stones on the project: "Queued · 3rd · about 4 min". Without that, "Queued · 3rd". Order is durable (`queuedAt`), so a restart keeps it, unlike `ScriptSlots` (`WorkflowTools.ts:966`).
- **Claude slots.** Ten stones on the bridge wait for four Claude slots (glossary). A container bills while it waits. Worth a line on the card when the call sites name `claude-bridge`, and a measurement at the gate.

### A stone node's brief

It fits with one added value. `BriefWorkspace` gains `stone`; `nodeBriefPayload` writes `workspace: "stone"`, `base` from the option, `mayCommit: !readonly`. Push and merge stay never (results come home, `results.md`). `task` stays cut to 280 characters when covered (`WorkflowLaunch.ts:265`), and the record is accepted with `decidedBy` envelope in the dispatching commit, so "every ledger row names an accepted brief" holds unchanged. ADR 0032 as amended by ADR 0043 already lists "its arms" (decision 5); this is the code catching up.

### Budgets

Compute counts toward the hard budget. `maxListMicros` binds priced tokens plus compute; the meter's `standingOf` (`WorkflowBudget.ts:383`) reads the sum and `WorkflowSpent` gains `computeMicros`. One dollar limit is ADR 0036's rule ("one dollar budget spans every role"), and compute is small next to tokens at list: ten standard-1 stones for an hour is $0.74 at most. The two figures stay on separate lines everywhere, because tokens on a plan are not a bill and compute may be.

`startMeter` watches `pi.usage`, which does not move while a stone only runs a build, so a stone node adds a 30 s tick while its stone is awake. Overshoot from that tick at ten stones is under one cent.

At the limit, ADR 0036's rule stands: running nodes are aborted and new ones refused `budget_spent` (`WorkflowTools.ts:1451`, `BudgetStopper` `WorkflowBudget.ts:703`), and the script sees `null`. A stopped run does not stop a container, so:

- **A stone's stopper also asks it to sleep, at once,** not after the idle timer. Otherwise a stopped workflow bills for up to 20 minutes more.
- **Work is kept.** A stopped stone's commits and disk stay, per `results.md` and `arms.md`. An accepted Raise does not restart nodes (today's rule); the user opens the stone and messages it.
- **A usage hold sleeps too.** `holdNode` (`WorkflowTools.ts:1648`) can hold a node for hours, up to `MAX_HOLDS` times; the stone should sleep for the hold.

Every stone needs a hard limit (kickoff, "How to work"), and `budgetFrom` and `DEFAULT_BUDGET` give none (`Spend.ts:150`, `Briefs.ts:97`). So a launch with stones and no `max_usd` gets `maxListMicros` of a server setting times its stones (recommended $2 per stone), filled by the brain and editable on the card. A `subagent_spawn` stone and a New stone draft take one stone's worth.

## 2. A single stone with no workflow

### From a model

`isolation: "stone"` on `subagent_spawn`, not a new tool. `isolation` already chooses where a child works (`SubagentTools.ts:297`, `Briefs.ts:87`), and `subagent_send`, `_status`, `_stop`, the anchor, reporter and settlement all apply unchanged. A new tool adds a declaration to every cached prompt for nothing. The brief card's Do, Why and Runs on gain "Runs in a stone", the base and the rate. ADR 0026 is met as it stands: it is a brief, it waits for Go in every mode.

### From the user

Is "Run in" a third option beside project root and worktree? As a value of the same control, yes (`EnvMode`, `hero/ContextStrip.ts:31`, aria-label "Workspace" at `ContextStrip.ts:122`): but not on the hero the user reaches today, because:

- The hero is only reached when a project has no project thread (`Sidebar.ts:235` "Start the project thread", `Update.ts:536`), or through its project picker; Refresh has its own confirm (`Refresh.ts`).
- A launch there makes or refreshes the project thread (`Launch.ts:84-91`, ADR 0026's amendment: new top-level threads come only from a refresh).
- So "Stone" on that hero means a project thread on a container: a long-lived conversation that wakes a machine per message, with its folder away from the user's checkout. Nothing asks for it, and the coordinator design that might want it is being rethought.

Recommendation: a **New stone** button at the head of the sidebar's managed section (`Sidebar.ts:240`), shown when the project has a project thread and is a git repository. It opens a draft in the hero's composer with the workspace control reading "Stone" and the base branch control as usual, headline "What should a stone build in <project>?", same model pill and attachments. Send calls `thread.launch` with a new `WorkspaceStrategy` member `Stone { baseRef }`, whose handler skips the refresh path, refuses `replaces`, and refuses a scratch project (already refused at `ThreadLaunch.ts:1063`) or a folder that is no repository (`:1085`).

### Is it a top-level thread or a subagent-style row?

A subagent-style row, a **managed thread**. Parent: the project thread. That is what the shell already draws (`Sidebar.ts:1-5`), it keeps the "one project thread" rule, its result reaches the project thread as a note, and "Stop all" and rollup work unchanged. It is still "same transcript, sidebar row and composer": a managed thread has a row in the project's list. The glossary's Subagent says "no sidebar row of its own" and Node says "no sidebar row", which the shell's list has overtaken (`Sidebar.ts:3`); the phase's glossary edit should settle that.

### The brief it needs (ADR 0026)

The user's message is the brief and Send is the Go. The launch commit writes a brief record on the parent, `status: accepted`, `decidedBy` user, `task` the message, `why` "Asked by the user", `doneWhen` judged by the user, `wake: "quiet"` (the note reaches the project thread and does not wake it), with the default budget, then creates the start task as Go does (ADR 0030). No card: asking the user to approve what they just typed is noise, and every row still names an accepted brief. A goal thread's stones go through the model's path and get a card.

### What `Subagents.ts`'s lineage needs

- `RelationshipToParent` gains `stone` (`Subagents.ts:60`; its comment already expects this). `SubagentRows.ts:258` and the seam read at `:336` write it from the brief's workspace or the node's arms.
- A shell field, not more lineage: `ThreadShell.stone`, `added(OptionFromNullOr(StoneShell), null)` (`Shell.ts:52`): id, state, since, queue position, ETA, blocked reason, base commit, and the compute figure. `judges/wire-budget.ts` re-runs. A protocol bump, since old clients would refuse the literal.
- `MAX_SUBAGENT_DEPTH` (2) counts as today; node stones cannot spawn (`nodeChildTools`).

### Reconciling with `arms.md`

This note needs one seam from it, whatever its shape: one way to begin a stone from a child's creating commit, called by the start task (a model's brief), the launch handler (New stone) and `startChild` (a node), so all three write the same `cairn.arms` and the same row. Whether a subagent spawned by a stone shares its container is that note's call; the UI shows it as a child in the stone's work panel either way.

## 3. Sidebar, header, work panel, transcript

### Status words and the one thread-state function

`ThreadStateRow` (`ThreadState.ts:129`) gains `stone`. New union in `Shell.ts`, `StoneState`: `queued`, `preparing`, `waking`, `awake`, `sleeping`, `blocked`, plus whatever `arms.md` names for a stone whose disk is gone. `judges/thread-states.test.ts` fails until each value has a row in `docs/golden/thread-states.md`.

| Stone state | `threadStatus` | Word | Category | Tone | Banner (`threadHold`) |
| --- | --- | --- | --- | --- | --- |
| `queued` | new `queued` | Queued | Held | muted | "Waiting for a stone slot: 3rd, about 4 min" |
| `preparing` | new `preparing` | Preparing base | Active | info | none |
| `waking` | new `waking` | Waking | Active | info | none |
| `awake`, run live | `working` | Working | Active | info | none |
| `awake`, no run | `ready` | Done if unseen, else age | Resting |  | none |
| `sleeping` | `ready` | Done or Woke if unseen, else **Sleeping** | Resting | muted | none |
| `blocked` | new `blocked` | Blocked | Held | warning | the reason, with Retry |

Rules:

- **Priority.** A request for the user still comes first (Approval, Go, Input), then Asked its parent, then `blocked`, `queued`, `preparing`, `waking`, then the existing order (`threadStatus` `ThreadState.ts:189`).
- **Sleeping is a label, not a status** (`labelOf` `:303`). A stone that finished and slept unseen should read Done, or the user misses it. Research 06's words `blocked: approval` and `blocked: rate-limited` stay as the existing Approval and Limited.
- **Blocked means only that the arms cannot go on:** the base failed, the link is down past its grace, or Cloudflare refused the start. It pushes once.
- **Rollup.** The rail's mark and a parent's tally read these through the same function: Queued and Preparing count as working; Sleeping and Done as settled.

### Where each surface shows it

- **Sidebar row.** Mark and word from the function; `managedMetaOf` says "stone · 3m" and "stone · asks you" (`Derived.ts:214`, `:222`). A workflow's stones sit in the list like any managed thread, so ten stones are ten rows.
- **Thread header.** "stone, managed by cairn's project thread" (`next-header-role`), and the status word. Both hidden under `sm`.
- **Composer's strip.** Locked facts become "Stone · Sleeping" and the branch (`ContextStrip.ts:156-180`). This is the phone's answer to the hidden header word.
- **Work panel.** A Stone section above Steps: state, base commit and age, instance type, awake time, compute figure, branch, whole-branch change summary, portals with links and Close, and **Sleep now** or **Wake**. Steps gain "Waiting for a slot" and "Preparing base" with the ETA in `meta` (`SubagentSteps.ts:165`). In a workflow's block, `nodeDetailText` (`WorkflowPanel.ts:60`) adds "stone" and the node's compute.
- **Transcript.** Unchanged, plus a display-only Notice when a stone wakes or sleeps ("Woke in 1.3 s", "Slept after 25 minutes idle"), which the model never sees, and portal rows (section 4). A subagent row's group tally counts stones as children.
- **Hold banner.** Queued and Blocked join `ThreadHold` (`ThreadState.ts:107`).

### Changes when the code is on the wrong machine

What the UI needs, not how it is fetched:

- **Per run:** the same `cairn.checkpoint` entry with the same fields (`CheckpointCapture.ts:59-75`). The card reads only that entry, so it draws on a sleeping stone with no wake and needs no new client code.
- **Whole stone:** one summary (files, additions, deletions against the base) current at each run's end, for the work panel.
- **A line diff:** nothing calls one while the panel is off. If `diff.turn` or `diff.full` (`protocol/Checkpoints.ts:27-48`) is called for a stone, it answers a typed "the stone is asleep" rather than waking a container to read a diff.

### The diff panel

**Not needed back for phase 3.** The fan-out, stone start, idle cost and tools targets have no line diff in them. The user turned it off for breaking on the phone (`diff/Panel.ts:1-6`, 2026-10-30), and a ten-stone day on a phone would hit that first. Trunk ship has an outside judge; PR ship has GitHub's diff. Fixing the panel is a separate package the user can ask for.

### Files, Evidence, Terminal, Desktop

- **Files:** later. No target needs browsing without cloning, and the agent can answer.
- **Evidence:** phase 4; it is the verifier's output.
- **Terminal and Desktop:** not built. No phase 3 target requires either, and a composer plus `bash` reaches everything.

### What a phone sees

The list in the sheet, each stone with mark and word. A stone's page has the transcript and the strip's "Stone · Working". The work panel as a bottom sheet, with Sleep now, Wake and portal links at 44 px. The launch card in the composer's slot, with the compute line and Go at the thumb edge. A push on Blocked and on a request. Portals open as a link out of the PWA; iOS behaviour there is still untested (phase 2's surfaces note named the same gap).

### Steering a sleeping stone

The composer does nothing special. Send is Send, not Steer, since no run is live (`Footer.ts:227-228`). The input is admitted at once through the outbox, and the row goes `sleeping` to `waking` to `awake` while the run starts. Nothing about typing waits on the container. The strip and the transcript's Notice show the wake. If the wake fails, the row is Blocked, the input stays queued (`queueLength`) and Retry wakes again; the message is never lost and never sent twice. `arms.md` decides whether a first model turn may start before the container answers; the UI is the same either way. Opening a stone's thread is human activity through **Presence**, which the dual idle timer can read.

### The word "stone"

"Stone look" is unrelated, and two things collide:

- **UI words: no collision found.** No string the user sees names the look (a grep for `"Stone` outside comments found none), and `next/tokens.css` names no token after it. Keep it that way.
- **Code and docs: real noise.** 14 lines under `apps`, `packages` and `judges` say "Stone look", so `grep -i stone` finds them beside every real hit; this note's own search started that way. The first package should change those comments to "the look", and the glossary's Look entry should gain `_Avoid_: "Stone look"`.

## 4. Portals

### Status

Reach is shelved. The user shelved porch on 2026-10-29 as "not a live project" (`docs/phase-2/plan.md:81`, commit `c5f1e93`); the phase 2 gate had no reach check (`waves.md:767`).

- **ADR 0038** says `status: accepted`; its gate (`reach-restart.sh`) passed on a judge brain with a throwaway Caddy. It was never run on the machine.
- **On this machine:** `porch` is not on PATH, `~/.config/porchlight` does not exist, the live Caddyfile has no `import`, `stream_close_delay`, owner guard or porch line, and `phase-2-gate/runs/wizard.txt` has no stage 2 record.
- **One discrepancy.** The plan says the tools are "hidden while porch is missing"; the code installs them unconditionally (`ReachExtension.ts:280`, `ExtensionSet.ts:62`) and they answer porch's "not set up" error (`ReachStatus.ts:1-8`). I found no hiding code. Stage 2 also still exists in `ops/wizards/phase-2.sh:260`, though the plan says it was dropped.

### What exists

- `apps/server/src/reach/`: `Portals.ts`, `PortalTools.ts`, `PortalUnits.ts`, `PorchClient.ts`, `ReachRepair.ts`, `ReachStatus.ts`, `ReachLister.ts`, `ReachExtension.ts`, `ArtifactPublisher.ts`, `Artifacts.ts`. RPCs in `rpc/PortalHandlers.ts`.
- Migration `0011Portals.ts`, with `arms` (`:28`) and `stone_id` (`:29`). `PortalArms` in `Reach.ts:82`.
- Wizard stage 2 and `ops/wizards/reach-edits.ts`. Judges: `reach-restart.ts`, `reach.ts`, `porch-contract.ts`, `caddy-reload.ts`, `owner-guard.ts`.
- **No UI.** Nothing in `apps/web/src` or `packages/client-logic` reads `PortalDetails`, `portal_open` or `reach.list`; the golden table says "Not shown yet; the portal entry (6I)" (`thread-states.md:327`).
- **No Worker.** `alchemy.run.ts` is an empty stack; spike 1's Worker has pipe, status, start, stop and evict routes and no preview route (`spikes/1-stones/src/worker.ts:5-9`).

### Checking "stone portals fit without redesign" (`reach.md:140`)

| The note's claim | The code | Holds? |
| --- | --- | --- |
| The row gains `arms` and `stone_id` | Both columns exist (`0011Portals.ts:28-29`), though `stone_id` is never read and `PortalRow` has no such field | Yes, nearly |
| A `service` porch named `<port>-<stone>-pv` | `porch add` exists; the name is valid (`schema.ts`, `PorchName`) | Yes |
| The token comes from a snippet through a per-porch `imports` list | Not in porch: `ServicePorch` has only `upstream` and `redirect`, `serviceProxy` renders a bare `reverse_proxy` (`caddyfile.ts:40-52`), and the porch changes were dropped (`waves.md:233`, `:245`) | **No** |
| Lifetime and lease-by-name stay; steps 3 and 4 drop out | `unit` is `NOT NULL` (`0011Portals.ts:30`); `portals_live_port` is one port space (`:47`), so two stones cannot both open 5173; `reconcile` marks a row whose unit is gone `stopped`, `lost` (`Portals.ts:36`, `:1284`); the insert writes `'host'` (`:885`); six portals per brain counts all arms (`Reach.ts:22`) | **No**, a small migration and branches |
| Covered by the wildcard and the guard | Wildcard yes. **The owner guard matches only `plans` and `<a>--<b>`** (`reach-edits.ts:172`), so `5173-ab12-pv.gneiss.run` would be open to the whole tailnet, friends and family included | **No**, and this one is a privacy hole |

And a porch per portal reloads Caddy per open and close, which cuts every portal's HMR socket, since porch's handles set no `stream_close_delay` (`waves.md:233`).

### Does the kickoff force porch into the stone path?

No. Decision 6 says "Artifacts and portals go through porch ... Cairn calls it rather than writing a third mechanism", then for stones only "Caddy names ... which proxy to the stones Worker with the service token". Research 02 section 3.3 recommends a matcher. The user later shelved porch, and Phase 3's "done when" has no portal target (it lists stone portals as work, with no judge of its own). A fixed handle is not a third mechanism: it is one edit to the file the user already owns. Add `@cairn_stone_portal` in the `*.gneiss.run` block, above the catch-all, with its own `forward_auth` and `reverse_proxy`. It should not reuse the `ownerOnly` edit, which would also make `plans.gneiss.run` owner-only, a decision shelved with porch.

```caddyfile
@cairn_stone_portal expression `{host}.matches('(?i)^[0-9]{1,5}-[a-z0-9-]+-pv\\.gneiss\\.run$')`
handle @cairn_stone_portal {
	forward_auth 127.0.0.1:3774 {
		uri /_cairn/auth
		header_up X-Cairn-Peer {remote_host}
	}
	reverse_proxy https://<the stones Worker>.workers.dev {
		header_up CF-Access-Client-Id {env.CAIRN_STONE_CLIENT_ID}
		header_up CF-Access-Client-Secret {env.CAIRN_STONE_CLIENT_SECRET}
		header_up X-Cairn-Link-Secret {env.CAIRN_STONE_LINK_SECRET}
		header_up X-Cairn-Preview {host}
		stream_close_delay 5m
	}
}
```

This is a sketch for a spike, not validated. Its gain over porch: **no reload per portal**, so nothing else's socket is ever cut by a stone, and no registry to reconcile.

### What is missing, by place

| Place | Needs |
| --- | --- |
| **Porch** | Nothing for stones. |
| **Caddy** | One wizard edit in `reach-edits.ts`, with the backup, validate and fmt path stage 2 already has; three values in the container's environment, as `CLOUDFLARE_API_TOKEN` already is, which means one `docker compose up -d` (one drop of every connection). Host override is automatic for an HTTPS upstream since Caddy 2.11.0 (docs); the live container was 2.11.2 by the reach note. |
| **Pi-hole, tailnet DNS** | Nothing. `5173-abcd1234-pv.gneiss.run` already answers 192.168.4.20 from this machine and 100.84.155.69 from 1.1.1.1 (`dig`, 2026-11-04). One label, so the wildcard certificate covers it. |
| **Worker** | A preview route, keyed on `X-Cairn-Preview`, checking Access's JWT and the link secret, then `env.STONE.getByName(id).preview(port, req)`. It must **strip `CF-Access-*`, `Cf-Access-Jwt-Assertion`, the link secret and `X-Cairn-Preview` before `getTcpPort(port).fetch`**, or agent code in the stone can read them. A separate header from `Authorization`, which a dev app may use itself (the spike's bearer is at `worker.ts:43`). |
| **Durable Object** | Accept both ends of an HMR WebSocket (research 02 Q4; `arms.md`). An allowlist of ports the brain has opened, so the route cannot reach the Sandbox shim's own port or a stray process. |
| **HMR and dev servers** | Bind `0.0.0.0`; Vite's `allowedHosts` (the host portal sets `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`); whether the container sees the original Host or a rewritten one. Research 02 section 5 row 7 asks exactly this. Open until spiked. |
| **`Portals.ts`** | A migration: `unit` nullable, `portals_live_port` scoped to host rows and a unique `(stone_id, port)`. A stone branch in open (no port claim, no `systemd-run`, no porch; start the command in the background through the arms, because an eviction ends the foreground, ADR 0010), in `reconcile` and in the sweep. Cap: a separate count for stones. `portal_open` routes by the thread's arms, and is not gated on porch for stones. |
| **A sleeping stone** | Its dev server is gone. The Worker answers 503 with a plain page, "This stone is asleep", and a link to its thread. No auto-wake: a phone tab reloading in a pocket should not start a machine. On wake, the brain restarts the commands of `open` rows; `PortalStopReason` gains `asleep`. Needs `arms.md`: does a preview request count as human activity? Recommended yes for a real request, no for an open idle socket, matching research 06's "a running dev server alone doesn't keep a stone awake". |
| **UI** | A portal row in the transcript (`PortalDetails`, already on tool results), the work panel's list, and Close. The first portal UI of any kind. |
| **Name** | `<stone>` must be DNS-safe and short. The spike's id is 12 hex (`frame.ts:29`), which fits. |

### Research 02 section 5 row 7, still open

Does Caddy to workers.dev keep HMR WebSockets and absolute-URL apps working? Plus what the row did not ask: do Access's service token headers pass on a browser-originated upgrade through Caddy (S1 proved them on the relay's own socket, not through Caddy); does Host handling break an app that builds absolute URLs; does `stream_close_delay` hold across this path; and what is the added latency. All in spike SP1.

### Running ADR 0038 again

Only for host portals and artifacts, and **not needed by anything in phase 3**. It needs from the user: deciding porch is live again; `ops/wizards/phase-2.sh 2` (builds an 80 MB binary, `porch init`, a compose mount and container recreate, four Caddyfile edits); accepting that `plans.gneiss.run` becomes owner-only; then the phone nonce check, `judges/reach.ts --live`. Its own open fault stays: porch's handles have no `stream_close_delay`.

## 5. Spend

### How Cairn knows a cost

| Source | Grain | Use | Status |
| --- | --- | --- | --- |
| **Cairn's own intervals**, seconds awake times the list rate | Per stone, live | The meter, the budget, the card, the usage page | Designed here; needs `arms.md` |
| **GraphQL `containersUsageAdaptiveGroups`**: `cpuTimeSec`, `allocatedMemory`, `allocatedDisk`, `txBytes` in `sum`, filterable by `instanceId`, buckets down to a minute. Cloudflare says its values "are the ones to use when estimating your billing costs" and match the dashboard's estimates | Per instance, delayed | Reconciling in a judge | Documented. Whether `instanceId` maps to a Durable Object is not stated; SP2 finds out |
| **Billing usage API**: `GET /accounts/{id}/billable-usage` (Version 1, alpha; the reference also calls it deprecated) and `/billable/usage` (Version 2, alpha, restricted), with `/billing/usage/paygo` listed as beta for select accounts | By service and day | At most a month-end check for idle cost | Pages disagree; access for this account not tried |

So **there is no per-stone bill to read**, and the product shows its own figure with a label. A dashboard figure is the final word on the Idle cost target, read by the user.

### Attribution

- **Intervals, not a running total.** `arms.md` keeps, for each stone, `started` and `stopped` times and the instance type, in the `Workspace` object. An alarm while the container runs (60 s) records `lastSeenAt`, so a container that dies with no callback closes its interval there, overstating by at most 60 s. The alarm ends with the container, so a sleeping stone has **no** alarm, which the Idle cost target needs. It should avoid holding `container.monitor()` for this: since 2026-10-01 pending I/O keeps an object billed for up to 15 minutes (research 02 Q5).
- **The brain's copy.** Pulled at a 60 s tick while awake, at sleep, and at a boot repair, into a document on the stone's conversation. Replaced, never added to, which is the property that keeps the spend ledger right through a `kill -9` (ADR 0036). An open interval counts up to now in the meter's commit. During a link outage it keeps counting: the safe direction.
- **Billing is per 10 ms; the ledger keeps whole seconds** (`Spend.compute.seconds`). Good enough for a figure this size.

### The rate, labelled (ADR 0036)

Current docs, read 2026-11-04: memory $0.0000025 per GiB-s and disk $0.00000007 per GB-s, on provisioned size while running; CPU $0.000020 per vCPU-s on **active use only**. For standard-1 (1/2 vCPU, 4 GiB, 8 GB): $0.038 an hour with no CPU, $0.074 at its full half vCPU, matching v1's measurement.

- **CPU is the unknown.** Instance-seconds do not give it. So the ledger charges the full CPU allotment, a ceiling, and says "up to". If SP2 shows the dataset or the container's `cpu.stat` gives real CPU cheaply, the ceiling can tighten later.
- **The label.** "up to $0.31 at Cloudflare list price, before included usage". It is a list price, as ADR 0036 asks, and it says so for a second reason: the $5 plan includes 25 GiB-hours, 375 vCPU-minutes and 200 GB-hours a month. Memory binds first, at about 6.25 standard-1 hours, so a fan-out of ten stones for 30 minutes (5 instance-hours) may bill nothing that month.
- **Types.** `Spend.compute` holds `{ seconds, micros }` already. `PriceBasis` (`Spend.ts:22`) is for tokens, so compute gets its own label, not a fourth value. `SpendSummary`, `WorkflowSpent` and `NodeReceipt` gain `computeMicros`, optional in stored documents.

### R2 and Durable Objects

Not attributed to a stone or a workflow, and never in a workflow's budget: each is pennies, shared by bases across stones, and has no sensible per-stone split.

- **R2:** $0.015 per GB-month beyond 10 GB. Shown per project on the usage page, from sizes the bases and results records hold.
- **Durable Objects:** 400k GB-s included; five stones at 3 h a day is about half that. The risk is a pinned object (research 02: five pinned for a month is about $25), so the judge checks none is pinned, and the page shows the object's cost only as part of the account floor.
- **The after-figure says so:** "R2 and Durable Object costs are not included: about a cent".

### "Cost shown before launch and after"

- **Before:** the card's Estimate and Compute lines (section 1).
- **After:** the workflow block in the work panel, today's `spentText` (`WorkflowPanel.ts:83`) plus compute, beside the frozen estimate, with an estimate miss visible: "Spent $0.72 at API list price · up to $0.31 compute at Cloudflare list price · estimated $0.40 to $0.90, $0.10 to $0.37". The model reads the same line when its script ends. Per node in `nodeDetailText`.
- **Judged:** `launch-stones` and `steps-stones` on fake stones, then the fan-out gate on real ones.

### Idle cost

- **Shown:** a Stones section on the usage page (`meters/UsageView.ts`). This month's awake time and compute. Awake right now, by name, with a link, so a stuck one is visible. Stored in R2 against the included 10 GB. And one line: "With nothing awake: about $5.00 a month, target under $6", with Workers Paid as a fixed known figure. Anything unread says Unknown (`data-known`), never zero.
- **Judged:** `judges/idle-cost.ts` on the deployed stage, after a window with nothing awake. Every known stone reports no container and no pending alarm; the link holds no socket; `containersUsageAdaptiveGroups` is zero for the window; and the projection of R2, object and request usage plus $5.00 is under $6. Then the user reads the month's bill, which is the outside judge the target really means.

## 6. A project setting surface

**Where.** One new **Stones** section on the settings page, after Skills, with the same project picker the Skills section uses (`settings/View.ts:923`, `:949`). Sentence-case title "Stones"; a phone reads it as one column. There is no project settings page to extend, and one section keeps the page's existing shape. Stored in a new `cairn.sqlite` table, read over its own RPC, not on `ProjectShell`, so the shell stream does not grow.

| Row | Day one? | Why |
| --- | --- | --- |
| **Ship mode** (trunk or PR) | Yes | The kickoff's "Ship: trunk or PR, per project"; `results.md` reads it. Default PR. |
| **Base status** (none, preparing, ready at a commit, stale and why, failed), with Prepare now | Yes | The first thing to look at when a stone is slow or blocked, and the launch card's Base line reads the same answer. From `bases.md`. |
| **Setup script status** (`.agents/setup` found or not, last exit, log tail, a note on `.agents/resume`) | Yes, inside the base row | One thing to the user: "why did my base fail". |
| **Stone secrets by name** (names, set or not, add through a masked field, never shown back) | Only if `bases.md` finds a target project needs one | Cairn itself should not, to be checked. Read-only names first if the store is not ready. |
| **Egress** | One read-only line ("Open") | No control until there is a policy to set. `bases.md` or `arms.md` owns the policy. |

Instance type is deliberately not a row: standard-1 for every stone until a measurement says otherwise.

## 7. Judges

All on fake stones, with no Cloudflare, unless the row says otherwise. A new `judges/fixtures/surfaces/StoneBrain.ts`, shaped like `fixtures/workflows/LaunchBrain.ts`, plays stone states and intervals through the scripted harness's documents and rows: nothing is billed and no script runs. Broken controls are planted in the page by the judge, in the existing style. Each script runs at 390 and 1,440 px.

### `judges/behaviour.ts`

| Case | Judges | Broken control | Cost |
| --- | --- | --- | --- |
| `stone-new-<w>` | New stone opens the draft; Send sends one `thread.launch` with `Stone`; a row appears under the project thread reading Queued; the project thread stays marked and is not archived; the first-launch hero offers no Stone | `stone-root`: the frame leaves as `Root`, so no row under the project thread and the mark moves | $0 |
| `stone-wake-<w>` | A message to a sleeping stone: the button says Send; one `thread.send`; Sleeping, Waking, Working; a reload mid-wake sends nothing again; a failed wake shows Blocked with Retry and keeps the input | `double`: frames sent twice, two inputs | $0 |
| `stone-strip-390` | The strip reads "Stone · <state>" and the branch; no sideways scroll | `strip-hide`: the strip removed in the page | $0 |

### `judges/surfaces.ts`

| Case | Judges | Broken control | Cost |
| --- | --- | --- | --- |
| `stone-brief-go` | A `subagent_spawn` with `isolation: "stone"` shows "Runs in a stone", the base and the rate; Go from two devices starts one child, whose row reads Queued | existing `double` | $0 |
| `stone-brief-unready` | `stones.check` refuses: Go blocked with the reason and Check again; a tap sends nothing | `nocheck`, extended to `stones.check` frames | $0 |

### `judges/workflow-surfaces.ts`

| Case | Judges | Broken control | Cost |
| --- | --- | --- | --- |
| `launch-stones` | Numbers in order; Stones, Compute, Base, Run on 1 first; unknown compute reads the rate and never $0.00; a `parallel()` script offers no Run on 1; a host-only launch draws none of these | existing `sample`: Run on 1's answer leaves as Go, so all stones start | $0 |
| `steps-stones` | Twelve stones, ten slots: ten run, two read Queued with their place; Stop on a queued node frees it and starts nothing; the after-line shows spent beside the estimate | existing `stop` | $0 |
| `budget-stones` | The meter crosses the limit on compute alone, with no `pi.usage` change: running stones end stopped and read Sleeping, new ones are refused, the raise card shows | `no-tick`: the 30 s compute tick dropped by a fault, so the line is never reached | $0 |

### Other judges

| Case | Judges | Broken control | Cost |
| --- | --- | --- | --- |
| `thread-states.test.ts`, `thread-state-rows.test.ts` (in `pnpm check`) | Every `StoneState` has a golden row, and each row's word and category hold; Done beats Sleeping | Already fail on a missing row; a planted row with the wrong word | $0 |
| `LaunchCard.test.ts`, `WorkflowPanel.test.ts`, `Meters.test.ts` (in `pnpm check`) | Words; unknown compute is never zero | Test cases that fail on a zero | $0 |
| `workflow-kill.sh` new case `stone-envelope` | A stone node inside its envelope gets no card; one the plan showed as host raises exactly one; `kill -9` runs each node once | Existing `grantAll` fault: no card, must fail | $0 |
| `spend-kill.sh` new case `compute` | Kills around interval pulls: compute never double counts | Adds instead of replaces: must fail | $0 |
| `rows-subagent.ts` `stone-row` | A stone's row in its parent's transcript, its state through the one function, the way back | Existing | $0 |
| `work-panel.ts` `stone-panel` | The Stone section; Sleep now and Wake send one RPC each; portal link; sheet at 390 | Existing click-never-arrives | $0 |
| `meters.ts` `meters-compute` | Usage page's Stones section; compute labelled; Unknown carries `data-known="false"`; the $6 line | Existing `data-known` check with a planted zero | $0 |
| `reach-edits.test.ts`, `owner-guard.ts` new variant | The `stone-portals` edit is idempotent and leaves `@plans` alone; in a throwaway Caddy, stone hosts in any case answer 403 to a refused peer | Unguarded variant answers 200 | $0 |
| `judges/stone-portal.ts` (new) | Throwaway Caddy to a local fake Worker: headers added; a WebSocket crosses and survives a `caddy reload`; the fake's echo proves nothing is leaked to the upstream's upstream | No `stream_close_delay`: socket cut | $0 |
| `Portals.test.ts` | Two stones on 5173 both open; `reconcile` leaves stone rows alone | The old index: second open refused | $0 |

### Look states (`judges/look.ts`)

Add named states, each at 390 and 1,440 in dark, plus light where the state lists one: `stone-list` (one stone in each state), `stone-thread` (header, strip, a Notice, a portal row), `stone-panel`, `launch-stones`, `brief-stone`, `stone-draft`, `settings-stones`, `usage-stones`. About 16 shots more on round 10's 40. Keep existing states' seeds free of stones, so the 40 frozen shots do not drift, and put the words in one round: **round 11**, then `look.ts freeze 11` on approval. New primitive needs: a sleeping mark and a queued mark. Colour only on status marks, per the look. $0.

### The gate: a phone run (the user)

`judges/stones-phone.ts`, in the style of `phone-report.ts`, on a deployed dev stage, from the phone:

1. The project thread proposes a ten-stone workflow: the card shows compute; the user taps Run on 1 first, then proposes again and taps Go.
2. All ten run, each on its own branch; the user opens one and steers it.
3. One sleeps; a message wakes it.
4. One opens a portal; the page shows a nonce the user types back; the user edits through the thread and sees the HMR change.
5. The after-figure shows; the user compares it with the dashboard next day.

**Broken control:** none on a phone run, by nature; the fake-stone judges above carry them. **Cost:** ten stones for 30 minutes is 5 instance-hours, up to $0.37 at list and likely inside included usage, plus a cheap model's tokens. Real Cloudflare money, so the plan puts it after the user's word.

## What I need from the sibling notes

- **`arms.md`:**
  - One way to begin a stone from a child's creating commit (section 2).
  - The states that map to `StoneState`, and what a stone whose disk is gone reads as: can a message still reach it?
  - A DNS-safe id. Sleep now and Wake. Sleep at once on a budget stop and on a usage hold.
  - Compute intervals per stone, no alarm while asleep, no socket held open with nothing awake.
  - The checkpoint entry in today's shape, whole-branch summary at each run's end.
  - A preview route and its port allowlist. Whether a preview request and Presence feed the dual timer. Restart of a portal's command after a wake.
  - Whether a stone's start is idempotent, so a node never reaches `start_unknown`. Where the slot wait lives, given that this note asks for a durable queue.
  - The bridge's cwd for a stone (`BridgeCwdExtension.ts`).
- **`bases.md`:** a `baseStatus(project)` answer with state, commit, why stale, setup exit, log tail, an expected preparing time and R2 bytes. The secret store and whether a target project needs it on day one. Egress policy.
- **`results.md`:** what `stone.full` returns beyond `nodeId` for `integrate`. Reading ship mode from the new settings row. That a stopped stone's work stays reachable. R2 bytes per bundle and their retention. The conflict card as a request card payload.

## What I did not verify

- **Nothing here was run against Cloudflare.** Every stone number is research 02, spike 1 or current docs. The compute formula matches v1's figures by arithmetic only.
- **The Caddy handle is unvalidated:** not run in `caddy validate`, and the `{env.*}` placeholders on `header_up` and the regex escaping are untested. The live Caddy version is the reach note's reading, not re-read.
- **Docs fetched by a summarising tool** for pricing, limits, the GraphQL tutorial and the billing API; quotes are its quotes. The billing pages disagree on status, and I did not try any endpoint. `instanceId` to Durable Object mapping, data lag and token scope are unknown.
- **I read code, I ran no judge**, and no browser, since no UI changed. The line counts of proposed shots are estimates.
- **A conflict to resolve:** the user's global instructions say Playwright is uninstalled and never to use it for UI checks, yet `judges/look.ts`, `behaviour.ts` and the others import `playwright` (pinned at 1.64.1 in `package.json`, present in `node_modules`). The new cases go into those files as they stand; I did not change or test that.
- **The grep for "Stone" in UI strings** is a text search, not a render. The "no worktree for workflow writers" reading comes from `WorkflowTools.ts` and `WorkflowLaunch.ts`; I did not run a writer node to watch it.
- **Sibling notes did not exist when this was written,** so "what I need" is a request list, not a reconciliation. iOS behaviour of a portal link from the installed PWA is untested.

## (a) Recommended design

1. **Verb.** `stone(prompt, opts)` and `stone.full` in prelude version 4, over the `agent` node tool with `arms: "stone"`. Arms enters the recorder, the keys, the envelope check and the row. Card lines: Stones, Compute, Base, an honest Run on 1. Awake stones share a brain-wide cap (default 10), and past it they queue with a row, a place and an ETA when one is known. Compute counts in `maxListMicros`; at the limit runs stop and containers sleep at once, with their work kept.
2. **A single stone.** `isolation: "stone"` on `subagent_spawn` for a model. A New stone button in the managed list for the user, drafting in the hero's composer, launching a managed thread under the project thread through a new `Stone` workspace strategy, Send being its Go (`decidedBy` user, `wake: quiet`). The first-launch hero offers no Stone. Lineage gains `stone`; the shell row gains `stone`.
3. **Surfaces.** `StoneState` through the one thread-state function; Sleeping is a label under Done; Blocked means only that the arms cannot go on. A Stone section in the work panel, the composer strip for the phone, Notices for wake and sleep. Changed-files card unchanged. Diff panel stays off. No Files, Evidence, Terminal or Desktop. A message wakes a sleeping stone with no special composer behaviour.
4. **Portals.** One fixed Caddy handle with its own owner guard, outside porch, to a Worker preview route that strips secrets and allows only opened ports. A migration and branches in `Portals.ts`, the first portal UI, a plain asleep page with no auto-wake. Porch stays shelved.
5. **Spend.** Cairn's own intervals times list rate, labelled "up to ... at Cloudflare list price, before included usage". GraphQL reconciles in a judge; billing APIs are not built on. R2 and objects show on the usage page and not in a workflow's figure. An idle line against $6, judged on the deployed stage and then by the user's bill.
6. **Settings.** A Stones section: ship mode, base status with setup status on day one; secrets if a project needs them; egress as a read-only line.
7. **Judges.** Fake stones through `StoneBrain.ts` for everything above at $0, look round 11, and one phone run for the gate.

## (b) Proposed ADRs

1. **A stone is a workflow verb over the one node path.** `stone()` in the prelude calls the `agent` node tool with `arms: "stone"`, so one reserve, settle, stop and meter path serves both; `agent({ arms })` is refused and `resume` on a stone is refused for now. Amends ADR 0012.
2. **A stone always has a parent, and a project thread is never a stone.** A single stone is a managed thread under the project thread, from a model's brief or the user's New stone, whose Send is its Go. Amends ADR 0026's amendment by naming this as the one way a project gets a new stone without a refresh.
3. **Awake stones share one cap and queue past it.** A brain-wide setting, durable order, a row from the first moment; a start never fails for being over the cap.
4. **Stone portals are a fixed Caddy handle, outside porch.** One edit with its own owner guard and no reload per portal, proxying to the Worker's preview route with the service token. Amends ADR 0038 and reads kickoff decision 6's stone sentence as Caddy only. Gate: spike SP1 and `judges/stone-portal.ts`.
5. **Compute is a labelled ceiling from Cairn's own intervals, and it counts in the dollar limit.** Amends ADR 0036: its sum spans priced tokens and compute, shown on separate lines. Gate: spike SP2 within 10% or the label says how far off it is.

## (c) User decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Can a project thread itself be a stone? | **No.** It would wake a machine per message and take the long-lived thread off the user's checkout. Revisit with the coordinator rethink. |
| 2 | How does the user start one stone by hand? | **New stone** in the managed list, opening the hero's composer. The alternative is only asking the project thread, which costs a brief and a card for something just typed. |
| 3 | Do stone portals go through porch? | **No, keep porch shelved.** A fixed Caddy handle. Cost: one wizard edit and one container recreate. Host portals stay dormant, and the kickoff's "through porch" no longer describes them. |
| 4 | Awake stones at once? | **10**, as a setting, ceiling 32. Lower saves money and fails the fan-out target. |
| 5 | A default hard limit when a launch names none? | **$2 per stone at list, tokens plus compute**, editable on the card. On a plan this can stop work the plan would not bill; the Raise is one tap. |
| 6 | Bring the diff panel back in phase 3? | **No.** Files and stats on the card; GitHub for a PR's lines. Say so if you want to read line diffs on the phone; that becomes a package. |
| 7 | A sleeping stone's portal: wake on visit? | **No.** A page that says asleep, linking to the thread. Costs one tap; saves a machine started by a stray reload. |
| 8 | Ship mode's default for a new project? | **PR.** Trunk is one setting away and pushes without a person looking. |
| 9 | A read-only Cloudflare analytics token for the judges? | **Yes,** one wizard step, used only by `idle-cost.ts` and SP2. Without it the idle check is the month's bill alone. |
| 10 | Spend on the real runs? | **Yes,** about $0.60 of Cloudflare list price over SP1, SP2 and the phone gate, mostly inside the $5 plan's included usage, on your word before each. |

## (d) Measured spikes

- **SP1 `spikes/N-stone-portal`.** A Vite app in a deployed stone behind a throwaway handle in a test Caddy. **Gate:** the page loads through Caddy, Worker and object; HMR applies an edit in under 1 s p50 over 20 edits; the socket survives a `caddy reload` with `stream_close_delay`, and is cut without it (the control); an absolute-URL app's links work; the container sees neither the Access headers nor the link secret; a sleeping stone answers the asleep page. Answers research 02 section 5 row 7. Cost: under $0.05.
- **SP2 `spikes/N-compute-reconcile`.** Five stones, 30 minutes, varied load, comparing Cairn's intervals to `containersUsageAdaptiveGroups`. **Gate:** per stone, the ceiling is never under the dataset's cost, and over it by at most what full CPU explains; `instanceId` maps to a stone; records the data's lag; records whether `cpu.stat` is readable in the container. If `instanceId` does not map, the reconcile is account-level and the ADR says so. Cost: about $0.19 at list, likely inside included usage.
- **No spike needed for** the sampled dry run, the fixed-handle guard (a throwaway Caddy judges it) or the card.

## (e) Packages

| Package | What | Depends on | Judge |
| --- | --- | --- | --- |
| **U0 Words and protocol** | `StoneState`, `StoneShell`, `BriefWorkspace.stone`, `RelationshipToParent.stone`, `WorkspaceStrategy.Stone`, compute fields, golden rows, glossary terms (Stone state, New stone, Compute, Stone portal, a settled Subagent and Node), "Stone look" comments reworded | none | `thread-states.test.ts`, `wire-budget.ts`, `JsonSchema.test.ts`, `pnpm check` |
| **U1 Fake stones** | `StoneBrain.ts`, `ShellFixtures` additions kept apart from frozen seeds | U0 | Used by U2 onward; `look.ts check` still 40 shots |
| **U2 Thread state** | The function, labels, holds, `managedMetaOf`, steps | U0, U1 | `thread-state-rows.test.ts`, `rows-subagent.ts stone-row` |
| **U3 Verb and envelope** | Prelude v4, recorder, keys, `briefWithin`, `nodeBriefPayload`, refusals | U0 | `Prelude.test.ts` hash, `WorkflowPlan.test.ts`, `workflow-kill.sh stone-envelope` |
| **U4 Launch card** | Lines, sampled dry run, `stones.check`, compute estimate | U3, `bases.md`'s status | `launch-stones`, `LaunchCard.test.ts` |
| **U5 Node dispatch and queue** | Row before slot, cap, durable order, ETA, `startChild` branch | U3, `arms.md`'s seam | `steps-stones`, `workflow-kill.sh` |
| **U6 Single stone** | `isolation: "stone"`, New stone, `Stone` strategy, user-Go brief | U2, `arms.md`'s seam | `stone-new-<w>`, `stone-brief-go`, `stone-brief-unready` |
| **U7 Stone surfaces** | Header, strip, work panel section, Notices, Sleep now, Wake, composer's wake | U2, U5 or U6 | `stone-wake-<w>`, `stone-strip-390`, `work-panel.ts stone-panel` |
| **U8 Compute and budget** | Interval document, ledger, meter tick, stopper's sleep, hold's sleep, after-figure | U5, `arms.md`'s intervals | `budget-stones`, `spend-kill.sh compute`, SP2 |
| **U9 Portals** | Migration, stone branch, `portal_open` routing, Worker route with `arms.md`, wizard edit in `ops/wizards/phase-3.sh`, portal UI | SP1, `arms.md`'s route | `owner-guard.ts`, `stone-portal.ts`, `Portals.test.ts`, `reach-edits.test.ts` |
| **U10 Settings** | Stones section, table, RPC | U0, `bases.md`, `results.md` | A `behaviour.ts` case on each row, `settings-stones` look state |
| **U11 Usage and idle** | Stones section on the usage page, `idle-cost.ts`, analytics token wizard step | U8, `bases.md`'s sizes | `meters-compute`, `idle-cost.ts` and its awake control, the user's bill |
| **U12 Look round 11** | All new states, marks, freeze | U4, U6 to U11 | `look.ts capture --strict`, the user's approval, `look.ts freeze 11` |
| **U13 Phone gate** | `stones-phone.ts`, the phase wizard's steps | Everything, plus `arms.md`, `bases.md` and `results.md` | The user, from the phone |

Order: U0 and U1 first; U2 and U3 in parallel; U4 to U7 as the sibling seams land; SP1 before U9 and SP2 alongside U8; U12 then U13 last.
