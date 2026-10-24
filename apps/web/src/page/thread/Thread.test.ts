import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { ThreadShell } from "@cairn/protocol/Shell";
import { ThreadStreamItem } from "@cairn/protocol/Thread";
import { DateTime, Option, Schema } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";

import { Message as RootMessage } from "../../Message.ts";
import { AppRoute } from "../../Route.ts";
import { emptySnapshot, launchItem, liveModel } from "../../TestFixtures.ts";
import { update as rootUpdate } from "../../Update.ts";
import { WaitToResubscribe } from "./Command.ts";
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
  launching: false,
}).model;

/** The same page while the thread's launch is on its way to the brain. */
const launchingPage = inform(page, {
  threadId: Option.some(threadId),
  epoch: 2,
  hasClient: true,
  launching: true,
}).model;

const missing = (watch: number) =>
  Message.EndedThreadStream({
    epoch: 2,
    watch,
    missing: true,
    reason: "Thread does not exist in the brain.",
  });

const failed = (watch: number) =>
  Message.EndedThreadStream({
    epoch: 2,
    watch,
    missing: false,
    reason: "The thread stream stopped. Resubscribe.",
  });

describe("the thread page", () => {
  // Direct update calls: the transcript re-anchors its list (a scroll Command) on a new view, which
  // the thread page's own tests need not resolve.
  it("applies a snapshot, then ops, and holds both entries", () => {
    const ready = update(
      page,
      Message.ReceivedThreadItem({ epoch: 2, watch: 0, item: snapshot })
    ).model;

    const current = update(
      ready,
      Message.ReceivedThreadItem({ epoch: 2, watch: 0, item: appendAssistant })
    ).model;

    expect(current.status._tag).toBe("Ready");

    const { entries } = Option.getOrThrow(current.view).view;

    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries[0]?.model)).toContain("hello");
    expect(JSON.stringify(entries[1]?.model)).toContain("hi there");
  });

  it("asks for a fresh subscription when an op cannot be applied", () => {
    const pastTheEnd = decodeItem(
      '{"_tag":"Ops","seq":1,"ops":[["p",["entries"],5,1,[]]]}'
    );

    const ready = update(
      page,
      Message.ReceivedThreadItem({ epoch: 2, watch: 0, item: snapshot })
    ).model;

    const current = update(
      ready,
      Message.ReceivedThreadItem({ epoch: 2, watch: 0, item: pastTheEnd })
    ).model;

    expect(current.watch).toBe(1);
    expect(current.status._tag).toBe("Loading");
    expect(Option.getOrThrow(current.view).view.entries).toHaveLength(1);
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
      launching: false,
    }).model;

    expect(reconnected.status._tag).toBe("Loading");
    expect(Option.isSome(reconnected.view)).toBeTruthy();

    const other = inform(ready, {
      threadId: Option.none(),
      epoch: 2,
      hasClient: true,
      launching: false,
    }).model;

    expect(Option.isNone(other.view)).toBeTruthy();
  });

  it("stays Loading on NotFound while its launch is on the way, and subscribes again", () => {
    story(
      update,
      given(launchingPage),
      message(missing(0)),
      model((current) => {
        expect(current.status._tag).toBe("Loading");
      }),
      Command.expectExact(
        WaitToResubscribe({ epoch: 2, watch: 0, attempt: 0 })
      ),
      Command.resolve(
        WaitToResubscribe,
        Message.ElapsedResubscribeWait({ epoch: 2, watch: 0 })
      ),
      model((current) => {
        expect(current.watch).toBe(1);
        expect(current.status._tag).toBe("Loading");
      }),
      message(missing(1)),
      Command.expectExact(
        WaitToResubscribe({ epoch: 2, watch: 1, attempt: 1 })
      ),
      Command.resolve(
        WaitToResubscribe,
        Message.ElapsedResubscribeWait({ epoch: 2, watch: 1 })
      ),
      model((current) => {
        expect(current.watch).toBe(2);
        expect(current.retries).toBe(2);

        // The launch landed: the third subscription's snapshot resets the waits.
        const ready = update(
          current,
          Message.ReceivedThreadItem({ epoch: 2, watch: 2, item: snapshot })
        ).model;

        expect(ready.status._tag).toBe("Ready");
        expect(ready.retries).toBe(0);
      })
    );
  });

  it("says Missing once the launch is gone, and leaves Missing when the shell learns of the thread", () => {
    story(
      update,
      given(launchingPage),
      message(missing(0)),
      Command.resolve(
        WaitToResubscribe,
        Message.ElapsedResubscribeWait({ epoch: 2, watch: 0 })
      ),
      model((current) => {
        expect(current.watch).toBe(1);
      })
    );

    const gone = inform(
      update(
        launchingPage,
        Message.ElapsedResubscribeWait({ epoch: 2, watch: 0 })
      ).model,
      {
        threadId: Option.some(threadId),
        epoch: 2,
        hasClient: true,
        launching: false,
      }
    ).model;

    const shown = update(gone, missing(gone.watch));

    expect(shown.model.status._tag).toBe("Missing");
    expect(shown.commands ?? []).toHaveLength(0);

    const known = inform(shown.model, {
      threadId: Option.some(threadId),
      epoch: 2,
      hasClient: true,
      launching: true,
    }).model;

    expect(known.status._tag).toBe("Loading");
    expect(known.watch).toBe(shown.model.watch + 1);
  });

  it("subscribes again after a failed stream, backing off until a snapshot", () => {
    story(
      update,
      given(page),
      message(failed(0)),
      model((current) => {
        expect(current.status._tag).toBe("Failed");
      }),
      Command.expectExact(
        WaitToResubscribe({ epoch: 2, watch: 0, attempt: 0 })
      ),
      Command.resolve(
        WaitToResubscribe,
        Message.ElapsedResubscribeWait({ epoch: 2, watch: 0 })
      ),
      model((current) => {
        expect(current.watch).toBe(1);
        expect(current.status._tag).toBe("Loading");
      }),
      message(failed(1)),
      Command.expectExact(
        WaitToResubscribe({ epoch: 2, watch: 1, attempt: 1 })
      ),
      Command.resolve(
        WaitToResubscribe,
        Message.ElapsedResubscribeWait({ epoch: 2, watch: 1 })
      ),
      model((current) => {
        const ready = update(
          current,
          Message.ReceivedThreadItem({ epoch: 2, watch: 2, item: snapshot })
        ).model;

        // After a snapshot the next failure waits the shortest time again.
        expect(
          (update(ready, failed(2)).commands ?? []).map((command) => [
            command.name,
            command.args,
          ])
        ).toStrictEqual([
          ["WaitToResubscribe", { epoch: 2, watch: 2, attempt: 0 }],
        ]);
      })
    );
  });

  it("drops a resubscribe wait from a closed subscription", () => {
    const moved = update(
      launchingPage,
      Message.ElapsedResubscribeWait({ epoch: 1, watch: 0 })
    ).model;

    expect(moved.watch).toBe(0);
  });
});

