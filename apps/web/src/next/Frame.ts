// The `next` views' frame (ADR 0040, plan look track L0): the root view the app draws when the `ui`
// client setting is `next`. It renders the same Model as the classic views, through the same
// Messages, and keeps the hooks the judges read (`Hooks.ts`). This module and what it alone imports
// are their own chunk, fetched by `FrameLoad.ts` the first time `ui` is `next`, so the entry bundle
// does not grow.
//
// It starts as a frame around the classic regions, marked `data-ui="next"` so `next`'s tokens can
// scope to it. Each look-track package replaces a region with its own view here: the shell (L6),
// the composer, transcript, diff and settings (L7), then phase 2's surfaces (wave 6). This file is
// integrator-only after L0.

import "./tokens.css";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../Message.ts";
import type { Model } from "../Model.ts";
import { view as requestCardView } from "./card/View.ts";

/** The request card's update and root hooks, held by `FrameLoad.ts` once this chunk loads. */
export { requestCard } from "./card/Update.ts";

/**
 * The regions the classic views draw, handed to the frame until `next` draws its own. Each is a
 * thunk, so a region `next` has replaced is never built.
 */
export interface Regions {
  /** The sidebar's open state, for the wrapper's `data-sidebar-state`. */
  readonly sidebarState: string;
  /** The sidebar: projects, threads, search and shelves. */
  readonly sidebar: () => Html;
  /** The notice bar above the page; empty when there is no notice. */
  readonly notice: () => Html;
  /**
   * The routed page: hero, thread, draft, settings or not found. Under an open thread,
   * `composerLane` draws around the docked composer what its lane holds besides it.
   */
  readonly page: (
    composerLane: (composer: () => Html) => ReadonlyArray<Html>
  ) => Html;
}

/**
 * The composer's lane under an open thread: the request card (plan 6A), then the composer, which
 * gives the card its slot on the phone while a request shows (`next/card/card.css`). Siblings, so
 * the composer keeps its place in the tree and its Mounts.
 */
const composerLane = (
  model: Model,
  h: HtmlBuilder<Message>,
  composer: () => Html
): ReadonlyArray<Html> => [
  h.submodel({
    slotId: "request-card",
    model: model.requestCard,
    view: requestCardView,
    toParentMessage: (message) => Message.GotRequestCardMessage({ message }),
  }),
  composer(),
];

/** The app drawn with the `next` views, over the same Model as the classic ones. */
export const view = (
  model: Model,
  h: HtmlBuilder<Message>,
  regions: Regions
): Document => ({
  title: "Cairn",
  body: h.div(
    [
      // Foldkit replaces the mount node with this element unless the two match, so it keeps
      // index.html's id and with it the #root rules in styles.css (the safe-area top inset).
      h.Id("root"),
      h.DataAttribute("ui", "next"),
      h.DataAttribute("route", model.route._tag),
      h.DataAttribute("slot", "sidebar-wrapper"),
      h.DataAttribute("sidebar-state", regions.sidebarState),
      h.Class(
        "group/sidebar-wrapper flex min-h-svh w-full max-sm:[--workspace-titlebar-control-size:--spacing(8)] h-dvh! min-h-0!"
      ),
    ],
    [
      regions.sidebar(),
      h.main(
        [
          h.DataAttribute("slot", "sidebar-inset"),
          h.Class(
            "relative flex min-w-0 w-full flex-1 flex-col bg-background text-foreground surface-grain h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
          ),
        ],
        [
          regions.notice(),
          regions.page((composer) => composerLane(model, h, composer)),
        ]
      ),
    ]
  ),
});
