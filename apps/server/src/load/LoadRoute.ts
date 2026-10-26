// `POST /api/load-report`: the page's own account of one load, written as one `load.report` log line
// (plan D46: a log line, no table). The page posts it once it is interactive (`load/LoadMark.ts` in
// the web app); the route adds the path the peer took (direct or DERP, `PeerPath`), the user agent
// and the brain's time. `judges/phone-report.ts` reads these lines for the wizard's phone verdict.
// The guard runs first, as for every `/api` request, so a report needs the owner's identity and the
// exact Origin.

import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { forwardedPeer } from "../http/Request.ts";
import { PeerPath } from "./PeerPath.ts";

/** The route's path. */
export const LOAD_REPORT_PATH = "/api/load-report";

/** What the page reports. */
export const LoadReport = Schema.Struct({
  /** Navigation start to the `cairn:interactive` mark. */
  interactiveMs: Schema.Finite.check(
    Schema.isBetween({ minimum: 0, maximum: 600_000 })
  ),
  /** The document, every resource fetched before the mark, and the socket if it had opened. */
  requestsBeforeInteractive: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 1000 })
  ),
  /** Opened from the Home Screen (iOS `navigator.standalone` or `display-mode: standalone`). */
  standalone: Schema.Boolean,
});

export type LoadReport = typeof LoadReport.Type;

const noStore = { "cache-control": "no-store" };

/** Logs one load report; answers 204, or 400 for a body that is not a report. Needs `PeerPath`. */
export const LoadRoute = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const paths = yield* PeerPath;

    yield* router.add(
      "POST",
      LOAD_REPORT_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        const parsed = yield* HttpServerRequest.schemaBodyJson(LoadReport).pipe(
          Effect.option
        );

        if (Option.isNone(parsed)) {
          return HttpServerResponse.jsonUnsafe(
            {
              code: "invalid_input",
              message:
                "The load report is not valid JSON in the LoadReport shape. Nothing was logged; fix the client.",
              retryable: false,
            },
            { status: 400, headers: noStore }
          );
        }

        const path = yield* Option.match(forwardedPeer(request), {
          onNone: () => Effect.succeed("unknown" as const),
          onSome: (ip) => paths.pathOf(ip),
        });

        const at = yield* DateTime.now;

        yield* Effect.logInfo("load report").pipe(
          Effect.annotateLogs({
            event: "load.report",
            interactiveMs: Math.round(parsed.value.interactiveMs),
            requestsBeforeInteractive: parsed.value.requestsBeforeInteractive,
            derp: path === "derp",
            path,
            userAgent: request.headers["user-agent"] ?? "unknown",
            standalone: parsed.value.standalone,
            at: DateTime.formatIso(at),
          })
        );

        return HttpServerResponse.empty({ status: 204, headers: noStore });
      }).pipe(Effect.withSpan("LoadRoute.report"))
    );
  })
);
