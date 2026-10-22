// Skills as the composer's `$` and `/` completion sees them. The brain resolves them from pi's
// configuration and the project's `.agents/skills`.
import { Schema } from "effect";

import { DisplayText, ProjectId, TrimmedNonEmptyString } from "./Ids.ts";

/** One skill the composer can complete. */
export const SkillSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: DisplayText,
  source: Schema.Literals(["project", "user"]),
  /** False for a skill that is listed for completion but kept out of the model's prompt. */
  modelInvocable: Schema.Boolean,
});

export type SkillSummary = typeof SkillSummary.Type;

/** `skills.list` and `skills.reload` input: the project whose skills to resolve. */
export const SkillsInput = Schema.Struct({
  projectId: ProjectId,
});

export type SkillsInput = typeof SkillsInput.Type;

/** `skills.list` and `skills.reload` result. */
export const SkillList = Schema.Struct({
  skills: Schema.Array(SkillSummary),
});

export type SkillList = typeof SkillList.Type;
