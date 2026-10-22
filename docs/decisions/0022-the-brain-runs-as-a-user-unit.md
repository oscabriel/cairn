---
status: proposed
gate: judges/shutdown.sh
---

# The brain runs as a user unit that closes the Harness on SIGTERM

The brain is a systemd user unit, `cairn.service` (lingering is on), listening on `127.0.0.1:3774` behind Caddy. On SIGTERM it stops accepting sockets, closes them with 1001, asks the bridge to stop taking turns, and closes the pi-durable Harness with a five second timeout before closing SQLite, so a clean restart never counts toward pi-durable's crash-loop guard. The unit uses `KillMode=mixed`, `TimeoutStopSec=30`, `SuccessExitStatus=130`, `Restart=always` with a short, stepped delay and `StartLimitIntervalSec=0`, so kill judges never trip systemd's start limit. Deploys check out a commit in a separate live worktree and restart the unit; development never touches the running brain and uses ephemeral loopback ports.

Gate: `judges/shutdown.sh` against a transient unit, then against the deployed `cairn.service`: SIGTERM mid-reply keeps committed work, leaves no `claude` child outside the cgroup, and the unit comes back without tripping the start limit.
