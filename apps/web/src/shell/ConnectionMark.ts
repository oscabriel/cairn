// The connection mark (GLOSSARY "Connection mark"): the chat header's one quiet word for a socket
// that is not live, a spinner in the waiting tone and its word: Connecting on the page's first dial,
// Reconnecting while it dials again or waits to, Catching up while the shell stream brings the page
// current. While the page is live the mark stays in the document, visually hidden, so a judge
// (`judges/reconnect.ts`, `judges/dev-smoke.ts`, the durability page) can wait for Live; its
// `data-state` is the connection state's tag (`connection/Reconnect.ts`).

import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { ConnectionState } from "../connection/Reconnect.ts";
import type { Connection } from "../connection/Reconnect.ts";
import { TYPE } from "../ui/Classes.ts";
import { classNames } from "../ui/ClassNames.ts";
import { statusGlyph } from "../ui/Glyph.ts";
import { TONE_TEXT } from "../ui/Tone.ts";

/** The word read out while the page is live, when the mark is visually hidden. */
export const LIVE_WORD = "Connected";

/** The mark's word for a connection state; none while the page is live. */
export const connectionWord = (state: ConnectionState): Option.Option<string> =>
  ConnectionState.match(state, {
    Connecting: ({ attempt }) =>
      Option.some(attempt === 0 ? "Connecting" : "Reconnecting"),
    Syncing: () => Option.some("Catching up"),
    Live: () => Option.none(),
    Backoff: () => Option.some("Reconnecting"),
  });

/** The connection mark for `connection`, drawn in the chat header. */
export const connectionMark = <Message>(
  h: HtmlBuilder<Message>,
  connection: Connection
): Html => {
  const word = connectionWord(connection.state);

  return h.span(
    [
      h.DataAttribute("testid", "connection-state"),
      h.DataAttribute("state", connection.state._tag),
      h.Role("status"),
      h.Class(
        Option.match(word, {
          onNone: () => "sr-only",
          onSome: () =>
            classNames(
              "inline-flex shrink-0 items-center gap-(--space-1-5) whitespace-nowrap text-ink-2",
              TYPE.small
            ),
        })
      ),
    ],
    Option.match(word, {
      onNone: () => [LIVE_WORD],
      onSome: (text) => [
        h.span(
          [h.Class(classNames("inline-flex", TONE_TEXT.waiting))],
          [statusGlyph(h, "busy", "regular")]
        ),
        h.span([], [text]),
      ],
    })
  );
};
