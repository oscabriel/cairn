// Role aliases (ADR 0035): briefs, workflow scripts and recipes name a role (`@worker`), never a
// model, and the commit that dispatches a child resolves it to a concrete model the child keeps for
// life. The table is a server setting; `roles.check` previews a resolution for the brief card.
// Shapes from docs/phase-2/notes/models.md, section 1.

import { Schema } from "effect";

import { DisplayText, TrimmedNonEmptyString } from "./Ids.ts";
import { ModelRef, ThinkingLevel } from "./Models.ts";

/** A role alias: `@` and 1 to 24 of `[a-z0-9-]`. */
export const RoleName = Schema.String.check(
  Schema.isPattern(/^@[a-z0-9-]{1,24}$/u)
).pipe(Schema.brand("RoleName"));

export type RoleName = typeof RoleName.Type;

/** The roles that always exist. `@verifier` drives a verification recipe from phase 4 on. */
export const BUILT_IN_ROLES = ["@worker", "@scout", "@judge", "@verifier"];

/**
 * What a tool or script passes where a model goes: `@worker`, `@worker:high`, or a literal
 * `provider/modelId[:level]`. Parsed by one function in the brain; an alias never names an alias.
 */
export const RoleSpec = Schema.String.check(
  Schema.isPattern(
    /^(?:@[a-z0-9-]{1,24}|[A-Za-z0-9._-]+\/[A-Za-z0-9._:/@-]+?)(?::(?:off|minimal|low|medium|high|xhigh|max))?$/u
  )
).pipe(Schema.brand("RoleSpec"));

export type RoleSpec = typeof RoleSpec.Type;

/** What one role points to: a model, its thinking level, the fallbacks tried at dispatch. */
export const RoleBinding = Schema.Struct({
  model: ModelRef,
  /** None uses the model's default level. */
  thinkingLevel: Schema.OptionFromNullOr(ThinkingLevel),
  /** Tried in order at dispatch only, never mid-run. */
  fallbacks: Schema.Array(ModelRef).check(Schema.isMaxLength(4)),
  note: Schema.OptionFromNullOr(DisplayText),
});

export type RoleBinding = typeof RoleBinding.Type;

/**
 * A binding as a document carries it, plain JSON with `null` for an absent value: a workflow
 * launch's per-launch overrides (ADR 0035) live in the frozen payload and in the answer to it.
 */
export const RoleBindingJson = Schema.Struct({
  model: ModelRef,
  thinkingLevel: Schema.NullOr(ThinkingLevel),
  fallbacks: Schema.Array(ModelRef).check(Schema.isMaxLength(4)),
  note: Schema.NullOr(DisplayText),
});

export type RoleBindingJson = typeof RoleBindingJson.Type;

/**
 * Per-launch role overrides: role name to the binding this launch uses instead of the global
 * table's. Roles it does not name resolve through the table as usual.
 */
export const RoleOverrides = Schema.Record(RoleName, RoleBindingJson);

export type RoleOverrides = typeof RoleOverrides.Type;

/** The role table, global (ADR 0035): role name to binding. */
export const RoleTable = Schema.Record(RoleName, RoleBinding);

export type RoleTable = typeof RoleTable.Type;

/** A model family, for the rule that a judge or verifier is not the worker's family. */
export const ModelFamily = Schema.Literals([
  "anthropic",
  "openai",
  "google",
  "other",
]);

export type ModelFamily = typeof ModelFamily.Type;

/** Why a candidate model was passed over at resolution. */
export const RoleSkipReason = Schema.Literals([
  "missing_credential",
  "unknown_model",
  "limited",
  "failing",
]);

export type RoleSkipReason = typeof RoleSkipReason.Type;

/** One model the resolver passed over, and why. */
export const SkippedModel = Schema.Struct({
  model: ModelRef,
  reason: RoleSkipReason,
});

export type SkippedModel = typeof SkippedModel.Type;

/**
 * A spec resolved to a concrete model, as the dispatch records it in documents (`cairn.subagents`,
 * the workflow ledger), so it is plain JSON: absent values are `null`.
 */
export const ResolvedRole = Schema.Struct({
  spec: RoleSpec,
  /** Null for a literal `provider/modelId` spec. */
  role: Schema.NullOr(RoleName),
  model: ModelRef,
  thinkingLevel: Schema.NullOr(ThinkingLevel),
  via: Schema.Literals(["primary", "fallback", "literal"]),
  skipped: Schema.Array(SkippedModel),
  family: ModelFamily,
  /** False when the model has no list price; its spend counts tokens only (ADR 0036). */
  priced: Schema.Boolean,
});

export type ResolvedRole = typeof ResolvedRole.Type;

/** `roles.check` input: the specs a brief or workflow plan names. */
export const RolesCheckInput = Schema.Struct({
  specs: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(64)),
  /** A launch card's role overrides (the proposed `roleOverrides` or the user's `LaunchEdits`). */
  overrides: Schema.optionalKey(RoleOverrides),
});

export type RolesCheckInput = typeof RolesCheckInput.Type;

/** One spec's preview for the brief card: resolved, or why Go is blocked on it. */
export const RoleCheck = Schema.Struct({
  spec: TrimmedNonEmptyString,
  resolution: Schema.Union([
    Schema.TaggedStruct("Resolved", { resolved: ResolvedRole }),
    Schema.TaggedStruct("Unresolved", {
      reason: Schema.Literals([
        "unbound_role",
        "invalid_spec",
        "no_ready_model",
      ]),
      skipped: Schema.Array(SkippedModel),
    }),
  ]),
  /** Set when a `@judge` or `@verifier` shares `@worker`'s family: a warning, not a block. */
  sameFamilyAsWorker: Schema.Boolean,
});

export type RoleCheck = typeof RoleCheck.Type;

const bridge = (modelId: string) => ({ provider: "claude-bridge", modelId });

const lunaOnGo = { provider: "opencode-go", modelId: "gpt-6-luna" };

const defaultRoleTableJson: typeof RoleTable.Encoded = {
  "@worker": {
    model: bridge("claude-opus-5-5"),
    thinkingLevel: "medium",
    fallbacks: [],
    note: null,
  },
  "@scout": {
    model: bridge("claude-sonnet-5-5"),
    thinkingLevel: "high",
    fallbacks: [],
    note: null,
  },
  "@judge": {
    model: lunaOnGo,
    thinkingLevel: null,
    fallbacks: [],
    note: null,
  },
  "@verifier": {
    model: lunaOnGo,
    thinkingLevel: null,
    fallbacks: [],
    note: null,
  },
};

/**
 * The table a fresh brain seeds (ADR 0035, decided 2026-10-27): `@worker` Opus 5.5 medium, `@scout`
 * Sonnet 5.5 high, `@judge` and `@verifier` OpenCode Go `gpt-6-luna`. The verifier was Codex
 * `gpt-6-luna` until 2026-10-29, when the user said there is no Codex subscription; a table seeded
 * before then keeps its Codex binding with this model as the fallback, as every seeded table stays.
 */
export const DEFAULT_ROLE_TABLE: RoleTable =
  Schema.decodeSync(RoleTable)(defaultRoleTableJson);
