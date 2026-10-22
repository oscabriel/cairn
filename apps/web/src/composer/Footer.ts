// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// apps/web/src/components/chat/ChatComposer.tsx (the footer, lines 5144 to 5330 and 7254 to 7330),
// ComposerPrimaryActions.tsx, CompactComposerControlsMenu.tsx and
// restingComposerControlsMeasurement.ts. Kept: the footer's left cluster (model picker, then the
// thinking and runtime-mode blocks, then an overflow menu) and right cluster (attach, then send or
// Stop), their data attributes and class strings, and the measured folding: blocks go icon-only
// from the last one back, then hide into "More composer controls", then the cluster hides; the
// measurement reads natural and icon-only widths so a folded block can come back. Changed: the
// measuring runs in a Foldkit Mount that reports `MeasuredFooter` and client-logic decides the
// layout; t3code's traits become one thinking select (pi exposes thinking levels), and the mode
// select lists the four modes with every one but full access marked as applying later.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { shouldUseCompactComposerFooter } from "@cairn/client-logic/FooterLayout";
import type { ControlsMeasurement } from "@cairn/client-logic/FooterLayout";
import {
  LATER_PHASE_NOTE,
  runtimeModeOptions,
  runtimeModePresentation,
} from "@cairn/client-logic/RuntimeMode";
import type { RuntimeModeIcon } from "@cairn/client-logic/RuntimeMode";
import type { ThinkingLevel } from "@cairn/protocol/Models";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import { Effect, Option, Queue, Stream } from "effect";
import { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  Brain,
  Check,
  ChevronDown,
  CornerUpRight,
  Ellipsis,
  ListPlus,
  Lock,
  LockOpen,
  PenLine,
  Sparkles,
} from "lucide";

import { hasAttachments } from "../attachments/Update.ts";
import { attachButton } from "./AttachmentTray.ts";
import {
  ACTIONS_CLASS,
  BLOCK_CLASS,
  CONTROL_BASE_CLASS,
  CONTROLS_CLASS,
  FOOTER_CLASS,
  FOOTER_CONTROL_CLASS,
  MENU_ITEM_CLASS,
  SEND_CLASS,
  SEPARATOR_CLASS,
  STOP_CLASS,
} from "./Classes.ts";
import { activeDraft, draftKey, isDraftTarget } from "./Drafts.ts";
import { icon } from "./Icon.ts";
import type { IconNode } from "./Icon.ts";
import { Message } from "./Message.ts";
import { Popover } from "./Model.ts";
import type { Model } from "./Model.ts";
import {
  modelLabel,
  resolvedThinking,
  thinkingLabel,
  thinkingLevels,
} from "./Models.ts";
import { isThreadRunning } from "./Update.ts";

const RUNTIME_ICONS: Readonly<Record<RuntimeModeIcon, IconNode>> = {
  lock: Lock,
  "pen-line": PenLine,
  sparkles: Sparkles,
  "lock-open": LockOpen,
};

const parseWidth = (value: string): number => {
  const parsed = Number(value.replace(/px$/u, ""));

  return Number.isFinite(parsed) ? parsed : 0;
};

const outerWidth = (element: Element): number => {
  const { width } = element.getBoundingClientRect();

  if (width === 0) {
    return 0;
  }

  const style = getComputedStyle(element);

  return (
    width +
    parseWidth(style.marginInlineStart) +
    parseWidth(style.marginInlineEnd)
  );
};

const blockWidths = (block: Element) => {
  let natural = outerWidth(block);
  let iconOnly = natural;

  for (const label of block.querySelectorAll<HTMLElement>(
    "[data-composer-control-label]"
  )) {
    const inFlow = getComputedStyle(label).position !== "absolute";

    const gap = label.parentElement
      ? parseWidth(getComputedStyle(label.parentElement).columnGap)
      : 0;

    const rendered = inFlow ? label.getBoundingClientRect().width : 0;

    natural += label.scrollWidth - rendered + (inFlow ? 0 : gap);
    iconOnly -= rendered + (inFlow ? gap : 0);
  }

  return { natural, iconOnly: Math.min(natural, iconOnly) };
};

