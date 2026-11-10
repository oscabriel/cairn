// The composer's footer (plan look track L7), in the Stone look, made to fit one row on a
// phone (the user's 390 px notes): the left cluster is the model pill, with its provider's mark,
// naming the model shortly and its thinking level ("Opus 5.5 · High") and opening the one picker
// that sets both (providers on a rail, the models, the thinking levels in their own band), then the
// runtime mode, whose label the measured layout (`composer/Footer.ts`'s `MeasureFooter` and
// client-logic's `FooterLayout.ts`) drops to its glyph when the row is tight; the right cluster is
// the paperclip and the round send button (Stop while a run works with nothing typed). The plan
// meter lives on the settings page and the thread's usage, not here. Send and Stop are the accent
// fill, the main ink: the look has no other action colour.
//
// The hooks the judges and the measurement read are classic's: `data-chat-composer-*`,
// `data-chat-provider-model-picker(-label)`, `data-resting-block`, `data-composer-control-label`,
// `data-composer-shortcut` and the test ids.

import { shouldUseCompactComposerFooter } from "@cairn/client-logic/FooterLayout";
import { onlyIf } from "@cairn/client-logic/OnlyIf";
import { runtimeModePresentation } from "@cairn/client-logic/RuntimeMode";
import type { RuntimeModeIcon } from "@cairn/client-logic/RuntimeMode";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  CornerUpRight,
  ListPlus,
  Lock,
  LockOpen,
  Paperclip,
  PenLine,
  Sparkles,
} from "lucide";

import { hasAttachments } from "../attachments/Update.ts";
import { ATTACH_ACCEPT, pickedFiles } from "../attachments/View.ts";
import { stopGlyph } from "../ui/Glyph.ts";
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
import { activeDraft, draftKey, runtimeModeOf } from "./Drafts.ts";
import { MeasureFooter } from "./Footer.ts";
import { icon } from "./Icon.ts";
import type { IconNode } from "./Icon.ts";
import { Message } from "./Message.ts";
import { Popover } from "./Model.ts";
import type { Model } from "./Model.ts";
import {
  modelLabel,
  pillLabel,
  providerLabel,
  resolvedModel,
} from "./Models.ts";
import { providerMark } from "./ProviderMark.ts";
import { isThreadRunning } from "./Update.ts";

const RUNTIME_ICONS: Readonly<Record<RuntimeModeIcon, IconNode>> = {
  lock: Lock,
  "pen-line": PenLine,
  sparkles: Sparkles,
  "lock-open": LockOpen,
};

const isOpen = (model: Model, tag: Popover["_tag"]): boolean =>
  Option.exists(model.popover, (popover) => popover._tag === tag);

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
      h.Title(modelLabel(model)),
      h.DataAttribute("composer-shortcut", "composer.effort"),
      h.Class(`${PILL_CLASS} min-w-13 shrink`),
      h.OnClick(
        Message.OpenedPopover({
          popover: Popover.ModelPicker({
            query: "",
            highlighted: Option.none(),
            provider: Option.none(),
          }),
        })
      ),
    ],
    [
      Option.match(resolvedModel(model), {
        // No model yet: an empty square holds the pill's shape until the catalog loads.
        onNone: () => h.span([h.AriaHidden(true), h.Class("size-4 shrink-0")]),
        onSome: (ref) =>
          providerMark(h, ref.provider, providerLabel(ref.provider), "size-4"),
      }),
      h.span(
        [
          h.DataAttribute("chat-provider-model-picker-label", "true"),
          h.Class("min-w-0 flex-1 truncate"),
        ],
        [pillLabel(model)]
      ),
    ]
  );

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
    [stopGlyph(h)]
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

/** The footer: the model pill and the mode, then the paperclip and send, on one row. */
export const footerView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const { layout, width } = model.footer;
  const draft = activeDraft(model);

  // The tray is what the user sees; a draft's saved ids alone are not content.
  const hasContent =
    draft.text.trim().length > 0 ||
    Option.exists(draftKey(model), (key) =>
      hasAttachments(model.attachments, key)
    );

  const running = isThreadRunning(model);
  const compact = shouldUseCompactComposerFooter(width, running);

  // The mode is the one measured block. It is never folded away: past icon-only there is nothing
  // left to fold it into, and the pill truncates instead.
  const modeIconOnly = layout.iconOnlyCount > 0 || layout.hiddenCount > 0;

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
        [pickerButton(model, h), modeBlock(model, false, modeIconOnly, h)]
      ),
      h.div(
        [
          h.DataAttribute("chat-composer-actions", "right"),
          h.DataAttribute("chat-composer-primary-actions-compact", "false"),
          h.Class(ACTIONS_CLASS),
        ],
        [
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
