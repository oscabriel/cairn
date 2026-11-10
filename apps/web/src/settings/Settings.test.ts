// Scene tests for the settings page, plus the client settings' decoding: defaults for what is
// missing, and a corrupt saved value that leaves the page on its defaults instead of failing.

import { skillsPromptTokens } from "@cairn/client-logic/SkillsPrompt";
import { ProjectId } from "@cairn/protocol/Ids";
import type { ServerSettings } from "@cairn/protocol/Settings";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Option, Predicate } from "effect";
import { KeyValueStore } from "effect/persistence";
import * as AsyncData from "foldkit/asyncData";
import * as Scene from "foldkit/scene";

import { Message as ComposerMessage } from "../composer/Message.ts";
import { defaultSettings as defaultComposerSettings } from "../composer/Model.ts";
import { Message as RootMessage } from "../Message.ts";
import { liveModel } from "../TestFixtures.ts";
import { update as rootUpdate } from "../Update.ts";
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
import { view } from "./View.ts";

const projectId = ProjectId.make("prj_cairn");

const server: ServerSettings = {
  autoSettleDays: 7,
  titleModel: Option.none(),
  bridgeEnabled: true,
  bridgeGenerationCap: 4,
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
  isMac: false,
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

  it("keep the rest of a value saved before the cutover, with its retired `ui` key", () => {
    assert.strictEqual(
      parseClientSettings('{"ui":"classic","theme":"light"}').theme,
      "light"
    );
    assert.notProperty(parseClientSettings('{"ui":"next"}'), "ui");
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

const fromSettings = (message: Message) =>
  RootMessage.GotSettingsMessage({ message });

describe("the composer's send settings", () => {
  it("follow the Send shortcut and Follow-up behaviour chosen in Settings", () => {
    const withChoice = rootUpdate(
      liveModel(0),
      fromSettings(
        Message.LoadedClientSettings({
          settings: {
            ...DEFAULT_CLIENT_SETTINGS,
            sendShortcut: "mod-enter",
            followUpBehavior: "steer",
          },
        })
      )
    ).model;

    assert.strictEqual(withChoice.composer.settings.sendShortcut, "mod-enter");
    assert.strictEqual(withChoice.composer.settings.followUpBehavior, "steer");

    // The composer's own saved copy, answering late, does not undo the choice.
    const late = rootUpdate(
      withChoice,
      RootMessage.GotComposerMessage({
        message: ComposerMessage.LoadedSettings({
          settings: defaultComposerSettings,
        }),
      })
    ).model;

    assert.strictEqual(late.composer.settings.followUpBehavior, "steer");

    const chosen = rootUpdate(
      late,
      fromSettings(
        Message.SelectedClientSetting({
          key: "followUpBehavior",
          value: "queue",
        })
      )
    ).model;

    assert.strictEqual(chosen.composer.settings.followUpBehavior, "queue");
    assert.strictEqual(chosen.composer.settings.sendShortcut, "mod-enter");
  });
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
      Message.ReceivedServerSettings({ epoch: 2, request: 1, settings: server })
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

  // U-10 and ADR 0050: no view deletes a thread, draws the settled shelf or opens a diff, so their
  // settings are not offered; their stored values stay.
  it("hides the settings whose feature has no surface, keeping their stored values", () => {
    Scene.scene(
      config,
      Scene.given(loaded),
      Scene.expect(
        Scene.selector('[data-settings-row="confirm-delete"]')
      ).toBeAbsent(),
      Scene.expect(
        Scene.selector('[data-settings-row="auto-settle"]')
      ).toBeAbsent(),
      Scene.expect(
        Scene.selector('[data-settings-row="diff-layout"]')
      ).toBeAbsent(),
      Scene.expect(Scene.selector("#settings-auto-settle")).toBeAbsent(),
      Scene.expect(Scene.selector("#settings-theme")).toExist(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
    assert.isTrue(loaded.client.confirmThreadDelete);
    assert.strictEqual(loaded.client.diffLayout, "stacked");
  });

  // U-11: every key the shell answers is listed (`Keys.test.ts` holds that they are the only ones).
  it("lists the keys the shell answers in its Keyboard section", () => {
    Scene.scene(
      config,
      Scene.given(loaded),
      Scene.expect(Scene.testId("settings-section-keyboard")).toExist(),
      Scene.expect(
        Scene.selector('[data-settings-row="key-new-thread"]')
      ).toContainText("Ctrl+N"),
      Scene.expect(
        Scene.selector('[data-settings-row="key-previous-thread"]')
      ).toContainText("Ctrl+Shift+["),
      Scene.expect(
        Scene.selector('[data-settings-row="key-next-thread"]')
      ).toContainText("Ctrl+Shift+]"),
      Scene.expect(
        Scene.selector('[data-settings-row="key-scratch"]')
      ).toContainText("Ctrl+J"),
      Scene.expect(
        Scene.selector('[data-settings-row="key-close"]')
      ).toContainText("Esc"),
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
          request: 1,
          patch: {
            autoSettleDays: Option.none(),
            titleModel: Option.none(),
            bridgeEnabled: Option.some(false),
            bridgeGenerationCap: Option.none(),
            defaultBudget: Option.none(),
          },
        }),
        Message.SucceededServerUpdate({ request: 1, settings: off })
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

const skillsOf = (name: string) => ({
  skills: [
    {
      name,
      description: `${name}'s skill.`,
      source: "project" as const,
      modelInvocable: true,
    },
  ],
});

type SettingsCommand = NonNullable<
  ReturnType<typeof update>["commands"]
>[number];

/** Runs messages through `update`, keeping every step's commands. */
const run = (model: Model, ...messages: ReadonlyArray<Message>) => {
  let current = model;

  const commands: Array<SettingsCommand> = [];

  for (const message of messages) {
    const next = update(current, message);

    current = next.model;

    for (const command of next.commands ?? []) {
      commands.push(command);
    }
  }

  return { model: current, commands };
};

describe("the settings page's stale answers", () => {
  const otherId = ProjectId.make("prj_myr");

  const twoProjects: Model = {
    ...loaded,
    context: {
      ...loaded.context,
      projects: [...loaded.context.projects, { id: otherId, title: "myr" }],
    },
  };

  it("keeps the selected project's skills when a slower answer for the previous one lands last", () => {
    const asked = run(
      twoProjects,
      Message.ClickedReloadSkills(),
      Message.SelectedSkillsProject({ value: otherId })
    );

    const [reloadA, listB] = asked.commands.filter(
      (command) => command.name === FetchSkills.name
    );

    assert.deepStrictEqual(
      [reloadA?.args?.projectId, listB?.args?.projectId],
      [projectId, otherId]
    );

    const answered = run(
      asked.model,
      Message.ReceivedSkills({
        epoch: 3,
        projectId: otherId,
        skills: skillsOf("myr-only"),
      }),
      Message.ReceivedSkills({
        epoch: 3,
        projectId,
        skills: skillsOf("cairn-only"),
      }),
      Message.FailedSkills({
        epoch: 3,
        projectId,
        message: "The skills could not be read.",
      })
    ).model;

    assert.deepStrictEqual(
      Option.map(AsyncData.getData(answered.skills), (list) =>
        list.skills.map((skill) => skill.name)
      ),
      Option.some(["myr-only"]),
      "the previous project's skills replaced the selected one's"
    );
  });

  it("shows the settings of the newest change when an older change's answer lands last", () => {
    const changed = run(
      loaded,
      Message.SelectedAutoSettleDays({ value: "14" }),
      Message.ToggledBridge({ isChecked: false })
    );

    const requests = changed.commands
      .filter((command) => command.name === UpdateServerSettings.name)
      .flatMap((command) => {
        const request = command.args?.request;

        return Predicate.isNumber(request) ? [request] : [];
      });

    assert.lengthOf(requests, 2);

    const [first = 0, second = 0] = requests;
    const both = { ...server, autoSettleDays: 14, bridgeEnabled: false };
    const firstOnly = { ...server, autoSettleDays: 14 };

    const answered = run(
      changed.model,
      Message.SucceededServerUpdate({ request: second, settings: both }),
      Message.SucceededServerUpdate({ request: first, settings: firstOnly })
    ).model;

    assert.deepStrictEqual(
      AsyncData.getData(answered.server),
      Option.some(both),
      "the older change's answer replaced the newer one's"
    );
  });

  it("keeps a change's answer when the page's first read of the settings lands after it", () => {
    const opened = inform(
      { ...initial, clientLoaded: true },
      {
        epoch: 3,
        hasClient: true,
        isOpen: true,
        projects: [{ id: projectId, title: "cairn" }],
      }
    );

    const [read = 0] = (opened.commands ?? [])
      .filter((command) => command.name === FetchServerSettings.name)
      .flatMap((command) => {
        const request = command.args?.request;

        return Predicate.isNumber(request) ? [request] : [];
      });

    const off = { ...server, bridgeEnabled: false };

    const changed = run(
      opened.model,
      Message.ToggledBridge({ isChecked: false })
    );

    const [request = 0] = changed.commands
      .filter((command) => command.name === UpdateServerSettings.name)
      .flatMap((command) => {
        const asked = command.args?.request;

        return Predicate.isNumber(asked) ? [asked] : [];
      });

    const answered = run(
      changed.model,
      Message.SucceededServerUpdate({ request, settings: off }),
      Message.ReceivedServerSettings({
        epoch: 3,
        request: read,
        settings: server,
      })
    ).model;

    assert.deepStrictEqual(
      AsyncData.getData(answered.server),
      Option.some(off)
    );
  });

  it("keeps a change's answer when a read asked after it, on coming back to the page, lands first", () => {
    const context = {
      epoch: 3,
      hasClient: true,
      isOpen: true,
      projects: [{ id: projectId, title: "cairn" }],
    };

    const opened = inform({ ...initial, clientLoaded: true }, context);

    const shown = run(
      opened.model,
      Message.ReceivedServerSettings({ epoch: 3, request: 1, settings: server })
    ).model;

    const off = { ...server, bridgeEnabled: false };

    const changed = run(shown, Message.ToggledBridge({ isChecked: false }));

    const [request = 0] = changed.commands
      .filter((command) => command.name === UpdateServerSettings.name)
      .flatMap((command) => {
        const asked = command.args?.request;

        return Predicate.isNumber(asked) ? [asked] : [];
      });

    // The user leaves and comes back while the change is in flight, which asks a new read.
    const left = inform(changed.model, { ...context, isOpen: false }).model;
    const back = inform(left, context);

    const [read = 0] = (back.commands ?? [])
      .filter((command) => command.name === FetchServerSettings.name)
      .flatMap((command) => {
        const asked = command.args?.request;

        return Predicate.isNumber(asked) ? [asked] : [];
      });

    assert.isAbove(read, request);

    // The read was answered before the brain applied the change, and lands first.
    const answered = run(
      back.model,
      Message.ReceivedServerSettings({
        epoch: 3,
        request: read,
        settings: server,
      }),
      Message.SucceededServerUpdate({ request, settings: off })
    ).model;

    assert.deepStrictEqual(
      AsyncData.getData(answered.server),
      Option.some(off)
    );
  });
});
