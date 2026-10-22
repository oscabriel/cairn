// The editor seam (ADR 0023, plan D23): the only module that knows the composer's editor is a
// textarea. Everything else works on `(text, selection)` strings, t3code's canonical form, so a rich
// editor can replace this file alone.
//
// Ported in part from cairn-v1, apps/web/src/mounts.ts (`ComposerInput`) at 1a5cd4a: the keydown
// rules that a Foldkit attribute cannot express (IME, key repeat, the soft keyboard, mod+shift+V) run
// in a Mount on the textarea. Changed: the send rules are client-logic's port of t3code
// (`composerSubmissionIntentForKey`), read against flags the view writes as data attributes, so
// the Mount needs no Model; the text itself reaches the Model through `OnInput`, synchronously, as in
// the S2 spike that passed the typing gate, and the Mount reports only the selection.
import {
  composerSubmissionIntentForKey,
  SendShortcut,
} from "@cairn/client-logic/ComposerLogic";
import type { ComposerKeyEvent } from "@cairn/client-logic/ComposerLogic";
import { isPasteAsTextShortcut } from "@cairn/client-logic/TextPaste";
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Command, Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./Message.ts";
import type { MenuKey } from "./Message.ts";

/** The editor's test id; judges and Commands find the live element by it. */
export const EDITOR_TEST_ID = "composer-editor";

const EDITOR_SELECTOR = `[data-testid="${EDITOR_TEST_ID}"]`;

/** The placeholder t3code shows. */
export const EDITOR_PLACEHOLDER =
  "Ask for changes, send follow-ups, or attach images";

/** What the Mount reads from the editor's data attributes at keydown time. */
export interface EditorFlags {
  readonly menuOpen: boolean;
  readonly isDraft: boolean;
  readonly isRunning: boolean;
  readonly isMac: boolean;
  readonly softKeyboardOpen: boolean;
  readonly sendShortcut: SendShortcut;
}

const MENU_KEYS: ReadonlyArray<MenuKey> = [
  "ArrowUp",
  "ArrowDown",
  "Enter",
  "Tab",
  "Escape",
];

const isMenuKey = Schema.is(Schema.Literals(MENU_KEYS));

const isSendShortcut = Schema.is(SendShortcut);

const readFlags = (element: HTMLElement): EditorFlags => {
  const { dataset } = element;
  const shortcut = dataset.sendShortcut ?? "enter";

  return {
    menuOpen: dataset.menuOpen === "true",
    isDraft: dataset.draft === "true",
    isRunning: dataset.running === "true",
    isMac: dataset.mac === "true",
    softKeyboardOpen: dataset.softKeyboard === "true",
    sendShortcut: isSendShortcut(shortcut) ? shortcut : "enter",
  };
};

const keyEvent = (event: KeyboardEvent): ComposerKeyEvent => ({
  key: event.key,
  shiftKey: event.shiftKey,
  altKey: event.altKey,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  // Some browsers send the composition keydown as key "Process" without `isComposing`.
  isComposing: event.isComposing || event.key === "Process",
  repeat: event.repeat,
});

const hasModifier = (event: KeyboardEvent) =>
  event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;

/** What one keydown in the editor means, and whether the browser's default must not run. */
const keydownMessage = (
  element: HTMLTextAreaElement,
  event: KeyboardEvent
): Option.Option<readonly [EditorMessage, boolean]> => {
  const key = keyEvent(event);

  if (key.isComposing) {
    return Option.none();
  }

  const flags = readFlags(element);

  if (flags.menuOpen && !hasModifier(event) && isMenuKey(event.key)) {
    return Option.some([Message.PressedMenuKey({ key: event.key }), true]);
  }

  const intent = composerSubmissionIntentForKey(key, {
    isMac: flags.isMac,
    isSoftwareKeyboardOpen: flags.softKeyboardOpen,
    isDraftThread: flags.isDraft,
    isRunning: flags.isRunning,
    sendShortcut: flags.sendShortcut,
    prompt: element.value,
  });

  if (Option.isSome(intent)) {
    return Option.some([
      Message.PressedSubmitKey({ intent: intent.value }),
      true,
    ]);
  }

  const collapsed = element.selectionStart === element.selectionEnd;

  if (event.key === "ArrowUp" && !hasModifier(event) && collapsed) {
    const onFirstLine = !element.value
      .slice(0, element.selectionStart)
      .includes("\n");

    return onFirstLine
      ? Option.some([
          Message.PressedHistoryKey({ direction: "backward" }),
          false,
        ])
      : Option.none();
  }

  if (event.key === "ArrowDown" && !hasModifier(event) && collapsed) {
    const onLastLine = !element.value
      .slice(element.selectionEnd)
      .includes("\n");

    return onLastLine
      ? Option.some([
          Message.PressedHistoryKey({ direction: "forward" }),
          false,
        ])
      : Option.none();
  }

  return Option.none();
};

type EditorMessage =
  | typeof Message.ChangedSelection.Type
  | typeof Message.PressedSubmitKey.Type
  | typeof Message.PressedMenuKey.Type
  | typeof Message.PressedHistoryKey.Type
  | typeof Message.FocusedEditor.Type
  | typeof Message.BlurredEditor.Type;

/** How long after mod+shift+V a paste counts as "keep it as text". */
const PASTE_AS_TEXT_WINDOW_MS = 1000;

/**
 * The textarea's behaviour Foldkit's attributes cannot express: the send, menu and history keys
 * (read against the flags the view writes), the selection after every edit or caret move, focus,
 * and the mod+shift+V window that 3B's paste handling reads from `data-paste-as-text-until`.
 */
