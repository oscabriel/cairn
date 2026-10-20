---
status: proposed
gate: S1
---

# Stones are brained at home, with arms on Cloudflare

A stone is a pi-durable conversation in the brain's own harness whose `HarnessOptions.env` returns a `ContainerExecutionEnv`, talking over a link to a `Workspace` Durable Object that owns `ctx.container` (Sandbox SDK 1.0). That keeps Claude, Executor and every credential on the Beelink, with one transcript store and one UI path. Research 02 recommended the opposite (a stone brained in its own Durable Object); that design is the fallback, and it moves the loop against the user's stated choice, so every fix the S1 measurements point to comes first.

Gate S1: `registerEnvConformance` passes against a deployed container driven from the Beelink, exec p50 is at most 150 ms, a mid-turn Worker eviction recovers without rerunning an unsafe tool, and no local Docker is used.
