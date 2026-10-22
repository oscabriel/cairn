// The whole HTTP stack on a real socket: the app layer on an ephemeral loopback port, a Node RPC
// client sending Caddy's headers and Cairn's Origin, raw upgrade requests for the refusals, and an
// identity that the test revokes to watch the socket close.
import http from "node:http";

import { Internal, Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs, PROTOCOL_VERSION } from "@cairn/protocol/Rpc";
import { NodeServices, NodeSocket } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import { HttpServer } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

import { AppLayer } from "../AppLayer.ts";
import { ServerConfig } from "../Config.ts";
import {
  Identity,
  IdentityRefused,
  PEER_HEADER,
  USER_HEADER,
} from "./Identity.ts";
import { IdentityRecheckInterval } from "./Ws.ts";

const OWNER = "oscabriel@github";

const HOST = "code.gneiss.run";

const ORIGIN = "https://code.gneiss.run";

/** Whether the test's one device is still admitted; flipped by the revocation test. */
const admitted = Ref.makeUnsafe(true);

// The real header rule, with a re-check the test controls (the real re-check asks tailscaled
// through a 30 s cache, which `Identity.test.ts` covers).
const TestIdentity = Layer.succeed(
  Identity,
  Identity.of({
    admit: (peer) =>
      peer === "100.84.155.69"
        ? Effect.succeed(OWNER)
        : Effect.fail(
            new IdentityRefused({
              message: "not the owner",
              reason: "not_the_owner",
            })
          ),
    viewerOf: (request) =>
      request.headers[USER_HEADER] === OWNER
        ? Option.some(OWNER)
        : Option.none(),
    stillAdmitted: () => Ref.get(admitted),
  })
);

const TestServer = AppLayer.pipe(
  Layer.provide(TestIdentity),
  Layer.provide(
    ServerConfig.layerWith({
      host: HOST,
      origin: ORIGIN,
      owner: OWNER,
      webRoot: "/nonexistent/cairn-web",
    })
  ),
  Layer.provide(NodeServices.layer),
  Layer.provide(Layer.succeed(IdentityRecheckInterval, Duration.millis(200)))
);

const decodeReady = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ ready: Schema.Boolean }))
);

const caddyHeaders = {
  host: HOST,
  origin: ORIGIN,
  [USER_HEADER]: OWNER,
};

const boundPort = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const { address } = server;

  return "port" in address ? address.port : 0;
});

const connect = Effect.fnUntraced(function* (headers: Record<string, string>) {
  const port = yield* boundPort;

  const context = yield* Layer.build(
    RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
      Layer.provide(
        NodeSocket.layerWebSocket(
          `ws://127.0.0.1:${port}/ws?protocol=${PROTOCOL_VERSION}`,
          { headers }
        )
      ),
      Layer.provide(RpcSerialization.layerJson)
    )
  );

  return yield* RpcClient.make(CairnRpcs).pipe(Effect.provideContext(context));
});

/** The status a raw WebSocket upgrade gets: 101 when it becomes a socket. */
const upgradeStatus = (pathname: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const port = yield* boundPort;

    return yield* Effect.callback<number>((resume) => {
      const request = http.request({
        host: "127.0.0.1",
        port,
        path: pathname,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
        },
      });

      request.on("upgrade", (_response, socket) => {
        socket.destroy();
        resume(Effect.succeed(101));
      });
      request.on("response", (response) => {
        response.resume();
        resume(Effect.succeed(response.statusCode ?? 0));
      });
      request.on("error", (cause) => {
        resume(Effect.die(cause));
      });
      request.end();
    });
  });

/** A plain GET on the listener: status, one header and the body. */
const plainGet = (pathname: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const port = yield* boundPort;

    return yield* Effect.callback<{
      readonly status: number;
      readonly user: string | undefined;
      readonly body: string;
    }>((resume) => {
      const request = http.get(
        { host: "127.0.0.1", port, path: pathname, headers },
        (response) => {
          const chunks: Array<Buffer> = [];

          response.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.on("end", () => {
            const user = response.headers[USER_HEADER];

            resume(
              Effect.succeed({
                status: response.statusCode ?? 0,
                user: Array.isArray(user) ? user[0] : user,
                body: Buffer.concat(chunks).toString("utf-8"),
              })
            );
          });
        }
      );

      request.on("error", (cause) => {
        resume(Effect.die(cause));
      });
    });
  });

