// The `next` composer's class strings (plan look track L7), in the Stone look round 1 drew
// (~/Developer/agent-artifacts/cairn/v2/look/round-1/): one raised box with a hairline, the
// prompt, and under it a row of quiet pills, the paperclip and the round send button in the main
// ink. Colour is left to status icons, so nothing here names a hue: the send and stop buttons are
// the accent fill, which in Stone is the main ink (near-white in dark, near-black in light).
//
// Every control is at least `--hit-target` each way on a coarse pointer, its ring is the
// `--stroke-focus` outline on keyboard focus only, and nothing that takes focus casts a shadow at
// rest (the look rules read a resting shadow as a ring that never goes away). The box's elevation
// sits on its wrapper for the same reason. The utilities are built by `composer.css`, imported
// here, from this folder and next/hero only.

import "./composer.css";
import { classNames } from "../../ui/ClassNames.ts";
import {
  DISABLED,
  FEEDBACK_MOTION,
  FOCUS_RING,
  HIT_TARGET,
  TYPE,
  WEIGHT_MEDIUM,
} from "../ui/Classes.ts";

/** The docked composer's lane under the transcript, inset like the transcript's rows. */
export const LANE_CLASS =
  "chat-composer-lane relative z-20 w-full shrink-0 px-(--space-2) pt-(--space-2) pb-[calc(env(safe-area-inset-bottom)+var(--space-3))] sm:px-(--space-5) sm:pb-[calc(env(safe-area-inset-bottom)+var(--space-4))]";

/** The stack the box and its drawers sit in, one lane wide. */
export const STACK_CLASS =
  "group/composer-stack relative z-10 mx-auto w-full max-w-(--chat-content-max-width)";

/** The box's wrapper: it carries the elevation, so the box itself has no resting shadow. */
export const SHELL_CLASS =
  "relative isolate mx-auto w-full max-w-(--chat-content-max-width) rounded-(--radius-large) shadow-(--elevation-2)";

/**
 * The box: raised, one hairline, the large radius. It is the prompt's field shell, so it shows the
 * focus ring while the prompt has keyboard focus (the prompt itself draws none).
 */
export const BOX_CLASS = classNames(
  "relative grid gap-(--space-1) rounded-(--radius-large) border border-stroke-2 bg-surface-raised text-ink-1",
  "has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-solid has-[textarea:focus-visible]:outline-offset-1 has-[textarea:focus-visible]:outline-stroke-focus",
  "in-data-[thread-context-over]:bg-select-2"
);

/** The body around the prompt and the attachment tray. */
export const BODY_CLASS =
  "relative px-(--space-3) pt-(--space-3) sm:px-(--space-4)";

/** The row under the prompt: the controls on the left, the actions on the right. */
export const FOOTER_CLASS =
  "flex min-w-0 flex-nowrap items-center justify-between gap-(--space-2) px-(--space-2) pb-(--space-2) sm:px-(--space-3) sm:pb-(--space-3)";

/** The left cluster: model, thinking and mode, and the overflow button (measured, `Footer.ts`). */
export const CONTROLS_CLASS =
  "relative -m-1 flex min-w-0 flex-1 items-center gap-(--space-1) overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** One foldable block (thinking, mode). */
export const BLOCK_CLASS = "flex w-max min-w-max shrink-0 items-center";

/** A pill in the footer: the model, the thinking level, the mode and the overflow. */
export const PILL_CLASS = classNames(
  "relative inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-(--space-1-5) whitespace-nowrap rounded-(--radius-small) bg-select-2 px-(--space-2) text-ink-2",
  "hover:bg-select-3 hover:text-ink-1 aria-expanded:bg-select-3 aria-expanded:text-ink-1",
  "[&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ink-3",
  TYPE.small,
  WEIGHT_MEDIUM,
  HIT_TARGET,
  FOCUS_RING,
  FEEDBACK_MOTION,
  DISABLED
);

/** The right cluster: the plan meter, the paperclip and send. */
export const ACTIONS_CLASS =
  "flex shrink-0 flex-nowrap items-center justify-end gap-(--space-1-5)";

/**
 * The paperclip: a label around the file input, which covers it unseen, so a tap opens the picker
 * and the input itself is the size a finger hits. The label is the input's field shell, so the
 * ring shows on it while the input has keyboard focus.
 */
export const ATTACH_CLASS = classNames(
  "relative grid size-8 shrink-0 cursor-pointer place-items-center rounded-(--radius-small) text-ink-2 hover:bg-select-1 hover:text-ink-1 [&_svg]:size-4",
  "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-solid has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-stroke-focus",
  "pointer-coarse:size-(--hit-target)",
  FEEDBACK_MOTION
);

/** The file input over the paperclip: its whole box, invisible. */
export const ATTACH_INPUT_CLASS =
  "absolute inset-0 size-full cursor-pointer opacity-0 outline-none";

/** The round send button, and Stop while a run works: the accent fill, which is the main ink. */
export const ROUND_ACTION_CLASS = classNames(
  "relative grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-accent-fill text-accent-ink not-disabled:hover:bg-accent-fill/90 [&_svg]:pointer-events-none",
  "pointer-coarse:size-(--hit-target)",
  FOCUS_RING,
  FEEDBACK_MOTION,
  DISABLED
);

/** A drawer attached above the box (the queue). */
export const DRAWER_CLASS =
  "mx-(--space-3) -mb-px flex flex-col rounded-t-(--radius-medium) border border-b-0 border-stroke-2 bg-surface-sunken pb-(--space-1)";

/** A quiet text button inside a drawer (Clear queue). */
export const TEXT_BUTTON_CLASS = classNames(
  "inline-flex cursor-pointer items-center rounded-(--radius-small) px-(--space-1-5) text-ink-2 hover:text-ink-1",
  TYPE.small,
  "pointer-coarse:min-h-(--hit-target)",
  FOCUS_RING
);

/** A small square icon button inside a drawer (cancel a queued message). */
export const SMALL_ICON_BUTTON_CLASS = classNames(
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-(--radius-small) text-ink-3 hover:bg-select-2 hover:text-ink-1 [&_svg]:size-3.5",
  HIT_TARGET,
  FOCUS_RING
);

/** The context strip under the box: where a draft runs, and its base branch. */
export const CONTEXT_STRIP_CLASS =
  "mx-auto flex w-[calc(100%-2*var(--space-4))] min-w-0 items-center gap-(--space-1) px-(--space-1) pt-(--space-1) text-ink-3";

/** A context strip control: quiet text with its glyph. */
export const CONTEXT_CONTROL_CLASS = classNames(
  "relative inline-flex h-7 min-w-0 cursor-pointer items-center gap-(--space-1) whitespace-nowrap rounded-(--radius-small) px-(--space-1-5) text-ink-3 hover:bg-select-1 hover:text-ink-2 aria-expanded:bg-select-2 disabled:cursor-default disabled:hover:bg-transparent [&_svg]:size-3.5 [&_svg]:shrink-0",
  TYPE.small,
  HIT_TARGET,
  FOCUS_RING,
  FEEDBACK_MOTION
);

/** A started thread's fact in the strip: the control's words and glyph, not a control. */
export const CONTEXT_FACT_CLASS = classNames(
  "inline-flex h-7 min-w-0 items-center gap-(--space-1) whitespace-nowrap px-(--space-1-5) text-ink-3 [&_svg]:size-3.5 [&_svg]:shrink-0",
  TYPE.small
);
