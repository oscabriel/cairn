// Ported from github.com/pingdotgg/t3code, apps/web/src/components/composerFooterLayout.test.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: options are `Option` values and positional
// parameters, and every layout carries `iconOnlyCount` (0 without icon-only widths). MIT License,
// Copyright (c) 2026 T3 Tools Inc.; the full notice is in FooterLayout.ts.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX,
  COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX,
  COMPOSER_RESTING_EXPANSION_MIN_PX,
  getRestingComposerImagePreviewCounts,
  overlayComposerIsResting,
  resolveComposerTimelineInset,
  resolveContextStripLabelsCompact,
  resolveRestingComposerControlsLayout,
  resolveRestingComposerControlsNaturalWidth,
  resolveScrollToEndClearance,
  shouldAnimateComposerRestingTransition,
  shouldUseCompactComposerFooter,
  shouldUseCompactComposerPrimaryActions,
  shouldUseRestingComposerLayout,
} from "./FooterLayout.ts";
import type { ControlsLayout, ControlsMeasurement } from "./FooterLayout.ts";

const inset = (
  currentInset: number,
  overlayHeight: number,
  isResting: boolean,
  restingOnlyHeight = 0,
  expandedNoticesHeight = 0
) =>
  resolveComposerTimelineInset({
    currentInset,
    overlayHeight,
    isResting,
    restingOnlyHeight,
    expandedNoticesHeight,
  });

const layout = (
  hiddenCount: number,
  visible: boolean,
  iconOnlyCount = 0
): ControlsLayout => ({
  hiddenCount,
  iconOnlyCount,
  visible,
});

describe(getRestingComposerImagePreviewCounts, () => {
  it("shows at most three thumbnails and counts the remainder", () => {
    assert.deepStrictEqual(getRestingComposerImagePreviewCounts(0), {
      visibleCount: 0,
      overflowCount: 0,
    });
    assert.deepStrictEqual(getRestingComposerImagePreviewCounts(3), {
      visibleCount: 3,
      overflowCount: 0,
    });
    assert.deepStrictEqual(getRestingComposerImagePreviewCounts(7), {
      visibleCount: 3,
      overflowCount: 4,
    });
  });
});

describe(shouldUseCompactComposerFooter, () => {
  it("stays expanded without a measured width", () => {
    assert.isFalse(shouldUseCompactComposerFooter(Option.none()));
  });

  it("switches to compact mode below the breakpoint", () => {
    assert.isTrue(
      shouldUseCompactComposerFooter(
        Option.some(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX - 1)
      )
    );
  });

  it("stays expanded at and above the breakpoint", () => {
    assert.isFalse(
      shouldUseCompactComposerFooter(
        Option.some(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX)
      )
    );
    assert.isFalse(
      shouldUseCompactComposerFooter(
        Option.some(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX + 48)
      )
    );
  });

  it("uses a higher breakpoint for wide action states", () => {
    assert.isTrue(
      shouldUseCompactComposerFooter(
        Option.some(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX - 1),
        true
      )
    );
    assert.isFalse(
      shouldUseCompactComposerFooter(
        Option.some(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX),
        true
      )
    );
  });
});

describe(shouldUseCompactComposerPrimaryActions, () => {
  it("matches the wide footer breakpoint", () => {
    assert.isTrue(
      shouldUseCompactComposerPrimaryActions(
        Option.some(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX - 1),
        true
      )
    );
    assert.isFalse(
      shouldUseCompactComposerPrimaryActions(
        Option.some(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX),
        true
      )
    );
    assert.isFalse(
      shouldUseCompactComposerPrimaryActions(Option.some(10), false)
    );
  });
});

describe(overlayComposerIsResting, () => {
  it("drops a resting reservation once a status bar replaces the composer", () => {
    const isResting = overlayComposerIsResting(false, true);

    assert.isFalse(isResting);
    assert.strictEqual(inset(0, 56, isResting), 56);
    assert.isTrue(overlayComposerIsResting(true, true));
  });
});

describe(resolveComposerTimelineInset, () => {
  it("follows the expanded overlay height", () => {
    assert.strictEqual(inset(160, 140, false), 140);
  });

  it("keeps a larger expanded reservation while resting", () => {
    assert.strictEqual(inset(200, 60, true), 200);
  });

  it("uses the measured expanded height while the resting strip host is mounting", () => {
    assert.strictEqual(inset(172, 110, true), 172);
  });

  it("keeps timeline padding stable when the model-only strip appears on collapse", () => {
    const expanded = inset(0, 172, false);
    const collapsed = inset(expanded, 110, true, 32);

    assert.strictEqual(collapsed, expanded);
    assert.strictEqual(inset(collapsed, 172, false), expanded);
  });

  it("reserves the empty expansion when no larger height is known", () => {
    assert.strictEqual(
      inset(0, 60, true),
      60 + COMPOSER_RESTING_EXPANSION_MIN_PX
    );
  });

  it("keeps the timeline reservation stable through notice expansion and collapse", () => {
    const collapsed = inset(0, 172, false);
    const expanded = inset(collapsed, 532, false, 0, 360);

    assert.strictEqual(expanded, collapsed);

    const resting = inset(expanded, 470, true, 0, 360);

    assert.strictEqual(resting, collapsed);
    assert.strictEqual(inset(resting, 110, true), collapsed);
  });
});

