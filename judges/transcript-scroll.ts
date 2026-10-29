// The transcript's scroll judge (plan 3C, D26): the real transcript submodel over a 2,100-row
// synthetic thread with a streaming tail, in Chromium, sampled once per animation frame.
//
//   node judges/transcript-scroll.ts [--seconds 6] [--headed] [--broken estimate|reflow|anchor]
//
// It starts the web client's Vite server on an ephemeral loopback port and opens the transcript
// harness (apps/web/src/timeline/harness), which has no brain. `--broken` turns on one of the
// harness's broken controls, to show the check it names fails without what it guards. Checks, in
// order:
//   follow     while replies stream at the end (growing, then committing and starting the next),
//              every frame ends within 1 px of the bottom;
//   scroll-up  a wheel up stops following: the pill shows and, while the reply keeps streaming, no
//              frame moves `scrollTop` or the first visible row;
//   expand     opening a turn fold, then the output of the tool row it revealed, moves no frame's
//              `scrollTop` or the clicked control;
//   pill       the pill brings the list back to its end, which it follows again;
//   switch     thread A's first visible row and its offset come back after showing thread B;
//   range      on a fresh load, a 40-tick wheel gesture up from the end over settled history, then
//              one back down: the scroll range (`scrollHeight - clientHeight`) moves at most 1 px
//              from frame to frame, and neither `scrollTop` nor the rows on screen move against
//              the gesture by more than 1 px (`--broken estimate` fails it);
//   reflow     a glyph near the top of the viewport, bookmarked with `caretRangeFromPoint` as a
//              row and a character offset in it, is back within 3 px of its place once the
//              viewport goes from 1,440 px wide to 900, back, to 390 and back (`--broken reflow`
//              fails it); each step also reports whether the first visible row and its offset,
//              the coarser place the list itself keeps, held within 1 px;
//   insert-above  a turn inserted a few rows above the first visible row, as an escalated
//              question's card lands, moves neither the first visible row nor its offset in any
//              frame, and the list made room above (`--broken anchor` fails it);
//   arrive     a checkpoint landing late for a settled turn above the reader, so that turn's answer
//              grows its changed-files card, likewise moves nothing on screen (`--broken anchor`).
// It also reports the document's element count once the fresh load settled, and after the range
// gesture. Prints one JSON line and exits 0 when every check passed, apart from the known failures
// in `KNOWN_FAILING`, which it reports without failing on; a known failure that passes fails the
// run, so the change that fixes one removes it from the set.
//
// The range and reflow checks are ported from github.com/hardbeat920/monocode,
// tests/browser/transcript-scroll.spec.ts ("scrolling settled history keeps the scroll range
// fixed") and tests/browser/readerAnchor.ts, at 26465c620977f3951d0a532a0f7db32c3c179007.
// Changed: rows on screen are checked for reversal besides `scrollTop`, the gesture also runs back
// down, the bookmark names a list row rather than a reply, and the width steps are this judge's.
//
// MIT License. Copyright (c) 2026 Nick
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

/* oxlint-disable no-await-in-loop -- a judge drives one browser step after another, on purpose */
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { Option, Predicate, Schema } from "effect";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { createServer as createViteServer } from "vite";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "6" },
    headed: { type: "boolean", default: false },
    broken: { type: "string", default: "" },
  },
});

const SECONDS = Number(values.seconds);

const LOOPBACK = "127.0.0.1";

const root = path.resolve(import.meta.dirname, "..");

const SCROLLER = '[data-testid="timeline-scroll"]';

/**
 * Checks that fail on the real transcript today. Empty since the measured list (ADR 0041) fixed
 * stage 2.2's `range` and `reflow` findings (`docs/phase-2/backlog.md`).
 */
const KNOWN_FAILING: ReadonlySet<string> = new Set();

/** The longest main-thread task the follow phase allows, in ms: three frames at 60 Hz. */
const LONG_TASK_MAX_MS = 50;

/**
 * The most long-task time the follow phase allows per six seconds, in ms. Highlighting the growing
 * fence on every frame cost about 1,400; plain until it closes, then sliced, it costs 0 on a quiet
 * machine, and this leaves room for three tasks at the limit.
 */
const LONG_TASK_TOTAL_MS = 150;

