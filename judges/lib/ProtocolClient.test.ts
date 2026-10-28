// Judges `ProtocolClient` against an in-process server on a real loopback socket: the upgrade carries
// the Origin and the extra headers, `?protocol=` reaches the server, unary calls, streams and typed
// errors cross, and a refused upgrade fails the call instead of hanging or retrying.

import { createServer } from "node:http";

import { PROTOCOL_VERSION } from "@cairn/protocol/Rpc";
import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import {
  Rpc,
  RpcClientError,
  RpcGroup,
  RpcSerialization,
  RpcServer,
} from "effect/rpc";

import * as ProtocolClient from "./ProtocolClient.ts";

const origin = "https://code.gneiss.run";

const Seen = Schema.Struct({
  text: Schema.String,
  origin: Schema.String,
  user: Schema.String,
  host: Schema.String,
});

class Refused extends Schema.TaggedError<Refused>()("Refused", {
  message: Schema.String,
}) {}

const TestRpcs = RpcGroup.make(
  Rpc.make("echo", { payload: { text: Schema.String }, success: Seen }),
  Rpc.make("count", {
    payload: { upTo: Schema.Int },
    success: Schema.Int,
    stream: true,
  }),
  Rpc.make("refuse", { error: Refused })
);

const Handlers = TestRpcs.toLayer({
  echo: ({ text }, { headers }) =>
    Effect.succeed({
      text,
      origin: headers.origin ?? "",
      user: headers["x-cairn-user"] ?? "",
      host: headers.host ?? "",
    }),
  count: ({ upTo }) => Stream.range(1, upTo),
  refuse: () => new Refused({ message: "Refused on purpose by the test." }),
});

// Refused upgrades per Origin, so a test can see whether the client tried again.
const refusals = new Map<string, number>();

// The two upgrade rules the brain's guard and `/ws` route apply: Cairn's Origin, and the protocol
// version in the query (426 otherwise).
const Guard = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      const requestOrigin = request.headers.origin ?? "";

      if (requestOrigin !== origin) {
        refusals.set(requestOrigin, (refusals.get(requestOrigin) ?? 0) + 1);

        return HttpServerResponse.text("Origin refused.\n", { status: 403 });
      }

      const protocol = new URL(request.url, "http://loopback").searchParams.get(
        "protocol"
      );

      if (protocol !== String(PROTOCOL_VERSION)) {
        return HttpServerResponse.text("protocol_incompatible\n", {
          status: 426,
        });
      }

      return yield* httpEffect;
    }),
  { global: true }
);

const ServerLayer = HttpRouter.serve(
  Layer.mergeAll(
    RpcServer.layerHttp({
      group: TestRpcs,
      path: "/ws",
      disableFatalDefects: true,
    }),
    Guard
  ),
  { disableLogger: true, disableListenLog: true }
).pipe(
  Layer.provide(Handlers),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provideMerge(
    NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
  )
);

const baseUrl = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;

  return HttpServer.formatAddress(server.address);
});

describe("socketUrl", () => {
  layer(Layer.empty)((it) => {
    it.effect("turns http into ws and https into wss, with the protocol", () =>
      Effect.sync(() => {
        assert.strictEqual(
          ProtocolClient.socketUrl("http://127.0.0.1:4100", 1),
          "ws://127.0.0.1:4100/ws?protocol=1"
        );

        assert.strictEqual(
          ProtocolClient.socketUrl("https://code.gneiss.run/", 2),
          "wss://code.gneiss.run/ws?protocol=2"
        );
      })
    );
  });
});

layer(ServerLayer, { excludeTestServices: true })("ProtocolClient", (it) => {
  it.effect("sends Origin and the extra upgrade headers", () =>
    Effect.gen(function* () {
      const base = yield* baseUrl;

      const client = yield* ProtocolClient.make(TestRpcs, {
        base,
        origin,
        headers: { Host: "code.gneiss.run", "X-Cairn-User": "owner@github" },
      });

      const seen = yield* client.echo({ text: "hello" });

      assert.deepStrictEqual(seen, {
        text: "hello",
        origin,
        user: "owner@github",
        host: "code.gneiss.run",
      });
    }).pipe(Effect.scoped)
  );

  it.effect("streams every item in order", () =>
    Effect.gen(function* () {
      const base = yield* baseUrl;

      const client = yield* ProtocolClient.make(TestRpcs, { base, origin });

      const items = yield* client.count({ upTo: 50 }).pipe(Stream.runCollect);

      assert.deepStrictEqual(
        items,
        Array.from({ length: 50 }, (_, index) => index + 1)
      );
    }).pipe(Effect.scoped)
  );

  it.effect("carries a typed error across the socket", () =>
    Effect.gen(function* () {
      const base = yield* baseUrl;

      const client = yield* ProtocolClient.make(TestRpcs, { base, origin });

      const error = yield* client.refuse().pipe(Effect.flip);

      assert.instanceOf(error, Refused);

      assert.strictEqual(error.message, "Refused on purpose by the test.");
    }).pipe(Effect.scoped)
  );

  it.effect("fails, without retrying, when the upgrade is refused", () =>
    Effect.gen(function* () {
      const base = yield* baseUrl;

      const foreign = yield* ProtocolClient.make(TestRpcs, {
        base,
        origin: "https://evil.example",
      });

      const refused = yield* foreign
        .echo({ text: "x" })
        .pipe(Effect.flip, Effect.timeout("3 seconds"));

      assert.instanceOf(refused, RpcClientError.RpcClientError);

      // Effect's default policy would try again after 500 ms.
      yield* Effect.sleep("1200 millis");

      assert.strictEqual(refusals.get("https://evil.example"), 1);

      const stale = yield* ProtocolClient.make(TestRpcs, {
        base,
        origin,
        protocol: PROTOCOL_VERSION + 1,
      });

      const incompatible = yield* stale
        .echo({ text: "x" })
        .pipe(Effect.flip, Effect.timeout("3 seconds"));

      assert.instanceOf(incompatible, RpcClientError.RpcClientError);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "opens a fresh connection in a new scope after the last closed",
    () =>
      Effect.gen(function* () {
        const base = yield* baseUrl;

        const open = ProtocolClient.make(TestRpcs, { base, origin }).pipe(
          Effect.flatMap((client) => client.echo({ text: "again" })),
          Effect.scoped
        );

        const first = yield* open;

        const second = yield* open;

        assert.strictEqual(first.text, "again");

        assert.strictEqual(second.text, "again");
      })
  );
});
