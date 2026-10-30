// The push toggle (plan look track L7), over the push Submodel and its update, drawn with the
// switch on the settings page: "Notify me on this device", what it is for, and the note that says
// why it cannot be turned on when it cannot.

import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../../push/Message.ts";
import { PushStatus } from "../../push/Model.ts";
import type { Model } from "../../push/Model.ts";
import { switchControl } from "../settings/Controls.ts";
import { TYPE } from "../ui/Classes.ts";

/** The switch's element id; the settings page and judges find it by this. */
export const PUSH_SWITCH_ID = "push-notifications";

/** The line under the switch, when there is something to say. */
export const pushNote = (model: Model): Option.Option<string> => {
  if (Option.contains(model.support, "needs-home-screen")) {
    return Option.some(
      "On iPhone and iPad, add Cairn to the Home Screen first (Share, then Add to Home Screen) and open it from there."
    );
  }

  if (Option.contains(model.support, "unsupported")) {
    return Option.some("This browser cannot show notifications from Cairn.");
  }

  const failure = PushStatus.match(model.status, {
    Unknown: () => Option.none<string>(),
    Off: () => Option.none<string>(),
    On: () => Option.none<string>(),
    Working: () => Option.none<string>(),
    Failed: ({ message }) => Option.some(message),
  });

  if (Option.isSome(failure)) {
    return failure;
  }

  if (model.permission === "denied") {
    return Option.some(
      "Notifications are blocked for Cairn. Allow them in this browser's site settings."
    );
  }

  return Option.none();
};

const isOn = (model: Model): boolean =>
  PushStatus.match(model.status, {
    Unknown: () => false,
    Off: () => false,
    On: () => true,
    Working: () => false,
    Failed: () => false,
  });

const isDisabled = (model: Model): boolean =>
  !Option.contains(model.support, "supported") ||
  model.permission === "denied" ||
  PushStatus.match(model.status, {
    Unknown: () => true,
    Off: () => false,
    On: () => false,
    Working: () => true,
    Failed: () => false,
  });

const content = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.DataAttribute("testid", "push-toggle"),
      h.Class("flex flex-col gap-(--space-1)"),
    ],
    [
      switchControl(h, {
        id: PUSH_SWITCH_ID,
        label: "Notify me on this device",
        showLabel: true,
        isChecked: isOn(model),
        isDisabled: isDisabled(model),
        onToggle: (isChecked) => Message.ToggledNotifications({ isChecked }),
      }),
      h.p(
        [h.Class(`text-ink-2 ${TYPE.small}`)],
        [
          "A notification when a long run finishes or fails while Cairn is not on screen.",
        ]
      ),
      Option.match(pushNote(model), {
        onNone: () => h.empty,
        onSome: (note) =>
          h.p(
            [
              h.DataAttribute("testid", "push-note"),
              h.Role("status"),
              h.Class(`text-ink-2 ${TYPE.small}`),
            ],
            [note]
          ),
      }),
    ]
  );

/** The toggle, as the `next` settings page embeds it with `h.submodel`. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  content(model, h)
);
