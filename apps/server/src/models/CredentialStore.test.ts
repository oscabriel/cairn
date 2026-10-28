// Judges the brain's credential store over pi's auth.json: only literal API keys pass, `anthropic`
// and `openai-codex` are never read from it, every OAuth credential and every subscription token is
// ignored, and nothing is ever written to it. `openai-codex` is served and written only by Cairn's
// own OAuth source. Assertions are on provider ids and types only, never on a key's value; the real
// file's case reads the user's auth.json the same way and prints nothing.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import type { OAuthCredential } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import type { OAuthCredentialSource } from "./CredentialStore.ts";
import { CairnCredentialStore, OAUTH_PROVIDERS } from "./CredentialStore.ts";

const FIXTURE = {
  "opencode-go": { type: "api_key", key: "fake-opencode-key" },
  openrouter: {
    type: "api_key",
    key: "fake-router-key",
    env: { REGION: "eu" },
  },
  anthropic: { type: "api_key", key: "sk-ant-usr-fake" },
  "openai-codex": {
    type: "oauth",
    access: "fake-access",
    refresh: "fake-refresh",
    expires: 1,
  },
  "github-copilot": {
    type: "oauth",
    access: "fake-access",
    refresh: "fake-refresh",
    expires: 1,
  },
  "command-key": { type: "api_key", key: "!pass show key" },
  "env-key": { type: "api_key", key: "$SOME_KEY" },
  "env-template": { type: "api_key", key: "plain", env: { TOKEN: "$OTHER" } },
  "kimi-coding": { type: "api_key", key: "sk-ant-oat01-fake" },
  broken: { type: "api_key" },
};

const OAUTH: OAuthCredential = {
  type: "oauth",
  access: "cairn-access",
  refresh: "cairn-refresh",
  expires: 2,
  accountId: "acct_cairn",
};

const storeWith = (
  contents: string,
  oauth: Option.Option<OAuthCredentialSource> = Option.none()
) => {
  const dir = mkdtempSync(path.join(tmpdir(), "cairn-credentials-"));
  const authPath = path.join(dir, "auth.json");

  writeFileSync(authPath, contents, { mode: 0o600 });

  return { authPath, store: new CairnCredentialStore(authPath, oauth) };
};

/** Cairn's own sign-ins in memory, recording every write it took. */
const memorySource = (
  held: boolean,
  initial: Option.Option<OAuthCredential>
) => {
  let stored = initial;
  const writes: Array<string> = [];

  const source: OAuthCredentialSource = {
    providers: OAUTH_PROVIDERS,
    held,
    read: async () => await Promise.resolve(Option.getOrUndefined(stored)),
    modify: async (provider, update) => {
      const next = await update(Option.getOrUndefined(stored));

      if (next?.type === "oauth") {
        stored = Option.some(next);
        writes.push(`modify ${provider}`);
      }

      return next;
    },
    delete: async (provider) => {
      stored = Option.none();
      writes.push(`delete ${provider}`);
      await Promise.resolve();
    },
  };

  return { source, writes };
};

describe("the credential store over pi's auth.json", () => {
  it.effect("offers only literal API keys of allowed providers", () =>
    Effect.gen(function* () {
      const { store } = storeWith(JSON.stringify(FIXTURE));

      const listed = yield* Effect.promise(async () => await store.list());

      assert.deepStrictEqual(
        listed.map((info) => [info.providerId, info.type]),
        [
          ["opencode-go", "api_key"],
          ["openrouter", "api_key"],
        ]
      );

      for (const hidden of [
        "anthropic",
        "openai-codex",
        "github-copilot",
        "command-key",
        "env-key",
        "env-template",
        "kimi-coding",
        "broken",
        "absent",
      ]) {
        const read = yield* Effect.promise(
          async () => await store.read(hidden)
        );

        assert.isUndefined(read, `${hidden} must not be offered`);
      }

      const offered = yield* Effect.promise(
        async () => await store.read("opencode-go")
      );

      assert.strictEqual(offered?.type, "api_key");
    })
  );

  it.effect("says why each entry is not offered, by id and type only", () =>
    Effect.gen(function* () {
      const { store } = storeWith(JSON.stringify(FIXTURE));

      const entries = yield* Effect.promise(async () => await store.entries());

      assert.deepStrictEqual(
        entries.map((entry) => [
          entry.provider,
          entry.type,
          Option.getOrElse(entry.refusal, () => "offered"),
        ]),
        [
          ["opencode-go", "api_key", "offered"],
          ["openrouter", "api_key", "offered"],
          ["anthropic", "api_key", "hidden_provider"],
          ["github-copilot", "oauth", "oauth"],
          ["command-key", "api_key", "not_literal"],
          ["env-key", "api_key", "not_literal"],
          ["env-template", "api_key", "not_literal"],
          ["kimi-coding", "api_key", "subscription_token"],
          ["broken", "unknown", "malformed"],
          // Cairn's own sign-in, not pi's entry; without an OAuth store this brain holds none.
          ["openai-codex", "oauth", "not_holder"],
        ]
      );
    })
  );

  it.effect(
    "never writes: modify and delete refuse and the file is unchanged",
    () =>
      Effect.gen(function* () {
        const { authPath, store } = storeWith(JSON.stringify(FIXTURE));
        const before = statSync(authPath);
        const bytes = readFileSync(authPath);

        for (const provider of ["opencode-go", "openai-codex", "absent"]) {
          const modify = yield* Effect.promise(
            async () =>
              await store
                .modify(provider, async () => await Promise.resolve(OAUTH))
                .then(
                  () => "resolved",
                  () => "rejected"
                )
          );

          const remove = yield* Effect.promise(
            async () =>
              await store.delete(provider).then(
                () => "resolved",
                () => "rejected"
              )
          );

          assert.strictEqual(modify, "rejected", provider);
          assert.strictEqual(remove, "rejected", provider);
        }

        const after = statSync(authPath);

        assert.strictEqual(after.mtimeMs, before.mtimeMs);
        assert.isTrue(readFileSync(authPath).equals(bytes));
      })
  );

  it.effect("reads a missing file as empty and creates nothing", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(path.join(tmpdir(), "cairn-credentials-"));
      const authPath = path.join(dir, "auth.json");
      const store = new CairnCredentialStore(authPath);

      const listed = yield* Effect.promise(async () => await store.list());

      assert.deepStrictEqual(listed, []);
      assert.isFalse(existsSync(authPath));
    })
  );

  const realAuth = path.join(homedir(), ".pi", "agent", "auth.json");

  it.effect.skipIf(!existsSync(realAuth))(
    "reads the user's auth.json as API keys only, never anthropic or openai-codex",
    () =>
      Effect.gen(function* () {
        const before = statSync(realAuth);
        const store = new CairnCredentialStore(realAuth);

        const listed = yield* Effect.promise(async () => await store.list());

        assert.isTrue(listed.every((info) => info.type === "api_key"));
        assert.isFalse(
          listed.some(
            (info) =>
              info.providerId === "anthropic" ||
              info.providerId === "openai-codex"
          )
        );

        for (const id of ["anthropic", "openai-codex"]) {
          const read = yield* Effect.promise(async () => await store.read(id));

          assert.isUndefined(read);
        }

        assert.strictEqual(statSync(realAuth).mtimeMs, before.mtimeMs);
      })
  );
});

