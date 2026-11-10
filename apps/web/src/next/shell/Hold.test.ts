// Scene tests for the hold banner above an open thread: a thread waiting for a Claude slot says
// so, a spent plan window reads "Limited" with its reset, and a thread nothing holds shows nothing.
// The banner sends nothing.

import { shellRow } from "@cairn/client-logic/ShellRowTestKit";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";
import * as Scene from "foldkit/scene";

import { formatDayTime } from "../../settings/Time.ts";
import { initial, view } from "./Hold.ts";
import type { Model } from "./Hold.ts";

const showing = (thread: ThreadShell): Model => ({
  ...initial,
  thread: Option.some(thread),
});

const config = { update: (model: Model) => ({ model }), view };

describe("the thread hold banner", () => {
  it("says a thread is waiting for a Claude slot", () => {
    Scene.scene(
      config,
      Scene.given(
        showing(shellRow(1, { activity: "running", waitingFor: "claude_slot" }))
      ),
      Scene.expect(Scene.testId("thread-hold")).toContainText(
        "waiting for a Claude slot"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("reads Limited with the reset time for a spent plan window", () => {
    const resetsAt = DateTime.makeUnsafe("2026-10-22T15:00:00Z");

    Scene.scene(
      config,
      Scene.given(
        showing(
          shellRow(1, {
            activity: "failed",
            lastErrorClass: Option.some("usage_limit"),
            usageLimitResetAt: Option.some(resetsAt),
          })
        )
      ),
      Scene.expect(
        Scene.within(Scene.testId("thread-hold"), Scene.text("Limited"))
      ).toExist(),
      Scene.expect(Scene.testId("thread-hold")).toContainText(
        `resets ${formatDayTime(resetsAt)}`
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("shows nothing for a thread that is not held", () => {
    Scene.scene(
      config,
      Scene.given(showing(shellRow(1, {}))),
      Scene.expect(Scene.testId("thread-hold")).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
