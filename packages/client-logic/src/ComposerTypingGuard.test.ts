// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/composerTypingGuard.test.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: events are tagged values. MIT License,
// Copyright (c) 2026 T3 Tools Inc.; the full notice is in ComposerTypingGuard.ts.
import { assert, describe, it } from "@effect/vitest";

import {
  initialTypingGuard,
  TypingGuardEvent,
  updateTypingGuard,
} from "./ComposerTypingGuard.ts";
import type { TypingGuardState } from "./ComposerTypingGuard.ts";

const { Blurred, Focused, Idled, Requests, Sent, Typed } =
  TypingGuardEvent.cases;

const step = (
  state: TypingGuardState,
  ...events: ReadonlyArray<TypingGuardEvent>
): TypingGuardState => {
  let current = state;

  for (const event of events) {
    current = updateTypingGuard(current, event);
  }

  return current;
};

const typing = () =>
  step(initialTypingGuard, Focused.make({}), Typed.make({ now: 1000 }));

const requests = (requestIds: ReadonlyArray<string>, now: number) =>
  Requests.make({ requestIds, now });

describe("composer typing guard", () => {
  it("holds new requests while the focused draft was recently edited", () => {
    assert.deepStrictEqual(
      step(typing(), requests(["approval", "question"], 2499)).held,
      ["approval", "question"]
    );
  });

  it.each([
    ["idle", Idled.make({})],
    ["send", Sent.make({})],
    ["blur", Blurred.make({})],
  ] as const)(
    "releases on %s and never re-holds the request",
    (_name, release) => {
      let state = step(typing(), requests(["question"], 1200), release);

      assert.deepStrictEqual(state.held, []);

      state = step(
        state,
        Focused.make({}),
        Typed.make({ now: 2000 }),
        requests([], 2100),
        requests(["question", "new-question"], 2200)
      );

      assert.deepStrictEqual(state.held, ["new-question"]);
    }
  );

  it("shows requests immediately when idle or unfocused", () => {
    for (const state of [
      initialTypingGuard,
      typing(),
      step(typing(), Blurred.make({})),
    ]) {
      assert.deepStrictEqual(
        step(state, requests(["question"], 2500)).held,
        []
      );
    }
  });

  it("does not hide a request that already took over when typing starts", () => {
    const state = step(
      initialTypingGuard,
      requests(["question"], 0),
      Focused.make({}),
      Typed.make({ now: 1000 }),
      requests(["question"], 1100)
    );

    assert.deepStrictEqual(state.held, []);
  });

  it("drops a hold when its request is resolved", () => {
    const held = step(typing(), requests(["question"], 1100));

    assert.deepStrictEqual(step(held, requests([], 1200)).held, []);
  });
});
