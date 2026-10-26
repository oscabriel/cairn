// The root Messages. Everything a socket produces carries the epoch it belongs to, so a late
// Message from a released client is recognised and dropped.

import { Hello } from "@cairn/protocol/Rpc";
import { ShellStreamItem } from "@cairn/protocol/Shell";
import { Schema } from "effect";
import { Url } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";

import { Message as ComposerMessage } from "./composer/Message.ts";
import { OutboxItem } from "./connection/Outbox.ts";
import * as Thread from "./page/thread/index.ts";
import { Message as PushMessage } from "./push/Message.ts";
import { Message as SettingsMessage } from "./settings/Message.ts";
import { Message as ParkedMessage } from "./shell/Parked.ts";
import { Message as SidebarMessage } from "./sidebar/Message.ts";

/** Everything the root reacts to. */
export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url.Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},

  /** The client for the current epoch was built. */
  AcquiredConnection: {},
  /** The client of an earlier epoch was let go. */
  ReleasedConnection: {},
  /** Building the client failed. */
  FailedAcquireConnection: { reason: Schema.String },
  /** Something on the epoch's socket failed: the shell stream, hello or a call. */
  LostConnection: { epoch: Schema.Int, reason: Schema.String },
  /** The wait before attempt `attempt` of `epoch` is over. */
  ElapsedBackoff: { epoch: Schema.Int, attempt: Schema.Int },
  /** The page came back online, was shown again, or became visible. */
  WokeUp: {},

  SucceededHello: { epoch: Schema.Int, hello: Hello },
  ReceivedShellItem: { epoch: Schema.Int, item: ShellStreamItem },

  /** A new mutation for the brain; it waits in the outbox until acknowledged. */
  QueuedOutboxItem: { item: OutboxItem },
  /** The brain acknowledged the outbox item with `key`. */
  AcknowledgedOutboxItem: { epoch: Schema.Int, key: Schema.String },
  /**
   * Sending the outbox item with `key` failed. `transport` is a failure of the socket, not an
   * answer: the connection reports the loss, and the next one sends the item again.
   */
  FailedOutboxItem: {
    epoch: Schema.Int,
    key: Schema.String,
    retryable: Schema.Boolean,
    transport: Schema.Boolean,
    message: Schema.String,
  },
  /** The wait before sending the outbox item with `key` again, after a retryable failure, is over. */
  ElapsedResend: { epoch: Schema.Int, key: Schema.String },
  CompletedSaveOutbox: { saved: Schema.Boolean },
  /** The user closed the notice bar. */
  DismissedNotice: {},

  GotThreadMessage: { message: Thread.Message },
  GotSidebarMessage: { message: SidebarMessage },
  GotComposerMessage: { message: ComposerMessage },
  GotPushMessage: { message: PushMessage },
  GotSettingsMessage: { message: SettingsMessage },
  GotParkedMessage: { message: ParkedMessage },
  /** The settings page's view chunk loaded. */
  LoadedSettingsPage: {},
  /** The settings page's view chunk could not be fetched. */
  FailedSettingsPage: {},
});

export type Message = typeof Message.Type;
