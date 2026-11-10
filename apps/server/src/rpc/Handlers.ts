// Every RPC handler in one layer (a seam: the integrator adds each domain's handlers here). The
// group is built from the real handlers only, and `servesEveryRpc` holds it to every RPC of
// `CairnRpcs`: a handler that is written but not listed here is a compile error naming its tag,
// never a stub's "not available" answer at run time. Handlers stay thin: they call services and
// return protocol values.

import type { CairnRpcs } from "@cairn/protocol/Rpc";
import { Layer } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";

import { CodexLogin } from "../models/CodexLogin.ts";
import { ModelSpecs } from "../models/ModelSpecs.ts";
import { UsageFeed } from "../usage/UsageFeed.ts";
import { Recipes } from "../workflows/recipes/Recipes.ts";
import { AttachmentHandlers } from "./AttachmentHandlers.ts";
import { DiffHandlers } from "./DiffHandlers.ts";
import { EventHandlers } from "./EventHandlers.ts";
import { ExecutorHandlers } from "./ExecutorHandlers.ts";
import { GoalHandlers } from "./GoalHandlers.ts";
import { LoginHandlers } from "./LoginHandlers.ts";
import { ModelCheckHandlers } from "./ModelCheckHandlers.ts";
import { ModelHandlers } from "./ModelHandlers.ts";
import { PortalHandlers } from "./PortalHandlers.ts";
import { ProjectHandlers } from "./ProjectHandlers.ts";
import { PushHandlers } from "./PushHandlers.ts";
import { ReachHandlers } from "./ReachHandlers.ts";
import { SessionHandlers } from "./SessionHandlers.ts";
import { ShellHandlers } from "./ShellHandlers.ts";
import { SkillHandlers } from "./SkillHandlers.ts";
import { SpendHandlers } from "./SpendHandlers.ts";
import { ThreadCommandHandlers } from "./ThreadCommandHandlers.ts";
import { ThreadStreamHandlers } from "./ThreadStreamHandlers.ts";
import { UsageHandlers } from "./UsageHandlers.ts";
import { WorkflowHandlers } from "./WorkflowHandlers.ts";

/** A handler for every RPC of `CairnRpcs`. */
type CairnHandler = Rpc.ToHandler<RpcGroup.Rpcs<typeof CairnRpcs>>;

/**
 * Holds a handler layer to the whole group: a layer that leaves an RPC without its handler does not
 * type-check, and the error names the missing `Handler<"tag">`.
 */
const servesEveryRpc = <E, R>(layer: Layer.Layer<CairnHandler, E, R>) => layer;

/**
 * The handlers of `CairnRpcs`, as the layer each socket's RPC server reads. Needs `SessionHello`,
 * the shell store (`ShellStream`, `EventSink`), the `HarnessSeam`, the model catalog
 * (`PiModelSource`), `SettingsStore`, `ModelHealth`, and the project and thread services. The
 * `models.check` handler's `ModelSpecs` reads the Claude plan's windows from `BridgeProvider`, a
 * reference the deployed root provides. The reach handlers read `Artifacts`, `ReachLister` and
 * `Portals` (`ReachLive`), over porch.
 */
export const HandlersLayer = servesEveryRpc(
  Layer.mergeAll(
    SessionHandlers,
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
    PortalHandlers,
    ModelCheckHandlers.pipe(Layer.provide(ModelSpecs.layerNoDeps)),
    ReachHandlers,
    LoginHandlers.pipe(Layer.provide(CodexLogin.layer)),
    WorkflowHandlers.layer.pipe(Layer.provide(Recipes.layer)),
    GoalHandlers
  )
);
