---
status: proposed
gate: `judges/approval-kill.ts` (six kills with an approval pending, then an answer that runs exactly once; its control, the brain opened with pi-durable's own restart limit, fails)
---

# Crashes end no wait

pi-durable 1.5.0 removed park and retry. A task a crash cuts off `restartLimit` times in a row without committing a new state now ends: a tool call with a `restart_limit` error result, an extension's task `faulted`. Cairn's approvals (ADR 0013), a subagent's start (ADR 0030), its reporters and a workflow's watchers (ADR 0012) waited across crashes by being parked at the fifth and retried at boot. On 1.5 the same five crashes would end a pending approval's call, and the user's answer would find nothing to run, against gate S4.

The preferred design moved each wait off its running invocation: a task asleep on pi-durable's clock until its record settles or expires, which a crash does not count. pi-durable 1.5.1 cannot express that for a tool call. Only a task's own committed state (a checkpoint, a `waiting` on tasks, a `sleeping`, an outcome) is progress, and a tool's `execute` commits none of these: the `pi.tool` task's checkpoint stays `{ phase: "execute" }` on every rerun, and a tool has no `sleepUntil` or durable wait (its `waitForTask` waits in memory, so the tool task stays `running` and is counted). Every Cairn wait on a person is a tool call (a gated call, `ask_user`, `ask_parent`, a brief's spawn, a workflow's question), so ending the call and answering by a later input would change what the model sees in every one of them. Cairn's own task kinds can already sleep (a brief's expiry does), but they are not where S4 breaks.

So the brain opens its Harness with `restartLimit` infinite (`apps/server/src/brain/RestartLimit.ts`) and does its own crash accounting at boot (`CrashLimit.ts`, the `crash limit` repair, after open and before resume). A live task cut off five times in a row is aborted, so it ends visibly through its own abort handler, unless it is a wait Cairn keeps however often the brain dies:

- every tool call (`pi.tool`): an approval wait, a question, a subagent wait, a workflow's script call and its nodes. A tool that is not replay-safe never runs again after a crash, and a gated one never runs its effect twice, so a tool call that reruns is a wait or a read;
- the subagent tasks that wait (the brief and its tell sleep, the reporter waits on its child, the start makes a Go'd child once) and a workflow's watcher and budget stopper.

What boot ends is work that may itself be what crashes the brain: a generation (pi-durable already charges a request a crash cut off as a failed attempt under the retry policy), a compaction, and Cairn's other task kinds. Removed with park: `Parked`, `TaskParked`, the seam's `retry`, `thread.retryTask`, the `parked` thread activity and `parkedTaskIds` on the wire, the Retry banner, and the three boot retries; migration `0015_ParkedRemoved` rewrites a row a 1.4 brain stored as `parked` to `idle`, which the boot reconcile then sets from the brain.

What this gives up. A replay-safe tool call that deterministically crashes the brain loops forever, where 1.4 parked it after five; so does an abort handler that crashes the brain, since an abort mark starts pi-durable's count over and boot cannot end a task twice. A subagent's start that crashes the brain loops too, where ADR 0030 wanted a human Retry: no retry exists on 1.5, and the review fixes of 2026-11-09 hold a Go'd brief's start to the same promise as an approval, to run once however often the brain dies.

Also part of the bump, 2026-11-09 (pi 1.4.0 to 1.5.1):

- The conversation view is a window over the whole history on 1.5, newest 50 entries first and dropping its oldest 50 past 100. The thread stream asks for a window that starts with the newest 75 entries (what the thread window can hold) and never drops any, so appends stay appends for a subscription's life (`STREAM_WINDOW` in `PiDurableHarness.ts`); `hasMoreHistory` reads the view's `before`. A compaction no longer cuts the view: its summary is appended where it was written, and the entries before it stay.
- A wake and a declined brief's tell read whether the parent was stopped and admit their input in one commit (`submit(tx, draft)`), so a stop lands either before the read or after the input.

Gate: `judges/approval-kill.ts`, on a judge brain with the production seam, brain, extension set and boot repairs over a faux model: six kills while the gated `bash` waits on its approval, then a seventh life accepts it as the user. Measured on 2026-11-09: the real case passes (6 of 6 kills with the approval pending, the command ran once, the record accepted by the user, one result that is not an error); the control (pi-durable's own limit) fails as it must, its call ended "Tool bash was interrupted 5 times in a row; it is not run again", its record cancelled and the command never run. The status moves to accepted when the user accepts it.
