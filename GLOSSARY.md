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

**Server settings**: The settings the brain owns and every device shares (auto-settle days, the title model, whether Claude is offered through the bridge, the bridge's generation cap), kept in `cairn.sqlite`.

## Conversations

**Thread**: One conversation in the sidebar. Its arms are the project's checkout or its own git worktree on the Beelink.

**Turn**: One user message and everything the model did in answer to it, up to the next user message: its thoughts, tool calls and replies. The transcript folds a settled turn's work behind one row.

**Fold**: The "Worked for <duration>" (or "You stopped after <duration>") row that stands in for a settled turn's intermediate work, leaving its final answer visible.

_Avoid_: session, chat

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

**Subagent**: A child conversation that a thread or stone spawns through a tool. Its parent owns it, and it is visible and steerable in the UI.

_Avoid_: child agent, worker (except as a role alias)

**Goal**: A thread with stated criteria that owns the subagents and stones working toward them. Still a thread: same transcript, sidebar row and composer. Its criteria are met only when an outside judge says so.

_Avoid_: task, epic, project (for the goal)

**Workflow**: A durable script that fans work out across subagents and stones. Every node returns a typed result, writers get verified, and integration is an explicit step.

_Avoid_: pipeline, DAG, job

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

**Events log**: The brain's structured JSON log lines (Effect's `Logger.formatJson`). Judges and the deploy check read it by event name (the `event` annotation), for example `listening` with the bound port.

## Streams and the client

**Shell stream**: The stream of Cairn's own state every client holds: projects and one row per thread, as a snapshot then whole-row updates, resumable from a sequence.

**Thread stream**: The stream of one thread's conversation: a snapshot of its projected view, then the changes to it, with a fresh snapshot on every subscribe.

**Window**: The newest part of a long thread that a thread stream subscription starts with (at most 10 user turns, 75 entries, 1 MiB). `entriesOffset` counts the active entries before it, and `thread.history` pages them in.

**Boot data**: The JSON the brain inlines in `index.html` (shell snapshot, protocol, build id, push key) so the sidebar paints before the socket opens.

**Load report**: The page's own account of one load (time to interactive, requests before it, standalone), logged by the brain as one `load.report` line with the peer's direct or DERP path.

**Client settings**: The settings that belong to one device (send shortcut, follow-up behaviour, timestamp format, confirm delete, composer collapse, theme, font sizes, chat width, diff layout), saved in localStorage under `cairn:client-settings:v1`. Server settings are the ones the brain keeps for every device.

**Hold**: What keeps an open thread from moving on without the user: a parked task (with Retry), a turn waiting for a Claude slot, or a spent plan window (Limited).

**Projection**: The client's view of a thread: pi-durable's conversation with brain-only documents and Claude stamps removed, image data replaced by references and long strings cut.

**Draft**: A message not yet sent, kept in the browser per thread (or per new-thread draft) so typing never waits on the network.

**Composer**: Where the user writes a turn: the editor, its `/`, `@` and `$` menus, and the footer's model, thinking and mode controls. Docked under an open thread, or inside the hero for a draft.

**Attachment tray**: The composer's row of a draft's attachments (image thumbnails, file rows, upload progress, retry and remove). A send pressed while uploads are in flight waits and fires when the last one answers.

**Hero**: The new-thread page: "What should we build in <project>?" above the composer, with the project picker and the workspace strip.

**Outbox**: The browser's list of sends not yet acknowledged. It resends them after a reconnect, and the brain admits each one once.

**Presence**: A device telling the brain whether Cairn is on screen and which thread it shows, so a push never fires for a thread the user is looking at.

## Asking the user

**Approval**: A durable record in the brain that holds one gated tool call until the user answers it, from any device, or it expires. Executor's own approval prompts are answered by Cairn, never shown as a second question.

_Avoid_: permission request, prompt (for the record)

**Brief**: The written plan a subagent or stone starts from: what to do, why, and how its result will be judged. It is an approval, and nothing delegated starts until it is answered with Go.

_Avoid_: task, spec, ticket

**Parked**: A task pi-durable stopped running after the brain crashed 5 times in a row while it ran without progress. It shows in the UI with a retry; a task waiting on a pending approval is retried at boot by itself.

**Permission mode**: A thread's rule for which tool calls need an approval, after t3code's modes. Full access, the default, asks for none.

_Avoid_: approval policy, trust level

**Plan window**: One rate-limit window of a subscription plan (five hours, seven days), with how much of it is used and when it resets. Unknown is shown as unknown, never as zero.

## Results

**Artifact**: An HTML page or folder an agent publishes to a private `gneiss.run` URL.

_Avoid_: page, report (for the published thing)

**Portal**: A private `gneiss.run` URL in front of a running dev server, on the Beelink or in a stone.

_Avoid_: preview, tunnel

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
