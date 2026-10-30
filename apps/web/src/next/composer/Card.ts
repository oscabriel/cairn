// The `next` composer box (plan look track L7): the classic card's parts and behaviour
// (`composer/Card.ts`, itself a port of t3code's composer surface) in the Stone look. The open
// `/`, `@` or `$` menu and the queue of waiting messages sit above the box as drawers; inside it
// are the attachment tray, the prompt (classic's editor, its Mounts unchanged, so typing behaves
// exactly as classic's) and the footer; the context strip sits under it. The popovers (model
// picker, thinking, mode, project, workspace and branch) are classic's, which take the look
// through the token bridge.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { X } from "lucide";

import type { Message as TrayMessage } from "../../attachments/Message.ts";
import { hasAttachments } from "../../attachments/Update.ts";
import {
  attachmentFormAttributes,
  attachmentTray,
} from "../../composer/AttachmentTray.ts";
import { activeDraft, draftKey, isDraftTarget } from "../../composer/Drafts.ts";
import { editorView } from "../../composer/Editor.ts";
import { icon } from "../../composer/Icon.ts";
import { Message } from "../../composer/Message.ts";
import type { Model } from "../../composer/Model.ts";
import { popoverView } from "../../composer/Popovers.ts";
import { queuedInputs } from "../../composer/Queue.ts";
import type { QueuedInput } from "../../composer/Queue.ts";
import {
  MENU_LIST_ID,
  menuContents,
  menuOptionId,
} from "../../composer/TriggerMenu.ts";
import { isThreadRunning } from "../../composer/Update.ts";
import { TYPE } from "../ui/Classes.ts";
import {
  BODY_CLASS,
  BOX_CLASS,
  DRAWER_CLASS,
  SHELL_CLASS,
  SMALL_ICON_BUTTON_CLASS,
  TEXT_BUTTON_CLASS,
} from "./Classes.ts";
import { footerView } from "./Footer.ts";
import { triggerMenuView } from "./TriggerMenu.ts";

/** True when the open draft holds attachments, saved or still in the tray. */
const draftHasAttachments = (model: Model): boolean =>
  activeDraft(model).attachments.length > 0 ||
  Option.exists(draftKey(model), (key) =>
    hasAttachments(model.attachments, key)
  );

const queuedRow = (input: QueuedInput, h: HtmlBuilder<Message>): Html =>
  h.li(
    [
      h.Key(String(input.submissionId)),
      h.DataAttribute("testid", "composer-queued-input"),
      h.DataAttribute("mode", input.mode),
      h.Class(
        `flex min-w-0 items-center gap-(--space-2) px-(--space-3) text-ink-1 ${TYPE.ui}`
      ),
    ],
    [
      h.span(
        [h.Class(`shrink-0 text-ink-3 ${TYPE.small}`)],
        [input.mode === "steer" ? "Steer" : "Queued"]
      ),
      h.span([h.Class("min-w-0 flex-1 truncate")], [input.text]),
      h.button(
        [
          h.Type("button"),
          h.AriaLabel("Cancel queued message"),
          h.Class(SMALL_ICON_BUTTON_CLASS),
          h.OnClick(
            Message.ClickedWithdraw({ submissionId: input.submissionId })
          ),
        ],
        [icon(h, X, "x", "")]
      ),
    ]
  );

/** The waiting messages as a drawer above the box, with "Clear queue"; empty when none wait. */
const queueView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const queued = queuedInputs(model.context.inbox);

  if (queued.length === 0) {
    return h.empty;
  }

  return h.div(
    [
      h.DataAttribute("composer-banner-surface", "attached"),
      h.DataAttribute("testid", "composer-queue"),
      h.Class(DRAWER_CLASS),
    ],
    [
      h.div(
        [
          h.Class(
            "flex items-center justify-between px-(--space-3) pt-(--space-1)"
          ),
        ],
        [
          h.span(
            [h.Class(`text-ink-3 ${TYPE.small}`)],
            [queued.length === 1 ? "1 queued" : `${queued.length} queued`]
          ),
          h.button(
            [
              h.Type("button"),
              h.DataAttribute("testid", "composer-clear-queue"),
              h.Class(TEXT_BUTTON_CLASS),
              h.OnClick(Message.ClickedStop({ clearQueue: true })),
            ],
            ["Clear queue"]
          ),
        ]
      ),
      h.ul(
        [h.Class("flex flex-col")],
        queued.map((input) => queuedRow(input, h))
      ),
    ]
  );
};

const noticeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.notice, {
    onNone: () => h.empty,
    onSome: (text) =>
      h.p(
        [
          h.Role("status"),
          h.DataAttribute("testid", "composer-notice"),
          h.Class(`px-(--space-4) text-ink-2 ${TYPE.small}`),
        ],
        [text]
      ),
  });

const editor = (model: Model, h: HtmlBuilder<Message>): Html => {
  const menu = menuContents(model);

  return editorView(
    {
      text: activeDraft(model).text,
      placeholder: !draftHasAttachments(model),
      flags: {
        menuOpen: Option.isSome(menu),
        isDraft: isDraftTarget(model),
        isRunning: isThreadRunning(model),
        isMac: model.isMac,
        softKeyboardOpen: model.softKeyboardOpen,
        sendShortcut: model.settings.sendShortcut,
      },
      menuListId: Option.map(menu, () => MENU_LIST_ID),
      activeOptionId: Option.map(
        Option.flatMap(menu, (contents) => contents.activeId),
        menuOptionId
      ),
    },
    h
  );
};

/**
 * The composer box: the drawers above it (the open menu, the queue), the tray, the prompt and the
 * footer inside it, and `contextStrip` under it.
 */
export const cardView = (
  model: Model,
  contextStrip: Option.Option<Html>,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "composer-shell"),
      ...onlyIf(
        Option.isSome(contextStrip),
        h.DataAttribute("with-context", "true")
      ),
      h.Class("relative"),
    ],
    [
      popoverView(model, h),
      triggerMenuView(model, h),
      h.form(
        [
          h.DataAttribute("chat-composer-form", "true"),
          h.Class(SHELL_CLASS),
          ...attachmentFormAttributes(
            (message: TrayMessage) =>
              Message.GotAttachmentsMessage({ message }),
            h
          ),
        ],
        [
          h.div(
            [h.DataAttribute("slot", "composer-banner-attachment")],
            [queueView(model, h)]
          ),
          h.div(
            [
              h.DataAttribute("chat-composer-main-surface", "true"),
              h.DataAttribute("chat-composer-surface", "true"),
              h.DataAttribute("chat-composer-mobile-collapsed", "false"),
              h.DataAttribute("slot", "field-shell"),
              h.Class(BOX_CLASS),
            ],
            [
              h.div(
                [
                  h.DataAttribute("chat-composer-body", "true"),
                  h.Class(BODY_CLASS),
                ],
                [
                  h.div([
                    h.Role("status"),
                    h.Attribute("aria-atomic", "true"),
                    h.Class("sr-only"),
                  ]),
                  attachmentTray(
                    model.attachments,
                    draftKey(model),
                    (message: TrayMessage) =>
                      Message.GotAttachmentsMessage({ message }),
                    h
                  ),
                  h.div([h.Class("relative")], [editor(model, h)]),
                ]
              ),
              noticeView(model, h),
              footerView(model, h),
            ]
          ),
        ]
      ),
      Option.getOrElse(contextStrip, () => h.empty),
    ]
  );
