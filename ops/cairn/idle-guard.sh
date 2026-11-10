#!/usr/bin/env bash
# idle-guard.sh [data-dir]: the deploy's guard for live threads (ADR 0054; finding E-7). A restart of
# the brain cuts every run in flight: a tool call comes back interrupted, and an Executor call may
# have run. So ops/cairn/deploy.sh restarts only while every live thread (neither deleted nor
# archived) is `idle` or `failed` with an empty queue, read from the brain's cairn.sqlite read-only,
# once before it moves anything and again just before the restart.
#
# Exits 0 and prints one line when the restart may go; exits 1 and prints the refusal, with the
# unsettled threads' ids, activities and queue lengths, on stderr. data-dir defaults to
# $CAIRN_DATA_DIR, then ~/.local/share/cairn. Prints no secret and no thread title.
set -euo pipefail

data=${1:-${CAIRN_DATA_DIR:-$HOME/.local/share/cairn}}
db=$data/cairn.sqlite

if [[ ! -f $db ]]; then
	echo "$db is missing; no thread can be running"
	exit 0
fi

activity="coalesce(json_extract(shell_json, '\$.activity'), 'idle')"
queue="coalesce(json_extract(shell_json, '\$.queueLength'), 0)"

busy=$(sqlite3 -readonly -separator ' ' "$db" "
	select id, $activity, $queue from threads
	where deleted_at is null
		and json_extract(shell_json, '\$.archivedAt') is null
		and ($activity not in ('idle', 'failed') or $queue > 0)
	order by id") || {
	echo "$db could not be read; refusing to restart the brain" >&2
	exit 1
}

if [[ -n $busy ]]; then
	echo "$(wc -l <<<"$busy") live thread(s) are not settled (id, activity, queue); a restart would cut them:" >&2
	sed 's/^/  /' <<<"$busy" >&2
	exit 1
fi

echo "every live thread is idle or failed with an empty queue"
