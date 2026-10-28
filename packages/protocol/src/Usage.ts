// Plan windows and provider usage, for `usage.subscribe`. An unknown value is reported as unknown,
// never as zero: a meter that reads 0% when the probe failed would invite the wrong decision.

import { Schema } from "effect";

import { DisplayText, TrimmedNonEmptyString } from "./Ids.ts";

/** A fraction of a plan window used, from 0 to 1, or unknown. */
export const UsedFraction = Schema.OptionFromNullOr(
  Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
);

/** One rate-limit window of a subscription plan (five hours, seven days, ...). */
export const PlanWindow = Schema.Struct({
  /** A stable key such as `five_hour` or `seven_day_opus`. */
  id: TrimmedNonEmptyString,
  label: DisplayText,
  used: UsedFraction,
  resetsAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  /** True once the provider refused a request because this window is spent. */
  exhausted: Schema.Boolean,
});

export type PlanWindow = typeof PlanWindow.Type;

/**
 * Whether a provider's windows could be read, so an empty `windows` list stops meaning two things:
 * `unreadable` when the probe failed or the response changed shape, `unsupported` when the
 * provider has no readable windows (OpenCode Go).
 */
export const UsageReading = Schema.Literals([
  "read",
  "unreadable",
  "unsupported",
]);

export type UsageReading = typeof UsageReading.Type;

/** Usage of one provider. */
export const ProviderUsage = Schema.Struct({
  provider: TrimmedNonEmptyString,
  reading: UsageReading,
  windows: Schema.Array(PlanWindow),
  checkedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
});

export type ProviderUsage = typeof ProviderUsage.Type;

/** One frame of `usage.subscribe`: every provider's usage, replaced whole. */
export const UsageSnapshot = Schema.Struct({
  providers: Schema.Array(ProviderUsage),
});

export type UsageSnapshot = typeof UsageSnapshot.Type;
