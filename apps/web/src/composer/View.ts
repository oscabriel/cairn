// The composer's view: the new-thread hero for a draft, the composer docked under the transcript for
// an open thread, nothing without a target. The root places it: the hero fills the page, the
// docked composer sits below the thread page.

import { Submodel } from "foldkit";

import { contextStripView } from "../hero/ContextStripView.ts";
import { heroView } from "../hero/Hero.ts";
import { cardView } from "./Card.ts";
import type { Message } from "./Message.ts";
import { ComposerTarget } from "./Model.ts";
import type { Model } from "./Model.ts";

/** The composer, as the root embeds it with `h.submodel`. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  ComposerTarget.match(model.context.target, {
    None: () => h.empty,
    Home: () => heroView(model, h),
    Draft: () => heroView(model, h),
    Thread: () =>
      h.div(
        [
          h.DataAttribute("chat-composer-docked", "true"),
          h.Class("chat-composer-lane relative z-20 w-full shrink-0 pt-2"),
        ],
        [
          h.div(
            [
              h.DataAttribute("chat-composer-stack", "true"),
              h.Class(
                "group/composer-stack relative z-10 mx-auto w-full max-w-(--chat-content-max-width)"
              ),
            ],
            [
              cardView(model, contextStripView(model, h), h),
              h.div([
                h.Attribute("aria-hidden", "true"),
                h.Class(
                  "h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                ),
              ]),
            ]
          ),
        ]
      ),
  })
);
