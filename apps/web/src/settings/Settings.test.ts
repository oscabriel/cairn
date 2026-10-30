// Scene tests for the settings page, plus the client settings' decoding: defaults for what is
// missing, and a corrupt saved value that leaves the page on its defaults instead of failing.

import { ProjectId } from "@cairn/protocol/Ids";
import { DEFAULT_ROLE_TABLE } from "@cairn/protocol/Roles";
import type { ServerSettings } from "@cairn/protocol/Settings";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import { KeyValueStore } from "effect/persistence";
import * as AsyncData from "foldkit/asyncData";
import * as Scene from "foldkit/scene";

import { leadingWindow, usageMeterView } from "../composer/UsageMeter.ts";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  DEFAULT_CLIENT_SETTINGS,
  loadClientSettings,
  parseClientSettings,
} from "./ClientSettings.ts";
import {
  ApplyClientSettings,
  FetchCatalog,
  FetchExecutorStatus,
  FetchProviders,
  FetchServerSettings,
  FetchSkills,
  SaveClientSettings,
  UpdateServerSettings,
} from "./Command.ts";
import { Message } from "./Message.ts";
import { initial } from "./Model.ts";
import type { Model } from "./Model.ts";
import { inform, update } from "./Update.ts";
import { skillsPromptTokens, view } from "./View.ts";

const projectId = ProjectId.make("prj_cairn");

const server: ServerSettings = {
  autoSettleDays: 7,
  titleModel: Option.none(),
  bridgeEnabled: true,
  bridgeGenerationCap: 4,
  roleBindings: DEFAULT_ROLE_TABLE,
  defaultBudget: DEFAULT_BUDGET,
};

const resetAt = DateTime.makeUnsafe("2026-10-22T15:00:00Z");

/** An open page on epoch 3 whose sections all answered. */
const loaded: Model = {
  ...initial,
  context: {
    epoch: 3,
    hasClient: true,
    isOpen: true,
    projects: [{ id: projectId, title: "cairn" }],
  },
  loadedEpoch: Option.some(3),
  clientLoaded: true,
  server: AsyncData.succeed(server),
  catalog: AsyncData.succeed({
    models: [
      {
        provider: "claude-bridge",
        modelId: "claude-haiku-5-5",
        name: "Claude Haiku 5.5",
        thinkingLevels: ["off", "high"],
        acceptsImages: true,
        contextWindow: Option.some(200_000),
        available: true,
      },
    ],
    defaults: {
      model: { provider: "claude-bridge", modelId: "claude-haiku-5-5" },
      thinkingLevel: "medium",
    },
  }),
  providers: AsyncData.succeed([
    {
      provider: "claude-bridge",
      name: "Claude",
      credential: "subscription",
      state: "ready",
      detail: Option.none(),
    },
    {
      provider: "openai-codex",
      name: "OpenAI Codex",
      credential: "none",
      state: "missing",
      detail: Option.some("No credential in pi's auth.json."),
    },
  ]),
  executor: AsyncData.succeed({
    state: "needs-sign-in",
    detail: Option.some("Executor asked Cairn to sign in again."),
    checkedAt: Option.none(),
  }),
  skillsProject: Option.some(projectId),
  skills: AsyncData.succeed({
    skills: [
      {
        name: "tdd",
        description: "Test-driven development.",
        source: "user",
        modelInvocable: true,
      },
      {
        name: "deploy",
        description: "Deploys the app.",
        source: "project",
        modelInvocable: false,
      },
    ],
  }),
  usage: Option.some({
    providers: [
      {
        provider: "claude-bridge",
        reading: "read",
        windows: [
          {
            id: "five_hour",
            label: "Session",
            used: Option.some(0.42),
            resetsAt: Option.some(resetAt),
            exhausted: false,
          },
          {
            id: "seven_day",
            label: "Weekly",
            used: Option.none(),
            resetsAt: Option.none(),
            exhausted: false,
          },
        ],
        checkedAt: Option.none(),
      },
    ],
  }),
};

const sceneView = Scene.withViewInputs(view, {
  notifications: () => null,
  roleTable: () => null,
});

const config = { update, view: sceneView() };

