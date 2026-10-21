#!/usr/bin/env bash
# Spike 3's judge: kill -9 the brain at points in a four-node workflow, each in a fresh store.
#   ./judge.sh [case...]
# A case passes when every node's effect ran exactly once (approve once per answer) and the
# workflow's result holds all four nodes.
set -u
cd "$(dirname "$0")"
export SPIKE_JOB_SECONDS=${SPIKE_JOB_SECONDS:-15}
pid=
starts=0

start() { (node brain.ts "$@" >>"$1/out.log" 2>&1 & echo $! >"$1/pid"); pid=$(cat "$1/pid")
	for _ in $(seq 100); do grep -q '"listening"' "$1/events.log" 2>/dev/null && [[ $(grep -c '"listening"' "$1/events.log") -ge $starts ]] && return; sleep 0.1; done; echo "no start"; exit 1; }
seen() { grep -c "\"kind\":\"$2\"" "$1/events.log" 2>/dev/null || true; }
await() { local limit=$(( ${4:-60} * 10 )); for _ in $(seq "$limit"); do (( $(seen "$1" "$2") >= ${3:-1} )) && return 0; sleep 0.1; done; echo "timed out on $2"; return 1; }
kill9() { kill -9 "$pid"; while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done; }
stop() { kill "$pid" 2>/dev/null; while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done; }
up() { starts=$((starts + 1)); start "$@"; }
answer() { local id; id=$(curl -s localhost:3774/ | node -pe 'JSON.parse(require("fs").readFileSync(0)).approvals[0]?.id'); curl -s -o /dev/null -X POST "localhost:3774/answer?id=$id&decision=$1"; }
count() { local n; n=$(grep -c "\"node\":\"$2\"" "$1/effects.log" 2>/dev/null); echo "${n:-0}"; }
fresh() { d="runs/judge/$1"; rm -rf "$d"; mkdir -p "$d"; starts=0; export SPIKE_RUN="$1-$(date +%s%N)"; }

verdict() { # <name> <dir> <want scan long approve integrate> <final pattern>
	local got="$(count "$2" scan) $(count "$2" long) $(count "$2" approve) $(count "$2" integrate)"
	local final; final=$(grep '"kind":"final"' "$2/events.log" | tail -n 1)
	if [[ "$got" == "$3" ]] && grep -q -- "$4" <<<"$final"; then s=PASS; else s=FAIL; fi
	printf '%-20s %s  effects scan/long/approve/integrate %s (want %s)  restarts %s\n' "$1" "$s" "$got" "$3" "$(( $(grep -c '"kind":"open"' "$2/events.log") - 1 ))"
	if [[ $s == FAIL ]]; then echo "    ${final:0:300}"; fi
}

case_plain() { local d; fresh plain; up "$d" submit p; await "$d" approval_waiting; answer accept; await "$d" idle 1 90; stop; verdict plain "$d" "1 1 1 1" 'Script completed'; }

case_kill_fanout() { local d; fresh kill-fanout
	up "$d" submit kf; await "$d" job_started; await "$d" agent_done; kill9
	up "$d"; await "$d" job_reattached; answer accept; await "$d" idle 1 90; stop
	verdict kill-fanout "$d" "1 1 1 1" 'Script completed'; }

case_kill_before_nodes() { local d; fresh kill-early
	up "$d" submit ke; await "$d" submitted; kill9
	up "$d"; await "$d" approval_waiting; answer accept; await "$d" idle 1 90; stop
	verdict kill-before-nodes "$d" "1 1 1 1" 'Script completed'; }

case_kill_thrice() { local d; fresh kill-thrice
	up "$d" submit kt; await "$d" job_started; kill9
	up "$d"; await "$d" job_reattached; kill9
	up "$d"; await "$d" job_reattached 2; answer accept; await "$d" approval_settled; kill9
	up "$d"; await "$d" idle 1 90; stop
	verdict kill-thrice "$d" "1 1 1 1" 'Script completed'; }

case_kill_in_integrate() { local d; fresh kill-integrate
	SPIKE_HOLD_NODE=integrate SPIKE_HOLD_WORK_MS=3000 up "$d" submit ki; await "$d" approval_waiting; answer accept; await "$d" holding 1 90; kill9
	up "$d"; await "$d" idle 1 90; stop
	verdict kill-in-integrate "$d" "1 1 1 1" 'Script completed'; }

case_decline() { local d; fresh decline
	up "$d" submit dc; await "$d" approval_waiting; answer decline; await "$d" idle 1 90; stop
	verdict decline "$d" "1 1 1 0" 'stopped'; }

case_abort() { local d; fresh abort
	up "$d" submit ab; await "$d" job_started; curl -s -X POST localhost:3774/abort >/dev/null; await "$d" idle 1 30; stop
	local unit; unit=$(grep -o 'cairn-s3-job-[^"]*' "$d/events.log" | head -n 1)
	local state; state=$(systemctl --user is-active "$unit" 2>&1)
	printf '%-20s %s  job unit after abort: %s, stopped events %s\n' abort "$([[ $state != active ]] && echo PASS || echo FAIL)" "$state" "$(seen "$d" job_stopped)"; }

cases=("$@")
(( ${#cases[@]} )) || cases=(plain kill_fanout kill_before_nodes kill_thrice kill_in_integrate decline abort)
for c in "${cases[@]}"; do "case_$c"; done
