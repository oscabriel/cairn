import { ThreadId } from "@cairn/protocol/Ids";
import { ThreadStreamItem } from "@cairn/protocol/Thread";
import { Option, Schema } from "effect";
import { given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";

import { entryLines } from "./EntryText.ts";
import { Message } from "./Message.ts";
import { initial } from "./Model.ts";
import { inform, update } from "./Update.ts";

const threadId = Schema.decodeSync(ThreadId)(
  "01890a5d-ac96-774b-bcce-b302099a8057"
);

// Items arrive as JSON text, as the socket carries them.
const decodeItem = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(ThreadStreamItem))
);

const userEntry = {
  id: 1,
  conversationId: 1,
  kind: "message",
  model: [{ role: "user", content: "hello", timestamp: 1 }],
};

const snapshot = decodeItem(
  `{"_tag":"Snapshot","seq":0,"view":{"conversation":{"id":1},"entries":[${JSON.stringify(userEntry)}],"docs":{}},"entriesOffset":0,"hasMoreHistory":false}`
);

const assistantEntry = {
  id: 2,
  conversationId: 1,
  kind: "message",
  model: [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "short" },
        { type: "text", text: "hi there" },
        { type: "toolCall", id: "t1", name: "read", arguments: {} },
        { type: "somethingNew" },
      ],
    },
  ],
};

const appendAssistant = decodeItem(
  `{"_tag":"Ops","seq":1,"ops":[["p",["entries"],1,0,[${JSON.stringify(assistantEntry)}]]]}`
);

const page = inform(initial, {
  threadId: Option.some(threadId),
  epoch: 2,
  hasClient: true,
}).model;

describe("the thread page", () => {
  it("applies a snapshot, then ops, and reads the entries as text", () => {
    story(
      update,
      given(page),
      message(
        Message.ReceivedThreadItem({ epoch: 2, watch: 0, item: snapshot })
      ),
      message(
        Message.ReceivedThreadItem({
          epoch: 2,
          watch: 0,
          item: appendAssistant,
        })
      ),
      model((current) => {
        expect(current.status._tag).toBe("Ready");

        const { entries } = Option.getOrThrow(current.view).view;

        expect(entries.flatMap(entryLines)).toStrictEqual([
          { role: "user", text: "hello" },
          {
            role: "assistant",
            text: "(thinking) short\nhi there\n[tool call: read]",
          },
        ]);
      })
    );
  });

  it("asks for a fresh subscription when an op cannot be applied", () => {
    const pastTheEnd = decodeItem(
      '{"_tag":"Ops","seq":1,"ops":[["p",["entries"],5,1,[]]]}'
    );

    story(
      update,
      given(page),
      message(
        Message.ReceivedThreadItem({ epoch: 2, watch: 0, item: snapshot })
      ),
      message(
        Message.ReceivedThreadItem({ epoch: 2, watch: 0, item: pastTheEnd })
      ),
      model((current) => {
        expect(current.watch).toBe(1);
        expect(current.status._tag).toBe("Loading");
        expect(Option.getOrThrow(current.view).view.entries).toHaveLength(1);
      })
    );
  });

  it("drops items from a closed subscription and says when the thread is missing", () => {
    story(
      update,
      given(page),
      message(
        Message.ReceivedThreadItem({ epoch: 1, watch: 0, item: snapshot })
      ),
      model((current) => {
        expect(Option.isNone(current.view)).toBeTruthy();
      }),
      message(
        Message.EndedThreadStream({
          epoch: 2,
          watch: 0,
          missing: true,
          reason: "gone",
        })
      ),
      model((current) => {
        expect(current.status._tag).toBe("Missing");
      })
    );
  });

  it("starts over for another thread and keeps the view across a reconnect", () => {
    const ready = update(
      page,
      Message.ReceivedThreadItem({ epoch: 2, watch: 0, item: snapshot })
    ).model;

    const reconnected = inform(ready, {
      threadId: Option.some(threadId),
      epoch: 3,
      hasClient: false,
    }).model;

    expect(reconnected.status._tag).toBe("Loading");
    expect(Option.isSome(reconnected.view)).toBeTruthy();

    const other = inform(ready, {
      threadId: Option.none(),
      epoch: 2,
      hasClient: true,
    }).model;

    expect(Option.isNone(other.view)).toBeTruthy();
  });
});
