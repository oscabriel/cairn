// Scene tests for the glyphs: each status mark draws its own lucide icon hidden from assistive
// technology, and the busy mark turns only when motion is allowed.

import { assert, describe, it } from "@effect/vitest";
import * as Scene from "foldkit/scene";

import { markOfTone, STATUS_MARKS, statusGlyph } from "./Glyph.ts";
import { appOf, given } from "./SceneFixture.ts";
import { TONES } from "./Tone.ts";

const app = appOf((h) =>
  STATUS_MARKS.map((mark) => statusGlyph(h, mark, "regular"))
);

describe("the status glyphs", () => {
  it("draws one hidden lucide icon per mark, and spins only the busy one when motion is allowed", () => {
    Scene.scene(
      app,
      given,
      Scene.expectAll(Scene.all.selector("[data-glyph] svg")).toHaveCount(
        STATUS_MARKS.length
      ),
      Scene.expect(Scene.selector('[data-glyph="done"] svg')).toHaveClass(
        "lucide-circle-check"
      ),
      Scene.expect(Scene.selector('[data-glyph="done"] svg')).toHaveAttr(
        "aria-hidden",
        "true"
      ),
      Scene.expect(Scene.selector('[data-glyph="busy"]')).toHaveClass(
        "motion-safe:animate-spin"
      ),
      Scene.expect(Scene.selector('[data-glyph="done"]')).not.toHaveClass(
        "motion-safe:animate-spin"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("gives every tone a distinct mark", () => {
    assert.strictEqual(new Set(TONES.map(markOfTone)).size, TONES.length);
  });
});
