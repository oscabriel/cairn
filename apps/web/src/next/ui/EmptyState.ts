// The `next` empty state: what a list, panel or page shows when it has nothing yet (no threads, no
// subagents, no artifacts), as a quiet glyph, a title that says what is missing, one line on how it
// fills, and at most one action. Centred in its space, and its words wrap rather than run out.

import { Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { TYPE, WEIGHT_STRONG } from "./Classes.ts";

/** What an empty state says. */
export interface EmptyContent {
  /** A large glyph or avatar above the title. */
  readonly glyph: Option.Option<Html>;
  readonly title: string;
  /** How the space fills: what to do, or what will appear. */
  readonly body: Option.Option<string>;
  readonly action: Option.Option<Html>;
}

/** An empty state, centred in its space. */
export const emptyState = <Message>(
  h: HtmlBuilder<Message>,
  content: EmptyContent,
  attributes: ReadonlyArray<Attribute<Message>> = []
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "empty"),
      ...attributes,
      h.Class(
        "flex min-w-0 flex-col items-center gap-(--space-2) px-(--space-4) py-(--space-8) text-center"
      ),
    ],
    [
      Option.match(content.glyph, {
        onNone: () => h.empty,
        onSome: (glyph) =>
          h.div([h.Class("mb-(--space-1) text-ink-3")], [glyph]),
      }),
      h.p(
        [
          h.Class(
            classNames(
              "max-w-full break-words text-ink-1",
              TYPE.title,
              WEIGHT_STRONG
            )
          ),
        ],
        [content.title]
      ),
      Option.match(content.body, {
        onNone: () => h.empty,
        onSome: (body) =>
          h.p(
            [
              h.Class(
                classNames("max-w-[32rem] break-words text-ink-2", TYPE.body)
              ),
            ],
            [body]
          ),
      }),
      Option.match(content.action, {
        onNone: () => h.empty,
        onSome: (action) => h.div([h.Class("mt-(--space-2)")], [action]),
      }),
    ]
  );
