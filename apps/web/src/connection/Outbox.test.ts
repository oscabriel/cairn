import { AttachmentId, CommandId, ThreadId } from "@cairn/protocol/Ids";
import { ShellSynchronizedItem } from "@cairn/protocol/Shell";
import {
  SHELL_COMMAND_RESEND_WINDOW,
  ThreadVisit,
} from "@cairn/protocol/ShellCommands";
import { DateTime, Duration, Effect, Option, Predicate, Ref } from "effect";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";

import { SaveReady } from "../attachments/Command.ts";
import { Message as AttachmentsMessage } from "../attachments/Message.ts";
import { readyIds } from "../attachments/Update.ts";
import {
  SaveOutbox,
  SayHello,
  SendOutboxItem,
  WaitForBackoff,
  WaitToResend,
} from "../Command.ts";
import { SaveDrafts } from "../composer/Command.ts";
import { Message as ComposerMessage } from "../composer/Message.ts";
import { Message } from "../Message.ts";
import type { Model } from "../Model.ts";
import { Message as NextShellMessage } from "../next/shell/Message.ts";
import { AppRoute } from "../Route.ts";
import {
  connectingModel,
  hello,
  launchItem,
  liveModel,
  sendItem,
} from "../TestFixtures.ts";
import { update } from "../Update.ts";
import { CairnConnection } from "./Connection.ts";
import {
  enqueue,
  enqueueDispatch,
  loadOutbox,
  OUTBOX_STORAGE_KEY,
  OutboxItem,
  outboxKey,
  saveOutbox,
} from "./Outbox.ts";

const first = sendItem("request-1");

const second = sendItem("request-2");

const synchronizedItem = ShellSynchronizedItem.make({});

/** The names of the Commands an update issued. */
const names = (result: ReturnType<typeof update>) =>
  (result.commands ?? []).map(({ name }) => name);

/** The answer to a save of `outbox`, when no other tab wrote meanwhile. */
const savedAs = (outbox: ReadonlyArray<OutboxItem>) =>
  Message.CompletedSaveOutbox({ written: outbox, stored: Option.some(outbox) });

