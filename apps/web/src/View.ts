// The app's root view: the frame (`Frame.ts`, ADR 0040), which draws the shell, the
// routed page and the composer, with the notice bar this module keeps above the page. The notice
// bar is the banner (U-13): what did not go or could not be kept (a turn the brain refused,
// a view that could not load, changes this device could not save), in the waiting tone, with
// Dismiss.

import { Option } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { view as frameView } from "./Frame.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { banner } from "./ui/Banner.ts";
import { buttonDefaults, button } from "./ui/Button.ts";

const noticeBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.notice, {
    onNone: () => h.empty,
    onSome: (notice) =>
      h.div(
        [h.Class("shrink-0 px-(--space-3) pt-(--space-2)")],
        [
          banner(
            h,
            {
              tone: "waiting",
              mark: Option.none(),
              title: notice,
              detail: Option.none(),
              actions: [
                button(
                  h,
                  {
                    ...buttonDefaults<Message>(),
                    variant: "ghost",
                    size: "small",
                    onClick: Option.some(Message.DismissedNotice()),
                  },
                  ["Dismiss"]
                ),
              ],
            },
            [h.DataAttribute("testid", "notice")]
          ),
        ]
      ),
  });

/** The app, drawn by the frame. */
export const view = (model: Model, h: HtmlBuilder<Message>): Document =>
  frameView(model, h, { notice: () => noticeBar(model, h) });
