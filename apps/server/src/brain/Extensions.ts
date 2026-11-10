// The Cairn extension seam (plan D50). Every Cairn tool, section and hook is a pi-durable extension
// carried with an order key, and the brain installs the whole set once, at boot, in key order.
// Installing or removing an extension later appends `pi.system` entries to every conversation and
// misses the prompt cache once (footgun "moving default selections"), so the set never churns, and
// the keys below are fixed with gaps for what later waves add. Judge-only extensions go through the
// same seam, with the `judge` key.
//
// Beside its extensions a feature gives the harness what the seam needs from it (ADR 0053): the
// documents the thread stream carries, what an answer does in its commit for the records it owns,
// and the subagents' part of a submit and a Stop all. They travel with the set, so a root that
// builds the set from the features' manifests (`Features.ts`) gives the harness all of them, and a
// set built by hand from a few extensions gives the harness none of the features it left out.

import type {
  ConversationDocToken,
  Extension,
  ConversationId,
  InputSubmissionDraft,
  JsonObject,
  Session,
  Tx,
} from "@earendil-works/pi-durable";
import { Context, Effect, Layer } from "effect";
import type { Option } from "effect";

import type { AnsweredHook } from "../approvals/ApprovalLedger.ts";
import type { DurableCallError } from "./Durable.ts";

/** Install order, which is also prompt order. Gaps leave room; existing keys never move. */
export const ExtensionOrder = {
  codingTools: 100,
  cairn: 200,
  skills: 300,
  context: 400,
  codemode: 500,
  executor: 600,
  /** `cairn.budgets`: the `beforeTool` gate that refuses delegating tools past a scope's line (ADR 0036). */
  budgets: 640,
  /** `cairn.subagents`: the seven subagent tools and the anchor, brief and reporter tasks (ADR 0028). */
  subagents: 650,
  /** cairn.workflows: the workflow node tools, their watcher task and the gate (ADR 0012 as amended). */
  workflows: 660,
  /** `cairn.goals`: goal_check, goal_criteria and the cairn.judge-run task (ADR 0026). */
  goals: 670,
  bridgeCwd: 700,
  /** `cairn.reach`: the artifact tools (3E) and the portal tools (3F); 750 is the provider request log's. */
  reach: 760,
  piTools: 800,
  modelHealth: 850,
  /** `cairn.models`: the `models` tool, what a child can run on (ADR 0043). */
  models: 860,
  /** `cairn.ask-user`: the `ask_user` tool, questions for the user as user-input records. */
  askUser: 870,
  judge: 900,
  /** `cairn.results`: declares each child's result schema in `beforeRequest`; `submit_result`. */
  results: 950,
} as const;

/** One extension and where it installs. */
export interface CairnExtension {
  readonly order: number;
  readonly extension: Extension;
}

/**
 * Gives a user's input to a subagent its reporter before it is submitted, so its result reaches the
 * parent (ADR 0028). True when it gave it one.
 */
export type SteerHook = (
  session: Pick<Session, "commit" | "snapshot">,
  conversationId: ConversationId,
  input: InputSubmissionDraft
) => Effect.Effect<boolean, DurableCallError>;

/**
 * A Stop all's hold on the stopped thread's wakes, in its own commit, before any child stops: their
 * stopped results must not wake it (ADR 0028). `stopped` is the generation the stop aborted or
 * followed, which the hold is written against; none when the stop found no run live.
 */
export type WakeHoldHook = (
  tx: Tx,
  conversationId: ConversationId,
  stopped: Option.Option<number>
) => Promise<void>;

/** What the features give the harness beside their extensions; `R` is what their hooks read. */
export interface FeatureHooks<R> {
  /** The `cairn.*` documents the thread stream carries, in stream order. */
  readonly documents: ReadonlyArray<ConversationDocToken<JsonObject>>;
  /** What an answer does in its commit, for the records each feature owns. */
  readonly answered: ReadonlyArray<Effect.Effect<AnsweredHook, never, R>>;
  /** What a submit does first. */
  readonly steer: ReadonlyArray<SteerHook>;
  /** What a Stop all holds before its children stop. */
  readonly holdWakes: ReadonlyArray<WakeHoldHook>;
}

/** A set with no feature's hooks: a set built by hand from a few extensions. */
export const NO_FEATURE_HOOKS: FeatureHooks<never> = {
  documents: [],
  answered: [],
  steer: [],
  holdWakes: [],
};

/** The installed extension set, in install order, with the features' hooks. Built once per process. */
export class Extensions extends Context.Service<
  Extensions,
  {
    readonly installed: ReadonlyArray<Extension>;
    /** The `cairn.*` documents the thread stream carries beside pi-durable's own, in order. */
    readonly documents: ReadonlyArray<ConversationDocToken<JsonObject>>;
    /**
     * What an answer does inside its commit besides settling the record, for the records the
     * installed features own (a brief's Go starts its child, a launch's Go approves its row,
     * accepted criteria bind). Each hook acts on its own records only, so their order is free.
     */
    readonly answered: AnsweredHook;
    /** What a submit does first: a subagent's input gets its reporter. True when one did. */
    readonly steer: SteerHook;
    /** What a Stop all writes before its children stop: the hold on the thread's wakes. */
    readonly holdWakes: WakeHoldHook;
  }
>()("cairn/server/brain/Extensions") {
  /**
   * The set built from `sources` alone, with no feature's hooks: a set a test or a judge builds by
   * hand from a few extensions.
   */
  static readonly fromSources = <E, R>(
    sources: ReadonlyArray<Effect.Effect<CairnExtension, E, R>>
  ) => Extensions.fromFeatures(sources, NO_FEATURE_HOOKS);

  /**
   * The set built from `sources`, sorted by order, with the features' `hooks`, each kind run in
   * turn. Two extensions with one name or one order key are a wiring bug, so the layer dies
   * naming them.
   */
  static readonly fromFeatures = <E, R, HR>(
    sources: ReadonlyArray<Effect.Effect<CairnExtension, E, R>>,
    hooks: FeatureHooks<HR>
  ) =>
    Layer.effect(
      Extensions,
      Effect.gen(function* () {
        const collected = yield* Effect.all(sources);
        const sorted = collected.toSorted((a, b) => a.order - b.order);
        const answered = yield* Effect.all(hooks.answered);

        const names = new Set<string>();
        const orders = new Set<number>();

        for (const { extension, order } of sorted) {
          if (names.has(extension.name) || orders.has(order)) {
            return yield* Effect.die(
              `The Cairn extension set has two entries for ${extension.name} or order ${order}. Give each extension its own name and key in Extensions.ts.`
            );
          }

          names.add(extension.name);
          orders.add(order);
        }

        return Extensions.of({
          installed: sorted.map(({ extension }) => extension),
          documents: hooks.documents,
          answered: async (tx, conversationId, record) => {
            for (const hook of answered) {
              // oxlint-disable-next-line no-await-in-loop -- writes of one commit, in turn
              await hook(tx, conversationId, record);
            }
          },
          steer: (session, conversationId, input) =>
            Effect.map(
              Effect.forEach(hooks.steer, (hook) =>
                hook(session, conversationId, input)
              ),
              (steered) => steered.includes(true)
            ),
          holdWakes: async (tx, conversationId, stopped) => {
            for (const hook of hooks.holdWakes) {
              // oxlint-disable-next-line no-await-in-loop -- writes of one commit, in turn
              await hook(tx, conversationId, stopped);
            }
          },
        });
      })
    );
}
