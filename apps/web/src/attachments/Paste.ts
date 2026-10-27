// Ported from cairn-v1, apps/web/src/mounts.ts (`ComposerInput`'s paste half) at 1a5cd4a, itself
// after github.com/pingdotgg/t3code apps/web/src/components/chat/ChatComposer.tsx (`onPaste`) at
// c079503d. Kept: a paste carrying images, or only files, becomes attachments; a long text paste
// folds into a file unless it came from mod+shift+V; a paste that would push the draft past its
// limit folds regardless. Changed: the claim rule and the 32 KiB fold are client-logic's ports of
// t3code at fe27e8e3 (`shouldHandleAttachmentPaste`, `pastedTextDisposition`); the mod+shift+V
// window is the one the editor's Mount writes as `data-paste-as-text-until`; the listener sits on
// the composer's form, and a guarded document listener catches a paste made with focus on nothing
// (Foldkit's `OnPaste` carries no clipboard data, notes/client.md).
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

import { shouldHandleAttachmentPaste } from "@cairn/client-logic/AttachmentFiles";
import { TURN_TEXT_MAX_CHARS } from "@cairn/client-logic/ComposerSubmission";
import {
  pastedTextDisposition,
  wouldTextPasteExceedLimit,
} from "@cairn/client-logic/TextPaste";
import { Array, Effect, Option, Queue, Stream } from "effect";
import { Mount } from "foldkit";
import { streamFromEventFilterMapPreventDefault } from "foldkit/dom";

import { Message } from "./Message.ts";

/** The composer's editor, which the paste reads its selection and mod+shift+V window from. */
const EDITOR_SELECTOR = '[data-testid="composer-editor"]';

/** The composer's form, inside which the Mount handles pastes itself. */
const COMPOSER_FORM_SELECTOR = "[data-chat-composer-form]";

const EDITABLE =
  'input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]';

/** The name a folded paste is created with; the tray gives it the next free `pasted-text` name. */
const PASTED_TEXT_NAME = "pasted-text.txt";

type PasteMessage =
  | typeof Message.PastedFiles.Type
  | typeof Message.PastedText.Type;

const clipboardFiles = (event: ClipboardEvent): ReadonlyArray<File> =>
  Array.fromIterable(event.clipboardData?.files ?? []);

const plainTextOf = (event: ClipboardEvent): string =>
  event.clipboardData?.getData("text/plain") ?? "";

/** The files of a paste the composer should claim, or none to leave the paste to the browser. */
const claimedFiles = (
  event: ClipboardEvent
): Option.Option<ReadonlyArray<File>> => {
  const files = clipboardFiles(event);

  return shouldHandleAttachmentPaste({ files, plainText: plainTextOf(event) })
    ? Option.some(files)
    : Option.none();
};

/** A long text paste into the editor, as a file, unless mod+shift+V asked to keep it as text. */
const foldedText = (
  event: ClipboardEvent,
  editor: HTMLTextAreaElement
): Option.Option<File> => {
  const text = plainTextOf(event);
  const bypassUntil = Number(editor.dataset.pasteAsTextUntil ?? Number.NaN);

  const disposition = pastedTextDisposition({
    text,
    canAttach: true,
    bypassAutoAttachment:
      Number.isFinite(bypassUntil) && event.timeStamp <= bypassUntil,
    wouldExceedInputLimit: wouldTextPasteExceedLimit(
      editor.value.length,
      { start: editor.selectionStart, end: editor.selectionEnd },
      text.length,
      TURN_TEXT_MAX_CHARS
    ),
  });

  return disposition === "attachment"
    ? Option.some(new File([text], PASTED_TEXT_NAME, { type: "text/plain" }))
    : Option.none();
};

/** What one paste inside the composer means, or none to let the browser paste. */
const composerPaste = (
  form: Element,
  event: ClipboardEvent
): Option.Option<PasteMessage> => {
  if (event.defaultPrevented) {
    return Option.none();
  }

  const files = claimedFiles(event);

  if (Option.isSome(files)) {
    return Option.some(
      Message.PastedFiles({ files: files.value, pastedAt: event.timeStamp })
    );
  }

  const editor = form.querySelector(EDITOR_SELECTOR);

  const intoEditor =
    editor instanceof HTMLTextAreaElement &&
    event.target instanceof Node &&
    editor.contains(event.target);

  return intoEditor
    ? Option.map(foldedText(event, editor), (file) =>
        Message.PastedText({ file, pastedAt: event.timeStamp })
      )
    : Option.none();
};

/**
 * The composer's paste handling, mounted on its form: claimed files and folded long text become
 * attachments, and the browser's own paste is stopped for them. Any other paste is left alone.
 */
export const AttachmentPaste = Mount.defineStream("AttachmentPaste", {
  messages: [Message.PastedFiles, Message.PastedText],
  execute: ({ element }) =>
    Stream.callback<PasteMessage>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onPaste = (event: Event) => {
            if (!(event instanceof ClipboardEvent)) {
              return;
            }

            Option.map(composerPaste(element, event), (message) => {
              event.preventDefault();
              // The document listener must not take the same paste again.
              event.stopPropagation();
              Queue.offerUnsafe(queue, message);
            });
          };

          element.addEventListener("paste", onPaste);

          return onPaste;
        }),
        (onPaste) =>
          Effect.sync(() => {
            element.removeEventListener("paste", onPaste);
          })
      ).pipe(Effect.flatMap(() => Effect.never))
    ),
});

const isInside = (event: Event, selector: string): boolean =>
  event
    .composedPath()
    .some(
      (target) => target instanceof Element && target.closest(selector) !== null
    );

/**
 * Files pasted with focus on no field (the page itself, a button): they attach to the open
 * composer, as t3code's focus redirect does for typing. Pastes into another field, or into the
 * composer (its own Mount handles those), are left alone.
 */
export const documentPastes: Stream.Stream<PasteMessage> =
  streamFromEventFilterMapPreventDefault({
    target: document,
    type: "paste",
    filterMapEvent: (event) => {
      if (
        event.defaultPrevented ||
        isInside(event, COMPOSER_FORM_SELECTOR) ||
        isInside(event, EDITABLE) ||
        document.querySelector(EDITOR_SELECTOR) === null
      ) {
        return Option.none();
      }

      return Option.map(claimedFiles(event), (files) =>
        Message.PastedFiles({ files, pastedAt: event.timeStamp })
      );
    },
  });
