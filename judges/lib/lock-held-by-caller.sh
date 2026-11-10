#!/usr/bin/env bash
# Whether a process this one descends from holds the judge lock (ADR 0054):
#
#   bash judges/lib/lock-held-by-caller.sh <lock>    (exit 0: a caller holds it; 1: no)
#
# The nightly and `judges/run-set.ts` take the lock themselves. A caller that wrapped them, as a hand
# run does by convention (`flock /tmp/cairn-judge.lock node judges/run-set.ts`), already holds it, and
# a second `flock` on the same file waits on that caller forever. They ask this first and skip their
# own `flock` when the answer is yes. It walks this process's ancestors and, for each descriptor one
# has open on the lock file, reads the kernel's lock line for it (`/proc/<pid>/fdinfo/<fd>`, which
# lists only the locks that descriptor holds), so a lock another process holds is never mistaken for
# a caller's. Reads only /proc; prints nothing.
set -uo pipefail

lock=$(realpath -m -- "${1:?usage: lock-held-by-caller.sh <lock>}")
pid=$PPID

while ((pid > 1)); do
	for fd in "/proc/$pid/fd/"*; do
		[[ $(readlink -- "$fd" 2>/dev/null) == "$lock" ]] || continue
		if grep -q '^lock:.*FLOCK' "/proc/$pid/fdinfo/${fd##*/}" 2>/dev/null; then
			exit 0
		fi
	done
	pid=$(awk '/^PPid:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)
	[[ $pid =~ ^[0-9]+$ ]] || break
done

exit 1
