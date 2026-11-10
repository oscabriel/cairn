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
#
# It runs under the judge lock (`flock` on `CAIRN_JUDGE_LOCK`, default /tmp/cairn-judge.lock), the
# one `judges/run-set.ts` holds for the whole pre-deploy set, so the two never share the machine. It
# waits up to `CAIRN_NIGHTLY_LOCK_WAIT` seconds (default 90 minutes, inside the unit's 3 hours) for
# a holder; a night still waiting then is skipped, since it judged nothing, and exits 0. A second
# skipped night in a row fails, so a stuck holder cannot silence the nightly. It takes the lock
# itself: a caller that already holds it (a hand run wrapped in `flock /tmp/cairn-judge.lock`, an
# ancestor of this process) is seen by `judges/lib/lock-held-by-caller.sh` and the script runs under
# that caller's lock; a holder that is not an ancestor must set CAIRN_JUDGE_LOCK_HELD=1, or the
# nightly waits for it and skips. The durability runs it starts record as within the nightly
# (`CAIRN_JUDGE_OUTER`, judges/lib/Record.ts).
set -euo pipefail

self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
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

# The judge lock: run this script again under it, unless this process or its caller already holds it
# (a hand run wrapped in `flock <lock>`, whose lock a second `flock` here would wait on until skipped).
skipped=$HOME/cairn-judges/nightly-skipped
lock=${CAIRN_JUDGE_LOCK:-/tmp/cairn-judge.lock}
if [[ ${CAIRN_JUDGE_LOCK_HELD:-} != 1 ]] && ! bash judges/lib/lock-held-by-caller.sh "$lock"; then
	set +e
	CAIRN_JUDGE_LOCK_HELD=1 flock --wait "${CAIRN_NIGHTLY_LOCK_WAIT:-5400}" --conflict-exit-code 75 \
		"$lock" bash "$self" "$@"
	status=$?
	set -e
	if ((status != 75)); then
		exit "$status"
	fi
	echo "{\"nightly\":\"skipped\",\"reason\":\"another judge held $lock (this script takes it itself; a holder that is not its caller must set CAIRN_JUDGE_LOCK_HELD=1)\"}" | tee -a "$log"
	if [[ -f $skipped ]]; then
		echo "the nightly could not take the judge lock $lock and skipped the night before too ($(cat "$skipped")); see what holds it" >&2
		exit 1
	fi
	date -Iseconds >"$skipped"
	exit 0
fi
rm -f "$skipped"
failures=0
steps=0
started=$(date +%s)
commit=$(git rev-parse HEAD)
tree=clean
[[ -z $(git status --porcelain) ]] || tree=dirty
# The judges the steps start record as within the nightly; the nightly's own record, below, as the
# judge that started it had it (none, from the timer).
outer=${CAIRN_JUDGE_OUTER:-}
export CAIRN_JUDGE_OUTER=${outer:-fixtures/durability/nightly.sh}

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

CAIRN_JUDGE_OUTER=$outer node judges/lib/append-record.ts --file fixtures/durability/nightly.sh \
	--exit "$((failures == 0 ? 0 : 1))" --started "$started" --commit "$commit" --tree "$tree" \
	--counts "{\"failedSteps\":$failures,\"steps\":$steps}" -- "$@" ||
	echo "the nightly's judge record was not written" >&2

((failures == 0))
