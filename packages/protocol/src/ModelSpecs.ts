// Model specs (ADR 0043): where a brief, a workflow node, a recipe or a goal's model judge says
// which model a child runs on, it names `provider/modelId[:level]`, or nothing for its parent's
// model and level. A named model is checked when the child is created and refused with the reason
// when it is not ready, never replaced. `models.check` previews the check for the brief card and
// the launch card.

import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./Ids.ts";
import { ModelRef, ThinkingLevel } from "./Models.ts";

/**
 * A model spec, `provider/modelId[:level]`; a model id may hold `@` and `/` (a Workers AI id such as
 * `@cf/meta/...`). The pattern also takes `@name[:level]`: a role name from before ADR 0043, which
 * briefs, workflow scripts, envelopes and goal judges recorded then still hold. A stored role name
 * reads as no model named (the parent's); a new tool call that passes one is refused.
 */
export const ModelSpec = Schema.String.check(
  Schema.isPattern(
    /^(?:@[a-z0-9-]{1,24}|[A-Za-z0-9._-]+\/[A-Za-z0-9._:/@-]+?)(?::(?:off|minimal|low|medium|high|xhigh|max))?$/u
  )
).pipe(Schema.brand("ModelSpec"));

export type ModelSpec = typeof ModelSpec.Type;

/** Why a named model cannot take a child now. */
export const ModelUnready = Schema.Literals([
  "unknown_model",
  "missing_credential",
  "limited",
  "failing",
]);

export type ModelUnready = typeof ModelUnready.Type;

/**
 * A spec resolved to the model a child runs on, as the dispatch records it in documents
 * (`cairn.subagents`, the workflow ledger), so it is plain JSON: absent values are `null`. Records
 * written before ADR 0043 also hold `role`, `via`, `skipped` and `family`, which decoding ignores.
 */
export const ResolvedModel = Schema.Struct({
  /** What was named, or the parent's `provider/modelId` when nothing was. */
  spec: ModelSpec,
  model: ModelRef,
  /** The spec's level held to the levels the model takes; null when it named none. */
  thinkingLevel: Schema.NullOr(ThinkingLevel),
  /** False when the model has no list price; its spend counts tokens only (ADR 0036). */
  priced: Schema.Boolean,
});

export type ResolvedModel = typeof ResolvedModel.Type;

/** `models.check` input: the specs a brief or a workflow's launch names. */
export const ModelsCheckInput = Schema.Struct({
  specs: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(64)),
});

export type ModelsCheckInput = typeof ModelsCheckInput.Type;

/**
 * Why a spec did not resolve: not a spec (`invalid_spec`), a role name (`role_removed`, ADR 0043),
 * or a model that is not ready (`ModelUnready`).
 */
export const ModelCheckFailure = Schema.Literals([
  "invalid_spec",
  "role_removed",
  ...ModelUnready.literals,
]);

export type ModelCheckFailure = typeof ModelCheckFailure.Type;

/** One spec's preview for the brief card: what it runs on, or why Go is blocked on it. */
export const ModelCheck = Schema.Struct({
  spec: TrimmedNonEmptyString,
  resolution: Schema.Union([
    Schema.TaggedStruct("Resolved", { resolved: ResolvedModel }),
    Schema.TaggedStruct("Unresolved", { reason: ModelCheckFailure }),
  ]),
});

export type ModelCheck = typeof ModelCheck.Type;
