// `session.hello`: the first call on every socket. It tells the page which protocol and web build
// the server has (a page holding another build reloads), the server's clock, who the socket was
// admitted as, the new-thread defaults and, once push exists, the VAPID public key.

import { createHash } from "node:crypto";
import path from "node:path";

import type { ModelDefaults } from "@cairn/protocol/Models";
import type { VapidKey } from "@cairn/protocol/Push";
import type { Hello } from "@cairn/protocol/Rpc";
import { PROTOCOL_VERSION, Viewer } from "@cairn/protocol/Rpc";
import { Context, DateTime, Effect, FileSystem, Layer, Option } from "effect";

import { ServerConfig } from "../Config.ts";

/** The build id a server without a web build reports (dev, judges). */
export const DEV_BUILD = "dev";

/**
 * The new-thread defaults before the model runtime provides its own: pi's own
 * `defaultProvider`, `defaultModel` and `defaultThinkingLevel` on the Beelink today.
 */
export const FALLBACK_DEFAULTS: ModelDefaults = {
  model: { provider: "claude-bridge", modelId: "claude-opus-5-5" },
  thinkingLevel: "medium",
};

/** The parts of `session.hello` other services own. */
export class SessionHello extends Context.Service<
  SessionHello,
  {
    /** The web build's id: a hash of the built `index.html`, or `dev` with no build. */
    readonly build: string;
    /** The model and thinking level a new thread starts with. */
    readonly defaults: Effect.Effect<ModelDefaults>;
    /** The push key; `None` until push is configured. */
    readonly vapidPublicKey: Effect.Effect<Option.Option<VapidKey>>;
  }
>()("cairn/server/rpc/SessionHandlers/SessionHello") {
  /**
   * The build id from `index.html` under the configured web root, `FALLBACK_DEFAULTS` and no push
   * key. The models and push packages replace `defaults` and `vapidPublicKey` through their own
   * layers.
   */
  static readonly layer = Layer.effect(
    SessionHello,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;

      const index = yield* fs
        .readFile(path.join(config.webRoot, "index.html"))
        .pipe(Effect.option);

      const build = Option.match(index, {
        onNone: () => DEV_BUILD,
        onSome: (bytes) =>
          createHash("sha256").update(bytes).digest("hex").slice(0, 12),
      });

      return SessionHello.of({
        build,
        defaults: Effect.succeed(FALLBACK_DEFAULTS),
        vapidPublicKey: Effect.succeedNone,
      });
    })
  );
}

/** The `session.*` handlers. Needs `SessionHello`; reads `Viewer` per request. */
export const sessionHandlers = Effect.gen(function* () {
  const hello = yield* SessionHello;

  return {
    "session.hello": () =>
      Effect.gen(function* () {
        const viewer = yield* Viewer;

        const answer: Hello = {
          protocol: PROTOCOL_VERSION,
          build: hello.build,
          serverTime: yield* DateTime.now,
          viewer: viewer.login,
          defaults: yield* hello.defaults,
          vapidPublicKey: yield* hello.vapidPublicKey,
        };

        return answer;
      }),
  };
});