/** Reads the footer's widths the way t3code's `measureRestingComposerControls` does. */
const measure = (
  footer: Element
): Option.Option<{
  width: number;
  hostWidth: number;
  measurement: ControlsMeasurement;
}> => {
  const controls = footer.querySelector<HTMLElement>(
    "[data-chat-composer-controls]"
  );

  const picker = footer.querySelector<HTMLElement>(
    "[data-chat-provider-model-picker]"
  );

  const shell = footer.closest("[data-slot=composer-shell]");

  if (controls === null || picker === null) {
    return Option.none();
  }

  const controlsStyle = getComputedStyle(controls);
  const pickerStyle = getComputedStyle(picker);

  const label = picker.querySelector<HTMLElement>(
    "[data-chat-provider-model-picker-label]"
  );

  const hiddenLabel =
    label === null ? 0 : Math.max(0, label.scrollWidth - label.clientWidth);

  const margins =
    parseWidth(pickerStyle.marginInlineStart) +
    parseWidth(pickerStyle.marginInlineEnd);

  const blocks = [...controls.querySelectorAll("[data-resting-block]")].map(
    blockWidths
  );

  const overflow = controls.querySelector("[data-resting-controls-overflow]");

  return Option.some({
    width: (shell ?? footer).getBoundingClientRect().width,
    hostWidth:
      controls.clientWidth -
      parseWidth(controlsStyle.paddingInlineStart) -
      parseWidth(controlsStyle.paddingInlineEnd),
    measurement: {
      gap: parseWidth(controlsStyle.columnGap),
      naturalFixedWidth:
        picker.getBoundingClientRect().width + hiddenLabel + margins,
      minimumFixedWidth: parseWidth(pickerStyle.minWidth) + margins,
      blockWidths: blocks.map(({ natural }) => natural),
      iconOnlyBlockWidths: Option.some(blocks.map(({ iconOnly }) => iconOnly)),
      overflowWidth:
        overflow === null
          ? 0
          : outerWidth(overflow.firstElementChild ?? overflow),
    },
  });
};

const OBSERVED =
  "[data-chat-composer-controls], [data-resting-block], [data-composer-control-label], [data-chat-provider-model-picker-label]";

/**
 * Measures the footer whenever it, the composer or one of its labels resizes, and reports the
 * widths when they changed. The layout decision is client-logic's, in update.
 */
export const MeasureFooter = Mount.defineStream("MeasureFooter", {
  messages: [Message.MeasuredFooter],
  execute: ({ element }) =>
    Stream.callback<typeof Message.MeasuredFooter.Type>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          let last = "";

          const report = () => {
            Option.map(measure(element), (measured) => {
              const key = JSON.stringify(measured);

              if (key !== last) {
                last = key;
                Queue.offerUnsafe(queue, Message.MeasuredFooter(measured));
              }
            });
          };

          const resize = new ResizeObserver(report);

          const observeAll = () => {
            resize.disconnect();
            resize.observe(element);
            Option.map(
              Option.fromNullishOr(
                element.closest("[data-slot=composer-shell]")
              ),
              (shell) => {
                resize.observe(shell);
              }
            );

            for (const target of element.querySelectorAll(OBSERVED)) {
              resize.observe(target);
            }

            report();
          };

          const mutations = new MutationObserver(observeAll);

          mutations.observe(element, {
            childList: true,
            subtree: true,
            characterData: true,
          });
          observeAll();

          return { resize, mutations };
        }),
        ({ mutations, resize }) =>
          Effect.sync(() => {
            mutations.disconnect();
            resize.disconnect();
          })
      ).pipe(Effect.flatMap(() => Effect.never))
    ),
});

const chevron = (h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Attribute("aria-hidden", "true"), h.Class("flex items-center")],
    [
      icon(
        h,
        ChevronDown,
        "chevron-down",
        "shrink-0 size-3.5 text-icon-muted",
        2.25
      ),
    ]
  );

const controlIcon = (
  h: HtmlBuilder<Message>,
  node: IconNode,
  name: string
): Html =>
  h.span(
    [h.DataAttribute("composer-control-icon", "true"), h.Class("inline-flex")],
    [icon(h, node, name, "shrink-0 size-4")]
  );

const controlLabel = (
  h: HtmlBuilder<Message>,
  text: string,
  iconOnly: boolean
): Html =>
  h.span(
    [
      h.DataAttribute("composer-control-label", "true"),
      h.Class(iconOnly ? "sr-only" : "flex-1 truncate"),
    ],
    [text]
  );

