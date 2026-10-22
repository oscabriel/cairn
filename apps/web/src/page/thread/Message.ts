// The thread page's Messages. Stream Messages carry the epoch and watch number they were opened
// under, so a late item from a closed subscription is recognised and dropped.
import { ThreadStreamItem } from "@cairn/protocol/Thread";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { OutboxItem } from "../../connection/Outbox.ts";
import { Message as TimelineMessage } from "../../timeline/Message.ts";

/** Everything the thread page reacts to. */
export const Message = defineMessageUnion({
  /** One item of the thread stream. */
  ReceivedThreadItem: {
    epoch: Schema.Int,
    watch: Schema.Int,
    item: ThreadStreamItem,
  },
  /** The thread stream ended or failed. `missing` when the brain has no such thread. */
  EndedThreadStream: {
    epoch: Schema.Int,
    watch: Schema.Int,
    missing: Schema.Boolean,
    reason: Schema.String,
  },
  /** A Message of the transcript. */
  GotTimelineMessage: { message: TimelineMessage },
});

export type Message = typeof Message.Type;

/** What the thread page asks of the root. */
export const OutMessage = defineMessageUnion({
  /** A turn to queue in the outbox (the transcript's Retry). */
  RequestedSend: { item: OutboxItem },
});

export type OutMessage = typeof OutMessage.Type;
