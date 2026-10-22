#!/usr/bin/env bash
# hold.sh <server> [port] [host]: open a relay session for one stdio server and leave it open, as a client
# killed mid-session would (port of spikes/5-stdio-bridges/hold.ts, in curl so the relay needs no MCP
# SDK). The gateway spawns the server's child on `initialize`; the session then lives until the relay's
# 10 minute timeout. Prints the session id.
#
# The key is read from ~/.config/cairn/bridges.key and handed to curl on stdin as a header, so it never
# appears in argv or output.
set -euo pipefail
server=${1:?usage: hold.sh <server> [port] [host]}
port=${2:-3776}
host=${3:-172.17.0.1}
url=http://$host:$port/$server/mcp
key_header() { printf 'Authorization: Bearer %s\n' "$(tr -d '[:space:]' <"$HOME/.config/cairn/bridges.key")"; }
post() {
	key_header | curl -sS -m 30 -H @- -H 'Content-Type: application/json' \
		-H 'Accept: application/json, text/event-stream' "$@" "$url"
}

session=$(post -D - -o /dev/null -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cairn-relay-hold","version":"0"}}}' |
	tr -d '\r' | awk -F': ' 'tolower($1) == "mcp-session-id" { print $2 }')
[[ -n $session ]] || {
	echo "no session from $url" >&2
	exit 1
}
post -o /dev/null -H "Mcp-Session-Id: $session" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
post -o /dev/null -H "Mcp-Session-Id: $session" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
echo "$session"
