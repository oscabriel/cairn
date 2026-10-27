// What the user asked the sidebar to change, before the brain has a command id for it. Update records
// an intent at once (so the row moves before the brain answers, see `Pending.ts`), and a Command mints
// the UUIDv7 command ids that turn intents into `shell.dispatch` commands for the outbox.

import { ThreadId } from "@cairn/protocol/Ids";
import type { CommandId } from "@cairn/protocol/Ids";
import {
  ProjectCreate,
  ThreadArchive,
  ThreadDelete,
  ThreadMarkUnread,
  ThreadPin,
  ThreadRename,
  ThreadSetAutoSettle,
  ThreadSettle,
  ThreadSnooze,
  ThreadUnpin,
  ThreadUnsettle,
  ThreadUnsnooze,
  ThreadVisit,
} from "@cairn/protocol/ShellCommands";
import type { ShellCommand } from "@cairn/protocol/ShellCommands";
import { Effect, Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { mintCommandId } from "../composer/Ids.ts";

/** One change the sidebar asks the brain for. */
export const Intent = defineTaggedUnion({
  Settle: { threadId: ThreadId },
  Unsettle: { threadId: ThreadId },
  Pin: { threadId: ThreadId },
  Unpin: { threadId: ThreadId },
  Snooze: { threadId: ThreadId, until: Schema.DateTimeUtc },
  Unsnooze: { threadId: ThreadId },
  Rename: { threadId: ThreadId, title: Schema.String },
  Visit: { threadId: ThreadId, at: Schema.DateTimeUtc },
  MarkUnread: { threadId: ThreadId },
  SetAutoSettle: { threadId: ThreadId, enabled: Schema.Boolean },
  Archive: { threadId: ThreadId },
  Delete: { threadId: ThreadId },
  AddProject: { workspaceRoot: Schema.String },
});

export type Intent = typeof Intent.Type;

/** The thread an intent changes; none for a project intent. */
export const intentThreadId = (intent: Intent): Option.Option<ThreadId> =>
  Intent.match(intent, {
    AddProject: () => Option.none(),
    Settle: ({ threadId }) => Option.some(threadId),
    Unsettle: ({ threadId }) => Option.some(threadId),
    Pin: ({ threadId }) => Option.some(threadId),
    Unpin: ({ threadId }) => Option.some(threadId),
    Snooze: ({ threadId }) => Option.some(threadId),
    Unsnooze: ({ threadId }) => Option.some(threadId),
    Rename: ({ threadId }) => Option.some(threadId),
    Visit: ({ threadId }) => Option.some(threadId),
    MarkUnread: ({ threadId }) => Option.some(threadId),
    SetAutoSettle: ({ threadId }) => Option.some(threadId),
    Archive: ({ threadId }) => Option.some(threadId),
    Delete: ({ threadId }) => Option.some(threadId),
  });

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
    Unsnooze: ({ threadId }) => ThreadUnsnooze.make({ commandId, threadId }),
    Rename: ({ threadId, title }) =>
      ThreadRename.make({ commandId, threadId, title }),
    Visit: ({ threadId, at }) => ThreadVisit.make({ commandId, threadId, at }),
    MarkUnread: ({ threadId }) =>
      ThreadMarkUnread.make({ commandId, threadId }),
    SetAutoSettle: ({ threadId, enabled }) =>
      ThreadSetAutoSettle.make({ commandId, threadId, enabled }),
    Archive: ({ threadId }) => ThreadArchive.make({ commandId, threadId }),
    Delete: ({ threadId }) => ThreadDelete.make({ commandId, threadId }),
    AddProject: ({ workspaceRoot }) =>
      ProjectCreate.make({ commandId, workspaceRoot, title: Option.none() }),
  });

/** A draft id for a new thread, a command id's UUIDv7, so a draft becomes a thread idempotently. */
export const mintDraftId: Effect.Effect<string> = Effect.map(
  mintCommandId,
  String
);