/** The range gesture, as MonoCode's: 40 wheel ticks of 160 px, each two frames after the last. */
const GESTURE_TICKS = 40;

const GESTURE_TICK_PX = 160;

/** How far the gesture must carry the list, so a list that hardly moved cannot pass. */
const GESTURE_MIN_TRAVEL_PX = 3000;

/** The widths the reflow check takes the viewport through, in order, from 1,440. */
const REFLOW_WIDTHS = [900, 1440, 390, 1440];

const VIEWPORT = { width: 1440, height: 900 };

/** How far the bookmarked glyph may settle from its place after a width change (MonoCode's 3). */
const REFLOW_TOLERANCE_PX = 3;

/** How long the reflow check watches the glyph after each width change; its last frame counts. */
const REFLOW_SETTLE_MS = 1500;

/** How long the insert-above and arrive checks watch the screen after their change. */
const LAND_WATCH_MS = 1500;

/** How far the list must have scrolled to make room above, so a change that missed cannot pass. */
const LAND_MIN_SHIFT_PX = 20;

// Runs in the page before the app: per-frame sampling, the long-task log, and probes. A string, so
// the page's globals stay out of this file's types; what comes back is decoded below.
const PAGE_SCRIPT = `
window.__longTasks = [];
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
}).observe({ type: "longtask", buffered: true });
window.__takeLongTasks = () => window.__longTasks.splice(0);
window.__pill = () =>
  document.querySelector('[data-testid="scroll-to-end"]')?.dataset.visible === "true";
window.__streamedCode = () =>
  [...document.querySelectorAll('[data-streaming] [data-slot="code-block"] code')].map(
    (code) => code.dataset.highlighted === "true"
  );
window.__nodes = () => document.getElementsByTagName("*").length;
window.__landed = () =>
  Number(document.querySelector('[data-testid="landed"]')?.dataset.count ?? 0);
window.__rows = () =>
  Number(document.querySelector(${JSON.stringify(SCROLLER)})?.querySelector("[aria-setsize]")?.getAttribute("aria-setsize") ?? 0);
window.__markVisible = (selector, name) => {
  const scroller = document.querySelector(${JSON.stringify(SCROLLER)});
  if (scroller === null) return false;
  const box = scroller.getBoundingClientRect();
  const found = [...scroller.querySelectorAll(selector)].find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.top > box.top + 40 && rect.bottom < box.bottom - 120;
  });
  if (found !== undefined) found.dataset.probe = name;
  return found !== undefined;
};
window.__sample = (duration, probe) => new Promise((resolve) => {
  const scroller = document.querySelector(${JSON.stringify(SCROLLER)});
  const frames = [];
  const end = performance.now() + duration;
  const read = () => {
    if (scroller === null) return { scrollTop: 0, distance: 0, firstKey: "", firstOffset: 0, probe: 0 };
    const top = scroller.getBoundingClientRect().top;
    const rows = [...scroller.querySelectorAll("[data-virtual-list-item-key]")];
    const first = rows.find((row) => row.getBoundingClientRect().bottom > top + 1);
    const probed = probe === "" ? null : document.querySelector('[data-probe="' + probe + '"]');
    return {
      scrollTop: scroller.scrollTop,
      distance: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      firstKey: first?.dataset.virtualListItemKey ?? "",
      firstOffset: first === undefined ? 0 : first.getBoundingClientRect().top - top,
      probe: probed === null ? 0 : probed.getBoundingClientRect().top,
    };
  };
  const step = () => {
    frames.push(read());
    if (performance.now() < end) requestAnimationFrame(step);
    else resolve(frames);
  };
  requestAnimationFrame(step);
});
window.__twoFrames = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
window.__rest = () => new Promise((resolve) => {
  const scroller = document.querySelector(${JSON.stringify(SCROLLER)});
  let last = scroller?.scrollTop ?? 0;
  const check = () => setTimeout(() => {
    const now = scroller?.scrollTop ?? 0;
    if (now === last) resolve(true);
    else { last = now; check(); }
  }, 150);
  check();
});
window.__startTrace = () => {
  const scroller = document.querySelector(${JSON.stringify(SCROLLER)});
  const frames = [];
  let frame = 0;
  const read = () => {
    if (scroller === null) return;
    const box = scroller.getBoundingClientRect();
    const rows = [...scroller.querySelectorAll("[data-virtual-list-item-key]")]
      .map((row) => ({
        key: row.dataset.virtualListItemKey ?? "",
        rect: row.getBoundingClientRect(),
      }))
      .filter(({ rect }) => rect.bottom > box.top && rect.top < box.bottom)
      .map(({ key, rect }) => ({ key, top: rect.top - box.top }));
    frames.push({
      scrollTop: scroller.scrollTop,
      range: scroller.scrollHeight - scroller.clientHeight,
      rows,
    });
  };
  const step = () => {
    read();
    frame = requestAnimationFrame(step);
  };
  read();
  frame = requestAnimationFrame(step);
  window.__stopTrace = () => {
    cancelAnimationFrame(frame);
    return frames;
  };
};
// MonoCode's reader anchor: a visible glyph, not a scroll offset or a node boundary.
window.__bookmark = () => {
  const scroller = document.querySelector(${JSON.stringify(SCROLLER)});
  if (scroller === null) return null;
  const box = scroller.getBoundingClientRect();
  for (const offsetY of [32, 48, 64]) {
    for (const fraction of [0.25, 0.5, 0.75]) {
      const x = box.left + box.width * fraction;
      const range = document.caretRangeFromPoint(x, box.top + offsetY);
      if (range === null || range.startContainer.nodeType !== Node.TEXT_NODE) continue;
      const node = range.startContainer;
      const row = node.parentElement?.closest("[data-virtual-list-item-key]");
      if (row == null || !scroller.contains(row) || node.length === 0) continue;
      const offset = Math.min(range.startOffset, node.length - 1);
      if (/\\s/u.test(node.data[offset])) continue;
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const prefix = document.createRange();
      prefix.selectNodeContents(row);
      prefix.setEnd(node, offset);
      return {
        key: row.dataset.virtualListItemKey,
        character: prefix.toString().length,
        glyph: node.data[offset],
        top: rect.top - box.top,
      };
    }
  }
  return null;
};
window.__bookmarkTop = (key, character) => {
  const scroller = document.querySelector(${JSON.stringify(SCROLLER)});
  const row = scroller?.querySelector('[data-virtual-list-item-key="' + CSS.escape(key) + '"]');
  if (scroller == null || row == null) return null;
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let remaining = character;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (remaining < node.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.setEnd(node, remaining + 1);
      return range.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    }
    remaining -= node.length;
  }
  return null;
};
window.__traceBookmark = (duration, key, character) => new Promise((resolve) => {
  const tops = [];
  const end = performance.now() + duration;
  const step = () => {
    tops.push(window.__bookmarkTop(key, character));
    if (performance.now() < end) requestAnimationFrame(step);
    else resolve(tops);
  };
  requestAnimationFrame(step);
});
`;

