// Settings the server owns, so every device agrees.
import { Schema } from "effect";

import { NonNegativeInt, PositiveInt } from "./Ids.ts";
import { ModelRef } from "./Models.ts";

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
});

export type SettingsPatch = typeof SettingsPatch.Type;
