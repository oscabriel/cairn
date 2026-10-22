// J1: pi-ai's built-in Anthropic OAuth is refused in every layer (ADR 0002, plan "How the bridge
// plugs in"). The brain's model runtime is built over a fixture agent dir whose auth.json holds an
// `anthropic` OAuth credential and a fake `sk-ant-oat01-` key under another provider, with every
// Anthropic auth variable set to a fake token. A spy `fetch` fails the test if any request leaves.
// Judged: the variables are gone from `process.env`, `anthropic` resolves no auth, no `anthropic`
// model is available or listed, the registered `anthropic` provider has no `auth.oauth`, and a
// request carrying a subscription token or a Bearer header ends in an error without a fetch.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { hasApi, normalizeContext } from "@earendil-works/pi-ai";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ModelSource } from "../brain/ModelSource.ts";
import {
  ANTHROPIC_AUTH_ENV,
  GUARDED_PROVIDER_KEYS,
  guardedAnthropicProvider,
  REFUSED_REQUEST_TEXT,
} from "./AnthropicGuard.ts";
import { HarnessSettings } from "./HarnessSettings.ts";
import { PiConfig } from "./PiConfig.ts";
import { PiModelSource } from "./PiModelSource.ts";

const FAKE_OAT = "sk-ant-oat01-fake-token-for-the-judge";

const fetchCalls: Array<string> = [];

const spyFetch: typeof fetch = async (input) => {
  fetchCalls.push(input instanceof Request ? input.url : String(input));

  return await Promise.reject(
    new Error("J1 spy fetch: no request may leave the brain")
  );
};

/** The process state the judge changes, restored afterwards. */
const saved = {
  env: new Map<string, Option.Option<string>>(),
  fetch: globalThis.fetch,
};

const root = mkdtempSync(path.join(tmpdir(), "cairn-j1-"));

const dirs = {
  agentDir: path.join(root, "agent"),
  home: path.join(root, "home"),
  cwd: path.join(root, "cwd"),
};

const seed = () => {
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(
    path.join(dirs.agentDir, "auth.json"),
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: FAKE_OAT,
        refresh: "fake-refresh",
        expires: 4_102_444_800_000,
      },
      "kimi-coding": { type: "api_key", key: FAKE_OAT },
    }),
    { mode: 0o600 }
  );

  for (const name of [...ANTHROPIC_AUTH_ENV, "PI_OFFLINE", "HOME"]) {
    saved.env.set(name, Option.fromNullishOr(process.env[name]));
  }

  for (const name of ANTHROPIC_AUTH_ENV) {
    process.env[name] = FAKE_OAT;
  }

  // No catalog refresh over the network in a test; the spy would see it.
  process.env.PI_OFFLINE = "1";
  process.env.HOME = dirs.home;
  globalThis.fetch = spyFetch;
};

const restore = () => {
  globalThis.fetch = saved.fetch;

  for (const [name, value] of saved.env) {
    if (Option.isSome(value)) {
      process.env[name] = value.value;
    } else {
      Reflect.deleteProperty(process.env, name);
    }
  }
};

const ModelsLayer = PiModelSource.layerNoDeps.pipe(
  Layer.provide(HarnessSettings.layerNoDeps),
  Layer.provide(Layer.suspend(() => PiConfig.layerWith(dirs)))
);

