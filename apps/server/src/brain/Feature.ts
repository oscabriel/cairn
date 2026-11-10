// The feature seam (ADR 0053): what one feature registers with the brain and the app, in one
// manifest its folder exports. `Features.ts` lists every manifest in order, and each consumer folds
// the whole list: the extension set (`ExtensionSet.ts`), the reactor host (`ReactorSet.ts`), the
// boot repairs (`BootRepairs.ts`), the close hooks (`ShutdownHooks.ts`), the RPC group
// (`rpc/Handlers.ts`) and the app (`AppLayer.ts`). The brain defines the shape and reads only what
// a consumer hands it, so `brain/` imports no feature folder, and a new feature arrives as its
// folder plus one entry in that list.
//
// A manifest is declared with `satisfies CairnFeature`, which checks its shape and keeps its
// precise type: the consumers' requirements and the RPC group's completeness are computed from it.

import type {
  ConversationDocToken,
  JsonObject,
} from "@earendil-works/pi-durable";
import type { Effect, Layer } from "effect";

import type { AnsweredHook } from "../approvals/ApprovalLedger.ts";
import type { PlacedRepair } from "../BootRepair.ts";
import type { ShutdownHook } from "../Shutdown.ts";
import type { Reactor } from "./Events.ts";
import type { CairnExtension, SteerHook, WakeHoldHook } from "./Extensions.ts";

/** What one feature registers. Every field is folded by a consumer (`Features.test.ts`). */
export interface CairnFeature {
  /** The feature's folder under `apps/server/src`. */
  readonly name: string;
  /**
   * Its pi-durable extensions, each built from the services it reads, with its `ExtensionOrder`
   * key, which decides where it installs.
   */
  readonly extensionSources: ReadonlyArray<
    Effect.Effect<CairnExtension, never, unknown>
  >;
  /**
   * The services its extensions read that the feature builds itself. Those a root chooses (the
   * Executor link, the pi tools host, the subagents' child workspaces) stay in the set's
   * requirements.
   */
  readonly extensionLayer: Layer.Layer<never, unknown, unknown>;
  /**
   * The `cairn.*` documents of its own the thread stream carries, in stream order, after the
   * thread's own (`cairn.approvals`, `cairn.permissions`), which the harness always carries.
   */
  readonly documents: ReadonlyArray<ConversationDocToken<JsonObject>>;
  /** What an answer does in its commit for the records it owns. */
  readonly answered: ReadonlyArray<Effect.Effect<AnsweredHook, never, unknown>>;
  /** What a submit does first (the subagents' reporter for a child's input). */
  readonly steer: ReadonlyArray<SteerHook>;
  /** What a Stop all writes before its children stop. */
  readonly holdWakes: ReadonlyArray<WakeHoldHook>;
  /** Its boot repairs, each placed by a `RepairOrder` key. */
  readonly bootRepairs: ReadonlyArray<PlacedRepair<unknown>>;
  /** Its close hooks, in the order they run; features close in list order. */
  readonly closeHooks: ReadonlyArray<ShutdownHook<unknown>>;
  /** Its durable event reactors (ADR 0033). */
  readonly reactors: ReadonlyArray<Reactor>;
  /** The waits the crash limit keeps however often crashes cut them off (ADR 0046). */
  readonly keptWaits: {
    /** Task kinds kept whole. */
    readonly kinds: ReadonlyArray<string>;
    /** Tools whose calls wait without a record of their own. */
    readonly tools: ReadonlyArray<string>;
  };
  /** Its RPC handlers. */
  readonly handlers: Layer.Layer<never, unknown, unknown>;
  /** The services it runs over pi-durable, beside the harness (`PiDurableBrain`). */
  readonly harnessLayer: Layer.Layer<never, unknown, unknown>;
  /** What the app runs for it: its fibers and the services only it gives the app. */
  readonly appLayer: Layer.Layer<never, unknown, unknown>;
}

/**
 * What the given manifests register in one list field, as one type: the union of each manifest's
 * own entries, which a fold over the list keeps (TypeScript would infer only the first manifest's).
 */
export type Registered<
  F extends CairnFeature,
  K extends "extensionSources" | "answered" | "bootRepairs" | "closeHooks",
> = F[K] extends ReadonlyArray<infer A> ? A : never;
