// What the user asked the sidebar to change, before the brain has a command id for it. Update records
// an intent at once (so the row moves before the brain answers, see `Pending.ts`), and a Command mints
// the UUIDv7 command ids that turn intents into `shell.dispatch` commands for the outbox.
import { CommandId, ThreadId } from "@cairn/protocol/Ids";
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
import { Clock, Effect, Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

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

const decodeCommandId = Schema.decodeSync(CommandId);

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A UUIDv7 command id: 48 bits of `Clock` milliseconds, the version and variant bits, and random
 * bits from the platform's secure generator.
 */
export const mintCommandId: Effect.Effect<CommandId> = Effect.gen(function* () {
  const millis = yield* Clock.currentTimeMillis;

  const bytes = yield* Effect.sync(() =>
    globalThis.crypto.getRandomValues(new Uint8Array(16))
  );

  let remaining = Math.trunc(millis);

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }

  bytes[6] = 0x70 + ((bytes[6] ?? 0) % 16);
  bytes[8] = 0x80 + ((bytes[8] ?? 0) % 64);

  const digits = hex(bytes);

  return decodeCommandId(
    `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`
  );
});

/** A draft id for a new thread, minted the same way so a draft becomes a thread idempotently. */
export const mintDraftId: Effect.Effect<string> = Effect.map(
  mintCommandId,
  String
);
