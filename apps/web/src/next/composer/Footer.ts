// The `next` composer's footer (plan look track L7): the classic footer's behaviour, drawn in the
// Stone look. The left cluster holds the model, the thinking level and the runtime mode as quiet
// pills, folded by the same measured layout as classic (`composer/Footer.ts`'s `MeasureFooter`
// and client-logic's `FooterLayout.ts`), so a narrow composer shows a block's glyph only, then
// moves it into the overflow menu; the right cluster holds the plan meter, the paperclip and the
// round send button (Stop while a run works with nothing typed). Send and Stop are the accent
// fill, the main ink: the look has no other action colour.
//
// The hooks the judges and the measurement read are classic's: `data-chat-composer-*`,
// `data-chat-provider-model-picker(-label)`, `data-resting-block`, `data-composer-control-label`,
// `data-resting-controls-overflow`, `data-composer-shortcut` and the test ids.

import { shouldUseCompactComposerFooter } from "@cairn/client-logic/FooterLayout";
import { onlyIf } from "@cairn/client-logic/OnlyIf";
import { runtimeModePresentation } from "@cairn/client-logic/RuntimeMode";
import type { RuntimeModeIcon } from "@cairn/client-logic/RuntimeMode";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  Bot,
  Brain,
  CornerUpRight,
  Ellipsis,
  ListPlus,
  Lock,
  LockOpen,
  Paperclip,
  PenLine,
  Sparkles,
} from "lucide";

import { hasAttachments } from "../../attachments/Update.ts";
import { ATTACH_ACCEPT, pickedFiles } from "../../attachments/View.ts";
import { activeDraft, draftKey, isDraftTarget } from "../../composer/Drafts.ts";
import { footerBlocks, MeasureFooter } from "../../composer/Footer.ts";
import { icon } from "../../composer/Icon.ts";
import type { IconNode } from "../../composer/Icon.ts";
import { Message } from "../../composer/Message.ts";
import { Popover } from "../../composer/Model.ts";
import type { Model } from "../../composer/Model.ts";
import {
  modelLabel,
  resolvedModel,
  resolvedThinking,
  thinkingLabel,
} from "../../composer/Models.ts";
import { isThreadRunning } from "../../composer/Update.ts";
import { usageMeterView } from "../../composer/UsageMeter.ts";
import {
  ACTIONS_CLASS,
  ATTACH_CLASS,
  ATTACH_INPUT_CLASS,
  BLOCK_CLASS,
  CONTROLS_CLASS,
  FOOTER_CLASS,
  PILL_CLASS,
  ROUND_ACTION_CLASS,
} from "./Classes.ts";

const RUNTIME_ICONS: Readonly<Record<RuntimeModeIcon, IconNode>> = {
  lock: Lock,
  "pen-line": PenLine,
  sparkles: Sparkles,
  "lock-open": LockOpen,
};

const isOpen = (model: Model, tag: Popover["_tag"]): boolean =>
  Option.exists(model.popover, (popover) => popover._tag === tag);

const runtimeModeOf = (model: Model): RuntimeMode =>
  isDraftTarget(model)
    ? activeDraft(model).runtimeMode
    : Option.match(model.context.thread, {
        onNone: () => "full-access",
        onSome: (thread) => thread.runtimeMode,
      });

const controlIcon = (
  h: HtmlBuilder<Message>,
  node: IconNode,
  name: string
): Html => icon(h, node, name, "", 2, "composer-control-icon");

const controlLabel = (
  h: HtmlBuilder<Message>,
  text: string,
  iconOnly: boolean
): Html =>
  h.span(
    [
      h.DataAttribute("composer-control-label", "true"),
      h.Class(iconOnly ? "sr-only" : "min-w-0 truncate"),
    ],
    [text]
  );

/** One foldable block: a hidden block stays drawn (invisible) so it can be measured. */
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
      ...onlyIf(hidden, h.AriaHidden(true), h.Inert(true)),
      h.Class(
        hidden
          ? `${BLOCK_CLASS} pointer-events-none invisible absolute`
          : BLOCK_CLASS
      ),
    ],
    content
  );