describe(shouldUseRestingComposerLayout, () => {
  const resting = {
    isExistingThread: true,
    isMobileViewport: false,
    isScrollCollapsed: true,
    hasExpandedChrome: false,
    hasMultilinePrompt: false,
    timelineOverflows: true,
  };

  it("uses the resting layout after a timeline scroll", () => {
    assert.isTrue(shouldUseRestingComposerLayout(resting));
  });

  it.each([
    ["the timeline is not scrolled", { isScrollCollapsed: false }],
    ["the timeline fits above it", { timelineOverflows: false }],
    ["it is a new thread", { isExistingThread: false }],
    ["the viewport is mobile", { isMobileViewport: true }],
    ["chrome is expanded", { hasExpandedChrome: true }],
    ["the draft is multi-line", { hasMultilinePrompt: true }],
  ] as const)("stays expanded when %s", (_reason, override) => {
    assert.isFalse(shouldUseRestingComposerLayout({ ...resting, ...override }));
  });
});

describe(shouldAnimateComposerRestingTransition, () => {
  it("does not animate layout measurements that settle during initial mount", () => {
    assert.isFalse(shouldAnimateComposerRestingTransition(false, true, false));
  });

  it("animates later resting-state changes and interrupted transitions", () => {
    assert.isTrue(shouldAnimateComposerRestingTransition(true, true, false));
    assert.isTrue(shouldAnimateComposerRestingTransition(true, false, true));
  });
});

const base: ControlsMeasurement = {
  gap: 4,
  naturalFixedWidth: 149,
  minimumFixedWidth: 105,
  blockWidths: [60, 140],
  overflowWidth: 24,
  iconOnlyBlockWidths: Option.none(),
};

const resolve = (
  input: ControlsMeasurement,
  hostWidth: number,
  previous: Option.Option<ControlsLayout> = Option.none()
) => resolveRestingComposerControlsLayout(input, hostWidth, previous);

describe(resolveRestingComposerControlsLayout, () => {
  it("shows everything when the host has room", () => {
    assert.deepStrictEqual(resolve(base, 357), layout(0, true));
  });

  it("moves trailing blocks into the overflow menu until the rest fits", () => {
    assert.deepStrictEqual(resolve(base, 356), layout(1, true));
    assert.deepStrictEqual(resolve(base, 241), layout(1, true));
    assert.deepStrictEqual(resolve(base, 240), layout(2, true));
  });

  it("shrinks the picker after moving every trailing block into overflow", () => {
    assert.deepStrictEqual(resolve(base, 176), layout(2, true));
    assert.deepStrictEqual(resolve(base, 133), layout(2, true));
  });

  it("hides the whole cluster below the picker's minimum readable width", () => {
    assert.deepStrictEqual(resolve(base, 132), layout(2, false));
    assert.deepStrictEqual(resolve(base, 0), layout(2, false));
  });

  it("supports a single leading control without overflow blocks", () => {
    assert.deepStrictEqual(
      resolve(
        {
          ...base,
          naturalFixedWidth: 140,
          minimumFixedWidth: 140,
          blockWidths: [],
          overflowWidth: 0,
        },
        139
      ),
      layout(0, false)
    );
  });
});

describe("context strip labels and resting composer controls", () => {
  const stripWidth = 724;
  const labelWidth = 327;
  const chromeWidth = 125;

  const measurement: ControlsMeasurement = {
    gap: 4,
    naturalFixedWidth: 96 + 49 / 128 + 5 + 4,
    minimumFixedWidth: 52 + 5 + 4,
    blockWidths: [130 + 89 / 128, 119 + 43 / 64],
    overflowWidth: 28,
    iconOnlyBlockWidths: Option.none(),
  };

  const naturalWidth = resolveRestingComposerControlsNaturalWidth(measurement);

  const hostWidth = (compact: boolean) =>
    stripWidth - chromeWidth - (compact ? 0 : labelWidth);

  it("keeps the labels compact when the full controls only fit beside compact labels", () => {
    const fitted = resolve(measurement, hostWidth(true));

    assert.deepStrictEqual(fitted, layout(0, true));

    const compact = resolveContextStripLabelsCompact(
      true,
      chromeWidth + labelWidth + naturalWidth,
      stripWidth
    );

    assert.isTrue(compact);
    assert.deepStrictEqual(resolve(measurement, hostWidth(compact)), fitted);
  });

  it("does not settle when the strip only reserves the visible controls", () => {
    assert.isFalse(
      resolveContextStripLabelsCompact(
        true,
        chromeWidth + labelWidth + 137,
        stripWidth
      )
    );
    assert.deepStrictEqual(
      resolve(measurement, hostWidth(false)),
      layout(2, true)
    );
  });
});

