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
# A deploy that fails before the restart leaves the brain as it was: install or build failing puts the
# live worktree back on the previous commit and reinstalls it, and the web app is built into
# apps/web/dist.next and swapped in with one atomic rename, so the running brain never serves a
# half-built dist. A deploy refuses while cairn-nightly.service runs, because the nightly matrix runs
# from the same worktree. After deploy-check passes, the commit is written to
# ${XDG_STATE_HOME:-~/.local/state}/cairn/deployed.
#
# --check changes nothing: it resolves the commit, verifies that commit's unit file, says whether the
# live worktree is the deployed commit and whether the nightly is running, and says what it would do.
# Run ops/cairn/install.sh once first. Nothing here prints a secret. No sudo.
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
	# CAIRN_LIVE_WORKTREE points a judge at a scratch worktree; the unit always runs cairn-live.
	live=${CAIRN_LIVE_WORKTREE:-$HOME/Developer/projects/cairn-live}
	commit=$(git -C "$repo" rev-parse --verify "${1:-HEAD}^{commit}")
	local subject
	subject=$(git -C "$repo" log --oneline -1 "$commit")
	local marker=${XDG_STATE_HOME:-$HOME/.local/state}/cairn/deployed
	local nightly
	nightly=$(systemctl --user is-active cairn-nightly.service 2>/dev/null || true)

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
			if [[ -f $marker && $(cat "$marker") == "$(git -C "$live" rev-parse HEAD)" ]]; then
				echo "the live worktree is the deployed commit"
			else
				echo "the live worktree is not the deployed commit (a deploy failed after its checkout, or none recorded)"
			fi
		else
			echo "live worktree $live is missing; run ops/cairn/install.sh first" >&2
			exit 1
		fi
		if [[ $nightly == active ]]; then
			echo "cairn-nightly.service is running; a deploy would refuse"
		fi
		echo "unit: $(systemctl --user is-enabled cairn.service 2>/dev/null || true), $(systemctl --user is-active cairn.service 2>/dev/null || true)"
		# The peak since this invocation started; journalctl _SYSTEMD_INVOCATION_ID=<id> -g brain_memory_peak times it.
		echo "memory: $(systemctl --user show cairn.service -p InvocationID -p MemoryCurrent -p MemoryPeak -p MemoryHigh --value 2>/dev/null | paste -sd ' ' || true) (invocation, current, peak, high; bytes)"
		echo "check done; nothing changed"
		exit 0
	fi

	[[ -d $live ]] || {
		echo "live worktree $live is missing; run ops/cairn/install.sh first" >&2
		exit 1
	}
	if [[ $nightly == active ]]; then
		echo "cairn-nightly.service is running from the live worktree; deploy after it finishes" >&2
		exit 1
	fi

	local prev
	prev=$(git -C "$live" rev-parse HEAD)

	# Until the restart, any failure puts the live worktree back as it was.
	restore() {
		echo "deploy failed before the restart; restoring $(git -C "$live" log --oneline -1 "$prev")" >&2
		rm -rf "$live/apps/web/dist.next"
		git -C "$live" checkout --quiet --detach "$prev"
		(cd "$live" && pnpm install --frozen-lockfile) >&2 || echo "reinstalling $prev failed; run pnpm install in $live" >&2
	}
	trap restore ERR

	git -C "$live" checkout --quiet --detach "$commit"
	(cd "$live" && pnpm install --frozen-lockfile)
	rm -rf "$live/apps/web/dist.next"
	(cd "$live" && pnpm --filter @cairn/web exec vite build --outDir dist.next --emptyOutDir)

	# One rename: the brain reads dist per request, so it sees the old build or the new, never half.
	if [[ -d $live/apps/web/dist ]]; then
		mv --exchange --no-target-directory "$live/apps/web/dist.next" "$live/apps/web/dist"
		rm -rf "$live/apps/web/dist.next"
	else
		mv --no-target-directory "$live/apps/web/dist.next" "$live/apps/web/dist"
	fi
	trap - ERR

	systemctl --user daemon-reload
	systemctl --user restart cairn.service
	if (cd "$live" && node ops/cairn/deploy-check.ts --unit cairn --seconds 60); then
		mkdir -p "$(dirname "$marker")"
		git -C "$live" rev-parse HEAD >"$marker"
		echo "deployed $(git -C "$live" log --oneline -1)"
	else
		echo "cairn did not come up; see journalctl --user -u cairn" >&2
		exit 1
	fi
}

main "$@"
