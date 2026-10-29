// Per-scope layers (ADR 0034). A layer is memoized by reference, and the memo map is inherited:
// `Layer.build` (and so `Effect.provide` of a layer) builds into a fork of the map around it, which
// answers from every entry the root or an enclosing scope already holds, and `LayerMap.make` builds
// every key into one shared fork. Built from inside the brain's runtime, a subagent's or a workflow
// node's scope would be handed its parent's instance (`brain/MemoMapIsolation.test.ts` pins this).
//
// So anything Cairn builds per subagent, child thread or workflow node (a workspace lease, a
// budget meter, an Executor narrowing) goes through `ChildScope.build`: a scope of its own, forked
// from the caller's so it closes with the child's lifecycle, and a fresh memo map. Nothing under
// `subagents/` or `workflows/` calls `Layer.build`, `Effect.provide` with a layer or `LayerMap.make`
// directly; `ChildScope.test.ts` scans for them.

import { Effect, Exit, Layer, Scope } from "effect";
import type { Context } from "effect";

/** One child's built services and the way to release them before the caller's scope closes. */
export interface ChildServices<ROut> {
  readonly context: Context.Context<ROut>;
  readonly close: Effect.Effect<void>;
}

/**
 * Builds `layer` for one child: a fresh memo map, in a scope forked from the caller's, so every
 * child alive at once owns its own instances, released when the caller's scope closes or `close`
 * runs first. A failed build releases what it had built.
 */
const build = Effect.fnUntraced(function* <ROut, E, RIn>(
  layer: Layer.Layer<ROut, E, RIn>
) {
  const scope = yield* Scope.fork(yield* Effect.scope);

  const context = yield* Layer.buildWithMemoMap(
    layer,
    yield* Layer.makeMemoMap,
    scope
  ).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));

  const services: ChildServices<ROut> = {
    context,
    close: Scope.close(scope, Exit.void),
  };

  return services;
});

/** The one way to build a per-child layer (ADR 0034). */
export const ChildScope = { build } as const;
