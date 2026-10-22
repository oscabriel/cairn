#!/usr/bin/env bash
# kill.sh <name> held|answer|pair
#   held:   kill -9 while the mark tool runs, so the bridge holds Claude's tool call open; then resume
#   answer: kill -9 after the tool returned, while Claude writes the answer; then resume
#   pair:   two conversations at once, no kill; reports the peak number of children
# Ported from cairn-v1 spikes/01-bridge/kill.sh at 1a5cd4a56e84bfb187940428d144b584d2e084b0.
set -euo pipefail
cd "$(dirname "$0")"
name=$1 when=$2
R=$PWD/runs/$name
rm -rf "$R" && mkdir -p "$R"
export CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH=$R/bridge.log

if [ "$when" = pair ]; then
  MARK_SLEEP_MS=3000 timeout 240 node --import tsx worker.ts pair "$R" > "$R/pair.jsonl" 2>&1 || true
  grep -e '"peak_children"' -e '"settled"' -e '"env"' -e '"hook"' "$R/pair.jsonl" | cut -c1-300
  exit 0
fi

case $when in
  held) export MARK_SLEEP_MS=60000; after=1 ;;
  answer) export MARK_SLEEP_MS=0; after=0.4 ;;
  *) echo "held|answer|pair" >&2; exit 2 ;;
esac

# Own process group, so kill -9 takes the claude child with it, as a systemd unit stop would.
setsid node --import tsx worker.ts start "$R" > "$R/start.jsonl" 2>&1 &
pid=$!
until [ -s "$R/marks.log" ]; do
  kill -0 $pid 2>/dev/null || { echo "worker exited before the tool ran"; tail -5 "$R/start.jsonl"; exit 1; }
  sleep 0.05
done
sleep "$after"
kill -9 -- -$pid
wait $pid 2>/dev/null || true
echo "killed pgid $pid $after s after the tool started"
sleep 1
left=$( (pgrep -g "$pid" || true) | wc -l)
echo "processes left in the killed process group: $left"

MARK_SLEEP_MS=0 timeout 240 node --import tsx worker.ts resume "$R" > "$R/resume.jsonl" 2>&1 || true
echo "--- start"
grep -e '"env"' -e '"hook"' -e '"child"' "$R/start.jsonl" | cut -c1-300 | head -8
echo "--- resume"
grep -e '"assistant"' -e '"settled"' -e '"child"' "$R/resume.jsonl" | cut -c1-400
echo "--- marks.log ($(wc -l < "$R/marks.log") lines)"
cat "$R/marks.log"
