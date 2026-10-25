// The sidebar's clock is right from the first render (T29): init reads the clock once, so ages and
// snooze presets never start from 0 (1970) while the clock subscription drops its first tick.
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";

import { ReadClock } from "./Command.ts";
import { snoozePresetsOf } from "./Derived.ts";
import { Message, OutMessage } from "./Message.ts";
import { initial } from "./Model.ts";
import { init, update } from "./Update.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("the sidebar clock", () => {
  it("is read by init", () => {
    expect(init().commands?.map((command) => command.name)).toContain(
      "ReadClock"
    );
  });

  it.effect("puts snooze presets within days of now, not in 1970", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_760_000_000_000);

      const ticked = yield* ReadClock().effect;
      const { model } = update(initial, ticked);
      const now = 1_760_000_000_000;

      expect(model.nowMs).toBe(now);

      for (const preset of snoozePresetsOf(model)) {
        const at = DateTime.toEpochMillis(preset.snoozedUntil);

        expect(at).toBeGreaterThan(now);
        expect(at - now).toBeLessThan(8 * DAY_MS);
      }
    })
  );
});

describe("a sidebar retry that fails", () => {
  it("asks the root to say why", () => {
    const { outMessage } = update(
      initial,
      Message.FailedRetry({ message: "The task is gone." })
    );

    expect(outMessage).toStrictEqual(
      OutMessage.RequestedNotice({ message: "The task is gone." })
    );
  });
});