const userTurn: ModelContext = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("J1: pi-ai's Anthropic OAuth is refused", () => {
  beforeAll(seed);

  afterAll(restore);

  it.live("strips, hides, replaces and refuses at every layer", () =>
    Effect.gen(function* () {
      const source = yield* ModelSource;
      const catalog = yield* PiModelSource;
      const runtime = source.models();

      for (const name of ANTHROPIC_AUTH_ENV) {
        assert.isUndefined(process.env[name], `${name} must be stripped`);
      }

      const auth = yield* Effect.promise(
        async () => await runtime.getAuth("anthropic")
      );

      assert.isUndefined(auth, "anthropic must resolve no auth");

      const available = yield* Effect.promise(
        async () => await runtime.getAvailable("anthropic")
      );

      assert.deepStrictEqual(available, [], "no anthropic model is available");

      const listed = yield* catalog.catalog({ bridgeEnabled: true });

      assert.isFalse(
        listed.models.some((model) => model.provider === "anthropic"),
        "no anthropic model is listed"
      );

      const provider = runtime.getProvider("anthropic");

      assert.isDefined(
        provider,
        "the guarded anthropic provider is registered"
      );
      assert.isUndefined(provider?.auth.oauth, "it has no OAuth login");

      const statuses = yield* catalog.providers;

      assert.deepInclude(
        statuses.map((status) => [status.provider, status.state]),
        ["anthropic", "refused"]
      );

      const [model] = runtime.getModels("anthropic");

      if (model === undefined || !hasApi(model, "anthropic-messages")) {
        assert.fail("pi-ai still knows anthropic's catalog");
      }

      // Through the runtime: unconfigured, then a caller-supplied token, then a Bearer header.
      for (const options of [
        {},
        { apiKey: FAKE_OAT },
        { headers: { Authorization: `Bearer ${FAKE_OAT}` } },
      ]) {
        const answer = yield* Effect.promise(
          async () =>
            await runtime.completeSimple(model, userTurn, {
              ...options,
              fetch: spyFetch,
            })
        );

        assert.strictEqual(answer.stopReason, "error");
        assert.deepStrictEqual(fetchCalls, [], "no request left the brain");
      }

      // The direct `completeSimple` refuses the model as not offered.
      const direct = yield* Effect.flip(
        source.completeSimple(
          { provider: "anthropic", modelId: model.id },
          userTurn,
          { fetch: spyFetch }
        )
      );

      assert.strictEqual(direct.reason, "unknown_model");

      // The provider itself, bypassing the runtime: neither a token nor a Bearer header reaches fetch.
      const guarded = guardedAnthropicProvider();

      for (const options of [
        { apiKey: FAKE_OAT },
        { apiKey: "sk-ant-api03-fake", headers: { authorization: "Bearer x" } },
      ]) {
        const refused = yield* Effect.promise(
          async () =>
            await guarded
              .streamSimple(model, normalizeContext(userTurn), {
                ...options,
                fetch: spyFetch,
              })
              .result()
        );

        assert.strictEqual(refused.stopReason, "error");
        assert.strictEqual(refused.errorMessage, REFUSED_REQUEST_TEXT);
      }

      assert.deepStrictEqual(fetchCalls, [], "no request left the brain");
    }).pipe(Effect.provide(ModelsLayer))
  );

  it.live("the guarded resolver takes only a metered key and no variable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const guarded = guardedAnthropicProvider();
        const resolver = guarded.auth.apiKey;

        assert.isUndefined(guarded.auth.oauth);

        if (resolver === undefined) {
          assert.fail("the guarded provider keeps API-key auth");
        }

        const ctx = {
          env: async (name: string) =>
            await Promise.resolve(`${FAKE_OAT}-${name}`),
          fileExists: async () => await Promise.resolve(true),
        };

        const signal = yield* Effect.abortSignal;

        const fromEnv = yield* Effect.promise(
          async () => await resolver.resolve({ ctx, signal })
        );

        const fromToken = yield* Effect.promise(
          async () =>
            await resolver.resolve({
              ctx,
              signal,
              credential: { type: "api_key", key: FAKE_OAT },
            })
        );

        const fromMetered = yield* Effect.promise(
          async () =>
            await resolver.resolve({
              ctx,
              signal,
              credential: { type: "api_key", key: "sk-ant-api03-fake" },
            })
        );

        assert.isUndefined(fromEnv, "no Anthropic variable resolves");
        assert.isUndefined(fromToken, "a subscription token does not resolve");
        assert.strictEqual(fromMetered?.source, "stored credential");
      })
    )
  );

  it("carries exactly the keys the guard was checked against", () => {
    assert.deepStrictEqual(
      Object.keys(guardedAnthropicProvider()).toSorted(),
      [...GUARDED_PROVIDER_KEYS].toSorted()
    );
  });
});
