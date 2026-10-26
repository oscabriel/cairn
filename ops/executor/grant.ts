// Cairn's one Executor grant: OAuth on the scoped connection the user made for Cairn (ADR 0003).
//
//   EXECUTOR_CONNECTION=<id> node ops/executor/grant.ts
//
// With no grant yet, it prints the consent URL and waits for Executor's redirect on
// http://127.0.0.1:3777/callback (3774 is the brain's own port, held while cairn.service runs). Either way it then connects with the grant and lists what the
// connection exposes, which is the step's outside judge. The grant lives in
// ~/.config/cairn/executor-grant.json (mode 600) until Cairn's database exists, and nothing else may
// use it: Executor treats a reused rotated refresh token as theft.
import { homedir } from "node:os";

import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
} from "@earendil-works/pi-mcp/oauth";
import type {
  McpOAuthState,
  OAuthFlowOptions,
} from "@earendil-works/pi-mcp/oauth";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, FileSystem, Schema } from "effect";

const origin = "https://exec.gneiss.run";

const callbackPort = 3777;

const grantPath = `${homedir()}/.config/cairn/executor-grant.json`;

class GrantError extends Schema.TaggedError<GrantError>()("GrantError", {
  step: Schema.String,
  cause: Schema.Defect(),
}) {}

// Only what outlives one sign-in is written down. The verifier, state and discovery belong to
// a single authorization and stay in memory.
const StoredGrant = Schema.Struct({
  serverUrl: Schema.String,
  clientInformation: Schema.optionalKey(
    Schema.Struct({
      client_id: Schema.String,
      client_secret: Schema.optionalKey(Schema.String),
      client_id_issued_at: Schema.optionalKey(Schema.Finite),
      client_secret_expires_at: Schema.optionalKey(Schema.Finite),
    })
  ),
  tokens: Schema.optionalKey(
    Schema.Struct({
      access_token: Schema.String,
      token_type: Schema.String,
      expires_in: Schema.optionalKey(Schema.Finite),
      scope: Schema.optionalKey(Schema.String),
      refresh_token: Schema.optionalKey(Schema.String),
      id_token: Schema.optionalKey(Schema.String),
    })
  ),
  tokensExpireAt: Schema.optionalKey(Schema.Finite),
});

const StoredGrantJson = Schema.fromJsonString(StoredGrant);

const decodeStoredGrant = Schema.decodeEffect(StoredGrantJson);

const encodeStoredGrant = Schema.encodeEffect(StoredGrantJson);

const attempt = <A>(step: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new GrantError({ step, cause }),
  });

const program = Effect.gen(function* () {
  const connection = yield* Config.String("EXECUTOR_CONNECTION");
  const serverUrl = `${origin}/mcp?connection=${encodeURIComponent(connection)}`;
  const fs = yield* FileSystem.FileSystem;

  const run = Effect.runPromiseWith(
    yield* Effect.context<FileSystem.FileSystem>()
  );

  const readStored = Effect.gen(function* () {
    const exists = yield* fs.exists(grantPath);

    const stored = exists
      ? yield* decodeStoredGrant(yield* fs.readFileString(grantPath))
      : undefined;

    // A grant for another connection is not ours to reuse.
    return stored?.serverUrl === serverUrl ? stored : undefined;
  });

  // Encoding keeps only StoredGrant's fields, so the per-sign-in ones never reach the disk.
  const writeStored = (state: McpOAuthState) =>
    Effect.gen(function* () {
      const text = yield* encodeStoredGrant(state);

      yield* fs.writeFileString(grantPath, `${text}\n`, { mode: 0o600 });
      yield* fs.chmod(grantPath, 0o600);
    });

  let transient: McpOAuthState | undefined;

  const store = {
    load: async () =>
      await run(readStored).then((stored) => ({
        ...stored,
        ...transient,
        serverUrl,
      })),
    save: async (state: McpOAuthState) => {
      transient = state;
      await run(writeStored(state));
    },
  };

  const callback = yield* Effect.acquireRelease(
    attempt(
      "listen for the callback",
      async () =>
        await OAuthCallbackServer.listen({
          port: callbackPort,
          path: "/callback",
        })
    ),
    (server) =>
      Effect.promise(async () => {
        await server.close();
      })
  );

  const oauth = new McpOAuthProvider({
    serverUrl,
    redirectUrl: callback.redirectUrl,
    clientMetadata: { client_name: "Cairn" },
    store,
    onRedirect: async (url) => {
      await run(
        Console.log(`Open this to approve Cairn's grant:\n\n  ${url.href}\n`)
      );
    },
  });

  const connect = Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new McpClient({ name: "cairn", version: "0" });

      const transport = new StreamableHttpTransport({
        url: serverUrl,
        authProvider: adaptOAuthProvider(oauth),
      });

      yield* attempt("connect", async () => await client.connect(transport));

      return client;
    }),
    (client) =>
      Effect.promise(async () => {
        await client.close();
      })
  );

  const client = yield* connect.pipe(
    Effect.catchIf(
      (error) => error.cause instanceof McpOAuthAuthorizationRequiredError,
      () =>
        Effect.gen(function* () {
          const state = yield* attempt(
            "read the OAuth state",
            async () => await oauth.state()
          );

          const { code, iss } = yield* attempt(
            "wait for consent",
            async () => await callback.waitForCallback(state)
          );

          const flow: OAuthFlowOptions = { serverUrl, authorizationCode: code };

          if (iss !== undefined) {
            flow.iss = iss;
          }

          yield* attempt(
            "exchange the code",
            async () => await authorizeMcp(oauth, flow)
          );

          return yield* connect;
        })
    )
  );

  const tools = yield* attempt(
    "list tools",
    async () => await client.listTools()
  );

  yield* Console.log(
    `Grant works. Executor tools: ${tools.map((tool) => tool.name).join(", ")}`
  );

  const listing = yield* attempt(
    "search",
    async () => await client.callTool("search", {})
  );

  for (const part of listing.content) {
    if (part.type === "text") {
      yield* Console.log(part.text);
    }
  }
}).pipe(Effect.scoped);

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
