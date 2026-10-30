// The `next` settings page's controls (plan look track L7): a native select and a switch in the
// Stone look, each `--hit-target` tall on a coarse pointer with the focus ring on keyboard focus
// only and no resting shadow. Both keep @foldkit/ui's wiring (the label's `for`, the switch's
// `role="switch"` and `aria-checked`) and the ids the judges find them by.

import * as Select from "@foldkit/ui/select";
import * as Switch from "@foldkit/ui/switch";
import type { Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import type { SelectOption } from "../../ui/Select.ts";
import {
  DISABLED,
  FEEDBACK_MOTION,
  FOCUS_RING,
  HIT_TARGET,
  TYPE,
} from "../ui/Classes.ts";

import "./settings.css";

const SELECT_CLASS = classNames(
  "h-8 w-full min-w-36 max-w-full cursor-pointer rounded-(--radius-small) border border-stroke-2 bg-surface-sunken px-(--space-2) text-ink-1",
  TYPE.ui,
  HIT_TARGET,
  FOCUS_RING,
  FEEDBACK_MOTION,
  DISABLED
);

/** A select's state and wiring; its label is for assistive technology, the row says it aloud. */
export interface SelectConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<SelectOption>;
  readonly isDisabled: boolean;
  readonly onChange: (value: string) => Message;
}

/** A labelled native select. */
export const select = <Message>(
  h: HtmlBuilder<Message>,
  config: SelectConfig<Message>
): Html =>
  Select.view(
    {
      id: config.id,
      value: config.value,
      isDisabled: config.isDisabled,
      onChange: config.onChange,
      toView: (attributes) =>
        h.div(
          [h.Class("flex w-full min-w-0 flex-col")],
          [
            h.label([...attributes.label, h.Class("sr-only")], [config.label]),
            h.select(
              [
                ...attributes.select,
                h.DataAttribute("slot", "select-trigger"),
                h.Class(SELECT_CLASS),
              ],
              config.options.map((option) =>
                h.option(
                  [
                    h.Key(option.value),
                    h.Value(option.value),
                    h.Selected(option.value === config.value),
                  ],
                  [option.label]
                )
              )
            ),
          ]
        ),
    },
    h
  );

/** A switch's state and wiring. */
export interface SwitchConfig<Message> {
  readonly id: string;
  readonly label: string;
  /** Whether the label shows beside the switch, or is for assistive technology only. */
  readonly showLabel: boolean;
  readonly isChecked: boolean;
  readonly isDisabled: boolean;
  readonly onToggle: (isChecked: boolean) => Message;
}

const SWITCH_CLASS = classNames(
  "group/switch relative inline-flex h-8 w-11 shrink-0 cursor-pointer items-center justify-center rounded-(--radius-round)",
  HIT_TARGET,
  FOCUS_RING,
  DISABLED
);

const TRACK_CLASS =
  "flex h-5 w-9 items-center rounded-(--radius-round) border border-stroke-2 bg-select-2 p-0.5 transition-[background-color] duration-(--duration-feedback) group-aria-checked/switch:border-transparent group-aria-checked/switch:bg-accent-fill";

const THUMB_CLASS =
  "block size-3.5 rounded-(--radius-round) bg-ink-2 transition-transform duration-(--duration-feedback) group-aria-checked/switch:translate-x-4 group-aria-checked/switch:bg-accent-ink";

/** A switch: the button is the size a finger hits, the track and thumb sit inside it. */
export const switchControl = <Message>(
  h: HtmlBuilder<Message>,
  config: SwitchConfig<Message>
): Html =>
  Switch.view(
    {
      id: config.id,
      isChecked: config.isChecked,
      isDisabled: config.isDisabled,
      onToggle: config.onToggle,
      toView: (attributes) =>
        h.div(
          [h.Class("flex items-center gap-(--space-2)")],
          [
            h.button(
              [
                ...attributes.button,
                h.DataAttribute("slot", "switch"),
                h.Class(SWITCH_CLASS),
              ],
              [
                h.span(
                  [h.Class(TRACK_CLASS)],
                  [
                    h.span([
                      h.DataAttribute("slot", "switch-thumb"),
                      h.Class(THUMB_CLASS),
                    ]),
                  ]
                ),
              ]
            ),
            h.label(
              [
                ...attributes.label,
                h.Class(config.showLabel ? `text-ink-1 ${TYPE.ui}` : "sr-only"),
              ],
              [config.label]
            ),
            h.input([...attributes.hiddenInput, h.Type("hidden")]),
          ]
        ),
    },
    h
  );
