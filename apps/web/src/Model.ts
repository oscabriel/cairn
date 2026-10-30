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
import * as Thread from "./page/thread/index.ts";
import { Model as PushModel } from "./push/Model.ts";
import { AppRoute } from "./Route.ts";
import { Model as SettingsModel } from "./settings/Model.ts";
import { Model as ParkedModel } from "./shell/Parked.ts";
import { BootData } from "./shell/ShellStore.ts";
import { Model as SidebarModel } from "./sidebar/Model.ts";

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
});

export type SentTurn = typeof SentTurn.Type;

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
  /** The key of the outbox item sent on the current epoch and not yet answered. */
  outboxInFlight: Schema.Option(Schema.String),
  /** Retryable failures of the outbox's head in a row; the next resend waits by this attempt. */
  outboxAttempt: Schema.Int,
  /** Turns not yet settled by the brain, by outbox key. Kept in memory only. */
  sentTurns: Schema.Record(Schema.String, SentTurn),
  /** A message for the user about something that did not work. */
  notice: Schema.Option(Schema.String),
  thread: Thread.Model.Model,
  sidebar: SidebarModel,
  composer: Composer.Model,
  push: PushModel,
  settings: SettingsModel,
  parked: ParkedModel,
  /** The request card the `next` views draw in the composer's lane (plan 6A). */
  requestCard: RequestCardModel,
  /** Where the settings page's lazily loaded view is (`SettingsPage.ts`). */
  settingsPage: Schema.Literals(["idle", "loading", "loaded", "failed"]),
});

export type Model = typeof Model.Type;

/** What the page starts with, read before the first update: boot data and the saved outbox. */
export const Flags = Schema.Struct({
  boot: Schema.Option(BootData),
  outbox: Schema.Array(OutboxItem),
});

export type Flags = typeof Flags.Type;
