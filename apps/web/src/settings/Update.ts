// The settings page's update. This device's settings are read once per load, applied to the
// document and saved on every change. The brain is asked for each section when the page opens on a
// client, and again on a new epoch; answers from another epoch are dropped. Server settings change
// through `settings.update`, and the page shows what the brain answered rather than what was asked.

import { ProjectId } from "@cairn/protocol/Ids";
import type { ModelRef } from "@cairn/protocol/Models";
import { ServerSettings } from "@cairn/protocol/Settings";
import type { SettingsPatch } from "@cairn/protocol/Settings";
import { Array, Equal, Match, Option, Schema } from "effect";
import type { Update } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import { modifyFields } from "foldkit/struct";

import { chooseSetting, toggleSetting } from "./ClientSettings.ts";
import type { ClientSettings } from "./ClientSettings.ts";
import {
  ApplyClientSettings,
  FetchCatalog,
  FetchExecutorStatus,
  FetchProviders,
  FetchServerSettings,
  FetchSkills,
  LoadClientSettings,
  SaveClientSettings,
  SignInExecutor,
  UpdateServerSettings,
} from "./Command.ts";
import type { Services } from "./Command.ts";
import { Message } from "./Message.ts";
import { initial } from "./Model.ts";
import type { Model, SettingsContext } from "./Model.ts";

type UpdateReturn = Update.Return<Model, Message, Services>;

/** The page at load: it reads this device's settings, which then apply to the document. */
export const init = (): UpdateReturn => ({
  model: initial,
  commands: [LoadClientSettings()],
});

/** The section state to show while asking again: kept data stays on screen. */
const reloading = <A>(
  data: AsyncData.AsyncData<A, string>
): AsyncData.AsyncData<A, string> =>
  Option.getOrElse(AsyncData.revalidateOrLoad(data), () => data);

/** The skills project: the user's pick while it still exists, else the first project. */
const pickSkillsProject = (
  current: Option.Option<ProjectId>,
  context: SettingsContext
): Option.Option<ProjectId> =>
  Option.orElse(
    Option.filter(current, (id) =>
      context.projects.some((project) => project.id === id)
    ),
    () => Option.map(Array.head(context.projects), (project) => project.id)
  );

const canAsk = (model: Model): boolean =>
  model.context.isOpen && model.context.hasClient;

const skillsCommands = (model: Model, reload: boolean) =>
  Option.match(model.skillsProject, {
    onNone: () => [],
    onSome: (projectId) => [
      FetchSkills({ epoch: model.context.epoch, projectId, reload }),
    ],
  });

/** Asks the brain for every section of the page. */
const loadSections = (model: Model): UpdateReturn => ({
  model: modifyFields(model, {
    loadedEpoch: () => Option.some(model.context.epoch),
    server: reloading,
    catalog: reloading,
    providers: reloading,
    executor: reloading,
    skills: (skills) =>
      Option.isSome(model.skillsProject) ? reloading(skills) : skills,
  }),
  commands: [
    FetchServerSettings({ epoch: model.context.epoch }),
    FetchCatalog({ epoch: model.context.epoch }),
    FetchProviders({ epoch: model.context.epoch }),
    FetchExecutorStatus({ epoch: model.context.epoch }),
    ...skillsCommands(model, false),
  ],
});

/** Takes the root's context; an opened page, a new epoch or a new skills project asks the brain. */
export const inform = (
  model: Model,
  context: SettingsContext
): UpdateReturn => {
  const skillsProject = pickSkillsProject(model.skillsProject, context);

  const next = modifyFields(model, {
    context: () => context,
    skillsProject: () => skillsProject,
    // Leaving the page forgets the epoch, so coming back asks again.
    loadedEpoch: (loaded) => (context.isOpen ? loaded : Option.none()),
  });

  if (!canAsk(next)) {
    return { model: next };
  }

  if (!Option.contains(next.loadedEpoch, context.epoch)) {
    return loadSections(next);
  }

  if (!Equal.equals(skillsProject, model.skillsProject)) {
    return {
      model: modifyFields(next, { skills: reloading }),
      commands: skillsCommands(next, false),
    };
  }

  return { model: next };
};