/** One foldable block: hidden blocks stay rendered (invisible) so they can be measured. */
const block = (
  h: HtmlBuilder<Message>,
  name: string,
  hidden: boolean,
  iconOnly: boolean,
  content: ReadonlyArray<Html>
): Html =>
  h.div(
    [
      h.Key(name),
      h.DataAttribute("resting-block", name),
      h.DataAttribute("composer-block-icon-only", String(iconOnly)),
      h.DataAttribute("composer-block-hidden", String(hidden)),
      ...(hidden ? [h.AriaHidden(true), h.Inert(true)] : []),
      h.Class(
        hidden
          ? `${BLOCK_CLASS} pointer-events-none invisible absolute`
          : BLOCK_CLASS
      ),
    ],
    [
      h.div([
        h.DataAttribute("orientation", "vertical"),
        h.Role("separator"),
        h.Attribute("aria-orientation", "vertical"),
        h.DataAttribute("slot", "separator"),
        h.Class(SEPARATOR_CLASS),
      ]),
      ...content,
    ]
  );

const isOpen = (model: Model, tag: Popover["_tag"]): boolean =>
  Option.exists(model.popover, (popover) => popover._tag === tag);

/** The footer's foldable blocks, in order: thinking (when the model has levels), then mode. */
export const footerBlocks = (model: Model): ReadonlyArray<"traits" | "mode"> =>
  thinkingLevels(model).length > 0 ? ["traits", "mode"] : ["mode"];

const runtimeModeOf = (model: Model): RuntimeMode =>
  isDraftTarget(model)
    ? activeDraft(model).runtimeMode
    : Option.match(model.context.thread, {
        onNone: () => "full-access",
        onSome: (thread) => thread.runtimeMode,
      });

const pickerButton = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.DataAttribute("chat-provider-model-picker", "true"),
      h.DataAttribute("slot", "popover-trigger"),
      h.DataAttribute("testid", "composer-model-picker"),
      h.AriaHasPopup("dialog"),
      h.AriaExpanded(isOpen(model, "ModelPicker")),
      h.Class(
        `${CONTROL_BASE_CLASS} ${FOOTER_CONTROL_CLASS} shrink justify-between whitespace-nowrap -ms-2.5 min-w-13`
      ),
      h.OnClick(
        Message.OpenedPopover({
          popover: Popover.ModelPicker({
            query: "",
            highlighted: Option.none(),
          }),
        })
      ),
    ],
    [
      h.span(
        [h.Class("flex min-w-0 flex-1 items-center gap-1.5")],
        [
          h.span(
            [
              h.DataAttribute("chat-provider-model-picker-label", "true"),
              h.Class("min-w-0 flex-1 overflow-hidden truncate"),
            ],
            [modelLabel(model)]
          ),
        ]
      ),
      chevron(h),
    ]
  );

const traitsBlock = (
  model: Model,
  hidden: boolean,
  iconOnly: boolean,
  h: HtmlBuilder<Message>
): Html => {
  const label = Option.match(resolvedThinking(model), {
    onNone: () => "Thinking",
    onSome: thinkingLabel,
  });

  return block(h, "traits", hidden, iconOnly, [
    h.button(
      [
        h.Type("button"),
        h.AriaLabel(label),
        h.AriaHasPopup("menu"),
        h.AriaExpanded(isOpen(model, "Thinking")),
        h.DataAttribute("testid", "composer-thinking"),
        h.Class(
          `${CONTROL_BASE_CLASS} ${FOOTER_CONTROL_CLASS} justify-center shrink-0 whitespace-nowrap`
        ),
        h.OnClick(Message.OpenedPopover({ popover: Popover.Thinking() })),
      ],
      [
        controlIcon(h, Brain, "brain"),
        controlLabel(h, label, iconOnly),
        chevron(h),
      ]
    ),
  ]);
};

const modeBlock = (
  model: Model,
  hidden: boolean,
  iconOnly: boolean,
  h: HtmlBuilder<Message>
): Html => {
  const mode = runtimeModeOf(model);
  const presentation = runtimeModePresentation[mode];

  return block(h, "mode", hidden, iconOnly, [
    h.button(
      [
        h.Type("button"),
        h.Role("combobox"),
        h.AriaHasPopup("listbox"),
        h.AriaExpanded(isOpen(model, "RuntimeMode")),
        h.AriaLabel("Runtime mode"),
        h.DataAttribute("testid", "composer-runtime-mode"),
        h.Class(
          `${CONTROL_BASE_CLASS} ${FOOTER_CONTROL_CLASS} shrink-0 justify-center whitespace-nowrap`
        ),
        h.OnClick(Message.OpenedPopover({ popover: Popover.RuntimeMode() })),
      ],
      [
        controlIcon(h, RUNTIME_ICONS[presentation.icon], presentation.icon),
        controlLabel(h, presentation.label, iconOnly),
        chevron(h),
      ]
    ),
  ]);
};

