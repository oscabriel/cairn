// How much the skills add to the model's system prompt, as the settings page reports it (moved from
// apps/web's classic settings view, look track L7, so the `next` page reads it without that view).

import type { SkillSummary } from "@cairn/protocol/Skills";

// formatSkillsForPrompt in pi-coding-agent 1.4.0 (core/skills.js): a fixed preamble of about 380
// characters, then per skill its name, description, file path and about 70 characters of tags.
// The path is not on the wire, so an average is assumed.
const PREAMBLE_CHARS = 380;

const PER_SKILL_CHARS = 70 + 60;

/** About how many tokens the skills add to the system prompt (4 characters a token). */
export const skillsPromptTokens = (
  skills: ReadonlyArray<SkillSummary>
): number => {
  const invocable = skills.filter((skill) => skill.modelInvocable);

  if (invocable.length === 0) {
    return 0;
  }

  const chars = invocable.reduce(
    (total, skill) =>
      total + PER_SKILL_CHARS + skill.name.length + skill.description.length,
    PREAMBLE_CHARS
  );

  return Math.round(chars / 4);
};
