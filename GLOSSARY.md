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

**Scratch project**: The hidden project behind "no project": a fresh folder under Cairn's data directory, with no git repo, so its threads have no diffs. It can become a real project later.

**Owner**: The one Tailscale login Cairn admits (`oscabriel@github`), written to `~/.config/cairn/cairn.json` at install and compared exactly. Only the owner's untagged nodes get in.

**Live worktree**: `~/Developer/projects/cairn-live`, the detached checkout `cairn.service` runs from. Only `ops/cairn/deploy.sh` moves it.

**Agent dir**: pi's own configuration folder (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`): settings, skills, packages and `auth.json`. The brain reads it through pi's own classes and never writes it, which `judges/pi-readonly.sh` judges.

**Server settings**: The settings the brain owns and every device shares (auto-settle days, the title model, whether Claude is offered through the bridge, the bridge's generation cap, the role table and the default budget), kept in `cairn.sqlite`.

## Conversations

**Thread**: One conversation in the sidebar. Its arms are the project's checkout or its own git worktree on the Beelink.

**Turn**: One user message and everything the model did in answer to it, up to the next user message: its thoughts, tool calls and replies. The transcript folds a settled turn's work behind one row.

**Fold**: The "Worked for <duration>" (or "You stopped after <duration>") row that stands in for a settled turn's intermediate work, leaving its final answer visible.

_Avoid_: session, chat

**Event conversation**: The ownerless pi-durable conversation, one per UTC month, whose entries are durable events (`event.<name>`, data an `EventEnvelope`). It never runs. A `cairn.events-rotated` marker closes each month's conversation and names the next.

_Avoid_: events log (for this conversation)

**Run**: One stretch of a thread's agent loop, from the input that starts it until the answer is final and nothing is queued for it; steers and follow-ups placed along the way join it. pi-durable shows it as `pi.live.run`; RunStarted and RunTerminal bracket it.

**Settle**: To move a thread off the active shelf: by hand, or automatically after `autoSettleDays` of quiet (3 by default; 0 turns it off). A manual settle state (settled, or unsettled by hand) wins over the automatic one until the user sends the thread a message, which clears it.

**Snooze**: To hide a thread until a wake time. The server ends the snooze on time. A failed run or a pending request wakes the thread early, and a message the user sends ends the snooze.

**Launch**: Creating a thread: its sidebar row appears at once (preparing), then the brain prepares its workspace, opens its conversation and sends its first message, each step recorded so a restart resumes it.

**Notice**: A display-only `cairn.notice` entry the brain writes into a thread's transcript about something that happened outside a run, such as why a launch failed after its conversation existed. It carries no model message, so the model never sees it.

**Temporary branch**: The `cairn/<8 hex>` branch (or `cairn-<8 hex>` when a plain `cairn` branch exists) a new worktree starts on, renamed from the first message by the title model.

**Title model**: The cheap model that names threads and branches, never the bridge; without one, a thread keeps its first line as its title and a branch takes a slug of the message.

**Stone**: A thread whose arms run entirely on Cloudflare, on its own branch, started from a prepared base. Still a thread: same transcript, sidebar row and composer.

_Avoid_: orb, cloud thread, sandbox

**Link**: The connection the Beelink dials out to the stones Worker on `workers.dev`, behind an Access service token. A stone's arms are a pi-env daemon in its container, reached over the link through the stone's `Workspace` Durable Object (Cloudflare's name for the object that owns a container; not a Cairn project).

**Stone image**: The base container image every stone starts from (`images/stone`). GitHub Actions builds it and pushes it to Cloudflare's registry, and the stack deploys it by digest.

**Subagent**: A thread that another thread or a stone spawns through a tool, from an approved brief. Its parent owns it; it has no sidebar row of its own but shows under its parent, where it can be steered and stopped. Its result reaches the parent as a note.

**Child workspace**: A subagent's own git worktree and branch, planned in `cairn.sqlite` before git makes it, so a crash between the two is repaired at boot. Releasing it never deletes a worktree with uncommitted or unmerged work. Every commit a thread's `bash` makes carries a `Cairn-Thread: <thread id>` trailer.

_Avoid_: child agent, worker (except as a role alias)

**Lineage**: A subagent's place in the tree, on its row: its parent, its root, and how it relates to its parent. A row with a lineage is hidden from the sidebar, which shows it under its nearest ancestor that has a row.

**Settlement**: A subagent's closed result for one input: completed, stopped or failed, with a summary, a divergence from its brief, a payload checked against the brief's schema, and its commit and branch. It reaches the parent as a note; waking the parent is a separate input.

_Avoid_: using it for a thread's settle state, which is **Settle**

**Note**: A transcript entry the model reads but that starts no run (a passive write with model content), such as a subagent's settlement in its parent. An idle thread places it at once, a running one at its next boundary ahead of queued inputs, and a stop keeps it.

**Wake**: The separate input that follows a note when the parent should act on it. A quiet spawn, a user's own steer to the child, a usage-limit failure, or a parent the user stopped or whose run failed gets the note without a wake. At most one wake waits in a running parent's queue.

**Reporter**: The task that delivers one input to a subagent and its result back to the parent, under request ids derived from the child and the settlement's seq, so each lands once across a restart.

**Mirror**: The record that escalating a subagent's question places in its parent. An answer from either thread settles both, once.

**Goal**: A thread with stated criteria that owns the subagents and stones working toward them. Still a thread: same transcript, sidebar row and composer. Its criteria are met only when an outside judge says so.

_Avoid_: task, epic, project (for the goal)

**Workflow**: A durable script that fans work out across subagents and stones. Every node returns a typed result, writers get verified, and integration is an explicit step.

_Avoid_: pipeline, DAG, job

**Dispatch ledger**: A workflow's record of every node it dispatched: the brief that approved it, its model and its cost. A replay reads it, and the steps panel shows it.

**Recipe**: A saved workflow script, named by its `meta.name`.

**Prelude**: The fixed JavaScript added to an approved workflow script that gives it `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, `args`, `verify` and `approve` over the node tools. Its text is pinned by `PRELUDE_VERSION`.

**Dry run**: Running a workflow script in its own sandbox with stub nodes, to build its launch card: the call sites, the node count and the estimate.

**Call site**: One row of a launch card's table: a script `line:column` with its role, label, phase, schema name, whether it may write, and how many times it may run at most.

**Role**: A name such as `@worker`, `@scout`, `@judge` or `@verifier` that briefs and workflows use instead of a model. It resolves to a concrete model when the child is created, and the child keeps that model.

_Avoid_: alias (alone), agent type

**Role table**: The global table from each role to its binding, in the server settings, seeded from ADR 0035's defaults. Built-in roles cannot be dropped.

**Binding**: One role's entry in the role table: a model, an optional thinking level and up to four fallbacks, tried in order at dispatch only, past a provider that is limited or failing. A binding names a model, never another role. A launch may override bindings for its own children.

## Seams and services

**Harness seam**: The boundary between Cairn's orchestration and UI and the agent loop. pi-durable is the only real agent loop behind it; a scripted test harness also sits behind it for conformance tests.

_Avoid_: provider adapter, harness (alone)

**Scripted harness**: The in-memory implementation of the harness seam that plays scripted answers; the backend for UI tests, screenshots and the dev client, and the second side of the conformance suite.

**Conformance suite**: The replay scenarios in `apps/server/src/brain/conformance/` whose hand-written expectations judge every harness behind the seam (ADR 0024).

**Bridge**: Cairn's Claude provider, which serves the Claude subscription to pi-durable through the unmodified `claude` binary.

_Avoid_: Claude provider, proxy

**Child**: A `claude` process the bridge spawns for one conversation. Children run in the thread's real folder with every Claude Code tool, hook and setting turned off; the bridge's tools reach them through an in-process MCP server.

**Held query**: A child's open Claude query that the bridge keeps waiting across a tool call, so the tool result returns into the same query instead of a new turn.

_Avoid_: parked query (Parked is a pi-durable task)

**Stamp**: The record on a Claude reply's final assistant message (`cairn.claude`) naming the Claude Code session that answered, so the next turn resumes it. Committed with the reply, and never sent to clients.

**Claude slot**: One of the bridge's generation permits (four by default). A child holds one only while it generates, never across a tool call; a thread waiting for one shows "waiting for a Claude slot".

**Usage probe**: A Claude Code child the bridge starts with no prompt, to read the login and the plan windows. It costs nothing and runs at boot, when a client starts watching usage, every five minutes while usage is watched or Claude turns run, and once after a rejection.

**One-shot**: A request to the bridge that joins no conversation (compaction and other summaries, or a call without a session id). It runs in its own child, keeps no session and serves no tools.

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

**Stop hook**: A step that runs after a thread is stopped, in the order given to `StopHooks`; the bridge's explicit abort will be one.

**Turn content stage**: One step that turns a user turn into model content and its `cairn.user` entry, in the order listed in `apps/server/src/threads/TurnContentStages.ts`.

**Shell projector**: The brain fiber that keeps each thread row's derived fields (activity, run times, queue, last error, waiting, approval, preview, parked tasks) equal to what pi-durable holds, committing at most once per thread per 50 ms window. It is recomputed, never replayed.

**Boot reconcile**: The shell projector's pass at boot, after the harness resumes, that rebuilds every thread row from `inspect()` and the rows themselves, so an event lost to a crash cannot leave a row wrong. _Avoid_: replay.

**Close hook**: A step SIGTERM runs after every socket has closed and before the stores close, in the fixed order listed in `apps/server/src/ShutdownHooks.ts`, each with its own timeout.

**Command receipt**: The shell store's record of a command id's first answer (the sequence it committed at, or its rejection), so a resent command lands once.

**Durable event**: A fact with several consumers (a node settled, a child's result, an approval answered), appended to the event conversation in the commit of the change it describes, so it exists exactly when the change does (ADR 0033). Not the events log.

**Reactor**: A named handler of some durable event kinds that runs each event once, oldest first, in one commit with its cursor in `cairn.events`. It writes only through `tx` and creates pi-durable tasks for outside work. Its `from` (`now` or `start`) says where a newly added reactor's cursor starts. The brain's reactors are listed in `apps/server/src/brain/ReactorSet.ts`.

**Pi host**: The brain service that loads the allowlisted pi TUI extensions (pi-web-access, pi-fff) and offers their tools to every thread as pi-durable tools, one instance per brain or per folder (ADR 0039).

**Events log**: The brain's structured JSON log lines (Effect's `Logger.formatJson`). Judges and the deploy check read it by event name (the `event` annotation), for example `listening` with the bound port.

## Streams and the client

**Shell stream**: The stream of Cairn's own state every client holds: projects and one row per thread, as a snapshot then whole-row updates, resumable from a sequence.

**Thread stream**: The stream of one thread's conversation: a snapshot of its projected view, then the changes to it, with a fresh snapshot on every subscribe.

**Window**: The newest part of a long thread that a thread stream subscription starts with (at most 10 user turns, 75 entries, 1 MiB). `entriesOffset` counts the active entries before it, and `thread.history` pages them in.

**Boot data**: The JSON the brain inlines in `index.html` (shell snapshot, protocol, build id, push key) so the sidebar paints before the socket opens.

**Load report**: The page's own account of one load (time to interactive, requests before it, standalone), logged by the brain as one `load.report` line with the peer's direct or DERP path.

**Client settings**: The settings that belong to one device (send shortcut, follow-up behaviour, timestamp format, confirm delete, composer collapse, theme, font sizes, chat width, diff layout), saved in localStorage under `cairn:client-settings:v1`. Server settings are the ones the brain keeps for every device.

**Hold**: What keeps an open thread from moving on without the user: a parked task (with Retry), a turn waiting for a Claude slot, or a plan's spent usage limit (Limited): a Claude plan window, a Codex limit or OpenCode Go's.

**Projection**: The client's view of a thread: pi-durable's conversation with brain-only documents and Claude stamps removed, image data replaced by references and long strings cut.

**Draft**: A message not yet sent, kept in the browser per thread (or per new-thread draft) so typing never waits on the network.

**Composer**: Where the user writes a turn: the editor, its `/`, `@` and `$` menus, and the footer's model, thinking and mode controls. Docked under an open thread, or inside the hero for a draft.

**Attachment tray**: The composer's row of a draft's attachments (image thumbnails, file rows, upload progress, retry and remove). A send pressed while uploads are in flight waits and fires when the last one answers.

**Hero**: The new-thread page: "What should we build in <project>?" above the composer, with the project picker and the workspace strip.

**Outbox**: The browser's list of sends not yet acknowledged. It resends them after a reconnect, and the brain admits each one once.

**Presence**: A device telling the brain whether Cairn is on screen and which thread it shows, so a push never fires for a thread the user is looking at.

## Asking the user

**Approval**: A durable record in the brain that holds one decision (a gated tool call, a question or a brief) until it is answered, from any device, or it expires. It records who decided and why. Executor's own approval prompts are answered by Cairn, never shown as a second question.

_Avoid_: permission request, prompt (for the record)

**Brief**: The written plan a subagent or stone starts from: what to do, why, and how its result will be judged. It is an approval, and nothing delegated starts until the user answers it with Go or it fits its workflow's envelope.

_Avoid_: task, spec, ticket

**Go**: The user's yes to a brief or a workflow's launch. It starts the child (or the workflow) in the same commit that accepts the record. On a launch card, the user may edit the budget and the per-launch role overrides before Go; the edits travel with the answer and the proposal stays as the model wrote it.

_Avoid_: approve (for a brief), run

**Decider**: Who settled an approval record: the user, a parent thread answering its child's question, the permission mode, a workflow's envelope, a judge, expiry, or the system (a stop or boot). Every record past pending names one.

**Escalate**: To pass a child's question up from its parent to the user, because the parent chose to, its run ended, or 15 minutes passed. The user answers it in the parent thread, and either answer settles both records once.

_Avoid_: forward, bubble up

**Criterion**: One stated, checkable condition of a goal or a brief, naming the outside judge that decides it. It is met only by a verdict recorded after it last changed.

**Verdict**: A judge run's recorded result for a criterion: pass or fail, the judge, and the evidence (exit code, output tail, commit, model). Only the verdict writer records one.

**Request card**: The card above the composer that holds what waits on the user in a thread: an approval, a question or a brief. Once answered, it leaves one line in the transcript saying who decided and why.

_Avoid_: prompt, modal, panel

**Parked**: A task pi-durable stopped running after the brain crashed 5 times in a row while it ran without progress. It shows in the UI with a retry; a task waiting on a pending approval is retried at boot by itself.

**Permission mode**: A thread's rule for which tool calls need an approval, after t3code's modes, kept in `cairn.permissions` and read by each gated tool at call time. Full access, the default, asks for none; Auto-accept edits asks before commands and Executor calls; Supervised asks before everything but reads. Auto is listed for later. A thread may also allow one tool for the rest of its life (Allow for this thread). A subagent's mode is never wider than its parent's.

_Avoid_: approval policy, trust level

**Effect mark**: The memo a gated tool commits right before its effect, so a rerun after a crash that finds it reports the call may have run and never repeats it.

**Plan window**: One rate-limit window of a subscription plan (five hours, seven days), with how much of it is used and when it resets. Unknown is shown as unknown, never as zero. A provider whose windows could not be read says `unreadable`; one that has none to read (OpenCode Go, an API key login) says `unsupported`, so an empty list never means two things.

**Spend**: What a thread, goal or workflow run used, derived from each conversation's `pi.usage`: tokens per model, and their list price where the model has one. Tokens with no price are counted and named, never priced at zero.

**List price**: A model's catalog price per token, which Cairn uses to put a dollar figure on spend. On a plan (the bridge, OpenCode Go, Codex) it is not a bill, and the figure says so.

_Avoid_: cost (for a plan's figure)

**Spend ledger**: The derived cache of each conversation's `pi.usage` in `cairn.sqlite`, priced one response at a time and rebuilt from `pi.usage` at boot when it drifts. A kill never counts a response twice.

**Model family**: The vendor a model comes from (Anthropic, OpenAI, Google, or other), whichever provider serves it. A judge or verifier on another family than the worker is the outside judge the kickoff asks for.

**Provider health**: Whether a provider is answering: ok, limited (under a plan's usage limit, until its reset or the next success) or failing (its login broke, or three transient failures came inside five minutes with no success between; such a streak lapses fifteen minutes after its newest failure, so one request can find out). Each request counts once, by its last attempt, and a login or logout starts the provider over. Role resolution passes over a limited or failing provider.

**Budget**: The limits a brief or a workflow's launch carries (list-price dollars, tokens, turns, minutes, a plan window guard), with a warning line at 80% by default. Reaching it stops new work and asks for a raise.

## Results

**Artifact**: An HTML page or folder an agent publishes to a private `gneiss.run` URL. Cairn publishes only over pages it published itself: a file in the artifacts folder with no row in Cairn's artifacts table is the user's and is never overwritten.

_Avoid_: page, report (for the published thing)

**Portal**: A private `gneiss.run` URL in front of a running dev server, on the Beelink or in a stone. On the Beelink its server runs as its own systemd user unit (`cairn-portal-<id>`), so the page outlives a brain restart; a portal lives 12 hours and closes when its thread is archived.

**Porch**: The user's tool (porchlight) that names private `gneiss.run` URLs and renders them into Caddy. Cairn publishes artifacts and opens portals by calling it.

_Avoid_: preview, tunnel

**Result tool**: `submit_result`, the tool a subagent ends with: a typed value checked against its brief's result schema, plus its divergence (the envelope `{ result, divergence }`). A child gets two attempts.

**Typed result**: The value a subagent hands back through the result tool, kept in its `cairn.result`.

**Nudge**: The one input a subagent gets when its run ends without a result, asking it to call the result tool. It counts as an attempt when it comes before any call.

**Divergence**: What a subagent says it did differently from its brief, carried beside its result.

**Verification**: A project's own launch, drive, evidence and cleanup recipe under `.cairn/verify/`, which an outside judge runs against a result.

_Avoid_: e2e, test suite (for the recipe)

**Parity baseline**: t3code's captured states (screenshots, page HTML, landmark files, `states.json` with masks, `version.json`) committed under `judges/fixtures/parity/t3@fe27e8e3/<group>/`, written only by `judges/capture.ts t3` when the installed nightly matches ADR 0015 (D56).

**Landmark**: An element both apps mark with the same hook (`data-testid`, `data-timeline-row-kind`, `data-chat-*`, `data-composer-*`, `data-changed-files-*`, `data-slot`, `h1`), read with its box and computed tokens; the structure judge compares landmarks by key. _Avoid_: anchor.

**Outside judge**: Anything other than the model that did the work that decides whether the work is right: a test, a conformance suite, a screenshot comparison, a verifier on another model family, or the user.

_Avoid_: reviewer (alone), checker

**Attachment**: A file the user adds to a message: an image, a document or text. The brain prepares it when it is uploaded, and the model gets it as content.

**Upload URL**: The one-shot, signed address a client posts one attachment's bytes to. It expires after ten minutes.

**Prepared image**: An uploaded image fitted to 1,568 px at upload time (`<id>.prepared`): the bytes the model receives.

**Checkpoint**: A git ref (`refs/cairn/checkpoints/<thread>/turn/<n>`) the brain records for a thread's working folder before its first run (turn 0) and at the end of each run, so the diff of any turn, or of the whole thread, can be shown. Scratch threads have none.

**Changed-files card**: The card under a run's last reply listing the files the run changed, with their diff stats. It covers the whole run, from one checkpoint to the next: a queued follow-up that starts in the commit that ends the run belongs to the same run, so its edits share the card with the first turn's (decided 2026-10-24, review task T42). _Avoid_: per-turn diff.

## Milestones

**Daily driver**: The state in which the user does a full day of real work in Cairn instead of herdr.

**Parity**: Being indistinguishable from t3code in layout and behaviour wherever Cairn copies t3code, as judged side by side.

_Avoid_: polish, "like t3code"
