import { CommandId, ThreadId } from "@cairn/protocol/Ids";
import { ShellSynchronizedItem } from "@cairn/protocol/Shell";
import { ThreadVisit } from "@cairn/protocol/ShellCommands";
import { DateTime, Effect, Option } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";

import {
  SaveOutbox,
  SayHello,
  SendOutboxItem,
  WaitForBackoff,
  WaitToResend,
} from "../Command.ts";
import { Message } from "../Message.ts";
import {
  connectingModel,
  hello,
  liveModel,
  sendItem,
} from "../TestFixtures.ts";
import { update } from "../Update.ts";
import {
  enqueue,
  enqueueDispatch,
  loadOutbox,
  OUTBOX_STORAGE_KEY,
  outboxKey,
  saveOutbox,
} from "./Outbox.ts";

const first = sendItem("request-1");

const second = sendItem("request-2");

const synchronizedItem = ShellSynchronizedItem.make({});

const visit = (commandId: string, at: string) =>
  ThreadVisit.make({
    commandId: CommandId.make(commandId),
    threadId: ThreadId.make("01890a5d-ac96-774b-bcce-b302099a8057"),
    at: DateTime.makeUnsafe(at),
  });

describe("the outbox", () => {
  it("sends a queued item while live, and drops it when the brain acknowledges it", () => {
    story(
      update,
      given(liveModel(0)),
      message(Message.QueuedOutboxItem({ item: first })),
      model((current) => {
        expect(current.outbox).toStrictEqual([first]);
        expect(current.outboxInFlight).toStrictEqual(Option.some("request-1"));
      }),
      Command.expectExact(
        SaveOutbox({ outbox: [first] }),
        SendOutboxItem({ epoch: 0, item: first })
      ),
      Command.resolve(SaveOutbox, Message.CompletedSaveOutbox({ saved: true })),
      Command.resolve(
        SendOutboxItem,
        Message.AcknowledgedOutboxItem({ epoch: 0, key: "request-1" })
      ),
      model((current) => {
        expect(current.outbox).toStrictEqual([]);
        expect(Option.isNone(current.outboxInFlight)).toBeTruthy();
      }),
      Command.expectExact(SaveOutbox({ outbox: [] })),
      Command.resolve(SaveOutbox, Message.CompletedSaveOutbox({ saved: true }))
    );
  });

  it("sends one item at a time, in order", () => {
    story(
      update,
      given({
        ...liveModel(0),
        outbox: [first],
        outboxInFlight: Option.some("request-1"),
      }),
      message(Message.QueuedOutboxItem({ item: second })),
      Command.expectExact(SaveOutbox({ outbox: [first, second] })),
      Command.resolve(SaveOutbox, Message.CompletedSaveOutbox({ saved: true })),
      message(Message.AcknowledgedOutboxItem({ epoch: 0, key: "request-1" })),
      Command.expectExact(
        SaveOutbox({ outbox: [second] }),
        SendOutboxItem({ epoch: 0, item: second })
      ),
      Command.resolve(SaveOutbox, Message.CompletedSaveOutbox({ saved: true })),
      Command.resolve(
        SendOutboxItem,
        Message.AcknowledgedOutboxItem({ epoch: 0, key: "request-2" })
      ),
      Command.resolve(SaveOutbox, Message.CompletedSaveOutbox({ saved: true })),
      model((current) => {
        expect(current.outbox).toStrictEqual([]);
      })
    );
  });

  it("keeps an item queued while offline, and sends it once the next connection is live", () => {
    story(
      update,
      given(connectingModel),
      message(Message.QueuedOutboxItem({ item: first })),
      Command.expectExact(SaveOutbox({ outbox: [first] })),
      Command.resolve(SaveOutbox, Message.CompletedSaveOutbox({ saved: true })),
      message(Message.AcquiredConnection()),
      Command.resolve(SayHello, Message.SucceededHello({ epoch: 0, hello })),
      model((current) => {
        expect(Option.isNone(current.outboxInFlight)).toBeTruthy();
      })
    );
  });

  it("resends the unanswered item after a reconnect", () => {
    story(
      update,
      given(liveModel(0)),
      message(Message.QueuedOutboxItem({ item: first })),
      Command.resolve(SaveOutbox, Message.CompletedSaveOutbox({ saved: true })),
      // The socket drops before the brain answers: the call fails with the transport, then the
      // shell stream reports the loss.
      Command.resolve(
        SendOutboxItem,
        Message.FailedOutboxItem({
          epoch: 0,
          key: "request-1",
          retryable: true,
          transport: true,
          message: "The socket closed.",
        })
      ),
      message(Message.LostConnection({ epoch: 0, reason: "closed" })),
      Command.resolve(
        WaitForBackoff,
        Message.ElapsedBackoff({ epoch: 0, attempt: 1 })
      ),
      model((current) => {
        expect(current.outbox).toStrictEqual([first]);
        expect(Option.isNone(current.outboxInFlight)).toBeTruthy();
      }),
      message(Message.AcquiredConnection()),
      Command.resolve(SayHello, Message.SucceededHello({ epoch: 1, hello })),
      Command.expectNone(),
      message(Message.ReceivedShellItem({ epoch: 1, item: synchronizedItem })),
      Command.expectExact(SendOutboxItem({ epoch: 1, item: first })),
      Command.resolve(
        SendOutboxItem,
        Message.AcknowledgedOutboxItem({ epoch: 1, key: "request-1" })
      ),
      Command.resolve(SaveOutbox, Message.CompletedSaveOutbox({ saved: true })),
      model((current) => {
        expect(current.outbox).toStrictEqual([]);
      })
    );
  });

  it("drops an item the brain refused for good and says why; keeps one it may retry and sends it again after a wait", () => {
    story(
      update,
      given({
        ...liveModel(0),
        outbox: [first, second],
        outboxInFlight: Option.some("request-1"),
      }),
      message(
        Message.FailedOutboxItem({
          epoch: 0,
          key: "request-1",
          retryable: false,
          transport: false,
          message: "The thread does not exist.",
        })
      ),
      model((current) => {
        expect(current.outbox).toStrictEqual([second]);
        expect(current.notice).toStrictEqual(
          Option.some("The thread does not exist.")
        );
      }),
      Command.expectExact(
        SaveOutbox({ outbox: [second] }),
        SendOutboxItem({ epoch: 0, item: second })
      ),
      Command.resolve(SaveOutbox, Message.CompletedSaveOutbox({ saved: true })),
      Command.resolve(
        SendOutboxItem,
        Message.FailedOutboxItem({
          epoch: 0,
          key: "request-2",
          retryable: true,
          transport: false,
          message: "The brain is starting.",
        })
      ),
      model((current) => {
        expect(current.outbox).toStrictEqual([second]);
        expect(Option.isNone(current.outboxInFlight)).toBeTruthy();
      }),
      // Nothing else is queued and the socket stays up: the item is sent again on its own.
      Command.expectExact(
        WaitToResend({ epoch: 0, key: "request-2", attempt: 1 })
      ),
      Command.resolve(
        WaitToResend,
        Message.ElapsedResend({ epoch: 0, key: "request-2" })
      ),
      Command.expectExact(SendOutboxItem({ epoch: 0, item: second })),
      Command.resolve(
        SendOutboxItem,
        Message.AcknowledgedOutboxItem({ epoch: 0, key: "request-2" })
      ),
      model((current) => {
        expect([current.outbox, current.outboxAttempt]).toStrictEqual([[], 0]);
      }),
      Command.resolve(SaveOutbox, Message.CompletedSaveOutbox({ saved: true }))
    );
  });

  it("sends nothing when a resend timer fires for an item already answered", () => {
    story(
      update,
      given({
        ...liveModel(0),
        outbox: [second],
        outboxInFlight: Option.some("request-2"),
      }),
      message(Message.ElapsedResend({ epoch: 0, key: "request-1" })),
      Command.expectNone(),
      message(Message.ElapsedResend({ epoch: 0, key: "request-2" })),
      Command.expectNone(),
      model((current) => {
        expect(current.outboxInFlight).toStrictEqual(Option.some("request-2"));
      })
    );
  });

  it("keeps only the latest queued visit to a thread, and never the one in flight", () => {
    const sent = visit(
      "01890a5d-ac96-774b-bcce-b302099a0000",
      "2026-10-24T10:00:00Z"
    );

    const stale = visit(
      "01890a5d-ac96-774b-bcce-b302099a0004",
      "2026-10-24T10:00:04Z"
    );

    const latest = visit(
      "01890a5d-ac96-774b-bcce-b302099a0008",
      "2026-10-24T10:00:08Z"
    );

    const inFlight = Option.some<string>(sent.commandId);

    const queued = enqueueDispatch(
      enqueueDispatch([first], sent, Option.none()),
      stale,
      inFlight
    );

    expect(
      enqueueDispatch(queued, latest, inFlight).map(outboxKey)
    ).toStrictEqual(["request-1", sent.commandId, latest.commandId]);
  });

  it("acknowledges an item answered on an earlier epoch", () => {
    story(
      update,
      given({ ...liveModel(2), outbox: [first, second] }),
      message(Message.AcknowledgedOutboxItem({ epoch: 1, key: "request-1" })),
      model((current) => {
        expect(current.outbox).toStrictEqual([second]);
      }),
      Command.resolve(SaveOutbox, Message.CompletedSaveOutbox({ saved: true })),
      Command.resolve(
        SendOutboxItem,
        Message.AcknowledgedOutboxItem({ epoch: 2, key: "request-2" })
      ),
      Command.resolve(SaveOutbox, Message.CompletedSaveOutbox({ saved: true }))
    );
  });

  it("keeps one item per key", () => {
    expect(enqueue(enqueue([], first), sendItem("request-1"))).toStrictEqual([
      first,
    ]);
    expect(outboxKey(second)).toBe("request-2");
  });

  it("survives a reload through storage, and reads unreadable storage as empty", async () => {
    const roundTrip = Effect.gen(function* () {
      const saved = yield* saveOutbox([first, second]);
      const loaded = yield* loadOutbox;
      const store = yield* KeyValueStore.KeyValueStore;

      yield* store.set(OUTBOX_STORAGE_KEY, "{not json");

      const broken = yield* loadOutbox;

      return { saved, loaded, broken };
    }).pipe(Effect.provide(KeyValueStore.layerMemory));

    const { broken, loaded, saved } = await Effect.runPromise(roundTrip);

    expect(saved).toBeTruthy();
    expect(loaded).toStrictEqual([first, second]);
    expect(broken).toStrictEqual([]);
  });
});
