// The `next` shell's Subscriptions: Cmd+J and Ctrl+J show or hide the scratch thread on any
// platform, even while typing (the user, 2026-10-29), and Escape closes the add-project picker, the
// refresh confirm or the overlay while one is open. The root lifts them only while the `next` views draw.

import { Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { streamFromEventFilterMap, streamFromKeyBindings } from "foldkit/dom";

import type { Services } from "./Command.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";

/** The scratch thread's shortcut: Command or Control with J, whatever the platform. */
export const SCRATCH_KEYS = ["Meta+j", "Control+j"] as const;

const scratchShortcut = streamFromKeyBindings<Message>({
  bindings: SCRATCH_KEYS.map((keys) => ({
    keys,
    whileTyping: "Allow" as const,
    mapEvent: () => Message.PressedScratchShortcut(),
  })),
});

const escape: Stream.Stream<Message> = streamFromEventFilterMap({
  target: document,
  type: "keydown",
  filterMapEvent: (event) =>
    event.key === "Escape" && !event.isComposing
      ? Option.some(Message.PressedEscape())
      : Option.none(),
});

/** The shell's subscriptions. */
export const subscriptions = Subscription.make<Model, Message, Services>()(
  (entry) => ({
    scratchShortcut: Subscription.persistentEntry(scratchShortcut),
    escape: entry(
      { open: Schema.Boolean },
      {
        modelToDependencies: (model) => ({
          open:
            model.scratch.isOpen ||
            Option.isSome(model.refresh) ||
            Option.isSome(model.addProject),
        }),
        dependenciesToStream: ({ open }) => (open ? escape : Stream.empty),
      }
    ),
  })
);
