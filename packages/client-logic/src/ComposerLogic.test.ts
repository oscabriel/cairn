// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// apps/web/src/composer-logic.test.ts (isPathSuggestionCurrent, composerSubmissionIntentForKey),
// packages/client-runtime/src/state/composerDispatch.test.ts and
// apps/web/src/components/chat/composerMenuHighlight.test.ts. Changed: cases for remapped
// keybindings are gone (Cairn's composer keys are fixed), environments are gone, `restart` is gone.
// MIT License, Copyright (c) 2026 T3 Tools Inc.; the full notice is in ComposerLogic.ts.
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  alternateFollowUp,
  composerSubmissionIntentForKey,
  isPathSuggestionCurrent,
  isTypeToFocusKey,
  pastedPathQueryLength,
  resolveComposerDispatchMode,
  resolveComposerMenuActiveItemId,
} from "./ComposerLogic.ts";
import type { ComposerKeyContext, ComposerKeyEvent } from "./ComposerLogic.ts";
import { detectComposerTrigger } from "./ComposerTrigger.ts";

const enter: ComposerKeyEvent = {
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  repeat: false,
};

const context: ComposerKeyContext = {
  isMac: false,
  isSoftwareKeyboardOpen: false,
  isDraftThread: false,
  isRunning: false,
  sendShortcut: "enter",
  prompt: "",
};

const intent = (
  event: Partial<ComposerKeyEvent>,
  overrides: Partial<ComposerKeyContext> = {}
) =>
  Option.getOrNull(
    composerSubmissionIntentForKey(
      { ...enter, ...event },
      { ...context, ...overrides }
    )
  );

describe(isPathSuggestionCurrent, () => {
  const searched = { projectId: "prj_1", query: "alpha" };

  it("allows a file suggestion matching the live search", () => {
    assert.isTrue(
      isPathSuggestionCurrent(
        searched,
        detectComposerTrigger("@alpha", 6),
        "prj_1"
      )
    );
  });

  it("rejects a visible file suggestion after the query or project changes", () => {
    assert.isFalse(
      isPathSuggestionCurrent(
        searched,
        detectComposerTrigger("@beta", 5),
        "prj_1"
      )
    );
    assert.isFalse(
      isPathSuggestionCurrent(
        searched,
        detectComposerTrigger("@alpha", 6),
        "prj_2"
      )
    );
  });
});

describe(composerSubmissionIntentForKey, () => {
  it.each([
    ["enter", "one line", false, "foreground"],
    ["enter", "two\nlines", false, "foreground"],
    ["mod-enter-multiline", "one line", false, "foreground"],
    ["mod-enter-multiline", "two\nlines", false, null],
    ["mod-enter-multiline", "two\nlines", true, "foreground"],
    ["mod-enter", "one line", false, null],
    ["mod-enter", "one line", true, "foreground"],
  ] as const)("honors %s for %j", (sendShortcut, prompt, ctrlKey, expected) => {
    assert.strictEqual(intent({ ctrlKey }, { sendShortcut, prompt }), expected);
  });

  it.each([true, false])("uses the platform's modifier (mac %s)", (isMac) => {
    const modEnter = { metaKey: isMac, ctrlKey: !isMac };

    for (const [sendShortcut, prompt, requiresModifier] of [
      ["enter", "one line", false],
      ["enter", "two\nlines", false],
      ["mod-enter", "one line", true],
      ["mod-enter", "two\nlines", true],
      ["mod-enter-multiline", "one line", false],
      ["mod-enter-multiline", "two\nlines", true],
    ] as const) {
      const running = { isMac, sendShortcut, prompt, isRunning: true };

      assert.strictEqual(
        intent(modEnter, running),
        requiresModifier ? "foreground" : "alternate"
      );
      assert.strictEqual(
        intent({ ...modEnter, shiftKey: requiresModifier }, running),
        "alternate"
      );
      assert.strictEqual(
        intent({}, running),
        requiresModifier ? null : "foreground"
      );
      assert.strictEqual(
        intent(
          { ...modEnter, altKey: true },
          { isMac, sendShortcut, isDraftThread: true }
        ),
        "background"
      );
      assert.strictEqual(
        intent({ ...modEnter, altKey: true }, { isMac, sendShortcut }),
        "background"
      );
      assert.strictEqual(
        intent(modEnter, { isMac, sendShortcut, prompt, isDraftThread: true }),
        "background"
      );
      assert.strictEqual(intent({ shiftKey: true }, running), null);
    }
  });

  it("leaves queued-message steering on mod+shift+Enter outside a draft", () => {
    assert.strictEqual(
      intent({ ctrlKey: true, shiftKey: true }, { isRunning: true }),
      null
    );
  });

  it("does not start a background thread with the queued-message shortcut", () => {
    assert.strictEqual(
      intent({ ctrlKey: true, shiftKey: true }, { isDraftThread: true }),
      null
    );
  });

  it("keeps modifier submission available with the software keyboard open", () => {
    const keyboardOpen = { isSoftwareKeyboardOpen: true };

    assert.strictEqual(intent({ ctrlKey: true }, keyboardOpen), "foreground");
    assert.strictEqual(
      intent({ ctrlKey: true }, { ...keyboardOpen, isRunning: true }),
      "alternate"
    );
    assert.strictEqual(
      intent({ ctrlKey: true }, { ...keyboardOpen, isDraftThread: true }),
      "background"
    );
  });

  it.each([
    [{}, { isSoftwareKeyboardOpen: true }],
    [{ isComposing: true }, {}],
    [{ repeat: true }, {}],
  ] as const)("does not submit with %j %j", (event, overrides) => {
    assert.strictEqual(intent(event, overrides), null);
  });

  it("types every other key", () => {
    assert.strictEqual(intent({ key: "a" }), null);
  });
});