const Frame = Schema.Struct({
  scrollTop: Schema.Finite,
  distance: Schema.Finite,
  firstKey: Schema.String,
  firstOffset: Schema.Finite,
  probe: Schema.Finite,
});

type Frame = typeof Frame.Type;

const decodeFrames = Schema.decodeUnknownSync(Schema.Array(Frame));

const decodeNumbers = Schema.decodeUnknownSync(Schema.Array(Schema.Finite));

const decodeBooleans = Schema.decodeUnknownSync(Schema.Array(Schema.Boolean));

const decodeBoolean = Schema.decodeUnknownSync(Schema.Boolean);

const decodeNumber = Schema.decodeUnknownSync(Schema.Finite);

const TraceFrame = Schema.Struct({
  scrollTop: Schema.Finite,
  range: Schema.Finite,
  rows: Schema.Array(Schema.Struct({ key: Schema.String, top: Schema.Finite })),
});

type TraceFrame = typeof TraceFrame.Type;

const decodeTrace = Schema.decodeUnknownSync(Schema.Array(TraceFrame));

const Bookmark = Schema.Struct({
  key: Schema.String,
  character: Schema.Int,
  glyph: Schema.String,
  top: Schema.Finite,
});

type Bookmark = typeof Bookmark.Type;

const decodeBookmark = Schema.decodeUnknownSync(
  Schema.OptionFromNullOr(Bookmark)
);

const decodeTops = Schema.decodeUnknownSync(
  Schema.Array(Schema.OptionFromNullOr(Schema.Finite))
);

