// Every RPC handler in one layer (a seam: the integrator adds each domain's handlers here). Later
// entries win: `Layer.mergeAll` keeps the last handler for a tag, so each domain's handler layer,
// listed after the stubs, replaces its stubs. Handlers stay thin: they call services and return
// protocol values.
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer } from "effect";

import { ModelHandlers } from "./ModelHandlers.ts";
import { ProjectHandlers } from "./ProjectHandlers.ts";
import { sessionHandlers } from "./SessionHandlers.ts";
import { ShellHandlers } from "./ShellHandlers.ts";
import { stubHandlers } from "./StubHandlers.ts";
import { ThreadCommandHandlers } from "./ThreadCommandHandlers.ts";
import { ThreadStreamHandlers } from "./ThreadStreamHandlers.ts";

/** The stubs with the session handlers over them. */
const BaseHandlers = CairnRpcs.toLayer(
  Effect.gen(function* () {
    const session = yield* sessionHandlers;

    return CairnRpcs.of({
      ...stubHandlers,
      ...session,
    });
  })
);

/**
 * The handlers of `CairnRpcs`, as the layer each socket's RPC server reads. Needs `SessionHello`,
 * the shell store (`ShellStream`, `EventSink`), the `HarnessSeam`, the model catalog
 * (`PiModelSource`), `SettingsStore`, and the project and thread services.
 */
export const HandlersLayer = Layer.mergeAll(
  BaseHandlers,
  ShellHandlers,
  ThreadStreamHandlers.layer,
  ModelHandlers,
  ProjectHandlers.layer,
  ThreadCommandHandlers.layer
);
