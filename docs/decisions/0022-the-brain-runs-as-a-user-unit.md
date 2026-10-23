---
status: accepted
gate: judges/shutdown.sh
---

# The brain runs as a user unit that closes the Harness on SIGTERM

The brain is a systemd user unit, `cairn.service` (lingering is on), listening on `127.0.0.1:3774` behind Caddy. On SIGTERM it stops accepting sockets, closes them with 1001, asks the bridge to stop taking turns, and closes the pi-durable Harness with a five second timeout before closing SQLite, so a clean restart never counts toward pi-durable's crash-loop guard. The unit uses `KillMode=mixed`, `TimeoutStopSec=30`, `SuccessExitStatus=130`, `Restart=always` with a short, stepped delay and `StartLimitIntervalSec=0`, so kill judges never trip systemd's start limit. Deploys check out a commit in a separate live worktree and restart the unit; development never touches the running brain and uses ephemeral loopback ports.

Gate: `judges/shutdown.sh` against a transient unit, then against the deployed `cairn.service`: SIGTERM mid-reply keeps committed work, leaves no `claude` child outside the cgroup, and the unit comes back without tripping the start limit.

## Gate result (wave 5, step 3)

Passed on 2026-10-22 against the transient judge units (waves 2 to 5) and then the deployed `cairn.service`. `judges/shutdown.sh --unit cairn.service` (six `systemctl --user restart`s, each during a `bash sleep 20` turn on `opencode-go/claude-haiku-5-5`): `closed` 2,004 to 2,009 ms, no `shutdown_slow`, `NRestarts` 0 before and after, nothing parked, first snapshot 7 to 13 ms after each reconnect. `judges/durability.ts --unit cairn.service --window streaming` (`kill -9` of the main pid 90 characters into a `claude-bridge/claude-haiku-5-5` reply): both committed entries kept, 1 `claude` child before and 0 outside the cgroup after, kill to up 1,813 ms, first snapshot 8 ms after the socket opened, the reconnected client equal to a fresh one 60 ms after quiet, the unit active with `NRestarts` 0 to 1. Production loads no judge tools, so `bash sleep 20` stands in for `slow` and `mark` on the deployed unit.