export const ComposerInput = Mount.defineStream("ComposerInput", {
  messages: [
    Message.ChangedSelection,
    Message.PressedSubmitKey,
    Message.PressedMenuKey,
    Message.PressedHistoryKey,
    Message.FocusedEditor,
    Message.BlurredEditor,
  ],
  execute: ({ element }) =>
    Stream.callback<EditorMessage>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listeners: Array<readonly [string, (event: Event) => void]> =
            [];

          let last = { start: -1, end: -1 };

          if (element instanceof HTMLTextAreaElement) {
            const reportSelection = () => {
              const current = {
                start: element.selectionStart,
                end: element.selectionEnd,
              };

              if (current.start !== last.start || current.end !== last.end) {
                last = current;
                Queue.offerUnsafe(queue, Message.ChangedSelection(current));
              }
            };

            const onKeyDown = (event: Event) => {
              if (!(event instanceof KeyboardEvent)) {
                return;
              }

              if (isPasteAsTextShortcut(event, readFlags(element).isMac)) {
                element.dataset.pasteAsTextUntil = String(
                  event.timeStamp + PASTE_AS_TEXT_WINDOW_MS
                );

                return;
              }

              const decided = keydownMessage(element, event);

              if (Option.isSome(decided)) {
                const [message, prevent] = decided.value;

                if (prevent) {
                  event.preventDefault();
                }

                Queue.offerUnsafe(queue, message);
              }
            };

            listeners.push(
              ["input", reportSelection],
              ["select", reportSelection],
              ["keyup", reportSelection],
              ["pointerup", reportSelection],
              ["keydown", onKeyDown],
              [
                "focus",
                () => {
                  Queue.offerUnsafe(queue, Message.FocusedEditor());
                },
              ],
              [
                "blur",
                () => {
                  Queue.offerUnsafe(queue, Message.BlurredEditor());
                },
              ]
            );

            for (const [type, listener] of listeners) {
              element.addEventListener(type, listener);
            }
          }

          return listeners;
        }),
        (listeners) =>
          Effect.sync(() => {
            for (const [type, listener] of listeners) {
              element.removeEventListener(type, listener);
            }
          })
      ).pipe(Effect.flatMap(() => Effect.never))
    ),
});

const liveEditor = Effect.sync(() =>
  Option.fromNullishOr(
    document.querySelector<HTMLTextAreaElement>(EDITOR_SELECTOR)
  )
);

/**
 * Puts `value` in the live editor with the caret at `cursor`, and focuses it. A menu pick or a
 * recalled prompt must place the caret, which a re-render of the value alone cannot.
 */
export const SetEditorValue = Command.define("SetEditorValue", {
  args: { value: Schema.String, cursor: Schema.Int },
  messages: [Message.CompletedEditorCommand],
  execute: ({ cursor, value }) =>
    Effect.map(liveEditor, (editor) => {
      Option.map(editor, (element) => {
        if (element.value !== value) {
          element.value = value;
        }

        element.focus();
        element.setSelectionRange(cursor, cursor);
      });

      return Message.CompletedEditorCommand();
    }),
});

/** Focuses the editor, keeping its selection. */
export const FocusEditor = Command.define("FocusEditor", {
  messages: [Message.CompletedEditorCommand],
  execute: Effect.map(liveEditor, (editor) => {
    Option.map(editor, (element) => {
      element.focus();
    });

    return Message.CompletedEditorCommand();
  }),
});

const EDITOR_CLASS =
  "-m-1 block max-h-52 min-h-19.5 w-[calc(100%+--spacing(2))] resize-none overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none [field-sizing:content]";

/** What the editor shows and the flags its Mount reads. */
export interface EditorInputs {
  readonly text: string;
  readonly flags: EditorFlags;
  /** The id of the open menu's list, for `aria-controls`. */
  readonly menuListId: Option.Option<string>;
  readonly activeOptionId: Option.Option<string>;
}

/** The editor: the textarea and its placeholder, inside t3code's prompt frame. */
export const editorView = (
  inputs: EditorInputs,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [
      h.Class(
        "relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)"
      ),
    ],
    [
      h.textarea([
        h.AriaLabel("Message"),
        h.DataAttribute("testid", EDITOR_TEST_ID),
        h.DataAttribute("menu-open", String(inputs.flags.menuOpen)),
        h.DataAttribute("draft", String(inputs.flags.isDraft)),
        h.DataAttribute("running", String(inputs.flags.isRunning)),
        h.DataAttribute("mac", String(inputs.flags.isMac)),
        h.DataAttribute("soft-keyboard", String(inputs.flags.softKeyboardOpen)),
        h.DataAttribute("send-shortcut", inputs.flags.sendShortcut),
        h.Attribute("aria-autocomplete", "list"),
        h.AriaExpanded(inputs.flags.menuOpen),
        ...Option.match(inputs.menuListId, {
          onNone: () => [],
          onSome: (id) => [h.AriaControls(id)],
        }),
        ...Option.match(inputs.activeOptionId, {
          onNone: () => [],
          onSome: (id) => [h.AriaActiveDescendant(id)],
        }),
        h.Rows(1),
        h.Class(EDITOR_CLASS),
        h.Value(inputs.text),
        h.OnInput((value) => Message.ChangedDraft({ value })),
        h.OnMount(ComposerInput()),
      ]),
      inputs.text === ""
        ? h.div(
            [
              h.Attribute("aria-hidden", "true"),
              h.Class(
                "pointer-events-none absolute inset-0 leading-relaxed text-placeholder/75"
              ),
            ],
            [EDITOR_PLACEHOLDER]
          )
        : h.empty,
    ]
  );