/** The OAuth providers' verdicts over an empty pi file and `source`. */
const refusalOf = async (source: OAuthCredentialSource) => {
  const { store } = storeWith("{}", Option.some(source));
  const entries = await store.entries();

  return entries.map((entry) => [
    entry.provider,
    Option.getOrElse(entry.refusal, () => "offered"),
  ]);
};

describe("the credential store with Cairn's own sign-ins", () => {
  it.effect(
    "serves openai-codex from Cairn's store only, never from pi's entry",
    () =>
      Effect.gen(function* () {
        const own = memorySource(true, Option.some(OAUTH));

        const { store } = storeWith(
          JSON.stringify(FIXTURE),
          Option.some(own.source)
        );

        const read = yield* Effect.promise(
          async () => await store.read("openai-codex")
        );

        // The fixture's pi entry has `fake-access`; Cairn's own has `cairn-access`.
        assert.strictEqual(
          read?.type === "oauth" ? read.access : "",
          "cairn-access"
        );

        const listed = yield* Effect.promise(async () => await store.list());

        assert.deepStrictEqual(
          listed.map((info) => [info.providerId, info.type]),
          [
            ["opencode-go", "api_key"],
            ["openrouter", "api_key"],
            ["openai-codex", "oauth"],
          ]
        );

        const entries = yield* Effect.promise(
          async () => await store.entries()
        );

        assert.deepStrictEqual(
          entries
            .filter((entry) => entry.provider === "openai-codex")
            .map((entry) => Option.getOrElse(entry.refusal, () => "offered")),
          ["offered"]
        );
      })
  );

  it.effect(
    "writes refreshes and sign-outs to Cairn's store and leaves pi's file alone",
    () =>
      Effect.gen(function* () {
        const own = memorySource(true, Option.some(OAUTH));

        const { authPath, store } = storeWith(
          JSON.stringify(FIXTURE),
          Option.some(own.source)
        );

        const bytes = readFileSync(authPath);

        const rotated = yield* Effect.promise(
          async () =>
            await store.modify("openai-codex", async (current) =>
              current?.type === "oauth"
                ? await Promise.resolve({ ...current, refresh: "rotated" })
                : undefined
            )
        );

        assert.strictEqual(
          rotated?.type === "oauth" ? rotated.refresh : "",
          "rotated"
        );

        yield* Effect.promise(async () => {
          await store.delete("openai-codex");
        });

        const keyWrite = yield* Effect.promise(
          async () =>
            await store
              .modify("opencode-go", async () => await Promise.resolve(OAUTH))
              .then(
                () => "resolved",
                () => "rejected"
              )
        );

        assert.strictEqual(keyWrite, "rejected");
        assert.deepStrictEqual(own.writes, [
          "modify openai-codex",
          "delete openai-codex",
        ]);
        assert.isTrue(readFileSync(authPath).equals(bytes));
      })
  );

  it.effect("tells a signed-out store from one this brain does not hold", () =>
    Effect.gen(function* () {
      const signedOut = yield* Effect.promise(
        async () => await refusalOf(memorySource(true, Option.none()).source)
      );

      const elsewhere = yield* Effect.promise(
        async () =>
          await refusalOf(memorySource(false, Option.some(OAUTH)).source)
      );

      assert.deepStrictEqual(signedOut, [["openai-codex", "signed_out"]]);
      assert.deepStrictEqual(elsewhere, [["openai-codex", "not_holder"]]);
    })
  );
});