/** What a failed send reports, or none for any other answer. */
const failure = (answer: Message) =>
  Predicate.isTagged(answer, "FailedOutboxItem")
    ? Option.some({
        key: answer.key,
        retryable: answer.retryable,
        transport: answer.transport,
      })
    : Option.none();

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
        SaveOutbox({ base: [], outbox: [first] }),
        SendOutboxItem({ epoch: 0, item: first })
      ),
      Command.resolve(SaveOutbox, savedAs([first])),
      Command.resolve(
        SendOutboxItem,
        Message.AcknowledgedOutboxItem({ epoch: 0, key: "request-1" })
      ),
      model((current) => {
        expect(current.outbox).toStrictEqual([]);
        expect(Option.isNone(current.outboxInFlight)).toBeTruthy();
      }),
      Command.expectExact(SaveOutbox({ base: [first], outbox: [] })),
      Command.resolve(SaveOutbox, savedAs([]))
    );
  });

  it("sends one item at a time, in order", () => {
    story(
      update,
      given({
        ...liveModel(0),
        outbox: [first],
        outboxStored: [first],
        outboxInFlight: Option.some("request-1"),
      }),
      message(Message.QueuedOutboxItem({ item: second })),
      Command.expectExact(
        SaveOutbox({ base: [first], outbox: [first, second] })
      ),
      Command.resolve(SaveOutbox, savedAs([first, second])),
      message(Message.AcknowledgedOutboxItem({ epoch: 0, key: "request-1" })),
      Command.expectExact(
        SaveOutbox({ base: [first, second], outbox: [second] }),
        SendOutboxItem({ epoch: 0, item: second })
      ),
      Command.resolve(SaveOutbox, savedAs([second])),
      Command.resolve(
        SendOutboxItem,
        Message.AcknowledgedOutboxItem({ epoch: 0, key: "request-2" })
      ),
      Command.resolve(SaveOutbox, savedAs([])),
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
      Command.expectExact(SaveOutbox({ base: [], outbox: [first] })),
      Command.resolve(SaveOutbox, savedAs([first])),
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
      Command.resolve(SaveOutbox, savedAs([first])),
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
      Command.resolve(SaveOutbox, savedAs([])),
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
        outboxStored: [first, second],
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
        SaveOutbox({ base: [first, second], outbox: [second] }),
        SendOutboxItem({ epoch: 0, item: second })
      ),
      Command.resolve(SaveOutbox, savedAs([second])),
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
      Command.resolve(SaveOutbox, savedAs([]))
    );
  });

  it("waits out the resend backoff after a 'not now', whatever else the brain streams", () => {
    const failed = update(
      {
        ...liveModel(0),
        outbox: [first],
        outboxStored: [first],
        outboxInFlight: Option.some("request-1"),
      },
      Message.FailedOutboxItem({
        epoch: 0,
        key: "request-1",
        retryable: true,
        transport: false,
        message: "The brain is starting.",
      })
    );

    // The busy brain streams a row change a few milliseconds later.
    const streamed = update(
      failed.model,
      Message.ReceivedShellItem({ epoch: 0, item: synchronizedItem })
    );

    const elapsed = update(
      streamed.model,
      Message.ElapsedResend({ epoch: 0, key: "request-1" })
    );

    expect({
      failed: names(failed),
      streamed: names(streamed),
      elapsed: names(elapsed),
    }).toStrictEqual({
      failed: [WaitToResend.name],
      streamed: [],
      elapsed: [SendOutboxItem.name],
    });
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

  it("drops a shell command past its resend window unsent, and sends one inside it", async () => {
    // Minted at 2023-06-14T00:24:31.638Z, the first 48 bits of the id.
    const minted = 0x01_89_0a_5d_ac_96;

    const item = OutboxItem.Dispatch({
      command: visit(
        "01890a5d-ac96-774b-bcce-b302099a0000",
        "2023-06-14T00:24:31Z"
      ),
    });

    const sendAt = (millis: number) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(millis);

        return yield* SendOutboxItem({ epoch: 3, item }).effect;
      }).pipe(
        Effect.provideService(
          CairnConnection._tag,
          Ref.makeUnsafe(Option.none())
        ),
        Effect.provide(TestClock.layer())
      );

    const late = await Effect.runPromise(
      sendAt(minted + Duration.toMillis(SHELL_COMMAND_RESEND_WINDOW) + 1)
    );

    expect(failure(late)).toStrictEqual(
      Option.some({ key: outboxKey(item), retryable: false, transport: false })
    );

    const inTime = await Effect.runPromise(
      sendAt(minted + Duration.toMillis(SHELL_COMMAND_RESEND_WINDOW))
    );

    // Inside the window it goes for the connection, which is down: a transport failure, kept.
    expect(failure(inTime)).toStrictEqual(
      Option.some({ key: outboxKey(item), retryable: true, transport: true })
    );
  });

  it("acknowledges an item answered on an earlier epoch", () => {
    story(
      update,
      given({
        ...liveModel(2),
        outbox: [first, second],
        outboxStored: [first, second],
      }),
      message(Message.AcknowledgedOutboxItem({ epoch: 1, key: "request-1" })),
      model((current) => {
        expect(current.outbox).toStrictEqual([second]);
      }),
      Command.resolve(SaveOutbox, savedAs([second])),
      Command.resolve(
        SendOutboxItem,
        Message.AcknowledgedOutboxItem({ epoch: 2, key: "request-2" })
      ),
      Command.resolve(SaveOutbox, savedAs([]))
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
      const saved = yield* saveOutbox([], [first, second]);
      const loaded = yield* loadOutbox;
      const store = yield* KeyValueStore.KeyValueStore;

      yield* store.set(OUTBOX_STORAGE_KEY, "{not json");

      const broken = yield* loadOutbox;

      return { saved, loaded, broken };
    }).pipe(Effect.provide(KeyValueStore.layerMemory));

    const { broken, loaded, saved } = await Effect.runPromise(roundTrip);

    expect(Option.isSome(saved)).toBeTruthy();
    expect(loaded).toStrictEqual([first, second]);
    expect(broken).toStrictEqual([]);
  });
});