const overflowHolder = (model: Model, h: HtmlBuilder<Message>): Html => {
  const needed = model.footer.layout.hiddenCount > 0;

  return h.div(
    [
      h.DataAttribute("resting-controls-overflow", "true"),
      ...(needed ? [] : [h.AriaHidden(true), h.Inert(true)]),
      h.Class(
        needed
          ? "min-w-0 shrink-0"
          : "min-w-0 shrink-0 pointer-events-none invisible absolute"
      ),
    ],
    [
      h.button(
        [
          h.Type("button"),
          h.AriaLabel("More composer controls"),
          h.AriaHasPopup("menu"),
          h.AriaExpanded(isOpen(model, "Overflow")),
          h.DataAttribute("slot", "menu-trigger"),
          h.DataAttribute("testid", "composer-overflow"),
          h.Class(
            `${CONTROL_BASE_CLASS} ${FOOTER_CONTROL_CLASS} justify-center whitespace-nowrap shrink-0`
          ),
          h.OnClick(Message.OpenedPopover({ popover: Popover.Overflow() })),
        ],
        [controlIcon(h, Ellipsis, "ellipsis")]
      ),
    ]
  );
};

const STOP_ICON_PATH =
  "M3.5 2h5A1.5 1.5 0 0 1 10 3.5v5A1.5 1.5 0 0 1 8.5 10h-5A1.5 1.5 0 0 1 2 8.5v-5A1.5 1.5 0 0 1 3.5 2Z";

const SEND_ICON_PATH = "M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5";

const stopButton = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.AriaLabel("Stop generation"),
      h.DataAttribute("testid", "composer-stop"),
      h.Class(STOP_CLASS),
      h.OnClick(Message.ClickedStop({ clearQueue: false })),
    ],
    [
      h.svg(
        [
          h.Attribute("width", "12"),
          h.Attribute("height", "12"),
          h.Attribute("viewBox", "0 0 12 12"),
          h.Attribute("fill", "currentColor"),
          h.Attribute("aria-hidden", "true"),
        ],
        [h.path([h.Attribute("d", STOP_ICON_PATH)])]
      ),
    ]
  );

/** What the send button says, and the icon it draws while a run is busy. */
interface SendLook {
  readonly label: string;
  readonly busyIcon: Option.Option<"queue" | "steer">;
}

/** What the send button says and draws while a run is busy or idle. */
const sendLook = (model: Model): SendLook => {
  if (!isThreadRunning(model)) {
    return { label: "Submit message", busyIcon: Option.none() };
  }

  return model.settings.followUpBehavior === "queue"
    ? { label: "Queue message", busyIcon: Option.some("queue") }
    : { label: "Steer message", busyIcon: Option.some("steer") };
};

const sendButton = (
  model: Model,
  hasContent: boolean,
  h: HtmlBuilder<Message>
): Html => {
  const look = sendLook(model);

  return h.button(
    [
      h.Type("button"),
      h.AriaLabel(look.label),
      h.DataAttribute("testid", "composer-send"),
      h.Disabled(!hasContent),
      h.Class(SEND_CLASS),
      h.OnClick(Message.ClickedSend({ alternate: false })),
    ],
    [
      Option.match(look.busyIcon, {
        onNone: () =>
          h.svg(
            [
              h.Attribute("width", "14"),
              h.Attribute("height", "14"),
              h.Attribute("viewBox", "0 0 14 14"),
              h.Attribute("fill", "none"),
              h.Attribute("aria-hidden", "true"),
            ],
            [
              h.path([
                h.Attribute("d", SEND_ICON_PATH),
                h.Attribute("stroke", "currentColor"),
                h.Attribute("stroke-width", "1.8"),
                h.Attribute("stroke-linecap", "round"),
                h.Attribute("stroke-linejoin", "round"),
              ]),
            ]
          ),
        onSome: (kind) =>
          kind === "queue"
            ? icon(h, ListPlus, "list-plus", "size-4")
            : icon(h, CornerUpRight, "corner-up-right", "size-4"),
      }),
    ]
  );
};

