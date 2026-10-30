// The sidebar's clock is right from the first render (T29): init reads the clock once, so visits and
// the favicon badge never start from 0 (1970) while the clock subscription drops its first tick.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { ReadClock } from "./Command.ts";
import { initial } from "./Model.ts";
import { init, update } from "./Update.ts";

describe("the sidebar clock", () => {
  it("is read by init", () => {
    expect(init().commands?.map((command) => command.name)).toContain(
      "ReadClock"
    );
  });

  it.effect("starts at now, not in 1970", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_760_000_000_000);

      const ticked = yield* ReadClock().effect;
      const { model } = update(initial, ticked);

      expect(model.nowMs).toBe(1_760_000_000_000);
    })
  );
});
