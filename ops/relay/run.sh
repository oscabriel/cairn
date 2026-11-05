#!/usr/bin/env bash
# The relay unit's main process (port of spikes/5-stdio-bridges/bridges/run.sh). It renders
# gateway.template.json for this machine and execs the gateway, so systemd restarts it when it stops
# and it stays in the unit's cgroup.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
state=$HOME/.local/state/cairn
mkdir -p "$state/relay"

config=$state/relay/gateway.json
sed -e "s|@HOME@|$HOME|g" -e "s|@RELAY@|$here|g" "$here/gateway.template.json" >"$config.tmp"
mv "$config.tmp" "$config"

exec "$here/node_modules/.bin/supergateway" --config "$config"
