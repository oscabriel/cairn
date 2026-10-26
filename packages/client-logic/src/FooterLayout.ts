// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// apps/web/src/components/composerFooterLayout.ts, and resolveContextStripLabelsCompact from
// apps/web/src/components/BranchToolbar.logic.ts. Kept: the compact footer below 620 px (780 px
// with wide actions), the resting layout rules, the timeline inset arithmetic, and the measured
// folding of footer blocks (labels go icon-only from the last block back, then blocks hide into the
// overflow menu, then the whole cluster hides below its minimum width) with a pixel of slack on the
// way back so a jittering measurement cannot flip the layout. Changed: optional inputs and results
// are `Option`, and the layout always reports `iconOnlyCount` (0 when the blocks have no icon-only
// widths).
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { Option, Schema } from "effect";

/** Below this composer width the footer is compact. */
export const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 620;

/** Below this width a footer with wide actions (Stop beside send, queue controls) is compact. */
export const COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX = 780;

const RESTING_IMAGE_THUMBNAIL_LIMIT = 3;

/** How many image thumbnails a resting composer shows, and how many it counts as "+n". */
export const getRestingComposerImagePreviewCounts = (imageCount: number) => {
  const visibleCount = Math.min(imageCount, RESTING_IMAGE_THUMBNAIL_LIMIT);

  return {
    visibleCount,
    overflowCount: Math.max(0, imageCount - visibleCount),
  };
};

/** True below the compact breakpoint; a composer not measured yet stays expanded. */
export const shouldUseCompactComposerFooter = (
  width: Option.Option<number>,
  hasWideActions = false
): boolean => {
  const breakpoint = hasWideActions
    ? COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
    : COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX;

  return Option.exists(width, (measured) => measured < breakpoint);
};

/** True when wide primary actions should fold to icons. */
export const shouldUseCompactComposerPrimaryActions = (
  width: Option.Option<number>,
  hasWideActions: boolean
): boolean =>
  hasWideActions &&
  Option.exists(
    width,
    (measured) => measured < COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
  );

/** What decides whether an existing thread's composer rests as one short row. */
export interface RestingLayoutFacts {
  readonly isExistingThread: boolean;
  readonly isMobileViewport: boolean;
  readonly isScrollCollapsed: boolean;
  readonly hasExpandedChrome: boolean;
  readonly hasMultilinePrompt: boolean;
  readonly timelineOverflows: boolean;
}

/** True when the composer should rest: desktop, an existing thread scrolled into its history. */
export const shouldUseRestingComposerLayout = (
  facts: RestingLayoutFacts
): boolean =>
  facts.isExistingThread &&
  !facts.isMobileViewport &&
  facts.timelineOverflows &&
  facts.isScrollCollapsed &&
  !facts.hasMultilinePrompt &&
  !facts.hasExpandedChrome;

/**
 * How much taller the empty expanded composer is than its resting row on desktop: the body loses
 * 8 px of top padding, the prompt clamps from 70 px to 32 px, and the 48 px footer leaves flow.
 */
export const COMPOSER_RESTING_EXPANSION_MIN_PX = 94;

/** What the timeline inset is computed from. */
export interface TimelineInsetFacts {
  readonly currentInset: number;
  readonly overlayHeight: number;
  readonly isResting: boolean;
  readonly restingOnlyHeight: number;
  readonly expandedNoticesHeight: number;
}

/**
 * The space the timeline keeps clear under it. Reserving only the resting height lets a scroll to
 * the end land flush against the short composer, and the expansion that follows would then cover
 * the last rows.
 */
export const resolveComposerTimelineInset = (
  facts: TimelineInsetFacts
): number => {
  // Expanded notices temporarily cover the timeline; remove their growth before rounding.
  const overlayHeight = Math.ceil(
    facts.overlayHeight - facts.expandedNoticesHeight
  );

  return facts.isResting
    ? Math.max(
        facts.currentInset,
        overlayHeight +
          (facts.currentInset === 0
            ? COMPOSER_RESTING_EXPANSION_MIN_PX - facts.restingOnlyHeight
            : 0)
      )
    : overlayHeight;
};

/** True only while the composer is mounted and reported itself resting. */
export const overlayComposerIsResting = (
  composerMounted: boolean,
  composerReportedResting: boolean
): boolean => composerMounted && composerReportedResting;

/** True when a resting-state change should animate: never during the first layout. */
export const shouldAnimateComposerRestingTransition = (
  hasCompletedInitialLayout: boolean,
  stateChanged: boolean,
  hasInterruptedAnimation: boolean
): boolean =>
  hasCompletedInitialLayout && (stateChanged || hasInterruptedAnimation);

/** The measured widths the footer's folding is computed from, in CSS pixels. */
export const ControlsMeasurement = Schema.Struct({
  gap: Schema.Finite,
  /** The always-shown leading control (the model picker) at its natural width. */
  naturalFixedWidth: Schema.Finite,
  /** The leading control at its smallest readable width. */
  minimumFixedWidth: Schema.Finite,
  /** Each foldable block at its natural width, in footer order. */
  blockWidths: Schema.Array(Schema.Finite),
  /** The overflow menu's trigger. */
  overflowWidth: Schema.Finite,
  /** Each block with its label hidden, when the blocks can go icon-only. */
  iconOnlyBlockWidths: Schema.Option(Schema.Array(Schema.Finite)),
});

