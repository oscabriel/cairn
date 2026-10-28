// Settings the server owns, so every device agrees.

import { Schema } from "effect";

import { NonNegativeInt, PositiveInt } from "./Ids.ts";
import { ModelRef } from "./Models.ts";
import { RoleTable } from "./Roles.ts";
import { Budget } from "./Spend.ts";

/** Server-owned settings. */
export const ServerSettings = Schema.Struct({
  /** Days of quiet after which a thread settles by itself; 0 turns auto-settle off. */
  autoSettleDays: NonNegativeInt.check(Schema.isLessThanOrEqualTo(365)),
  /** The cheap model that names threads and branches; none uses the first available small model. */
  titleModel: Schema.OptionFromNullOr(ModelRef),
  /** Whether Claude is offered through the bridge. */
  bridgeEnabled: Schema.Boolean,
  /** How many Claude children may generate at once. */
  bridgeGenerationCap: PositiveInt.check(Schema.isLessThanOrEqualTo(16)),
  /** The role table (ADR 0035): what `@worker`, `@scout`, `@judge` and `@verifier` run on. */
  roleBindings: RoleTable,
  /** The budget a brief or workflow launch starts from when it names none (ADR 0036). */
  defaultBudget: Budget,
});

export type ServerSettings = typeof ServerSettings.Type;

/** `settings.update` input: an absent key leaves that setting as it is. */
export const SettingsPatch = Schema.Struct({
  autoSettleDays: Schema.OptionFromOptionalKey(
    ServerSettings.fields.autoSettleDays
  ),
  titleModel: Schema.OptionFromOptionalKey(ServerSettings.fields.titleModel),
  bridgeEnabled: Schema.OptionFromOptionalKey(Schema.Boolean),
  bridgeGenerationCap: Schema.OptionFromOptionalKey(
    ServerSettings.fields.bridgeGenerationCap
  ),
  /** Replaces the whole table. */
  roleBindings: Schema.OptionFromOptionalKey(RoleTable),
  defaultBudget: Schema.OptionFromOptionalKey(Budget),
});

export type SettingsPatch = typeof SettingsPatch.Type;
