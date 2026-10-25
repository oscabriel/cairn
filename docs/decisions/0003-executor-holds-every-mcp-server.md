# Executor holds every MCP server and credential

MCP servers and third-party credentials live in a self-hosted Executor 2.0 on the Beelink (Docker, pinned by digest, a systemd user unit, `exec.gneiss.run`). Cairn holds one OAuth grant on one scoped connection and narrows it per project itself, because v1's per-project Executor setup was rejected outright. Agents reach Executor's six tools through Cairn proxies under pi's code mode, so the model's tool list stays fixed however many servers exist.

## Consequences

- The per-project scope is advisory. It holds only for a model that calls Executor through Cairn's proxies: thread tools run unconfined as the user, so a thread's `bash` can read the grant from `cairn.sqlite` and call Executor on loopback directly. Making it hold means sandboxing thread tools (bubblewrap or a second uid, with Cairn's data and the logins masked), which is not done; it would need its own ADR (decided 2026-10-24, review task T22).
- Cairn's grant is never shared with the pi CLI or Claude Code: Executor treats a reused rotated refresh token as theft.
- Approvals use model elicitation mode with Cairn's queue. On boot, decline every orphaned approval; never auto-retry after an Executor restart.
- Back up the data volume, key files included, before every upgrade.
- Servers migrated from the user's setup: `convex` and `playwright` (both stdio, ADR 0014). `myr` is out of scope: the user is retiring it (2026-10-21), so the tools target covers `convex`, `playwright` and GitHub.