const freePort = async (): Promise<number> => {
  const server = createNetServer().listen(0, LOOPBACK);

  await once(server, "listening");

  const address = server.address();

  server.close();
  await once(server, "close");

  if (address === null || Predicate.isString(address)) {
    throw new Error(
      "judges/transcript-scroll.ts: the kernel gave no loopback port."
    );
  }

  return address.port;
};

/** Samples the list once per animation frame for `ms`; `probe` names a marked element to track. */
const sampleFrames = async (
  page: Page,
  ms: number,
  probe = ""
): Promise<ReadonlyArray<Frame>> =>
  decodeFrames(
    await page.evaluate(`window.__sample(${ms}, ${JSON.stringify(probe)})`)
  );

const markVisible = async (
  page: Page,
  selector: string,
  probe: string
): Promise<boolean> =>
  decodeBoolean(
    await page.evaluate(
      `window.__markVisible(${JSON.stringify(selector)}, ${JSON.stringify(probe)})`
    )
  );

const pillVisible = async (page: Page): Promise<boolean> =>
  decodeBoolean(await page.evaluate("window.__pill()"));

const takeLongTasks = async (page: Page): Promise<ReadonlyArray<number>> =>
  decodeNumbers(await page.evaluate("window.__takeLongTasks()"));

const changes = (
  frames: ReadonlyArray<Frame>,
  pick: (frame: Frame) => number
): number =>
  frames
    .slice(1)
    .filter(
      (frame, index) =>
        Math.abs(pick(frame) - pick(frames[index] ?? frame)) > 0.5
    ).length;

const maxDistance = (frames: ReadonlyArray<Frame>): number =>
  Math.max(0, ...frames.map((frame) => frame.distance));

const click = async (page: Page, testId: string): Promise<void> => {
  await page.click(`[data-testid="${testId}"]`);
};

const wheelUp = async (page: Page, pixels: number): Promise<void> => {
  const box = await page.locator(SCROLLER).boundingBox();

  if (box !== null) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  }

  for (let moved = 0; moved < pixels; moved += 100) {
    await page.mouse.wheel(0, -100);
    await sleep(16);
  }
};

const followPhase = async (page: Page) => {
  await takeLongTasks(page);
  await click(page, "stream-on");

  const frames = await sampleFrames(page, SECONDS * 1000);
  const tasks = await takeLongTasks(page);

  const streamedCode = decodeBooleans(
    await page.evaluate("window.__streamedCode()")
  );

  return {
    frames: frames.length,
    maxDistancePx: maxDistance(frames),
    framesOver1Px: frames.filter((frame) => frame.distance > 1).length,
    codeBlocks: streamedCode.length,
    codeBlocksHighlighted: streamedCode.filter(Boolean).length,
    longTasks: {
      count: tasks.length,
      totalMs: Math.round(tasks.reduce((sum, value) => sum + value, 0)),
      maxMs: Math.round(Math.max(0, ...tasks)),
      seconds: SECONDS,
    },
  };
};

const scrollUpPhase = async (page: Page) => {
  await wheelUp(page, 800);
  await sleep(400);

  const pill = await pillVisible(page);
  const frames = await sampleFrames(page, 2500);
  const firstKey = frames[0]?.firstKey ?? "";

  return {
    pill,
    frames: frames.length,
    scrollTopChanges: changes(frames, (frame) => frame.scrollTop),
    anchorMoves:
      changes(frames, (frame) => frame.firstOffset) +
      frames.filter((frame) => frame.firstKey !== firstKey).length,
  };
};

const expandPhase = async (page: Page) => {
  await click(page, "stream-off");
  await sleep(300);

  let fold = await markVisible(page, '[data-testid="turn-fold"]', "fold");

  // Scroll up until a fold sits wholly in view, past the streamed reply's long fence; the samples
  // below start after the last wheel.
  for (let tries = 0; !fold && tries < 30; tries += 1) {
    await wheelUp(page, 400);
    await sleep(300);
    fold = await markVisible(page, '[data-testid="turn-fold"]', "fold");
  }

  const foldSampling = sampleFrames(page, 1000, "fold");

  if (fold) {
    await page.click('[data-probe="fold"]');
  }

  const afterFold = await foldSampling;

  // The fold opened its turn: the command it ran is a tool row whose output opens in place.
  const tool = await markVisible(
    page,
    '[data-timeline-row-kind="work"] summary',
    "tool"
  );

  const toolSampling = sampleFrames(page, tool ? 1000 : 0, "tool");

  if (tool) {
    await page.click('[data-probe="tool"]');
  }

  const afterTool = await toolSampling;

  return {
    opened: (fold ? 1 : 0) + (tool ? 1 : 0),
    scrollTopChanges:
      changes(afterFold, (frame) => frame.scrollTop) +
      changes(afterTool, (frame) => frame.scrollTop),
    controlMoves:
      changes(afterFold, (frame) => frame.probe) +
      changes(afterTool, (frame) => frame.probe),
  };
};

