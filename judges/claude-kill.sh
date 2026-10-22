#!/usr/bin/env bash
# J2 and J9 on the bridge (plan 3F): `kill -9` of the judge brain while a Claude reply streams,
# while a `bash` tool call is held in the bridge, and while Claude writes its answer after the
# tool's result; then a clean restart and a stop with a live `claude` child. Each case runs
# `judges/claude-kill.ts` on its own transient unit (see its header for every check):
#
#   judges/claude-kill.sh [streaming] [parked] [answer]    (default: all three)
#
# Needs `judge-main.ts --models real` (the real Claude bridge) and Claude Code's login in
# `~/.claude`. Prints one JSON line per case and exits 0 when every case passed. Uses only
# `systemctl --user`, node and the user's own `claude` login; no sudo, no secrets printed. Costs a
# few cents of plan usage on Haiku.
set -euo pipefail

cd "$(dirname "$0")/.."

cases=("$@")
((${#cases[@]} > 0)) || cases=(streaming parked answer)

failures=0

for name in "${cases[@]}"; do
	if line=$(node judges/claude-kill.ts --case "$name" | grep '^{'); then
		echo "$line"
	else
		echo "${line:-$name: no result line}"
		failures=$((failures + 1))
	fi
done

if ((failures > 0)); then
	echo "claude-kill: ${failures} of ${#cases[@]} cases failed"
	exit 1
fi

echo "claude-kill: every case passed"
