// The model picker's view of the brain's model runtime: what is offered, the defaults, and whether
// each provider has a usable credential. Provider and model ids are pi-ai's (`anthropic`,
// `claude-bridge`, `opencode-go`, ...), passed through as strings.

import { Schema } from "effect";

import { DisplayText, NonNegativeInt, TrimmedNonEmptyString } from "./Ids.ts";

/** A thinking level, as pi-ai's `ModelThinkingLevel` names them. `off` disables reasoning. */
export const ThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type ThinkingLevel = typeof ThinkingLevel.Type;

/** A provider and one of its models, the pair a thread runs on. */
export const ModelRef = Schema.Struct({
  provider: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
});

export type ModelRef = typeof ModelRef.Type;

/** One model the picker may offer. */
export const ModelListing = Schema.Struct({
  provider: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
  name: DisplayText,
  /** The levels this model accepts; empty for a model without reasoning. */
  thinkingLevels: Schema.Array(ThinkingLevel),
  acceptsImages: Schema.Boolean,
  contextWindow: Schema.OptionFromNullOr(NonNegativeInt),
  /** False when its provider has no usable credential; the picker shows it disabled. */
  available: Schema.Boolean,
});

export type ModelListing = typeof ModelListing.Type;

/** The model and thinking level a new thread starts with. */
export const ModelDefaults = Schema.Struct({
  model: ModelRef,
  thinkingLevel: ThinkingLevel,
});

export type ModelDefaults = typeof ModelDefaults.Type;

/** What `models.list` answers. */
export const ModelCatalog = Schema.Struct({
  models: Schema.Array(ModelListing),
  defaults: ModelDefaults,
});

export type ModelCatalog = typeof ModelCatalog.Type;

/** Whether one provider can be used, and why not. Never carries a credential value. */
export const ProviderStatus = Schema.Struct({
  provider: TrimmedNonEmptyString,
  name: DisplayText,
  credential: Schema.Literals(["api-key", "subscription", "none"]),
  state: Schema.Literals(["ready", "missing", "refused", "unknown"]),
  /** A sentence for the settings page when the state is not `ready`. */
  detail: Schema.OptionFromNullOr(DisplayText),
});

export type ProviderStatus = typeof ProviderStatus.Type;

/** `providers.login.start`, `providers.login.cancel` and `providers.logout` input (ADR 0037). */
export const ProviderLoginInput = Schema.Struct({
  provider: TrimmedNonEmptyString,
});

export type ProviderLoginInput = typeof ProviderLoginInput.Type;

/** An https URL a login step hands to the user. */
const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\//u));

/**
 * One step of a provider login, streamed by `providers.login.start` until it ends: the device code
 * to enter (finishable from the phone), a browser URL, progress, then signed in or failed. Never
 * carries a credential value.
 */
export const LoginProgress = Schema.Union([
  Schema.TaggedStruct("DeviceCode", {
    userCode: TrimmedNonEmptyString,
    verificationUri: HttpsUrl,
    expiresInSeconds: NonNegativeInt,
  }),
  Schema.TaggedStruct("AuthUrl", { url: HttpsUrl }),
  Schema.TaggedStruct("Progress", { message: DisplayText }),
  Schema.TaggedStruct("SignedIn", {
    account: Schema.OptionFromNullOr(DisplayText),
  }),
  Schema.TaggedStruct("Failed", {
    reason: Schema.Literals(["expired", "cancelled", "refused", "unavailable"]),
    message: DisplayText,
  }),
]);

export type LoginProgress = typeof LoginProgress.Type;
