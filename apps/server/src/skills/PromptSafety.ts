// Which prompt text the Claude bridge would refuse, judged piece by piece. The bridge checks a
// thread's whole instructions (`unsendableFindings` in `@cairn/bridge/ClaudeGuards`): pi's preamble
// at a line start, pi's documentation routing line, or both of pi's documentation paths together.
// Sections are built from many pieces (one skill, one context file), and two pieces could each
// bring one of the two paths, so a piece carrying either path alone is refused here too.
import {
  THIRD_PARTY_DOC_PATHS,
  unsendableFindings,
} from "@cairn/bridge/ClaudeGuards";

/** What in `text` the bridge refuses, as short phrases; empty when the text is sendable. */
export const refusedPhrases = (text: string): ReadonlyArray<string> => [
  ...unsendableFindings(text),
  ...THIRD_PARTY_DOC_PATHS.filter(
    (docPath) =>
      text.includes(docPath) &&
      !THIRD_PARTY_DOC_PATHS.every((each) => text.includes(each))
  ),
];

/** True when any of `pieces` carries text the bridge refuses. */
export const isRefused = (...pieces: ReadonlyArray<string>): boolean =>
  pieces.some((piece) => refusedPhrases(piece).length > 0);
