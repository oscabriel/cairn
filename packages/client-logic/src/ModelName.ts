// A model's short name for tight places (the composer's model pill): the family and version a
// person says aloud, without the provider word, the context size or the snapshot date. Claude ids
// read as "Opus 5.5"; every other id is short enough as it is, so it is kept, less its suffixes.

const CLAUDE_FAMILY_FIRST =
  /^claude-(?<family>[a-z]+)-(?<major>\d+)(?:-(?<minor>\d{1,2}))?$/u;

const CLAUDE_VERSION_FIRST =
  /^claude-(?<major>\d+)(?:-(?<minor>\d{1,2}))?-(?<family>[a-z]+)$/u;

const capitalized = (word: string): string =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/** The id without a `[1m]`-style context suffix, a `-latest` tag or a dated snapshot. */
const bareId = (modelId: string): string =>
  modelId
    .trim()
    .replace(/\[[^\]]*\]$/u, "")
    .replace(/-latest$/u, "")
    .replace(/-\d{8}$/u, "");

/** "Opus 5.5" for `claude-opus-5-5`, "gpt-6-luna" for `gpt-6-luna`. */
export const condensedModelName = (modelId: string): string => {
  const id = bareId(modelId);

  const groups =
    CLAUDE_FAMILY_FIRST.exec(id)?.groups ??
    CLAUDE_VERSION_FIRST.exec(id)?.groups;

  if (groups === undefined) {
    return id.length > 0 ? id : modelId;
  }

  const { family = "", major = "", minor } = groups;

  return `${capitalized(family)} ${minor === undefined ? major : `${major}.${minor}`}`;
};
