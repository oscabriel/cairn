// The root Model: the route, the connection, the shell, the outbox, and one child Model per page.
// Page state lives here under its own key, so leaving a page and coming back keeps it.

import { AttachmentRef } from "@cairn/protocol/Attachments";
import { Hello } from "@cairn/protocol/Rpc";
import { ShellSnapshot } from "@cairn/protocol/Shell";
import { Schema } from "effect";

import * as Composer from "./composer/Model.ts";
import { OutboxItem } from "./connection/Outbox.ts";
import { Connection } from "./connection/Reconnect.ts";
import { Model as RequestCardModel } from "./next/card/Model.ts";
import { Model as MetersModel } from "./next/meters/Model.ts";
import { Model as ChunksModel } from "./next/page/Chunks.ts";
import { Model as HoldModel } from "./next/shell/Hold.ts";
import { Model as NextShellModel } from "./next/shell/Model.ts";
import * as Thread from "./page/thread/index.ts";
import { Model as PushModel } from "./push/Model.ts";
import { AppRoute } from "./Route.ts";
import { Model as SettingsModel } from "./settings/Model.ts";
import { BootData } from "./shell/ShellStore.ts";
import { QueuedSend } from "./timeline/Model.ts";

/**
 * A turn handed to the outbox, kept until the brain has it so a refusal can put it back in the
 * composer: a send until it is acknowledged, a launch until its thread starts or fails.
 */
export const SentTurn = Schema.Struct({
  item: OutboxItem,
  /** The refs of its attachments; the turn itself carries only their ids. */
  attachments: Schema.Array(AttachmentRef),
  /** The brain acknowledged it; a launch then waits for its shell row to leave `preparing`. */
  acknowledged: Schema.Boolean,
  /** Sent from the scratch overlay, so a refusal puts its words back there, not in the composer. */
  fromScratch: Schema.Boolean,
});

export type SentTurn = typeof SentTurn.Type;

/**
 * A send (or a launch's first message) the brain acknowledged whose own row has not reached its
 * thread's transcript yet: its pending row stays, marked sent, until that row or the brain's queue
 * shows it, or the page leaves the thread.
 */
export const AwaitedSend = Schema.Struct({
  threadId: Schema.String,
  send: QueuedSend,
  /** The newest entry its thread showed before it was sent: its own row comes after it. */
  since: Schema.Option(Schema.Int),
  /** A launch's first message: it goes if the launch fails, since no row will come. */
  launch: Schema.Boolean,
});

export type AwaitedSend = typeof AwaitedSend.Type;

/** The root Model. */
export const Model = Schema.Struct({
  route: AppRoute,
  connection: Connection,
  /** The current epoch's `session.hello`, once it answered. */
  hello: Schema.Option(Hello),
  /** The shell as of its last applied item; none until boot data or the first snapshot. */
  shell: Schema.Option(ShellSnapshot),
  /** Mutations waiting for the brain, oldest first. */
  outbox: Schema.Array(OutboxItem),
  /** The outbox as this tab last read or wrote it in storage; a save writes what changed since. */
  outboxStored: Schema.Array(OutboxItem),
  /** The keys of the outbox items sent on the current epoch and not yet answered, one per lane. */
  outboxInFlight: Schema.Array(Schema.String),
  /** Retryable failures in a row, by the key of the lane head they befell; its resend waits by them. */
  outboxAttempt: Schema.Record(Schema.String, Schema.Int),
  /**
   * The keys of the items waiting out their resend backoff after the brain answered "not now";
   * nothing more of their lanes is sent until a timer elapses, or a new epoch starts.
   */
  outboxResend: Schema.Array(Schema.String),
  /** Turns not yet settled by the brain, by outbox key. Kept in memory only. */
  sentTurns: Schema.Record(Schema.String, SentTurn),
  /**
   * The newest entry id each queued send's thread showed when this tab first saw the send queued, by
   * outbox key: its own row is a user row past it, so an earlier row with the same words is not it.
   * None for an item this page did not queue (read from storage at start, or adopted from another
   * tab), or queued while no page showed its thread's view: its row may already be there, or come
   * in the view that arrives, so once acknowledged it is matched against any row.
   * Kept in memory only.
   */
  outboxSince: Schema.Record(Schema.String, Schema.Option(Schema.Int)),
  /** Acknowledged sends still drawn as pending rows, oldest first. Kept in memory only. */
  outboxEchoes: Schema.Array(AwaitedSend),
  /**
   * Keys of the items another tab queued, folded in from storage after this page started. This tab
   * sends them too, but a refused turn is the queuing tab's to put back: it alone has the record.
   */
  outboxAdopted: Schema.Array(Schema.String),
  /**
   * Adopted turns the brain refused here: left in the outbox for the tab that queued them, and not
   * sent from this tab again.
   */
  outboxLeft: Schema.Array(Schema.String),
  /** A message for the user about something that did not work. */
  notice: Schema.Option(Schema.String),
  thread: Thread.Model.Model,
  composer: Composer.Model,
  push: PushModel,
  settings: SettingsModel,
  hold: HoldModel,
  /** The `next` views' shell: the rail, the project's list, the scratch overlay (ADR 0040). */
  nextShell: NextShellModel,
  /** The scratch thread's page, for the `next` shell's overlay; no thread while it is hidden. */
  scratchThread: Thread.Model.Model,
  /** The request card the `next` views draw in the composer's lane (plan 6A). */
  requestCard: RequestCardModel,
  /** The usage page the `next` views draw (plan 6G). */
  meters: MetersModel,
  /** The views a cold load never draws, fetched as chunks on demand (`next/page/Chunks.ts`). */
  chunks: ChunksModel,
});

export type Model = typeof Model.Type;

/** What the page starts with, read before the first update: boot data and the saved outbox. */
export const Flags = Schema.Struct({
  boot: Schema.Option(BootData),
  outbox: Schema.Array(OutboxItem),
  /** Storage also holds outbox items this build cannot decode, kept as they are, not told about yet. */
  outboxUnread: Schema.Boolean,
});

export type Flags = typeof Flags.Type;
