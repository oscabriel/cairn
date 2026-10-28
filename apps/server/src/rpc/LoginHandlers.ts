// `providers.login.start`, `providers.login.cancel` and `providers.logout` (ADR 0037): thin calls
// into `CodexLogin`. Codex is the one provider Cairn signs in to itself; any other provider is
// `InvalidInput` on `provider`. A second sign-in while one runs is `Conflict` (`limit_reached`), and
// a brain that keeps no sign-ins answers the stream with one `Failed` step (`unavailable`) and
// `providers.logout` with `Unavailable`. No answer carries a token.

import {
  Conflict,
  Internal,
  InvalidInput,
  Unavailable,
} from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer, Option, Stream } from "effect";

import { CodexLogin } from "../models/CodexLogin.ts";
import { CODEX_PROVIDER } from "../models/CredentialStore.ts";

const notSignedInHere = (provider: string, requestId: string) =>
  new InvalidInput({
    message: `Cairn signs in only to ${CODEX_PROVIDER}, not ${provider.slice(0, 200)}. Add the provider's API key in pi instead.`,
    field: Option.some("provider"),
    requestId: Option.some(requestId),
  });

/** `providers.login.start`: the sign-in's steps, until it signs in or fails. */
export const LoginStartHandler = CairnRpcs.toLayerHandler(
  "providers.login.start",
  Effect.gen(function* () {
    const login = yield* CodexLogin;

    return ({ provider }, { requestId }) =>
      provider === CODEX_PROVIDER
        ? login.start.pipe(
            Stream.mapError(
              (busy) =>
                new Conflict({
                  message: busy.message,
                  reason: "limit_reached",
                  requestId: Option.some(String(requestId)),
                })
            )
          )
        : Stream.fail(notSignedInHere(provider, String(requestId)));
  })
);

/** `providers.login.cancel`: cancels the running sign-in, if any; nothing else to cancel. */
export const LoginCancelHandler = CairnRpcs.toLayerHandler(
  "providers.login.cancel",
  Effect.gen(function* () {
    const login = yield* CodexLogin;

    return ({ provider }) =>
      provider === CODEX_PROVIDER ? Effect.asVoid(login.cancel) : Effect.void;
  })
);

/** `providers.logout`: removes Cairn's stored sign-in. */
export const LogoutHandler = CairnRpcs.toLayerHandler(
  "providers.logout",
  Effect.gen(function* () {
    const login = yield* CodexLogin;

    return ({ provider }, { requestId }) =>
      provider === CODEX_PROVIDER
        ? login.logout.pipe(
            Effect.asVoid,
            Effect.mapError((failure) =>
              failure.reason === "unavailable"
                ? new Unavailable({
                    message: failure.message.slice(0, 4096),
                    requestId: Option.some(String(requestId)),
                  })
                : new Internal({
                    message: failure.message.slice(0, 4096),
                    requestId: Option.some(String(requestId)),
                  })
            )
          )
        : Effect.fail(notSignedInHere(provider, String(requestId)));
  })
);

/** Every handler this module owns. Needs `CodexLogin`. */
export const LoginHandlers = Layer.mergeAll(
  LoginStartHandler,
  LoginCancelHandler,
  LogoutHandler
);
