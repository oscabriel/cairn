// Scene tests for the `next` chips: a plain chip shows its tone, label and count; a toggle chip says
// whether it is pressed, sends its message and is a touch target; a status chip always carries its
// mark and its word, and thread labels map onto the token tones.

import { THREAD_LABELS } from "@cairn/client-logic/ThreadState";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import * as Scene from "foldkit/scene";

import { chip, toggleChip } from "./Chip.ts";
import { markOfTone } from "./Glyph.ts";
import { appOf, expectSent, given, sent } from "./SceneFixture.ts";
import { statusChip, statusOfLabel } from "./StatusChip.ts";
import { TONES, toneOfThreadTone } from "./Tone.ts";
import type { Tone } from "./Tone.ts";

const app = appOf((h) => [
  chip(
    h,
    "waiting",
    { glyph: Option.none(), label: "Subagents", count: Option.some(3) },
    [h.DataAttribute("testid", "plain")]
  ),
  toggleChip(
    h,
    {
      isPressed: true,
      onClick: Option.some(sent("open")),
      attributes: [h.DataAttribute("testid", "pressed")],
    },
    { glyph: Option.none(), label: "Open", count: Option.none() }
  ),
  toggleChip(
    h,
    {
      isPressed: false,
      onClick: Option.some(sent("done")),
      attributes: [h.DataAttribute("testid", "unpressed")],
    },
    { glyph: Option.none(), label: "Done", count: Option.none() }
  ),
  ...TONES.map((tone) =>
    statusChip(h, { tone, mark: markOfTone(tone), word: tone }, [
      h.DataAttribute("testid", `status-${tone}`),
    ])
  ),
  statusChip(h, statusOfLabel(THREAD_LABELS.approval), [
    h.DataAttribute("testid", "approval"),
  ]),
  statusChip(h, statusOfLabel(THREAD_LABELS.failed), [
    h.DataAttribute("testid", "failed"),
  ]),
]);

describe("the next chip", () => {
  it("shows its label and count on its tone's wash", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("plain")).toHaveAttr("data-tone", "waiting"),
      Scene.expect(Scene.testId("plain")).toHaveClass("bg-tone-waiting-wash"),
      Scene.expect(Scene.testId("plain")).toHaveText("Subagents3"),
      Scene.inside(
        Scene.testId("plain"),
        Scene.expect(Scene.selector("[data-chip-count]")).toHaveClass(
          "tabular-nums"
        )
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("toggles: says whether it is pressed and sends its message", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("pressed")).toHaveAttr("aria-pressed", "true"),
      Scene.expect(Scene.testId("unpressed")).toHaveAttr(
        "aria-pressed",
        "false"
      ),
      Scene.expect(Scene.testId("unpressed")).toHaveClass(
        "pointer-coarse:min-h-(--hit-target)"
      ),
      Scene.click(Scene.testId("unpressed")),
      Scene.click(Scene.testId("pressed")),
      expectSent("done,open"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

describe("the status chip", () => {
  it("never shows a status by colour alone: every chip has a mark and a word", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("approval"),
        Scene.expect(Scene.selector('[data-glyph="needs"]')).toExist()
      ),
      Scene.expect(Scene.testId("approval")).toHaveText("Approval"),
      Scene.expect(Scene.testId("approval")).toHaveAttr("data-tone", "waiting"),
      Scene.inside(
        Scene.testId("failed"),
        Scene.expect(Scene.selector('[data-glyph="failed"]')).toExist()
      ),
      Scene.expect(Scene.testId("failed")).toHaveClass("text-tone-failed"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("draws each tone on its own wash with its own mark", () => {
    const expected = {
      neutral: ["idle", "bg-select-2"],
      accent: ["info", "bg-accent-wash"],
      working: ["busy", "bg-tone-working-wash"],
      waiting: ["needs", "bg-tone-waiting-wash"],
      failed: ["failed", "bg-tone-failed-wash"],
      done: ["done", "bg-tone-done-wash"],
    } as const satisfies Record<Tone, readonly [string, string]>;

    Scene.scene(
      app,
      given,
      ...TONES.flatMap((tone) => [
        Scene.expect(Scene.testId(`status-${tone}`)).toHaveAttr(
          "data-tone",
          tone
        ),
        Scene.expect(Scene.testId(`status-${tone}`)).toHaveClass(
          expected[tone][1]
        ),
        Scene.inside(
          Scene.testId(`status-${tone}`),
          Scene.expect(
            Scene.selector(`[data-glyph="${expected[tone][0]}"]`)
          ).toExist()
        ),
        Scene.expect(Scene.testId(`status-${tone}`)).toHaveText(tone),
      ]),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("maps every thread tone onto a token tone that has a wash", () => {
    for (const label of Object.values(THREAD_LABELS)) {
      assert.include(TONES, toneOfThreadTone(label.tone));
    }

    assert.strictEqual(toneOfThreadTone("info"), "working");
    assert.strictEqual(toneOfThreadTone("question"), "waiting");
    assert.strictEqual(toneOfThreadTone("error"), "failed");
    assert.strictEqual(toneOfThreadTone("success"), "done");
    assert.strictEqual(toneOfThreadTone("muted"), "neutral");
  });
});
