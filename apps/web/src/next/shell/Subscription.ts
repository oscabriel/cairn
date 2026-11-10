// The `next` shell's Subscriptions: the clock its ages and visits read (every second while a row
// is working or waiting, else every 15 seconds), the key binding table (`Keys.ts`), Cmd+J and
// Ctrl+J, which show or hide the scratch thread on any platform, even while typing (the user,
// 2026-10-29), and Escape, which closes an open menu (each overlay is a dialog that takes its own,
// `next/ui/Sheet.ts`). A work panel row's "Stop?" lets go after a pause, since a tap in WebKit
// never blurs it (U-3). The window's width at `lg` says whether the work and goal panels are
// columns or sheets.

import { threadStatus } from "@cairn/client-logic/ThreadState";
import { Clock, Duration, Effect, Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import {
  streamFromEventFilterMap,
  streamFromKeyBindings,
  streamFromMediaQuery,
} from "foldkit/dom";

import type { Services } from "./Command.ts";
import { keyBindings } from "./Keys.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";

// `Stream.tick` emits at once; the first tick is dropped because the stream restarts whenever a
// row starts or stops running, and a streaming thread does that several times a second.
const clock = (fast: boolean): Stream.Stream<Message> =>
  Stream.tick(Duration.seconds(fast ? 1 : 15)).pipe(
    Stream.drop(1),
    Stream.mapEffect(() =>
      Effect.map(Clock.currentTimeMillis, (nowMs) => Message.Ticked({ nowMs }))
    )
  );

/** True while a row of the shell is working or waiting: its age then counts seconds. */
const hasRunningRow = (model: Model): boolean =>
  Option.exists(model.context.shell, (shell) =>
    shell.threads.some((thread) => {
      const status = threadStatus(thread, Option.none());

      return status === "working" || status === "waiting";
    })
  );

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

/** Tailwind's `lg`: from here the work and goal panels are columns beside the chat. */
const WIDE_QUERY = "(min-width: 64rem)";

const wide: Stream.Stream<Message> = streamFromMediaQuery({
  query: WIDE_QUERY,
  mapMatches: (isWide) => Message.ChangedWidth({ isWide }),
});

/** How long a row's "Stop?" waits for its second press before it lets go. */
export const STOP_ASK_MS = 5000;

/** The pause after a row's first press: a new question, or none, starts it again. */
const stopAsked = (armed: Option.Option<string>): Stream.Stream<Message> =>
  Option.match(armed, {
    onNone: () => Stream.empty,
    onSome: (key) =>
      Stream.fromEffect(
        Effect.as(
          Effect.sleep(Duration.millis(STOP_ASK_MS)),
          Message.LapsedStop({ key })
        )
      ),
  });

/** The shell's subscriptions. */
export const subscriptions = Subscription.make<Model, Message, Services>()(
  (entry) => ({
    clock: entry(
      { fast: Schema.Boolean },
      {
        modelToDependencies: (model) => ({ fast: hasRunningRow(model) }),
        dependenciesToStream: ({ fast }) => clock(fast),
      }
    ),
    keyBindings: Subscription.persistentEntry(
      streamFromKeyBindings<Message>({ bindings: keyBindings })
    ),
    scratchShortcut: Subscription.persistentEntry(scratchShortcut),
    escape: entry(
      { open: Schema.Boolean },
      {
        modelToDependencies: (model) => ({ open: Option.isSome(model.menu) }),
        dependenciesToStream: ({ open }) => (open ? escape : Stream.empty),
      }
    ),
    width: Subscription.persistentEntry(wide),
    stopAsked: entry(
      { armed: Schema.Option(Schema.String) },
      {
        modelToDependencies: (model) => ({ armed: model.work.armedStop }),
        dependenciesToStream: ({ armed }) => stopAsked(armed),
      }
    ),
  })
);
