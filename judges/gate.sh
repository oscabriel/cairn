#!/usr/bin/env bash
# The sign-in gate's judge (ADR 0008 as amended; plan "Sign-in"), run on the Beelink against the live
# code.gneiss.run route and the brain on 127.0.0.1:3774. Ported from cairn-v1 spikes/05-signin/verify.sh
# (cairn-v1 at 1a5cd4a): same structure, Cairn's routes and the exact-owner rule.
#
#   judges/gate.sh [--port 3774] [--control-port <port> --control-owner <login>]
#
# Cases, one JSON line each ({"case", "pass", "expected", "got"}), exit status = failed cases:
#   - every tailnet node asked of /_cairn/auth: 200 with X-Cairn-User = owner exactly when the node's
#     login is the configured owner and it has no tags, else 403 (a new device is covered with no edit);
#   - refused paths: code.gneiss.run reached over loopback and the LAN, with every forgeable header;
#   - the admitted path over the tailnet: the app shell and a WebSocket upgrade;
#   - direct hits on the brain's port: no copied identity is 403, a wrong Host is 421;
#   - the Origin matrix for POST, DELETE and WebSocket upgrades, and Sec-Fetch-Site: cross-site;
#   - control: the node rows judged against a made-up owner must disagree with what the brain did, so
#     the judge can fail. With --control-port and --control-owner (a second brain started with another
#     owner), its node rows must follow that owner instead, which proves the brain reads identity.
#
# Reads ~/.config/cairn/cairn.json (owner, host, origin; no secrets). Never prints header values a
# client did not send.
set -uo pipefail

port=3774
control_port=""
control_owner=""
while [[ $# -gt 0 ]]; do
	case $1 in
	--port)
		port=$2
		shift 2
		;;
	--control-port)
		control_port=$2
		shift 2
		;;
	--control-owner)
		control_owner=$2
		shift 2
		;;
	*)
		echo "usage: gate.sh [--port 3774] [--control-port <port> --control-owner <login>]" >&2
		exit 2
		;;
	esac
done

