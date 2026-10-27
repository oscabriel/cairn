// The memo-map rule a per-scope layer build must follow, pinned for effect 4.0.5. A layer is
// memoized by reference in a memo map, and the map is inherited: `Layer.buildWithMemoMap` puts it
// in the built context as `Layer.CurrentMemoMap`, and `Layer.build` (so `Effect.provide` and
// `Layer.launch` too) builds into a fork of the inherited map, which still answers from every entry
// its parent holds. `LayerMap.make` builds every key into one shared fork. So a scope built inside
// another (a subagent inside its parent thread's turn), or beside a root that already holds the
// layer, or as a `LayerMap` key beside another key, is handed the instance that already exists.
//
// Cairn builds no per-thread layer today: the brain is one layer under `Layer.launch`, the
// per-socket RPC server provides plain values, and the per-scope `Layer.build` calls (the web
// connection, the conformance restart) build siblings, which a fork keeps apart. A subagent per
// thread must build its scope with a fresh memo map, as `freshMemoMap` here does. The check is
// first shown to catch the broken builds, then run over the one phase 2 must use.
//
// Ported from github.com/humanlayer/fold, packages/fold-core/test/Api/SessionIsolation.vi.test.ts
// and packages/fold-core/src/Api/Provisioning.ts at 4bd8c58c4c644ad43df573c156ecdf8bddedd04d.
// Kept: two scopes alive at once each own their service, and a fresh memo map per build is the
// fix. Changed: one counted service instead of Fold's sessions, and the nested and LayerMap cases.
//
// MIT License. Copyright (c) 2026 HumanLayer
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer, LayerMap, Scope } from "effect";

/** A service the root builds once, as `Layer.launch` builds the app. */
class Brain extends Context.Service<Brain, { readonly name: string }>()(
  "cairn/server/brain/MemoMapIsolation/Brain"
) {
  static readonly layer = Layer.effect(
    Brain,
    Effect.sync(() => Brain.of({ name: "brain" }))
  );
}

/** A service every scope must own: a new object per build, compared by identity. */
class Subagent extends Context.Service<Subagent, { readonly name: string }>()(
  "cairn/server/brain/MemoMapIsolation/Subagent"
) {
  static readonly layer = Layer.effect(
    Subagent,
    Effect.sync(() => Subagent.of({ name: "subagent" }))
  );
}

/** One way to build `Subagent` for a scope; `rootMemoMap` is the map the root was built with. */
type Build = (
  rootMemoMap: Layer.MemoMap
) => Effect.Effect<Context.Context<Subagent>, never, Scope.Scope>;

/** What the per-scope sites call today: a fork of the inherited memo map. */
const layerBuild: Build = () => Layer.build(Subagent.layer);

/** The broken control: every scope builds into the root's one memo map. */
const sharedMemoMap: Build = Effect.fnUntraced(function* (rootMemoMap) {
  return yield* Layer.buildWithMemoMap(
    Subagent.layer,
    rootMemoMap,
    yield* Effect.scope
  );
});

/** What a per-scope build must do: a memo map of its own (Fold's `provisionAgentRuntime`). */
const freshMemoMap: Build = Effect.fnUntraced(function* () {
  return yield* Layer.buildWithMemoMap(
    Subagent.layer,
    yield* Layer.makeMemoMap,
    yield* Effect.scope
  );
});

/** Builds `Subagent` with `build` in a scope of its own, opened inside `surroundings`. */
const buildIn = Effect.fnUntraced(function* (
  build: Build,
  rootMemoMap: Layer.MemoMap,
  surroundings: Context.Context<never>
) {
  const scope = yield* Scope.make();

  yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));

  return yield* build(rootMemoMap).pipe(
    Scope.provide(scope),
    Effect.provideContext(surroundings)
  );
});

/** A root built the way `Layer.launch` builds one, with a memo map of its own. */
const buildRoot = Effect.fnUntraced(function* <ROut>(layer: Layer.Layer<ROut>) {
  const memoMap = yield* Layer.makeMemoMap;

  const context = yield* Layer.buildWithMemoMap(
    layer,
    memoMap,
    yield* Effect.scope
  );

  return { memoMap, context };
});

/** Every way `build` let one scope's `Subagent` reach another while both were open, described. */
const leaks = Effect.fnUntraced(function* (build: Build) {
  const found: Array<string> = [];

  // Siblings: two scopes opened one after the other under a root that never built `Subagent`.
  const brain = yield* buildRoot(Brain.layer);
  const first = yield* buildIn(build, brain.memoMap, brain.context);
  const second = yield* buildIn(build, brain.memoMap, brain.context);

  if (Context.get(first, Subagent) === Context.get(second, Subagent)) {
    found.push("a sibling scope got the first scope's instance");
  }

  // Nested: a scope opened inside the first one's services, as a subagent runs in its parent's turn.
  const nested = yield* buildIn(
    build,
    brain.memoMap,
    Context.merge(brain.context, first)
  );

  if (Context.get(nested, Subagent) === Context.get(first, Subagent)) {
    found.push("a nested scope got its parent's instance");
  }

  // Root-held: the root already built the same layer by reference.
  const app = yield* buildRoot(Layer.merge(Brain.layer, Subagent.layer));
  const scoped = yield* buildIn(build, app.memoMap, app.context);

  if (Context.get(scoped, Subagent) === Context.get(app.context, Subagent)) {
    found.push("a scope got the instance the root holds");
  }

  return found;
});

describe("per-scope layer builds", () => {
  it.effect("the check catches a memo map shared by every scope", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* leaks(sharedMemoMap), [
        "a sibling scope got the first scope's instance",
        "a nested scope got its parent's instance",
        "a scope got the instance the root holds",
      ]);
    })
  );

  it.effect(
    "Layer.build keeps siblings apart but hands a nested scope its parent's instance",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* leaks(layerBuild), [
          "a nested scope got its parent's instance",
          "a scope got the instance the root holds",
        ]);
      })
  );

  it.effect(
    "LayerMap hands two keys alive at once one instance of a shared layer",
    () =>
      Effect.gen(function* () {
        const shared = yield* LayerMap.make(() => Subagent.layer);
        const fresh = yield* LayerMap.make(() => Layer.fresh(Subagent.layer));

        const instance = (map: typeof shared, key: string) =>
          Effect.map(map.contextEffect(key), Context.get(Subagent));

        assert.strictEqual(
          yield* instance(shared, "thread-a"),
          yield* instance(shared, "thread-b")
        );
        assert.notStrictEqual(
          yield* instance(fresh, "thread-a"),
          yield* instance(fresh, "thread-b")
        );
      })
  );

  it.effect(
    "a fresh memo map per scope gives every scope its own instance",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* leaks(freshMemoMap), []);
      })
  );
});