/** The footer: the left cluster's controls folded by the measured layout, and the actions. */
export const footerView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const { layout, width } = model.footer;
  const blocks = footerBlocks(model);
  const draft = activeDraft(model);

  const hasContent =
    draft.text.trim().length > 0 ||
    draft.attachments.length > 0 ||
    Option.exists(draftKey(model), (key) =>
      hasAttachments(model.attachments, key)
    );

  const running = isThreadRunning(model);
  const compact = shouldUseCompactComposerFooter(width, running);
  const hiddenFrom = blocks.length - layout.hiddenCount;
  const iconFrom = blocks.length - layout.iconOnlyCount;

  return h.div(
    [
      h.DataAttribute("chat-composer-footer", "true"),
      h.DataAttribute("chat-composer-footer-compact", String(compact)),
      h.DataAttribute("testid", "composer-footer"),
      h.Class(FOOTER_CLASS),
      h.OnMount(MeasureFooter()),
    ],
    [
      h.div(
        [
          h.DataAttribute("chat-composer-controls", "left"),
          h.DataAttribute("chat-composer-footer-controls", "true"),
          h.DataAttribute("resting-controls-visible", String(layout.visible)),
          h.Class(
            layout.visible ? CONTROLS_CLASS : `${CONTROLS_CLASS} invisible`
          ),
        ],
        [
          pickerButton(model, h),
          ...blocks.map((name, index) => {
            const hidden = index >= hiddenFrom;
            const iconOnly = index >= iconFrom;

            return name === "traits"
              ? traitsBlock(model, hidden, iconOnly, h)
              : modeBlock(model, hidden, iconOnly, h);
          }),
          overflowHolder(model, h),
        ]
      ),
      h.div(
        [
          h.DataAttribute("chat-composer-actions", "right"),
          h.DataAttribute("chat-composer-primary-actions-compact", "false"),
          h.Class(ACTIONS_CLASS),
        ],
        [
          attachButton(
            (message) => Message.GotAttachmentsMessage({ message }),
            h
          ),
          running && !hasContent
            ? stopButton(h)
            : sendButton(model, hasContent, h),
        ]
      ),
    ]
  );
};

const checkSlot = (h: HtmlBuilder<Message>, checked: boolean): Html =>
  checked
    ? icon(h, Check, "check", "ms-auto size-4")
    : h.span([h.Class("ms-auto size-4")]);

const menuItem = (
  h: HtmlBuilder<Message>,
  key: string,
  checked: boolean,
  onClick: Message,
  label: ReadonlyArray<Html | string>
): Html =>
  h.button(
    [
      h.Key(key),
      h.Type("button"),
      h.Role("menuitemradio"),
      h.AriaChecked(checked),
      h.DataAttribute("value", key),
      h.Class(`${MENU_ITEM_CLASS} w-full text-left`),
      h.OnClick(onClick),
    ],
    [
      h.span([h.Class("flex min-w-0 flex-1 flex-col")], label),
      checkSlot(h, checked),
    ]
  );

const groupHeading = (h: HtmlBuilder<Message>, text: string): Html =>
  h.div(
    [h.Class("px-2 py-1.5 font-medium text-muted-foreground text-xs")],
    [text]
  );

/** The thinking levels the model accepts, as menu rows. */
export const thinkingItems = (
  model: Model,
  h: HtmlBuilder<Message>
): ReadonlyArray<Html> => {
  const current = resolvedThinking(model);

  return thinkingLevels(model).map((level: ThinkingLevel) =>
    menuItem(
      h,
      level,
      Option.contains(current, level),
      Message.PickedThinking({ level }),
      [thinkingLabel(level)]
    )
  );
};

/** The four runtime modes, as menu rows; every mode but full access says it applies later. */
export const modeItems = (
  model: Model,
  h: HtmlBuilder<Message>
): ReadonlyArray<Html> => {
  const current = runtimeModeOf(model);
  const editable = isDraftTarget(model);

  return runtimeModeOptions.map((mode) => {
    const presentation = runtimeModePresentation[mode];

    return menuItem(
      h,
      mode,
      current === mode,
      editable ? Message.PickedRuntimeMode({ mode }) : Message.ClosedPopover(),
      [
        h.span([h.Class("font-medium")], [presentation.label]),
        h.span(
          [h.Class("text-muted-foreground text-xs")],
          [
            presentation.isEnforced
              ? presentation.description
              : `${presentation.description} ${LATER_PHASE_NOTE}.`,
          ]
        ),
      ]
    );
  });
};

/** The overflow menu: the blocks the footer hid, under their headings. */
export const overflowItems = (
  model: Model,
  h: HtmlBuilder<Message>
): ReadonlyArray<Html> => {
  const blocks = footerBlocks(model);
  const hidden = blocks.slice(blocks.length - model.footer.layout.hiddenCount);

  return hidden.flatMap((name) =>
    name === "traits"
      ? [groupHeading(h, "Thinking"), ...thinkingItems(model, h)]
      : [groupHeading(h, "Mode"), ...modeItems(model, h)]
  );
};
