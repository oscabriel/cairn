// The editor's focus report (W-1): the request card's typing guard lets a held request show when
// the user leaves the composer, and on the phone that card takes the composer's slot. A mouse press
// on Send blurs the editor before the click lands, so the editor reports leaving only once the press
// ends; a blur with no press under way is reported at once.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { ComposerInput } from "./Editor.ts";

/** Waits a few tasks on the real clock, for a report deferred past a press's end to reach the stream. */
const settle = Effect.sleep("10 millis");

/** Runs the editor's Mount on a fresh textarea beside a Send button, collecting what it reports. */
const mounted = Effect.gen(function* () {
  const editor = document.createElement("textarea");
  const send = document.createElement("button");

  document.body.replaceChildren(editor, send);

  const reports: Array<string> = [];

  const fiber = yield* Effect.forkChild(
    Stream.runForEach(ComposerInput().f(editor, Stream.empty), (message) =>
      Effect.sync(() => {
        reports.push(message._tag);
      })
    )
  );

  // Let the Mount add its listeners.
  yield* settle;

  return { editor, send, reports, fiber };
});

describe("the editor's focus report", () => {
  it.live("reports leaving at once when no press is under way", () =>
    Effect.gen(function* () {
      const { editor, reports, fiber } = yield* mounted;

      editor.focus();
      editor.blur();
      yield* settle;

      assert.deepStrictEqual(reports, ["FocusedEditor", "BlurredEditor"]);
      yield* Fiber.interrupt(fiber);
    })
  );

  it.live("reports leaving only once a mouse press that blurred it ends", () =>
    Effect.gen(function* () {
      const { editor, send, reports, fiber } = yield* mounted;

      editor.focus();
      // A mouse press on Send: the pointer goes down, the press moves focus off the editor.
      send.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "mouse",
        })
      );
      editor.blur();
      yield* settle;

      assert.deepStrictEqual(
        reports,
        ["FocusedEditor"],
        "the editor reported leaving while the press was under way"
      );

      send.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" })
      );
      yield* settle;

      assert.deepStrictEqual(reports, ["FocusedEditor", "BlurredEditor"]);
      yield* Fiber.interrupt(fiber);
    })
  );

  it.live("reports no leave when the press gave focus back to the editor", () =>
    Effect.gen(function* () {
      const { editor, send, reports, fiber } = yield* mounted;

      editor.focus();
      send.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "mouse",
        })
      );
      editor.blur();
      editor.focus();
      send.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" })
      );
      yield* settle;

      assert.deepStrictEqual(reports, ["FocusedEditor", "FocusedEditor"]);
      yield* Fiber.interrupt(fiber);
    })
  );
});
