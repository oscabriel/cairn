// The brain's layer graph (a seam: the integrator adds each package's layer here). Each entry point
// provides what it chooses itself: the identity rules, the settings source, logging, and (from
// later waves) the Executor link and the extension set. Build order is shutdown order reversed:
// whatever the close hooks need is built before `Shutdown`, and the HTTP server after it, so on
// SIGTERM the sockets close first, then the hooks run, then the stores close.
import { Effect, Layer } from "effect";

import { runBootRepairs } from "./BootRepairs.ts";
import { Health } from "./http/Health.ts";
import { HttpLive } from "./http/Http.ts";
import { BootJson } from "./http/Static.ts";
import { HandlersLayer } from "./rpc/Handlers.ts";
import { SessionHello } from "./rpc/SessionHandlers.ts";
import { Shutdown } from "./Shutdown.ts";
import { shutdownHooks } from "./ShutdownHooks.ts";

// Boot, until the boot package owns it: the repairs in order, then ready. The listener serves
// static files meanwhile and answers `/ws` with 503 until `markReady`.
const Boot = Layer.effectDiscard(
  Effect.gen(function* () {
    const health = yield* Health;

    yield* runBootRepairs;
    yield* health.markReady;
    yield* Effect.logInfo("ready").pipe(
      Effect.annotateLogs({ event: "ready" })
    );
  })
);

/**
 * Everything but the entry point's choices. Needs `ServerConfig`, `Identity` and the platform's
 * `FileSystem`.
 */
export const AppLayer = Layer.mergeAll(HttpLive, Boot).pipe(
  Layer.provide(HandlersLayer),
  Layer.provide(SessionHello.layer),
  Layer.provide(BootJson.layerNone),
  Layer.provide(Shutdown.layerFrom(shutdownHooks)),
  Layer.provide(Health.layer)
);
