#!/usr/bin/env bash
# deploy.sh [--check] [commit]: deploy a commit (default: HEAD of this checkout) to the brain's user unit.
#
# The unit runs from its own worktree, ~/Developer/projects/cairn-live, never from a working tree, so
# half-written code never reaches the phone and development never touches the running brain. Steps:
# check the commit out there (detached), `pnpm install --frozen-lockfile`, build the web app, reload
# systemd (the unit file ships with the commit), restart cairn.service, then run
# ops/cairn/deploy-check.ts from the live worktree: this invocation's own `listening` line and a
# `session.hello` over /ws within 60 s, or the deploy fails.
#
# --check changes nothing: it resolves the commit, verifies that commit's unit file and says what it
# would do. Run ops/cairn/install.sh once first. Nothing here prints a secret. No sudo.
set -euo pipefail

# Everything runs inside main, so bash has read the whole script before the checkout replaces it
# (this script may be the live worktree's own copy).
main() {
	local check=0
	if [[ ${1:-} == --check ]]; then
		check=1
		shift
	fi
	local here repo live commit
	here=$(cd "$(dirname "$0")" && pwd)
	repo=$(git -C "$here" rev-parse --show-toplevel)
	live=$HOME/Developer/projects/cairn-live
	commit=$(git -C "$repo" rev-parse --verify "${1:-HEAD}^{commit}")
	local subject
	subject=$(git -C "$repo" log --oneline -1 "$commit")

	# The commit's own unit file must verify before anything moves.
	scratch=$(mktemp -d)
	trap 'rm -rf "$scratch"' EXIT
	git -C "$repo" show "$commit:ops/cairn/cairn.service" >"$scratch/cairn.service" 2>/dev/null || {
		echo "$subject has no ops/cairn/cairn.service; nothing to deploy" >&2
		exit 1
	}
	git -C "$repo" cat-file -e "$commit:apps/server/src/main.ts" 2>/dev/null || {
		echo "$subject has no apps/server/src/main.ts; nothing to deploy" >&2
		exit 1
	}
	systemd-analyze --user verify "$scratch/cairn.service"

	if [[ $check -eq 1 ]]; then
		echo "would deploy $subject"
		if [[ -d $live ]]; then
			echo "live worktree now at $(git -C "$live" log --oneline -1)"
		else
			echo "live worktree $live is missing; run ops/cairn/install.sh first" >&2
			exit 1
		fi
		echo "unit: $(systemctl --user is-enabled cairn.service 2>/dev/null || true), $(systemctl --user is-active cairn.service 2>/dev/null || true)"
		echo "check done; nothing changed"
		exit 0
	fi

	[[ -d $live ]] || {
		echo "live worktree $live is missing; run ops/cairn/install.sh first" >&2
		exit 1
	}
	git -C "$live" checkout --quiet --detach "$commit"
	(cd "$live" && pnpm install --frozen-lockfile && pnpm --filter @cairn/web build)

	systemctl --user daemon-reload
	systemctl --user restart cairn.service
	if (cd "$live" && node ops/cairn/deploy-check.ts --unit cairn --seconds 60); then
		echo "deployed $(git -C "$live" log --oneline -1)"
	else
		echo "cairn did not come up; see journalctl --user -u cairn" >&2
		exit 1
	fi
}

main "$@"
