// The sidebar's Subscriptions: the clock its labels read (every second while a row shows a running
// duration, else every 15 seconds), the default key bindings (one `streamFromKeyBindings` table), the
// `md` breakpoint, and the undo notice's timer.

import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  firesWhileTyping,
  toFoldkitKeys,
} from "@cairn/client-logic/Keybindings";
import type { KeybindingCommand } from "@cairn/client-logic/Keybindings";
import { threadStatus } from "@cairn/client-logic/ThreadState";
import { Clock, Duration, Effect, Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { streamFromKeyBindings, streamFromMediaQuery } from "foldkit/dom";
import type { KeyBinding } from "foldkit/dom";

import { UNDO_NOTICE_MS } from "./Command.ts";
import type { Services } from "./Command.ts";
import { threadsOf } from "./Derived.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";

/** The commands the sidebar answers; the others are bound by the pages that own them. */
const SIDEBAR_COMMANDS: ReadonlySet<KeybindingCommand> = new Set([
  "sidebar.toggle",
  "chat.new",
  "chat.newLocal",
  "chat.newWithoutProject",
  "thread.previous",
  "thread.next",
  "thread.settle",
  "thread.pin",
  "thread.undo",
]);

const keyBindings: ReadonlyArray<KeyBinding<Message>> =
  DEFAULT_RESOLVED_KEYBINDINGS.filter((rule) =>
    SIDEBAR_COMMANDS.has(rule.command)
  ).map((rule) => ({
    keys: toFoldkitKeys(rule.shortcut),
    whileTyping: firesWhileTyping(rule, {}) ? "Allow" : "Suppress",
    mapEvent: () => Message.PressedShortcut({ command: rule.command }),
  }));

// `Stream.tick` emits at once; the first tick is dropped because the stream restarts whenever a
// row starts or stops running, and a streaming thread does that several times a second.
const clock = (fast: boolean): Stream.Stream<Message> =>
  Stream.tick(Duration.seconds(fast ? 1 : 15)).pipe(
    Stream.drop(1),
    Stream.mapEffect(() =>
      Effect.map(Clock.currentTimeMillis, (nowMs) => Message.Ticked({ nowMs }))
    )
  );

const hasRunningRow = (model: Model): boolean =>
  threadsOf(model).some((thread) => {
    const status = threadStatus(thread, Option.none());

    return status === "working" || status === "waiting";
  });

/** The sidebar's subscriptions. */
export const subscriptions = Subscription.make<Model, Message, Services>()(
  (entry) => ({
    clock: entry(
      { fast: Schema.Boolean },
      {
        modelToDependencies: (model) => ({ fast: hasRunningRow(model) }),
        dependenciesToStream: ({ fast }) => clock(fast),
      }
    ),
    undoTimer: entry(
      { version: Schema.Option(Schema.Int) },
      {
        modelToDependencies: (model) => ({
          version: Option.map(model.undo, (notice) => notice.version),
        }),
        dependenciesToStream: ({ version }) =>
          Option.match(version, {
            onNone: () => Stream.empty,
            onSome: (current) =>
              Stream.fromEffect(
                Effect.sleep(Duration.millis(UNDO_NOTICE_MS)).pipe(
                  Effect.as(Message.ExpiredUndo({ version: current }))
                )
              ),
          }),
      }
    ),
    keyBindings: Subscription.persistentEntry(
      streamFromKeyBindings<Message>({ bindings: keyBindings })
    ),
    viewport: Subscription.persistentEntry(
      streamFromMediaQuery({
        query: "(max-width: 767px)",
        mapMatches: (isMobile) => Message.ChangedViewport({ isMobile }),
      })
    ),
  })
);
