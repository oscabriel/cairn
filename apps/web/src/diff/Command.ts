// The diff panel's effects: asking the brain for a patch (`diff.turn` for one turn, `diff.full`
// for everything up to it), scrolling to a file, and loading a file's grammar when its diff mounts
// (the same lazy shiki chunks the transcript's code blocks use).
import { ThreadId } from "@cairn/protocol/Ids";
import { Effect, Predicate, Schema } from "effect";
import { Command } from "foldkit";
import * as Mount from "foldkit/mount";

import { CairnConnection } from "../connection/Connection.ts";
import { loadLanguage } from "../timeline/markdown/Highlight.ts";
import { Message } from "./Message.ts";
import { DiffScope } from "./Model.ts";

/** The element id of a file's diff, from its path. */
export const fileElementId = (path: string): string =>
  `diff-file-${encodeURIComponent(path).replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`;

/** Fetches the patch for one turn, or for the thread's baseline up to it. */
export const FetchDiff = Command.define("FetchDiff", {
  args: {
    version: Schema.Int,
    threadId: ThreadId,
    turn: Schema.Int,
    scope: DiffScope,
    ignoreWhitespace: Schema.Boolean,
  },
  messages: [Message.LoadedDiff, Message.FailedDiff],
  execute: ({ ignoreWhitespace, scope, threadId, turn, version }) =>
    Effect.flatMap(CairnConnection.get, (client) =>
      scope === "turn"
        ? client["diff.turn"]({
            threadId,
            fromTurnCount: Math.max(0, turn - 1),
            toTurnCount: turn,
            ignoreWhitespace,
          })
        : client["diff.full"]({
            threadId,
            toTurnCount: turn,
            ignoreWhitespace,
          })
    ).pipe(
      Effect.match({
        onSuccess: (result) =>
          Message.LoadedDiff({ version, patch: result.diff }),
        onFailure: (failure) =>
          Message.FailedDiff({
            version,
            message: Predicate.isTagged(failure, "RpcClientError")
              ? "The connection dropped before the diff arrived. Retry when Cairn reconnects."
              : failure.message,
          }),
      })
    ),
});

/** Scrolls the file's diff into view. */
export const ScrollToFile = Command.define("ScrollToFile", {
  args: { path: Schema.String },
  messages: [Message.ScrolledToFile],
  execute: ({ path }) =>
    Effect.sync(() => {
      document
        .querySelector(`#${CSS.escape(fileElementId(path))}`)
        ?.scrollIntoView({ block: "start" });

      return Message.ScrolledToFile();
    }),
});

const markHighlight = (element: Element, state: string): void => {
  if (element instanceof HTMLElement) {
    element.dataset.highlight = state;
  }
};

/** Loads a file's grammar when its diff mounts, and marks the file `data-highlight` with the result. */
export const LoadDiffHighlighting = Mount.define("LoadDiffHighlighting", {
  args: { language: Schema.String },
  messages: [Message.LoadedLanguage, Message.FailedLanguage],
  execute: ({ element, language }) =>
    loadLanguage(language).pipe(
      Effect.match({
        onSuccess: () => {
          markHighlight(element, "ready");

          return Message.LoadedLanguage({ language });
        },
        onFailure: () => {
          markHighlight(element, "failed");

          return Message.FailedLanguage({ language });
        },
      })
    ),
});
