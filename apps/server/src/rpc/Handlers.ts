// Every RPC handler in one layer (a seam: the integrator adds each domain's handlers here). Later
// entries win: `Layer.mergeAll` keeps the last handler for a tag, so each domain's handler layer,
// listed after the stubs, replaces its stubs. Handlers stay thin: they call services and return
// protocol values.

import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer } from "effect";

import { CodexLogin } from "../models/CodexLogin.ts";
import { RoleAliases } from "../models/RoleAliases.ts";
import { UsageFeed } from "../usage/UsageFeed.ts";
import { AttachmentHandlers } from "./AttachmentHandlers.ts";
import { DiffHandlers } from "./DiffHandlers.ts";
import { EventHandlers } from "./EventHandlers.ts";
import { ExecutorHandlers } from "./ExecutorHandlers.ts";
import { LoginHandlers } from "./LoginHandlers.ts";
import { ModelHandlers } from "./ModelHandlers.ts";
import { ProjectHandlers } from "./ProjectHandlers.ts";
import { PushHandlers } from "./PushHandlers.ts";
import { RoleHandlers } from "./RoleHandlers.ts";
import { sessionHandlers } from "./SessionHandlers.ts";
import { ShellHandlers } from "./ShellHandlers.ts";
import { SkillHandlers } from "./SkillHandlers.ts";
import { SpendHandlers } from "./SpendHandlers.ts";
import { stubHandlers } from "./StubHandlers.ts";
import { ThreadCommandHandlers } from "./ThreadCommandHandlers.ts";
import { ThreadStreamHandlers } from "./ThreadStreamHandlers.ts";
import { UsageHandlers } from "./UsageHandlers.ts";

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
 * (`PiModelSource`), `SettingsStore`, `ModelHealth`, and the project and thread services. The
 * `roles.check` handler's `RoleAliases` reads the Claude plan's windows from `BridgeProvider`, a
 * reference the deployed root provides.
 */
export const HandlersLayer = Layer.mergeAll(
  BaseHandlers,
  ShellHandlers,
  ThreadStreamHandlers.layer,
  ModelHandlers,
  ProjectHandlers.layer,
  ThreadCommandHandlers.layer,
  AttachmentHandlers,
  ExecutorHandlers,
  SkillHandlers.layer,
  UsageHandlers.pipe(Layer.provide(UsageFeed.layer)),
  PushHandlers,
  DiffHandlers.layer,
  EventHandlers,
  SpendHandlers,
  RoleHandlers.pipe(Layer.provide(RoleAliases.layerNoDeps)),
  LoginHandlers.pipe(Layer.provide(CodexLogin.layer))
);
