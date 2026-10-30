// The Cairn extension seam (plan D50). Every Cairn tool, section and hook is a pi-durable extension
// carried with an order key, and the brain installs the whole set once, at boot, in key order.
// Installing or removing an extension later appends `pi.system` entries to every conversation and
// misses the prompt cache once (footgun "moving default selections"), so the set never churns, and
// the keys below are fixed with gaps for what later waves add. Judge-only extensions go through the
// same seam, with the `judge` key.

import type { Extension } from "@earendil-works/pi-durable";
import { Context, Effect, Layer } from "effect";

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
  /** `cairn.roles`: the `roles` tool over the role table (ADR 0035). */
  roles: 860,
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

/** The installed extension set, in install order. Built once per process. */
export class Extensions extends Context.Service<
  Extensions,
  { readonly installed: ReadonlyArray<Extension> }
>()("cairn/server/brain/Extensions") {
  /**
   * The set built from `sources`, sorted by order. Two extensions with one name or one order key
   * are a wiring bug, so the layer dies naming them.
   */
  static readonly fromSources = <E, R>(
    sources: ReadonlyArray<Effect.Effect<CairnExtension, E, R>>
  ) =>
    Layer.effect(
      Extensions,
      Effect.gen(function* () {
        const collected = yield* Effect.all(sources);
        const sorted = collected.toSorted((a, b) => a.order - b.order);

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
        });
      })
    );
}
