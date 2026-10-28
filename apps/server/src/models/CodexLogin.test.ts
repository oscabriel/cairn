// J-codex, offline (ADR 0037): pi-ai's real Codex flow and refresh against a fake OpenAI sign-in
// (`FakeCodexAuth.ts`) that rotates the refresh token and revokes the grant on reuse. The device-code
// sign-in reaches the store and shows the account; a refresh under the store's permit persists the
// rotated token before anyone else reads it, so concurrent requests and a restarted brain never
// present a spent token; a second brain refuses to refresh; cancel stores nothing. The database is
// a temporary file and the lock a temporary path, never the deployed ones.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LoginProgress } from "@cairn/protocol/Models";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Stream,
} from "effect";

import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { OAuthCredentials0007 } from "../db/migrations/0007OAuthCredentials.ts";
import { CodexLogin } from "./CodexLogin.ts";
import { CairnCredentialStore, CODEX_PROVIDER } from "./CredentialStore.ts";
import type { FakeCodexAuth, FakeCodexAuthOptions } from "./FakeCodexAuth.ts";
import { FAKE_ACCOUNT, startFakeCodexAuth } from "./FakeCodexAuth.ts";
import { OAuthStore } from "./OAuthStore.ts";

const Migrations = {
  ...migrations,
  "0007_OAuthCredentials": OAuthCredentials0007,
};

interface Place {
  readonly database: string;
  readonly lock: string;
  readonly authPath: string;
}

const place = (): Place => {
  const directory = mkdtempSync(path.join(tmpdir(), "cairn-codex-"));

  return {
    database: path.join(directory, "cairn.sqlite"),
    lock: path.join(directory, "state", "oauth.lock"),
    // Never created: pi's file plays no part in Codex.
    authPath: path.join(directory, "pi", "auth.json"),
  };
};

/** One brain's store and sign-in over `where`, alive as long as the caller's scope. */
const brainAt = (where: Place) =>
  Effect.map(
    Layer.build(
      CodexLogin.layer.pipe(
        Layer.provideMerge(OAuthStore.layerWith(where.lock)),
        Layer.provideMerge(
          Database.layer({ filename: where.database, migrations: Migrations })
        ),
        Layer.provide(NodeServices.layer)
      )
    ),
    (context) => {
      const store = Context.get(context, OAuthStore);

      const credentials = new CairnCredentialStore(
        where.authPath,
        Option.some(store.source)
      );

      const models = createModels({ credentials });

      models.setProvider(openaiCodexProvider());

      return { store, login: Context.get(context, CodexLogin), models };
    }
  );

/** The fake, with the global `fetch` sent to it for the scope's life. */
const fakeAuth = (options: FakeCodexAuthOptions = {}) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const fake = await startFakeCodexAuth(options);
      const realFetch = globalThis.fetch;

      globalThis.fetch = fake.fetch;

      return { fake, realFetch };
    }),
    ({ fake, realFetch }) =>
      Effect.promise(async () => {
        globalThis.fetch = realFetch;
        await fake.close();
      })
  ).pipe(Effect.map(({ fake }) => fake));

/** Runs a sign-in, approving the code as soon as it is shown. */
const signInWith = (login: CodexLogin["Service"], fake: FakeCodexAuth) =>
  login.start.pipe(
    Stream.tap((step) =>
      Effect.sync(() => {
        if (Predicate.isTagged(step, "DeviceCode")) {
          fake.approve();
        }
      })
    ),
    Stream.runCollect
  );

/** A step's tag, or a failure's reason. */
const labelOf = (step: LoginProgress) =>
  Predicate.isTagged(step, "Failed") ? step.reason : step._tag;

const tagsOf = (steps: ReadonlyArray<LoginProgress>) =>
  steps.map((step) => step._tag);

const storedRefresh = (store: OAuthStore["Service"]) =>
  Effect.map(store.read(CODEX_PROVIDER), (found) =>
    Option.match(found, { onNone: () => "none", onSome: (c) => c.refresh })
  );

