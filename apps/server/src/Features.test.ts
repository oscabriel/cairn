// The feature seam (ADR 0053): every manifest in `Features.ts` is folded by every consumer, the
// order that matters is the one the list and its keys state, and every document a manifest gives
// the thread stream is one a client may see.

import { readFileSync } from "node:fs";
import path from "node:path";

import { DOCUMENT_SCHEMAS } from "@cairn/protocol/JsonSchema";
import { VISIBLE_DOCUMENTS } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { appLayersOf, harnessLayersOf } from "./AppLayer.ts";
import { RepairOrder } from "./BootRepair.ts";
import { bootRepairs, bootRepairsOf, keptWaitsOf } from "./BootRepairs.ts";
import { brainExtensions, FAUX_MODEL_OPTIONS } from "./brain/BrainTestKit.ts";
import { ExtensionOrder, Extensions } from "./brain/Extensions.ts";
import { FauxModels } from "./brain/FauxModels.ts";
import { THREAD_DOCUMENTS } from "./brain/PiDurableHarness.ts";
import {
  extensionLayersOf,
  extensionSourcesOf,
  featureHooksOf,
} from "./ExtensionSet.ts";
import { FEATURES } from "./Features.ts";
import type { Feature } from "./Features.ts";
import { reactorsOf } from "./ReactorSet.ts";
import { handlersOf } from "./rpc/Handlers.ts";
import { closeHooksOf, shutdownHooks } from "./ShutdownHooks.ts";

const source = (file: string) =>
  readFileSync(path.join(import.meta.dirname, file), "utf-8");

/** Every consumer's fold, as the consumer applies it to the list. */
const FOLDS: ReadonlyArray<{
  readonly consumer: string;
  readonly fold: string;
  readonly run: (features: ReadonlyArray<Feature>) => object;
}> = [
  {
    consumer: "ExtensionSet.ts",
    fold: "extensionSourcesOf",
    run: extensionSourcesOf,
  },
  {
    consumer: "ExtensionSet.ts",
    fold: "extensionLayersOf",
    run: extensionLayersOf,
  },
  { consumer: "ExtensionSet.ts", fold: "featureHooksOf", run: featureHooksOf },
  { consumer: "ReactorSet.ts", fold: "reactorsOf", run: reactorsOf },
  { consumer: "BootRepairs.ts", fold: "bootRepairsOf", run: bootRepairsOf },
  { consumer: "BootRepairs.ts", fold: "keptWaitsOf", run: keptWaitsOf },
  { consumer: "ShutdownHooks.ts", fold: "closeHooksOf", run: closeHooksOf },
  { consumer: "AppLayer.ts", fold: "handlersOf", run: handlersOf },
  { consumer: "AppLayer.ts", fold: "harnessLayersOf", run: harnessLayersOf },
  { consumer: "AppLayer.ts", fold: "appLayersOf", run: appLayersOf },
];

/** The production set's extensions, in install order (their `ExtensionOrder` keys). */
const INSTALLED: ReadonlyArray<string> = [
  "coding-tools",
  "cairn",
  "skills",
  "context",
  "codemode",
  "cairn-executor",
  "cairn.budgets",
  "cairn.subagents",
  "cairn.workflows",
  "cairn.goals",
  "cairn.bridge-cwd",
  "cairn-provider-request-log",
  "cairn.reach",
  "cairn.pi-tools",
  "cairn.model-health",
  "cairn.models",
  "cairn.ask-user",
  "cairn.results",
];

