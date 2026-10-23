// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/ChatComposer.tsx (the
// expanded image row, lines 6760 to 6930, the other-files list, lines 7015 to 7090, and the Attach
// button with its hidden file input, lines 7285 to 7322) and apps/web/src/components/ui/button.tsx
// (the `media-close`, `overlay` and `ghost` variants) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
// Kept: images as 64 px thumbnails with the remove button in the corner, the progress strip along
// the bottom and the retry button bottom left; other files as rows with their name, size or
// progress, retry and remove; their class strings. Changed: no snap-shot frames, video previews,
// preview dialog or tooltips (the failure reason is the retry button's title); the Attach button is
// a label around the file input, so the picker opens without script (the iOS paste menu is
// unreliable, notes/edges.md); a ready image restored after a reload is shown from the brain.
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
import {
  formatFileSize,
  formatUploadProgress,
} from "@cairn/client-logic/AttachmentFiles";
import { Array, Option } from "effect";
import { Mount, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { File as FileIcon, Paperclip, RefreshCw, X } from "lucide";

import { icon } from "../composer/Icon.ts";
import { Message } from "./Message.ts";
import { AttachmentStatus } from "./Model.ts";
import type { Item, Model } from "./Model.ts";
import { AttachmentPaste } from "./Paste.ts";
import { itemsOf } from "./Update.ts";

/** What accepts the Attach button's picker offers (plan section 3, 3B). */
export const ATTACH_ACCEPT = "image/*,application/pdf,.docx,text/*";

/** The variant of the brain's attachment route a restored thumbnail is read from. */
export const ATTACHMENT_PREVIEW_VARIANT = "original";

/** Where the brain serves one variant of a stored attachment. */
export const attachmentUrl = (attachmentId: string, variant: string): string =>
  `/api/attachments/${encodeURIComponent(attachmentId)}/${variant}`;

const BUTTON_BASE =
  "[&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none transition-[box-shadow,scale] [&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-[scale] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 sm:text-sm [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

const ICON_XS =
  "size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5";

const MEDIA_CLOSE = `${BUTTON_BASE} ${ICON_XS} [--control-icon-color:currentColor] border-transparent bg-black/65 text-white shadow-sm ring-1 ring-white/20 [:hover,[data-pressed]]:bg-black/80 focus-visible:ring-white`;

const OVERLAY = `${BUTTON_BASE} ${ICON_XS} [--control-icon-color:currentColor] border-transparent bg-black/70 text-white/65 [:hover,[data-pressed]]:bg-black/90`;

const GHOST = `${BUTTON_BASE} ${ICON_XS} [--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent`;

/** t3code's footer button look (ghost, icon-sm), on the label that opens the picker. */
const ATTACH_LABEL = `${BUTTON_BASE} size-8 sm:size-7 [--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring`;

const stateName = (item: Item): string =>
  AttachmentStatus.match(item.status, {
    Preparing: () => "preparing",
    Queued: () => "queued",
    Uploading: () => "uploading",
    Ready: () => "ready",
    Failed: () => "failed",
  });

const progressOf = (item: Item): Option.Option<number> =>
  AttachmentStatus.match(item.status, {
    Preparing: () => Option.some(0),
    Queued: () => Option.some(0),
    Uploading: ({ progress }) => Option.some(progress),
    Ready: () => Option.none(),
    Failed: () => Option.none(),
  });

/** Why the item failed, when it did. */
const failureOf = (item: Item): Option.Option<string> =>
  AttachmentStatus.guards.Failed(item.status)
    ? Option.some(item.status.reason)
    : Option.none();

/** The reason of a failure another attempt may fix, which earns a retry button. */
const retryableFailureOf = (item: Item): Option.Option<string> =>
  AttachmentStatus.guards.Failed(item.status) && item.status.retryable
    ? Option.some(item.status.reason)
    : Option.none();

/** The attributes judges and the paste timing read off every chip. */
const chipData = (item: Item, h: HtmlBuilder<Message>) => [
  h.Key(item.localId),
  h.DataAttribute("testid", "attachment-chip"),
  h.DataAttribute("attachment-state", stateName(item)),
  h.DataAttribute("attachment-name", item.name),
  h.DataAttribute("attachment-kind", item.isImage ? "image" : "file"),
  ...Option.match(failureOf(item), {
    onNone: () => [],
    onSome: (reason) => [h.Title(reason)],
  }),
  ...(AttachmentStatus.guards.Ready(item.status)
    ? [h.DataAttribute("attachment-id", item.status.ref.id)]
    : []),
  ...Option.match(item.pasteToRequestMs, {
    onNone: () => [],
    onSome: (ms) => [
      h.DataAttribute("paste-to-request-ms", String(Math.round(ms))),
    ],
  }),
];

const removeButton = (
  item: Item,
  className: string,
  h: HtmlBuilder<Message>
): Html =>
  h.button(
    [
      h.Type("button"),
      h.DataAttribute("slot", "button"),
      h.AriaLabel(`Remove ${item.name}`),
      h.Class(className),
      h.OnClick(Message.ClickedRemove({ localId: item.localId })),
    ],
    [icon(h, X, "x", "")]
  );

const retryButton = (
  item: Item,
  reason: string,
  className: string,
  h: HtmlBuilder<Message>
): Html =>
  h.button(
    [
      h.Type("button"),
      h.DataAttribute("slot", "button"),
      h.AriaLabel(`Retry upload for ${item.name}`),
      h.Title(reason),
      h.Class(className),
      h.OnClick(Message.ClickedRetry({ localId: item.localId })),
    ],
    [icon(h, RefreshCw, "refresh-cw", "")]
  );

/** The thumbnail's source: the local preview, else the brain's copy of a ready image. */
const thumbnailSource = (item: Item): Option.Option<string> =>
  Option.orElse(item.previewUrl, () =>
    AttachmentStatus.guards.Ready(item.status)
      ? Option.some(
          attachmentUrl(item.status.ref.id, ATTACHMENT_PREVIEW_VARIANT)
        )
      : Option.none()
  );

const thumbnail = (item: Item, h: HtmlBuilder<Message>): Html =>
  Option.match(thumbnailSource(item), {
    onNone: () =>
      h.div(
        [
          h.Class(
            "flex h-full w-full items-center justify-center px-1 text-center text-3xs text-secondary-label"
          ),
        ],
        [item.name]
      ),
    onSome: (src) =>
      h.img([
        h.Src(src),
        h.Alt(item.name),
        h.Attribute("draggable", "false"),
        h.Class("h-full w-full object-cover"),
      ]),
  });

/**
 * An image's tile: t3code's expanded-image tile, with the chip's judge attributes on the picture
 * inside it (where t3code has its preview button), so the tile keeps t3code's landmark.
 */
const imageChip = (item: Item, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Key(item.localId),
      h.DataAttribute("chat-composer-expanded-image", "true"),
      h.Class(
        "group/attachment shrink-0 snap-start bg-background relative h-16 w-16 overflow-hidden rounded-lg border border-border/80"
      ),
    ],
    [
      h.div(
        [...chipData(item, h), h.Class("h-full w-full")],
        [thumbnail(item, h)]
      ),
      Option.match(progressOf(item), {
        onNone: () => h.empty,
        onSome: (progress) =>
          h.span(
            [
              h.Class(
                "pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground"
              ),
            ],
            [formatUploadProgress(progress)]
          ),
      }),
      Option.match(retryableFailureOf(item), {
        onNone: () => h.empty,
        onSome: (reason) =>
          retryButton(item, reason, `${OVERLAY} absolute bottom-1 left-1`, h),
      }),
      h.span(
        [h.Class("absolute right-1 top-1 flex")],
        [removeButton(item, MEDIA_CLOSE, h)]
      ),
    ]
  );

