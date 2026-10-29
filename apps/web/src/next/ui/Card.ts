// The `next` card (the surfaces note's Card: a header line, a body and a semantic left rule): the
// frame a brief, a question, a launch approval, a subagent and an artifact are drawn in. The rule's
// tone says what the card is waiting on; the header carries the same meaning in words (a status
// chip), so the rule is never the only sign.

import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { TYPE, WEIGHT_STRONG } from "./Classes.ts";
import type { Tone } from "./Tone.ts";
import { TONE_RULE } from "./Tone.ts";

/** What a card shows. */
export interface CardContent {
  /** The rule's tone; `neutral` for a card that waits on nothing. */
  readonly tone: Tone;
  readonly title: string;
  /** Beside the title: a status chip, a time, a menu button. */
  readonly aside: ReadonlyArray<Html>;
  readonly body: ReadonlyArray<Html>;
  /** Actions at the foot, primary last; none for a card that only informs. */
  readonly actions: ReadonlyArray<Html>;
}

/** The class string of a card with a `tone` rule. */
export const cardClass = (tone: Tone): string =>
  classNames(
    "flex w-full min-w-0 flex-col gap-(--space-3) rounded-(--radius-medium) border border-stroke-1 border-l-3 bg-surface-raised p-(--space-4) text-ink-1 shadow-(--elevation-1)",
    TONE_RULE[tone]
  );

/** A card: header line, body and actions, with its tone's left rule. */
export const card = <Message>(
  h: HtmlBuilder<Message>,
  content: CardContent,
  attributes: ReadonlyArray<Attribute<Message>> = []
): Html =>
  h.section(
    [
      h.DataAttribute("slot", "card"),
      h.DataAttribute("tone", content.tone),
      ...attributes,
      h.Class(cardClass(content.tone)),
    ],
    [
      h.header(
        [h.Class("flex min-w-0 flex-wrap items-center gap-(--space-2)")],
        [
          h.h3(
            [
              h.Class(
                classNames(
                  "min-w-0 flex-1 break-words",
                  TYPE.body,
                  WEIGHT_STRONG
                )
              ),
            ],
            [content.title]
          ),
          ...content.aside,
        ]
      ),
      h.div(
        [h.Class(classNames("min-w-0 break-words text-ink-2", TYPE.body))],
        content.body
      ),
      content.actions.length === 0
        ? h.empty
        : h.footer(
            [
              h.Class(
                "flex flex-wrap items-center justify-end gap-(--space-2)"
              ),
            ],
            content.actions
          ),
    ]
  );

/** The card's body as label and value pairs (the brief's fields), in order. */
export const recordLines = <Message>(
  h: HtmlBuilder<Message>,
  lines: ReadonlyArray<readonly [string, string]>
): Html =>
  h.dl(
    [
      h.Class(
        classNames(
          "grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-(--space-3) gap-y-(--space-1)",
          TYPE.ui
        )
      ),
    ],
    lines.flatMap(([label, value]) => [
      h.dt([h.Class("text-ink-3")], [label]),
      h.dd([h.Class("min-w-0 break-words text-ink-1")], [value]),
    ])
  );

/** The card's body text as one paragraph. */
export const cardText = <Message>(
  h: HtmlBuilder<Message>,
  text: string
): Html => h.p([], [text]);
