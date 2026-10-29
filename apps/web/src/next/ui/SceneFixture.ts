// A stand-in app for the primitives' scene tests: a primitive drawn alone, whose clicks and typing
// send `Sent` messages that the page then lists in `data-testid="sent"`, so a scene can check what
// a primitive sent through the view, as the user would see it. Imported by tests only.

import { Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Scene from "foldkit/scene";

/** What a primitive under test sends: a word naming the action. */
export const Message = defineMessageUnion({ Sent: { what: Schema.String } });

/** What a primitive under test sends. */
export type Message = typeof Message.Type;

/** The words sent so far, in order. */
export interface Model {
  readonly sent: ReadonlyArray<string>;
}

/** The message a primitive under test sends for `what`. */
export const sent = (what: string): Message => Message.Sent({ what });

/** The scene's update: each message appends its word. */
export const update = (model: Model, message: Message) => ({
  model: { sent: [...model.sent, message.what] },
});

/** The model a scene starts from: nothing sent. */
export const given = Scene.given<Model>({ sent: [] });

/** A scene's app: `draw`'s primitives, then the list of what they sent. */
export const appOf = (
  draw: (h: HtmlBuilder<Message>) => ReadonlyArray<Html>
) => ({
  update,
  view: (model: Model, h: HtmlBuilder<Message>): Html =>
    h.div(
      [],
      [
        ...draw(h),
        h.output([h.DataAttribute("testid", "sent")], [model.sent.join(",")]),
      ]
    ),
});

/** Checks the words sent so far, joined by commas. */
export const expectSent = (words: string) =>
  Scene.expect(Scene.testId("sent")).toHaveText(words);
