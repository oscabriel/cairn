// The sidebar's Messages, and the OutMessage it hands the root: commands for the outbox.

import { ShellCommand } from "@cairn/protocol/ShellCommands";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

/** Everything the sidebar reacts to. */
export const Message = defineMessageUnion({
  /** The clock Subscription's tick. */
  Ticked: { nowMs: Schema.Finite },
  DetectedPlatform: { isMac: Schema.Boolean },
  LoadedShelves: {
    snoozedExpanded: Schema.Option(Schema.Boolean),
    settledExpanded: Schema.Option(Schema.Boolean),
  },
  CompletedSetBadge: {},
  CompletedNavigate: {},
  /** The viewport crossed the `md` breakpoint. */
  ChangedViewport: { isMobile: Schema.Boolean },
  /** A new draft id was minted for "New thread". */
  MintedDraftId: { draftId: Schema.String },
  ExpiredUndo: { version: Schema.Int },
  /** The command ids for these intents were minted; they go to the outbox. */
  IssuedCommands: { commands: Schema.Array(ShellCommand) },
  /** A shortcut from the key bindings fired, by command name. */
  PressedShortcut: { command: Schema.String },
});

export type Message = typeof Message.Type;

/** What the sidebar asks of the root. */
export const OutMessage = defineMessageUnion({
  /** Send these shell commands through the outbox, in order. */
  RequestedDispatch: { commands: Schema.Array(ShellCommand) },
});

export type OutMessage = typeof OutMessage.Type;