const pillPhase = async (page: Page) => {
  await click(page, "stream-on");
  await click(page, "scroll-to-end");
  await sleep(800);

  const frames = await sampleFrames(page, 2000);
  const visibleAfter = await pillVisible(page);

  await click(page, "stream-off");
  await sleep(300);

  return { maxDistancePx: maxDistance(frames), visibleAfter };
};

const switchPhase = async (page: Page) => {
  await wheelUp(page, 3000);
  await sleep(500);

  const [before] = await sampleFrames(page, 50);

  await click(page, "switch-b");
  await sleep(800);
  await click(page, "switch-a");
  await sleep(1200);

  const [after] = await sampleFrames(page, 50);

  return {
    before,
    after,
    keyKept:
      before !== undefined &&
      before.firstKey !== "" &&
      before.firstKey === after?.firstKey,
    offsetDeltaPx: Math.abs(
      (before?.firstOffset ?? 0) - (after?.firstOffset ?? 0)
    ),
  };
};

const rest = async (page: Page): Promise<void> => {
  await page.evaluate("window.__rest()");
};

/** One wheel gesture of `GESTURE_TICKS` ticks, `direction` 1 down or -1 up, traced per frame. */
const gesture = async (
  page: Page,
  direction: 1 | -1
): Promise<ReadonlyArray<TraceFrame>> => {
  await page.evaluate("window.__startTrace()");

  for (let tick = 0; tick < GESTURE_TICKS; tick += 1) {
    await page.mouse.wheel(0, direction * GESTURE_TICK_PX);
    await page.evaluate("window.__twoFrames()");
  }

  await rest(page);

  return decodeTrace(await page.evaluate("window.__stopTrace()"));
};

/** How far the rows on screen moved from one frame to the next, read on a row both frames show. */
const contentSteps = (frames: ReadonlyArray<TraceFrame>): Array<number> =>
  frames.slice(1).flatMap((frame, index) => {
    const previous = frames[index]?.rows ?? [];

    const shared = frame.rows.find((row) =>
      previous.some((other) => other.key === row.key)
    );

    const before = previous.find((row) => row.key === shared?.key);

    return shared === undefined || before === undefined
      ? []
      : [shared.top - before.top];
  });

const summarizeGesture = (
  frames: ReadonlyArray<TraceFrame>,
  direction: 1 | -1
) => {
  const ranges = frames.map((frame) => frame.range);

  const rangeSteps = frames
    .slice(1)
    .map((frame, index) => Math.abs(frame.range - (frames[index]?.range ?? 0)));

  // Scrolling down, `scrollTop` grows and rows rise; a reversal is a step the other way.
  const scrollTopReversals = frames
    .slice(1)
    .filter(
      (frame, index) =>
        direction * (frame.scrollTop - (frames[index]?.scrollTop ?? 0)) < -1
    ).length;

  const contentReversals = contentSteps(frames).filter(
    (step) => direction * step > 1
  ).length;

  const travelPx = Math.round(
    Math.abs((frames.at(-1)?.scrollTop ?? 0) - (frames[0]?.scrollTop ?? 0))
  );

  const rangeMaxStepPx = Math.max(0, ...rangeSteps);

  return {
    held:
      travelPx >= GESTURE_MIN_TRAVEL_PX &&
      rangeMaxStepPx <= 1 &&
      scrollTopReversals === 0 &&
      contentReversals === 0,
    frames: frames.length,
    travelPx,
    rangeMaxStepPx,
    rangeSpreadPx: Math.max(...ranges) - Math.min(...ranges),
    rangeStepsOver1Px: rangeSteps.filter((step) => step > 1).length,
    scrollTopReversals,
    contentReversals,
  };
};

