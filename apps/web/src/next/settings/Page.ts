// The `next` settings page as the frame places it (plan look track L7): the settings Submodel
// drawn with the `next` view (`View.ts`), with the push toggle (`next/push/View.ts`) in its
// notifications section. This module is the `settings` chunk (`next/page/Chunks.ts`), loaded when
// the route first needs it, so import it only through the chunk: a static import pulls the
// settings view back into the entry.

import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../../Message.ts";
import type { Model } from "../../Model.ts";
import { view as pushView } from "../push/View.ts";
import { view as settingsView } from "./View.ts";

/** The settings page. */
export const settingsPageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: "settings",
    model: model.settings,
    view: settingsView,
    viewInputs: {
      isMac: model.nextShell.isMac,
      notifications: () =>
        h.submodel({
          slotId: "push-toggle",
          model: model.push,
          view: pushView,
          toParentMessage: (message) => Message.GotPushMessage({ message }),
        }),
    },
    toParentMessage: (message) => Message.GotSettingsMessage({ message }),
  });