config=${CAIRN_CONFIG_FILE:-$HOME/.config/cairn/cairn.json}
field() { node --input-type=module -e 'import { readFileSync } from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1], "utf-8"))[process.argv[2]] ?? "")' "$config" "$1"; }
owner=$(field owner)
host=$(field host)
origin=$(field origin)
[[ -n $owner && -n $host && -n $origin ]] || {
	echo "gate.sh needs owner, host and origin in $config (ops/cairn/install.sh writes it)" >&2
	exit 2
}
tailnet_ip=$(tailscale ip -4 | head -1)
lan_ip=$(ip -4 route get 1.1.1.1 | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')

failed=0
emit() { # case expected got
	local pass=false
	[[ $2 == "$3" ]] && pass=true
	[[ $pass == true ]] || failed=$((failed + 1))
	printf '{"case":"%s","pass":%s,"expected":"%s","got":"%s"}\n' "$1" "$pass" "$2" "$3"
}
emit_not() { # case got: passes when got is a response that is not a refusal
	local pass=true
	case $2 in 403 | 421 | 000) pass=false ;; esac
	[[ $pass == true ]] || failed=$((failed + 1))
	printf '{"case":"%s","pass":%s,"expected":"not 403/421","got":"%s"}\n' "$1" "$pass" "$2"
}
code() { curl -s -m 5 -o /dev/null -w '%{http_code}' "$@"; }
# A WebSocket upgrade; a 101 holds the connection open until -m, so the timeout is expected.
ws() { curl -s -o /dev/null -w '%{http_code}' --http1.1 -m 2 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
	-H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$@" || true; }

# Every node on the tailnet: "<ip> <stable id> <login> <tag count>".
nodes() {
	tailscale status --json | node --input-type=module -e '
		let text = "";
		for await (const chunk of process.stdin) text += chunk;
		const status = JSON.parse(text);
		for (const node of [status.Self, ...Object.values(status.Peer ?? {})]) {
			const ip = (node.TailscaleIPs ?? [])[0];
			if (ip === undefined) continue;
			const login = status.User?.[String(node.UserID)]?.LoginName ?? "none";
			console.log(ip, node.ID, login, (node.Tags ?? []).length);
		}
	'
}

# What /_cairn/auth on <port> answers for each node: "<id> <status> <copied user>".
ask_nodes() {
	local auth_port=$1 ip id login tags response status user
	while read -r ip id login tags; do
		response=$(curl -s -m 5 -o /dev/null -D - -w '%{http_code}' -H "Host: $host" -H "X-Cairn-Peer: $ip" \
			"http://127.0.0.1:$auth_port/_cairn/auth" | tr -d '\r')
		status=${response##*$'\n'}
		user=$(awk -F': ' 'tolower($1) == "x-cairn-user" { print $2 }' <<<"$response")
		echo "$id $login $tags $status ${user:--}"
	done < <(nodes)
}

# Expected for a node under <owner>: "200 <owner>" or "403 -".
want_for() { # login tags owner
	if [[ $1 == "$3" && $2 == 0 ]]; then echo "200 $3"; else echo "403 -"; fi
}

echo "## every tailnet node, asked of /_cairn/auth on $port" >&2
answers=$(ask_nodes "$port")
control_disagreements=0
while read -r id login tags status user; do
	emit "node $id" "$(want_for "$login" "$tags" "$owner")" "$status $user"
	[[ $(want_for "$login" "$tags" "control-nobody@github") == "$status $user" ]] || control_disagreements=$((control_disagreements + 1))
done <<<"$answers"
emit "control: rows judged against a made-up owner disagree" "yes" "$([[ $control_disagreements -gt 0 ]] && echo yes || echo no)"

if [[ -n $control_port ]]; then
	echo "## control brain on $control_port with owner $control_owner" >&2
	while read -r id login tags status user; do
		emit "control node $id" "$(want_for "$login" "$tags" "$control_owner")" "$status $user"
	done < <(ask_nodes "$control_port")
fi

echo "## refused paths to $host" >&2
forged=(-H "X-Cairn-Peer: $tailnet_ip" -H "X-Forwarded-For: $tailnet_ip" -H "X-Real-IP: $tailnet_ip"
	-H "Forwarded: for=$tailnet_ip" -H "X-Cairn-User: $owner")
for via in "loopback 127.0.0.1" "lan $lan_ip"; do
	read -r name address <<<"$via"
	resolve=(--resolve "$host:443:$address")
	emit "GET / via $name" 403 "$(code "${resolve[@]}" "https://$host/")"
	emit "GET /api/shell via $name, forged headers" 403 "$(code "${resolve[@]}" "${forged[@]}" "https://$host/api/shell")"
	emit "POST via $name with Cairn's Origin, forged headers" 403 "$(code "${resolve[@]}" "${forged[@]}" -X POST -H "Origin: $origin" -d x "https://$host/api/load-report")"
	emit "WebSocket via $name with Cairn's Origin, forged headers" 403 "$(ws "${resolve[@]}" "${forged[@]}" -H "Origin: $origin" "https://$host/ws?protocol=1")"
done

echo "## admitted path over the tailnet ($tailnet_ip)" >&2
admitted=(--resolve "$host:443:$tailnet_ip")
emit "GET / admitted" 200 "$(code "${admitted[@]}" -H 'Accept: text/html' "https://$host/")"
emit "WebSocket admitted with Cairn's Origin" 101 "$(ws "${admitted[@]}" -H "Origin: $origin" "https://$host/ws?protocol=1")"

echo "## direct hits on 127.0.0.1:$port" >&2
direct=http://127.0.0.1:$port
emit "direct / without the copied identity" 403 "$(code -H "Host: $host" "$direct/")"
emit "direct /api/shell without the copied identity" 403 "$(code -H "Host: $host" "$direct/api/shell")"
emit "direct /ws without the copied identity" 403 "$(ws -H "Host: $host" -H "Origin: $origin" "$direct/ws?protocol=1")"
emit "direct /_cairn/auth without X-Cairn-Peer" 403 "$(code -H "Host: $host" "$direct/_cairn/auth")"
emit "direct with a wrong Host" 421 "$(code -H "Host: evil.example" -H "X-Cairn-User: $owner" "$direct/")"

echo "## Origin matrix on the admitted path" >&2
for method in POST DELETE; do
	emit "$method without Origin" 403 "$(code "${admitted[@]}" -X "$method" -d x "https://$host/api/load-report")"
	for bad in "https://evil.example" "https://$host.evil.example" "http://$host" "https://plans.gneiss.run"; do
		emit "$method from $bad" 403 "$(code "${admitted[@]}" -X "$method" -H "Origin: $bad" -d x "https://$host/api/load-report")"
	done
	emit_not "$method from Cairn's origin" "$(code "${admitted[@]}" -X "$method" -H "Origin: $origin" -d x "https://$host/api/load-report")"
done
emit "WebSocket without Origin" 403 "$(ws "${admitted[@]}" "https://$host/ws?protocol=1")"
for bad in "https://evil.example" "https://$host.evil.example" "http://$host" "https://plans.gneiss.run"; do
	emit "WebSocket from $bad" 403 "$(ws "${admitted[@]}" -H "Origin: $bad" "https://$host/ws?protocol=1")"
done
emit "GET /api/shell with Sec-Fetch-Site: cross-site" 403 "$(code "${admitted[@]}" -H 'Sec-Fetch-Site: cross-site' "https://$host/api/shell")"
emit "GET /api/shell with Sec-Fetch-Site: same-origin" 200 "$(code "${admitted[@]}" -H 'Sec-Fetch-Site: same-origin' "https://$host/api/shell")"

echo "## $failed failed" >&2
exit "$failed"
