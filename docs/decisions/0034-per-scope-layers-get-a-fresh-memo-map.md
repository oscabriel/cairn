---
status: accepted
gate: `apps/server/src/brain/MemoMapIsolation.test.ts` extended to `ChildScope.build`, and a scan refusing direct builds under `subagents/` and `workflows/`
---

# Per-scope layers are built with a fresh memo map

In Effect 4.0.5 `Layer.build` and `Effect.provide(layer)` build into a fork of the ambient memo map, which still hands out every instance its parent or the process root built; `LayerMap.make` shares one fork across keys (`MemoMapIsolation.test.ts`, stage 2.6). So anything Cairn builds per subagent, child thread or workflow node (the workspace lease, the budget meter) goes through one `ChildScope.build`, which uses `Layer.makeMemoMap` with `Layer.buildWithMemoMap`. Direct `Layer.build`, `Effect.provide` of a layer and `LayerMap.make` are refused under `subagents/` and `workflows/`.

The agent loop itself is not affected: a child is a pi-durable conversation in the brain's one harness (ADR 0016), not a layer.

Decided by the user on 2026-10-27, from the phase 2 area notes.

Gate evidence: on `phase2/3A`, the extended `MemoMapIsolation.test.ts` found no leak through `ChildScope.build` (two children opened at once beside a root holding the layer give three instances, where the `Layer.build` control gives one, and a child is released on close), and the `ChildScope.test.ts` scan caught each planted `Layer.build`, `Layer.launch`, `Effect.provide`, `LayerMap.make` and memo-map build, including one planted in `Delivery.ts`. Both pass in `pnpm check` at the wave 3 integration of 3A on 2026-10-29. Accepted.
