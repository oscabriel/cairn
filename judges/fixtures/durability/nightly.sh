#!/usr/bin/env bash
# The durability matrix, nightly (plan 5A, notes/edges.md "Durability"): every faux window and
# every bridge window three times each with the Chromium page, then both controls once (each must
# fail every window), then J14's 20 minute held approval once.
#
#   judges/fixtures/durability/nightly.sh [--no-slow] [--no-bridge]
#
# Writes every JSON line to `$CAIRN_DURABILITY_LOG` (default `~/cairn-judges/durability-<date>.jsonl`)
# as well as stdout, appends the night's judge record (`judges/lib/Record.ts`, ADR 0054) with its
# step counts, and exits 0 only when every step passed; a failed run starts
# cairn-nightly-failed.service, which asks the brain to push the failure to the user's devices. The
# bridge steps use Claude Code's login in `~/.claude` and cost a few cents of plan usage on Haiku;
# the whole run takes about an hour. Run it on a quiet machine: a browser judge beside a bridge window has made the bridge's
# streaming window miss its aim before. Uses only `systemctl --user`, node and the user's own
# logins; no sudo, no secrets printed.
set -euo pipefail

cd "$(dirname "$0")/../../.."

slow=1
bridge=1

for arg in "$@"; do
	case "$arg" in
	--no-slow) slow=0 ;;
	--no-bridge) bridge=0 ;;
	*)
		echo "Unknown option $arg. Use --no-slow or --no-bridge." >&2
		exit 2
		;;
	esac
done

mkdir -p "$HOME/cairn-judges"
log="${CAIRN_DURABILITY_LOG:-$HOME/cairn-judges/durability-$(date +%Y-%m-%d).jsonl}"
failures=0
steps=0
started=$(date +%s)
commit=$(git rev-parse HEAD)
tree=clean
[[ -z $(git status --porcelain) ]] || tree=dirty

# The commit under test, so a log line is never read against a later deploy's code.
echo "{\"nightly\":\"start\",\"commit\":\"$commit\"}" | tee -a "$log"

step() {
	echo "{\"step\":\"$*\"}" | tee -a "$log"

	# The judge's exit code is the verdict, a control's included (0 only when every window failed).
	set +e
	node judges/durability.ts "$@" | tee -a "$log"
	local status=${PIPESTATUS[0]}
	set -e

	steps=$((steps + 1))
	if ((status != 0)); then
		failures=$((failures + 1))
	fi
}

step --runs 3

if ((bridge)); then
	step --bridge --runs 3
fi

step --sabotage skip-snapshot
step --sabotage page-text

if ((slow)); then
	step --slow
fi

echo "{\"nightly\":true,\"failedSteps\":$failures,\"log\":\"$log\"}"

node judges/lib/append-record.ts --file fixtures/durability/nightly.sh \
	--exit "$((failures == 0 ? 0 : 1))" --started "$started" --commit "$commit" --tree "$tree" \
	--counts "{\"failedSteps\":$failures,\"steps\":$steps}" -- "$@" ||
	echo "the nightly's judge record was not written" >&2

((failures == 0))
