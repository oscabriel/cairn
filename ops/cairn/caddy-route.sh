#!/usr/bin/env bash
# caddy-route.sh [--check]: add code.gneiss.run -> 127.0.0.1:3774 to the live Caddyfile, above the static
# folders, behind forward_auth to the brain's /_cairn/auth (ADR 0008 as amended; plan "Sign-in").
#
# Writes a candidate beside the live file, validates it with Caddy and checks it is `caddy fmt` clean,
# then (without --check) backs the live file up with a timestamp, replaces it and reloads Caddy. --check
# stops after validation and leaves the live file untouched. Idempotent on `@cairn host code.gneiss.run`.
# Caddy runs in Docker (`docker exec caddy`), which mounts ~/caddy/conf at /etc/caddy. No sudo.
#
# The lb_try_* lines make Caddy retry the connection for up to 3 s instead of answering 502, which hides
# a brain restart (about a second) from page loads, uploads and the auth subrequest.
set -euo pipefail

main() {
	local check=0
	case ${1:-} in
	--check) check=1 ;;
	"") ;;
	*)
		echo "usage: caddy-route.sh [--check]" >&2
		exit 2
		;;
	esac

	local conf=~/caddy/conf
	local live=$conf/Caddyfile
	local marker='	# Agent-generated HTML plans/reports'
	caddy() { docker exec caddy caddy "$@"; }

	if grep -q '@cairn host code.gneiss.run' "$live"; then
		echo "cairn route already present in $live"
		exit 0
	fi
	grep -qF "$marker" "$live" || {
		echo "marker not found in $live: '$marker'" >&2
		exit 1
	}

	local candidate=$conf/Caddyfile.cairn-candidate
	trap 'rm -f "$candidate"' EXIT
	awk -v marker="$marker" '
	  index($0, marker) == 1 && !done {
	    print "\t# Cairn brain (local to Beelink; ops/cairn in the cairn repo)"
	    print "\t@cairn host code.gneiss.run"
	    print "\thandle @cairn {"
	    print "\t\tforward_auth 127.0.0.1:3774 {"
	    print "\t\t\turi /_cairn/auth"
	    print "\t\t\theader_up X-Cairn-Peer {remote_host}"
	    print "\t\t\tcopy_headers X-Cairn-User"
	    print "\t\t\tlb_try_duration 3s"
	    print "\t\t\tlb_try_interval 250ms"
	    print "\t\t}"
	    print "\t\treverse_proxy 127.0.0.1:3774 {"
	    print "\t\t\tlb_try_duration 3s"
	    print "\t\t\tlb_try_interval 250ms"
	    print "\t\t}"
	    print "\t}"
	    print ""
	    done = 1
	  }
	  { print }
	' "$live" >"$candidate"

	local before
	before=$(sha256sum "$live")
	caddy validate --config /etc/caddy/Caddyfile.cairn-candidate --adapter caddyfile 2>&1 | tail -1
	caddy fmt /etc/caddy/Caddyfile.cairn-candidate | diff -q - "$candidate" >/dev/null || {
		echo "candidate is not caddy-fmt clean" >&2
		exit 1
	}
	diff -u "$live" "$candidate" | tail -n +3 || true

	if [[ $check -eq 1 ]]; then
		[[ $(sha256sum "$live") == "$before" ]] || {
			echo "the live Caddyfile changed during the check" >&2
			exit 1
		}
		echo "candidate ok (not applied; live Caddyfile untouched)"
		exit 0
	fi

	cp "$live" "$live.bak-$(date +%Y%m%d-%H%M%S)"
	cat "$candidate" >"$live"
	caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
	echo "cairn route live"
}

main "$@"
