// Scene tests for the `next` disclosure, tally and stepper: a disclosure's header says whether it is
// open and which body it controls, toggles from a click, Enter or Space, sends nothing while
// disabled, and holds its body only while open; a tally reads its counts with their words in
// tabular figures and leaves out empty parts after the first; a stepper says each step's state in
// words and marks the working one, and its pill sums the steps.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import * as Scene from "foldkit/scene";

import { disclosure } from "./Disclosure.ts";
import { appOf, expectSent, given, sent } from "./SceneFixture.ts";
import type { Message } from "./SceneFixture.ts";
import type { Step } from "./Stepper.ts";
import { stepper, stepsPill, stepsTone, stepWord } from "./Stepper.ts";
import { tally, tallyText } from "./Tally.ts";
import type { TallyPart } from "./Tally.ts";

const PARTS: ReadonlyArray<TallyPart> = [
  { count: 4, word: "agents", tone: "neutral" },
  { count: 2, word: "working", tone: "working" },
  { count: 0, word: "failed", tone: "failed" },
  { count: 1, word: "done", tone: "done" },
];

const STEPS: ReadonlyArray<Step> = [
  { title: "Read the note", state: "done", meta: Option.some("1m") },
  { title: "Port the tests", state: "done", meta: Option.none() },
  { title: "Port the panel", state: "working", meta: Option.none() },
  { title: "Run the judge", state: "todo", meta: Option.none() },
];

const toggled =
  (id: string) =>
  (isOpen: boolean): Message =>
    sent(`${id}:${isOpen ? "open" : "fold"}`);

const app = appOf((h) => [
  disclosure(
    h,
    {
      id: "fold",
      isOpen: false,
      onToggle: toggled("fold"),
      isDisabled: false,
      attributes: [h.DataAttribute("testid", "folded")],
    },
    {
      glyph: Option.none(),
      title: "Worked for 4m",
      tally: Option.some(tally(h, PARTS, [h.DataAttribute("testid", "tally")])),
      body: [h.p([], ["Folded body"])],
    }
  ),
  disclosure(
    h,
    {
      id: "phase",
      isOpen: true,
      onToggle: toggled("phase"),
      isDisabled: false,
      attributes: [h.DataAttribute("testid", "open")],
    },
    {
      glyph: Option.none(),
      title: "Build",
      tally: Option.some(stepsPill(h, STEPS, Option.none())),
      body: [stepper(h, "Build steps", STEPS)],
    }
  ),
  disclosure(
    h,
    {
      id: "previous",
      isOpen: false,
      onToggle: toggled("previous"),
      isDisabled: true,
      attributes: [h.DataAttribute("testid", "disabled")],
    },
    {
      glyph: Option.none(),
      title: "Previous agents",
      tally: Option.none(),
      body: [],
    }
  ),
  stepsPill(h, STEPS, Option.some(sent("steps")), [
    h.DataAttribute("testid", "pill"),
  ]),
]);

describe("the next disclosure", () => {
  it("says whether it is open, and controls its body only while open", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("folded")).toHaveAttr("aria-expanded", "false"),
      Scene.expect(Scene.testId("folded")).not.toHaveAttr("aria-controls"),
      Scene.expect(Scene.text("Folded body")).not.toExist(),
      Scene.expect(Scene.testId("open")).toHaveAttr("aria-expanded", "true"),
      Scene.expect(Scene.testId("open")).toHaveAttr(
        "aria-controls",
        "phase-panel"
      ),
      Scene.expect(Scene.selector("#phase-panel")).toHaveAttr(
        "data-slot",
        "disclosure-body"
      ),
      Scene.expect(Scene.role("list", { name: "Build steps" })).toExist(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("toggles from a click, Enter and Space, and sends nothing while disabled", () => {
    Scene.scene(
      app,
      given,
      Scene.click(Scene.testId("folded")),
      Scene.keydown(Scene.testId("open"), "Enter"),
      Scene.keydown(Scene.testId("folded"), " "),
      Scene.expect(Scene.testId("disabled")).toHaveAttr(
        "aria-disabled",
        "true"
      ),
      Scene.expect(Scene.testId("disabled")).not.toHaveHandler("click"),
      expectSent("fold:open,phase:fold,fold:open"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("keeps its header one line: the title truncates and the tally keeps its slot", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("folded"),
        Scene.expect(Scene.text("Worked for 4m")).toHaveClass("truncate")
      ),
      Scene.inside(
        Scene.testId("folded"),
        Scene.expect(
          Scene.selector('[data-slot="disclosure-tally"]')
        ).toHaveClass("shrink-0")
      ),
      Scene.expect(Scene.testId("folded")).toHaveClass("min-h-9"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

describe("the next tally", () => {
  it("reads its counts with their words, leaving out empty parts after the first", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("tally")).toHaveText(
        "4 agents·2 working·1 done"
      ),
      Scene.inside(
        Scene.testId("tally"),
        Scene.expect(Scene.selector('[data-tally-part="failed"]')).not.toExist()
      ),
      Scene.inside(
        Scene.testId("tally"),
        Scene.expect(Scene.selector('[data-tally-part="working"]')).toHaveClass(
          "text-tone-working"
        )
      ),
      Scene.inside(
        Scene.testId("tally"),
        Scene.expectAll(Scene.all.selector(".tabular-nums")).toHaveCount(3)
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("keeps the first part even at zero", () => {
    assert.strictEqual(tallyText(PARTS), "4 agents · 2 working · 1 done");
    assert.strictEqual(
      tallyText([
        { count: 0, word: "agents", tone: "neutral" },
        { count: 0, word: "working", tone: "working" },
      ]),
      "0 agents"
    );
  });
});

describe("the next stepper", () => {
  it("says each step's state in words and marks the working step current", () => {
    Scene.scene(
      app,
      given,
      Scene.expectAll(Scene.all.role("listitem")).toHaveCount(4),
      Scene.expect(Scene.selector('[aria-current="step"]')).toHaveText(
        "Port the panelworking"
      ),
      Scene.expect(Scene.selector('[data-step-state="todo"]')).toHaveText(
        "Run the judgeto do"
      ),
      Scene.inside(
        Scene.selector('[data-step-state="todo"]'),
        Scene.expect(Scene.selector('[data-glyph="todo"]')).toExist()
      ),
      Scene.inside(
        Scene.selector('[aria-current="step"]'),
        Scene.expect(Scene.selector('[data-glyph="busy"]')).toExist()
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );

    assert.deepStrictEqual(
      (["todo", "working", "done", "failed"] as const).map(stepWord),
      ["to do", "working", "done", "failed"]
    );
  });

  it("sums the steps in a pill that opens the steps sheet", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("pill")).toHaveText("2/42 of 4 steps"),
      Scene.expect(Scene.testId("pill")).toHaveAttr("data-tone", "working"),
      Scene.expect(Scene.testId("pill")).toHaveAttr("aria-haspopup", "dialog"),
      Scene.expect(Scene.testId("pill")).toHaveClass(
        "pointer-coarse:min-h-(--hit-target)"
      ),
      Scene.click(Scene.testId("pill")),
      expectSent("steps"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );

    assert.strictEqual(
      stepsTone([
        ...STEPS,
        { title: "x", state: "failed", meta: Option.none() },
      ]),
      "failed"
    );
    assert.strictEqual(
      stepsTone(STEPS.map((step) => ({ ...step, state: "done" as const }))),
      "done"
    );
    assert.strictEqual(
      stepsTone(STEPS.map((step) => ({ ...step, state: "todo" as const }))),
      "neutral"
    );
  });
});
