// The root Model: the route, the connection, the shell, the outbox, and one child Model per page.
// Page state lives here under its own key, so leaving a page and coming back keeps it.
import { Hello } from "@cairn/protocol/Rpc";
import { ShellSnapshot } from "@cairn/protocol/Shell";
import { Schema } from "effect";

import * as Composer from "./composer/Model.ts";
import { OutboxItem } from "./connection/Outbox.ts";
import { Connection } from "./connection/Reconnect.ts";
import * as Thread from "./page/thread/index.ts";
import { Model as PushModel } from "./push/Model.ts";
import { AppRoute } from "./Route.ts";
import { BootData } from "./shell/ShellStore.ts";
import { Model as SidebarModel } from "./sidebar/Model.ts";

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
  /** A message for the user about something that did not work. */
  notice: Schema.Option(Schema.String),
  thread: Thread.Model.Model,
  sidebar: SidebarModel,
  composer: Composer.Model,
  push: PushModel,
});

export type Model = typeof Model.Type;

/** What the page starts with, read before the first update: boot data and the saved outbox. */
export const Flags = Schema.Struct({
  boot: Schema.Option(BootData),
  outbox: Schema.Array(OutboxItem),
});

export type Flags = typeof Flags.Type;