const pickerButton = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.DataAttribute("chat-provider-model-picker", "true"),
      h.DataAttribute("slot", "popover-trigger"),
      h.AriaHasPopup("dialog"),
      h.AriaExpanded(isOpen(model, "ModelPicker")),
      h.Class(`${PILL_CLASS} min-w-13 shrink`),
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
      icon(h, Bot, "bot", ""),
      h.span(
        [
          h.DataAttribute("chat-provider-model-picker-label", "true"),
          h.Class("min-w-0 flex-1 truncate"),
        ],
        [modelLabel(model)]
      ),
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
        h.DataAttribute("composer-shortcut", "composer.effort"),
        h.Class(PILL_CLASS),
        h.OnClick(Message.OpenedPopover({ popover: Popover.Thinking() })),
      ],
      [controlIcon(h, Brain, "brain"), controlLabel(h, label, iconOnly)]
    ),
  ]);
};

const modeBlock = (
  model: Model,
  hidden: boolean,
  iconOnly: boolean,
  h: HtmlBuilder<Message>
): Html => {
  const presentation = runtimeModePresentation[runtimeModeOf(model)];

  return block(h, "mode", hidden, iconOnly, [
    h.button(
      [
        h.Type("button"),
        h.Role("combobox"),
        h.AriaHasPopup("listbox"),
        h.AriaExpanded(isOpen(model, "RuntimeMode")),
        h.AriaLabel("Runtime mode"),
        h.DataAttribute("composer-shortcut", "composer.mode"),
        h.Class(PILL_CLASS),
        h.OnClick(Message.OpenedPopover({ popover: Popover.RuntimeMode() })),
      ],
      [
        controlIcon(h, RUNTIME_ICONS[presentation.icon], presentation.icon),
        controlLabel(h, presentation.label, iconOnly),
      ]
    ),
  ]);
};

const overflowHolder = (model: Model, h: HtmlBuilder<Message>): Html => {
  const needed = model.footer.layout.hiddenCount > 0;
  const blocks = footerBlocks(model);

  // The overflow button carries the shortcut of every block folded into it, as classic's does.
  const shortcut = blocks
    .slice(blocks.length - model.footer.layout.hiddenCount)
    .includes("traits")
    ? "composer.mode composer.effort"
    : "composer.mode";

  return h.div(
    [
      h.DataAttribute("resting-controls-overflow", "true"),
      ...onlyIf(!needed, h.AriaHidden(true), h.Inert(true)),
      h.Class(
        needed
          ? "min-w-0 shrink-0"
          : "pointer-events-none invisible absolute min-w-0 shrink-0"
      ),
    ],
    [
      h.button(
        [
          h.Type("button"),
          h.AriaLabel("More composer controls"),
          h.AriaHasPopup("menu"),
          h.AriaExpanded(isOpen(model, "Overflow")),
          h.DataAttribute("composer-shortcut", shortcut),
          h.DataAttribute("slot", "menu-trigger"),
          h.Class(PILL_CLASS),
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
      h.Class(ROUND_ACTION_CLASS),
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

/** What the send button says, and the glyph it draws while a run works. */
interface SendLook {
  readonly label: string;
  readonly busyIcon: Option.Option<"queue" | "steer">;
}

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
      h.Class(ROUND_ACTION_CLASS),
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

/** The paperclip: a label whose file input covers it, so the input is what a finger hits. */
const attachButton = (h: HtmlBuilder<Message>): Html =>
  h.label(
    [
      h.DataAttribute("slot", "field-shell"),
      h.Title("Attach files"),
      h.Class(ATTACH_CLASS),
    ],
    [
      // In a span, so the look rules do not read the paperclip as a field's leading glyph.
      h.span([h.Class("contents")], [icon(h, Paperclip, "paperclip", "")]),
      h.input([
        h.Type("file"),
        h.Multiple(true),
        h.Accept(ATTACH_ACCEPT),
        h.AriaLabel("Attach files"),
        h.Class(ATTACH_INPUT_CLASS),
        h.OnFileChange((files) =>
          Message.GotAttachmentsMessage({ message: pickedFiles(files) })
        ),
      ]),
    ]
  );

/** The footer: the left cluster folded by the measured layout, and the actions. */
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
          ...blocks.map((name, index) =>
            name === "traits"
              ? traitsBlock(model, index >= hiddenFrom, index >= iconFrom, h)
              : modeBlock(model, index >= hiddenFrom, index >= iconFrom, h)
          ),
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
          usageMeterView(h, {
            usage: model.context.usage,
            provider: Option.match(resolvedModel(model), {
              onNone: () => "",
              onSome: (ref) => ref.provider,
            }),
          }),
          attachButton(h),
          h.span(
            [
              h.DataAttribute("slot", "tooltip-trigger"),
              h.Class("inline-flex"),
            ],
            [
              running && !hasContent
                ? stopButton(h)
                : sendButton(model, hasContent, h),
            ]
          ),
        ]
      ),
    ]
  );
};
