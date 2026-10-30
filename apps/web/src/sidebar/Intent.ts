// What the user asked the sidebar to change, before the brain has a command id for it. Update records
// an intent at once (so the row moves before the brain answers, see `Pending.ts`), and a Command mints
// the UUIDv7 command ids that turn intents into `shell.dispatch` commands for the outbox.

import { ThreadId } from "@cairn/protocol/Ids";
import type { CommandId } from "@cairn/protocol/Ids";
import {
  ThreadPin,
  ThreadSettle,
  ThreadSnooze,
  ThreadUnpin,
  ThreadUnsettle,
  ThreadVisit,
} from "@cairn/protocol/ShellCommands";
import type { ShellCommand } from "@cairn/protocol/ShellCommands";
import { Effect, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { mintCommandId } from "../composer/Ids.ts";

/** One change the sidebar asks the brain for. */
export const Intent = defineTaggedUnion({
  Settle: { threadId: ThreadId },
  Unsettle: { threadId: ThreadId },
  Pin: { threadId: ThreadId },
  Unpin: { threadId: ThreadId },
  Snooze: { threadId: ThreadId, until: Schema.DateTimeUtc },
  Visit: { threadId: ThreadId, at: Schema.DateTimeUtc },
});

export type Intent = typeof Intent.Type;

/** The `shell.dispatch` command for an intent, under a freshly minted id. */
export const toShellCommand = (
  intent: Intent,
  commandId: CommandId
): ShellCommand =>
  Intent.match<ShellCommand>(intent, {
    Settle: ({ threadId }) => ThreadSettle.make({ commandId, threadId }),
    Unsettle: ({ threadId }) => ThreadUnsettle.make({ commandId, threadId }),
    Pin: ({ threadId }) => ThreadPin.make({ commandId, threadId }),
    Unpin: ({ threadId }) => ThreadUnpin.make({ commandId, threadId }),
    Snooze: ({ threadId, until }) =>
      ThreadSnooze.make({ commandId, threadId, until }),
    Visit: ({ threadId, at }) => ThreadVisit.make({ commandId, threadId, at }),
  });

/** A draft id for a new thread, a command id's UUIDv7, so a draft becomes a thread idempotently. */
export const mintDraftId: Effect.Effect<string> = Effect.map(
  mintCommandId,
  String
);
