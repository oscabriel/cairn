#!/usr/bin/env bash
# sweep.sh: RSS at N = 1..6 on Sonnet, then time to first token per model at N = 1 (3 runs each).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p runs
: > runs/sweep.jsonl
for n in 1 2 3 4 5 6; do
  PARK_MS=4000 MODEL=claude-sonnet-5-5 timeout 180 node children.ts $n | grep '"summary"' >> runs/sweep.jsonl
done
for model in claude-haiku-5-5 claude-sonnet-5-5 claude-opus-5-5; do
  for r in 1 2 3; do
    PARK_MS=0 MODEL=$model timeout 180 node children.ts 1 | grep '"summary"' >> runs/sweep.jsonl
  done
done
