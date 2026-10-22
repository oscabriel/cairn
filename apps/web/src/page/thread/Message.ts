// The thread page's Messages. Stream Messages carry the epoch and watch number they were opened
// under, so a late item from a closed subscription is recognised and dropped.
import { ThreadStreamItem } from "@cairn/protocol/Thread";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

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
});

export type Message = typeof Message.Type;
