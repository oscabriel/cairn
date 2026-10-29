// `reach.list` and `artifact.revoke` over the stubs, as `Handlers.ts` layers them: the list answers
// what `ReachLister` gives; revoke answers nothing on success, `NotFound` for an unknown artifact,
// `Unavailable` when porch's config cannot be read, and `Internal` (without the cause) when the
// store fails.

import { ArtifactId } from "@cairn/protocol/Reach";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Predicate } from "effect";
import { RpcTest } from "effect/rpc";

import {
  ArtifactNotFound,
  Artifacts,
  ArtifactsError,
} from "../reach/Artifacts.ts";
import { PorchError } from "../reach/PorchClient.ts";
import { ReachLister } from "../reach/ReachLister.ts";
import { ViewerTest } from "../shell/ShellTestKit.ts";
import { ReachHandlers } from "./ReachHandlers.ts";
import { stubHandlers } from "./StubHandlers.ts";

const Stubs = CairnRpcs.toLayer(Effect.succeed(CairnRpcs.of(stubHandlers)));

const makeClient = RpcTest.makeClient(CairnRpcs);

const ID = ArtifactId.make("art_0123456789abcdef0123456789abcdef");

const storeDown = new ArtifactsError({
  message: "secret SQL detail",
  operation: "reach.list",
  reason: "store",
});

/** Fails every revoke with `failure`; with none, a revoke is not expected. */
const artifactsFailing = (
  failure: Option.Option<ArtifactNotFound | ArtifactsError | PorchError>
) =>
  Layer.mock(Artifacts)({
    revoke: () =>
      Option.match(failure, {
        onNone: () => Effect.die("a revoke that succeeds is not answered here"),
        onSome: (error) => Effect.fail(error),
      }),
  });

const lister = (answer: Effect.Effect<never, ArtifactsError> | "empty") =>
  Layer.mock(ReachLister)({
    list: () =>
      answer === "empty"
        ? Effect.succeed({ artifacts: [], portals: [] })
        : answer,
  });

const run = <A, E>(
  layers: Layer.Layer<Artifacts | ReachLister>,
  body: (client: Effect.Success<typeof makeClient>) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const client = yield* makeClient;

    return yield* body(client);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(Stubs, ReachHandlers.pipe(Layer.provide(layers))).pipe(
        Layer.provideMerge(ViewerTest)
      )
    )
  );

describe("reach handlers", () => {
  it.effect(
    "reach.list answers the lister's rows; a store failure is Internal",
    () =>
      Effect.gen(function* () {
        const empty = yield* run(
          Layer.merge(artifactsFailing(Option.none()), lister("empty")),
          (client) => client["reach.list"]({ threadId: Option.none() })
        );

        assert.deepStrictEqual(empty, { artifacts: [], portals: [] });

        const failed = yield* run(
          Layer.merge(
            artifactsFailing(Option.none()),
            lister(Effect.fail(storeDown))
          ),
          (client) =>
            Effect.flip(client["reach.list"]({ threadId: Option.none() }))
        );

        assert.strictEqual(failed._tag, "Internal");
        assert.notInclude(failed.message, "secret SQL detail");
      })
  );

  it.effect("artifact.revoke maps each failure", () =>
    Effect.gen(function* () {
      const revoke = (
        failure: ArtifactNotFound | ArtifactsError | PorchError
      ) =>
        run(
          Layer.merge(artifactsFailing(Option.some(failure)), lister("empty")),
          (client) => Effect.flip(client["artifact.revoke"]({ artifactId: ID }))
        );

      const missing = yield* revoke(
        new ArtifactNotFound({
          message: "No published artifact",
          artifactId: ID,
        })
      );

      assert.isTrue(
        Predicate.isTagged(missing, "NotFound") &&
          missing.resource === "artifact" &&
          missing.id === ID
      );

      const porch = yield* revoke(
        new PorchError({
          message: "porch machine refused (no-config)",
          operation: "machine",
          reason: "no-config",
          porchCode: Option.some("no-config"),
          detail: "",
          retryable: false,
        })
      );

      assert.strictEqual(porch._tag, "Unavailable");

      const store = yield* revoke(storeDown);
      assert.strictEqual(store._tag, "Internal");
      assert.notInclude(store.message, "secret");
    })
  );
});
