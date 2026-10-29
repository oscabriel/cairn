// Scene tests for progress, meters, dividers, key hints and the empty state: progress reads as a
// percent or as working; a meter takes the waiting tone past its warning share and the failed tone
// at its limit, and an unknown reading reads Unknown, never zero; dividers are separators; a
// shortcut hides on a coarse pointer; an empty state shows only the parts it has.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import * as Scene from "foldkit/scene";

import { divider, labelledDivider } from "./Divider.ts";
import { emptyState } from "./EmptyState.ts";
import { shortcut } from "./Kbd.ts";
import { meter, meterTone, progress, UNKNOWN_READING } from "./Meter.ts";
import type { MeterReading } from "./Meter.ts";
import { appOf, given } from "./SceneFixture.ts";

const reading = (value: Option.Option<number>): MeterReading => ({
  value,
  max: 5,
  warnAt: 0.8,
  text: "some of $5.00",
});

const app = appOf((h) => [
  progress(h, "Nodes", Option.some(0.425), [h.DataAttribute("testid", "some")]),
  progress(h, "Nodes", Option.none(), [h.DataAttribute("testid", "unknown")]),
  meter(h, "Spend", reading(Option.some(4.5)), [
    h.DataAttribute("testid", "warn"),
  ]),
  meter(h, "Spend", reading(Option.none()), [
    h.DataAttribute("testid", "unread"),
  ]),
  divider(h, "vertical"),
  labelledDivider(h, "Previous agents"),
  shortcut(h, ["Ctrl", "K"]),
  emptyState(
    h,
    {
      glyph: Option.none(),
      title: "No subagents yet",
      body: Option.none(),
      action: Option.none(),
    },
    [h.DataAttribute("testid", "empty")]
  ),
]);

describe("progress and meter", () => {
  it("reads progress as a whole percent, and as working while unknown", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("some"),
        Scene.expect(Scene.role("progressbar")).toHaveAttr(
          "aria-valuenow",
          "43"
        ),
        Scene.expect(Scene.selector("[data-reading]")).toHaveText("43%")
      ),
      Scene.inside(
        Scene.testId("unknown"),
        Scene.expect(Scene.role("progressbar")).not.toHaveAttr("aria-valuenow"),
        Scene.expect(Scene.role("progressbar")).toHaveAttr("aria-busy", "true"),
        Scene.expect(Scene.selector("[data-reading]")).toHaveText("Working")
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("warns past its share, and reads an unknown value as Unknown, never zero", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("warn")).toHaveAttr("data-tone", "waiting"),
      Scene.inside(
        Scene.testId("warn"),
        Scene.expect(Scene.role("meter")).toHaveAttr(
          "aria-valuetext",
          "some of $5.00"
        )
      ),
      Scene.expect(Scene.testId("unread")).toHaveAttr("data-tone", "unknown"),
      Scene.inside(
        Scene.testId("unread"),
        Scene.expect(Scene.role("meter")).not.toHaveAttr("aria-valuenow"),
        Scene.expect(Scene.role("meter")).toHaveAttr(
          "aria-valuetext",
          UNKNOWN_READING
        ),
        Scene.expect(Scene.selector("[data-reading]")).toHaveText(
          UNKNOWN_READING
        )
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("takes its tone from its thresholds", () => {
    assert.deepStrictEqual(
      meterTone(reading(Option.some(1))),
      Option.some("accent")
    );
    assert.deepStrictEqual(
      meterTone(reading(Option.some(4))),
      Option.some("waiting")
    );
    assert.deepStrictEqual(
      meterTone(reading(Option.some(5))),
      Option.some("failed")
    );
    assert.deepStrictEqual(meterTone(reading(Option.none())), Option.none());
    assert.deepStrictEqual(
      meterTone({ ...reading(Option.some(0)), max: 0 }),
      Option.some("failed")
    );
  });
});

describe("dividers, key hints and the empty state", () => {
  it("draws separators, a shortcut hidden on a coarse pointer, and only the empty state's parts", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(
        Scene.role("separator", { name: "Previous agents" })
      ).toExist(),
      Scene.expect(Scene.selector('[aria-orientation="vertical"]')).toHaveClass(
        "w-px"
      ),
      Scene.expect(Scene.selector('[data-slot="shortcut"]')).toHaveClass(
        "pointer-coarse:hidden"
      ),
      Scene.expectAll(Scene.all.selector('[data-slot="kbd"]')).toHaveCount(2),
      Scene.expect(Scene.testId("empty")).toHaveText("No subagents yet"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
