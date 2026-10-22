---
status: accepted
gate: S3
---

# Workflows are durable scripts on pi-durable

The model writes a workflow as a JavaScript program run in pi-codemode's deterministic QuickJS sandbox. Its tools (`agent`, `stone`, `verify`, `integrate`, `approve`) are durable nested tool tasks, so a crashed workflow resumes from its journal. Fan-out is `Promise.all`: code mode runs a script's calls concurrently and journals each result, so there is no `parallel` tool.

Scripts fail when their deadline passes or a replay diverges. The workflow sandbox therefore has no deadline (`timeoutMs: Infinity`; the default is 300 s including time in tools), and Cairn refuses a script's own `timeout_ms`. Every node is a replay-safe tool that finds its earlier work after a restart: a subagent by its owning task, a submission by its request ID, an approval by its record (ADR 0013), and long work by a durable handle to a process outside the brain, which an abort ends.

Gate S3: a four-node workflow survives `kill -9` of the brain mid fan-out with no node rerun and no result lost, with one node waiting on an approval and one running longer than 15 minutes. Passed on 2026-10-21; measured in `spikes/3-workflows/NOTES.md`.

On pi-durable 1.4.0 (rerun 2026-10-22), five crashes in a row during a node's wait park the workflow's waiting tasks; a retry resumes them with no node rerun. Clean stops don't count, because the brain closes the Harness on SIGTERM. The UI shows parked tasks with a retry.
