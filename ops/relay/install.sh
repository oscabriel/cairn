#!/usr/bin/env bash
# install.sh [--check]: switch the stdio relay unit cairn-bridges from spikes/5-stdio-bridges to ops/relay
# (ADR 0014). Ports stay 3775 (Chrome's CDP, loopback) and 3776 (the gateway, docker bridge), and the
# unit keeps KillMode=control-group.
#
#   --check  changes nothing: verifies the unit, then diffs it and the rendered gateway config against
#            the unit and config that are running now, and says what the switch-over would do.
#   (none)   installs ops/relay's pinned packages, links the unit, restarts it once, waits for /healthz,
#            and prints the judge to run next (judges/relay-orphans.sh).
#
# Run it from the main checkout (~/Developer/projects/cairn), which the unit's paths name. Nothing here
# prints the gateway key; the config holds only the key file's path. No sudo.
set -euo pipefail

main() {
	local check=0
	case ${1:-} in
	--check) check=1 ;;
	"") ;;
	*)
		echo "usage: install.sh [--check]" >&2
		exit 2
		;;
	esac

	local here expected unit=cairn-bridges
	here=$(cd "$(dirname "$0")" && pwd)
	expected=$HOME/Developer/projects/cairn/ops/relay
	local unit_link=$HOME/.config/systemd/user/$unit.service
	local health=http://172.17.0.1:3776/healthz

	if [[ $here != "$expected" ]]; then
		echo "note: running from $here; the unit names $expected"
		[[ $check -eq 1 ]] || {
			echo "run the switch-over from $expected" >&2
			exit 1
		}
	fi

	# The unit, verified with its paths pointed at this copy, so a check works before the merge too.
	local scratch
	scratch=$(mktemp -d)
	trap 'rm -rf "${scratch:?}"' EXIT
	sed "s|%h/Developer/projects/cairn/ops/relay|$here|g" "$here/$unit.service" >"$scratch/$unit.service"
	systemd-analyze --user verify "$scratch/$unit.service"
	echo "ok: systemd-analyze --user verify $unit.service"

	# What runs now: the linked unit file, and the config the running gateway was started with.
	local installed running_config=""
	installed=$(readlink -f "$unit_link" 2>/dev/null || true)
	echo "installed unit: ${installed:-none}"
	echo "active: $(systemctl --user is-active "$unit" 2>/dev/null || true)"
	local group pid
	group=$(systemctl --user show -P ControlGroup "$unit" 2>/dev/null || true)
	if [[ -n $group && -r /sys/fs/cgroup$group/cgroup.procs ]]; then
		for pid in $(cat "/sys/fs/cgroup$group/cgroup.procs"); do
			running_config=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | awk 'prev == "--config" { print; exit } { prev = $0 }') || true
			[[ -n $running_config ]] && break
		done
	fi
	echo "running gateway config: ${running_config:-none}"

	sed -e "s|@HOME@|$HOME|g" -e "s|@RELAY@|$expected|g" "$here/gateway.template.json" >"$scratch/gateway.json"
	if [[ -n $installed && -f $installed ]]; then
		echo "--- unit diff (running -> ops/relay)"
		diff -u "$installed" "$here/$unit.service" | tail -n +3 || true
	fi
	if [[ -n $running_config && -f $running_config ]]; then
		echo "--- gateway config diff (running -> ops/relay, rendered)"
		diff -u <(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), null, 2))' "$running_config") \
			<(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), null, 2))' "$scratch/gateway.json") | tail -n +3 || true
	fi

	if [[ $check -eq 1 ]]; then
		[[ -x $here/node_modules/.bin/supergateway ]] && echo "ok: packages installed" || echo "would: pnpm install --frozen-lockfile --ignore-workspace in $here"
		echo "would: link $unit_link -> $expected/$unit.service, daemon-reload, enable, restart $unit once, wait for $health"
		echo "check done; nothing changed"
		exit 0
	fi

	(cd "$here" && pnpm install --frozen-lockfile --ignore-workspace)
	ln -sfn "$here/$unit.service" "$unit_link"
	systemctl --user daemon-reload
	systemctl --user enable "$unit" >/dev/null
	systemctl --user restart "$unit"
	local _
	for _ in $(seq 1 100); do
		if curl -fsS -o /dev/null "$health" 2>/dev/null; then
			echo "relay healthy from $here"
			echo "next: judges/relay-orphans.sh $unit $health $here/warm.sh executor"
			exit 0
		fi
		sleep 0.3
	done
	echo "relay did not answer $health; journalctl --user -u $unit" >&2
	exit 1
}

main "$@"
