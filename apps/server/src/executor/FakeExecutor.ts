// A fake Executor on 127.0.0.1, for the Executor tests and for every brain that must not hold the
// real grant (`ExecutorLink.layerFake`: dev and judges). It serves Executor's OAuth surface
// (protected-resource and authorization-server metadata, dynamic registration, PKCE code and
// rotating refresh grants, where a reused refresh token is `invalid_grant`) and its MCP endpoint in
// model mode, answering JSON. Sessions and pending requests live in memory, as in Executor, so
// `restart()` loses both. Apps:
//
// - `spike`: `mark {id}` asks for approval and appends a mark on accept; `marks` lists them;
//   `form` asks for input; `hang` answers only when `release()` is called.
// - `github`: `repos.get {path: {owner, repo}}` answers the repo's name at once;
//   `issues.create {path, body}` asks for approval first.
// - `executor` (only with `executorApp: true`): `apps.list`, Executor's own management tool.
//
// `execute` runs no code: it asks for one approval (a `spike.mark` of `from-program`) and
// completes with the program echoed once accepted.
//
// Ported from cairn-v1, apps/server/test/fake-executor.ts at 1a5cd4a. Changed: a `github`
// stand-in app, a hanging tool, counters for refreshes and refused refresh tokens, a grant seeded
// without the consent page, the clock injected, and an Effect resource around the server.

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";

import { Clock, Effect, Option, Predicate, Schema } from "effect";
import type { Scope } from "effect";

type Json = Schema.MutableJson;

type JsonRecord = Schema.MutableJsonObject;

interface Pending {
  readonly requestId: string;
  readonly path: string;
  readonly input: JsonRecord;
  readonly expiresAt: number;
}

/** A grant as `ops/executor/grant.ts` would have stored it. */
export interface FakeGrant {
  serverUrl: string;
  clientInformation: { client_id: string };
  tokens: {
    access_token: string;
    token_type: string;
    refresh_token: string;
    expires_in: number;
  };
}

/** What one fake Executor exposes to a test. */
export interface FakeExecutorHandle {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The MCP URL of the scoped connection the grant is for. */
  readonly serverUrl: string;
  readonly state: {
    /** How long an approval request stays answerable. */
    ttlMs: number;
    /** Whether the connection includes Executor's own app. */
    executorApp: boolean;
    /** Successful refresh grants. */
    refreshes: number;
    /** Refresh tokens refused (`invalid_grant`), which Executor treats as theft. */
    invalidGrants: number;
    /** When set, the next refresh answers this HTTP status instead: a token endpoint hiccup. */
    failTokenOnce: number | undefined;
    /** When set, `initialize` requests are never answered: a connect that hangs. */
    hangInitialize: boolean;
    /** `initialize` requests: one per MCP session opened. */
    sessionsOpened: number;
    /** Every tool call, in order. */
    readonly log: Array<{ tool: string; args: JsonRecord }>;
  };
  /** The `spike.mark` calls that ran. */
  readonly marks: Array<string>;
  /** Requests still waiting for an answer. */
  readonly pending: Map<string, Pending>;
  /** A grant made without the consent page. */
  issueGrant(): FakeGrant;
  /** What the user's browser does on the consent page: the code and state Executor redirects with. */
  consent(authorizationUrl: string): { code: string; state: string };
  /** Executor restarts: every session and pending request is gone; grants stay. */
  restart(): void;
  /** Revokes every access token, so the next request needs a refresh. */
  expireAccess(): void;
  /** Revokes every refresh token too: the grant is gone and needs a sign-in. */
  revoke(): void;
  /** Answers every `spike.hang` call waiting. */
  release(): void;
  /** Calls to one tool. */
  calls(tool: string): ReadonlyArray<{ tool: string; args: JsonRecord }>;
}

const decodeRecord = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.MutableJson)
);

const decodeBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson))
);

/** The value as a JSON object, or an empty one. */
const recordOf = (value: Json | undefined): JsonRecord =>
  Option.getOrElse(decodeRecord(value), () => ({}));

const stringOf = (value: Json | undefined) =>
  Predicate.isString(value) ? value : "";

const readBody = async (request: IncomingMessage) => await text(request);

const json = (
  response: ServerResponse,
  status: number,
  body: Json,
  headers: Record<string, string> = {}
) => {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
};

const CONNECTION = "con_cairn";

const appOf = (path: string) =>
  path.replace(/^tools\./u, "").split(".")[0] ?? "";

const completed = (value: Array<Json>) => ({
  status: "completed",
  execution: { value, toolCalls: [] },
  unavailableApps: [],
});

