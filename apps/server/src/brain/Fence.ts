// Text Cairn quotes inside a fence of its own, from a source it does not trust: a judged
// transcript's turns (`verdicts/ModelJudge.ts`, ADR 0055 decision 4) and a `done_when` check's
// output in a child's result note (`SubagentText.ts`). Role labels (plain or in Markdown) and the
// fence's own tags are stripped until none is left, and the angle brackets and ampersands left are
// escaped, so the quoted text can neither close its fence nor forge another speaker's words.
// Moved from ModelJudge.ts, where the judge's turns were fenced first, so the brain's notes can use
// it too (`brain/` imports no feature folder).

/**
 * A role label at a line's start, plain or in Markdown: `user:`, `Assistant:`, `tool result
 * (bash):`, `**User:**`, `- system:`.
 */
const ROLE_LABEL =
  /^[ \t>*_#`~+-]*(?:user|human|assistant|system|developer|tool(?:[ \t]+(?:result|output|call))?)[ \t]*(?:\([^)\n]*\))?[ \t*_`]*:[ \t*_`]*/gimu;

/** An opening or closing tag of one of `tags`, with any attributes. */
const tagPattern = (tags: ReadonlyArray<string>): RegExp =>
  new RegExp(`</?[ \\t]*(?:${tags.join("|")})\\b[^>]*>`, "giu");

/**
 * `text` as a fence of `tags` quotes it, so it can only be its own words: role labels and the
 * tags removed until none is left (removing `<turn>` from `<tu<turn>rn>` builds another, as removing
 * one of two labels leaves the other), then every `<`, `>` and `&` left escaped, so no tag in it,
 * however it was built, opens or closes a fence. `tags` are plain words.
 */
export const fencedText = (
  text: string,
  tags: ReadonlyArray<string>
): string => {
  const fenceTag = tagPattern(tags);

  const cleanOnce = (from: string): string =>
    from.replaceAll(fenceTag, "").replaceAll(ROLE_LABEL, "");

  let current = text;
  let next = cleanOnce(current);

  while (next !== current) {
    current = next;
    next = cleanOnce(current);
  }

  return current
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
};
