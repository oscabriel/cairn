#!/usr/bin/env bash
# install.sh [--check]: set the Beelink up to run the brain as the user unit cairn.service (ADR 0022).
#
#   1. Creates the data, state, cache and config directories (never on the NAS).
#   2. Writes ~/.config/cairn/cairn.json once: the owner is the Tailscale login of this machine's own node
#      (`tailscale whois` of its tailnet IP), never typed; host and origin are code.gneiss.run. An existing
#      file is kept as it is.
#   3. Creates the live worktree ~/Developer/projects/cairn-live (detached at this checkout's HEAD) if it
#      is missing, links its ops/cairn/cairn.service into ~/.config/systemd/user, and enables the unit.
#      The unit then ships with each deploy. Starting it is ops/cairn/deploy.sh's job.
#   4. Links the live worktree's cairn-nightly.service and cairn-nightly.timer (the durability matrix
#      at 03:30, judges/fixtures/durability/nightly.sh) and enables and starts the timer.
#
# --check changes nothing: it prints what it would do and verifies the unit. Nothing here reads a secret;
# the owner login and host are not secrets. No sudo (lingering is already on).
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

	local here repo
	here=$(cd "$(dirname "$0")" && pwd)
	repo=$(git -C "$here" rev-parse --show-toplevel)
	local live=$HOME/Developer/projects/cairn-live
	local config_dir=$HOME/.config/cairn
	local config=$config_dir/cairn.json
	local unit_link=$HOME/.config/systemd/user/cairn.service
	local dirs=("$config_dir" "$HOME/.local/share/cairn" "$HOME/.local/state/cairn" "$HOME/.cache/cairn/node")
	say() { if [[ $check -eq 1 ]]; then echo "would: $*"; else echo "$*"; fi; }

	# 1. Directories. ~/.local/share is on the NVMe under /home.
	local dir
	for dir in "${dirs[@]}"; do
		if [[ -d $dir ]]; then
			echo "ok: $dir exists"
		else
			say "create $dir (0700)"
			[[ $check -eq 1 ]] || install -d -m 0700 "$dir"
		fi
	done

	# 2. cairn.json.
	if [[ -f $config ]]; then
		echo "ok: $config exists, owner $(owner_of "$config")"
	else
		local owner
		owner=$(own_login)
		say "write $config with owner $owner, host code.gneiss.run"
		if [[ $check -eq 0 ]]; then
			(
				umask 077
				printf '{\n  "owner": "%s",\n  "host": "code.gneiss.run",\n  "origin": "https://code.gneiss.run"\n}\n' "$owner" >"$config"
			)
		fi
	fi

	# 3. Live worktree, unit link, enable.
	if [[ -d $live ]]; then
		echo "ok: live worktree $live at $(git -C "$live" log --oneline -1)"
	else
		say "add the live worktree $live detached at $(git -C "$repo" log --oneline -1)"
		[[ $check -eq 1 ]] || git -C "$repo" worktree add --detach "$live" HEAD >/dev/null
	fi

	local unit_file=$live/ops/cairn/cairn.service
	[[ -f $unit_file ]] || unit_file=$here/cairn.service
	systemd-analyze --user verify "$unit_file"
	echo "ok: systemd-analyze --user verify $unit_file"

	if [[ $(readlink "$unit_link" 2>/dev/null || true) == "$live/ops/cairn/cairn.service" ]]; then
		echo "ok: $unit_link links the live worktree's unit"
	else
		say "link $unit_link -> $live/ops/cairn/cairn.service"
		if [[ $check -eq 0 ]]; then
			mkdir -p "$(dirname "$unit_link")"
			ln -sfn "$live/ops/cairn/cairn.service" "$unit_link"
			systemctl --user daemon-reload
		fi
	fi

	if systemctl --user is-enabled --quiet cairn.service 2>/dev/null; then
		echo "ok: cairn.service is enabled"
	else
		say "enable cairn.service (not started; ops/cairn/deploy.sh starts it)"
		[[ $check -eq 1 ]] || systemctl --user enable cairn.service >/dev/null
	fi

	# 4. The nightly durability timer.
	# The links point into the live worktree, so it must carry the units: a link to a file the worktree
	# lacks would dangle. A worktree older than the units needs a deploy first. --check, which changes
	# nothing, verifies this checkout's copies instead.
	local name source link sources=()
	for name in cairn-nightly.service cairn-nightly.timer; do
		source=$live/ops/cairn/$name
		if [[ ! -f $source ]]; then
			if [[ $check -eq 0 ]]; then
				echo "error: $source is missing; deploy a commit that carries it (ops/cairn/deploy.sh), then rerun" >&2
				exit 1
			fi
			echo "note: $source is missing; a deploy must ship it before install.sh can link it"
			source=$here/$name
		fi
		sources+=("$source")
		link=$HOME/.config/systemd/user/$name
		if [[ $(readlink "$link" 2>/dev/null || true) == "$source" ]]; then
			echo "ok: $link links the live worktree's $name"
		else
			say "link $link -> $source"
			[[ $check -eq 1 ]] || ln -sfn "$source" "$link"
		fi
	done
	systemd-analyze --user verify "${sources[@]}"
	echo "ok: systemd-analyze --user verify ${sources[*]}"
	if systemctl --user is-enabled --quiet cairn-nightly.timer 2>/dev/null; then
		echo "ok: cairn-nightly.timer is enabled"
	else
		say "enable and start cairn-nightly.timer (03:30 nightly)"
		if [[ $check -eq 0 ]]; then
			systemctl --user daemon-reload
			systemctl --user enable --now cairn-nightly.timer >/dev/null
		fi
	fi

	[[ $check -eq 1 ]] && echo "check done; nothing changed" || echo "installed; next: ops/cairn/caddy-route.sh, then ops/cairn/deploy.sh"
}

# The login of this machine's own tailnet node, refused if the node is tagged (a tagged node has no user).
own_login() {
	local ip
	ip=$(tailscale ip -4 | head -1)
	tailscale whois --json "$ip" | node --input-type=module -e '
		let text = "";
		for await (const chunk of process.stdin) text += chunk;
		const whois = JSON.parse(text);
		const tags = whois.Node?.Tags ?? [];
		const login = whois.UserProfile?.LoginName ?? "";
		if (tags.length > 0 || login === "" || login.includes("@") === false) {
			console.error(`own node is tagged or has no login (tags ${tags.length})`);
			process.exit(1);
		}
		console.log(login);
	'
}

owner_of() {
	node --input-type=module -e '
		import { readFileSync } from "node:fs";
		console.log(JSON.parse(readFileSync(process.argv[1], "utf-8")).owner ?? "(none)");
	' "$1"
}

main "$@"