const noTool = (path: string) => ({
  path,
  ok: false,
  error: { kind: "tool", message: `No tool at ${path}` },
});

const repoPath = (input: JsonRecord) => {
  const path = recordOf(input.path);
  const { owner, repo } = path;

  return Predicate.isString(owner) && Predicate.isString(repo)
    ? `${owner}/${repo}`
    : "?";
};

const build = (now: () => number) => {
  let origin = "";
  const sessions = new Set<string>();
  const pending = new Map<string, Pending>();
  const ended = new Map<string, "answered" | "expired">();
  const marks: Array<string> = [];
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const hanging: Array<() => void> = [];
  let registrations = 0;
  let next = 0;

  const state: FakeExecutorHandle["state"] = {
    ttlMs: 60_000,
    executorApp: false,
    refreshes: 0,
    invalidGrants: 0,
    hangInitialize: false,
    failTokenOnce: undefined,
    sessionsOpened: 0,
    log: [],
  };

  const issueTokens = () => {
    const access = `at_${randomUUID()}`;
    const refresh = `rt_${randomUUID()}`;

    accessTokens.add(access);
    refreshTokens.add(refresh);

    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
    };
  };

  const ask = (path: string, input: JsonRecord) => {
    next += 1;

    const request: Pending = {
      requestId: `apr_${next}`,
      path,
      input,
      expiresAt: now() + state.ttlMs,
    };

    pending.set(request.requestId, request);

    const [app = "", ...tool] = path.replace(/^tools\./u, "").split(".");

    return {
      status: "approval-required",
      requestId: request.requestId,
      invocation: {
        app,
        tool: tool.join("."),
        version: "v1",
        kind: "mutation",
        input,
      },
      elicitation: {
        mode: "form",
        message: `Approve ${path}?\n${JSON.stringify(input)}`,
      },
      expiresAt: request.expiresAt,
    };
  };

  const run = (path: string, input: JsonRecord) => {
    if (path === "tools.spike.mark") {
      const id = stringOf(input.id);

      marks.push(id);

      return { path, ok: true, value: { marked: id, count: marks.length } };
    }

    if (path === "tools.github.issues.create") {
      return {
        path,
        ok: true,
        value: { number: 1, title: input.body ?? null },
      };
    }

    return noTool(path);
  };

  const hang = async () => {
    const { promise, resolve } = Promise.withResolvers<null>();

    hanging.push(() => {
      resolve(null);
    });
    await promise;

    return completed([
      { path: "tools.spike.hang", ok: true, value: "released" },
    ]);
  };

  const call = (args: JsonRecord) => {
    const calls = Array.isArray(args.calls) ? args.calls : [args.calls];
    const first = recordOf(calls[0]);
    const path = stringOf(first.path);
    const input = recordOf(first.input);

    switch (path) {
      case "tools.spike.mark":
      case "tools.github.issues.create": {
        return ask(path, input);
      }

      case "tools.spike.marks": {
        return completed([{ path, ok: true, value: [...marks] }]);
      }

      case "tools.spike.form": {
        next += 1;

        const requestId = `elc_${next}`;

        pending.set(requestId, {
          requestId,
          path,
          input,
          expiresAt: now() + state.ttlMs,
        });

        return {
          status: "input-required",
          requestId,
          tool: { app: "spike", tool: "form" },
          elicitation: { mode: "form", message: "Name?" },
          expiresAt: now() + state.ttlMs,
        };
      }

      case "tools.github.repos.get": {
        return completed([
          { path, ok: true, value: { full_name: repoPath(input) } },
        ]);
      }

      case "tools.executor.apps.list": {
        return completed([
          state.executorApp
            ? { path, ok: true, value: ["github", "spike"] }
            : noTool(path),
        ]);
      }

      default: {
        return completed([noTool(path)]);
      }
    }
  };

  const search = (args: JsonRecord) => {
    const own = state.executorApp
      ? [
          {
            path: "tools.executor.apps.list",
            description: "List apps",
            input: "{}",
          },
        ]
      : [];

    const apps = [
      {
        path: "tools.spike.mark",
        description: "Mark",
        input: "{ id: string }",
      },
      {
        path: "tools.github.repos.get",
        description: "Get a repository",
        input: "{ path: { owner: string; repo: string } }",
      },
    ];

    const { namespace } = args;

    const items = [...apps, ...own].filter(
      (entry) =>
        !Predicate.isString(namespace) ||
        namespace === "" ||
        appOf(entry.path) === namespace
    );

    return {
      items,
      namespaces: [],
      remaining: 0,
      next: null,
      unavailableApps: [],
    };
  };

  const resume = (args: JsonRecord) => {
    const requestId = stringOf(args.requestId);
    const action = stringOf(recordOf(args.response).action);
    const request = pending.get(requestId);

    if (request === undefined) {
      return {
        status: "unavailable",
        requestId,
        reason: ended.get(requestId) ?? "not-found",
        message: "No such request.",
      };
    }

    pending.delete(requestId);

    if (request.expiresAt <= now()) {
      ended.set(requestId, "expired");

      return {
        status: "unavailable",
        requestId,
        reason: "expired",
        message: "Expired.",
      };
    }

    ended.set(requestId, "answered");

    if (action !== "accept") {
      return completed([
        {
          path: request.path,
          ok: false,
          error: {
            kind: "tool",
            message: action === "decline" ? "ApprovalDenied" : "Cancelled",
          },
        },
      ]);
    }

    const { code } = request.input;

    if (Predicate.isString(code)) {
      return {
        status: "completed",
        execution: {
          value: { program: code, mark: run(request.path, request.input) },
        },
        unavailableApps: [],
      };
    }

    return completed([run(request.path, request.input)]);
  };

  const tool = async (name: string, args: JsonRecord) => {
    switch (name) {
      case "skills": {
        return {
          skills: [
            { app: "executor", name: "executor" },
            { app: "github", name: "github" },
          ],
        };
      }

      case "search": {
        return search(args);
      }

      case "describe": {
        const paths = Array.isArray(args.paths) ? args.paths : [];

        return {
          items: paths.map((path) => ({
            path,
            description: "A fake tool",
            signature: "(input: unknown) => Promise<unknown>",
          })),
          namespaces: [],
          missing: [],
        };
      }

      case "call": {
        return stringOf(
          recordOf(Array.isArray(args.calls) ? args.calls[0] : args.calls).path
        ) === "tools.spike.hang"
          ? await hang()
          : call(args);
      }

      case "execute": {
        return ask("tools.spike.mark", {
          id: "from-program",
          code: stringOf(args.code),
        });
      }

      case "resume": {
        return resume(args);
      }

      default: {
        return null;
      }
    }
  };

  const mcp = async (request: IncomingMessage, response: ServerResponse) => {
    const auth = (request.headers.authorization ?? "").replace(/^Bearer /u, "");

    if (auth === "" || !accessTokens.has(auth)) {
      await readBody(request);
      response.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp?connection=${CONNECTION}", scope="mcp offline_access"`,
      });
      response.end();

      return;
    }

    if (request.method === "DELETE") {
      sessions.delete(String(request.headers["mcp-session-id"]));
      response.writeHead(200);
      response.end();

      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();

      return;
    }

    const message = Option.getOrElse(
      decodeBody(await readBody(request)),
      (): JsonRecord => ({})
    );

    const id = message.id ?? null;

    if (message.method === "initialize" && state.hangInitialize) {
      return;
    }

    if (message.method === "initialize") {
      const session = randomUUID();

      sessions.add(session);
      state.sessionsOpened += 1;
      json(
        response,
        200,
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-executor", version: "0" },
          },
        },
        { "mcp-session-id": session }
      );

      return;
    }

    if (!sessions.has(String(request.headers["mcp-session-id"]))) {
      json(response, 404, {
        jsonrpc: "2.0",
        id,
        error: { code: -32_001, message: "Session not found" },
      });

      return;
    }

    if (message.id === undefined) {
      response.writeHead(202);
      response.end();

      return;
    }

    if (message.method === "ping") {
      json(response, 200, { jsonrpc: "2.0", id, result: {} });

      return;
    }

    if (message.method === "tools/call") {
      const params = recordOf(message.params);
      const name = stringOf(params.name);
      const args = recordOf(params.arguments);

      state.log.push({ tool: name, args });

      const value = await tool(name, args);

      json(
        response,
        200,
        value === null
          ? {
              jsonrpc: "2.0",
              id,
              error: { code: -32_602, message: `Unknown tool ${name}` },
            }
          : {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify(value) }],
                structuredContent: value,
              },
            }
      );

      return;
    }

    json(response, 200, {
      jsonrpc: "2.0",
      id,
      error: { code: -32_601, message: "Method not found" },
    });
  };

  const token = async (request: IncomingMessage, response: ServerResponse) => {
    const form = new URLSearchParams(await readBody(request));
    const grantType = form.get("grant_type");

    if (grantType === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");

      codes.delete(form.get("code") ?? "");

      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");

      if (
        code === undefined ||
        code.challenge !== challenge ||
        code.redirect !== form.get("redirect_uri")
      ) {
        json(response, 400, { error: "invalid_grant" });

        return;
      }

      json(response, 200, issueTokens());

      return;
    }

    if (grantType === "refresh_token" && state.failTokenOnce !== undefined) {
      const status = state.failTokenOnce;

      state.failTokenOnce = undefined;
      json(response, status, { error: "temporarily_unavailable" });

      return;
    }

    if (grantType === "refresh_token") {
      const refresh = form.get("refresh_token") ?? "";

      if (!refreshTokens.has(refresh)) {
        state.invalidGrants += 1;
        json(response, 400, { error: "invalid_grant" });

        return;
      }

      refreshTokens.delete(refresh);
      state.refreshes += 1;
      json(response, 200, issueTokens());

      return;
    }

    json(response, 400, { error: "unsupported_grant_type" });
  };

  const register = async (
    request: IncomingMessage,
    response: ServerResponse
  ) => {
    registrations += 1;

    const body = Option.getOrElse(
      decodeBody(await readBody(request)),
      (): JsonRecord => ({})
    );

    json(response, 201, { ...body, client_id: `client_${registrations}` });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", origin);
    const { pathname, searchParams } = url;

    if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
      const connection = searchParams.get("connection");

      json(response, 200, {
        resource:
          connection === null
            ? `${origin}/mcp`
            : `${origin}/mcp?connection=${connection}`,
        authorization_servers: [`${origin}/auth`],
        scopes_supported: ["mcp", "offline_access"],
      });

      return;
    }

    if (
      pathname.startsWith("/.well-known/oauth-authorization-server") ||
      pathname.startsWith("/.well-known/openid-configuration")
    ) {
      json(response, 200, {
        issuer: `${origin}/auth`,
        authorization_endpoint: `${origin}/auth/authorize`,
        token_endpoint: `${origin}/auth/token`,
        registration_endpoint: `${origin}/auth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });

      return;
    }

    if (pathname === "/auth/register") {
      await register(request, response);

      return;
    }

    if (pathname === "/auth/token") {
      await token(request, response);

      return;
    }

    if (pathname === "/mcp") {
      await mcp(request, response);

      return;
    }

    response.writeHead(404);
    response.end();
  };

  const server = createServer((request, response) => {
    // oxlint-disable-next-line promise/prefer-await-to-then -- a listener cannot await; a request that fails is dropped
    handle(request, response).catch(() => {
      response.destroy();
    });
  });

  const controls: Omit<FakeExecutorHandle, "origin" | "serverUrl"> = {
    state,
    marks,
    pending,
    issueGrant: () => {
      registrations += 1;

      return {
        serverUrl: `${origin}/mcp?connection=${CONNECTION}`,
        clientInformation: { client_id: `client_${registrations}` },
        tokens: issueTokens(),
      };
    },
    consent: (authorizationUrl) => {
      const { searchParams } = new URL(authorizationUrl);
      const code = `code_${randomUUID()}`;

      codes.set(code, {
        challenge: searchParams.get("code_challenge") ?? "",
        redirect: searchParams.get("redirect_uri") ?? "",
      });

      return { code, state: searchParams.get("state") ?? "" };
    },
    restart: () => {
      sessions.clear();
      pending.clear();
    },
    expireAccess: () => {
      accessTokens.clear();
    },
    revoke: () => {
      accessTokens.clear();
      refreshTokens.clear();
    },
    release: () => {
      for (const resolve of hanging.splice(0)) {
        resolve();
      }
    },
    calls: (name) => state.log.filter((entry) => entry.tool === name),
  };

  return {
    server,
    controls,
    setOrigin: (value: string) => {
      origin = value;
    },
  };
};

/** Starts a fake Executor on a free loopback port; it closes with the scope. */
export const startFakeExecutor: Effect.Effect<
  FakeExecutorHandle,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const built = build(() => clock.currentTimeMillisUnsafe());

  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      built.server.listen(0, "127.0.0.1", () => {
        const address = built.server.address();

        resume(
          Effect.succeed(
            address !== null && !Predicate.isString(address) ? address.port : 0
          )
        );
      });
    }),
    () =>
      Effect.callback<boolean>((resume) => {
        built.controls.release();
        built.server.closeAllConnections();
        built.server.close(() => {
          resume(Effect.succeed(true));
        });
      })
  );

  const origin = `http://127.0.0.1:${port}`;

  built.setOrigin(origin);

  return {
    ...built.controls,
    origin,
    serverUrl: `${origin}/mcp?connection=${CONNECTION}`,
  };
});