const fileStatusText = (item: Item): string =>
  AttachmentStatus.match(item.status, {
    Preparing: () => formatUploadProgress(0),
    Queued: () => formatUploadProgress(0),
    Uploading: ({ progress }) => formatUploadProgress(progress),
    Ready: () => formatFileSize(item.sizeBytes),
    Failed: () => "Not uploaded",
  });

const fileRow = (item: Item, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      ...chipData(item, h),
      h.Class("flex min-w-0 items-center gap-2 py-1 text-sm text-foreground"),
    ],
    [
      icon(h, FileIcon, "file", "size-4 shrink-0 text-muted-foreground"),
      h.span(
        [h.Title(item.name), h.Class("min-w-0 flex-1 truncate text-left")],
        [item.name]
      ),
      h.span(
        [h.Class("shrink-0 text-xs text-secondary-label")],
        [fileStatusText(item)]
      ),
      Option.match(retryableFailureOf(item), {
        onNone: () => h.empty,
        onSome: (reason) => retryButton(item, reason, GHOST, h),
      }),
      removeButton(item, GHOST, h),
    ]
  );

const noticeView = (
  model: Model,
  draftKey: string,
  h: HtmlBuilder<Message>
): Html => {
  const waiting = Option.exists(
    model.waitingSend,
    (send) => send.draftKey === draftKey
  );

  if (waiting) {
    return h.div(
      [
        h.DataAttribute("testid", "attachment-waiting"),
        h.Role("status"),
        h.Class("mb-2 text-muted-foreground text-xs"),
      ],
      ["Sending when the uploads finish."]
    );
  }

  return Option.match(
    Option.filter(model.notice, (notice) => notice.draftKey === draftKey),
    {
      onNone: () => h.empty,
      onSome: ({ text }) =>
        h.div(
          [
            h.DataAttribute("testid", "attachment-notice"),
            h.Role("status"),
            h.Class(
              "mb-2 flex items-start gap-2 text-destructive-foreground text-xs"
            ),
          ],
          [
            h.span([h.Class("min-w-0 flex-1")], [text]),
            h.button(
              [
                h.Type("button"),
                h.AriaLabel("Dismiss"),
                h.Class("shrink-0 underline-offset-4 hover:underline"),
                h.OnClick(Message.ClickedDismissNotice()),
              ],
              ["Dismiss"]
            ),
          ]
        ),
    }
  );
};

