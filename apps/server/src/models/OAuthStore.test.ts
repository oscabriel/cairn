// Cairn's OAuth store on temporary paths (never the deployed database or lock): sign-in and refresh
// times, one holder, one write at a time, a write that outlives its caller's interruption, and the
// pi-ai-facing source refusing an API key. Assertions read tokens the test minted, never real ones.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { OAuthCredential } from "@earendil-works/pi-ai";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
} from "effect";

import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { OAuthCredentials0007 } from "../db/migrations/0007OAuthCredentials.ts";
import { OAuthStore } from "./OAuthStore.ts";

const Sql = Database.layerTest({
  ...migrations,
  "0007_OAuthCredentials": OAuthCredentials0007,
});

const lockPath = () =>
  path.join(mkdtempSync(path.join(tmpdir(), "cairn-oauth-")), "oauth.lock");

const credential = (refresh: string): OAuthCredential => ({
  type: "oauth",
  access: `access-${refresh}`,
  refresh,
  expires: 1,
  accountId: "acct_test",
});

const holderAt = (lock: string) =>
  Effect.map(Layer.build(OAuthStore.layerWith(lock)), (context) =>
    Context.get(context, OAuthStore)
  );

const refreshOf = (found: Option.Option<OAuthCredential>) =>
  Option.match(found, { onNone: () => "none", onSome: (c) => c.refresh });

describe("the OAuth store", () => {
  it.live("keeps a sign-in, its refresh time, and a sign-out", () =>
    Effect.gen(function* () {
      const store = yield* holderAt(lockPath());

      assert.isTrue(store.held);
      assert.isTrue(Option.isNone(yield* store.read("openai-codex")));

      yield* store.signIn("openai-codex", credential("rt_1"));

      const signedIn = Option.getOrThrow(yield* store.signedIn("openai-codex"));

      assert.isTrue(Option.isNone(signedIn.refreshedAt));

      const next = yield* store.modify("openai-codex", (current) =>
        Effect.succeed(
          Option.map(current, (found) => ({ ...found, refresh: "rt_2" }))
        )
      );

      assert.strictEqual(refreshOf(next), "rt_2");
      assert.strictEqual(refreshOf(yield* store.read("openai-codex")), "rt_2");
      // pi-ai's extra fields survive the round trip.
      assert.strictEqual(
        Option.getOrThrow(yield* store.read("openai-codex")).accountId,
        "acct_test"
      );

      const refreshed = Option.getOrThrow(
        yield* store.signedIn("openai-codex")
      );

      assert.isTrue(Option.isSome(refreshed.refreshedAt));

      assert.isTrue(yield* store.remove("openai-codex"));
      assert.isFalse(yield* store.remove("openai-codex"));
      assert.isTrue(Option.isNone(yield* store.read("openai-codex")));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
    )
  );

  it.live("has one holder: a second process never reads or writes", () =>
    Effect.gen(function* () {
      const lock = lockPath();
      const first = yield* holderAt(lock);
      const second = yield* holderAt(lock);

      yield* first.signIn("openai-codex", credential("rt_1"));

      assert.isTrue(first.held);
      assert.isFalse(second.held);
      assert.isTrue(Option.isNone(yield* second.read("openai-codex")));
      assert.isTrue(Option.isNone(yield* second.signedIn("openai-codex")));

      const refused = yield* second
        .modify("openai-codex", () =>
          Effect.succeedSome(credential("rt_stolen"))
        )
        .pipe(Effect.flip);

      assert.strictEqual(refused._tag, "OAuthStoreError");

      if (Predicate.isTagged(refused, "OAuthStoreError")) {
        assert.strictEqual(refused.reason, "not_holder");
      }

      const signInRefused = yield* second
        .signIn("openai-codex", credential("rt_stolen"))
        .pipe(Effect.flip);

      assert.strictEqual(signInRefused.reason, "not_holder");
      assert.strictEqual(refreshOf(yield* first.read("openai-codex")), "rt_1");

      const viaSource = yield* Effect.promise(
        async () =>
          await second.source
            .modify("openai-codex", async () => {
              await Promise.resolve();
            })
            .then(
              () => "resolved",
              () => "rejected"
            )
      );

      assert.strictEqual(viaSource, "rejected");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
    )
  );

  it.live("frees the lock when its holder's scope closes", () =>
    Effect.gen(function* () {
      const lock = lockPath();

      yield* Effect.scoped(holderAt(lock));

      const next = yield* holderAt(lock);

      assert.isTrue(next.held);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
    )
  );

  it.live("runs one update at a time, each over the last one's write", () =>
    Effect.gen(function* () {
      const store = yield* holderAt(lockPath());

      yield* store.signIn("openai-codex", credential("0"));

      const bump = store.modify("openai-codex", (current) =>
        Effect.gen(function* () {
          yield* Effect.sleep("20 millis");

          return Option.map(current, (found) => ({
            ...found,
            refresh: String(Number(found.refresh) + 1),
          }));
        })
      );

      yield* Effect.all([bump, bump, bump, bump], { concurrency: "unbounded" });

      assert.strictEqual(refreshOf(yield* store.read("openai-codex")), "4");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
    )
  );

  it.live(
    "writes an update's answer even when its caller is interrupted meanwhile",
    () =>
      Effect.gen(function* () {
        const store = yield* holderAt(lockPath());
        const started = yield* Deferred.make<boolean>();

        yield* store.signIn("openai-codex", credential("rt_1"));

        // The provider has already rotated the token when the caller gives up.
        const refresh = yield* store
          .modify("openai-codex", (current) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, true);
              yield* Effect.sleep("50 millis");

              return Option.map(current, (found) => ({
                ...found,
                refresh: "rt_rotated",
              }));
            })
          )
          .pipe(Effect.forkChild);

        yield* Deferred.await(started);
        yield* Fiber.interrupt(refresh);

        assert.strictEqual(
          refreshOf(yield* store.read("openai-codex")),
          "rt_rotated"
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
      )
  );

  it.live(
    "refuses an API key through pi-ai's methods and passes their errors on",
    () =>
      Effect.gen(function* () {
        const store = yield* holderAt(lockPath());

        const keyed = yield* Effect.promise(
          async () =>
            await store.source
              .modify(
                "openai-codex",
                async () =>
                  await Promise.resolve({ type: "api_key" as const, key: "k" })
              )
              .then(
                () => "resolved",
                () => "rejected"
              )
        );

        class ProviderRefusedError extends Error {
          override name = "ProviderRefusedError";
        }

        const passed = yield* Effect.tryPromise({
          try: async () =>
            await store.source.modify(
              "openai-codex",
              async () =>
                await Promise.reject(new ProviderRefusedError("refresh failed"))
            ),
          catch: (cause) =>
            cause instanceof ProviderRefusedError ? "same error" : "other",
        }).pipe(Effect.flip);

        assert.strictEqual(keyed, "rejected");
        assert.strictEqual(passed, "same error");
        assert.isTrue(Option.isNone(yield* store.read("openai-codex")));
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
      )
  );
});
