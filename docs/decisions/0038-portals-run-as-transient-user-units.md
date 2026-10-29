---
status: accepted
gate: `judges/reach-restart.sh`: the page answers through a brain `kill -9`, and the kill matrix leaves no unit, lease or row behind
---

# Portals run as transient systemd user units

A portal's dev server starts with `systemd-run --user --unit cairn-portal-<id>`, in its own cgroup outside the brain's `KillMode=mixed`, so the page survives a brain restart. Cairn owns it through a row in `cairn.sqlite` (states `opening`, `open`, `stopped`, `removed`) and reconciles at boot. A portal lives 12 hours, six can be open at once, and settling a thread closes nothing. The alternative, running dev servers under the brain or through `porch run`, ties every page to every brain restart and orphans it on `kill -9`.

Cairn calls the porch CLI (porch is Bun-only with no library entry; a call costs about 29 ms) and reloads the Docker Caddy with `docker exec`, which needs no sudo. Artifacts and portals sit behind the owner check (ADR 0008), and `plans.gneiss.run` becomes owner-only. A Caddy reload cuts every open WebSocket, so the Caddyfile gets `stream_close_delay` (`docs/phase-2/notes/reach.md`).

Decided by the user on 2026-10-27, from the phase 2 area notes.

Gate evidence: `judges/reach-restart.sh` passed on `phase2/3F` (restart 18 of 18 probes through a `kill -9` and 18 of 18 through a SIGTERM, twice; matrix 16 of 16; control 1 ok and 17 failed) and again at the wave 3 integration on 2026-10-29: restart 15 of 15 probes through the `kill -9` and 15 of 15 through the SIGTERM, the closed name 404; matrix 16 of 16 (five open steps and three close steps, each rerun or left to the repair) with no unit, porch or row left; control 1 ok and 15 failed, as it must. The installed porch has no `porch lease`, so a portal's porch is `porch add <name> http://127.0.0.1:<port>` with a port Cairn picks from 3100 to 3699. Accepted.