layer(TestServer, { excludeTestServices: true })("the /ws socket", (it) => {
  it.effect("answers Caddy's auth subrequest and the local health check", () =>
    Effect.gen(function* () {
      const admittedPeer = yield* plainGet("/_cairn/auth", {
        [PEER_HEADER]: "100.84.155.69",
      });

      const refusedPeer = yield* plainGet("/_cairn/auth", {
        [PEER_HEADER]: "100.101.1.4",
      });

      const noPeer = yield* plainGet("/_cairn/auth", {});
      const health = yield* plainGet("/_cairn/health", {});
      const page = yield* plainGet("/", { host: HOST });

      assert.strictEqual(admittedPeer.status, 200);
      assert.strictEqual(admittedPeer.user, OWNER);
      assert.strictEqual(refusedPeer.status, 403);
      assert.isUndefined(refusedPeer.user);
      assert.notInclude(refusedPeer.body, "not_the_owner");
      assert.strictEqual(noPeer.status, 403);
      assert.strictEqual(health.status, 200);
      assert.isTrue(decodeReady(health.body).ready);
      assert.strictEqual(page.status, 403);
    })
  );

  it.effect("answers session.hello to a client with Cairn's Origin", () =>
    Effect.gen(function* () {
      const client = yield* connect(caddyHeaders);
      const hello = yield* client["session.hello"]();

      assert.strictEqual(hello.protocol, PROTOCOL_VERSION);
      assert.strictEqual(hello.viewer, OWNER);
      assert.strictEqual(hello.build, "dev");
      assert.isTrue(Option.isNone(hello.vapidPublicKey));
    })
  );

  it.effect("sends typed errors across the socket", () =>
    Effect.gen(function* () {
      const client = yield* connect(caddyHeaders);
      const error = yield* Effect.flip(client["models.list"]());

      assert.instanceOf(error, Unavailable);
      assert.strictEqual(error.code, "unavailable");
      assert.isTrue(error.retryable);
      assert.include(error.message, "models.list");
      assert.notInstanceOf(error, Internal);
    })
  );

  it.effect(
    "refuses a foreign Origin, a forged identity and an old protocol before upgrading",
    () =>
      Effect.gen(function* () {
        const path = `/ws?protocol=${PROTOCOL_VERSION}`;

        assert.strictEqual(yield* upgradeStatus(path, caddyHeaders), 101);
        assert.strictEqual(
          yield* upgradeStatus(path, {
            ...caddyHeaders,
            origin: "https://evil.example",
          }),
          403
        );
        assert.strictEqual(
          yield* upgradeStatus(path, { host: HOST, [USER_HEADER]: OWNER }),
          403
        );
        assert.strictEqual(
          yield* upgradeStatus(path, {
            ...caddyHeaders,
            [USER_HEADER]: "oscabriel@githubx",
          }),
          403
        );
        assert.strictEqual(
          yield* upgradeStatus("/ws?protocol=0", caddyHeaders),
          426
        );
        assert.strictEqual(yield* upgradeStatus("/ws", caddyHeaders), 426);
        assert.strictEqual(
          yield* upgradeStatus(path, { ...caddyHeaders, host: "127.0.0.1" }),
          421
        );
      })
  );

  it.effect("closes the socket once its identity is no longer admitted", () =>
    Effect.gen(function* () {
      const client = yield* connect(caddyHeaders);

      yield* client["session.hello"]();
      yield* Ref.set(admitted, false);
      yield* Effect.sleep("700 millis");

      const after = yield* Effect.exit(
        client["session.hello"]().pipe(Effect.timeout("2 seconds"))
      );

      yield* Ref.set(admitted, true);
      assert.isTrue(Exit.isFailure(after));
    })
  );
});
