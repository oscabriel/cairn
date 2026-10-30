// The `next` composer's view (plan look track L7): the same Submodel as classic's
// (`composer/View.ts`, over the composer's own Model, Messages and update), drawn in the Stone
// look. A draft's page is the hero; an open thread docks the box under its transcript; with no
// target it draws nothing. The `next` frame embeds it in place of classic's view.

import { Submodel } from "foldkit";

import type { Message } from "../../composer/Message.ts";
import { ComposerTarget } from "../../composer/Model.ts";
import type { Model } from "../../composer/Model.ts";
import { heroView } from "../hero/Hero.ts";
import { cardView } from "./Card.ts";
import { LANE_CLASS, STACK_CLASS } from "./Classes.ts";
import { contextStripView } from "./ContextStrip.ts";

/** The composer, as the `next` frame embeds it with `h.submodel`. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  ComposerTarget.match(model.context.target, {
    None: () => h.empty,
    Home: () => heroView(model, h),
    Draft: () => heroView(model, h),
    Thread: () =>
      h.div(
        [h.DataAttribute("chat-composer-docked", "true"), h.Class(LANE_CLASS)],
        [
          h.div(
            [
              h.DataAttribute("chat-composer-stack", "true"),
              h.Class(STACK_CLASS),
            ],
            [cardView(model, contextStripView(model, h), h)]
          ),
        ]
      ),
  })
);
