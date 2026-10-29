// The tones a `next` primitive can carry, and their class strings. Four are the status tones the
// design tokens name (working, waiting, failed, done: the surfaces note's closed set "working,
// needs you, done, failed"); `neutral` is ink on the selection ladder and `accent` the look's one
// action colour. A status is never colour alone: a status chip, banner or card rule always comes
// with its word, and with its glyph (`Glyph.ts`).

import type { ThreadTone } from "@cairn/client-logic/ThreadState";

/** A primitive's tone. */
export type Tone =
  | "neutral"
  | "accent"
  | "working"
  | "waiting"
  | "failed"
  | "done";

/** Every tone, in the order the catalogue shows them. */
export const TONES: ReadonlyArray<Tone> = [
  "neutral",
  "accent",
  "working",
  "waiting",
  "failed",
  "done",
];

/** The tone's ink: text and glyphs in it. */
export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  neutral: "text-ink-2",
  accent: "text-accent-text",
  working: "text-tone-working",
  waiting: "text-tone-waiting",
  failed: "text-tone-failed",
  done: "text-tone-done",
};

/** The tone's wash: a chip's or banner's ground. Every ink and the tone itself read on it (AA). */
export const TONE_WASH: Readonly<Record<Tone, string>> = {
  neutral: "bg-select-2",
  accent: "bg-accent-wash",
  working: "bg-tone-working-wash",
  waiting: "bg-tone-waiting-wash",
  failed: "bg-tone-failed-wash",
  done: "bg-tone-done-wash",
};

/** The tone as a left rule, for a card or banner. */
export const TONE_RULE: Readonly<Record<Tone, string>> = {
  neutral: "border-l-stroke-2",
  accent: "border-l-accent-fill",
  working: "border-l-tone-working",
  waiting: "border-l-tone-waiting",
  failed: "border-l-tone-failed",
  done: "border-l-tone-done",
};

/** The tone as a fill, for a meter's bar or a dot. */
export const TONE_FILL: Readonly<Record<Tone, string>> = {
  neutral: "bg-ink-3",
  accent: "bg-accent-fill",
  working: "bg-tone-working",
  waiting: "bg-tone-waiting",
  failed: "bg-tone-failed",
  done: "bg-tone-done",
};

const BY_THREAD_TONE: Readonly<Record<ThreadTone, Tone>> = {
  info: "working",
  muted: "neutral",
  attention: "waiting",
  question: "waiting",
  warning: "waiting",
  error: "failed",
  success: "done",
};

/**
 * The tone a thread label's tone draws in (`THREAD_LABELS`, `HOLD_LABELS`). An approval, a question
 * and something to look at all need the user, so all three are `waiting`; their glyphs and words
 * tell them apart.
 */
export const toneOfThreadTone = (tone: ThreadTone): Tone =>
  BY_THREAD_TONE[tone];
