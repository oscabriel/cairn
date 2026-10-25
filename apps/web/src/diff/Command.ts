// The diff panel's effects: asking the brain for a patch (`diff.turn` for one turn, `diff.full`
// for everything up to it), scrolling to a file, and loading a file's grammar when its diff mounts
// (the same lazy shiki chunks the transcript's code blocks use), then tokenizing a long file a
// slice at a time.
import { ThreadId } from "@cairn/protocol/Ids";
import { Duration, Effect, Predicate, Schema, Stream } from "effect";
import { Command, Dom } from "foldkit";
import * as Mount from "foldkit/mount";

import { CairnConnection } from "../connection/Connection.ts";
import { highlightStages } from "../timeline/markdown/Highlight.ts";
import { Message } from "./Message.ts";
import { DiffScope } from "./Model.ts";

/** The element id of a file's diff, from its path. */
export const fileElementId = (path: string): string =>
  `diff-file-${encodeURIComponent(path).replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`;

/** How long a patch may take before the panel stops waiting and offers Retry (T14). */
export const DIFF_FETCH_TIMEOUT = Duration.seconds(30);

/** A patch that did not arrive within `DIFF_FETCH_TIMEOUT`. */
export class DiffTimedOut extends Schema.TaggedError<DiffTimedOut>()(
  "DiffTimedOut",
  { message: Schema.String }
) {}

/** `fetch`, failing with `DiffTimedOut` once `DIFF_FETCH_TIMEOUT` passes without an answer. */
export const patchInTime = <A, E, R>(fetch: Effect.Effect<A, E, R>) =>
  fetch.pipe(
    Effect.timeoutOrElse({
      duration: DIFF_FETCH_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new DiffTimedOut({
            message: "The diff did not arrive within 30 seconds.",
          })
        ),
    })
  );

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
      patchInTime,
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

/**
 * Scrolls the file's diff into view once the render that follows the message commits: the message
 * that loads the patch dispatches this too, before the file is in the DOM.
 */
export const ScrollToFile = Command.define("ScrollToFile", {
  args: { path: Schema.String },
  messages: [Message.ScrolledToFile],
  execute: ({ path }) =>
    Dom.scrollIntoView(`#${CSS.escape(fileElementId(path))}`, {
      block: "start",
    }).pipe(Effect.ignore, Effect.as(Message.ScrolledToFile())),
});

const markHighlight = (element: Element, state: string): void => {
  if (element instanceof HTMLElement) {
    element.dataset.highlight = state;
  }
};

/**
 * Loads a file's grammar when its diff mounts, then tokenizes `code`, the file's shown lines when
 * they are too long to tokenize while rendering, a slice at a time, each slice answered with
 * `HighlightedCode`. Marks the file `data-highlight` with the result.
 */
export const LoadDiffHighlighting = Mount.defineStream("LoadDiffHighlighting", {
  args: { language: Schema.String, code: Schema.Option(Schema.String) },
  messages: [
    Message.LoadedLanguage,
    Message.HighlightedCode,
    Message.FailedLanguage,
  ],
  execute: ({ code, element, language }) =>
    highlightStages(language, code).pipe(
      Stream.map((stage) =>
        stage === "loaded"
          ? Message.LoadedLanguage({ language })
          : Message.HighlightedCode({ language })
      ),
      Stream.onEnd(
        Effect.sync(() => {
          markHighlight(element, "ready");
        })
      ),
      Stream.catchTag("HighlightLoadError", () =>
        Stream.fromEffect(
          Effect.sync(() => {
            markHighlight(element, "failed");

            return Message.FailedLanguage({ language });
          })
        )
      )
    ),
});
