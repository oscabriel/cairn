// The app's frame (ADR 0040, plan look track L0; the only views since the cutover, plan 7A). It
// keeps the hooks the judges read (`Hooks.ts`).
//
// The shell (L6, `shell/Layout.ts`): the project rail, the project's sidebar list, the chat header,
// the hold banner and the scratch overlay. The page inside it (L7, `page/Regions.ts`): the hero and
// the composer, the thread page and its transcript, the diff toggle and the settings page. The root
// hands it only the notice bar. This file is integrator-only.

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
import * as Pages from "./page/Regions.ts";
import { parentBanner } from "./rollup/ParentBanner.ts";
import { layout } from "./shell/Layout.ts";

/** The regions the root draws and hands to the frame. */
export interface Regions {
  /** The notice bar above the page; empty when there is no notice. */
  readonly notice: () => Html;
}

type H = HtmlBuilder<Message>;

/**
 * The composer's lane under an open thread: the parent banner while a subagent asks the user (plan
 * 6D), the request card (plan 6A), then the composer, which gives the card its slot on the phone
 * while a request shows (`next/card/card.css`). Siblings, so the composer keeps its place in the
 * tree and its Mounts.
 */
const composerLane = (model: Model, h: H): ReadonlyArray<Html> => [
  parentBanner(model, h),
  h.submodel({
    slotId: "request-card",
    model: model.requestCard,
    view: requestCardView,
    toParentMessage: (message) => Message.GotRequestCardMessage({ message }),
  }),
  Pages.dockedComposer(model, h),
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

/** The app. */
export const view = (model: Model, h: H, regions: Regions): Document => ({
  title: "Cairn",
  body: layout(model, h, {
    notice: regions.notice,
    page: () => Pages.page(model, h, { roleTable: () => roleTable(model, h) }),
    thread: () => Pages.threadBody(model, h),
    threadControls: () => Pages.threadControls(model, h),
    composerLane: () => composerLane(model, h),
    usage: () => usagePage(model, h),
  }),
});