/** Applies and saves `settings` when they differ from what the page holds. */
const changeClient = (model: Model, settings: ClientSettings): UpdateReturn =>
  Equal.equals(settings, model.client)
    ? { model }
    : {
        model: modifyFields(model, { client: () => settings }),
        commands: [
          ApplyClientSettings({ settings }),
          SaveClientSettings({ settings }),
        ],
      };

const NO_CHANGE: SettingsPatch = {
  autoSettleDays: Option.none(),
  titleModel: Option.none(),
  bridgeEnabled: Option.none(),
  bridgeGenerationCap: Option.none(),
  roleBindings: Option.none(),
  defaultBudget: Option.none(),
};

const sendPatch = (model: Model, patch: SettingsPatch): UpdateReturn => ({
  model: modifyFields(model, { notice: () => Option.none() }),
  commands: [UpdateServerSettings({ patch })],
});

const decodeAutoSettleDays = Schema.decodeUnknownOption(
  Schema.FiniteFromString.pipe(
    Schema.decodeTo(ServerSettings.fields.autoSettleDays)
  )
);

const decodeGenerationCap = Schema.decodeUnknownOption(
  Schema.FiniteFromString.pipe(
    Schema.decodeTo(ServerSettings.fields.bridgeGenerationCap)
  )
);

const decodeProjectId = Schema.decodeUnknownOption(ProjectId);

/** The select value that names a model; the same text the view writes. */
export const modelValue = (model: ModelRef): string =>
  `${model.provider}/${model.modelId}`;

/** The model a title-model select value names, among the listed models. */
const titleModelOf = (model: Model, value: string): Option.Option<ModelRef> =>
  Option.flatMap(AsyncData.getData(model.catalog), (catalog) =>
    Option.map(
      Array.findFirst(
        catalog.models,
        (listing) => modelValue(listing) === value
      ),
      (listing): ModelRef => ({
        provider: listing.provider,
        modelId: listing.modelId,
      })
    )
  );

/** The answer for `epoch`, written when it is still the page's epoch. */
const answer = (
  model: Model,
  epoch: number,
  write: (model: Model) => Model
): UpdateReturn => ({
  model: epoch === model.context.epoch ? write(model) : model,
});

