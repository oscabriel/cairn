---
status: accepted
gate: S5
---

# Stdio MCP servers run behind a supervised stdio relay

Executor v2 can't start local processes, so each stdio MCP server (`convex`, `playwright`) runs behind the stdio relay, supergateway on the Beelink, registered in Executor as one hand-written app (`mcpRouter` with an API-key account). One relay serves every server on `172.17.0.1:3776`, the docker bridge, behind an API key, and one systemd user unit owns it: the unit's cgroup ends every child when the relay stops or dies, which supergateway's own process groups would not. Cairn manages the unit and its config; it doesn't parent the processes. A server that runs one project per process gets a relay entry per project, but `convex` doesn't need one: each call names its project. A server that keeps state in its own process gets a long-lived backend the per-call children attach to, because Executor opens a new MCP session for every call. Playwright attaches to one shared headless Chrome over CDP. A server that can't be carried this way gets an exception agreed with the user.

Executor reaches the relay only with `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true`, which lets every app on the instance reach private addresses, plus an allowed HTTP origin and a ufw rule for `docker0`.

Gate S5: an agent in a thread calls `convex` and `playwright` through Executor, and a Cairn or Executor restart leaves no orphaned relay process. Measured in `spikes/5-stdio-bridges/NOTES.md`, judged by `judges/relay-orphans.sh`.