/** Opens the harness at the end of thread A, as a fresh page. */
const load = async (page: Page, url: string): Promise<number> => {
  const started = performance.now();

  await page.goto(url);
  await page.waitForSelector(`${SCROLLER} [data-virtual-list-item-key]`, {
    timeout: 30_000,
  });
  await sleep(1500);

  return Math.round(performance.now() - started);
};

const rangePhase = async (page: Page, url: string) => {
  // A fresh load: the history above the end has never been on screen.
  await load(page, url);

  const box = await page.locator(SCROLLER).boundingBox();

  if (box !== null) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  }

  const up = summarizeGesture(await gesture(page, -1), -1);
  const down = summarizeGesture(await gesture(page, 1), 1);

  return { up, down };
};

const tenths = (value: number): number => Math.round(value * 10) / 10;

/**
 * Per frame for `REFLOW_SETTLE_MS`, how far the bookmarked glyph sits from its place; none while
 * its row is off the list.
 */
const bookmarkShifts = async (
  page: Page,
  bookmark: Bookmark
): Promise<ReadonlyArray<Option.Option<number>>> => {
  const tops = decodeTops(
    await page.evaluate(
      `window.__traceBookmark(${REFLOW_SETTLE_MS}, ${JSON.stringify(bookmark.key)}, ${bookmark.character})`
    )
  );

  return tops.map((top) =>
    Option.map(top, (value) => tenths(Math.abs(value - bookmark.top)))
  );
};

/** Clicks the harness button `testId`, which changes thread A above the reader, and watches. */
const landPhase = async (page: Page, testId: string) => {
  await rest(page);

  const before = decodeNumber(await page.evaluate("window.__landed()"));
  const sampling = sampleFrames(page, LAND_WATCH_MS);

  await click(page, testId);

  const frames = await sampling;
  const after = decodeNumber(await page.evaluate("window.__landed()"));
  const [first] = frames;
  const firstKey = first?.firstKey ?? "";

  return {
    landed: after === before + 1,
    frames: frames.length,
    firstKey,
    scrollTopShiftPx: tenths(
      Math.abs((frames.at(-1)?.scrollTop ?? 0) - (first?.scrollTop ?? 0))
    ),
    anchorMoves:
      changes(frames, (frame) => frame.firstOffset) +
      frames.filter((frame) => frame.firstKey !== firstKey).length,
    maxOffsetShiftPx: tenths(
      Math.max(
        0,
        ...frames.map((frame) =>
          Math.abs(frame.firstOffset - (first?.firstOffset ?? 0))
        )
      )
    ),
  };
};

const nodeCount = async (page: Page): Promise<number> =>
  decodeNumber(await page.evaluate("window.__nodes()"));

const reflowPhase = async (page: Page) => {
  await wheelUp(page, 2400);
  await rest(page);

  const bookmark = decodeBookmark(await page.evaluate("window.__bookmark()"));
  const [before] = await sampleFrames(page, 50);
  const steps = [];

  for (const width of REFLOW_WIDTHS) {
    await page.setViewportSize({ width, height: VIEWPORT.height });

    const shifts = Option.isSome(bookmark)
      ? await bookmarkShifts(page, bookmark.value)
      : [];

    const shiftPx = Option.flatten(Option.fromUndefinedOr(shifts.at(-1)));
    const [after] = await sampleFrames(page, 50);

    const firstOffsetDeltaPx = tenths(
      Math.abs((after?.firstOffset ?? 0) - (before?.firstOffset ?? 0))
    );

    steps.push({
      width,
      held: Option.exists(shiftPx, (shift) => shift <= REFLOW_TOLERANCE_PX),
      shiftPx: Option.getOrNull(shiftPx),
      // A frame with the glyph's row off the list counts as unbounded.
      maxShiftPx: shifts.some(Option.isNone)
        ? null
        : Math.max(0, ...shifts.flatMap(Option.toArray)),
      // The coarser place: the first visible row and its offset, as the list itself keeps it.
      rowKept:
        after !== undefined &&
        after.firstKey === before?.firstKey &&
        firstOffsetDeltaPx <= 1,
      firstKey: after?.firstKey ?? "",
      firstOffsetDeltaPx,
    });
  }

  return {
    bookmark: Option.getOrNull(bookmark),
    firstKey: before?.firstKey ?? "",
    firstOffset: tenths(before?.firstOffset ?? 0),
    steps,
  };
};

