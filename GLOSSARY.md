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

## Conversations

**Thread**: One conversation in the sidebar. Its arms are the project's checkout or its own git worktree on the Beelink.

_Avoid_: session, chat

**Run**: One stretch of a thread's agent loop, from the input that starts it until the answer is final and nothing is queued for it; steers and follow-ups placed along the way join it. pi-durable shows it as `pi.live.run`; RunStarted and RunTerminal bracket it.

**Settle**: To move a thread off the active shelf: by hand, or automatically after `autoSettleDays` of quiet (3 by default; 0 turns it off). A manual settle state wins over the automatic one until cleared.

**Snooze**: To hide a thread until a wake time. The server ends the snooze on time. A failed run or a pending request wakes the thread early.

**Stone**: A thread whose arms run entirely on Cloudflare, on its own branch, started from a prepared base. Still a thread: same transcript, sidebar row and composer.

_Avoid_: orb, cloud thread, sandbox

**Link**: The connection the Beelink dials out to the stones Worker on `workers.dev`, behind an Access service token. A stone's arms are a pi-env daemon in its container, reached over the link through the stone's `Workspace` Durable Object (Cloudflare's name for the object that owns a container; not a Cairn project).

**Stone image**: The base container image every stone starts from (`images/stone`). GitHub Actions builds it and pushes it to Cloudflare's registry, and the stack deploys it by digest.

**Subagent**: A child conversation that a thread or stone spawns through a tool. Its parent owns it, and it is visible and steerable in the UI.

_Avoid_: child agent, worker (except as a role alias)

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

_Avoid_: Claude seat, Claude lane

**Executor**: The self-hosted service on the Beelink that holds every MCP server and third-party credential. Agents reach tools through it.

_Avoid_: MCP gateway, tool server

**Stdio relay**: The supervised process on the Beelink that carries Cairn's stdio MCP servers to Executor over HTTP, one session's server process per call.

_Avoid_: bridge (that is the Claude provider), MCP gateway

**Extension (Cairn's)**: A pi-durable extension Cairn installs in the brain (coding tools, code mode, Executor's tools, the skills, context and Cairn sections, judge tools), in one fixed order.

_Avoid_: plugin

**Guard**: The brain's check on every request and socket: the right host, the owner's Tailscale login copied from Caddy, and the exact origin of Cairn's page.

**Boot repair**: A step the brain runs after the Harness opens and before it accepts sockets, in the fixed order listed in `apps/server/src/BootRepairs.ts`.

**Close hook**: A step SIGTERM runs after every socket has closed and before the stores close, in the fixed order listed in `apps/server/src/ShutdownHooks.ts`, each with its own timeout.

**Command receipt**: The shell store's record of a command id's first answer (the sequence it committed at, or its rejection), so a resent command lands once.

**Events log**: The brain's structured JSON log lines (Effect's `Logger.formatJson`). Judges and the deploy check read it by event name (the `event` annotation), for example `listening` with the bound port.

## Streams and the client

**Shell stream**: The stream of Cairn's own state every client holds: projects and one row per thread, as a snapshot then whole-row updates, resumable from a sequence.

**Thread stream**: The stream of one thread's conversation: a snapshot of its projected view, then the changes to it, with a fresh snapshot on every subscribe.

**Projection**: The client's view of a thread: pi-durable's conversation with brain-only documents and Claude stamps removed, image data replaced by references and long strings cut.

**Draft**: A message not yet sent, kept in the browser per thread (or per new-thread draft) so typing never waits on the network.

**Outbox**: The browser's list of sends not yet acknowledged. It resends them after a reconnect, and the brain admits each one once.

**Presence**: A device telling the brain whether Cairn is on screen and which thread it shows, so a push never fires for a thread the user is looking at.

## Asking the user

**Approval**: A durable record in the brain that holds one gated tool call until the user answers it, from any device, or it expires. Executor's own approval prompts are answered by Cairn, never shown as a second question.

_Avoid_: permission request, prompt (for the record)

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

**Outside judge**: Anything other than the model that did the work that decides whether the work is right: a test, a conformance suite, a screenshot comparison, a verifier on another model family, or the user.

_Avoid_: reviewer (alone), checker

**Attachment**: A file the user adds to a message: an image, a document or text. The brain prepares it when it is uploaded, and the model gets it as content.

**Upload URL**: The one-shot, signed address a client posts one attachment's bytes to. It expires after ten minutes.

**Checkpoint**: A git ref the brain records for a thread's worktree at the end of each turn, so the diff of any turn, or of the whole thread, can be shown.

## Milestones

**Daily driver**: The state in which the user does a full day of real work in Cairn instead of herdr.

**Parity**: Being indistinguishable from t3code in layout and behaviour wherever Cairn copies t3code, as judged side by side.

_Avoid_: polish, "like t3code"
