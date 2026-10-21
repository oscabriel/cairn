#!/usr/bin/env bash
# Spike 4's judge: every crash window around a durable approval, each in a fresh store.
#   ./judge.sh [case...]
# A case passes when the navigation ran the expected number of times (0 or 1, never 2) and the
# conversation ended with the expected kind of tool result.
set -u
cd "$(dirname "$0")"
root=runs/judge
pid=

start() { # <dir> [submit <token>], env passes through
	(node brain.ts "$@" >>"$1/out.log" 2>&1 & echo $! >"$1/pid")
	pid=$(cat "$1/pid")
	for _ in $(seq 100); do grep -q '"listening"' <(tail -n 5 "$1/events.log" 2>/dev/null) && return; sleep 0.1; done
	echo "brain did not start"; exit 1
}
seen() { grep -c "\"kind\":\"$2\"" "$1/events.log" 2>/dev/null || true; }
await() { # <dir> <kind> [count] [timeout s]
	local want=${3:-1} limit=$(( ${4:-30} * 10 ))
	for _ in $(seq "$limit"); do (( $(seen "$1" "$2") >= want )) && return 0; sleep 0.1; done
	echo "timed out waiting for $2"; return 1
}
kill9() { kill -9 "$pid" 2>/dev/null; while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done; }
stop() { kill "$pid" 2>/dev/null; while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done; }
approval() { curl -s localhost:3774/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).items[0]?.id??""))'; }
answer() { curl -s -o /dev/null -d "id=$1&decision=$2" localhost:3774/answer; }
hits() { [[ -f "$1/hits.log" ]] && wc -l <"$1/hits.log" || echo 0; }
last_result() { grep '"kind":"tool_result"' "$1/events.log" | tail -n 1 | cut -c1-200; }

verdict() { # <name> <dir> <expected hits> <expected result pattern> [extra note]
	local got; got=$(hits "$2")
	local result; result=$(last_result "$2")
	if [[ "$got" == "$3" ]] && grep -q -- "$4" <<<"$result"; then status=PASS; else status=FAIL; fi
	printf '%-22s %s  hits %s (want %s)  %s\n' "$1" "$status" "$got" "$3" "${5:-}"
	if [[ $status == FAIL ]]; then echo "    $result"; fi
}

fresh() { rm -rf "$root/$1"; mkdir -p "$root/$1"; echo "$root/$1"; }

case_pending_kill() { # the gate: kill -9 with the approval parked, restart, answer
	local d; d=$(fresh pending-kill)
	start "$d" submit pk; await "$d" approval_waiting
	local id; id=$(approval); kill9
	start "$d"; await "$d" approval_waiting 2
	local t0; t0=$(date +%s%3N); answer "$id" accept; await "$d" hit; local t1; t1=$(date +%s%3N)
	await "$d" idle; stop
	verdict pending-kill "$d" 1 '"isError":false' "answer to navigation $((t1 - t0)) ms"
}

case_kill_six_times() { # six restarts with the approval parked
	local d; d=$(fresh kill-six)
	start "$d" submit k6; await "$d" approval_waiting
	local id; id=$(approval)
	for n in 2 3 4 5 6 7; do kill9; start "$d"; await "$d" approval_waiting "$n"; done
	answer "$id" accept; await "$d" idle; stop
	verdict kill-six-times "$d" 1 '"isError":false'
}

case_answer_then_kill() { # kill -9 right after the answer's commit
	local d; d=$(fresh answer-kill)
	start "$d" submit ak; await "$d" approval_waiting
	local id; id=$(approval); answer "$id" accept; kill9
	start "$d"; await "$d" idle 1 40; stop
	# The kill races the tool: either it had not started (runs once after restart) or it had (never reruns).
	if (( $(seen "$d" rerun_after_start) > 0 )); then
		verdict answer-then-kill "$d" "$(hits "$d")" 'may have run' "killed after start; hits must be 0 or 1"
	else
		verdict answer-then-kill "$d" 1 '"isError":false' "killed before start"
	fi
}

case_kill_started() { # kill -9 after `started`, before Executor is called
	local d; d=$(fresh kill-started)
	SPIKE_HOLD_STARTED_MS=5000 start "$d" submit ks; await "$d" approval_waiting
	answer "$(approval)" accept; await "$d" holding; kill9
	start "$d"; await "$d" idle; stop
	verdict kill-started "$d" 0 'may have run'
}

case_kill_asked() { # kill -9 after Executor asked, before Cairn answered it
	local d; d=$(fresh kill-asked)
	SPIKE_HOLD_ASKED_MS=5000 start "$d" submit ka; await "$d" approval_waiting
	answer "$(approval)" accept; await "$d" holding; kill9
	start "$d"; await "$d" idle; stop
	local apr; apr=$(grep -o 'apr_[0-9a-f-]*' "$d/events.log" | head -n 1)
	local late; late=$(node executor.ts resume "{\"requestId\":\"$apr\",\"response\":{\"action\":\"accept\"}}" 2>&1 | tail -n 1 | cut -c1-120)
	sleep 2
	verdict kill-asked "$d" 0 'may have run' "boot declined: $(seen "$d" orphan_declined); late accept: $late"
}

case_kill_called() { # kill -9 after Executor ran the call, before the result committed
	local d; d=$(fresh kill-called)
	SPIKE_HOLD_CALLED_MS=5000 start "$d" submit kc; await "$d" approval_waiting
	answer "$(approval)" accept; await "$d" holding; kill9
	start "$d"; await "$d" idle; stop
	verdict kill-called "$d" 1 'may have run'
}

case_decline() {
	local d; d=$(fresh decline)
	start "$d" submit dc; await "$d" approval_waiting
	answer "$(approval)" decline; await "$d" idle; stop
	verdict decline "$d" 0 'approval was declined'
}

case_expire_across_restart() { # expires while the brain is down
	local d; d=$(fresh expire)
	SPIKE_EXPIRY_MS=3000 start "$d" submit ex; await "$d" approval_waiting; kill9
	sleep 4
	SPIKE_EXPIRY_MS=3000 start "$d"; await "$d" idle; stop
	verdict expire-across-restart "$d" 0 'approval was expired'
}

case_double_answer() { # two devices answer at once
	local d; d=$(fresh double)
	start "$d" submit da; await "$d" approval_waiting
	local id; id=$(approval)
	answer "$id" accept & answer "$id" decline & answer "$id" accept & wait
	await "$d" idle; stop
	verdict double-answer "$d" 1 '"isError":false' "$(grep -c '"changed":true' "$d/events.log") answer took effect"
}

case_full_access() { # no Cairn ask; Executor's own prompt answered by Cairn
	local d; d=$(fresh full-access)
	SPIKE_MODE=full-access start "$d" submit fa; await "$d" idle; stop
	verdict full-access "$d" 1 '"isError":false' "executor asked: $(seen "$d" executor_resume)"
}

cases=("$@")
(( ${#cases[@]} )) || cases=(pending_kill kill_six_times answer_then_kill kill_started kill_asked kill_called decline expire_across_restart double_answer full_access)
for c in "${cases[@]}"; do "case_$c"; done
