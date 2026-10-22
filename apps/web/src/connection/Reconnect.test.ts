import {
  ShellSnapshotItem,
  ShellSynchronizedItem,
} from "@cairn/protocol/Shell";
import { Option } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";

import { SayHello, WaitForBackoff } from "../Command.ts";
import { Message } from "../Message.ts";
import {
  backingOff,
  connectingModel,
  emptySnapshot,
  hello,
  liveModel,
} from "../TestFixtures.ts";
import { update } from "../Update.ts";
import { backoffDelayMs, ConnectionState } from "./Reconnect.ts";

const snapshot = ShellSnapshotItem.make({ snapshot: emptySnapshot });

describe("the connection state machine", () => {
  it("goes Connecting, Syncing, Live, and is never Live before the first snapshot", () => {
    story(
      update,
      given(connectingModel),
      message(Message.AcquiredConnection()),
      model((current) => {
        expect(current.connection.state._tag).toBe("Syncing");
      }),
      Command.expectExact(SayHello({ epoch: 0 })),
      Command.resolve(SayHello, Message.SucceededHello({ epoch: 0, hello })),
      model((current) => {
        expect(current.connection.state._tag).toBe("Syncing");
        expect(Option.isSome(current.hello)).toBeTruthy();
      }),
      message(Message.ReceivedShellItem({ epoch: 0, item: snapshot })),
      model((current) => {
        expect(current.connection.state._tag).toBe("Live");
        expect(Option.isSome(current.shell)).toBeTruthy();
      })
    );
  });

  it("stays Syncing on a completion marker before any snapshot is held, then goes Live on the snapshot", () => {
    story(
      update,
      given(connectingModel),
      message(Message.AcquiredConnection()),
      Command.resolve(SayHello, Message.SucceededHello({ epoch: 0, hello })),
      message(
        Message.ReceivedShellItem({
          epoch: 0,
          item: ShellSynchronizedItem.make({}),
        })
      ),
      model((current) => {
        expect(current.connection.state._tag).toBe("Syncing");
      }),
      message(Message.ReceivedShellItem({ epoch: 0, item: snapshot })),
      model((current) => {
        expect(current.connection.state._tag).toBe("Live");
      })
    );
  });

  it("ignores a snapshot from an earlier epoch", () => {
    story(
      update,
      given({
        ...connectingModel,
        connection: { ...connectingModel.connection, epoch: 3 },
      }),
      message(Message.AcquiredConnection()),
      Command.resolve(SayHello, Message.SucceededHello({ epoch: 3, hello })),
      message(Message.ReceivedShellItem({ epoch: 2, item: snapshot })),
      model((current) => {
        expect(current.connection.state._tag).toBe("Syncing");
        expect(Option.isNone(current.shell)).toBeTruthy();
      })
    );
  });

  it("backs off after each failure and starts a new epoch when the wait ends", () => {
    story(
      update,
      given(liveModel(0)),
      message(Message.LostConnection({ epoch: 0, reason: "closed" })),
      model((current) => {
        expect(current.connection).toStrictEqual({
          epoch: 0,
          state: ConnectionState.Backoff({ attempt: 1 }),
        });
      }),
      Command.expectExact(WaitForBackoff({ epoch: 0, attempt: 1 })),
      Command.resolve(
        WaitForBackoff,
        Message.ElapsedBackoff({ epoch: 0, attempt: 1 })
      ),
      model((current) => {
        expect(current.connection).toStrictEqual({
          epoch: 1,
          state: ConnectionState.Connecting({ attempt: 1 }),
        });
      }),
      message(Message.FailedAcquireConnection({ reason: "refused" })),
      Command.expectExact(WaitForBackoff({ epoch: 1, attempt: 2 })),
      Command.resolve(
        WaitForBackoff,
        Message.ElapsedBackoff({ epoch: 1, attempt: 2 })
      ),
      message(Message.AcquiredConnection()),
      Command.resolve(
        SayHello,
        Message.LostConnection({ epoch: 2, reason: "hello failed" })
      ),
      model((current) => {
        expect(current.connection).toStrictEqual({
          epoch: 2,
          state: ConnectionState.Backoff({ attempt: 3 }),
        });
      }),
      Command.resolve(
        WaitForBackoff,
        Message.ElapsedBackoff({ epoch: 2, attempt: 3 })
      ),
      message(Message.AcquiredConnection()),
      Command.resolve(SayHello, Message.SucceededHello({ epoch: 3, hello })),
      message(Message.ReceivedShellItem({ epoch: 3, item: snapshot })),
      model((current) => {
        expect(current.connection).toStrictEqual({
          epoch: 3,
          state: ConnectionState.Live(),
        });
      }),
      // Live resets the count: the next failure waits the first step again.
      message(Message.LostConnection({ epoch: 3, reason: "closed" })),
      Command.expectExact(WaitForBackoff({ epoch: 3, attempt: 1 })),
      Command.resolve(
        WaitForBackoff,
        Message.ElapsedBackoff({ epoch: 3, attempt: 1 })
      )
    );
  });

  it("ignores reports from old epochs, and starts no second wait for a second report", () => {
    story(
      update,
      given(liveModel(4)),
      message(Message.LostConnection({ epoch: 3, reason: "late report" })),
      model((current) => {
        expect(current.connection.state._tag).toBe("Live");
      }),
      Command.expectNone(),
      message(Message.LostConnection({ epoch: 4, reason: "stream failed" })),
      Command.expectExact(WaitForBackoff({ epoch: 4, attempt: 1 })),
      Command.resolve(
        WaitForBackoff,
        Message.ElapsedBackoff({ epoch: 4, attempt: 1 })
      )
    );

    story(
      update,
      given(backingOff(4, 2)),
      message(Message.LostConnection({ epoch: 4, reason: "call failed" })),
      model((current) => {
        expect(current.connection).toStrictEqual(backingOff(4, 2).connection);
      }),
      Command.expectNone()
    );
  });

  it("retries at once when the page wakes, then ignores the stale timer", () => {
    story(
      update,
      given(backingOff(5, 1)),
      message(Message.WokeUp()),
      model((current) => {
        expect(current.connection).toStrictEqual({
          epoch: 6,
          state: ConnectionState.Connecting({ attempt: 1 }),
        });
      }),
      // The wait from epoch 5 ends after the page already retried: nothing changes.
      message(Message.ElapsedBackoff({ epoch: 5, attempt: 1 })),
      model((current) => {
        expect(current.connection.epoch).toBe(6);
      }),
      // Waking while connecting does nothing.
      message(Message.WokeUp()),
      model((current) => {
        expect(current.connection.epoch).toBe(6);
      }),
      Command.expectNone()
    );
  });

  it("forgets the in-flight outbox item and the hello when the socket is lost", () => {
    story(
      update,
      given({
        ...liveModel(1),
        hello: Option.some(hello),
        outboxInFlight: Option.some("request-1"),
      }),
      message(Message.LostConnection({ epoch: 1, reason: "closed" })),
      model((current) => {
        expect(Option.isNone(current.hello)).toBeTruthy();
        expect(Option.isNone(current.outboxInFlight)).toBeTruthy();
      }),
      Command.resolve(
        WaitForBackoff,
        Message.ElapsedBackoff({ epoch: 1, attempt: 1 })
      )
    );
  });
});

describe("the backoff schedule", () => {
  it("waits 0, 100, 200, 400 and 800 ms, then 1,000 ms for every later attempt", () => {
    expect(
      [1, 2, 3, 4, 5, 6, 7, 20].map((attempt) => backoffDelayMs(attempt, 0.5))
    ).toStrictEqual([0, 100, 200, 400, 800, 1000, 1000, 1000]);
  });

  it("moves each wait by at most 20 percent either way", () => {
    expect(backoffDelayMs(4, 0)).toBe(320);
    expect(backoffDelayMs(4, 0.999999)).toBe(480);
    expect(backoffDelayMs(9, 0)).toBe(800);
    expect(backoffDelayMs(9, 0.999999)).toBe(1200);
    expect(backoffDelayMs(1, 0.999999)).toBe(0);
  });
});
