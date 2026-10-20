#!/usr/bin/env bash
# caddy-route.sh [--check]: add exec.gneiss.run -> 127.0.0.1:4400 to the live Caddyfile, above the static folders.
# Backs the Caddyfile up first, validates with Caddy, and reloads. --check validates a candidate without touching the live file.
set -euo pipefail
conf=~/caddy/conf
live=$conf/Caddyfile
marker='	# Agent-generated HTML plans/reports'
caddy() { docker exec caddy caddy "$@"; }
if grep -q '@exec host exec.gneiss.run' "$live"; then echo "exec route already present"; exit 0; fi
grep -qF "$marker" "$live" || { echo "marker not found in $live" >&2; exit 1; }
candidate=$conf/Caddyfile.candidate
awk -v marker="$marker" '
  index($0, marker) == 1 && !done {
    print "\t# Executor 2.0 for Cairn (local to Beelink; ops/executor in the cairn repo)"
    print "\t@exec host exec.gneiss.run"
    print "\thandle @exec {"
    print "\t\treverse_proxy localhost:4400"
    print "\t}"
    print ""
    done = 1
  }
  { print }
' "$live" > "$candidate"
trap 'rm -f "$candidate"' EXIT
caddy validate --config /etc/caddy/Caddyfile.candidate --adapter caddyfile 2>&1 | tail -1
caddy fmt /etc/caddy/Caddyfile.candidate | diff -q - "$candidate" >/dev/null || { echo "candidate is not caddy-fmt clean" >&2; exit 1; }
[[ ${1:-} == --check ]] && { echo "candidate ok (not applied)"; exit 0; }
cp "$live" "$live.bak-$(date +%Y%m%d-%H%M%S)"
cat "$candidate" > "$live"
caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
echo "exec route live"
