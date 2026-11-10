// Every RPC handler in one layer: the brain's own, listed here, and every feature's, from its
// manifest (ADR 0053). The group is built from the real handlers only, and `servesEveryRpc` holds
// it to every RPC of `CairnRpcs`: a handler that is written but in no manifest is a compile error
// naming its tag, never a stub's "not available" answer at run time. Handlers stay thin: they call
// services and return protocol values.

import type { CairnRpcs } from "@cairn/protocol/Rpc";
import { Layer } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";

import type { Feature } from "../Features.ts";
import { DiffHandlers } from "./DiffHandlers.ts";
import { EventHandlers } from "./EventHandlers.ts";
import { ProjectHandlers } from "./ProjectHandlers.ts";
import { SessionHandlers } from "./SessionHandlers.ts";
import { ShellHandlers } from "./ShellHandlers.ts";
import { ThreadCommandHandlers } from "./ThreadCommandHandlers.ts";
import { ThreadStreamHandlers } from "./ThreadStreamHandlers.ts";

/** A handler for every RPC of `CairnRpcs`. */
type CairnHandler = Rpc.ToHandler<RpcGroup.Rpcs<typeof CairnRpcs>>;

/**
 * Holds a handler layer to the whole group: a layer that leaves an RPC without its handler does not
 * type-check, and the error names the missing `Handler<"tag">`.
 */
export const servesEveryRpc = <E, R>(layer: Layer.Layer<CairnHandler, E, R>) =>
  layer;

/**
 * The handlers of `CairnRpcs`, as the layer each socket's RPC server reads: the brain's own (the
 * session, the shell, a thread's commands and stream, projects, diffs, event status) and every
 * feature's (`AppLayer.ts` applies it to `Features.ts`'s list and holds the result to the whole
 * group). Needs `SessionHello`, the shell store (`ShellStream`, `EventSink`), the `HarnessSeam`,
 * the project and thread services, and what each feature's handlers read.
 */
export const handlersOf = (features: ReadonlyArray<Feature>) =>
  Layer.mergeAll(
    SessionHandlers,
    ShellHandlers,
    ThreadStreamHandlers.layer,
    ProjectHandlers.layer,
    ThreadCommandHandlers.layer,
    DiffHandlers.layer,
    EventHandlers,
    ...features.map((feature): Feature["handlers"] => feature.handlers)
  );
