# Judge records for shell judges (`judges/lib/Record.ts`, ADR 0054). Source it at the top of a judge,
# before any `cd`, and call `record_run` with the judge's file (relative to judges/) and its arguments:
#
#   source "$(dirname "$0")/lib/record.sh" && record_run gate.sh "$@"
#
# record_run runs the judge again as a child, so the judge's own traps and exits stay as they are,
# then appends its record (the commit and tree as the run started, the exit code as the verdict)
# and exits with the child's status. In the child it returns at once.
# shellcheck shell=bash

record_run() {
	local file=$1
	shift
	if [[ ${CAIRN_JUDGE_RECORDING:-} == "$file" ]]; then
		return 0
	fi

	local lib started commit tree status
	lib=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
	started=$(date +%s)
	commit=$(git -C "$lib" rev-parse HEAD 2>/dev/null || echo unknown)
	tree=dirty
	if [[ $commit != unknown && -z $(git -C "$lib" status --porcelain 2>/dev/null) ]]; then
		tree=clean
	fi

	set +e
	CAIRN_JUDGE_RECORDING=$file bash "$0" "$@"
	status=$?
	node "$lib/append-record.ts" --file "$file" --exit "$status" --started "$started" \
		--commit "$commit" --tree "$tree" -- "$@" ||
		echo "judge record not written for $file" >&2
	exit "$status"
}