describe("the feature manifests", () => {
  it("are each folded by every consumer, which reads every field", () => {
    const read = new Map<string, Set<PropertyKey>>();

    const watched = FEATURES.map(
      (feature): Feature =>
        new Proxy(feature, {
          get: (target, key, receiver) => {
            const keys = read.get(target.name) ?? new Set<PropertyKey>();

            keys.add(key);
            read.set(target.name, keys);

            // oxlint-disable-next-line anti-slop/no-reflect-get, typescript/no-unsafe-return -- the watch hands every read on to the manifest it watches, unchanged
            return Reflect.get(target, key, receiver);
          },
        })
    );

    for (const { run } of FOLDS) {
      run(watched);
    }

    // `name` names the feature's folder for the structural tests, and no consumer needs it.
    const unread = FEATURES.flatMap((feature) =>
      Object.keys(feature).flatMap((key) =>
        key === "name" || read.get(feature.name)?.has(key) === true
          ? []
          : [`${feature.name}.${key}`]
      )
    );

    assert.deepStrictEqual(unread, [], "manifest fields no consumer reads");

    for (const { consumer, fold } of FOLDS) {
      assert.include(
        source(consumer),
        `${fold}(FEATURES)`,
        `${consumer} folds the whole list with ${fold}`
      );
    }
  });

  it("each live in their own folder, one manifest a folder", () => {
    const names = FEATURES.map((feature) => feature.name);

    assert.lengthOf(new Set(names), names.length);

    for (const feature of FEATURES) {
      assert.include(
        source("Features.ts"),
        `from "./${feature.name}/`,
        `${feature.name}'s manifest is in its folder`
      );
    }
  });

  it("give the thread stream only documents a client may see, in the stream's order", () => {
    const kinds = [
      ...THREAD_DOCUMENTS,
      ...featureHooksOf(FEATURES).documents,
    ].map((token) => token.definition.kind);

    assert.deepStrictEqual(kinds, [
      "cairn.approvals",
      "cairn.permissions",
      "cairn.subagents",
      "cairn.child",
      "cairn.escalations",
      "cairn.workflows",
      "cairn.goal",
    ]);

    const described = new Set(DOCUMENT_SCHEMAS.map(([kind]) => kind));

    for (const feature of FEATURES) {
      for (const token of feature.documents) {
        assert.include(VISIBLE_DOCUMENTS, token.definition.kind);
        assert.isTrue(described.has(token.definition.kind));
      }
    }
  });

  it("run the boot repairs in key order, which keeps the rule", () => {
    assert.deepStrictEqual(
      bootRepairs.map((repair) => repair.name),
      [
        "sweep attachment uploads",
        "executor-sweep",
        "subagent rows",
        "subagent titles",
        "spend reconcile",
        "budget boot repair",
        "cancel abandoned approvals",
        "expire lapsed approvals",
        "crash limit",
        "child workspace repair",
        "scratch folder repair",
        "resume interrupted launches",
        "checkpoint repair",
        "portal reconcile",
        "start portal sweep",
        "start event reactors",
      ]
    );

    // Every key is used once, so no two repairs tie and none is left without a place.
    assert.sameMembers(
      bootRepairs.map((repair) => repair.at),
      Object.values(RepairOrder)
    );
    assert.lengthOf(new Set(Object.values(RepairOrder)), bootRepairs.length);
  });

  it("close in list order, the reactors last", () => {
    assert.deepStrictEqual(
      shutdownHooks.map((hook) => hook.name),
      [
        "claude-bridge begin closing",
        "stop portal sweep",
        "stop event reactors",
      ]
    );
  });

  it("keep the waits the crash limit keeps", () => {
    const kept = keptWaitsOf(FEATURES);

    assert.sameMembers([...kept.tools], ["subagent_status", "agent", "verify"]);
    assert.includeMembers(
      [...kept.kinds],
      [
        "cairn.workflow-watch",
        "cairn.workflow-budget-stop",
        "cairn.workflow-launch-watch",
      ]
    );
  });

  it.effect("install the production set in its key order, each key once", () =>
    Effect.gen(function* () {
      assert.lengthOf(
        new Set(Object.values(ExtensionOrder)),
        Object.values(ExtensionOrder).length
      );

      const built = yield* Layer.build(
        brainExtensions().pipe(
          Layer.provide(FauxModels.layer(FAUX_MODEL_OPTIONS))
        )
      );

      assert.deepStrictEqual(
        Context.get(built, Extensions).installed.map(
          (extension) => extension.name
        ),
        INSTALLED
      );
    }).pipe(Effect.scoped)
  );
});
