import { ConversationView } from "@cairn/protocol/Thread";
import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { queuedInputs } from "./Queue.ts";

const viewWithInbox = (items: ReadonlyArray<Schema.Json>) =>
  Schema.decodeSync(ConversationView)({
    conversation: { id: 1 },
    entries: [],
    docs: { "pi.inbox": { items } },
  });

describe("the queued inputs", () => {
  it("list the user's words, not the lines the brain added for attachments", () => {
    const inputs = queuedInputs(
      Option.some(
        viewWithInbox([
          {
            id: 4,
            mode: "followUp",
            content: [
              { type: "text", text: "look" },
              { type: "image", mimeType: "image/png", data: "AAAA" },
              {
                type: "text",
                text: '[Attached image "dot.png" (image/png, 1 KB) is saved at: /data/attachments/a1/original]',
              },
            ],
          },
          {
            id: 5,
            mode: "steer",
            content: [
              {
                type: "text",
                text: '<attachment name="notes.txt" type="text/plain" path="/data/attachments/a2/original">\nhello\n</attachment>',
              },
            ],
          },
        ])
      )
    );

    expect(inputs.map((input) => input.text)).toStrictEqual([
      "look",
      "(attachments)",
    ]);
  });
});
