// The `next` hero (plan look track L7): the page where a new thread starts, under the shell's chat
// header (L6's `next/shell/Header.ts`, which already says "New thread", so the hero draws no header
// of its own, as classic's `hero/Hero.ts` does). The headline and the composer box sit together in
// the middle of the page, one lane wide; with no project to offer, the hero asks for one first.

import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { draftProject } from "../../composer/Drafts.ts";
import type { Message } from "../../composer/Message.ts";
import type { Model } from "../../composer/Model.ts";
import { cardView } from "../composer/Card.ts";
import { STACK_CLASS } from "../composer/Classes.ts";
import { contextStripView } from "../composer/ContextStrip.ts";
import { hasNoProjects, headlineView, noProjectsView } from "./Headline.ts";

const page = (h: HtmlBuilder<Message>, child: Html): Html =>
  h.div(
    [
      h.DataAttribute("testid", "hero"),
      h.DataAttribute("chat-workspace-drop-target", "true"),
      h.DataAttribute("chat-canvas", "true"),
      h.Class(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-surface-ground"
      ),
    ],
    [child]
  );

/** The new-thread page: the headline and the composer box, or the no-projects hero. */
export const heroView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const inScratch = Option.exists(
    draftProject(model),
    (project) => project.kind === "scratch"
  );

  if (hasNoProjects(model) && !inScratch) {
    return page(h, noProjectsView(h));
  }

  return page(
    h,
    h.div(
      [
        h.DataAttribute("chat-composer-overlay", "true"),
        h.Class(
          "chat-composer-lane my-auto w-full px-(--space-3) py-(--space-6) sm:px-(--space-5)"
        ),
      ],
      [
        h.div(
          [
            h.DataAttribute("chat-composer-stack", "true"),
            h.Class(STACK_CLASS),
          ],
          [
            h.div([h.Class("pb-(--space-6)")], [headlineView(model, h)]),
            cardView(model, contextStripView(model, h), h),
          ]
        ),
      ]
    )
  );
};
