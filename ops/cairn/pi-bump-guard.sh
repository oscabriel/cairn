#!/usr/bin/env bash
# pi-bump-guard.sh <repo> <from> <to> [data-dir]: the deploy's guard for running workflows (workflows
# note judge 7, plan 7B). A running workflow's code mode call replays against the pi it started
# under; a deploy that changes the `@earendil-works/*` pins in pnpm-workspace.yaml would end it, so
# the guard refuses that deploy while any thread is not settled. A workflow runs inside its launching
# thread's run (the workflows note, decision 4), so a thread whose shell activity is not
# `idle` or `failed` (preparing, running, waiting or parked) may hold one; the guard counts those in
# the brain's cairn.sqlite, read-only. A deploy that leaves the pins alone always passes: a restart
# is survived (judge 6's kill).
#
# Exits 0 and prints one line saying why the deploy may go; exits 1 and prints the refusal on
# stderr. data-dir defaults to $CAIRN_DATA_DIR, then ~/.local/share/cairn. Prints no secret.
set -euo pipefail

repo=$1
from=$2
to=$3
data=${4:-${CAIRN_DATA_DIR:-$HOME/.local/share/cairn}}

pins() {
	git -C "$repo" show "$1:pnpm-workspace.yaml" 2>/dev/null | grep '"@earendil-works/' || true
}

if [[ "$(pins "$from")" == "$(pins "$to")" ]]; then
	echo "pi pins unchanged; running workflows survive the restart"
	exit 0
fi

db=$data/cairn.sqlite
if [[ ! -f $db ]]; then
	echo "pi pins change and $db is missing; nothing can be running"
	exit 0
fi

busy=$(sqlite3 -readonly "$db" "select count(*) from threads where coalesce(json_extract(shell_json, '\$.activity'), 'idle') not in ('idle', 'failed')") || {
	echo "pi pins change and $db could not be read; refusing" >&2
	exit 1
}

if [[ $busy -gt 0 ]]; then
	echo "pi pins change and $busy thread(s) are not settled, so a workflow may be running; deploy after they settle" >&2
	exit 1
fi

echo "pi pins change and every thread is settled"
