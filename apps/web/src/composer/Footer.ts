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
// select lists the four modes with every one but full access marked as applying later. The classic
// footer view went with the classic views (W-6): what is left is the measuring Mount and the menus'
// rows, which the footer's view (`FooterView.ts`) draws.
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

import type { ControlsMeasurement } from "@cairn/client-logic/FooterLayout";
import {
  LATER_PHASE_NOTE,
  runtimeModeOptions,
  runtimeModePresentation,
} from "@cairn/client-logic/RuntimeMode";
import type { ThinkingLevel } from "@cairn/protocol/Models";
import { Effect, Option, Queue, Stream } from "effect";
import { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Check } from "lucide";

import { canPickRuntimeMode, runtimeModeOf } from "./Drafts.ts";
import { icon } from "./Icon.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { resolvedThinking, thinkingLabel, thinkingLevels } from "./Models.ts";
import { MENU_ITEM_CLASS } from "./PopoverClasses.ts";

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

/** The footer's foldable blocks, in order: thinking (when the model has levels), then mode. */
const footerBlocks = (model: Model): ReadonlyArray<"traits" | "mode"> =>
  thinkingLevels(model).length > 0 ? ["traits", "mode"] : ["mode"];

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
  h.div([h.Class("px-2 py-1.5 font-medium text-ink-2 text-xs")], [text]);

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

/** The four runtime modes, as menu rows; a mode not enforced yet (Auto) says it applies later. */
export const modeItems = (
  model: Model,
  h: HtmlBuilder<Message>
): ReadonlyArray<Html> => {
  const current = runtimeModeOf(model);
  const editable = canPickRuntimeMode(model);

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
          [h.Class("text-ink-2 text-xs")],
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
