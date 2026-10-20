#!/usr/bin/env bash
# kill.sh parent|group: park 3 children, kill -9 the brain stand-in, then count surviving claude children.
#   parent: kill only the node process, as the OOM killer or a crash would
#   group:  kill the whole process group, as `systemctl stop` with KillMode=control-group would
set -euo pipefail
cd "$(dirname "$0")"
how=$1
log=runs/kill-$how.jsonl
PARK_MS=600000 setsid node children.ts 3 > "$log" 2>&1 &
pid=$!
until grep -q '"parked"' "$log"; do kill -0 $pid 2>/dev/null || { cat "$log"; exit 1; }; sleep 0.1; done
pids=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").find(x=>x.includes("\"parked\""));console.log(JSON.parse(l).data.pids.join(" "))' "$log")
case $how in parent) kill -9 $pid ;; group) kill -9 -- -$pid ;; esac
for wait in 1 5 30; do
  sleep_until=$((SECONDS + wait)); while [ $SECONDS -lt $sleep_until ]; do sleep 0.5; done
  alive=0; for p in $pids; do kill -0 $p 2>/dev/null && alive=$((alive + 1)); done
  echo "$how: ${wait}s after kill -9, $alive of 3 claude children alive"
  [ $alive -eq 0 ] && break
done
for p in $pids; do kill -0 $p 2>/dev/null && { echo "cleaning up $p"; kill -9 $p; }; done
true
