import { ShellSnapshot as ShellSnapshotSchema } from "@cairn/protocol/Shell";
import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpRouter } from "effect/http";

import { EventSink } from "./EventSink.ts";
import { ShellSnapshot } from "./ShellSnapshot.ts";
import { ShellSnapshotRoute } from "./ShellSnapshotRoute.ts";
import { createProject, createThread, ShellTestLayer } from "./ShellTestKit.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(
  Schema.toCodecJson(ShellSnapshotSchema)
);

const RouteTest = HttpRouter.serve(ShellSnapshotRoute, {
  disableLogger: true,
}).pipe(
  Layer.provideMerge(ShellTestLayer),
  Layer.provideMerge(NodeHttpServer.layerTest)
);

describe("GET /api/shell", () => {
  it.live("answers the current snapshot, never cached", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink;
      const { projectId, command } = createProject(1);

      yield* sink.commitCommand(command);
      yield* sink.commitCommand(createThread(projectId, 1));

      const response = yield* (yield* HttpClient.HttpClient).get("/api/shell");
      const body = yield* decodeSnapshot(yield* response.json);
      const expected = yield* (yield* ShellSnapshot).load;

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers["cache-control"], "no-store");
      assert.deepStrictEqual(body, expected);
    }).pipe(Effect.provide(RouteTest))
  );
});