describe("client settings", () => {
  it("decode missing keys to their defaults", () => {
    const settings = parseClientSettings('{"theme":"light"}');

    assert.strictEqual(settings.theme, "light");
    assert.deepStrictEqual(
      { ...settings, theme: DEFAULT_CLIENT_SETTINGS.theme },
      DEFAULT_CLIENT_SETTINGS
    );
    assert.strictEqual(DEFAULT_CLIENT_SETTINGS.sendShortcut, "enter");
    assert.strictEqual(DEFAULT_CLIENT_SETTINGS.fontSizeInterface, 16);
    assert.strictEqual(DEFAULT_CLIENT_SETTINGS.confirmThreadDelete, true);
  });

  it("survive a corrupt saved value", () => {
    assert.deepStrictEqual(
      parseClientSettings("{not json"),
      DEFAULT_CLIENT_SETTINGS
    );
    assert.deepStrictEqual(
      parseClientSettings('"a string"'),
      DEFAULT_CLIENT_SETTINGS
    );
    assert.deepStrictEqual(
      parseClientSettings('{"fontSizeInterface":99,"theme":"sepia"}'),
      DEFAULT_CLIENT_SETTINGS
    );
  });

  it.effect("load as defaults when localStorage holds garbage", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;

      yield* store.set(CLIENT_SETTINGS_STORAGE_KEY, "\u0000garbage");

      const settings = yield* loadClientSettings;

      assert.deepStrictEqual(settings, DEFAULT_CLIENT_SETTINGS);
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

describe("the settings page", () => {
  it("asks the brain for every section when it opens on a client", () => {
    const result = inform(
      { ...initial, clientLoaded: true },
      {
        epoch: 2,
        hasClient: true,
        isOpen: true,
        projects: [{ id: projectId, title: "cairn" }],
      }
    );

    assert.deepStrictEqual(
      (result.commands ?? []).map((command) => command.name).toSorted(),
      [
        FetchCatalog.name,
        FetchExecutorStatus.name,
        FetchProviders.name,
        FetchServerSettings.name,
        FetchSkills.name,
      ].toSorted()
    );
    assert.isTrue(Option.contains(result.model.loadedEpoch, 2));
    assert.isTrue(Option.contains(result.model.skillsProject, projectId));
  });

  it("drops an answer from another epoch", () => {
    const result = update(
      { ...loaded, server: AsyncData.Loading() },
      Message.ReceivedServerSettings({ epoch: 2, settings: server })
    );

    assert.isTrue(AsyncData.isLoading(result.model.server));
  });

  it("applies and saves a theme the user picks", () => {
    const light = { ...DEFAULT_CLIENT_SETTINGS, theme: "light" as const };

    Scene.scene(
      config,
      Scene.given(loaded),
      Scene.change(Scene.selector("#settings-theme"), "light"),
      Scene.Command.resolve(
        ApplyClientSettings({ settings: light }),
        Message.AppliedClientSettings()
      ),
      Scene.Command.resolve(
        SaveClientSettings({ settings: light }),
        Message.SavedClientSettings({ saved: true })
      ),
      Scene.expect(Scene.selector("#settings-theme")).toHaveValue("light"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("shows providers, plan windows, skills and Executor from the brain's answers", () => {
    Scene.scene(
      config,
      Scene.given(loaded),
      Scene.expect(Scene.testId("provider-state-claude-bridge")).toHaveText(
        "Ready"
      ),
      Scene.expect(Scene.testId("provider-state-openai-codex")).toHaveText(
        "No credential"
      ),
      Scene.expect(Scene.testId("plan-window-five_hour")).toContainText(
        "42% used"
      ),
      Scene.expect(Scene.testId("plan-window-seven_day")).toContainText(
        "unknown used"
      ),
      Scene.expect(
        Scene.selector('[data-settings-row="skills-count"]')
      ).toContainText("2 skills, 1 in the model's prompt"),
      Scene.expect(Scene.testId("executor-state")).toHaveText("Needs sign-in"),
      Scene.expect(Scene.testId("settings-model-list")).toContainText(
        "claude-bridge/claude-haiku-5-5"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("turns the Claude bridge off through settings.update and shows the answer", () => {
    const off = { ...server, bridgeEnabled: false };

    Scene.scene(
      config,
      Scene.given(loaded),
      Scene.click(
        Scene.role("switch", { name: "Claude through the subscription" })
      ),
      Scene.Command.resolve(
        UpdateServerSettings({
          patch: {
            autoSettleDays: Option.none(),
            titleModel: Option.none(),
            bridgeEnabled: Option.some(false),
            bridgeGenerationCap: Option.none(),
            roleBindings: Option.none(),
            defaultBudget: Option.none(),
          },
        }),
        Message.SucceededServerUpdate({ settings: off })
      ),
      Scene.expect(
        Scene.role("switch", { name: "Claude through the subscription" })
      ).toHaveAttr("aria-checked", "false"),
      Scene.expect(Scene.selector("#settings-bridge-cap")).toBeDisabled(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("estimates the skills' prompt from the invocable ones only", () => {
    assert.strictEqual(skillsPromptTokens([]), 0);
    assert.isAbove(
      skillsPromptTokens([
        { name: "a", description: "b", source: "user", modelInvocable: true },
      ]),
      100
    );
  });
});

describe("the composer usage meter", () => {
  it("leads with the window nearest its limit and reads unknown, never 0%", () => {
    const { usage } = loaded;

    assert.isTrue(
      Option.exists(
        leadingWindow({ usage, provider: "claude-bridge" }),
        (window) => window.id === "five_hour"
      )
    );
    assert.isTrue(
      Option.isNone(leadingWindow({ usage, provider: "opencode-go" }))
    );

    const unknownOnly = Option.some({
      providers: [
        {
          provider: "claude-bridge",
          reading: "read" as const,
          windows: [
            {
              id: "seven_day",
              label: "Weekly",
              used: Option.none(),
              resetsAt: Option.none(),
              exhausted: false,
            },
          ],
          checkedAt: Option.none(),
        },
      ],
    });

    Scene.scene(
      {
        update: (model: number) => ({ model }),
        view: (_model: number, h) =>
          usageMeterView(h, { usage: unknownOnly, provider: "claude-bridge" }),
      },
      Scene.given(0),
      Scene.expect(Scene.testId("composer-usage-meter")).toHaveText(
        "Weekly unknown"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
