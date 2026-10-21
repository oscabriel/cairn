# Spike 3: workflows as durable scripts

Result: **pass.** A four-node workflow ran as one code-mode script. Its run included a node that waited on an approval and a node whose job ran 16 minutes. It survived two `kill -9`s of the brain, one mid fan-out and one five minutes into the job. No node ran twice, and the script returned all four results. The judge's seven cases agree.

Run on 2026-10-21 on the Beelink: pi-durable, pi-codemode, pi-ai and chord 1.3.0, Node 26.11.1. Every model is scripted (pi-ai's faux provider), because this measures durability, not models.

## Shape

`brain.ts` runs one pi-durable conversation on SQLite. Its scripted model writes this script for the `codemode` tool:

```js
const [scan, long, ok] = await Promise.all([
  tools.agent({ node: "scan", task: "Count the files." }),
  tools.agent({ node: "long", task: "Run the long job." }),
  tools.approve({ summary: "Integrate the scan and the long job?" }),
]);
if (!ok.approved) return { stopped: ok.status, scan, long };
const merged = await tools.agent({ node: "integrate", task: JSON.stringify({ scan, long }) });
return { scan, long, ok, merged };
```

- **`agent`** (`callers: ["tools"]`, replay-safe) runs a subagent conversation owned by its tool task, found again after a restart by `scanConversations({ ownerTaskId })`, and submits with a request ID derived from the task ID. It returns the subagent's JSON answer as `structuredOutput`, so the script gets a typed value.
- **`approve`** is spike 4's approval record, answered by one host commit.
- **The subagents' own tools.** `work` is a quick effect, marked started by a memo first. `job` starts a long process as its own systemd user unit (`systemd-run --user --collect`), memoizes the unit name, and waits for the unit's result file. A rerun finds the memo and reattaches. An abort stops the unit.
- **`parallel` is `Promise.all`.** Code mode runs a script's tool calls concurrently and journals each result, so no `parallel` tool is needed.
- Every node's effect is logged in `effects.log`, outside pi-durable's store.

## What code mode needed

- **No deadline.** `CodemodeSandbox` ends every execution after 300 s by default, *including time spent in tools*. A workflow sandbox is created with `timeoutMs: Infinity`. A script can still set its own deadline with `// @options: {"timeout_ms": …}`. That deadline is stored when the script starts, and a rerun after it passes fails ("its deadline passed while it was interrupted"), so Cairn's workflow tool should strip or refuse that option.
- **Long work runs outside the brain.** A node's long job can't live in the brain's process, since a `kill -9` ends it. It runs in its own unit, and the tool holds only its handle. The same pattern carries over to stones (a container's handle) and to Claude through the bridge.
- **Results don't move between runs.** The scan finished before the first kill. After the restart, the script got its result from the journal, and the scan's subagent never ran again.

## Numbers

The gate run (`gate.sh`):

| Measure | Result |
| --- | --- |
| The long node's job | 960 s, in its own unit; the script's reported wall time was 960.4 s |
| `kill -9`s | 2: at 8 s (mid fan-out, scan done, job running, approval pending) and at 5 min 13 s |
| Restart to the job reattached | 17 ms after the Harness opened, both times |
| Approval answered | at 6 min 18 s, after both kills; the approval settled in under 1 ms |
| Effects: scan / long job / approval asked / integrate | 1 / 1 / 1 / 1 |
| Brain RSS with one workflow waiting (QuickJS worker included), 65 samples | 123 to 150 MiB |

The judge (`judge.sh`, a 15 s job, each case in a fresh store):

```
plain                PASS  effects scan/long/approve/integrate 1 1 1 1 (want 1 1 1 1)  restarts 0
kill-fanout          PASS  effects scan/long/approve/integrate 1 1 1 1 (want 1 1 1 1)  restarts 1
kill-before-nodes    PASS  effects scan/long/approve/integrate 1 1 1 1 (want 1 1 1 1)  restarts 1
kill-thrice          PASS  effects scan/long/approve/integrate 1 1 1 1 (want 1 1 1 1)  restarts 3
kill-in-integrate    PASS  effects scan/long/approve/integrate 1 1 1 1 (want 1 1 1 1)  restarts 1
decline              PASS  effects scan/long/approve/integrate 1 1 1 0 (want 1 1 1 0)  restarts 0
abort                PASS  job unit after abort: inactive, stopped events 1
```

`kill-thrice` kills during the fan-out, again while the job runs, and again right after the approval settles. The third kill landed before `approve`'s result was committed, so the rerun read the same answer again. The first version of the judge counted that as a second effect. Asking is the node's effect, and the user was asked once; the judge now counts asks.

## Decisions

- **Workflows are code-mode scripts in a sandbox with no deadline**, and Cairn's workflow tool refuses a script deadline. ADR 0012 accepted.
- **Every node is a replay-safe nested tool** that finds its earlier work after a restart: a subagent by its owner, a submission by its request ID, a job by its memoized handle, and an approval by its record. A node that can't do that isn't safe in a workflow.
- **Long work runs outside the brain behind a durable handle**, and an abort ends it.
- **`parallel` is `Promise.all`.** The kickoff's `parallel` tool isn't needed.

## Noticed

- In the first trial, a failed node failed the script, and code mode cancelled the other nested calls. The job's unit kept running, because the tool had no abort path then. It does now (the `abort` case).
- pi-durable 1.3.0 again lacks the main-branch spec's `sleeping` tasks and restart limit (see spike 4). Waits here live in replay-safe tools.
- Not covered: a script that diverges on replay (a change to the script or to the code-mode version), and real models writing workflows.

## Files

- `brain.ts`: the brain, the workflow tools, and a small HTTP answer and abort endpoint on `127.0.0.1:3774`. `node brain.ts <runDir> [submit <token>]`.
- `gate.sh`: the 16 minute run with two kills.
- `judge.sh`: the kill cases. `./judge.sh [case...]`.
- `runs/` (ignored): stores, events, effects and memory samples.
