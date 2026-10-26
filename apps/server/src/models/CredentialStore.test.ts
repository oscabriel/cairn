// Judges the brain's credential store over pi's auth.json: only literal API keys pass, `anthropic`
// and `openai-codex` are never read, every OAuth credential and every subscription token is
// ignored, and nothing is ever written. Assertions are on provider ids and types only, never on a
// key's value; the real file's case reads the user's auth.json the same way and prints nothing.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { CairnCredentialStore } from "./CredentialStore.ts";

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

const storeWith = (contents: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "cairn-credentials-"));
  const authPath = path.join(dir, "auth.json");

  writeFileSync(authPath, contents, { mode: 0o600 });

  return { authPath, store: new CairnCredentialStore(authPath) };
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
          ["openai-codex", "oauth", "hidden_provider"],
          ["github-copilot", "oauth", "oauth"],
          ["command-key", "api_key", "not_literal"],
          ["env-key", "api_key", "not_literal"],
          ["env-template", "api_key", "not_literal"],
          ["kimi-coding", "api_key", "subscription_token"],
          ["broken", "unknown", "malformed"],
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

        const modify = yield* Effect.promise(
          async () =>
            await store.modify().then(
              () => "resolved",
              () => "rejected"
            )
        );

        const remove = yield* Effect.promise(
          async () =>
            await store.delete().then(
              () => "resolved",
              () => "rejected"
            )
        );

        assert.strictEqual(modify, "rejected");
        assert.strictEqual(remove, "rejected");

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
