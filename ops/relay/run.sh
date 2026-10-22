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

# The Chrome the relay's own playwright pins when it is installed, else the newest Chromium Playwright
# has installed (playwright attaches over CDP, so the revision need not match), so a Playwright bump
# or a cache cleanup does not strand the unit on a revision that is gone.
chrome_bin() {
	local pinned newest
	pinned=$(node -e '
		const { createRequire } = require("node:module");
		const mcp = createRequire(process.argv[1] + "/").resolve("@playwright/mcp/package.json");
		console.log(createRequire(mcp)("playwright-core").chromium.executablePath());
	' "$here" 2>/dev/null) || true
	if [[ -n $pinned && -x $pinned ]]; then
		echo "$pinned"
		return
	fi
	newest=$(printf '%s\n' "$HOME"/.cache/ms-playwright/chromium-[0-9]*/chrome-linux64/chrome | sort -V | tail -n 1)
	if [[ ! -x $newest ]]; then
		echo "no Playwright Chromium under ~/.cache/ms-playwright; install one: pnpm dlx playwright install chromium" >&2
		return 1
	fi
	echo "$newest"
}
chrome=$(chrome_bin)
echo "relay chrome: $chrome"

# Without the session bus, Chrome can't ask systemd for a scope of its own
# (app-org.chromium.Chromium-<pid>.scope), which would take it out of this unit's cgroup.
env -u DBUS_SESSION_BUS_ADDRESS "$chrome" --headless=new \
	--remote-debugging-address=127.0.0.1 --remote-debugging-port=3775 \
	--user-data-dir="$state/chrome" --no-first-run --no-default-browser-check about:blank &
"$here/node_modules/.bin/supergateway" --config "$config" &
wait -n
exit 1
