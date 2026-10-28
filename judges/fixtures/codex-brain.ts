// One brain's Codex side for `judges/codex-login.ts`, as its own process so the judge can `kill -9`
// it: Cairn's OAuth store over `--db` behind the lock at `--lock`, the Codex sign-in, and pi-ai's
// model runtime over the composite credential store, with OpenAI's sign-in host sent to the fake at
// `--fake`. Prints one JSON line per event and never a token.
//
//   node judges/fixtures/codex-brain.ts <login|auth|status> --db <file> --lock <file> --fake <url>
//     [--hold] [--control no-persist]
//
// login   runs one sign-in: a `device_code` line when the code is shown, then a `login` line.
// auth    resolves Codex's request auth once (a refresh when the token is near expiry): an `auth` line.
// status  an `status` line: whether this brain holds the lock and whether a sign-in is stored.
// --hold  after its line, keeps the brain (and its lock) alive until killed.
// --control no-persist  a broken store for the judge's control: refreshes are answered but never
//         written, as a store that released before persisting would behave after a restart.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import type { LoginProgress } from "@cairn/protocol/Models";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer, Option, Predicate, Stream } from "effect";

import { Database } from "../../apps/server/src/db/Database.ts";
import { migrations } from "../../apps/server/src/db/Migrations.ts";
import { OAuthCredentials0007 } from "../../apps/server/src/db/migrations/0007OAuthCredentials.ts";
import { CodexLogin } from "../../apps/server/src/models/CodexLogin.ts";
import type { OAuthCredentialSource } from "../../apps/server/src/models/CredentialStore.ts";
import {
  CairnCredentialStore,
  CODEX_PROVIDER,
} from "../../apps/server/src/models/CredentialStore.ts";
import { redirectFetch } from "../../apps/server/src/models/FakeCodexAuth.ts";
import { OAuthStore } from "../../apps/server/src/models/OAuthStore.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    lock: { type: "string" },
    fake: { type: "string" },
    hold: { type: "boolean", default: false },
    control: { type: "string", default: "" },
  },
});

const [mode = ""] = positionals;

const { db = "", lock = "", fake = "" } = values;

/** A step's tag, or a failure's reason. */
const labelOf = (step: LoginProgress) =>
  Predicate.isTagged(step, "Failed") ? step.reason : step._tag;

const line = (
  event: string,
  fields: Record<string, string | number | boolean>
) =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
  });

globalThis.fetch = redirectFetch(fake, globalThis.fetch);

const BrainLayer = CodexLogin.layer.pipe(
  Layer.provideMerge(OAuthStore.layerWith(lock)),
  Layer.provideMerge(
    Database.layer({
      filename: db,
      migrations: {
        ...migrations,
        "0007_OAuthCredentials": OAuthCredentials0007,
      },
    })
  ),
  Layer.provide(NodeServices.layer)
);

/** The store pi-ai sees: the real source, or the control's that never persists a refresh. */
const sourceFor = (store: OAuthStore["Service"]): OAuthCredentialSource =>
  values.control === "no-persist"
    ? {
        ...store.source,
        modify: async (provider, update) =>
          await update(await store.source.read(provider)),
      }
    : store.source;

const program = Effect.gen(function* () {
  const context = yield* Layer.build(BrainLayer);
  const store = Context.get(context, OAuthStore);
  const login = Context.get(context, CodexLogin);

  // pi's file plays no part in Codex; a path that never exists.
  const piAuth = path.join(
    mkdtempSync(path.join(tmpdir(), "codex-brain-")),
    "auth.json"
  );

  const credentials = new CairnCredentialStore(
    piAuth,
    Option.some(sourceFor(store))
  );

  const models = createModels({ credentials });

  models.setProvider(openaiCodexProvider());

  if (mode === "login") {
    const steps = yield* login.start.pipe(
      Stream.tap((step) =>
        Predicate.isTagged(step, "DeviceCode")
          ? line("device_code", { userCode: step.userCode })
          : Effect.void
      ),
      Stream.runCollect
    );

    const last = Option.fromUndefinedOr(steps.at(-1));

    yield* line("login", {
      held: store.held,
      result: Option.match(last, { onNone: () => "none", onSome: labelOf }),
    });
  }

  if (mode === "auth") {
    const outcome = yield* Effect.tryPromise({
      try: async () => await models.getAuth(CODEX_PROVIDER),
      // pi-ai's error text can quote the provider's answer; only the fact is printed.
      catch: () => "refused",
    }).pipe(
      Effect.map((auth) => (auth?.auth.apiKey === undefined ? "none" : "ok")),
      Effect.catch((error) => Effect.succeed(error))
    );

    yield* line("auth", { held: store.held, outcome });
  }

  if (mode === "status") {
    const stored = yield* store.signedIn(CODEX_PROVIDER);

    yield* line("status", {
      held: store.held,
      signedIn: Option.isSome(stored),
    });
  }

  // Holding keeps the scope, and with it the lock, until the process is killed.
  return yield* values.hold
    ? Effect.andThen(line("holding", { held: store.held }), Effect.never)
    : Effect.void;
});

await Effect.runPromise(Effect.scoped(program));