/** The settings page's update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    LoadedClientSettings: ({ settings }) => ({
      model: modifyFields(model, {
        client: () => settings,
        clientLoaded: () => true,
      }),
      commands: [ApplyClientSettings({ settings })],
    }),
    AppliedClientSettings: () => ({ model }),
    SavedClientSettings: ({ saved }) => ({
      model: saved
        ? model
        : modifyFields(model, {
            notice: () =>
              Option.some(
                "This device would not keep the setting, so it lasts until the page reloads."
              ),
          }),
    }),
    ToggledClientSetting: ({ isChecked, key }) =>
      changeClient(model, toggleSetting(model.client, key, isChecked)),
    SelectedClientSetting: ({ key, value }) =>
      Option.match(chooseSetting(model.client, key, value), {
        onNone: () => ({ model }),
        onSome: (settings) => changeClient(model, settings),
      }),
    ChangedColorScheme: () => ({
      model,
      commands:
        model.client.theme === "system"
          ? [ApplyClientSettings({ settings: model.client })]
          : [],
    }),

    ReceivedServerSettings: ({ epoch, settings }) =>
      answer(model, epoch, (current) =>
        modifyFields(current, { server: () => AsyncData.succeed(settings) })
      ),
    ReceivedCatalog: ({ catalog, epoch }) =>
      answer(model, epoch, (current) =>
        modifyFields(current, { catalog: () => AsyncData.succeed(catalog) })
      ),
    ReceivedProviders: ({ epoch, providers }) =>
      answer(model, epoch, (current) =>
        modifyFields(current, {
          providers: () => AsyncData.succeed(providers),
        })
      ),
    ReceivedExecutorStatus: ({ epoch, status }) =>
      answer(model, epoch, (current) =>
        modifyFields(current, { executor: () => AsyncData.succeed(status) })
      ),
    ReceivedSkills: ({ epoch, skills }) =>
      answer(model, epoch, (current) =>
        modifyFields(current, { skills: () => AsyncData.succeed(skills) })
      ),
    FailedLoad: ({ epoch, message: text, section }) =>
      answer(model, epoch, (current) => {
        const failed = AsyncData.fail(text);

        return Match.value(section).pipe(
          Match.when("server", () =>
            modifyFields(current, { server: () => failed })
          ),
          Match.when("catalog", () =>
            modifyFields(current, { catalog: () => failed })
          ),
          Match.when("providers", () =>
            modifyFields(current, { providers: () => failed })
          ),
          Match.when("executor", () =>
            modifyFields(current, { executor: () => failed })
          ),
          Match.when("skills", () =>
            modifyFields(current, { skills: () => failed })
          ),
          Match.exhaustive
        );
      }),

    SelectedAutoSettleDays: ({ value }) =>
      Option.match(decodeAutoSettleDays(value), {
        onNone: () => ({ model }),
        onSome: (days) =>
          sendPatch(model, {
            ...NO_CHANGE,
            autoSettleDays: Option.some(days),
          }),
      }),
    SelectedTitleModel: ({ value }) =>
      value === ""
        ? sendPatch(model, {
            ...NO_CHANGE,
            titleModel: Option.some(Option.none()),
          })
        : Option.match(titleModelOf(model, value), {
            onNone: () => ({ model }),
            onSome: (ref) =>
              sendPatch(model, {
                ...NO_CHANGE,
                titleModel: Option.some(Option.some(ref)),
              }),
          }),
    ToggledBridge: ({ isChecked }) =>
      sendPatch(model, { ...NO_CHANGE, bridgeEnabled: Option.some(isChecked) }),
    SelectedGenerationCap: ({ value }) =>
      Option.match(decodeGenerationCap(value), {
        onNone: () => ({ model }),
        onSome: (cap) =>
          sendPatch(model, {
            ...NO_CHANGE,
            bridgeGenerationCap: Option.some(cap),
          }),
      }),
    SucceededServerUpdate: ({ settings }) => ({
      model: modifyFields(model, { server: () => AsyncData.succeed(settings) }),
    }),
    FailedServerUpdate: ({ message: text }) => ({
      model: modifyFields(model, { notice: () => Option.some(text) }),
    }),

    SelectedSkillsProject: ({ value }) =>
      Option.match(
        Option.filter(decodeProjectId(value), (id) =>
          model.context.projects.some((project) => project.id === id)
        ),
        {
          onNone: () => ({ model }),
          onSome: (projectId) => {
            const next = modifyFields(model, {
              skillsProject: () => Option.some(projectId),
              skills: reloading,
            });

            return {
              model: next,
              commands: canAsk(next) ? skillsCommands(next, false) : [],
            };
          },
        }
      ),
    ClickedReloadSkills: () => ({
      model: modifyFields(model, { skills: reloading }),
      commands: model.context.hasClient ? skillsCommands(model, true) : [],
    }),

    ClickedSignIn: () => ({
      model: modifyFields(model, { notice: () => Option.none() }),
      commands: [SignInExecutor()],
    }),
    OpenedSignIn: () => ({ model }),
    FailedSignIn: ({ message: text }) => ({
      model: modifyFields(model, { notice: () => Option.some(text) }),
    }),

    ReceivedUsage: ({ usage }) => ({
      model: modifyFields(model, { usage: () => Option.some(usage) }),
    }),

    DismissedNotice: () => ({
      model: modifyFields(model, { notice: () => Option.none() }),
    }),
  });
