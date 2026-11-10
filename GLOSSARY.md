# Cairn

One person's agent harness control plane: a brain at home and arms in the cloud. These words mean exactly this in code, UI, docs and conversation.

## Places

**Cairn**: The product: the server on the Beelink plus its clients.

**Brain**: The Cairn server process on the Beelink and the pi-durable harness inside it. Every transcript, tool call, approval and workflow lives in the brain.

_Avoid_: backend, host (for the process)

**Arms**: The execution environment a conversation's tools run in. A thread's arms are the Beelink host; a stone's arms are on Cloudflare.

_Avoid_: sandbox, runner

**Project**: A git repo or folder on the Beelink. Every thread has exactly one. "No project" is a real, hidden scratch project.

_Avoid_: workspace, repo (for the Cairn concept)

**Scratch project**: The hidden project behind "no project": a fresh folder under Cairn's data directory, with no git repo, so its threads have no diffs. It can become a real project later. It has no project thread; each of its threads is a scratch thread.

**Owner**: The one Tailscale login Cairn admits (`oscabriel@github`), written to `~/.config/cairn/cairn.json` at install and compared exactly. Only the owner's untagged nodes get in.

**Live worktree**: `~/Developer/projects/cairn-live`, the detached checkout `cairn.service` runs from. Only `ops/cairn/deploy.sh` moves it.

**Agent dir**: pi's own configuration folder (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`): settings, skills, packages and `auth.json`. The brain reads it through pi's own classes and never writes it, which `judges/pi-readonly.sh` judges.

