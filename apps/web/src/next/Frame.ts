// The `next` views' frame (ADR 0040, plan look track L0): the root view the app draws when the `ui`
// client setting is `next`. It renders the same Model as the classic views, through the same
// Messages, and keeps the hooks the judges read (`Hooks.ts`). This module and what it alone imports
// are their own chunk, fetched by `FrameLoad.ts` the first time `ui` is `next`, so the entry bundle
// does not grow.
//
// The shell is `next`'s own (L6, `shell/Layout.ts`): the project rail, the project's sidebar list, the
// chat header, the hold banner and the scratch overlay. The page inside it is still drawn from the
// classic regions (the transcript, the composer, the hero and settings pages) until L7 redraws
// them, then phase 2's surfaces (wave 6). This file is integrator-only after L0.

import "./tokens.css";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../Message.ts";
import type { Model } from "../Model.ts";
import { view as requestCardView } from "./card/View.ts";
import { layout } from "./shell/Layout.ts";

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
  /** The routed page: hero, thread, draft, settings or not found. */
  readonly page: () => Html;
  /** The routed thread's transcript, without the classic header and hold banner. */
  readonly thread: () => Html;
  /** The thread page's header controls (the diff toggle). */
  readonly threadControls: () => Html;
  /** The composer docked under a thread's transcript. */
  readonly composer: () => Html;
}

/**
 * The composer's lane under an open thread: the request card (plan 6A), then the composer, which
 * gives the card its slot on the phone while a request shows (`next/card/card.css`). Siblings, so
 * the composer keeps its place in the tree and its Mounts.
 */
const composerLane = (
  model: Model,
  h: HtmlBuilder<Message>,
  regions: Regions
): ReadonlyArray<Html> => [
  h.submodel({
    slotId: "request-card",
    model: model.requestCard,
    view: requestCardView,
    toParentMessage: (message) => Message.GotRequestCardMessage({ message }),
  }),
  regions.composer(),
];

/** The app drawn with the `next` views, over the same Model as the classic ones. */
export const view = (
  model: Model,
  h: HtmlBuilder<Message>,
  regions: Regions
): Document => ({
  title: "Cairn",
  body: layout(model, h, {
    notice: regions.notice,
    page: regions.page,
    thread: regions.thread,
    threadControls: regions.threadControls,
    composerLane: () => composerLane(model, h, regions),
  }),
});
