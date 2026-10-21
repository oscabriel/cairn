---
status: accepted
gate: S1
---

# Stones are brained at home, with arms on Cloudflare

A stone is a pi-durable conversation in the brain's own harness whose `HarnessOptions.env` returns a `ContainerExecutionEnv`, talking over a link to a `Workspace` Durable Object that owns `ctx.container` (Sandbox SDK 1.0). That keeps Claude, Executor and every credential on the Beelink, with one transcript store and one UI path. Research 02 recommended the opposite (a stone brained in its own Durable Object); that design is the fallback, and it moves the loop against the user's stated choice, so every fix the S1 measurements point to comes first.

Gate S1: `registerEnvConformance` passes against a deployed container driven from the Beelink, exec p50 is at most 150 ms, a mid-turn Worker eviction recovers without rerunning an unsafe tool, and no local Docker is used.

Passed on 2026-10-21; measured in `spikes/1-stones/NOTES.md`. The env is pi-env's `RemoteExecutionEnv`, whose `Connection` spawns a relay that carries the daemon's stdin and stdout over the link, so Cairn writes no ExecutionEnv of its own. Conformance passed 29 of 29 from the Beelink, exec p50 was 37 ms, and an eviction mid-command reported the call lost without rerunning it, on a container that outlived the object. An eviction ends the foreground command, so long work in a stone runs in the background. The stone image is built in GitHub Actions and deployed by digest. `@cloudflare/computer` 0.6.0 has no deployable shell, so it is not a stone's arms.
