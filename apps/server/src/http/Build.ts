// `GET /api/build`: the web build the server serves now, the same id `session.hello` reports and the
// boot JSON carries. A page reads it over plain HTTP when its socket's dials keep failing: after a
// protocol bump the server refuses an old page's dial with a 426 a browser WebSocket cannot read, so
// the page asks here and reloads for the new build (`load/StaleBuild.ts` in the web app). The guard
// (Host, identity, Origin, `Sec-Fetch-Site`) runs before this route as global middleware.

import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { SessionHello } from "../rpc/SessionHandlers.ts";

/** The route's path. */
export const BUILD_PATH = "/api/build";

/** What the route answers: the build id alone. */
const ServerBuild = Schema.Struct({ build: Schema.String });

const buildJson = HttpServerResponse.schemaJson(ServerBuild);

/** Answers the served web build, never cached. Needs `SessionHello`. */
export const BuildRoute = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const hello = yield* SessionHello;

    yield* router.add(
      "GET",
      BUILD_PATH,
      buildJson(
        { build: hello.build },
        { headers: { "cache-control": "no-store" } }
      ).pipe(
        Effect.catchTag("HttpBodyError", () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              {
                code: "internal",
                message:
                  "The build id could not be encoded. Report this with the time it happened.",
                retryable: false,
              },
              { status: 500, headers: { "cache-control": "no-store" } }
            )
          )
        ),
        Effect.withSpan("BuildRoute.build")
      )
    );
  })
);
