// The entry image route serves only image types inline (T24): a transcript's media type is whatever
// a tool wrote, so a stub harness hands back an HTML "image" and the route must turn it into a
// sandboxed download, while a PNG still shows inline.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { HttpRouter } from "effect/http";

import { EntryImageRoute } from "./EntryImageRoute.ts";
import { HarnessSeam } from "./HarnessSeam.ts";

const unsupported = () => Effect.die("not used by this test");

const seamServing = (mimeType: string) =>
  HarnessSeam.of({
    ensureThread: unsupported,
    configure: unsupported,
    submit: unsupported,
    stop: unsupported,
    withdraw: unsupported,
    respond: unsupported,
    write: unsupported,
    compact: unsupported,
    watch: () => Stream.die("not used by this test"),
    whenEnsured: unsupported,
    history: unsupported,
    entry: unsupported,
    entryImage: () =>
      Effect.succeed({
        mimeType,
        bytes: new TextEncoder().encode("<script>alert(1)</script>"),
      }),
    events: Stream.never,
    inspect: Effect.succeed([]),
    retry: unsupported,
    capabilities: { durable: false, live: false },
  });

const headersFor = (mimeType: string) =>
  Effect.promise(async () => {
    const { handler, dispose } = HttpRouter.toWebHandler(
      EntryImageRoute.pipe(
        Layer.provide(Layer.succeed(HarnessSeam, seamServing(mimeType)))
      ),
      { disableLogger: true }
    );

    const response = await handler(
      new Request(
        "http://cairn.test/api/threads/0190f0c0-0000-7000-8000-0000000000a1/entries/4/images/0"
      )
    );

    await dispose();

    return {
      status: response.status,
      type: response.headers.get("content-type"),
      disposition: response.headers.get("content-disposition"),
      csp: response.headers.get("content-security-policy"),
    };
  });

describe("the entry image route", () => {
  it.live(
    "serves a stored type that is not an image as a sandboxed download",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* headersFor("text/html"), {
          status: 200,
          type: "application/octet-stream",
          disposition: "attachment",
          csp: "default-src 'none'; sandbox",
        });
      })
  );

  it.live("serves a png inline, still under the sandbox", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* headersFor("image/png"), {
        status: 200,
        type: "image/png",
        disposition: "inline",
        csp: "default-src 'none'; sandbox",
      });
    })
  );
});
