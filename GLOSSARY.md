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

## Conversations

**Thread**: One conversation in the sidebar. Its arms are the project's checkout or its own git worktree on the Beelink.

_Avoid_: session, chat

**Stone**: A thread whose arms run entirely on Cloudflare, on its own branch, started from a prepared base. Still a thread: same transcript, sidebar row and composer.

_Avoid_: orb, cloud thread, sandbox

**Subagent**: A child conversation that a thread or stone spawns through a tool. Its parent owns it, and it is visible and steerable in the UI.

_Avoid_: child agent, worker (except as a role alias)

**Workflow**: A durable script that fans work out across subagents and stones. Every node returns a typed result, writers get verified, and integration is an explicit step.

_Avoid_: pipeline, DAG, job

## Seams and services

**Harness seam**: The boundary between Cairn's orchestration and UI and the agent loop. pi-durable is the only real agent loop behind it; a scripted test harness also sits behind it for conformance tests.

_Avoid_: provider adapter, harness (alone)

**Bridge**: Cairn's Claude provider, which serves the Claude subscription to pi-durable through the unmodified `claude` binary.

_Avoid_: Claude provider, proxy

**Executor**: The self-hosted service on the Beelink that holds every MCP server and third-party credential. Agents reach tools through it.

_Avoid_: MCP gateway, tool server

## Results

**Artifact**: An HTML page or folder an agent publishes to a private `gneiss.run` URL.

_Avoid_: page, report (for the published thing)

**Portal**: A private `gneiss.run` URL in front of a running dev server, on the Beelink or in a stone.

_Avoid_: preview, tunnel

**Verification**: A project's own launch, drive, evidence and cleanup recipe under `.cairn/verify/`, which an outside judge runs against a result.

_Avoid_: e2e, test suite (for the recipe)

**Outside judge**: Anything other than the model that did the work that decides whether the work is right: a test, a conformance suite, a screenshot comparison, a verifier on another model family, or the user.

_Avoid_: reviewer (alone), checker

## Milestones

**Daily driver**: The state in which the user does a full day of real work in Cairn instead of herdr.

**Parity**: Being indistinguishable from t3code in layout and behaviour wherever Cairn copies t3code, as judged side by side.

_Avoid_: polish, "like t3code"