/** Runs the outbox saves an update issued, as the runtime would, with no connection. */
const runSaves = (result: ReturnType<typeof update>) =>
  Effect.gen(function* () {
    const disconnected = yield* Ref.make(Option.none());

    return yield* Effect.forEach(
      (result.commands ?? []).filter(({ name }) => name === SaveOutbox.name),
      (command) => command.effect
    ).pipe(Effect.provideService(CairnConnection._tag, disconnected));
  });

describe("the outbox in two tabs", () => {
  it("keeps each tab's queued items in storage", async () => {
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        // Both tabs wait for the brain, so nothing is sent or acknowledged.
        yield* runSaves(
          update(connectingModel, Message.QueuedOutboxItem({ item: first }))
        );
        yield* runSaves(
          update(connectingModel, Message.QueuedOutboxItem({ item: second }))
        );

        return yield* loadOutbox;
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    expect(stored.map(outboxKey)).toStrictEqual(["request-1", "request-2"]);
  });

  it("sends an item another tab queued, and forgets it once that tab has its answer", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        /** `tab` told another tab wrote, after its save (which reads storage) answered. */
        const hear = (tab: Model) =>
          Effect.gen(function* () {
            const told = update(tab, Message.ChangedStoredOutbox());
            const [answer] = yield* runSaves(told);

            return answer === undefined
              ? { model: told.model, commands: [] }
              : update(told.model, answer);
          });

        const queued = update(
          connectingModel,
          Message.QueuedOutboxItem({ item: first })
        );

        const [savedA] = yield* runSaves(queued);

        const tabA =
          savedA === undefined
            ? queued.model
            : update(queued.model, savedA).model;

        const heard = yield* hear(liveModel(0));

        // Tab A hears the brain acknowledge the item, and saves the outbox without it.
        yield* runSaves(
          update(
            tabA,
            Message.AcknowledgedOutboxItem({ epoch: 0, key: "request-1" })
          )
        );

        const heardAgain = yield* hear({
          ...heard.model,
          outboxInFlight: Option.none(),
        });

        return {
          heard: heard.model.outbox.map(outboxKey),
          sent: (heard.commands ?? []).map(({ name }) => name),
          heardAgain: heardAgain.model.outbox.map(outboxKey),
        };
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    expect(result).toStrictEqual({
      heard: ["request-1"],
      sent: [SendOutboxItem.name],
      heardAgain: [],
    });
  });

  it("keeps an item another tab's write dropped because it read storage before the item was saved", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;

        const queued = update(
          connectingModel,
          Message.QueuedOutboxItem({ item: first })
        );

        const [savedA] = yield* runSaves(queued);

        const tabA =
          savedA === undefined
            ? queued.model
            : update(queued.model, savedA).model;

        // Tab B read storage before tab A's write landed, so its own write leaves A's item out.
        yield* store.remove(OUTBOX_STORAGE_KEY);
        yield* runSaves(
          update(connectingModel, Message.QueuedOutboxItem({ item: second }))
        );

        const told = update(tabA, Message.ChangedStoredOutbox());
        const [answer] = yield* runSaves(told);

        const heard =
          answer === undefined ? told.model : update(told.model, answer).model;

        return {
          outbox: heard.outbox.map(outboxKey),
          stored: (yield* loadOutbox).map(outboxKey),
        };
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    expect(result).toStrictEqual({
      outbox: ["request-2", "request-1"],
      stored: ["request-2", "request-1"],
    });
  });
});

/** `tab` told another tab wrote, after its save (which reads storage) answered. */
const hearOutbox = (tab: Model) =>
  Effect.gen(function* () {
    const told = update(tab, Message.ChangedStoredOutbox());
    const [answer] = yield* runSaves(told);

    return answer === undefined
      ? { model: told.model, commands: told.commands ?? [] }
      : update(told.model, answer);
  });

