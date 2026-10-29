// The `next` progress bar and meter. Progress is work moving toward done: a share of it, or
// indeterminate while the share is unknown. A meter is a reading against a limit (spend against a
// budget, a plan window's use): its bar takes the waiting tone past its warning threshold and the
// failed tone at the limit, and an unknown reading is drawn as unknown, never as zero (surfaces
// note, Meter; models note: "unknown never zero"). Both always show their reading in words beside
// the bar, which is the text alternative too (`aria-valuetext`).

import { Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { TYPE, WEIGHT_MEDIUM } from "./Classes.ts";
import type { Tone } from "./Tone.ts";
import { TONE_FILL, TONE_TEXT } from "./Tone.ts";

const TRACK =
  "relative h-1.5 w-full min-w-0 overflow-hidden rounded-(--radius-round) bg-select-3";

const BAR =
  "absolute inset-y-0 start-0 rounded-(--radius-round) transition-[width] duration-(--duration-move) ease-(--ease-motion)";

/** A share in 0 to 1 as a whole percent, clamped. */
const percentOf = (share: number): number =>
  Math.round(Math.min(1, Math.max(0, share)) * 100);

const labelLine = <Message>(
  h: HtmlBuilder<Message>,
  label: string,
  reading: string,
  readingClass: string
): Html =>
  h.div(
    [
      h.Class(
        classNames(
          "flex min-w-0 flex-wrap items-baseline justify-between gap-x-(--space-2)",
          TYPE.small
        )
      ),
    ],
    [
      h.span(
        [h.Class(classNames("min-w-0 text-ink-2", WEIGHT_MEDIUM))],
        [label]
      ),
      h.span(
        [
          h.DataAttribute("reading", ""),
          h.Class(classNames("tabular-nums", readingClass)),
        ],
        [reading]
      ),
    ]
  );

/** A progress bar: a share in 0 to 1, or none while it is unknown (indeterminate). */
export const progress = <Message>(
  h: HtmlBuilder<Message>,
  label: string,
  share: Option.Option<number>,
  attributes: ReadonlyArray<Attribute<Message>> = []
): Html => {
  const reading = Option.match(share, {
    onNone: () => "Working",
    onSome: (value) => `${String(percentOf(value))}%`,
  });

  return h.div(
    [
      h.DataAttribute("slot", "progress"),
      h.Class("flex min-w-0 flex-col gap-(--space-1)"),
      ...attributes,
    ],
    [
      labelLine(h, label, reading, "text-ink-2"),
      h.div(
        [
          h.Role("progressbar"),
          h.AriaLabel(label),
          h.AriaValuemin(0),
          h.AriaValuemax(100),
          ...Option.match(share, {
            onNone: () => [h.AriaBusy(true)],
            onSome: (value) => [h.AriaValuenow(percentOf(value))],
          }),
          h.AriaValuetext(reading),
          h.Class(TRACK),
        ],
        [
          Option.match(share, {
            onNone: () =>
              h.div([
                h.DataAttribute("indeterminate", ""),
                h.Class(
                  classNames(
                    BAR,
                    TONE_FILL.working,
                    "w-full opacity-60 motion-safe:animate-pulse"
                  )
                ),
              ]),
            onSome: (value) =>
              h.div([
                h.Class(classNames(BAR, TONE_FILL.working)),
                h.Style({ width: `${String(percentOf(value))}%` }),
              ]),
          }),
        ]
      ),
    ]
  );
};

/** A meter's reading: a value against a limit, the share where it warns, and its words. */
export interface MeterReading {
  /** None when the reading is unknown (a provider that reports no usage). */
  readonly value: Option.Option<number>;
  readonly max: number;
  /** The share of `max` from which the meter warns (the waiting tone), in 0 to 1. */
  readonly warnAt: number;
  /** The reading in words: `$1.20 of $5.00`. Used when the value is known. */
  readonly text: string;
}

/** The tone a reading draws in: failed at the limit, waiting past the warning share, else accent. */
export const meterTone = (reading: MeterReading): Option.Option<Tone> =>
  Option.map(reading.value, (value): Tone => {
    const share = reading.max <= 0 ? 1 : value / reading.max;

    if (share >= 1) {
      return "failed";
    }

    return share >= reading.warnAt ? "waiting" : "accent";
  });

/** The words an unknown reading shows: never zero. */
export const UNKNOWN_READING = "Unknown";

/** A meter: label and reading in words, and the bar in its threshold's tone. */
export const meter = <Message>(
  h: HtmlBuilder<Message>,
  label: string,
  reading: MeterReading,
  attributes: ReadonlyArray<Attribute<Message>> = []
): Html => {
  const tone = meterTone(reading);

  const text = Option.match(reading.value, {
    onNone: () => UNKNOWN_READING,
    onSome: () => reading.text,
  });

  return h.div(
    [
      h.DataAttribute("slot", "meter"),
      h.DataAttribute(
        "tone",
        Option.getOrElse(tone, () => "unknown")
      ),
      h.Class("flex min-w-0 flex-col gap-(--space-1)"),
      ...attributes,
    ],
    [
      labelLine(
        h,
        label,
        text,
        Option.match(tone, {
          onNone: () => "text-ink-3 italic",
          onSome: (known) =>
            known === "accent" ? "text-ink-1" : TONE_TEXT[known],
        })
      ),
      h.div(
        [
          h.Role("meter"),
          h.AriaLabel(label),
          h.AriaValuemin(0),
          h.AriaValuemax(reading.max),
          ...Option.match(reading.value, {
            onNone: () => [],
            onSome: (value) => [h.AriaValuenow(Math.min(value, reading.max))],
          }),
          h.AriaValuetext(text),
          h.Class(
            classNames(
              TRACK,
              Option.isNone(reading.value) &&
                "bg-[repeating-linear-gradient(135deg,var(--select-3)_0_4px,transparent_4px_8px)]"
            )
          ),
        ],
        [
          Option.match(
            Option.zipWith(
              reading.value,
              tone,
              (value, known) => [value, known] as const
            ),
            {
              onNone: () => h.empty,
              onSome: ([value, known]) =>
                h.div([
                  h.Class(classNames(BAR, TONE_FILL[known])),
                  h.Style({
                    width: `${String(percentOf(reading.max <= 0 ? 1 : value / reading.max))}%`,
                  }),
                ]),
            }
          ),
        ]
      ),
    ]
  );
};
