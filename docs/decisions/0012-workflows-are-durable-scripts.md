---
status: proposed
gate: S3
---

# Workflows are durable scripts on pi-durable

The model writes a workflow as a JavaScript program run in pi-codemode's deterministic QuickJS sandbox. Its tools (`agent`, `stone`, `parallel`, `verify`, `integrate`, `approve`) are durable nested tool tasks, so a crashed workflow resumes from its journal. Scripts fail when their timeout passes or a replay diverges, so a workflow that waits must wait on a durable task, never inside a script call that holds a timeout. The fallback is a Cairn-owned DAG of durable tasks.

Gate S3: a four-node workflow survives `kill -9` of the brain mid fan-out with no node rerun and no result lost, with one node waiting on an approval and one running longer than 15 minutes.
