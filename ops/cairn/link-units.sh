#!/usr/bin/env bash
# link-units.sh [--check] <live worktree>: link the user units that ship beside cairn.service into
# the user's systemd folder (`CAIRN_SYSTEMD_USER_DIR`, default ~/.config/systemd/user) when they have
# no link yet. ops/cairn/deploy.sh runs it after the checkout and before its daemon-reload, so a unit a
# commit adds (cairn-nightly-failed.service, which the nightly's OnFailure= starts, ADR 0054) is
# known to systemd from the deploy that ships it, without rerunning ops/cairn/install.sh.
#
# A link that already points at the live worktree's file is kept. A link that points anywhere else is
# left as it is and named, since someone chose it; install.sh relinks it. A unit the live worktree
# does not carry is not linked. It enables and starts nothing (install.sh enables the timer once),
# and never reloads systemd: the caller does. --check changes nothing and says what a deploy would
# link. Always exits 0 on a usage it understands.
set -euo pipefail

UNITS=(cairn-nightly.service cairn-nightly.timer cairn-nightly-failed.service)

main() {
	local check=0
	if [[ ${1:-} == --check ]]; then
		check=1
		shift
	fi
	if [[ $# -ne 1 ]]; then
		echo "usage: link-units.sh [--check] <live worktree>" >&2
		exit 2
	fi

	local live=$1
	local dir=${CAIRN_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}
	local name source link target
	for name in "${UNITS[@]}"; do
		source=$live/ops/cairn/$name
		link=$dir/$name
		target=$(readlink "$link" 2>/dev/null || true)
		if [[ $target == "$source" ]]; then
			continue
		fi
		if [[ -n $target || -e $link ]]; then
			echo "warning: $link points to ${target:-a file}, not $source; left as it is (ops/cairn/install.sh relinks it)" >&2
			continue
		fi
		if [[ $check -eq 1 ]]; then
			echo "a deploy would link $link -> $source"
			continue
		fi
		if [[ ! -f $source ]]; then
			echo "note: $source is missing, so $name is not linked"
			continue
		fi
		mkdir -p "$dir"
		ln -sn "$source" "$link"
		echo "linked $link -> $source"
	done
}

main "$@"