describe("the root tells the thread page", () => {
  const route = AppRoute.Thread({ threadId });

  const created = DateTime.makeUnsafe("2026-10-22T11:00:00Z");

  const row = (activity: ThreadShell["activity"]): ThreadShell =>
    ThreadShell.make({
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Start here",
      provider: "opencode-go",
      modelId: "small",
      thinkingLevel: "medium",
      runtimeMode: "full-access",
      branch: Option.none(),
      worktreePath: Option.none(),
      activity,
      activeRunId: Option.none(),
      latestRunRequestedAt: Option.none(),
      latestRunStartedAt: Option.none(),
      latestRunCompletedAt: Option.none(),
      queueLength: 0,
      lastError: Option.none(),
      lastErrorClass: Option.none(),
      usageLimitResetAt: Option.none(),
      waitingFor: "none",
      pendingRuntimeRequest: Option.none(),
      latestVisibleMessage: Option.none(),
      latestUserMessageAt: Option.none(),
      createdAt: created,
      updatedAt: created,
      archivedAt: Option.none(),
      settledOverride: Option.none(),
      settledAt: Option.none(),
      unsettledAt: Option.none(),
      snoozedUntil: Option.none(),
      snoozedAt: Option.none(),
      pinnedAt: Option.none(),
      pinOrderKey: Option.none(),
      activeOrderKey: Option.none(),
      autoSettleDisabledAt: Option.none(),
      lastVisitedAt: Option.none(),
      parkedTaskIds: [],
    });

  const withRow = (activity: ThreadShell["activity"]) =>
    rootUpdate(
      {
        ...liveModel(2),
        route,
        shell: Option.some({ ...emptySnapshot, threads: [row(activity)] }),
      },
      RootMessage.CompletedNavigateInternal()
    ).model;

  it("that the routed thread is launching while the outbox holds its launch", () => {
    const routed = { ...liveModel(2), route };

    const queued = rootUpdate(
      routed,
      RootMessage.QueuedOutboxItem({ item: launchItem(threadId) })
    ).model;

    expect(queued.thread.launching).toBeTruthy();

    const other = rootUpdate(
      routed,
      RootMessage.QueuedOutboxItem({
        item: launchItem("01890a5d-ac96-774b-bcce-b302099a80ff"),
      })
    ).model;

    expect(other.thread.launching).toBeFalsy();
  });

  it("that the routed thread is launching while its shell row is preparing", () => {
    expect(withRow("preparing").thread.launching).toBeTruthy();
    expect(withRow("idle").thread.launching).toBeFalsy();
    expect(withRow("failed").thread.launching).toBeFalsy();
  });
});
