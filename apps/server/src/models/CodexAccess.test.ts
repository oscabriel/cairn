// The Codex login the usage reader sends, over the real `OAuthStore` on a migrated in-memory
// `cairn.sqlite` behind a temporary lock (never the deployed database or lock): none while signed
// out, while another brain holds the lock, or when the login names no ChatGPT account; a fresh
// token as it is; a token near expiry refreshed first, under the store's permit, with the rotated
// token stored; a refused refresh reported and the stored login left alone. Tokens are the test's.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { OAuthCredential } from "@earendil-works/pi-ai";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
} from "effect";

import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { CodexAccess, REFRESH_MARGIN } from "./CodexAccess.ts";
import type { CodexRefresh } from "./CodexAccess.ts";
import { CODEX_PROVIDER } from "./CredentialStore.ts";
import { OAuthStore } from "./OAuthStore.ts";

const lockPath = () =>
  path.join(
    mkdtempSync(path.join(tmpdir(), "cairn-codex-access-")),
    "oauth.lock"
  );

const HOUR = 3_600_000;

const credential = (
  refresh: string,
  expires: number,
  accountId: Option.Option<string> = Option.some("acct_test")
): OAuthCredential => ({
  type: "oauth",
  access: `access-${refresh}`,
  refresh,
  expires,
  ...Option.match(accountId, {
    onNone: () => ({}),
    onSome: (id) => ({ accountId: id }),
  }),
});

/** A refresh that rotates `rt_n` to `rt_n+1` and counts its calls; or refuses. */
const fakeRefresh =
  (calls: Ref.Ref<number>, refuse: boolean): CodexRefresh =>
  async (current) => {
    const count = Effect.runSync(Ref.updateAndGet(calls, (n) => n + 1));

    if (refuse) {
      return await Promise.reject(new Error("invalid_grant"));
    }

    return await Promise.resolve(
      credential(`${current.refresh}-r${count}`, current.expires + 10 * HOUR)
    );
  };

/** The store and the access over it, on one database and lock. */
const accessOn = (lock: string, refresh: CodexRefresh) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      CodexAccess.layerWith(refresh).pipe(
        Layer.provideMerge(OAuthStore.layerWith(lock))
      )
    );

    return {
      store: Context.get(context, OAuthStore),
      access: Context.get(context, CodexAccess),
    };
  });

const Sql = Database.layerTest(migrations);

describe("the Codex login for usage reads", () => {
  it.live("reads nothing while signed out", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const { access } = yield* accessOn(lockPath(), fakeRefresh(calls, false));

      assert.isTrue(Option.isNone(yield* access.credential));
      assert.strictEqual(yield* Ref.get(calls), 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
    )
  );

  it.live("sends a fresh token as it is, with its account", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);

      const { store, access } = yield* accessOn(
        lockPath(),
        fakeRefresh(calls, false)
      );

      const now = yield* Clock.currentTimeMillis;

      yield* store.signIn(CODEX_PROVIDER, credential("rt_1", now + HOUR));

      const found = Option.getOrThrow(yield* access.credential);

      assert.strictEqual(Redacted.value(found.access), "access-rt_1");
      assert.strictEqual(found.accountId, "acct_test");
      assert.strictEqual(yield* Ref.get(calls), 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
    )
  );

  it.live(
    "refreshes a token near expiry first and stores the rotated one, once for concurrent reads",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);

        const { store, access } = yield* accessOn(
          lockPath(),
          fakeRefresh(calls, false)
        );

        const now = yield* Clock.currentTimeMillis;
        const nearExpiry = now + Duration.toMillis(REFRESH_MARGIN) - 1000;

        yield* store.signIn(CODEX_PROVIDER, credential("rt_1", nearExpiry));

        const [first, second] = yield* Effect.all(
          [access.credential, access.credential],
          { concurrency: 2 }
        );

        assert.strictEqual(yield* Ref.get(calls), 1);
        assert.strictEqual(
          Redacted.value(Option.getOrThrow(first).access),
          "access-rt_1-r1"
        );
        assert.strictEqual(
          Redacted.value(Option.getOrThrow(second).access),
          "access-rt_1-r1"
        );
        assert.strictEqual(
          Option.getOrThrow(yield* store.read(CODEX_PROVIDER)).refresh,
          "rt_1-r1"
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
      )
  );

  it.live("reports a refused refresh and leaves the stored login alone", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);

      const { store, access } = yield* accessOn(
        lockPath(),
        fakeRefresh(calls, true)
      );

      const now = yield* Clock.currentTimeMillis;

      yield* store.signIn(CODEX_PROVIDER, credential("rt_1", now - 1000));

      const failed = yield* Effect.flip(access.credential);

      assert.strictEqual(failed.reason, "refresh_failed");
      assert.notInclude(failed.message, "invalid_grant");
      assert.strictEqual(yield* Ref.get(calls), 1);
      assert.strictEqual(
        Option.getOrThrow(yield* store.read(CODEX_PROVIDER)).refresh,
        "rt_1"
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
    )
  );

  it.live("reads nothing for a login that names no ChatGPT account", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);

      const { store, access } = yield* accessOn(
        lockPath(),
        fakeRefresh(calls, false)
      );

      const now = yield* Clock.currentTimeMillis;

      yield* store.signIn(
        CODEX_PROVIDER,
        credential("rt_1", now + HOUR, Option.none())
      );

      assert.isTrue(Option.isNone(yield* access.credential));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
    )
  );

  it.live(
    "reads nothing and refreshes nothing in a brain that does not hold the lock",
    () =>
      Effect.gen(function* () {
        const lock = lockPath();
        const calls = yield* Ref.make(0);
        const holder = yield* accessOn(lock, fakeRefresh(calls, false));
        const now = yield* Clock.currentTimeMillis;

        yield* holder.store.signIn(
          CODEX_PROVIDER,
          credential("rt_1", now - 1000)
        );

        const second = yield* accessOn(lock, fakeRefresh(calls, false));

        assert.isFalse(second.store.held);
        assert.isTrue(Option.isNone(yield* second.access.credential));
        assert.strictEqual(yield* Ref.get(calls), 0);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
      )
  );

  it.effect("is signed out in `layerSignedOut`", () =>
    Effect.gen(function* () {
      const access = yield* CodexAccess;

      assert.isTrue(Option.isNone(yield* access.credential));
    }).pipe(Effect.provide(CodexAccess.layerSignedOut))
  );
});
