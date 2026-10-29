// The login RPCs over the stubs, as `Handlers.ts` layers them: a provider other than Codex is
// `InvalidInput` on `provider`, a second sign-in is `Conflict`, and a brain without Cairn's OAuth
// store answers the stream with one `Failed` step and `providers.logout` with `Unavailable`. A
// stored sign-in and a logout each forget the provider's health; a refused logout does not.

import { LoginProgress } from "@cairn/protocol/Models";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { RpcTest } from "effect/rpc";

import { CodexLogin, CodexLoginBusy } from "../models/CodexLogin.ts";
import { CODEX_PROVIDER } from "../models/CredentialStore.ts";
import { HealthOutcome, ModelHealth } from "../models/ModelHealth.ts";
import { ViewerTest } from "../shell/ShellTestKit.ts";
import { LoginHandlers } from "./LoginHandlers.ts";
import { stubHandlers } from "./StubHandlers.ts";

const LoginSteps = LoginProgress.pipe(Schema.toTaggedUnion("_tag"));

const Stubs = CairnRpcs.toLayer(Effect.succeed(CairnRpcs.of(stubHandlers)));

const handlersWith = (login: Layer.Layer<CodexLogin>) =>
  Layer.mergeAll(Stubs, LoginHandlers.pipe(Layer.provide(login))).pipe(
    Layer.provideMerge(ModelHealth.layerTest),
    Layer.provideMerge(ViewerTest)
  );

/** A sign-in that is always busy, to see the conflict's translation. */
const BusyLogin = Layer.mock(CodexLogin)({
  start: Stream.fail(new CodexLoginBusy({ message: "busy" })),
  cancel: Effect.succeed(false),
});

/** A sign-in that stores at once, and a logout that removes it. */
const SignedInLogin = Layer.mock(CodexLogin)({
  start: Stream.make(
    LoginSteps.cases.SignedIn.make({ account: Option.none() })
  ),
  logout: Effect.succeed(true),
});

/** Marks Codex failing with a revoked login, as a run's 401 would. */
const markRevoked = Effect.gen(function* () {
  const health = yield* ModelHealth;
  const at = yield* DateTime.now;

  yield* health.record(
    CODEX_PROVIDER,
    HealthOutcome.Failed({ at, message: "401 invalid_grant" })
  );

  assert.strictEqual((yield* health.stateOf(CODEX_PROVIDER)).state, "failing");
});

/** A step's tag, or a failure's reason. */
const labelOf = (step: LoginProgress) =>
  Predicate.isTagged(step, "Failed") ? step.reason : step._tag;

const makeClient = RpcTest.makeClient(CairnRpcs);

const run = <A, E>(
  login: Layer.Layer<CodexLogin>,
  body: Effect.Effect<
    A,
    E,
    Layer.Success<ReturnType<typeof handlersWith>> | Scope.Scope
  >
) => body.pipe(Effect.scoped, Effect.provide(handlersWith(login)));

describe("the login RPCs", () => {
  it.effect("refuse a provider Cairn does not sign in to", () =>
    run(
      CodexLogin.layer,
      Effect.gen(function* () {
        const client = yield* makeClient;

        const started = yield* client["providers.login.start"]({
          provider: "opencode-go",
        }).pipe(Stream.runCollect, Effect.flip);

        const loggedOut = yield* client["providers.logout"]({
          provider: "opencode-go",
        }).pipe(Effect.flip);

        assert.strictEqual(started._tag, "InvalidInput");
        assert.strictEqual(loggedOut._tag, "InvalidInput");

        if (Predicate.isTagged(loggedOut, "InvalidInput")) {
          assert.deepStrictEqual(loggedOut.field, Option.some("provider"));
        }

        // Nothing to cancel is not an error.
        yield* client["providers.login.cancel"]({ provider: "opencode-go" });
      })
    )
  );

  it.effect("answer unavailable on a brain without the OAuth store", () =>
    run(
      CodexLogin.layer,
      Effect.gen(function* () {
        const client = yield* makeClient;

        const steps = yield* client["providers.login.start"]({
          provider: "openai-codex",
        }).pipe(Stream.runCollect);

        assert.deepStrictEqual(
          steps.map((step) => labelOf(step)),
          ["unavailable"]
        );

        const refused = yield* client["providers.logout"]({
          provider: "openai-codex",
        }).pipe(Effect.flip);

        assert.strictEqual(refused._tag, "Unavailable");
      })
    )
  );

  it.effect("turn a second sign-in into a conflict", () =>
    run(
      BusyLogin,
      Effect.gen(function* () {
        const client = yield* makeClient;

        const busy = yield* client["providers.login.start"]({
          provider: "openai-codex",
        }).pipe(Stream.runCollect, Effect.flip);

        assert.strictEqual(busy._tag, "Conflict");

        if (Predicate.isTagged(busy, "Conflict")) {
          assert.strictEqual(busy.reason, "limit_reached");
        }
      })
    )
  );

  it.effect("forget the provider's health after a stored sign-in", () =>
    run(
      SignedInLogin,
      Effect.gen(function* () {
        const client = yield* makeClient;
        const health = yield* ModelHealth;

        yield* markRevoked;

        const steps = yield* client["providers.login.start"]({
          provider: CODEX_PROVIDER,
        }).pipe(Stream.runCollect);

        assert.deepStrictEqual(
          steps.map((step) => labelOf(step)),
          ["SignedIn"]
        );
        assert.strictEqual(
          (yield* health.stateOf(CODEX_PROVIDER)).state,
          "unknown"
        );
      })
    )
  );

  it.effect(
    "forget the provider's health after a logout, not after a refused one",
    () =>
      Effect.gen(function* () {
        yield* run(
          CodexLogin.layer,
          Effect.gen(function* () {
            const client = yield* makeClient;
            const health = yield* ModelHealth;

            yield* markRevoked;

            yield* client["providers.logout"]({
              provider: CODEX_PROVIDER,
            }).pipe(Effect.flip);

            assert.strictEqual(
              (yield* health.stateOf(CODEX_PROVIDER)).state,
              "failing"
            );
          })
        );

        yield* run(
          SignedInLogin,
          Effect.gen(function* () {
            const client = yield* makeClient;
            const health = yield* ModelHealth;

            yield* markRevoked;

            yield* client["providers.logout"]({ provider: CODEX_PROVIDER });

            assert.strictEqual(
              (yield* health.stateOf(CODEX_PROVIDER)).state,
              "unknown"
            );
          })
        );
      })
  );
});
