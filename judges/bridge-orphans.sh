#!/usr/bin/env bash
# Judge for gate S5 (ADR 0014): no stdio MCP bridge process outlives the event that should end it.
#
#   judges/bridge-orphans.sh <unit> <health-url> <warm-command> [<peer-unit>]
#
# Each case runs the warm command (which should leave sessions open, so children are running),
# records every PID in the unit's cgroup, applies one event, waits for the unit to answer its
# health URL again, and counts the recorded PIDs still alive outside the cgroup. Those are orphans.
# Children left inside the cgroup are reported too: they belong to sessions the bridge still holds.
# With a peer unit (the bridges' client, such as Executor), one more case restarts the peer.
# Exit status is the number of failed cases.
set -euo pipefail

unit=$1 health=$2 warm=$3 peer=${4:-}
cgroup_of() { systemctl --user show -P ControlGroup "$1"; }
procs() { cat "/sys/fs/cgroup$(cgroup_of "$unit")/cgroup.procs" 2>/dev/null || true; }
main_pid() { systemctl --user show -P MainPID "$unit"; }
now_ms() { date +%s%3N; }

# Milliseconds from $1 (the event) until the health URL answers.
wait_healthy() {
  local start=$1
  for _ in $(seq 1 200); do
    curl -fsS -o /dev/null "$health" 2>/dev/null && { echo $(( $(now_ms) - start )); return 0; }
    sleep 0.1
  done
  echo timeout; return 1
}

# Descendants of the main process that are not in its cgroup. A process can ask systemd to move
# it (Chrome does, over the session bus), and then stopping the unit no longer reaches it.
escaped_pids() {
  local cgroup pids next pid
  cgroup=$(procs)
  pids=$(main_pid)
  while [[ -n $pids ]]; do
    next=""
    for pid in $pids; do
      grep -qx "$pid" <<<"$cgroup" || echo "$pid"
      next+=" $(cat /proc/"$pid"/task/*/children 2>/dev/null || true)"
    done
    pids=$(xargs <<<"$next")
  done
}

# A recorded PID is an orphan when it is alive and not in the unit's current cgroup.
orphans() {
  local before=$1 now pid n=0 list=""
  now=$(procs)
  for pid in $before; do
    [[ -d /proc/$pid ]] || continue
    grep -qx "$pid" <<<"$now" && continue
    n=$((n + 1)); list+=" $pid:$(tr '\0' ' ' </proc/"$pid"/cmdline | cut -c1-60)"
  done
  echo "$n${list:+ ($list)}"
}

failed=0
run_case() {
  local name=$1 event=$2 out before after start healthy found
  bash -c "$warm" >/dev/null
  # Escaped processes join the recorded set, so the orphan count catches any that outlive the event.
  out=$(escaped_pids | xargs)
  if [[ -n $out ]]; then
    printf '%-18s escaped the cgroup before the event: %s\n' "$name" "$out"
    failed=$((failed + 1))
  fi
  before=$(procs; escaped_pids)
  start=$(now_ms)
  "$event"
  # Give systemd a moment to notice, so the old gateway can't answer.
  sleep 1
  healthy=$(wait_healthy "$start") || true
  sleep 2
  found=$(orphans "$before")
  after=$(procs | wc -l)
  printf '%-18s before %2d procs, healthy after %6s ms, after %2d procs, orphans %s\n' \
    "$name" "$(wc -w <<<"$before")" "$healthy" "$after" "$found"
  [[ ${found%% *} == 0 && $healthy != timeout ]] || failed=$((failed + 1))
}

# The main process is whatever systemd started; a child is any other process in the cgroup.
kill9_main() { kill -9 "$(main_pid)"; }
# The newest process: a session's server rather than anything the unit started with.
kill9_child() { kill -9 "$(procs | grep -vx "$(main_pid)" | sort -n | tail -1)"; }
restart_unit() { systemctl --user restart "$unit"; }
stop_start_unit() { systemctl --user stop "$unit" && systemctl --user start "$unit"; }

run_case kill9-main kill9_main
run_case kill9-child kill9_child
run_case restart-unit restart_unit
run_case stop-start-unit stop_start_unit
restart_peer() { systemctl --user restart "$peer"; }
[[ -n $peer ]] && run_case restart-peer restart_peer
exit "$failed"
