// Copy buttons light one check (T33): two list items holding code blocks share a position within
// their item, so the copy key is the block's path, and copying one marks only that one.
import { Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";
import { describe, expect, it } from "vitest";

import type { Message } from "../Message.ts";
import { markdownView } from "./View.ts";

const REPLY = [
  "- first",
  "  ```",
  "  echo one",
  "  ```",
  "- second",
  "  ```",
  "  echo two",
  "  ```",
].join("\n");

interface Model {
  readonly copied: Option.Option<string>;
}

const update = (model: Model, message: Message) =>
  Predicate.isTagged(message, "ClickedCopy")
    ? { model: { copied: Option.some(message.rowId) } }
    : { model };

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      markdownView(
        {
          h,
          rowId: "reply",
          highlightedLanguages: [],
          copiedRowId: model.copied,
        },
        REPLY,
        false
      ),
    ]
  );

describe("code block copy buttons", () => {
  it("mark only the block that was copied", () => {
    Scene.scene(
      { update, view },
      Scene.given({ copied: Option.none() }),
      Scene.expectAll(Scene.all.label("Copy code")).toHaveCount(2),
      Scene.click(Scene.label("Copy code")),
      Scene.expectAll(Scene.all.label("Copied")).toHaveCount(1),
      Scene.tap((simulation) => {
        expect(simulation.commands).toHaveLength(0);
      })
    );
  });
});
