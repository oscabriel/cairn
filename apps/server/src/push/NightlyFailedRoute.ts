// `POST /_cairn/notify/nightly-failed`: the failed nightly's unit (`ops/cairn/cairn-nightly-failed.service`,
// started by cairn-nightly.service's `OnFailure=`) asks the brain to push "the nightly judges
// failed" to every device (ADR 0054). Like `/_cairn/health` it answers only a process on this host:
// 404 to anything that came through Caddy (an `X-Forwarded-For`) or from another address, and 403
// to anything a browser sent (an `Origin` or a `Sec-Fetch-*` header), so a page open on this machine
// cannot fire it. The kind is fixed by the path and the body is never read: a caller decides only
// that the push goes, never what it says. The guard lets this one path and method through to these
// rules (`http/Guard.ts`).

import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { isDirectLoopback } from "../http/Health.ts";
import { Notifier } from "./Notifier.ts";

/** The route's path. */
export const NIGHTLY_FAILED_PATH = "/_cairn/notify/nightly-failed";

const noStore = { "cache-control": "no-store" };

/** Whether a browser sent the request: browsers add `Origin` to every POST, and fetch metadata. */
const fromBrowser = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.origin !== undefined ||
  Object.keys(request.headers).some((name) => name.startsWith("sec-fetch-"));

/**
 * Sends the nightly's failure push and answers how many devices took it: 200 when one did, 502
 * when none did, so the unit that called fails visibly. Needs `Notifier`.
 */
export const NightlyFailedRoute = HttpRouter.add(
  "POST",
  NIGHTLY_FAILED_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (!isDirectLoopback(request)) {
      return HttpServerResponse.text("Not found.\n", {
        status: 404,
        headers: noStore,
      });
    }

    if (fromBrowser(request)) {
      return HttpServerResponse.text(
        "The nightly's failure notice is for processes on this host, not browsers.\n",
        { status: 403, headers: noStore }
      );
    }

    const notifier = yield* Notifier;
    const outcomes = yield* notifier.nightlyFailed;

    const delivered = outcomes.filter(
      (outcome) => outcome === "delivered"
    ).length;

    return HttpServerResponse.jsonUnsafe(
      { devices: outcomes.length, delivered },
      { status: delivered > 0 ? 200 : 502, headers: noStore }
    );
  })
);
