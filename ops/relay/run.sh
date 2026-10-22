#!/usr/bin/env bash
# The relay unit's main process (port of spikes/5-stdio-bridges/bridges/run.sh). It renders
# gateway.template.json for this machine, starts the shared headless Chrome (playwright attaches to it
# over CDP, so pages outlive Executor's one-call MCP sessions) and the gateway, and exits as soon as
# either stops, so systemd restarts the pair. Both stay in the unit's cgroup.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
state=$HOME/.local/state/cairn
mkdir -p "$state/chrome" "$state/playwright" "$state/relay"

config=$state/relay/gateway.json
sed -e "s|@HOME@|$HOME|g" -e "s|@RELAY@|$here|g" "$here/gateway.template.json" >"$config.tmp"
mv "$config.tmp" "$config"

# Without the session bus, Chrome can't ask systemd for a scope of its own
# (app-org.chromium.Chromium-<pid>.scope), which would take it out of this unit's cgroup.
env -u DBUS_SESSION_BUS_ADDRESS "$HOME/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome" --headless=new \
	--remote-debugging-address=127.0.0.1 --remote-debugging-port=3775 \
	--user-data-dir="$state/chrome" --no-first-run --no-default-browser-check about:blank &
"$here/node_modules/.bin/supergateway" --config "$config" &
wait -n
exit 1
