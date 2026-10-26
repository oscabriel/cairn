#!/usr/bin/env bash
# The shutdown judge (notes/edges.md, "Shutdown"; ADR 0022): a clean restart closes the brain in
# under 5 s and is not a crash, a crash is one, and a tool that ignores its signal is cut off by
# systemd. It drives the judge brain through `judges/durability.ts` (the same transient units with
# the production unit's kill settings) and reads what systemd and the brain wrote:
#
# 1. sigterm-six: six `systemctl --user restart`s while `slow` runs. Each stop logs `closing` then
#    `closed <ms>` with ms under 5,000, no `shutdown_slow`, systemd's Stopping-to-Stopped time under
#    5,000 ms, NRestarts unchanged, nothing parked, and `mark` runs once (durability.ts checks the
#    last three).
# 2. kill-six: five `kill -9`s while `slow` runs park its task; `thread.retryTask` completes the
#    turn with each effect once (durability.ts).
# 3. Control: `stubborn` ignores its abort signal under TimeoutStopSec=3, so systemd must log the
#    stop timing out and SIGKILL the brain, and the stop must take at least 3 s. If the control does
#    not show that, the 5 s check above proves nothing and the judge fails.
#
#   judges/shutdown.sh
#   judges/shutdown.sh --unit cairn.service
#
# `--unit` judges the deployed unit instead (plan 5F): production loads no judge tools, so
# `judges/deployed-unit.ts restarts` makes six restarts during a `bash sleep 20` turn on a cheap
# real model and checks `closed <ms>` under 5,000, NRestarts unchanged and nothing parked.
#
# Prints one line per check and exits 0 when all hold. Uses only `systemctl --user`, `journalctl
# --user` and node; no sudo, no secrets.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ${1:-} == --unit ]]; then
	exec node judges/deployed-unit.ts restarts --unit "${2:?--unit needs a unit name}" "${@:3}"
fi

limit_ms=5000
failures=0

say() { printf '%-28s %s\n' "$1" "$2"; }
fail() { say "$1" "FAIL  $2"; failures=$((failures + 1)); }
pass() { say "$1" "PASS  $2"; }

# The kept window dirs, removed however the script ends.
kept=()
trap 'for kept_dir in "${kept[@]}"; do if [[ -n $kept_dir ]]; then rm -rf "$kept_dir"; fi; done' EXIT

# One durability window with --keep; prints its JSON line, or nothing. A failing window exits
# nonzero, which must reach its FAIL line rather than end the script under `set -e`.
window() { node judges/durability.ts --keep --window "$1" | grep '"window"' || true; }

# A window's notes, or why there are none.
notes() { if [[ -n $1 ]]; then field "$1" notes; else echo "the window printed no result"; fi; }

# A field of a window's JSON line; empty when the line is missing or not JSON.
field() { node -e 'try { const v = JSON.parse(process.argv[1])[process.argv[2]]; process.stdout.write(v === undefined ? "" : String(v)); } catch {}' "$1" "$2"; }

# Milliseconds from each "Stopping" to the next "Stopped" line of the unit in systemd's journal.
stop_times() {
	journalctl --user --no-pager -o short-unix -u "$1.service" |
		awk '/ Stopping / { start = $1 } / Stopped / && start { printf "%d\n", ($1 - start) * 1000; start = 0 }'
}

# --- 1. Six clean restarts ---------------------------------------------------------------------
line=$(window sigterm-six)
unit=$(field "$line" unit)
dir=$(field "$line" dir)
kept+=("$dir")

if [[ $(field "$line" pass) == true ]]; then
	pass sigterm-six "durability: $(field "$line" notes)"
else
	fail sigterm-six "durability: $(notes "$line")"
fi

if [[ -n $dir && -f $dir/events.log ]]; then
	closing=$(grep -c '"event":"closing"' "$dir/events.log" || true)
	closed_ms=$(grep -o '"event":"closed","ms":[0-9]*' "$dir/events.log" | grep -o '[0-9]*$' || true)
	closed=$(grep -c . <<<"$closed_ms" || true)
	slow=$(grep -c '"event":"shutdown_slow"' "$dir/events.log" || true)
	worst_closed=$(sort -n <<<"$closed_ms" | tail -n 1)

	if ((closing >= 6 && closed >= 6 && slow == 0 && ${worst_closed:-0} < limit_ms)); then
		pass closing-closed "closing ${closing}, closed ${closed}, worst closed ${worst_closed} ms, shutdown_slow ${slow}"
	else
		fail closing-closed "closing ${closing}, closed ${closed}, worst closed ${worst_closed:-none} ms, shutdown_slow ${slow}"
	fi

	times=$(stop_times "$unit")
	worst_stop=$(sort -n <<<"$times" | tail -n 1)
	stops=$(grep -c . <<<"$times" || true)

	if ((stops >= 6 && ${worst_stop:-limit_ms} < limit_ms)); then
		pass stop-time "systemd stops ${stops}, worst ${worst_stop} ms ($(tr '\n' ' ' <<<"$times"))"
	else
		fail stop-time "systemd stops ${stops}, worst ${worst_stop:-none} ms"
	fi

else
	fail closing-closed "no events log from the sigterm-six window"
fi

# --- 2. Five crashes park, retry finishes ------------------------------------------------------
line=$(window kill-six)
dir=$(field "$line" dir)
kept+=("$dir")

if [[ $(field "$line" pass) == true ]]; then
	pass kill-six "restarts $(field "$line" killToUp) ms, effects $(node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]).effects))' "$line"), $(field "$line" notes)"
else
	fail kill-six "$(notes "$line")"
fi

# --- 3. Control: a tool that ignores its signal ------------------------------------------------
line=$(window stubborn-control)
unit=$(field "$line" unit)
dir=$(field "$line" dir)
kept+=("$dir")

if [[ -n $unit ]]; then
	journal=$(journalctl --user --no-pager -o cat -u "$unit.service")
	killed=$(grep -c -E "timed out\. Killing|SIGKILL" <<<"$journal" || true)
	times=$(stop_times "$unit")
	first_stop=$(head -n 1 <<<"$times")

	if ((killed > 0 && ${first_stop:-0} >= 3000)); then
		pass control "stubborn stop took ${first_stop} ms and systemd killed it (${killed} lines)"
	else
		fail control "expected a SIGKILL after TimeoutStopSec=3; stop ${first_stop:-none} ms, kill lines ${killed}"
	fi
else
	fail control "the stubborn window did not start: $(notes "$line")"
fi

if ((failures > 0)); then
	echo "shutdown judge: ${failures} checks failed"
	exit 1
fi

echo "shutdown judge: every check passed"