const run = async (page: Page, port: number) => {
  const query =
    values.broken === "" ? "" : `?broken=${encodeURIComponent(values.broken)}`;

  const url = `http://${LOOPBACK}:${port}/src/timeline/harness/index.html${query}`;
  const loadMs = await load(page, url);
  const rows = decodeNumber(await page.evaluate("window.__rows()"));
  const nodesOnLoad = await nodeCount(page);
  const atEndOnLoad = maxDistance(await sampleFrames(page, 300));
  const follow = await followPhase(page);
  const scrollUp = await scrollUpPhase(page);
  const expand = await expandPhase(page);
  const pill = await pillPhase(page);
  const threadSwitch = await switchPhase(page);
  const range = await rangePhase(page, url);
  const nodesAfterRange = await nodeCount(page);
  const reflow = await reflowPhase(page);
  const insertAbove = await landPhase(page, "insert-above");
  const arrive = await landPhase(page, "arrive");

  return {
    rows,
    loadMs,
    nodes: { onLoad: nodesOnLoad, afterRange: nodesAfterRange },
    atEndOnLoad,
    follow,
    scrollUp,
    expand,
    pill,
    switch: threadSwitch,
    range,
    reflow,
    insertAbove,
    arrive,
  };
};

/** A change above the reader landed, the list made room for it, and nothing on screen moved. */
const landed = (phase: {
  readonly landed: boolean;
  readonly scrollTopShiftPx: number;
  readonly anchorMoves: number;
}): boolean =>
  phase.landed &&
  phase.scrollTopShiftPx >= LAND_MIN_SHIFT_PX &&
  phase.anchorMoves === 0;

const main = async () => {
  const port = await freePort();

  const vite = await createViteServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    root: path.join(root, "apps/web"),
    logLevel: "error",
    server: { host: LOOPBACK, port, strictPort: true },
  });

  await vite.listen();

  const browser = await chromium.launch({ headless: !values.headed });

  const page = await browser.newPage({ viewport: VIEWPORT });

  const errors: Array<string> = [];

  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(PAGE_SCRIPT);

  const result = await run(page, port);

  await browser.close();
  await vite.close();

  const checks = {
    follow: result.follow.maxDistancePx <= 1 && result.atEndOnLoad <= 1,
    longTasks:
      result.follow.longTasks.maxMs <= LONG_TASK_MAX_MS &&
      result.follow.longTasks.totalMs <= (LONG_TASK_TOTAL_MS * SECONDS) / 6,
    highlighted:
      result.follow.codeBlocks === 2 &&
      result.follow.codeBlocksHighlighted === 2,
    scrollUp:
      result.scrollUp.pill &&
      result.scrollUp.scrollTopChanges === 0 &&
      result.scrollUp.anchorMoves === 0,
    expand:
      result.expand.opened === 2 &&
      result.expand.scrollTopChanges === 0 &&
      result.expand.controlMoves === 0,
    pill: result.pill.maxDistancePx <= 1 && !result.pill.visibleAfter,
    switch: result.switch.keyKept && result.switch.offsetDeltaPx <= 1,
    range: result.range.up.held && result.range.down.held,
    reflow:
      result.reflow.bookmark !== null &&
      result.reflow.steps.every((step) => step.held),
    insertAbove: landed(result.insertAbove),
    arrive: landed(result.arrive),
    errors: errors.length === 0,
  };

  // Under a broken control every check counts, so the control's failure still shows in the exit.
  const known: ReadonlySet<string> =
    values.broken === "" ? KNOWN_FAILING : new Set();

  const entries = Object.entries(checks);

  const failed = entries
    .filter(([name, passed]) => !passed && !known.has(name))
    .map(([name]) => name);

  const fixed = entries
    .filter(([name, passed]) => passed && known.has(name))
    .map(([name]) => name);

  const ok = failed.length === 0 && fixed.length === 0;

  process.stdout.write(
    `${JSON.stringify({ ok, broken: values.broken, failed, knownFailing: [...known], fixed, checks, ...result, errors })}\n`
  );
  process.exitCode = ok ? 0 : 1;
};

await main();
