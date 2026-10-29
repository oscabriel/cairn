// The `next` stepper (the surfaces note's Stepper): a workflow's or a child's steps in order, each
// with its state as a mark and a word (to do, working, done, failed), and the "3/7 steps" pill that
// sums them, which on the phone opens the steps sheet. A step that changes state keeps its line's
// height, so updating a step moves nothing below or above it.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import * as FoldkitButton from "@foldkit/ui/button";
import { Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_RING,
  HIT_TARGET,
  TYPE,
  WEIGHT_MEDIUM,
} from "./Classes.ts";
import type { StatusMark } from "./Glyph.ts";
import { statusGlyph } from "./Glyph.ts";
import { statusChipClass } from "./StatusChip.ts";
import type { Tone } from "./Tone.ts";
import { TONE_TEXT } from "./Tone.ts";

/** A step's state. */
export type StepState = "todo" | "working" | "done" | "failed";

/** Every step state, in the order a step passes through them. */
export const STEP_STATES: ReadonlyArray<StepState> = [
  "todo",
  "working",
  "done",
  "failed",
];

const LOOK: Readonly<
  Record<
    StepState,
    { readonly mark: StatusMark; readonly tone: Tone; readonly word: string }
  >
> = {
  todo: { mark: "todo", tone: "neutral", word: "to do" },
  working: { mark: "busy", tone: "working", word: "working" },
  done: { mark: "done", tone: "done", word: "done" },
  failed: { mark: "failed", tone: "failed", word: "failed" },
};

/** The word a step state reads as. */
export const stepWord = (state: StepState): string => LOOK[state].word;

/** One step: what it is, its state, and quiet meta (a time, a cost). */
export interface Step {
  readonly title: string;
  readonly state: StepState;
  readonly meta: Option.Option<string>;
}

/** A list of steps in order, each its mark, title, state word and meta. */
export const stepper = <Message>(
  h: HtmlBuilder<Message>,
  label: string,
  steps: ReadonlyArray<Step>,
  attributes: ReadonlyArray<Attribute<Message>> = []
): Html =>
  h.ol(
    [
      h.AriaLabel(label),
      h.DataAttribute("slot", "stepper"),
      ...attributes,
      h.Class("flex min-w-0 flex-col"),
    ],
    steps.map((step) => {
      const look = LOOK[step.state];

      return h.li(
        [
          h.DataAttribute("step-state", step.state),
          ...onlyIf(step.state === "working", h.AriaCurrent("step")),
          h.Class(
            classNames(
              "flex min-h-8 min-w-0 items-center gap-(--space-2) py-(--space-1)",
              TYPE.ui
            )
          ),
        ],
        [
          h.span(
            [h.Class(TONE_TEXT[look.tone])],
            [statusGlyph(h, look.mark, "regular")]
          ),
          h.span(
            [
              h.Class(
                classNames(
                  "min-w-0 flex-1 truncate",
                  step.state === "todo" ? "text-ink-2" : "text-ink-1"
                )
              ),
            ],
            [step.title]
          ),
          h.span(
            [
              h.DataAttribute("step-word", ""),
              h.Class(classNames("shrink-0", TONE_TEXT[look.tone], TYPE.small)),
            ],
            [look.word]
          ),
          Option.match(step.meta, {
            onNone: () => h.empty,
            onSome: (meta) =>
              h.span(
                [
                  h.Class(
                    classNames("shrink-0 tabular-nums text-ink-3", TYPE.small)
                  ),
                ],
                [meta]
              ),
          }),
        ]
      );
    })
  );

/** What the steps sum to: failed if any failed, working if any works, done when all are. */
export const stepsTone = (steps: ReadonlyArray<Step>): Tone => {
  if (steps.some((step) => step.state === "failed")) {
    return "failed";
  }

  if (steps.some((step) => step.state === "working")) {
    return "working";
  }

  return steps.length > 0 && steps.every((step) => step.state === "done")
    ? "done"
    : "neutral";
};

const MARK_OF_SUM: Readonly<Record<Tone, StatusMark>> = {
  neutral: "todo",
  accent: "info",
  working: "busy",
  waiting: "needs",
  failed: "failed",
  done: "done",
};

/**
 * The "3/7 steps" pill: steps done of all steps, in tabular figures, with the mark of what they
 * sum to. With a click it is a button (the phone's way into the steps sheet); without, it only
 * shows.
 */
export const stepsPill = <Message>(
  h: HtmlBuilder<Message>,
  steps: ReadonlyArray<Step>,
  onClick: Option.Option<Message>,
  attributes: ReadonlyArray<Attribute<Message>> = []
): Html => {
  const done = steps.filter((step) => step.state === "done").length;
  const tone = stepsTone(steps);

  const insides = [
    statusGlyph(h, MARK_OF_SUM[tone], "small"),
    h.span(
      [h.Class("tabular-nums")],
      [
        h.span(
          [h.AriaHidden(true)],
          [`${String(done)}/${String(steps.length)}`]
        ),
        h.span(
          [h.Class("sr-only")],
          [`${String(done)} of ${String(steps.length)}`]
        ),
        " steps",
      ]
    ),
  ];

  const base = [
    h.DataAttribute("slot", "steps-pill"),
    h.DataAttribute("tone", tone),
    ...attributes,
  ];

  return Option.match(onClick, {
    onNone: () => h.span([...base, h.Class(statusChipClass(tone))], insides),
    onSome: (message) =>
      FoldkitButton.view(
        {
          onClick: message,
          toView: (button) =>
            h.button(
              [
                ...button.button,
                ...base,
                h.AriaHasPopup("dialog"),
                h.Class(
                  classNames(
                    statusChipClass(tone),
                    "cursor-pointer justify-center border border-stroke-2",
                    WEIGHT_MEDIUM,
                    HIT_TARGET,
                    FOCUS_RING,
                    FEEDBACK_MOTION
                  )
                ),
              ],
              insides
            ),
        },
        h
      ),
  });
};
