// Brain text bound for a protocol error (T19). Every protocol error's `message` is `DisplayText`,
// at most 4,096 characters; a longer one (a tool's whole stderr, a stack) would make the answer
// undecodable on the client. Newlines fold to spaces, since a notice is one line.

/** The longest `DisplayText` (`@cairn/protocol/Ids`). */
const DISPLAY_TEXT_LIMIT = 4096;

/** `text` as one line that fits a protocol error's message, cut with an ellipsis when too long. */
export const publicText = (text: string): string => {
  const line = text.replaceAll(/\s*\n\s*/gu, " ").trim();

  return line.length <= DISPLAY_TEXT_LIMIT
    ? line
    : `${line.slice(0, DISPLAY_TEXT_LIMIT - 1)}…`;
};
