// The deployed composition builds each stateful service once. The memo map keeps one instance per
// constructor reference (ADR 0034), so the hazard is a second constructor of a stateful service: a
// factory called twice (`Database.layer(options)`, `PiDurableBrain(...)`), which compiles and
// gives the brain two instances that disagree, a health store the brain records into and another
// the login RPCs reset, or a second connection to `cairn.sqlite`. This builds `MainLayer`, the
// layer `main.ts` runs, with fakes at its edges, through a memo map that records every context a
// constructor built, and counts each service's distinct instances. A second `Database.layer` given
// to `MainLayer` fails it.

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { withCatalog } from "./AppLayer.ts";
import { Brain } from "./brain/Brain.ts";
import { EventReactors } from "./brain/EventReactors.ts";
import { Extensions } from "./brain/Extensions.ts";
import { FauxModels } from "./brain/FauxModels.ts";
import { HarnessSeam } from "./brain/HarnessSeam.ts";
import { ModelSource } from "./brain/ModelSource.ts";
import { ServerConfig } from "./Config.ts";
import { Database } from "./db/Database.ts";
import { ExecutorLink } from "./executor/ExecutorLink.ts";
import { Identity } from "./http/Identity.ts";
import { MainLayer } from "./MainLayer.ts";
import { BridgeCwd } from "./models/BridgeCwdExtension.ts";
import { BridgeProvider } from "./models/BridgeProvider.ts";
import { ModelHealth } from "./models/ModelHealth.ts";
import { PiModelSource } from "./models/PiModelSource.ts";
import { SettingsStore } from "./models/SettingsStore.ts";
import { PiHost } from "./pi-host/PiHost.ts";
import { Artifacts } from "./reach/Artifacts.ts";
import { Portals } from "./reach/Portals.ts";
import { PortalTools } from "./reach/PortalTools.ts";
import { judgePortalSettings, ReachMachine } from "./reach/ReachLayer.ts";
import { ReachLister } from "./reach/ReachLister.ts";
import { EventSink } from "./shell/EventSink.ts";
import { ThreadRows } from "./shell/ThreadRows.ts";
import { Subagents } from "./subagents/Subagents.ts";
import { BudgetBook } from "./usage/BudgetBook.ts";
import { SpendLedger } from "./usage/SpendLedger.ts";
import { GoalBook } from "./verdicts/GoalBook.ts";
import { WorkflowPushes } from "./workflows/WorkflowPushes.ts";
import { ChildWorkspaces } from "./workspaces/ChildWorkspaces.ts";

/** The memo map's brand, which `Layer.MemoMap` declares and Effect does not export. */
const MEMO_MAP = "~effect/Layer/MemoMap";

/**
 * A memo map that hands every build to `inner` and records each context a constructor built, keyed
 * by service key: one distinct value per constructor run.
 */
const countingMemoMap = (
  inner: Layer.MemoMap,
  built: Map<string, Set<unknown>>
): Layer.MemoMap => {
  const memoMap: Layer.MemoMap = {
    [MEMO_MAP]: MEMO_MAP,
    get: (layer, scope) => inner.get(layer, scope),
    getOrElseMemoize: (layer, scope, build) =>
      inner.getOrElseMemoize(layer, scope, (_memoMap, buildScope) =>
        build(memoMap, buildScope).pipe(
          Effect.tap((context) =>
            Effect.sync(() => {
              for (const [key, value] of context.mapUnsafe) {
                const instances = built.get(key) ?? new Set<unknown>();

                instances.add(value);
                built.set(key, instances);
              }
            })
          )
        )
      ),
  };

  return memoMap;
};

const dataDir = mkdtempSync(path.join(os.tmpdir(), "cairn-composition-"));

// The edges `main.ts` gives the real machine, faked: the porch and units, the pi tools, the bridge,
// Executor, the identity rules and the settings. The models are the faux model behind the
// picker's catalog, as a judge brain runs them.
const Composed = MainLayer(
  withCatalog(FauxModels.layer({ tokensPerSecond: 50, settings: {} }))
).pipe(
  Layer.provide(ReachMachine.layerTest),
  Layer.provide(
    judgePortalSettings("cairn-composition-portal-", 0, "/usr/bin:/bin")
  ),
  Layer.provide(PiHost.layerEmpty),
  Layer.provide(BridgeProvider.layerOff),
  Layer.provide(ExecutorLink.layerDisabled),
  Layer.provide(Identity.layerLoopbackOwner),
  Layer.provide(
    ServerConfig.layerWith({
      dataDir,
      stateDir: path.join(dataDir, "state"),
      configDir: path.join(dataDir, "config"),
      webRoot: "/nonexistent/cairn-web",
    })
  ),
  Layer.provide(NodeServices.layer)
);

/**
 * The services whose state two instances would split: stores with memory, outboxes, the one
 * database and the brain itself. Each must be built exactly once.
 */
const STATEFUL = [
  Database,
  ModelHealth,
  SettingsStore,
  BudgetBook,
  WorkflowPushes,
  BridgeCwd,
  ChildWorkspaces,
  Artifacts,
  Portals,
  PortalTools,
  ReachLister,
  Subagents,
  GoalBook,
  SpendLedger,
  EventSink,
  ThreadRows,
  EventReactors,
  Extensions,
  Brain,
  HarnessSeam,
  ModelSource,
  PiModelSource,
] as const;

/**
 * Services built more than once on purpose: each later layer decorates the one before it, and only
 * the last reaches the handlers.
 */
const DECORATED: ReadonlySet<string> = new Set([
  // `SessionHello.layer`, then the models' defaults and the push key over it.
  "cairn/server/rpc/SessionHandlers/SessionHello",
]);

describe("the deployed composition", () => {
  it.live(
    "builds each stateful service once",
    () =>
      Effect.gen(function* () {
        const built = new Map<string, Set<unknown>>();
        const memoMap = countingMemoMap(yield* Layer.makeMemoMap, built);

        yield* Layer.buildWithMemoMap(Composed, memoMap, yield* Effect.scope);

        const timesBuilt = (key: string) => built.get(key)?.size ?? 0;

        for (const service of STATEFUL) {
          assert.strictEqual(
            timesBuilt(service.key),
            1,
            `${service.key} is built ${String(timesBuilt(service.key))} times`
          );
        }

        // Any other Cairn service built twice is a second instance too, unless it decorates
        // itself. Effect's own bookkeeping keys (`effect/...`) are not services.
        const twice = [...built.keys()].filter(
          (key) =>
            key.startsWith("cairn/") &&
            !DECORATED.has(key) &&
            timesBuilt(key) > 1
        );

        assert.deepStrictEqual(twice, [], "services built more than once");
        assert.isAbove(built.size, 100, "the composition was recorded");
      }).pipe(Effect.scoped),
    60_000
  );
});
