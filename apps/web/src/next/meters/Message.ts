// The meters' Messages: what the brain answered for each section, and the user's changes to the
// role table.

import { ModelCatalog } from "@cairn/protocol/Models";
import { RoleCheck, RoleName } from "@cairn/protocol/Roles";
import { ServerSettings } from "@cairn/protocol/Settings";
import { Spend } from "@cairn/protocol/Spend";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

/** The sections the meters ask the brain for. */
export const MetersSection = Schema.Literals([
  "spend",
  "server",
  "catalog",
  "checks",
]);

export type MetersSection = typeof MetersSection.Type;

/** Everything the meters react to. */
export const Message = defineMessageUnion({
  ReceivedSpend: { epoch: Schema.Int, spend: Spend },
  ReceivedServerSettings: { epoch: Schema.Int, settings: ServerSettings },
  ReceivedCatalog: { epoch: Schema.Int, catalog: ModelCatalog },
  ReceivedRoleChecks: { epoch: Schema.Int, checks: Schema.Array(RoleCheck) },
  /** A section's question failed; `section` names which. */
  FailedLoad: {
    epoch: Schema.Int,
    section: MetersSection,
    message: Schema.String,
  },
  /** Asks every section again after a failure. */
  ClickedRetry: {},

  /** The user picked another model for `role`; `value` is `provider/modelId`. */
  SelectedRoleModel: { role: RoleName, value: Schema.String },
  /** The user picked a thinking level for `role`; "" is the model's default. */
  SelectedRoleThinking: { role: RoleName, value: Schema.String },
  /** `settings.update` answered with the settings as they now are. */
  SavedRoleTable: { settings: ServerSettings },
  FailedRoleSave: { message: Schema.String },

  DismissedNotice: {},
});

/** A meters Message. */
export type Message = typeof Message.Type;
