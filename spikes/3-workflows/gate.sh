#!/usr/bin/env bash
# The S3 gate run: a 16 minute job, kill -9 mid-fan-out, a second kill while the job runs on, then the answer.
set -u
cd "$(dirname "$0")"
d=runs/gate; rm -rf "$d"; mkdir -p "$d"
export SPIKE_JOB_SECONDS=${SPIKE_JOB_SECONDS:-960} SPIKE_RUN=gate-$(date +%s)
up() { (node brain.ts "$d" "$@" >>"$d/out.log" 2>&1 & echo $! >"$d/pid"); sleep 3; }
rss() { echo "$(date +%s) $1 $(ps -o rss= -p "$(cat "$d/pid")")" >>"$d/rss.log"; }
up submit gate; rss after-start
sleep 5; rss fanout; kill -9 "$(cat "$d/pid")"; echo "$(date +%s) kill1" >>"$d/marks.log"
sleep 2; up; rss after-restart1
sleep 300; rss at-5min; kill -9 "$(cat "$d/pid")"; echo "$(date +%s) kill2" >>"$d/marks.log"
sleep 2; up; rss after-restart2
sleep 60
id=$(curl -s localhost:3774/ | node -pe 'JSON.parse(require("fs").readFileSync(0)).approvals[0].id')
echo "$(date +%s) answer $(curl -s -X POST "localhost:3774/answer?id=$id&decision=accept")" >>"$d/marks.log"
while ! grep -q '"kind":"idle"' "$d/events.log"; do sleep 10; rss waiting; done
rss done; kill "$(cat "$d/pid")"
echo "effects:"; cat "$d/effects.log"