export type ControlsMeasurement = typeof ControlsMeasurement.Type;

/** How the footer folds: blocks hidden into the overflow menu, blocks shown as icons, and whether any of it shows. */
export const ControlsLayout = Schema.Struct({
  hiddenCount: Schema.Int,
  iconOnlyCount: Schema.Int,
  visible: Schema.Boolean,
});

export type ControlsLayout = typeof ControlsLayout.Type;

const controlsWidth = (
  input: ControlsMeasurement,
  hiddenCount: number,
  fixedWidth: number,
  iconOnlyCount: number
): number => {
  const { blockWidths, gap } = input;
  const visibleCount = blockWidths.length - hiddenCount;

  const iconWidths = Option.getOrElse(
    input.iconOnlyBlockWidths,
    () => blockWidths
  );

  let blocks = 0;

  for (let index = 0; index < visibleCount; index += 1) {
    const iconOnly = index >= blockWidths.length - iconOnlyCount;

    blocks += (iconOnly ? iconWidths[index] : blockWidths[index]) ?? 0;
  }

  return (
    fixedWidth +
    blocks +
    (hiddenCount > 0 ? input.overflowWidth : 0) +
    gap * (visibleCount + (hiddenCount > 0 ? 1 : 0))
  );
};

/**
 * The width the controls want with nothing folded. The context strip reserves this before letting
 * its own labels expand; reserving only what is visible would let the strip take space the
 * composer just gave up, which hides the controls again, and repeats.
 */
export const resolveRestingComposerControlsNaturalWidth = (
  input: ControlsMeasurement
): number => controlsWidth(input, 0, input.naturalFixedWidth, 0);

const SLACK_PX = 1;

/**
 * How the footer folds into `hostWidth`. Demotions are immediate; promotions need a pixel of slack
 * over the `previous` layout, so a width that jitters by a fraction of a pixel settles.
 */
export const resolveRestingComposerControlsLayout = (
  input: ControlsMeasurement,
  hostWidth: number,
  previous: Option.Option<ControlsLayout>
): ControlsLayout => {
  const blockCount = input.blockWidths.length;
  const iconSteps = Option.isSome(input.iconOnlyBlockWidths) ? blockCount : 0;

  const previousStep = Option.match(previous, {
    onNone: () => 0,
    onSome: (last) =>
      last.hiddenCount > 0
        ? iconSteps + Math.min(last.hiddenCount, blockCount)
        : Math.min(last.iconOnlyCount, iconSteps),
  });

  const widthAtStep = (candidate: number, fixedWidth: number) =>
    controlsWidth(
      input,
      Math.max(0, candidate - iconSteps),
      fixedWidth,
      Math.min(candidate, iconSteps)
    );

  let step = 0;

  while (
    step < iconSteps + blockCount &&
    widthAtStep(step, input.naturalFixedWidth) >
      hostWidth - (step < previousStep ? SLACK_PX : 0)
  ) {
    step += 1;
  }

  const minimumWidth = widthAtStep(step, input.minimumFixedWidth);
  const wasHidden = Option.exists(previous, (last) => !last.visible);

  return {
    hiddenCount: Math.max(0, step - iconSteps),
    iconOnlyCount: Math.min(step, iconSteps),
    visible: wasHidden
      ? minimumWidth <= hostWidth - SLACK_PX
      : minimumWidth <= hostWidth,
  };
};

const CONTEXT_STRIP_EXPAND_HYSTERESIS_PX = 16;

/**
 * True when the context strip's labels should collapse to icons. Expanding again needs 16 px more
 * than collapsing did, so the boundary cannot flap.
 */
export const resolveContextStripLabelsCompact = (
  compact: boolean,
  neededWidth: number,
  availableWidth: number
): boolean =>
  compact
    ? neededWidth > availableWidth - CONTEXT_STRIP_EXPAND_HYSTERESIS_PX
    : neededWidth > availableWidth;

/** A rectangle's horizontal extent and top, in viewport pixels. */
export interface HorizontalBox {
  readonly top: number;
  readonly left: number;
  readonly right: number;
}

/** How far the scroll-to-end pill sits above the composer, clearing attachments under it. */
export const resolveScrollToEndClearance = (
  overlayHeight: number,
  mainSurfaceTop: number,
  button: Omit<HorizontalBox, "top">,
  attachments: ReadonlyArray<HorizontalBox>
): number => {
  let contentTop = mainSurfaceTop;
  let top = contentTop;

  for (const attachment of attachments) {
    contentTop = Math.min(contentTop, attachment.top);

    if (attachment.left < button.right && attachment.right > button.left) {
      top = Math.min(top, attachment.top);
    }
  }

  return Math.ceil(overlayHeight - (top - contentTop));
};
