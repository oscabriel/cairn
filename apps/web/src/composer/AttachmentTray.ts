// The composer's attachment tray and what the card needs to feed it: the tray itself (drawn between
// the editor and the footer, where t3code draws its attachment rows), the footer's Attach button,
// the form's drop and paste handling, and the tray's subscriptions. The tray is its own Submodel
// (`attachments/`): the composer keeps its Model under `attachments` and lifts its Messages with
// `GotAttachmentsMessage`. Everything here takes the lift as an argument, so it builds on its own.

import type { Option } from "effect";
import { Subscription } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message as TrayMessage } from "../attachments/Message.ts";
import type { Model as TrayModel } from "../attachments/Model.ts";
import { subscriptions as traySubscriptions } from "../attachments/Subscription.ts";
import { trayView } from "../attachments/View.ts";

/** The footer's Attach button, and the drop and paste handling of the composer's form. */
export {
  attachButtonView as attachButton,
  attachmentFormAttributes,
} from "../attachments/View.ts";

/** The open draft's tray, embedded as a Submodel of the composer's view. */
export const attachmentTray = <ParentMessage>(
  tray: TrayModel,
  draftKey: Option.Option<string>,
  toParentMessage: (message: TrayMessage) => ParentMessage,
  h: HtmlBuilder<ParentMessage>
): Html =>
  h.submodel({
    slotId: "attachment-tray",
    model: tray,
    view: trayView,
    viewInputs: { draftKey },
    toParentMessage,
  });

/** The tray's subscriptions (upload progress, pastes with focus on no field), lifted. */
export const attachmentSubscriptions = <ParentModel, ParentMessage>(config: {
  readonly read: (model: ParentModel) => Option.Option<TrayModel>;
  readonly toParentMessage: (message: TrayMessage) => ParentMessage;
}) =>
  Subscription.lift(traySubscriptions)<ParentModel, ParentMessage>({
    read: config.read,
    toParentMessage: config.toParentMessage,
  });
