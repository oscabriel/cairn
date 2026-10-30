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
// The transcript's subagent rows (plan 6C), registered with the transcript as this chunk loads.
import "./timeline/SubagentRows.ts";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../Message.ts";
import type { Model } from "../Model.ts";
import { usageRouter } from "../Route.ts";
import { view as requestCardView } from "./card/View.ts";
import { view as rolesView } from "./meters/RolesView.ts";
import { view as usageView } from "./meters/UsageView.ts";
import { layout } from "./shell/Layout.ts";

/** The request card's update and root hooks, held by `FrameLoad.ts` once this chunk loads. */
export { requestCard } from "./card/Update.ts";

/** The meters' update and root hooks, held by `FrameLoad.ts` once this chunk loads (plan 6G). */
export { meters } from "./meters/Update.ts";

/** What the `next` frame draws inside a page the classic views still draw. */
export interface PageSlots {
  /** The role table, after the settings page's models section (plan 6G). */
  readonly roleTable: () => Html;
}

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
  /** The routed page: hero, draft, settings or not found, with the frame's slots in it. */
  readonly page: (slots: PageSlots) => Html;
  /** The routed thread's transcript, without the classic header and hold banner. */
  readonly thread: () => Html;
  /** The thread page's header controls (the diff toggle). */
  readonly threadControls: () => Html;
  /** The composer docked under a thread's transcript. */
  readonly composer: () => Html;
}

type H = HtmlBuilder<Message>;

/**
 * The composer's lane under an open thread: the request card (plan 6A), then the composer, which
 * gives the card its slot on the phone while a request shows (`next/card/card.css`). Siblings, so
 * the composer keeps its place in the tree and its Mounts.
 */
const composerLane = (
  model: Model,
  h: H,
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

/** The role table, drawn in the settings page's slot (plan 6G). */
const roleTable = (model: Model, h: H): Html =>
  h.submodel({
    slotId: "role-table",
    model: model.meters,
    view: rolesView,
    viewInputs: { usageHref: usageRouter() },
    toParentMessage: (message) => Message.GotMetersMessage({ message }),
  });

/** The usage page at `/usage` (plan 6G), opened from the shell's foot. */
const usagePage = (model: Model, h: H): Html =>
  h.submodel({
    slotId: "usage-page",
    model: model.meters,
    view: usageView,
    toParentMessage: (message) => Message.GotMetersMessage({ message }),
  });

/** The app drawn with the `next` views, over the same Model as the classic ones. */
export const view = (model: Model, h: H, regions: Regions): Document => ({
  title: "Cairn",
  body: layout(model, h, {
    notice: regions.notice,
    page: () => regions.page({ roleTable: () => roleTable(model, h) }),
    thread: regions.thread,
    threadControls: regions.threadControls,
    composerLane: () => composerLane(model, h, regions),
    usage: () => usagePage(model, h),
  }),
});
