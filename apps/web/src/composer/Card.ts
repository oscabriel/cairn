// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// apps/web/src/components/chat/{ComposerSurface,ChatComposer,QueuedRunsControl}.tsx. Kept: the card's
// nesting (shell, host, form with the attached-drawer slot, main surface, body with the editor,
// footer) and its data attributes and classes, the queued inputs as an attached drawer above the
// card with a cancel per input. Changed: the queue reads pi-durable's inbox (`Queue.ts`); "Clear
// queue" stops the run and drops the queue together (plan D16), and editing a queued input is not
// offered yet.
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

import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { X } from "lucide";

import type { Message as TrayMessage } from "../attachments/Message.ts";
import { hasAttachments } from "../attachments/Update.ts";
import { attachmentFormAttributes, attachmentTray } from "./AttachmentTray.ts";
import {
  BANNER_SLOT_CLASS,
  BANNER_STACK_CLASS,
  BODY_CLASS,
  HOST_CLASS,
  MAIN_SURFACE_CLASS,
  SHELL_CLASS,
  SURFACE_CLASS,
} from "./Classes.ts";
import { activeDraft, draftKey, isDraftTarget } from "./Drafts.ts";
import { editorView } from "./Editor.ts";
import { footerView } from "./Footer.ts";
import { icon } from "./Icon.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { popoverView } from "./Popovers.ts";
import { queuedInputs } from "./Queue.ts";
import type { QueuedInput } from "./Queue.ts";
import {
  MENU_LIST_ID,
  menuContents,
  menuOptionId,
  triggerMenuView,
} from "./TriggerMenu.ts";
import { isThreadRunning } from "./Update.ts";

const DRAWER_CLASS =
  "relative isolate flex min-h-0 w-full flex-col overflow-hidden pb-[calc(1rem+1px)] before:rounded-t-2xl before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:border before:border-(--chat-composer-outline) before:bg-(--chat-composer-glass-surface) before:shadow-composer";

/** True when the open draft holds attachments, saved or still in the tray. */
const draftHasAttachments = (model: Model): boolean =>
  activeDraft(model).attachments.length > 0 ||
  Option.exists(draftKey(model), (key) =>
    hasAttachments(model.attachments, key)
  );

const toTray = (message: TrayMessage): Message =>
  Message.GotAttachmentsMessage({ message });

const queuedRow = (input: QueuedInput, h: HtmlBuilder<Message>): Html =>
  h.li(
    [
      h.Key(String(input.submissionId)),
      h.DataAttribute("testid", "composer-queued-input"),
      h.DataAttribute("mode", input.mode),
      h.Class("flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm"),
    ],
    [
      h.span(
        [h.Class("shrink-0 font-medium text-secondary-label text-xs")],
        [input.mode === "steer" ? "Steer" : "Queued"]
      ),
      h.span([h.Class("min-w-0 flex-1 truncate")], [input.text]),
      h.button(
        [
          h.Type("button"),
          h.AriaLabel("Cancel queued message"),
          h.Class(
            "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          ),
          h.OnClick(
            Message.ClickedWithdraw({ submissionId: input.submissionId })
          ),
        ],
        [icon(h, X, "x", "size-3.5")]
      ),
    ]
  );

/** The queued inputs as a drawer above the card, with "Clear queue". Empty when nothing waits. */
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
        [h.Class("flex items-center justify-between px-4 pt-2.5")],
        [
          h.span(
            [h.Class("font-medium text-secondary-label text-xs")],
            [queued.length === 1 ? "1 queued" : `${queued.length} queued`]
          ),
          h.button(
            [
              h.Type("button"),
              h.DataAttribute("testid", "composer-clear-queue"),
              h.Class(
                "cursor-pointer text-muted-foreground text-xs hover:text-foreground"
              ),
              h.OnClick(Message.ClickedStop({ clearQueue: true })),
            ],
            ["Clear queue"]
          ),
        ]
      ),
      h.ul(
        [h.Class("flex flex-col px-2 pb-1")],
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
          h.Class("px-4 pb-1 text-destructive-foreground text-xs"),
        ],
        [text]
      ),
  });

/**
 * The composer card: attached drawers (the open menu, the queue) above it, the editor, the
 * attachment tray and the footer inside it, and `contextStrip` under it.
 */
export const cardView = (
  model: Model,
  contextStrip: Option.Option<Html>,
  h: HtmlBuilder<Message>
): Html => {
  const menu = menuContents(model);

  return h.div(
    [
      h.DataAttribute("slot", "composer-shell"),
      ...(Option.isSome(contextStrip)
        ? [h.DataAttribute("with-context", "true")]
        : []),
      h.Class(SHELL_CLASS),
    ],
    [
      popoverView(model, h),
      triggerMenuView(model, h),
      h.div(
        [h.DataAttribute("slot", "composer-host"), h.Class(HOST_CLASS)],
        [
          h.div(
            [h.Class("relative z-10")],
            [
              h.form(
                [
                  h.Class(
                    "mx-auto w-full min-w-0 max-w-(--chat-content-max-width)"
                  ),
                  h.DataAttribute("chat-composer-form", "true"),
                  ...attachmentFormAttributes(toTray, h),
                ],
                [
                  h.div(
                    [
                      h.DataAttribute("slot", "composer-banner-attachment"),
                      h.Class(BANNER_SLOT_CLASS),
                    ],
                    [
                      h.div(
                        [h.Class(BANNER_STACK_CLASS)],
                        [queueView(model, h)]
                      ),
                    ]
                  ),
                  h.div(
                    [h.Class("relative")],
                    [
                      h.div(
                        [
                          h.DataAttribute("chat-composer-main-surface", "true"),
                          h.Class(MAIN_SURFACE_CLASS),
                        ],
                        [
                          h.div(
                            [
                              h.DataAttribute("chat-composer-surface", "true"),
                              h.DataAttribute(
                                "chat-composer-mobile-collapsed",
                                "false"
                              ),
                              h.Class(SURFACE_CLASS),
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
                                  // t3code draws the draft's images inside the body, above the
                                  // prompt.
                                  attachmentTray(
                                    model.attachments,
                                    draftKey(model),
                                    toTray,
                                    h
                                  ),
                                  h.div(
                                    [h.Class("relative")],
                                    [
                                      editorView(
                                        {
                                          text: activeDraft(model).text,
                                          placeholder:
                                            !draftHasAttachments(model),
                                          flags: {
                                            menuOpen: Option.isSome(menu),
                                            isDraft: isDraftTarget(model),
                                            isRunning: isThreadRunning(model),
                                            isMac: model.isMac,
                                            softKeyboardOpen:
                                              model.softKeyboardOpen,
                                            sendShortcut:
                                              model.settings.sendShortcut,
                                          },
                                          menuListId: Option.map(
                                            menu,
                                            () => MENU_LIST_ID
                                          ),
                                          activeOptionId: Option.map(
                                            Option.flatMap(
                                              menu,
                                              (contents) => contents.activeId
                                            ),
                                            menuOptionId
                                          ),
                                        },
                                        h
                                      ),
                                    ]
                                  ),
                                ]
                              ),
                              noticeView(model, h),
                              footerView(model, h),
                            ]
                          ),
                        ]
                      ),
                    ]
                  ),
                ]
              ),
            ]
          ),
        ]
      ),
      Option.getOrElse(contextStrip, () => h.empty),
    ]
  );
};