**Server settings**: The settings the brain owns and every device shares (auto-settle days, the title model, whether Claude is offered through the bridge, the bridge's generation cap and the default budget), kept in `cairn.sqlite`.

**Rolling copy**: A store's daily backup: `brain.sqlite` and `cairn.sqlite` each keep their newest three copies under `<dataDir>/backups` (`brain-daily-<time>.sqlite`, `cairn-daily-<time>.sqlite`), made through SQLite's online backup when the newest on disk is a day old (ADR 0016). The second copy folder (`CAIRN_BACKUP_COPY_DIR`, off the NVMe) gets each one too. _Avoid_: mirror (that is an escalated question's record), snapshot.

## Conversations

**Thread**: One conversation in the sidebar. Its arms are the project's checkout or its own git worktree on the Beelink.

**Project thread**: A folder project's one long-lived thread, the one the user talks to (the user, 2026-10-29), marked on the project row (`projectThreadId`). The first launch in a project makes it; it lives on, compacted as it grows. Every top-level thread in a project comes from the first launch or a refresh. Nothing replaces it unasked (ADR 0048): the hero's Send and `chat.new` open it instead of starting a new one, and the brain refuses a launch that would replace it without naming it in `replaces`.

**Refresh**: Replacing a project thread with a new one, from the chat header's Refresh after its confirm: the launch names the thread it replaces (`replaces`, ADR 0048), and makes the new thread, archives the old one and moves the mark in one commit, idempotent by its command id. The launch first stops the old thread's run, queue and working subagents, as an archive does; the old one becomes an earlier project thread. Unarchiving it is refused while another thread is the project thread, and the client offers no unarchive. Unarchiving the project thread when the project has none marks it again.

**Earlier project thread**: A project thread a refresh replaced: archived, out of the shell stream, and listed newest first under the sidebar's "Previous (n)" fold, read a page at a time from `shell.previousThreads` (ADR 0048). It opens read only however its page is reached (the fold, Back, a reload, a link, answered by `shell.earlierThread` when the fold does not hold it): its transcript, its subagent rows and its work panel, with a bar in place of the composer that leads to the current project thread. _Avoid_: the archive.

**Managed thread**: A thread whose lineage roots at a project thread (a subagent, a brief's child, a workflow node), listed under the project thread with its status word: the ones that ask the user first, then the other live ones, and the resting and failed ones folded under "Resting (n)", each group six rows then twelve more at a time; the open one always shows, under the fold's header while the fold is closed. It can be opened and used fully (read, message, steer, stop, answer), though the default flow goes through the project thread. One managed by an earlier project thread leaves the sidebar's list and is reached from that thread's transcript and work panel.

**Scratch thread**: A thread in the scratch project, for a one-off question: it runs in a throwaway folder of its own under the data directory. Clearing it stops its run and its subagents', deletes them from the shell and removes its folder; a boot repair removes any scratch folder whose thread is gone.

**Turn**: One user message and everything the model did in answer to it, up to the next user message: its thoughts, tool calls and replies. A brain input starts a turn the same way. The transcript folds a settled turn's work behind one row.

**Fold**: The "Worked for <duration>" (or "You stopped after <duration>") row that stands in for a settled turn's intermediate work, leaving its final answer visible. On `next` the fold line also counts the work it hides by kind, its fold tally: "Worked for 3m 41s · 4 edits · 9 reads · 2 commands · 2 agents" (`client-logic/FoldTally.ts`); only tool calls count.

_Avoid_: session, chat

**Event conversation**: The ownerless pi-durable conversation, one per UTC month, whose entries are durable events (`event.<name>`, data an `EventEnvelope`). It never runs. A `cairn.events-rotated` marker closes each month's conversation and names the next.

_Avoid_: events log (for this conversation)

**Run**: One stretch of a thread's agent loop, from the input that starts it until the answer is final and nothing is queued for it; steers and follow-ups placed along the way join it. pi-durable shows it as `pi.live.run`; RunStarted and RunTerminal bracket it.

**Shelf**: Where a row sat in the phase 1 inbox: active, pinned (`pinnedAt`), snoozed or settled. The brain keeps the fields and the client can still partition rows into shelves, but nothing draws a shelf or an inbox since the 7A cutover, and nothing settles, snoozes or pins: the shelf is fenced, see ADR 0050. A thread's shelf fields change nothing the `next` shell shows, with one passing exception: a snooze made before the cutover reads "Woke" on its row from its wake time until the brain ends it, which clears the snooze and the label with it.

**Settle**: To move a thread off the active shelf: by hand, or automatically after `autoSettleDays` of quiet. A manual settle state (settled, or unsettled by hand) wins over the automatic one until the user sends the thread a message, which clears it. Not drawn since the 7A cutover, see ADR 0050: no key or view settles, the brain's auto-settle sweep is not started and the Auto-settle setting is hidden; the commands, the fields and the sweep stay, dormant and tested.

**Snooze**: To hide a thread until a wake time. The server ends the snooze on time. A failure, a pending request, or a subagent below asking the user wakes the thread early, and the server records that wake on the row; a message the user sends also ends the snooze. Not drawn since the 7A cutover, see ADR 0050: nothing snoozes a thread, and a snooze made before it hides nothing. The brain still ends it on time; only until it does, the row reads "Woke" (see Shelf).

**Launch**: Creating a thread: its sidebar row appears at once (preparing), then the brain prepares its workspace, opens its conversation and sends its first message, each step recorded so a restart resumes it.

**Notice**: A display-only `cairn.notice` entry the brain writes into a thread's transcript about something that happened outside a run, such as why a launch failed after its conversation existed. It carries no model message, so the model never sees it.

**Temporary branch**: The `cairn/<8 hex>` branch (or `cairn-<8 hex>` when a plain `cairn` branch exists) a new worktree starts on, renamed from the first message by the title model.

**Title model**: The cheap model that names threads and branches, never the bridge; without one, a thread keeps its first line as its title and a branch takes a slug of the message.

**Stone**: A thread whose arms run entirely on Cloudflare, on its own branch, started from a prepared base. Still a thread: same transcript, sidebar row and composer.

_Avoid_: orb, cloud thread, sandbox

**Link**: The connection the Beelink dials out to the stones Worker on `workers.dev`, behind an Access service token. A stone's arms are a pi-env daemon in its container, reached over the link through the stone's `Workspace` Durable Object (Cloudflare's name for the object that owns a container; not a Cairn project).

**Stone image**: The base container image every stone starts from (`images/stone`). GitHub Actions builds it and pushes it to Cloudflare's registry, and the stack deploys it by digest.

**Subagent**: A thread that another thread or a stone spawns through a tool, from an approved brief. Its parent owns it; it has no sidebar row of its own but shows under its parent, where it can be steered and stopped. Its result reaches the parent as a note.

**Subagent row**: A spawned child's one line in its parent's transcript (`next` only), placed after the step that spawned it, its state read from the child's own row through the one thread-state function and linking to the child's thread. Two or more children from one step fold into a group with a tally ("3 subagents · 1 working · 2 done").

**Way back**: The "Subagent of <parent>" link at the top of a child's transcript, back to the parent thread.

**Parent banner**: The line above a thread's composer while one of its subagents asks the user, in the rows' own words ("Subagent · Approval", "2 subagents · Waiting for Go"); it names each asking child and its Open opens the first. It hides while the thread asks the user itself.

**Work panel**: The panel a thread in a tree opens from its chat header (`next` only): its parent chain, its children with their states (live ones with Stop, the word beside the composer's Stop glyph, whose first press asks "Stop?" in place since nothing undoes a stop, a question that lets go after five seconds or at any other press in the panel; resting ones under "Previous", folded, six then twelve more at a time), a subagent's own steps, and the thread's workflows from the steps panel's data, with Stop on the whole workflow while it may run nodes and on each live node of a running one. A column beside the chat column from 1,024 px, a bottom sheet below.

**Subagent steps**: A child's steps in the work panel, read from its own row and records, never model text: "You said go", "Started" (in a worktree or the project's checkout), "Working on it", "Said what it did", each Done, Now, To do, Failed or Stopped. The header's button counts them ("2/4 steps").

**Goal chip**: The chat header's button on a goal thread (`next` only), counting its criteria as the verdict writer left them ("2 of 4 met, 1 not met"; "2/4" on the phone). It opens the goal panel. The project thread's sidebar row carries the same tally ("2/4 met").

**Goal panel**: The panel the goal chip opens: the objective, the progress line, and each criterion with its state, the judge that decides it and the verdict's evidence. Only a criterion the user judges offers Met and Not met, which send `goal.mark`; the state changes only when the verdict writer records it. A column beside the chat column from 1,024 px, a bottom sheet below.

**Asked its parent**: A subagent row's state while the child's question is with its parent's model (ADR 0027), so the user is not asked yet and nothing above it lights.

**Subagent anchor**: The background task a parent owns for each child. It owns the child's conversation, so the parent's run is never held open by its children (ADR 0028).

**Brief task**: The parent's background task that holds a pending brief's 7-day expiry; if no answer comes by then, it expires the brief and tells the parent.

**Start task**: The parent's background task (`cairn.subagent-start`) that Go's commit creates: it checks the model the brief names at Go (none: the parent's), makes the child's workspace, then creates and starts the child in one commit. Crashes never end it (the crash limit keeps it), so a Go'd brief starts its child once however often the brain dies.

**Tell task**: The parent's background task (`cairn.subagent-brief-tell`) that tells it of a Decline, a Send back, an expiry, or a Go whose child could not start.

**Tally**: A parent row's count of its subagents (working, asking, settled, failed), from its registry. A settled child whose result is not yet delivered counts as working.

**Stop all**: A parent row's stop that also stops each working subagent, and theirs in turn (`thread.stop` with `subagents: stop`); a settled child with no run, and anything under it, is left as it is. It holds the parent's wakes until its next run, so a stopped child's result reaches it as a note and never wakes it, even when its last run had completed. Archiving or deleting a thread makes this stop.

**Crash point**: A named place in a subagent's delivery where a judge brain kills itself (`SubagentCrashes`), so the kill judge lands a `kill -9` inside each window. Production plants none.

**Run mark**: A child run's mark in its parent's `cairn.subagents` document, `nudge` or `settled`, keyed by the run's identity (its answer, its first input, or the submission), so each child run settles once whichever reporter commits first.

**Child scope**: The one way a per-subagent or per-workflow-node layer is built (`ChildScope.build`): a fresh memo map and a scope that closes with the child, so nothing leaks from the parent's layers (ADR 0034).

**Child workspace**: A subagent's own git worktree and branch, planned in `cairn.sqlite` before git makes it, so a crash between the two is repaired at boot. Releasing it never deletes a worktree with uncommitted or unmerged work. Every commit a thread's `bash` makes carries a `Cairn-Thread: <thread id>` trailer.

_Avoid_: child agent, worker

**Lineage**: A subagent's place in the tree, on its row: its parent, its root, and how it relates to its parent. A row with a lineage is hidden from the sidebar, which shows it under its nearest ancestor that has a row.

**Settlement**: A subagent's closed result for one input: completed, stopped or failed, with a summary, a divergence from its brief, a payload checked against the brief's schema, and its commit and branch. It reaches the parent as a note; waking the parent is a separate input.

_Avoid_: using it for a thread's settle state, which is **Settle**

**Note**: A transcript entry the model reads but that starts no run (a passive write with model content), such as a subagent's settlement in its parent. An idle thread places it at once, a running one at its next boundary ahead of queued inputs, and a stop keeps it.

**Wake**: The separate input that follows a note when the parent should act on it. A quiet spawn, a user's own steer to the child, a usage-limit failure, or a parent the user stopped (Stop all included) or whose run failed gets the note without a wake. At most one wake waits in a running parent's queue.

**Brain input**: An input the brain writes into a thread on its own rather than the user: a wake, a subagent's question to its parent, the brief that starts a child, a typed child's nudge, a brief's answer told to its parent, a parent's or a workflow's message. The user's own message is a `cairn.user` entry that names its sender (`data.from`); a brain input is a `pi.user` entry or a brief's answer. The transcript draws it as a quiet line in the notice row's style, never as the user's message, without the instructions meant only for the model, and a turn it started offers no Retry.

_Avoid_: system message, user message (for these)

**Reporter**: The task that delivers one input to a subagent and its result back to the parent, under request ids derived from the child and the settlement's seq, so each lands once across a restart.

**Mirror**: The record that escalating a subagent's question places in its parent. An answer from either thread settles both, once.

**Goal**: A thread with stated criteria that owns the subagents and stones working toward them. Still a thread: same transcript, sidebar row and composer. Its criteria are met only when an outside judge says so. The project thread is the natural goal thread and carries one goal at a time; a subagent's thread has none.

_Avoid_: task, epic, project (for the goal)

**Workflow**: A durable script that fans work out across subagents and stones. Every node returns a typed result its script reads; a writer is verified only where the script calls `verify`, and integration is an explicit step that phase 3 adds.

_Avoid_: pipeline, DAG, job

**Dispatch ledger**: A workflow's record of every node it dispatched: the brief that approved it, its model and its cost. A replay reads it, and the steps panel shows it.

**Node**: One `agent()` call of a workflow script, recorded as a row of the dispatch ledger: a child thread on the model its call names (none: the launching thread's), with no subagent tools of its own and no sidebar row.

**Launch approval**: The brief a workflow's `workflow_plan` call raises: the dry run's plan (call sites, node count, estimate, budget) frozen with its envelope. Go approves the ledger row in the answering commit; Run on 1 first approves it to run with `pipeline()` taking one item, a separate run with nothing carried over; Send back returns it to its model with notes, and nothing runs; Decline ends it. The card reads numbers first (nodes, the estimate, whose unknown cost is never $0.00, the budget, what Go covers), then the model each call site runs on, then its arguments, folded. The budget is what the call asked (`max_usd`, `max_tokens`) over the default budget; the user may change it on the card (Change budget), and the change travels in the answer with Go or Run on 1 first, never in the frozen plan (ADR 0047). A launch belongs to the run that proposed it: the model runs it with `codemode` in that same run, and if the run ends first the row is declined (`run-stopped`), so Go is never a standing grant. Two Goes on one script in one run are two launches.

_Avoid_: launch brief, plan approval

**Envelope**: What a workflow's launch approval grants its nodes: the script's hash, the models its nodes run on (and whether each may write), the permission modes, a node cap and a budget. It grants per model, to a node from any call site, not per call site. A node inside it gets its own brief, accepted with the envelope as decider in the commit that dispatches it; a node outside it (another model, a writer where the plan showed a reader, a wider mode, past the cap) raises its own brief card and waits for the user.

_Avoid_: grant (in prose), allowance

**Steps panel**: What a client shows of a thread's workflows, read from the dispatch ledger on the thread stream (`WorkflowSteps.ts`): each workflow's heading and node tally, its phases with their nodes, its totals and its log. A node's record is queued, running, held, unknown, done, failed, stopped or refused, which the work panel words from the state table (a running node reads "Working", as a working child does); a phase is pending with no nodes, running while one is live, else done. Phases only grow.

**Phase**: A named stage of a workflow, declared in its `meta` or reached at run time with `phase()`. The ledger lists phases append-only by title, and each node records the phase it ran in.

**Workflow gate**: The `beforeTool` hook that lets a workflow script run only against an approved ledger row of its exact hash, rewrites it behind the prelude, and marks the code mode call (`GATE_MEMO`), so the node tools refuse every other caller.

**Node watcher**: The background task (`cairn.workflow-watch`) that records a workflow node or script call that ended without settling: stopped, failed or finished. A node it records keeps a receipt of what its child used, so a stopped node's spend still counts.

**Node stop**: Stopping one node of a running workflow (`workflow.stopNode`): its task is aborted, the script sees `null` for it and goes on, and nothing reruns. Not offered as a restart; to run a node again, ask the thread. Stopping the whole workflow (`workflow.stop`) aborts its script call, or ends an approved one before it runs.

**Abort polling**: Every node tool ends its waits at a stop (`untilStopped`) and checks for one between its steps, so a stop never waits on something deaf to it.

**Recipe**: A saved workflow script, named by its `meta.name`: built in (the council) or a project's own under `.cairn/workflows/`.

**Recipe reference**: A workflow script that is only `export const meta = { name: "council" };`. Proposed and run like any script, it stands for the built-in recipe it names, so a thread launches a built-in recipe by name. A project's recipe launches by name too: `workflow_plan` reads it from the thread's folder and keeps the source it proposed beside the ledger, which the gate runs on Go.

**Resume (a node)**: `agent(prompt, { resume: nodeId })`: a new node whose child is a fork of a settled node's child, so it continues with that node's whole context under its own receipt and result. The council's cross-examination resumes each advisor's report.

**Prelude**: The fixed JavaScript added to an approved workflow script that gives it `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, `args`, `verify` and `approve` over the node tools. Its text is pinned by `PRELUDE_VERSION`.

**Dry run**: Running a workflow script in its own sandbox with stub nodes, to build its launch card: the call sites, the node count and the estimate.

**Call site**: One row of a launch card's table: a script `line:column` with its model, label, phase, schema name, whether it may write, and how many times it may run at most.

**Model spec**: What a brief, a workflow node, a recipe argument or a goal's model judge names to pick the model a child runs on: `provider/modelId`, with `:level` for a thinking level (`opencode-go/gpt-6-luna:high`). Naming none runs the child on its parent's model and level (ADR 0043). A named model is checked when the child is created (in the catalog, a usable credential, its provider neither failing nor past a spent plan window) and refused with the reason, never replaced. The `models` tool lists what a child can run on now. A role name (`@worker`) is no model spec: the records that held one were migrated when roles were retired (ADR 0052), and a new one is refused as not `provider/modelId`.

_Avoid_: role, alias, binding

## Seams and services

**Harness seam**: The boundary between Cairn's orchestration and UI and the agent loop. pi-durable is the only real agent loop behind it; a scripted test harness also sits behind it for conformance tests.

_Avoid_: provider adapter, harness (alone)

**Scripted harness**: The in-memory implementation of the harness seam that plays scripted answers; the backend for UI tests, screenshots and the dev client, and the second side of the conformance suite.

**Conformance suite**: The replay scenarios in `apps/server/src/brain/conformance/` whose hand-written expectations judge every harness behind the seam (ADR 0024).

**Test slack**: The factor every test deadline scales by (`CAIRN_TEST_SLACK`, at least 1): a half plus the one-minute load average per core, which `pnpm check` reads when it starts and `vitest.config.ts` reads again when the tests start, keeping the larger (a caller can name a value to raise it, not to lower it). It stretches every deadline a test sets for itself: `eventually`'s, Vitest's default test and hook limits, a test's own limit (`testLimit`), its `Effect.timeout` bounds (`slackened`), the budgets of polling loops of its own (`slackenedTries`), and the conformance suite's and mutation check's timeouts. So a quiet machine runs the tests' own numbers, and a busy one does not fail a test because it waited too little. It does not stretch a requirement a test measures (boot ready in under 3 s, a SIGTERM exit within 3 s, a cost ratio), which is the claim under test, not a deadline, and it is fixed when the tests start, so load that arrives later is not counted. _Avoid_: timeout multiplier.

**Bridge**: Cairn's Claude provider, which serves the Claude subscription to pi-durable through the unmodified `claude` binary.

_Avoid_: Claude provider, proxy

**Child**: A `claude` process the bridge spawns for one conversation. Children run in the thread's real folder with every Claude Code tool, hook and setting turned off; the bridge's tools reach them through an in-process MCP server.

**Held query**: A child's open Claude query that the bridge keeps waiting across a tool call, so the tool result returns into the same query instead of a new turn. A held child with no provider call open dies after its held time to live (30 minutes), and its session resumes from the stamp at the next call.

_Avoid_: parked query

**Stamp**: The record on a Claude reply's final assistant message (`cairn.claude`) naming the Claude Code session that answered, so the next turn resumes it. Committed with the reply, and never sent to clients.

**Claude slot**: One of the bridge's generation permits (four by default). A child holds one only while it generates, never across a tool call; a thread waiting for one shows "waiting for a Claude slot".

**Usage probe**: A Claude Code child the bridge starts with no prompt, to read the login and the plan windows. It costs nothing and runs at boot, when a client starts watching usage, every five minutes while usage is watched or Claude turns run, and once after a rejection.

**One-shot**: A request to the bridge that joins no conversation (compaction and other summaries, or a call without a session id). It runs in its own child, keeps no session and serves no tools. It takes a one-shot permit, not a Claude slot: at most two run at once, and never more than there are Claude slots.

_Avoid_: Claude seat, Claude lane

**Executor**: The self-hosted service on the Beelink that holds every MCP server and third-party credential. Agents reach tools through it.

**Executor grant**: Cairn's one OAuth grant to its Executor connection, kept in `cairn.sqlite` and held by one brain at a time under a lock. When Executor refuses it, Cairn shows that Executor needs sign-in and pushes once.

**Boot sweep**: The boot repair that declines at Executor every Executor approval request the brain recorded and never finished before a restart, so a late accept can never run it.

_Avoid_: MCP gateway, tool server

**Stdio relay**: The supervised process on the Beelink that carries Cairn's stdio MCP servers to Executor over HTTP, one session's server process per call.

_Avoid_: bridge (that is the Claude provider), MCP gateway

**Extension (Cairn's)**: A pi-durable extension Cairn installs in the brain (coding tools, code mode, Executor's tools, the skills, context and Cairn sections, judge tools), in one fixed order.

**Skill catalog**: The skills a thread can use, per working directory: the project's `.agents/skills` up to the git root first, then the user's skills as pi resolves them.

**Skill expansion**: The turn content stage that turns `/skill:name args` and `$name` references into pi's own `<skill>` block, ahead of the typed text.

**Run pin**: A system prompt section's text held fixed for one run, so a turn's prompt never changes mid-run.

**Context sections**: `addendum` (`APPEND_SYSTEM.md`) and `project_context` (the `AGENTS.md` files), as pi names them.

_Avoid_: plugin

**Guard**: The brain's check on every request and socket: the right host, the owner's Tailscale login copied from Caddy, and the exact origin of Cairn's page.

**Boot repair**: A step the brain runs after the Harness opens and before it accepts sockets, in the fixed order listed in `apps/server/src/BootRepairs.ts`.

**Stop hook**: A step that runs after a thread's run ends interrupted, whoever stopped it, in the order given to `StopHooks`; the bridge's explicit abort of a held child is one.

**Turn content stage**: One step that turns a user turn into model content and its `cairn.user` entry, in the order listed in `apps/server/src/threads/TurnContentStages.ts`.

**Shell projector**: The brain fiber that keeps each thread row's derived fields (activity, run times, queue, last error, waiting, approval, preview) equal to what pi-durable holds, committing at most once per thread per 50 ms window. It is recomputed, never replayed.

**Boot reconcile**: The shell projector's pass at boot, after the harness resumes, that rebuilds every thread row from `inspect()` and the rows themselves, so an event lost to a crash cannot leave a row wrong. _Avoid_: replay.

**Close hook**: A step SIGTERM runs after every socket has closed and before the stores close, in the fixed order listed in `apps/server/src/ShutdownHooks.ts`, each with its own timeout.

**Command receipt**: The shell store's record of a command id's first answer (the sequence it committed at, or its rejection), so a resent command lands once. Receipts are kept for four times the outbox's resend window, however many events follow.

**Durable event**: A fact with several consumers (a node settled, a child's result, an approval answered), appended to the event conversation in the commit of the change it describes, so it exists exactly when the change does (ADR 0033). Not the events log.

**Reactor**: A named handler of some durable event kinds that runs each event once, oldest first, in one commit with its cursor in `cairn.events`. It writes only through `tx` and creates pi-durable tasks for outside work. Its `from` (`now` or `start`) says where a newly added reactor's cursor starts. The brain's reactors are listed in `apps/server/src/brain/ReactorSet.ts`.

**Dead letter**: An event a reactor passed without handling it, recorded with its error in `cairn.event-dead-letters`: its handler failed on it five times in a row, or could not read it at all. The reactor goes on to the next event; the dead letter is logged, shown as the reactor's last failure and pushed (ADR 0033).

**Pi host**: The brain service that loads the allowlisted pi TUI extensions (pi-web-access, pi-fff) and offers their tools to every thread as pi-durable tools, one instance per brain or per folder (ADR 0039).

**Stored shape**: The shape a pi-durable document or a `cairn.sqlite` row is kept in. A change to a document's shape bumps its `version` with a `migrate` that rewrites the old shape when the store hands the document out; a change to a row's JSON gets a numbered migration; a reader that still tolerates an old shape is a shim, and carries the date after which it goes (ADR 0052). A writer's state type is derived from the protocol's schema of the document (`DocumentState`), so the two cannot drift. _Avoid_: legacy reader, compat.

**Events log**: The brain's structured JSON log lines (Effect's `Logger.formatJson`). Judges and the deploy check read it by event name (the `event` annotation), for example `listening` with the bound port.

## Streams and the client

**Shell stream**: The stream of Cairn's own state every client holds: projects and one row per thread, as a snapshot then whole-row updates, resumable from a sequence.

**Thread stream**: The stream of one thread's conversation: a snapshot of its projected view, then the changes to it, with a fresh snapshot on every subscribe.

**Window**: The newest part of a long thread that a thread stream subscription starts with (at most 10 user turns, 75 entries, 1 MiB). `entriesOffset` counts the active entries before it, and `thread.history` pages them in.

**Boot data**: The JSON the brain inlines in `index.html` (shell snapshot, protocol, build id, push key) so the sidebar paints before the socket opens.

**Load report**: The page's own account of one load (time to interactive, requests before it, standalone), logged by the brain as one `load.report` line with the peer's direct or DERP path.

**Client settings**: The settings that belong to one device (send shortcut, follow-up behaviour, timestamp format, confirm delete, composer collapse, theme, font sizes, chat width, diff layout), saved in localStorage under `cairn:client-settings:v1`. Server settings are the ones the brain keeps for every device. A setting whose feature has no surface is hidden while that is so and keeps its stored value: confirm delete, diff layout and the server's auto-settle (ADR 0050).

**Next (views)**: The app's views, under `apps/web/src/next/` and drawn by `next/Frame.ts` (ADR 0040). They began as a fork beside the classic views, picked by a `ui` client setting; at the cutover (plan 7A, 2026-10-30) the classic views, the setting and `?ui=` were deleted, so `next` is the only set. _Avoid_: classic (the deleted views), except when speaking of history.

**Design token**: A named value in `next/tokens.css` (a surface, ink, stroke, selection ladder step, accent, status tone, radius, space, type step, duration, layer or shadow) that the `next` views use in place of any literal colour or palette utility, in dark and light. `judges/contrast.test.ts` holds every text pair to WCAG AA and fails any other colour in `next/`. _Avoid_: token alone where Spend's model tokens could be meant; say design token or the token's name.

**Look**: The set of design token values the `next` views draw with: one look, Stone revised (the user, 2026-10-29), in dark and light in `next/tokens.css`; there is no look switch. Previewed and approved in look rounds. _Avoid_: theme (that is dark or light), skin.

**Primitive (next)**: A view helper in `apps/web/src/next/ui/` (button, chip, status chip, row, card, menu, sheet, field, banner, meter...) drawn with design tokens only. A next view builds on primitives rather than raw classes.

**Look catalogue**: The dev-only page at `/__look` (`apps/web/src/next/ui/catalogue`) that draws every next primitive in every state in dark and light. `judges/look-rules.ts` judges it and the look rounds screenshot it; it is never in the production build.

**Look round**: One preview of the look put to the user at `plans.gneiss.run/cairn/v2/look/round-<n>/`, ending with the question: approve, or name what to change. Rounds 0 and 1 were static mock pages; from round 2 `judges/look.ts round <n>` publishes screenshots of named states of the real `next` client, each with its look rules findings. _Avoid_: review (that is code review).

**Named state (look)**: One screen `judges/look.ts` drives the `next` client into (hero, slash menu, thread, unfolded turn, sidebar, settings), taken at 390 and 1,440 px in dark and, where it has one, a light variant. Each width and theme is one shot.

**Frozen round**: An approved look round recorded by `look.ts freeze <n>` in `judges/look/frozen/round-<n>.json`: the hash of `next/tokens.css` and each shot's hash and fingerprint (16 px cell means). `look.ts check` fails when the tokens or a shot drift from the newest frozen round, and `judges/look.test.ts` fails on the tokens in `pnpm check`, so changing an approved look needs a new round. _Avoid_: baseline alone (the parity baseline is t3code's).

**Shell (next)**: The `next` views' frame around the page (`next/shell`, look track L6): the project rail and the selected project's list at the left (a sheet on a phone), the chat header and the hold banner. The list shows the project's project thread on top and under it the threads it manages, newest first, each with its status mark from the one thread-state function, then its earlier project threads folded under "Previous (n)"; there are no Active, Settled, Pinned or Snoozed groups and no inbox. The project's name heads the list with its menu (Rename project, Remove project, which confirms first), and the chat header has the open thread's menu (Rename thread) on every thread but the project thread, whose header and row name its project. Its foot holds Usage and Settings, with no meters. It owns the page's clock, the visits and the favicon badge, and the keys: New thread, Previous and Next thread (over the rows the list draws, in its order), the scratch thread's Cmd+J or Ctrl+J, and Escape, all listed in Settings' Keyboard section (ADR 0050).

**Project rail**: The shell's column of project bubbles: one squircle with a low corner radius per folder project, filled edge to edge by the project's favicon (found in the project's root as t3code finds it, served at `/api/projects/<id>/favicon`) or showing its first letter, with a mark when a thread in the project needs the user or is working. A bubble opens its project's project thread, or, when it has none, a new draft in that project whose first message starts it. Below the last bubble, a + bubble of the same shape opens the add-project picker (a sheet on a phone, a dialog on a desktop): a folder on the Beelink, browsed to or typed, becomes a project the rail selects, and a folder that is already a project selects that project. On the hero and a draft's page the rail and the list show the draft's project, the one the hero names, whether the picker chose it or it is the hero's default. _Avoid_: inbox.

**Scratch overlay**: The floating panel over any page that holds the scratch thread: Cmd+J or Ctrl+J shows and hides it without losing it (a header button on a phone), and shown, it takes the keyboard; its first message launches the scratch thread, and Clear deletes the thread and its folder.

**Usage page**: `/usage`, opened from the shell's foot (`next/meters`): the spend ledger with each figure's basis, the model plans' windows (an unknown share reads Unknown, never zero) and the budgets. The default budget changes there, and each thread with spend recorded takes a budget of its own from its row (Set budget, ADR 0047).

**Measured list**: The transcript's own scroll list (`timeline/list`, ADR 0041). A row counts in the scroll range only once it has been measured (history it never drew is measured off-screen first), parked rows keep frozen heights, the first visible row keeps its offset through any change above it, and a glyph bookmark keeps the reader's place through width changes. _Avoid_: virtual list (that was `@foldkit/ui`'s, which estimated heights).

**Hold**: What keeps an open thread from moving on without the user: a turn waiting for a Claude slot, or a plan's spent usage limit (Limited): a Claude plan window, a Codex limit or OpenCode Go's.

**Projection**: The client's view of a thread: pi-durable's conversation with brain-only documents and Claude stamps removed, image data replaced by references and long strings cut.

**Draft**: A message not yet sent, kept in the browser per thread (or per new-thread draft) so typing never waits on the network.

**Composer**: Where the user writes a turn: the editor, its `/`, `@` and `$` menus, and the footer's model pill and mode control. Docked under an open thread, or inside the hero for a draft.

**Model pill**: The composer footer's first control: the provider's mark (Claude, OpenAI, OpenCode, or the provider's initial when it has no mark), the model's short name and its thinking level ("Opus 5.5 · High"). It opens the model picker.

**Model picker**: The popup the model pill opens, above the composer on a desktop and as a sheet along the bottom on a phone. Its provider rail runs down the left edge (Favorites first when there are any, then one mark per provider) and picks which provider's models the list shows; it opens on the current model's provider. A search lists matches from every provider, each row with its provider's mark. The thinking levels are a segmented choice in their own band under the list. _Avoid_: model menu.

**Attachment tray**: The composer's row of a draft's attachments (image thumbnails, file rows, upload progress, retry and remove). A send pressed while uploads are in flight waits and fires when the last one answers.

**Hero**: The new-thread page: "What should we build in <project>?" above the composer, with the project picker and the workspace strip. Its default project is the most recently updated folder project. When the project it names has a project thread, Send opens that thread with the message and its attachments waiting unsent in its composer, rather than starting a thread (ADR 0048). Its `/`, `@` and `$` menu opens over the headline, so the box never moves.

**Outbox**: The browser's list of sends not yet acknowledged. It resends them after a reconnect, and the brain admits each one once. A shell command older than the resend window (seven days) is dropped unsent. It sends in lanes, one item at a time in each: a thread's sends and launch in that thread's lane, shell commands in the shell's (one naming a thread whose launch still waits joins that thread's), so a launch the brain holds holds only its own thread. A send waiting in it shows at the end of its thread's transcript as a pending row, the user's message dimmed and marked "Not sent yet"; once the brain acknowledges it the row says "Sent" and stays until the thread's own row (or the brain's queue) shows it, so the words never blink out between the two.

**Connection mark**: The chat header's word for a socket that is not live, beside a spinner in the waiting tone: Connecting on the page's first dial, Reconnecting while it dials again or waits to, Catching up while the shell stream brings the page current. Hidden while the page is live. A page whose dials keep failing asks the server which build it serves over plain HTTP and reloads for a new one.

**Presence**: A device telling the brain whether Cairn is on screen and which thread it shows, so a push waits while the user is looking at that thread or one above it.

**Approval push**: The push for a request waiting on a thread, in the request's own words, one notification per thread; held back while a page shows it, sent late once it has waited a minute unseen, and reminded once 15 minutes after the last push. A subagent's request pushes under its project thread (the root of its lineage), with the root's tag and link and a "<child> asks:" prefix.

**Needs you**: A thread the user talks to (a folder project's project thread, or the scratch thread this device holds) with a request waiting anywhere in its tree, or a result of its own the user has not seen. A subagent's result reaches its parent, so only its requests count, and they count once, on the root. One predicate and one count in `client-logic/Badge.ts` give the favicon, the app icon's badge, every push's number and the rail's mark. The page passes what only it knows: the scratch thread's identity, which lives in its localStorage, so the brain's count, the push's number, leaves a scratch thread out; and the thread on screen, whose own result the user watches land, so the page's producers do not count that result (its requests still count). An old top-level thread no list shows never counts.

**State table**: The one table of state to word, tone and mark (`STATE_LOOKS` in `client-logic/ThreadState.ts`) that the sidebar's rows, the chat header, the hold banner, the parent banner, the work panel and the transcript's subagent rows read, so one state has one name and one mark on a screen. Words are sentence case ("Waiting for Go", "To do"); only the states that wait on the user carry the needs-you dot.

## Asking the user

**Approval**: A durable record in the brain that holds one decision (a gated tool call, a question or a brief) until it is answered, from any device, or it expires. It records who decided and why. Executor's own approval prompts are answered by Cairn, never shown as a second question.

_Avoid_: permission request, prompt (for the record)

**Brief**: The written plan a subagent or stone starts from: what to do, why, and how its result will be judged. A subagent's brief may name a command that exits 0 once the work is done (`done_when`), shown on the card before Go and given to the child, which Cairn does not run yet; otherwise no outside judge checks the result, and the parent (or the workflow script) accepts it (ADR 0055). It is an approval, and nothing delegated starts until the user answers it with Go or it fits its workflow's envelope.

_Avoid_: task, spec, ticket

**Go**: The user's yes to a brief or a workflow's launch. It starts the child (or the workflow) in the same commit that accepts the record. On a subagent's brief card or a launch card, the user may change the budget before Go (dollars at list price and tokens, ADR 0047); the change travels with the answer and the proposal stays as the model wrote it. Go approves the budget the card shows, which reads "No limit" only when no limit will run. The card offers Go only once every model the brief or launch names is ready; while one is not, Go is blocked with the reason.

_Avoid_: approve (for a brief), run

**Send back**: The user's answer to a subagent's brief that asks its parent for a new one, or to a workflow's launch that asks its model to propose the script again: it needs notes on what to change, starts nothing, and the proposer reads the notes. A node's own brief takes Go or Decline only.

_Avoid_: revise (in prose; it is the decision's wire name), reject

**Decider**: Who settled an approval record: the user, a parent thread answering its child's question, the permission mode, a workflow's envelope, a judge, expiry, or the system (a stop or boot). Every record past pending names one.

**Escalate**: To pass a child's question up from its parent to the user, because the parent chose to, the parent was stopped or failed, the run that saw the question ended, the parent thread was archived or deleted, or 15 minutes passed after the parent's model saw it. The parent's `cairn.escalations` records each one and why. The user answers it in the parent thread, and either answer settles both records once.

_Avoid_: forward, bubble up

**Relayed question**: A subagent's final plain answer whose last line is a question or numbered options, turned into a question to its parent (source `answer`) instead of a result. It expires, and it ends when the child is stopped.

**Criterion**: One stated, checkable condition of a goal or a brief, naming the outside judge that decides it. It is met only by a verdict recorded after it last changed.

**Verdict**: A judge run's recorded result for a criterion: pass or fail, the judge, and the evidence (exit code, output tail, commit, model). Only the verdict writer records one.

**Judge run**: The durable `cairn.judge-run` task `goal_check` queues for one criterion. It runs the criterion's judge and records the verdict, its index entry and a verdict note in one completing commit; met is set only by that commit, and a rerun or a second check queues nothing.

**Verdict note**: The `cairn.verdict` note a judge run leaves for the thread's model, saying how the criterion was judged. It does not wake the thread.

**Request card**: The card above the composer that holds what waits on the user in a thread: an approval, a question or a brief, one at a time with its place among them ("2/3"). On the phone it takes the composer's slot while a request shows. A request that arrives while the user types in the composer waits until they pause for 1.5 s, send or leave the composer, while the thread's row and header show it at once. Every request can be declined with a reason, a question too. A question's answers wait out a 3 second undo window before they are sent; a request settled elsewhere, stopped or expired while it showed closes with that settled line and keeps what the user had typed. Once answered, it leaves one line in the transcript saying who decided and why.

_Avoid_: prompt, modal, panel

**Crash limit**: Cairn's own count of crashes in a row that cut a task off without progress (ADR 0046). pi-durable ends no task for crashes in Cairn's brain; at boot, a task cut off five times in a row is aborted, except the waits, which run on however often the brain dies: a tool call that holds a record (an approval wait among them), a workflow's script call, `subagent_status`, a workflow's `agent` and `verify` calls, a call one of those is nested under, and the subagent and workflow tasks that wait. A tool call that waits on nothing is aborted like other work, and the model reads that it was. _Avoid_: parked, which pi-durable 1.5 no longer does.

**Permission mode**: A thread's rule for which tool calls need an approval, after t3code's modes, kept in `cairn.permissions` and read by each gated tool at call time. Full access, the default, asks for none; Auto-accept edits asks before commands and Executor calls; Supervised asks before everything but reads. Auto is listed for later. A thread may also allow one tool for the rest of its life (Allow for this thread). A subagent's mode is never wider than its parent's.

_Avoid_: approval policy, trust level

**Effect mark**: The memo a gated tool commits right before its effect, so a rerun after a crash that finds it reports the call may have run and never repeats it.

**Plan window**: One rate-limit window of a subscription plan (five hours, seven days), with how much of it is used and when it resets. Unknown is shown as unknown, never as zero. A provider whose windows could not be read says `unreadable`; one that has none to read (OpenCode Go, an API key login) says `unsupported`, so an empty list never means two things.

**Spend**: What a thread, goal or workflow run used, derived from each conversation's `pi.usage`: tokens per model, and their list price where the model has one. Tokens with no price are counted and named, never priced at zero.

**List price**: A model's catalog price per token, which Cairn uses to put a dollar figure on spend. On a plan (the bridge, OpenCode Go, Codex) it is not a bill, and the figure says so.

_Avoid_: cost (for a plan's figure)

**Spend ledger**: The derived cache of each conversation's `pi.usage` in `cairn.sqlite`, priced one response at a time and rebuilt from `pi.usage` at boot when it drifts. A kill never counts a response twice.

**Provider health**: Whether a provider is answering: ok, limited (under a plan's usage limit, until its reset or the next success) or failing (its login broke, or three transient failures came inside five minutes with no success between; such a streak lapses fifteen minutes after its newest failure, so one request can find out). Each request counts once, by its last attempt, and a login or logout starts the provider over: the outcome of a request made before it is ignored. A child named onto a limited or failing provider's model is refused.

**Budget**: The limits a brief, a workflow's launch or a thread carries: list-price dollars and tokens, with a warning line at 80% by default (ADR 0047). A model's call names them (`max_usd`, `max_tokens` on `subagent_spawn` and `workflow_plan`) or the default budget fills them, and the proposal freezes the result; the user may change it on the card before Go. Reaching it stops new work and asks for a raise. Turns, minutes and a plan window guard stay in the schema and are offered by nothing.

**Default budget**: The server setting a brief or a workflow's launch starts from for each limit its model's call does not name, changed on the usage page. A proposal freezes what it started from, so a later change moves no budget already asked.

**Budget scope**: A thread and its lineage subtree under one budget. A subagent's comes from its brief, as the user set it at Go; a thread's own is declared from the usage page (`budget.declare`, a `stop` scope), whose form opens filled with the line the thread stands at (`budget.get`). A declare replaces that line whole, raises included; one with no limit removes it, a subagent's brief budget too. A goal's `drain` scope has no caller yet.

**Budget mode**: How a scope acts at its limit: `stop` (every thread of the scope stops, overshooting by at most one response per running child) or `drain` (no new subagent work starts; running children finish under their own budgets).

**Budget guard**: What acts once per epoch when a scope crosses its warning line or its limit: a notice, a push, the stop or drain, and the raise.

**Raise**: A `budget_raise` approval proposing the larger of double the line and the spend plus one line. Each accepted raise starts a new epoch, as does each declare. A workflow's raise names the run (its scope is the workflow id) and raises that run only. Its card names the scope by its title, reads what it spent against its line and the line proposed, and offers Decline and Approve only. A thread's raise still pending when a new budget is declared is declined, as the user's answer, in the declare's commit.

**Workflow meter**: What a workflow run spent, summed over its nodes' children (tokens, list-price dollars priced one response at a time, model turns) and written into its ledger row in the commit that reserves a node, the one that settles a node, and, while a node runs, at most once a second. The first commit that reaches the warning line or the limit marks it and emits `workflow.budget.soft` or `workflow.budget.spent`, once per epoch.

**Budget stopper**: The background task (`cairn.workflow-budget-stop`) the budget reactor creates when a run reaches its limit: it stops the child of every running node until none runs, so those nodes end `stopped` and the script sees `null`. New nodes are refused `budget_spent` at their reserve; the run ends partial, `budget_spent`.

**Usage hold (node)**: A workflow node whose child's run ended on a provider's usage limit is `held` until the limit resets (or fifteen minutes when the provider names no reset), then its child is asked to go on; other nodes keep running.

## Results

**Artifact**: An HTML page or folder an agent publishes to a private `gneiss.run` URL. Cairn publishes only over pages it published itself: a file in the artifacts folder with no row in Cairn's artifacts table is the user's and is never overwritten.

_Avoid_: page, report (for the published thing)

**Portal**: A private `gneiss.run` URL in front of a running dev server, on the Beelink or in a stone. On the Beelink its server runs as its own systemd user unit (`cairn-portal-<id>`), so the page outlives a brain restart; a portal lives 12 hours and closes when its thread is archived.

**Porch**: The user's tool (porchlight) that names private `gneiss.run` URLs and renders them into Caddy. Cairn publishes artifacts and opens portals by calling it.

**Reach state**: What the brain knows of porch: unknown, ready, or not set up (the porch binary is missing or has no machine config). The portal reconcile and sweep record it and log it once at info; it is not a boot failure. The brain also asks as it builds its extension set at boot, and offers models the artifact and portal tools only when porch is ready (ADR 0038).

_Avoid_: preview, tunnel

**Result tool**: `submit_result`, the tool a subagent ends with: a typed value checked against its brief's result schema, plus its divergence (the envelope `{ result, divergence }`). A child gets two attempts.

**Typed result**: The value a subagent hands back through the result tool, kept in its `cairn.result`.

**Nudge**: The one input a subagent gets when its run ends without a result, asking it to call the result tool. It counts as an attempt when it comes before any call.

**Divergence**: What a subagent says it did differently from its brief, carried beside its result.

**Verification**: A project's own launch, drive, evidence and cleanup recipe under `.cairn/verify/`, which an outside judge runs against a result.

_Avoid_: e2e, test suite (for the recipe)

**Parity baseline**: What is left of t3code's captured states under `judges/fixtures/parity/t3@fe27e8e3/`: the imported thread (`thread/thread.json`) the judges seed, and the hero landmark files `behaviour.ts` holds the composer footer against. The screenshots, page HTML and the capture and pixel-parity judges that wrote and compared them were deleted at the cutover (plan 7A).

**Landmark**: An element both apps mark with the same hook (`data-testid`, `data-timeline-row-kind`, `data-chat-*`, `data-composer-*`, `data-changed-files-*`, `data-slot`, `h1`), read with its box and computed tokens (`judges/fixtures/parity/Landmarks.ts`). _Avoid_: anchor (that word is the subagent anchor's).

**Outside judge**: Anything other than the model that did the work that decides whether the work is right: a test, a conformance suite, a screenshot comparison, a model judge or verifier on another model, or the user. A goal's model judge on the thread's own model is refused unless the user names that model for it (ADR 0055), and a subagent's parent accepting its result is not one.

**Browser driver**: `judges/lib/Browser.ts`, what every browser judge drives system Chromium with over the DevTools protocol (ADR 0044). Chained locators with auto-waiting and strict single-match behaviour, real key events, touch, routes, screenshots, and nothing no judge calls.

_Avoid_: reviewer (alone), checker

**Judge registry**: `judges/index.ts`, one entry per judge: what it proves, how it runs, its cost, what it needs and its broken control or `none` (ADR 0054). `judges/index.test.ts` fails on a judge file without one.

**Judge record**: One JSON line a judge run appends to `~/cairn-judges/records.jsonl` when it ends: the judge, the commit, a clean or dirty tree, pass or fail, its counts, time and cost (`judges/lib/Record.ts`). A run another judge starts (`shutdown.sh`'s durability windows, the nightly's steps) is recorded as within that judge, not as the judge's own. `node judges/status.ts` joins each judge's own records with the registry, showing a failure on the commit under any argument list. An unrecorded run is not evidence.

**Judge set**: The free judges that need no model, no deployed brain, no Docker and no porch, which `node judges/run-set.ts` runs in order under the judge lock before a deploy. `ops/cairn/deploy.sh` refuses a commit without a passing set on a clean tree, unless `--override`. _Avoid_: the gate (that is `pnpm check`).

**Judge lock**: `flock /tmp/cairn-judge.lock`, so two judges never share the Beelink's ports, units and CPU. `judges/run-set.ts` holds it for the whole set and the nightly takes it before it starts (a night that cannot take it in 90 minutes is skipped, and a second in a row fails); a judge run by hand holds it only when its caller wraps it in `flock`, as agents and the user do by convention. The set and the nightly take it themselves, and run under a caller's lock when the caller that wrapped them already holds it (`judges/lib/lock-held-by-caller.sh`); any other holder that starts them must set `CAIRN_JUDGE_LOCK_HELD=1`.

**Attachment**: A file the user adds to a message: an image, a document or text. The brain prepares it when it is uploaded, and the model gets it as content.

**Upload URL**: The one-shot, signed address a client posts one attachment's bytes to. It expires after ten minutes.

**Prepared image**: An uploaded image fitted to 1,568 px at upload time (`<id>.prepared`): the bytes the model receives.

**Checkpoint**: A git ref (`refs/cairn/checkpoints/<thread>/turn/<n>`) the brain records for a thread's working folder before its first run (turn 0) and at the end of each run, so the diff of any turn, or of the whole thread, can be shown. Scratch threads have none.

**Changed-files card**: The card under a run's last reply listing the files the run changed, with their diff stats. It covers the whole run, from one checkpoint to the next: a queued follow-up that starts in the commit that ends the run belongs to the same run, so its edits share the card with the first turn's (decided 2026-10-24, review task T42). _Avoid_: per-turn diff.

## Milestones

**Daily driver**: The state in which the user does a full day of real work in Cairn instead of herdr.

**Parity**: Being indistinguishable from t3code in layout and behaviour wherever Cairn copies t3code, as judged side by side.

_Avoid_: polish, "like t3code"
