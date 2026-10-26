// `models.list`, `providers.status`, `settings.get` and `settings.update`: thin calls into the model
// catalog and the settings store that translate their failures into the protocol's `Unavailable`,
// carrying the RPC request id. Also the `session.hello` defaults, from the same catalog.

import { Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer, Option } from "effect";

import type { ModelRuntimeError } from "../models/PiModelSource.ts";
import { PiModelSource } from "../models/PiModelSource.ts";
import type { SettingsStoreError } from "../models/SettingsStore.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { FALLBACK_DEFAULTS, SessionHello } from "./SessionHandlers.ts";

const unavailable =
  (requestId: string) => (failure: ModelRuntimeError | SettingsStoreError) =>
    new Unavailable({
      message: failure.message,
      requestId: Option.some(requestId),
    });

/** `models.list`: the picker's models (the bridge's hidden when it is off) and the defaults. */
export const ModelsListHandler = CairnRpcs.toLayerHandler(
  "models.list",
  Effect.gen(function* () {
    const models = yield* PiModelSource;
    const settings = yield* SettingsStore;

    return (_input, { requestId }) =>
      Effect.gen(function* () {
        const current = yield* settings.get;

        return yield* models.catalog({ bridgeEnabled: current.bridgeEnabled });
      }).pipe(Effect.mapError(unavailable(String(requestId))));
  })
);

/** `providers.status`: each provider's state, never a credential value. */
export const ProvidersStatusHandler = CairnRpcs.toLayerHandler(
  "providers.status",
  Effect.gen(function* () {
    const models = yield* PiModelSource;

    return (_input, { requestId }) =>
      models.providers.pipe(Effect.mapError(unavailable(String(requestId))));
  })
);

/** `settings.get`: the server-owned settings. */
export const SettingsGetHandler = CairnRpcs.toLayerHandler(
  "settings.get",
  Effect.gen(function* () {
    const settings = yield* SettingsStore;

    return (_input, { requestId }) =>
      settings.get.pipe(Effect.mapError(unavailable(String(requestId))));
  })
);

/** `settings.update`: applies the present keys, returns the result. */
export const SettingsUpdateHandler = CairnRpcs.toLayerHandler(
  "settings.update",
  Effect.gen(function* () {
    const settings = yield* SettingsStore;

    return (patch, { requestId }) =>
      settings
        .update(patch)
        .pipe(Effect.mapError(unavailable(String(requestId))));
  })
);

/** Every handler this module owns. Needs `PiModelSource` and `SettingsStore`. */
export const ModelHandlers = Layer.mergeAll(
  ModelsListHandler,
  ProvidersStatusHandler,
  SettingsGetHandler,
  SettingsUpdateHandler
);

/**
 * `SessionHello` with the new-thread defaults from the model catalog (the bridge's models skipped
 * when the setting turns it off). A catalog or settings failure falls back to the fixed defaults,
 * so a socket always gets its hello. Needs the base `SessionHello`, `PiModelSource` and
 * `SettingsStore`.
 */
export const SessionHelloWithModels = Layer.effect(
  SessionHello,
  Effect.gen(function* () {
    const base = yield* SessionHello;
    const models = yield* PiModelSource;
    const settings = yield* SettingsStore;

    return SessionHello.of({
      ...base,
      defaults: Effect.gen(function* () {
        const current = yield* settings.get;

        const catalog = yield* models.catalog({
          bridgeEnabled: current.bridgeEnabled,
        });

        return catalog.defaults;
      }).pipe(
        Effect.catchTags({
          ModelRuntimeError: () => Effect.succeed(FALLBACK_DEFAULTS),
          SettingsStoreError: () => Effect.succeed(FALLBACK_DEFAULTS),
        })
      ),
    });
  })
);
