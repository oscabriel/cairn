// The login RPCs over the stubs, as `Handlers.ts` layers them: a provider other than Codex is
// `InvalidInput` on `provider`, a second sign-in is `Conflict`, and a brain without Cairn's OAuth
// store answers the stream with one `Failed` step and `providers.logout` with `Unavailable`.

import type { LoginProgress } from "@cairn/protocol/Models";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Predicate, Stream } from "effect";
import type { Scope } from "effect";
import { RpcTest } from "effect/rpc";

import { CodexLogin, CodexLoginBusy } from "../models/CodexLogin.ts";
import { ViewerTest } from "../shell/ShellTestKit.ts";
import { LoginHandlers } from "./LoginHandlers.ts";
import { stubHandlers } from "./StubHandlers.ts";

const Stubs = CairnRpcs.toLayer(Effect.succeed(CairnRpcs.of(stubHandlers)));

const handlersWith = (login: Layer.Layer<CodexLogin>) =>
  Layer.mergeAll(Stubs, LoginHandlers.pipe(Layer.provide(login))).pipe(
    Layer.provideMerge(ViewerTest)
  );

/** A sign-in that is always busy, to see the conflict's translation. */
const BusyLogin = Layer.mock(CodexLogin)({
  start: Stream.fail(new CodexLoginBusy({ message: "busy" })),
  cancel: Effect.succeed(false),
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
});