describe("this tab's turns in two tabs", () => {
  const launch = launchItem("01890a5d-ac96-774b-bcce-b302099a80a1");
  const launchKey = outboxKey(launch);

  it("are settled here when another tab's answer removes them: a launch is followed, a send forgotten", async () => {
    const sentTurns = await Effect.runPromise(
      Effect.gen(function* () {
        yield* saveOutbox([], [first, launch]);

        const tabA: Model = {
          ...connectingModel,
          outbox: [first, launch],
          outboxStored: [first, launch],
          sentTurns: {
            "request-1": {
              item: first,
              attachments: [],
              acknowledged: false,
              fromScratch: false,
            },
            [launchKey]: {
              item: launch,
              attachments: [],
              acknowledged: false,
              fromScratch: false,
            },
          },
        };

        // Tab B was acknowledged both and saved the outbox without them.
        yield* saveOutbox([first, launch], []);

        return (yield* hearOutbox(tabA)).model.sentTurns;
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    expect(sentTurns).toStrictEqual({
      [launchKey]: {
        item: launch,
        attachments: [],
        acknowledged: true,
        fromScratch: false,
      },
    });
  });

  it("leaves a turn another tab queued to that tab when the brain refuses it here", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // Tab A queued the turn; tab B hears of it and sends it.
        yield* saveOutbox([], [first]);

        const heard = yield* hearOutbox(liveModel(0));

        const refused = update(
          heard.model,
          Message.FailedOutboxItem({
            epoch: 0,
            key: "request-1",
            retryable: false,
            transport: false,
            message: "Thread 01890a5d is archived.",
          })
        );

        yield* runSaves(refused);

        return {
          sent: (heard.commands ?? []).map(({ name }) => name),
          draft:
            refused.model.composer.drafts[
              "thread:01890a5d-ac96-774b-bcce-b302099a8057"
            ]?.text,
          sentAgain: names(refused).filter(
            (name) => name === SendOutboxItem.name
          ),
          stored: (yield* loadOutbox).map(outboxKey),
        };
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    expect(result).toStrictEqual({
      sent: [SendOutboxItem.name],
      draft: undefined,
      sentAgain: [],
      stored: ["request-1"],
    });
  });

  it("stops counting a turn it left to another tab as queued on the thread page", async () => {
    const queued = await Effect.runPromise(
      Effect.gen(function* () {
        // Tab A queued the turn and closed; tab B, on that thread's page, is refused it.
        yield* saveOutbox([], [first]);

        const onThread: Model = {
          ...liveModel(0),
          route: AppRoute.Thread({
            threadId: "01890a5d-ac96-774b-bcce-b302099a8057",
          }),
        };

        const heard = yield* hearOutbox(onThread);

        const refused = update(
          heard.model,
          Message.FailedOutboxItem({
            epoch: 0,
            key: "request-1",
            retryable: false,
            transport: false,
            message: "Thread 01890a5d is archived.",
          })
        );

        return refused.model.thread.timeline.queuedPrompts;
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    expect(queued).toStrictEqual([]);
  });
});

describe("a turn the brain refuses", () => {
  const ref = {
    id: AttachmentId.make("att_1"),
    name: "notes.pdf",
    mimeType: "application/pdf",
    sizeBytes: 12,
    kind: "pdf" as const,
    sha256: "0".repeat(64),
  };

  it("goes back into its thread's draft with its attachment, and the notice can be dismissed", () => {
    const threadKey = "thread:01890a5d-ac96-774b-bcce-b302099a8057";

    story(
      update,
      given(liveModel(0)),
      message(
        Message.GotComposerMessage({
          message: ComposerMessage.PreparedTurn({
            draftKey: threadKey,
            item: first,
            navigateTo: Option.none(),
            attachments: [ref],
          }),
        })
      ),
      Command.resolveAll(
        [SaveOutbox, savedAs([first])],
        [
          SaveDrafts,
          ComposerMessage.CompletedSaveDrafts({
            version: 1,
            written: {},
            stored: Option.some({}),
          }),
        ]
      ),
      Command.resolve(
        SendOutboxItem,
        Message.FailedOutboxItem({
          epoch: 0,
          key: "request-1",
          retryable: false,
          transport: false,
          message: "Thread 01890a5d does not exist.",
        })
      ),
      Command.resolveAll(
        [SaveOutbox, savedAs([])],
        [
          SaveReady,
          AttachmentsMessage.CompletedSave({
            written: { [threadKey]: [ref] },
            stored: Option.some({ [threadKey]: [ref] }),
          }),
        ]
      ),
      model((current) => {
        expect({
          text: current.composer.drafts[threadKey]?.text,
          tray: readyIds(current.composer.attachments, threadKey),
          sent: current.sentTurns,
          notice: current.notice,
        }).toStrictEqual({
          text: "message request-1",
          tray: [ref.id],
          sent: {},
          notice: Option.some("Thread 01890a5d does not exist."),
        });
      }),
      message(Message.DismissedNotice()),
      model((current) => {
        expect(current.notice).toStrictEqual(Option.none());
      })
    );
  });

  it("goes back into the composer with its attachment when sent from the composer on the scratch thread's page", () => {
    const threadKey = "thread:01890a5d-ac96-774b-bcce-b302099a8057";

    story(
      update,
      given({
        ...liveModel(0),
        nextShell: {
          ...liveModel(0).nextShell,
          scratch: {
            ...liveModel(0).nextShell.scratch,
            threadId: Option.some(
              ThreadId.make("01890a5d-ac96-774b-bcce-b302099a8057")
            ),
          },
        },
      }),
      message(
        Message.GotComposerMessage({
          message: ComposerMessage.PreparedTurn({
            draftKey: threadKey,
            item: first,
            navigateTo: Option.none(),
            attachments: [ref],
          }),
        })
      ),
      Command.resolveAll(
        [SaveOutbox, savedAs([first])],
        [
          SaveDrafts,
          ComposerMessage.CompletedSaveDrafts({
            version: 1,
            written: {},
            stored: Option.some({}),
          }),
        ]
      ),
      Command.resolve(
        SendOutboxItem,
        Message.FailedOutboxItem({
          epoch: 0,
          key: "request-1",
          retryable: false,
          transport: false,
          message: "Thread 01890a5d does not exist.",
        })
      ),
      Command.resolveAll(
        [SaveOutbox, savedAs([])],
        [
          SaveReady,
          AttachmentsMessage.CompletedSave({
            written: { [threadKey]: [ref] },
            stored: Option.some({ [threadKey]: [ref] }),
          }),
        ]
      ),
      model((current) => {
        expect({
          text: current.composer.drafts[threadKey]?.text,
          tray: readyIds(current.composer.attachments, threadKey),
          sent: current.sentTurns,
          notice: current.notice,
        }).toStrictEqual({
          text: "message request-1",
          tray: [ref.id],
          sent: {},
          notice: Option.some("Thread 01890a5d does not exist."),
        });
      })
    );
  });

  it("goes back into the scratch overlay when it was a scratch turn", () => {
    const scratchId = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a8057");
    const live = liveModel(0);

    const sent = update(
      {
        ...live,
        nextShell: {
          ...live.nextShell,
          scratch: {
            ...live.nextShell.scratch,
            isOpen: true,
            threadId: Option.some(scratchId),
          },
        },
      },
      Message.GotNextShellMessage({
        message: NextShellMessage.PreparedScratchTurn({
          item: first,
          threadId: scratchId,
        }),
      })
    ).model;

    const refused = update(
      sent,
      Message.FailedOutboxItem({
        epoch: 0,
        key: "request-1",
        retryable: false,
        transport: false,
        message: "Thread 01890a5d is archived.",
      })
    ).model;

    expect({
      scratch: refused.nextShell.scratch.draft,
      composer: refused.composer.drafts[`thread:${scratchId}`]?.text,
      sent: refused.sentTurns,
    }).toStrictEqual({
      scratch: "message request-1",
      composer: undefined,
      sent: {},
    });
  });

  it("goes back into its thread's draft after a reload, when only the outbox kept it", () => {
    const threadKey = "thread:01890a5d-ac96-774b-bcce-b302099a8057";

    // The page reloaded with the turn in the saved outbox; its sent-turn record was in memory.
    story(
      update,
      given({
        ...liveModel(0),
        outbox: [first],
        outboxStored: [first],
        outboxInFlight: Option.some("request-1"),
      }),
      message(
        Message.FailedOutboxItem({
          epoch: 0,
          key: "request-1",
          retryable: false,
          transport: false,
          message: "Thread 01890a5d is archived.",
        })
      ),
      model((current) => {
        expect({
          text: current.composer.drafts[threadKey]?.text,
          notice: current.notice,
        }).toStrictEqual({
          text: "message request-1",
          notice: Option.some("Thread 01890a5d is archived."),
        });
      }),
      Command.resolve(SaveOutbox, savedAs([]))
    );
  });
});
