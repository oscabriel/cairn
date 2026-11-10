// The hero (plan look track L7): the page where a new thread starts, under the shell's chat
// header (L6's `shell/Header.ts`, which already says "New thread", so the hero draws no header
// of its own, as classic's hero did). The headline and the composer box sit together in
// the middle of the page, one lane wide; with no project to offer, the hero asks for one first.
// The `/`, `@` and `$` menu's drawer opens over the headline here rather than in the page's flow,
// so the centred block keeps its height and the box being typed in never moves, and its list is
// never taller than the space above the box, so a short page never hides its first rows (U-21).
// The headline stays drawn behind an open drawer (the user, 2026-11-10): the drawer covers what it
// lies over, and whatever its rows leave above it of the question and the picker still shows.

import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { cardView } from "../composer/Card.ts";
import { STACK_CLASS } from "../composer/Classes.ts";
import { contextStripView } from "../composer/ContextStrip.ts";
import { draftProject } from "../composer/Drafts.ts";
import { KeepDrawerRoom } from "../composer/HeroDrawerRoom.ts";
import type { Message } from "../composer/Message.ts";
import type { Model } from "../composer/Model.ts";
import { hasNoProjects, headlineView, noProjectsView } from "./Headline.ts";

/**
 * The trigger menu's drawer (`composer/TriggerMenuView.ts`, `data-composer-drawer-layer`) taken out
 * of the hero's flow and laid over the space above the box, so opening it, or the list growing and
 * shrinking as it filters, moves neither the headline nor the box. Its list is at most 18rem and at
 * most that space less a margin (`--hero-drawer-room`, kept by `KeepDrawerRoom`), so its first rows
 * never sit above the page's top, where no scroll reaches, nor touch it; it scrolls inside itself
 * instead. However little room there is, it holds one whole row (a touch row and its padding).
 */
const DRAWER_OVER_HEADLINE = [
  "[&_[data-composer-drawer-layer]]:absolute",
  "[&_[data-composer-drawer-layer]]:inset-x-0",
  "[&_[data-composer-drawer-layer]]:bottom-full",
  // `--hero-drawer-room` is `composer/HeroDrawerRoom.ts`'s property, written out so the stylesheet build sees it.
  "[&_[data-slot=command-list]]:max-h-[max(calc(var(--hit-target)_+_2_*_var(--space-1-5)),min(18rem,calc(var(--hero-drawer-room,18rem)_-_var(--space-3))))]",
].join(" ");

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
        h.OnMount(KeepDrawerRoom()),
        h.Class(
          "chat-composer-lane my-auto w-full px-(--space-3) py-(--space-6) sm:px-(--space-5)"
        ),
      ],
      [
        h.div(
          [
            h.DataAttribute("chat-composer-stack", "true"),
            h.Class(`${STACK_CLASS} ${DRAWER_OVER_HEADLINE}`),
          ],
          [
            h.div(
              [
                h.DataAttribute("hero-headline-block", ""),
                h.Class("pb-(--space-6)"),
              ],
              [headlineView(model, h)]
            ),
            cardView(model, contextStripView(model, h), h),
          ]
        ),
      ]
    )
  );
};