describe(resolveComposerDispatchMode, () => {
  it("starts an ordinary turn while idle", () => {
    assert.strictEqual(
      resolveComposerDispatchMode(false, false, "queue"),
      "auto"
    );
    assert.strictEqual(
      resolveComposerDispatchMode(false, true, "steer"),
      "auto"
    );
  });

  it.each([
    ["queue", "steer"],
    ["steer", "queue"],
  ] as const)(
    "uses the configured %s behavior only during a running turn",
    (followUp, alternate) => {
      assert.strictEqual(
        resolveComposerDispatchMode(true, false, followUp),
        followUp
      );
      assert.strictEqual(
        resolveComposerDispatchMode(true, true, followUp),
        alternate
      );
      assert.strictEqual(alternateFollowUp(followUp), alternate);
    }
  );
});

describe(pastedPathQueryLength, () => {
  it("continues an @ query with the pasted word", () => {
    assert.strictEqual(pastedPathQueryLength("see @sr", "c/index.ts rest"), 10);
  });

  it("is zero outside a file search", () => {
    assert.strictEqual(pastedPathQueryLength("see ", "src"), 0);
  });
});

describe(resolveComposerMenuActiveItemId, () => {
  const items = ["top", "second", "third"];

  it("defaults to the first item when nothing is highlighted", () => {
    assert.deepStrictEqual(
      resolveComposerMenuActiveItemId(
        items,
        Option.none(),
        "skill:u",
        Option.none()
      ),
      Option.some("top")
    );
  });

  it("preserves the highlighted item within the same query", () => {
    assert.deepStrictEqual(
      resolveComposerMenuActiveItemId(
        items,
        Option.some("second"),
        "skill:u",
        Option.some("skill:u")
      ),
      Option.some("second")
    );
  });

  it("resets to the top result when the query changes", () => {
    assert.deepStrictEqual(
      resolveComposerMenuActiveItemId(
        items,
        Option.some("second"),
        "skill:ui",
        Option.some("skill:u")
      ),
      Option.some("top")
    );
  });

  it("falls back to the first item when the highlighted item disappears", () => {
    assert.deepStrictEqual(
      resolveComposerMenuActiveItemId(
        items,
        Option.some("missing"),
        "skill:ui",
        Option.some("skill:ui")
      ),
      Option.some("top")
    );
  });

  it("clears the active result while results are empty", () => {
    assert.isTrue(
      Option.isNone(
        resolveComposerMenuActiveItemId(
          [],
          Option.some("second"),
          "path:src",
          Option.some("path:src")
        )
      )
    );
  });
});

describe(isTypeToFocusKey, () => {
  it("takes printable keys without modifiers", () => {
    assert.isTrue(isTypeToFocusKey({ ...enter, key: "a" }));
    assert.isTrue(isTypeToFocusKey({ ...enter, key: "日" }));
    assert.isFalse(isTypeToFocusKey({ ...enter, key: "a", ctrlKey: true }));
    assert.isFalse(isTypeToFocusKey({ ...enter, key: "Enter" }));
    assert.isFalse(isTypeToFocusKey({ ...enter, key: "a", isComposing: true }));
  });
});
