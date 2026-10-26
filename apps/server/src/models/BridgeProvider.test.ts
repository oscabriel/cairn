// The bridge as the brain composes it: the boot log's process parsing and orphan rule, the
// `ExtraProviders` it hands the model runtime (the real `claude-bridge` provider, or nothing when
// off), and pi's model runtime with that provider registered: Claude's models listed and every one
// of them given D7's compaction override in the run settings. Also the usage feed on and off.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ClaudeSdkScripts } from "@cairn/bridge/ClaudeSdk";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  Layer,
  Logger,
  Option,
  References,
  Stream,
} from "effect";

import { ModelSource } from "../brain/ModelSource.ts";
import { UsageFeed } from "../usage/UsageFeed.ts";
import {
  BridgeExtraProviders,
  BridgeProvider,
  orphanClaudes,
  parseProcessStat,
} from "./BridgeProvider.ts";
import { BRIDGE_COMPACTION, HarnessSettings } from "./HarnessSettings.ts";
import { PiConfig } from "./PiConfig.ts";
import { ExtraProviders, PiModelSource } from "./PiModelSource.ts";

const Scripts = Layer.effect(ClaudeSdkScripts, ClaudeSdkScripts.make([]));

const BridgeTest = BridgeProvider.layerTest.pipe(Layer.provideMerge(Scripts));

const stat = (pid: number, command: string, parent: number) =>
  `${pid} (${command}) S ${parent} ${pid} ${pid} 0 -1 4194560 100 0 0 0`;

describe("the boot log's process rules", () => {
  it("reads the command and parent, even when the command holds spaces and parentheses", () => {
    assert.deepStrictEqual(
      parseProcessStat(stat(42, "tmux: server (1)", 7)),
      Option.some({ pid: 42, command: "tmux: server (1)", parent: 7 })
    );
    assert.deepStrictEqual(parseProcessStat("garbage"), Option.none());
  });

  it("finds claude processes re-parented to init or a systemd subreaper, never a live brain's", () => {
    const processes = [
      { pid: 1, command: "systemd", parent: 0 },
      { pid: 900, command: "systemd", parent: 1 },
      { pid: 1000, command: "node", parent: 900 },
      { pid: 1001, command: "claude", parent: 1000 },
      { pid: 1002, command: "claude", parent: 900 },
      { pid: 1003, command: "claude", parent: 1 },
      { pid: 1004, command: "zsh", parent: 1 },
    ];

    assert.deepStrictEqual(orphanClaudes(processes), [1002, 1003]);
  });
});

describe("the bridge's extra providers", () => {
  it.effect("are nothing while the bridge is off (the default)", () =>
    Effect.gen(function* () {
      const extra = yield* ExtraProviders;

      assert.deepStrictEqual(extra, []);
    }).pipe(Effect.provide(BridgeExtraProviders))
  );

  it.effect("are nothing when CAIRN_BRIDGE is malformed, with a warning", () =>
    Effect.gen(function* () {
      const events: Array<unknown> = [];

      const capture = Logger.make((options) => {
        events.push(
          options.fiber.getRef(References.CurrentLogAnnotations).event
        );
      });

      const extra = yield* ExtraProviders.useSync(
        (providers) => providers
      ).pipe(
        Effect.provide(
          BridgeExtraProviders.pipe(
            Layer.provide(BridgeProvider.layer),
            Layer.provide(
              Layer.merge(
                ConfigProvider.layer(
                  ConfigProvider.fromEnvRecord({ CAIRN_BRIDGE: "of" })
                ),
                Logger.layer([capture], { mergeWithExisting: false })
              )
            )
          )
        )
      );

      assert.deepStrictEqual(extra, []);
      assert.include(events, "claude_bridge_flag_invalid");
    })
  );

  it.live("are the claude-bridge provider while it is on", () =>
    Effect.gen(function* () {
      const extra = yield* ExtraProviders;

      assert.deepStrictEqual(
        extra.map((provider) => provider.id),
        ["claude-bridge"]
      );
    }).pipe(
      Effect.provide(BridgeExtraProviders.pipe(Layer.provide(BridgeTest)))
    )
  );
});

describe("pi's model runtime with the bridge", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cairn-bridge-provider-"));
  const agentDir = path.join(root, "agent");
  const home = path.join(root, "home");
  const cwd = path.join(root, "cwd");
  const saved = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const dir of [agentDir, home, cwd]) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(path.join(agentDir, "settings.json"), "{}");

    for (const name of ["PI_OFFLINE", "HOME"]) {
      saved.set(name, process.env[name]);
    }

    process.env.PI_OFFLINE = "1";
    process.env.HOME = home;
  });

  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }

    rmSync(root, { recursive: true, force: true });
  });

  const layer = PiModelSource.layerNoDeps.pipe(
    Layer.provide(HarnessSettings.layerNoDeps),
    Layer.provide(
      Layer.suspend(() => PiConfig.layerWith({ agentDir, cwd, home }))
    ),
    Layer.provide(BridgeExtraProviders),
    Layer.provide(BridgeTest)
  );

  it.live(
    "registers Claude's models and gives each one D7's compaction override",
    () =>
      Effect.gen(function* () {
        const source = yield* PiModelSource;
        const models = yield* ModelSource;

        const catalog = yield* source.catalog({ bridgeEnabled: true });

        const claude = catalog.models
          .filter((model) => model.provider === "claude-bridge")
          .map((model) => model.modelId);

        assert.includeMembers(claude, [
          "claude-haiku-5-5",
          "claude-sonnet-5-5",
          "claude-opus-5-5",
        ]);
        assert.isTrue(
          catalog.models
            .filter((model) => model.provider === "claude-bridge")
            .every((model) => model.available),
          "an unknown login counts as available"
        );

        const overrides = models.settings().compaction?.modelOverrides ?? {};

        for (const id of claude) {
          assert.deepStrictEqual(
            overrides[`claude-bridge/${id}`],
            BRIDGE_COMPACTION,
            id
          );
        }
      }).pipe(Effect.provide(layer))
  );
});

describe("the usage feed", () => {
  it.effect(
    "says there are no providers while the bridge is off, and stays open",
    () =>
      Effect.gen(function* () {
        const feed = yield* UsageFeed;

        const first = yield* feed.snapshots.pipe(
          Stream.take(1),
          Stream.runCollect
        );

        assert.deepStrictEqual(first, [{ providers: [] }]);
      }).pipe(Effect.provide(UsageFeed.layer))
  );

  it.live("reports the bridge's plan windows while it is on", () =>
    Effect.gen(function* () {
      const bridge = yield* BridgeProvider;
      const feed = yield* UsageFeed;
      const usage = Option.getOrThrow(bridge.usage);

      yield* usage.observe({
        status: "allowed",
        resetsAt: 1_900_000_000,
        rateLimitType: "five_hour",
        utilization: 0.25,
      });

      const frame = yield* feed.snapshots.pipe(
        Stream.filter((snapshot) =>
          snapshot.providers.some((provider) => provider.windows.length > 0)
        ),
        Stream.take(1),
        Stream.runCollect
      );

      const windows = frame[0]?.providers.flatMap((provider) =>
        provider.windows.map((window) => [
          provider.provider,
          window.id,
          window.used,
        ])
      );

      assert.deepStrictEqual(windows, [
        ["claude-bridge", "five_hour", Option.some(0.25)],
      ]);
    }).pipe(
      Effect.provide(UsageFeed.layer.pipe(Layer.provideMerge(BridgeTest)))
    )
  );
});
