---
status: proposed
gate: S4
---

# Approvals are durable records

pi-durable has no "wait for a human" primitive, and its hooks may only block or rewrite. So an approval or a question to the user is an approval document plus a task that waits until a host commit resolves it, modelled on t3code's `runtime_request`. Executor's approvals feed the same queue. Permission modes follow t3code's, defaulting to full access. The fallback is live-only approvals, failed as interrupted on restart.

Gate S4: an approval pending across a brain restart can still be answered from the phone and runs exactly once.
