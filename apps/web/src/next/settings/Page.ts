// The `next` settings page as the frame places it (plan look track L7): the settings Submodel
// drawn with the `next` view (`View.ts`), with the push toggle (`next/push/View.ts`) in its
// notifications section and the frame's role table (plan 6G) after its models section. The page
// comes with the `next` chunk, so it needs no chunk of its own as classic's does.

import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../../Message.ts";
import type { Model } from "../../Model.ts";
import { view as pushView } from "../push/View.ts";
import { view as settingsView } from "./View.ts";

/** What the frame draws inside the settings page. */
export interface SettingsSlots {
  /** The role table, after the models section (plan 6G). */
  readonly roleTable: () => Html;
}

/** The settings page. */
export const settingsPageView = (
  model: Model,
  h: HtmlBuilder<Message>,
  slots: SettingsSlots
): Html =>
  h.submodel({
    slotId: "settings",
    model: model.settings,
    view: settingsView,
    viewInputs: {
      notifications: () =>
        h.submodel({
          slotId: "push-toggle",
          model: model.push,
          view: pushView,
          toParentMessage: (message) => Message.GotPushMessage({ message }),
        }),
      roleTable: slots.roleTable,
    },
    toParentMessage: (message) => Message.GotSettingsMessage({ message }),
  });
