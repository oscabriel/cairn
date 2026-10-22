# Spike 4: approvals as durable records

Result: **pass.** An approval parked across a `kill -9` of the brain was answered from the user's phone, and the navigation it gated ran exactly once. The judge's ten crash windows never ran a call twice. Cairn's approval also replaces Executor's own prompt, which is the way past asking on every playwright navigation.

Run on 2026-10-21 on the Beelink: pi-durable, pi-ai, pi-mcp and chord 1.3.0, Node 26.11.1, Executor 2.0.0-beta.25, through Cairn's own scoped connection and grant (step C) to the S5 stdio relay's playwright.

## Shape

`brain.ts` is one pi-durable conversation on SQLite whose scripted model calls `executor_call` once. The tool navigates Cairn's playwright through Executor to the brain's own `/hit/<token>` page, so every navigation that really ran is counted in `hits.log`, outside pi-durable's store. The same process serves the approvals page on `127.0.0.1:3774`.

- **The record.** A session document, `cairn.approvals`, keyed by the tool task ID. The tool creates its record in one commit, or finds the one an earlier run made.
- **The wait.** The tool watches the document until the record leaves `pending`, or commits `expired` when its time passes. The answer is one host commit; nothing else wakes the tool.
- **The effect.** After an accept, the tool commits `run: "started"`, calls Executor, and commits `done`. A rerun that finds `started` returns "Interrupted after it started, so it may have run. Not retried."
- **Executor's prompt.** The bridges app asks for approval on playwright's destructive tools. Cairn records the `apr_` ID, then answers `accept` at once with `resume`. On boot it declines every recorded `apr_` whose call never finished.
- **Full access** skips the record and still answers Executor's prompt.

### What pi-durable 1.3.0 has

The spec on pi's main branch describes `sleeping` tasks, `sleepUntil`, a restart limit and `retryTask`. **None are in 1.3.0**, the published version: its task states are `pending`, `running`, `waiting` (on tasks only), `completing` and `terminal`, and `api.now()` doesn't exist. So no task can sleep until an expiry or wait on an outside event. The design here keeps the wait in the replay-safe tool's memory, and the restart reruns it. That suits 1.3.0 well: with no restart limit, six restarts during one wait cost nothing. When Cairn moves to a pi-durable with the restart limit, a long approval wait across five crashes would be parked, and Cairn would need to retry tool tasks whose record is still pending, or move the wait into a sleeping task.

## Numbers

The judge is `judge.sh`: each case runs in a fresh store and counts navigations in `hits.log`. Last run:

| Case | Navigations | Result the model saw |
| --- | --- | --- |
| `kill -9` while pending, restart, accept | 1 | the page; 729 ms from answer to navigation |
| Six `kill -9`s while pending, then accept | 1 | the page |
| Accept, then `kill -9` at once | 0 | "may have run" (the kill landed after `started`) |
| `kill -9` after `started`, before Executor | 0 | "may have run" |
| `kill -9` after Executor asked, before Cairn answered | 0 | "may have run"; boot declined the `apr_`, and a later accept was refused as `answered` |
| `kill -9` after Executor ran it, before the result | 1 | "may have run" |
| Decline | 0 | "the approval was declined" |
| Expiry passes while the brain is down | 0 | "the approval was expired" |
| Three answers at once (accept, decline, accept) | 1 | the page; one answer took effect |
| Full access | 1 | the page; Cairn answered Executor's prompt |

The phone run: the approval was parked, the brain killed with `kill -9` and restarted, and the user answered 43 minutes later from the phone through `https://cairn-s4.gneiss.run` (a temporary Caddy route, removed after). One navigation, 0.94 s from the answer's commit to the hit: about 0.6 s for Executor's `call` to return approval-required, then 0.27 s to the page.

| Measure | Result |
| --- | --- |
| Executor `call` to approval-required (fresh MCP connection included) | 0.3 to 0.6 s |
| Executor `resume` accept to the navigation | 0.27 to 0.4 s |
| Answer commit to the waiting tool | under 1 ms |

## Decisions

- **The approval record lives in a session document, answered by one host commit.** Every device reads the same queue, and the tool's restart finds its record.
- **The gated tool is replay-safe and owns the wait.** The `started` mark makes the effect at most once; the record makes the question once.
- **Cairn's approval is the only one the user sees.** Executor's prompt for a call Cairn already allowed is answered by Cairn in the same tool call. This gets past asking on every playwright navigation: full access asks nothing, and the approval-required mode asks once per call in Cairn. Executor's own policies stay for Claude Code and the pi CLI on their own grants.
- **Never expose Executor's `resume` to the model.** It would let the model accept its own prompts. Cairn's tools proxy `call` and `execute` and answer prompts themselves.
- **A crash between the answer and the call loses the call**, reported as "may have run". Cairn can't know whether Executor received it, so it never guesses.

## Noticed

- The approvals page takes a key through Caddy; the real one goes behind Tailscale sign-in (ADR 0008).
- `executor.ts` holds Cairn's grant while it runs. Only one process may: the brain, the judge's late-accept check and `grant.ts` never ran at the same time.

## Files

- `brain.ts`: the brain, the gated tool, and the approvals page. `node brain.ts <runDir> [submit <token>]`.
- `judge.sh`: the crash windows. `./judge.sh [case...]`.
- `executor.ts`: an MCP client on Cairn's grant. `node executor.ts <tool> '<json>'`.
- `runs/` (ignored): each run's store, events and hits.

## Rerun on pi-durable 1.4.0 (2026-10-22)

All ten cases pass, after two changes:

- **`kill-six-times` was parked at first.** The approval's tool task waits without committing a new state, so 1.4.0's crash-loop guard parked it after 5 crashes ("cut off 5 times without progress"), although the wait never crashed anything. The brain now calls `retryTask()` at boot for each task whose approval record is still `pending`. A crash after the answer stays parked, so the guard still catches a call that crashes the brain.
- **`double-answer` assumed the first accept wins.** Three answers sent at once race, and on 1.4.0 the decline landed first. The judge now checks the invariant: exactly one answer takes effect, and the call follows it. Three runs went accept, decline, decline, all correct.

1.4.0 also adds durable sleep (`sleepUntil`) and `api.now()`. The approval's expiry could become a sleeping task, but a sleep can't be woken early by an answer, so the wait stays in the tool.
