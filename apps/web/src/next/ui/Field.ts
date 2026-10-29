// The `next` input and textarea shells: a visible label, the shell around the control (its stroke,
// ground and focus ring, with an optional leading glyph and trailing actions), and below it a hint
// or, when the value is refused, an error with its mark. The control draws no ring of its own; the
// shell draws one while the control has focus. States: rest, hover, focus, disabled, invalid.
//
// The composer is not built on these: its editor and its keys are its own (`composer/Editor.ts`).
// These are for the short fields phase 2 asks for: a question's custom answer, a budget, a
// workflow's run-on-one item.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import { Option } from "effect";
import type {
  Attribute,
  Html,
  HtmlBuilder,
  TextareaAttribute,
} from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_WITHIN_RING,
  HIT_HEIGHT,
  TYPE,
  WEIGHT_MEDIUM,
} from "./Classes.ts";
import { statusGlyph } from "./Glyph.ts";

/** A field's words and state, shared by the input and textarea shells. */
export interface FieldConfig<Message> {
  /** The control's id; the label, hint and error ids derive from it. Unique on the page. */
  readonly id: string;
  readonly label: string;
  /** Help under the shell, shown while there is no error. */
  readonly hint: Option.Option<string>;
  /** Why the value is refused; some marks the field invalid. */
  readonly error: Option.Option<string>;
  readonly isDisabled: boolean;
  /** A glyph inside the shell before the control. */
  readonly leading: Option.Option<Html>;
  /** Actions inside the shell after the control: a clear or a send button. */
  readonly trailing: ReadonlyArray<Html>;
  /** More attributes on the shell: `data-hover` and `data-focus` in the catalogue. */
  readonly shellAttributes: ReadonlyArray<Attribute<Message>>;
}

/** A field with no hint, error, glyph or actions. Spread over it to configure one. */
export const fieldDefaults = <Message>(
  id: string,
  label: string
): FieldConfig<Message> => ({
  id,
  label,
  hint: Option.none(),
  error: Option.none(),
  isDisabled: false,
  leading: Option.none(),
  trailing: [],
  shellAttributes: [],
});

/** The control's value and what typing sends. */
export interface ControlConfig<Message> {
  readonly value: string;
  readonly placeholder: Option.Option<string>;
  readonly onInput: Option.Option<(value: string) => Message>;
}

const SHELL = classNames(
  "flex min-w-0 items-center gap-(--space-2) rounded-(--radius-small) border border-stroke-2 bg-surface-sunken px-(--space-2) text-ink-1 hover:border-stroke-focus/60 data-hover:border-stroke-focus/60 aria-invalid:border-tone-failed aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [&>[data-glyph]]:text-ink-3",
  FOCUS_WITHIN_RING,
  FEEDBACK_MOTION
);

const CONTROL = classNames(
  "min-w-0 flex-1 bg-transparent text-ink-1 outline-none placeholder:text-ink-3 disabled:cursor-not-allowed",
  TYPE.ui
);

const describedBy = <Message>(
  h: HtmlBuilder<Message>,
  config: FieldConfig<Message>
): ReadonlyArray<TextareaAttribute<Message>> => {
  // The error replaces the hint, so at most one describes the control.
  const id = Option.isSome(config.error)
    ? Option.some(`${config.id}-error`)
    : Option.as(config.hint, `${config.id}-hint`);

  return Option.toArray(Option.map(id, (each) => h.AriaDescribedBy(each)));
};

const controlAttributes = <Message>(
  h: HtmlBuilder<Message>,
  field: FieldConfig<Message>,
  control: ControlConfig<Message>
): ReadonlyArray<TextareaAttribute<Message>> => [
  h.Id(field.id),
  h.Value(control.value),
  h.Disabled(field.isDisabled),
  ...onlyIf(Option.isSome(field.error), h.AriaInvalid(true)),
  ...describedBy(h, field),
  ...Option.match(control.placeholder, {
    onNone: () => [],
    onSome: (placeholder) => [h.Placeholder(placeholder)],
  }),
  ...Option.match(control.onInput, {
    onNone: () => [],
    onSome: (onInput) => [h.OnInput(onInput)],
  }),
];

const frame = <Message>(
  h: HtmlBuilder<Message>,
  field: FieldConfig<Message>,
  shellAlign: string,
  control: Html
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "field"),
      h.Class("flex min-w-0 flex-col gap-(--space-1-5)"),
    ],
    [
      h.label(
        [
          h.For(field.id),
          h.Class(classNames("text-ink-1", TYPE.ui, WEIGHT_MEDIUM)),
        ],
        [field.label]
      ),
      h.div(
        [
          h.DataAttribute("slot", "field-shell"),
          ...onlyIf(Option.isSome(field.error), h.AriaInvalid(true)),
          ...onlyIf(field.isDisabled, h.AriaDisabled(true)),
          ...field.shellAttributes,
          h.Class(classNames(SHELL, shellAlign)),
        ],
        [
          Option.getOrElse(field.leading, () => h.empty),
          control,
          ...field.trailing,
        ]
      ),
      Option.match(field.error, {
        onNone: () =>
          Option.match(field.hint, {
            onNone: () => h.empty,
            onSome: (hint) =>
              h.p(
                [
                  h.Id(`${field.id}-hint`),
                  h.Class(classNames("text-ink-2", TYPE.small)),
                ],
                [hint]
              ),
          }),
        onSome: (error) =>
          h.p(
            [
              h.Id(`${field.id}-error`),
              h.Class(
                classNames(
                  "flex items-start gap-(--space-1) text-tone-failed",
                  TYPE.small
                )
              ),
            ],
            [statusGlyph(h, "failed", "small"), h.span([], [error])]
          ),
      }),
    ]
  );

/** A one-line field: label, shell with an input, and its hint or error. */
export const inputField = <Message>(
  h: HtmlBuilder<Message>,
  field: FieldConfig<Message>,
  control: ControlConfig<Message>
): Html =>
  frame(
    h,
    field,
    "",
    h.input([
      h.Type("text"),
      ...controlAttributes(h, field, control),
      h.Class(classNames(CONTROL, "h-9", HIT_HEIGHT)),
    ])
  );

/** A multi-line field: label, shell with a textarea of `rows` lines, and its hint or error. */
export const textareaField = <Message>(
  h: HtmlBuilder<Message>,
  field: FieldConfig<Message>,
  control: ControlConfig<Message>,
  rows: number
): Html =>
  frame(
    h,
    field,
    "items-start",
    h.textarea([
      h.Rows(rows),
      ...controlAttributes(h, field, control),
      h.Class(classNames(CONTROL, "resize-y py-(--space-2)")),
    ])
  );
