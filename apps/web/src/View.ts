// The app's root view: the `next` frame (`next/Frame.ts`, ADR 0040), which draws the shell, the
// routed page and the composer, with the notice bar this module keeps above the page.

import { Option } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { view as frameView } from "./next/Frame.ts";

const noticeBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.notice, {
    onNone: () => h.empty,
    onSome: (notice) =>
      h.div(
        [
          h.DataAttribute("testid", "notice"),
          h.Role("status"),
          h.Class("flex items-start gap-2 border-b px-4 py-2 text-sm"),
        ],
        [
          h.span([h.Class("min-w-0 flex-1")], [notice]),
          h.button(
            [
              h.Type("button"),
              h.AriaLabel("Dismiss"),
              h.Class("shrink-0 underline-offset-4 hover:underline"),
              h.OnClick(Message.DismissedNotice()),
            ],
            ["Dismiss"]
          ),
        ]
      ),
  });

/** The app, drawn by the `next` frame. */
export const view = (model: Model, h: HtmlBuilder<Message>): Document =>
  frameView(model, h, { notice: () => noticeBar(model, h) });