describe("resolveRestingComposerControlsLayout hysteresis", () => {
  it("keeps a block in overflow when re-showing it would leave no slack", () => {
    assert.deepStrictEqual(
      resolve(base, 357, Option.some(layout(1, true))),
      layout(1, true)
    );
  });

  it("re-shows a block once the host clears the slack margin", () => {
    assert.deepStrictEqual(
      resolve(base, 358, Option.some(layout(1, true))),
      layout(0, true)
    );
  });

  it("restores the blocks that fit when the full cluster has no slack", () => {
    const partlyRestored = resolve(base, 357, Option.some(layout(2, true)));

    assert.deepStrictEqual(partlyRestored, layout(1, true));
    assert.deepStrictEqual(
      resolve(base, 357, Option.some(partlyRestored)),
      partlyRestored
    );
    assert.deepStrictEqual(
      resolve(base, 358, Option.some(partlyRestored)),
      layout(0, true)
    );
  });

  it("requires slack before partially restoring a cluster", () => {
    const previous = layout(2, true);

    assert.deepStrictEqual(resolve(base, 241, Option.some(previous)), previous);
    assert.deepStrictEqual(
      resolve(base, 242, Option.some(previous)),
      layout(1, true)
    );
  });

  it("settles when the measured picker width jitters below a pixel", () => {
    let current = layout(0, true);
    const settled = new Set<string>();

    for (let index = 0; index < 10; index += 1) {
      current = resolve(
        { ...base, naturalFixedWidth: index % 2 === 0 ? 149 : 149.5 },
        357,
        Option.some(current)
      );

      if (index >= 2) {
        settled.add(`${current.hiddenCount}:${current.visible}`);
      }
    }

    assert.strictEqual(settled.size, 1);
  });

  it("keeps the cluster hidden until its minimum width clears the slack", () => {
    assert.deepStrictEqual(
      resolve(base, 133, Option.some(layout(2, false))),
      layout(2, false)
    );
    assert.deepStrictEqual(
      resolve(base, 134, Option.some(layout(2, false))),
      layout(2, true)
    );
  });
});

describe(resolveScrollToEndClearance, () => {
  it("removes the side tab gap while clearing overlapping attachments", () => {
    for (const overlayHeight of [120, 214]) {
      const attachments = [{ top: 500, left: 600, right: 700 }];
      const button = { left: 340, right: 460 };

      assert.strictEqual(
        resolveScrollToEndClearance(overlayHeight, 534, button, attachments),
        overlayHeight - 34
      );
      assert.strictEqual(
        resolveScrollToEndClearance(overlayHeight, 534, button, []),
        overlayHeight
      );
      assert.strictEqual(
        resolveScrollToEndClearance(overlayHeight, 534, button, [
          ...attachments,
          { top: 500, left: 100, right: 700 },
        ]),
        overlayHeight
      );
      assert.strictEqual(
        resolveScrollToEndClearance(
          overlayHeight,
          534,
          { left: 590, right: 710 },
          attachments
        ),
        overlayHeight
      );
    }
  });
});

describe("progressive composer controls", () => {
  const measurement: ControlsMeasurement = {
    gap: 4,
    naturalFixedWidth: 140,
    minimumFixedWidth: 80,
    blockWidths: [80, 140],
    iconOnlyBlockWidths: Option.some([40, 60]),
    overflowWidth: 24,
  };

  it("keeps labels while they fit and removes trailing labels before controls", () => {
    for (const [hostWidth, iconOnlyCount, hiddenCount] of [
      [368, 0, 0],
      [367, 1, 0],
      [288, 1, 0],
      [287, 2, 0],
      [248, 2, 0],
      [247, 2, 1],
      [211, 2, 2],
    ] as const) {
      assert.deepStrictEqual(
        resolve(measurement, hostWidth),
        layout(hiddenCount, true, iconOnlyCount)
      );
    }
  });

  it("requires slack to restore labels and controls", () => {
    for (const [hostWidth, previous, promoted] of [
      [368, layout(0, true, 1), layout(0, true, 0)],
      [288, layout(0, true, 2), layout(0, true, 1)],
      [248, layout(1, true, 2), layout(0, true, 2)],
    ] as const) {
      assert.deepStrictEqual(
        resolve(measurement, hostWidth, Option.some(previous)),
        previous
      );
      assert.deepStrictEqual(
        resolve(measurement, hostWidth + 1, Option.some(previous)),
        promoted
      );
    }
  });

  it("settles through fractional label-width changes at each threshold", () => {
    for (const hostWidth of [368, 288, 248]) {
      let previous = resolve(measurement, hostWidth);

      for (let index = 0; index < 10; index += 1) {
        const next = resolve(
          { ...measurement, naturalFixedWidth: 140 + (index % 2) * 0.5 },
          hostWidth,
          Option.some(previous)
        );

        if (index > 1) {
          assert.deepStrictEqual(next, previous);
        }

        previous = next;
      }
    }
  });
});
