// The settings page's Messages: what the user changed, what the brain answered, and the plan
// windows' stream.
import { ExecutorStatus } from "@cairn/protocol/Executor";
import { ModelCatalog, ProviderStatus } from "@cairn/protocol/Models";
import { ServerSettings } from "@cairn/protocol/Settings";
import { SkillList } from "@cairn/protocol/Skills";
import { UsageSnapshot } from "@cairn/protocol/Usage";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import {
  BooleanSettingKey,
  ChoiceSettingKey,
  ClientSettings,
} from "./ClientSettings.ts";

/** Everything the settings page reacts to. */
export const Message = defineMessageUnion({
  /** This device's settings were read from storage. */
  LoadedClientSettings: { settings: ClientSettings },
  /** The appearance settings were written onto the document. */
  AppliedClientSettings: {},
  /** Saving this device's settings finished; false when storage refused them. */
  SavedClientSettings: { saved: Schema.Boolean },
  ToggledClientSetting: { key: BooleanSettingKey, isChecked: Schema.Boolean },
  SelectedClientSetting: { key: ChoiceSettingKey, value: Schema.String },
  /** The device switched between light and dark while the theme follows it. */
  ChangedColorScheme: {},

  /** One section's answer for `epoch`. */
  ReceivedServerSettings: { epoch: Schema.Int, settings: ServerSettings },
  ReceivedCatalog: { epoch: Schema.Int, catalog: ModelCatalog },
  ReceivedProviders: {
    epoch: Schema.Int,
    providers: Schema.Array(ProviderStatus),
  },
  ReceivedExecutorStatus: { epoch: Schema.Int, status: ExecutorStatus },
  ReceivedSkills: { epoch: Schema.Int, skills: SkillList },
  /** A section's question failed; `section` names which. */
  FailedLoad: {
    epoch: Schema.Int,
    section: Schema.Literals([
      "server",
      "catalog",
      "providers",
      "executor",
      "skills",
    ]),
    message: Schema.String,
  },

  SelectedAutoSettleDays: { value: Schema.String },
  SelectedTitleModel: { value: Schema.String },
  ToggledBridge: { isChecked: Schema.Boolean },
  SelectedGenerationCap: { value: Schema.String },
  /** `settings.update` answered with the settings as they now are. */
  SucceededServerUpdate: { settings: ServerSettings },
  FailedServerUpdate: { message: Schema.String },

  SelectedSkillsProject: { value: Schema.String },
  ClickedReloadSkills: {},

  ClickedSignIn: {},
  /** The browser left for Executor's sign-in page. */
  OpenedSignIn: {},
  FailedSignIn: { message: Schema.String },

  /** A frame of plan windows. */
  ReceivedUsage: { usage: UsageSnapshot },

  DismissedNotice: {},
});

/** A settings page Message. */
export type Message = typeof Message.Type;