describe("the Codex sign-in against a fake OpenAI", () => {
  it.live(
    "signs in with a device code, shows the account and stores the grant",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeAuth();
        const brain = yield* brainAt(place());

        const steps = yield* signInWith(brain.login, fake);

        assert.deepStrictEqual(tagsOf(steps), ["DeviceCode", "SignedIn"]);

        for (const step of steps) {
          if (Predicate.isTagged(step, "DeviceCode")) {
            assert.strictEqual(step.userCode, "FAKE-CODE");
            assert.strictEqual(
              step.verificationUri,
              "https://auth.openai.com/codex/device"
            );
            assert.strictEqual(step.expiresInSeconds, 900);
          }

          if (Predicate.isTagged(step, "SignedIn")) {
            assert.strictEqual(
              Option.getOrNull(step.account),
              FAKE_ACCOUNT.email
            );
          }
        }

        // No step carries a token.
        assert.notInclude(JSON.stringify(steps), "rt_");
        assert.strictEqual(yield* storedRefresh(brain.store), fake.log.current);
        assert.strictEqual(
          Option.getOrThrow(yield* brain.store.read(CODEX_PROVIDER)).accountId,
          FAKE_ACCOUNT.accountId
        );

        // The model runtime sees Codex as available.
        const available = yield* Effect.promise(
          async () => await brain.models.getAvailable(CODEX_PROVIDER)
        );

        assert.isAbove(available.length, 0);
      }).pipe(Effect.scoped)
  );

  it.live(
    "refreshes once for concurrent requests, under the store's permit",
    () =>
      Effect.gen(function* () {
        // The sign-in's token is inside pi-ai's five-minute margin; a refreshed one is not.
        const fake = yield* fakeAuth({
          accessSeconds: 60,
          refreshedSeconds: 3600,
        });

        const brain = yield* brainAt(place());

        yield* signInWith(brain.login, fake);

        const auths = yield* Effect.promise(
          async () =>
            await Promise.all(
              [1, 2, 3, 4].map(
                async () => await brain.models.getAuth(CODEX_PROVIDER)
              )
            )
        );

        assert.isTrue(auths.every((auth) => auth?.auth.apiKey !== undefined));
        assert.strictEqual(fake.log.refreshes, 1);
        assert.strictEqual(fake.log.reuses, 0);
        assert.strictEqual(yield* storedRefresh(brain.store), fake.log.current);

        const refreshed = Option.getOrThrow(
          yield* brain.store.signedIn(CODEX_PROVIDER)
        );

        assert.isTrue(Option.isSome(refreshed.refreshedAt));
      }).pipe(Effect.scoped)
  );

  it.live(
    "persists the rotated token before release, so a restarted brain presents it",
    () =>
      Effect.gen(function* () {
        // Every access token is inside the margin, so each brain's first request refreshes.
        const fake = yield* fakeAuth({ accessSeconds: 60 });
        const where = place();

        yield* Effect.scoped(
          Effect.gen(function* () {
            const brain = yield* brainAt(where);

            yield* signInWith(brain.login, fake);
            yield* Effect.promise(
              async () => await brain.models.getAuth(CODEX_PROVIDER)
            );
          })
        );

        assert.strictEqual(fake.log.refreshes, 1);

        const restarted = yield* brainAt(where);

        const auth = yield* Effect.promise(
          async () => await restarted.models.getAuth(CODEX_PROVIDER)
        );

        assert.isDefined(auth);
        assert.strictEqual(fake.log.refreshes, 2);
        assert.strictEqual(fake.log.reuses, 0);
        assert.strictEqual(
          yield* storedRefresh(restarted.store),
          fake.log.current
        );
      }).pipe(Effect.scoped)
  );

  it.live("leaves refreshing to the holder: a second brain refuses", () =>
    Effect.gen(function* () {
      const fake = yield* fakeAuth({ accessSeconds: 60 });
      const where = place();
      const holder = yield* brainAt(where);

      yield* signInWith(holder.login, fake);

      const second = yield* brainAt(where);

      assert.isFalse(second.store.held);

      const auth = yield* Effect.promise(
        async () => await second.models.getAuth(CODEX_PROVIDER)
      );

      assert.isUndefined(auth);
      assert.strictEqual(fake.log.refreshes, 0);

      const steps = yield* Stream.runCollect(second.login.start);

      assert.deepStrictEqual(
        steps.map((step) => labelOf(step)),
        ["unavailable"]
      );
      assert.strictEqual(fake.log.codeRequests, 1);
    }).pipe(Effect.scoped)
  );

  it.live("cancels a sign-in and stores nothing", () =>
    Effect.gen(function* () {
      const fake = yield* fakeAuth();
      const brain = yield* brainAt(place());

      const running = yield* brain.login.start.pipe(
        Stream.tap((step) =>
          Predicate.isTagged(step, "DeviceCode")
            ? Effect.asVoid(brain.login.cancel)
            : Effect.void
        ),
        Stream.runCollect,
        Effect.forkChild
      );

      const steps = yield* Fiber.join(running);

      assert.deepStrictEqual(
        steps.map((step) => labelOf(step)),
        ["DeviceCode", "cancelled"]
      );
      assert.strictEqual(yield* storedRefresh(brain.store), "none");
      assert.strictEqual(fake.log.exchanges, 0);
    }).pipe(Effect.scoped)
  );

  it.live("runs one sign-in at a time", () =>
    Effect.gen(function* () {
      const fake = yield* fakeAuth();
      const brain = yield* brainAt(place());

      const first = yield* brain.login.start.pipe(
        Stream.runCollect,
        Effect.forkChild
      );

      yield* Effect.sleep("200 millis");

      const busy = yield* Stream.runCollect(brain.login.start).pipe(
        Effect.flip
      );

      assert.strictEqual(busy._tag, "CodexLoginBusy");

      fake.approve();

      const steps = yield* Fiber.join(first);

      assert.deepStrictEqual(tagsOf(steps), ["DeviceCode", "SignedIn"]);

      // The slot is free again.
      assert.isFalse(yield* brain.login.cancel);
    }).pipe(Effect.scoped)
  );

  it.live("signs out", () =>
    Effect.gen(function* () {
      const fake = yield* fakeAuth();
      const brain = yield* brainAt(place());

      yield* signInWith(brain.login, fake);

      assert.isTrue(yield* brain.login.logout);
      assert.strictEqual(yield* storedRefresh(brain.store), "none");

      const available = yield* Effect.promise(
        async () => await brain.models.getAvailable(CODEX_PROVIDER)
      );

      assert.strictEqual(available.length, 0);
    }).pipe(Effect.scoped)
  );

  it.live("answers unavailable on a brain without the OAuth store", () =>
    Effect.gen(function* () {
      const login = Context.get(
        yield* Layer.build(CodexLogin.layer),
        CodexLogin
      );

      const steps = yield* Stream.runCollect(login.start);

      assert.deepStrictEqual(
        steps.map((step) => labelOf(step)),
        ["unavailable"]
      );

      const refused = yield* login.logout.pipe(Effect.flip);

      assert.strictEqual(refused.reason, "unavailable");
    }).pipe(Effect.scoped)
  );
});