/** What the composer tells the tray's view: the draft that is open now. */
export interface TrayInputs {
  readonly draftKey: Option.Option<string>;
}

/**
 * The open draft's attachments: image thumbnails in a wrapping row, other files as rows below,
 * then a note (a refusal, or a send waiting on uploads). Nothing when the draft has none.
 */
export const trayView = Submodel.defineView<Model, Message, TrayInputs>(
  (model, inputs, h) =>
    Option.match(inputs.draftKey, {
      onNone: () => h.empty,
      onSome: (draftKey) => {
        const items = itemsOf(model, draftKey);
        const images = Array.filter(items, (item) => item.isImage);
        const files = Array.filter(items, (item) => !item.isImage);

        const hasNote =
          Option.exists(
            model.waitingSend,
            (send) => send.draftKey === draftKey
          ) ||
          Option.exists(model.notice, (notice) => notice.draftKey === draftKey);

        if (items.length === 0 && !hasNote) {
          return h.empty;
        }

        return h.div(
          [h.DataAttribute("testid", "attachment-tray")],
          [
            images.length === 0
              ? h.empty
              : h.div(
                  [h.Class("mb-3 flex max-w-full flex-wrap gap-2")],
                  images.map((item) => imageChip(item, h))
                ),
            files.length === 0
              ? h.empty
              : h.div(
                  [h.Class("mb-3 flex flex-col gap-1")],
                  files.map((item) => fileRow(item, h))
                ),
            noticeView(model, draftKey, h),
          ]
        );
      },
    })
);

/**
 * The footer's Attach button: a label around a visually hidden multi-file input, so a tap opens
 * the picker directly (and keyboard focus reaches the input). `toParentMessage` lifts the picked
 * files into the composer's Messages.
 */
export const attachButtonView = <ParentMessage>(
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>
): Html =>
  h.label(
    [
      h.DataAttribute("slot", "tooltip-trigger"),
      h.Title("Attach files"),
      h.Class(ATTACH_LABEL),
    ],
    [
      icon(h, Paperclip, "paperclip", ""),
      h.input([
        h.Type("file"),
        h.Multiple(true),
        h.Accept(ATTACH_ACCEPT),
        h.AriaLabel("Attach files"),
        h.Class("sr-only"),
        h.OnFileChange((files) =>
          toParentMessage(Message.PickedFiles({ files }))
        ),
      ]),
    ]
  );

/**
 * The attributes the composer's form carries: it accepts dropped files, and its Mount turns pasted
 * files (and long text pastes) into attachments. `toParentMessage` lifts them.
 */
export const attachmentFormAttributes = <ParentMessage>(
  toParentMessage: (message: Message) => ParentMessage,
  h: HtmlBuilder<ParentMessage>
) => [
  h.AllowDrop(),
  h.OnDropFiles((files) => toParentMessage(Message.DroppedFiles({ files }))),
  h.OnMount(Mount.mapMessage(AttachmentPaste(), toParentMessage)),
];
