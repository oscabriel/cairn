// The transcript's scroll judge (plan 3C, D26): the real transcript submodel over a 2,100-row
// synthetic thread with a streaming tail, in Chromium, sampled once per animation frame.
//
//   node judges/transcript-scroll.ts [--seconds 6] [--headed]
//
// It starts the web client's Vite server on an ephemeral loopback port and opens the transcript
// harness (apps/web/src/timeline/harness), which has no brain. Checks, in order:
//   follow     while replies stream at the end (growing, then committing and starting the next),
//              every frame ends within 1 px of the bottom;
//   scroll-up  a wheel up stops following: the pill shows and, while the reply keeps streaming, no
//              frame moves `scrollTop` or the first visible row;
//   expand     opening a turn fold, then the output of the tool row it revealed, moves no frame's
//              `scrollTop` or the clicked control;
//   pill       the pill brings the list back to its end, which it follows again;
//   switch     thread A's first visible row and its offset come back after showing thread B.
// The long tasks seen while streaming are recorded (count, total and longest, in ms).
// Prints one JSON line and exits 0 when every check passed.
/* oxlint-disable no-await-in-loop -- a judge drives one browser step after another, on purpose */
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { Predicate, Schema } from "effect";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { createServer as createViteServer } from "vite";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "6" },
    headed: { type: "boolean", default: false },
  },
});

const SECONDS = Number(values.seconds);

const LOOPBACK = "127.0.0.1";

const root = path.resolve(import.meta.dirname, "..");

const SCROLLER = '[data-testid="timeline-scroll"]';

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

const decodeBoolean = Schema.decodeUnknownSync(Schema.Boolean);

const decodeNumber = Schema.decodeUnknownSync(Schema.Finite);

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

  return {
    frames: frames.length,
    maxDistancePx: maxDistance(frames),
    framesOver1Px: frames.filter((frame) => frame.distance > 1).length,
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

  // Scroll up until a fold sits wholly in view; the samples below start after the last wheel.
  for (let tries = 0; !fold && tries < 12; tries += 1) {
    await wheelUp(page, 300);
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

const run = async (page: Page, port: number) => {
  const started = performance.now();

  await page.goto(`http://${LOOPBACK}:${port}/src/timeline/harness/index.html`);
  await page.waitForSelector(`${SCROLLER} [data-virtual-list-item-key]`, {
    timeout: 30_000,
  });
  await sleep(1500);

  const loadMs = Math.round(performance.now() - started);
  const rows = decodeNumber(await page.evaluate("window.__rows()"));
  const atEndOnLoad = maxDistance(await sampleFrames(page, 300));
  const follow = await followPhase(page);
  const scrollUp = await scrollUpPhase(page);
  const expand = await expandPhase(page);
  const pill = await pillPhase(page);
  const threadSwitch = await switchPhase(page);

  return {
    rows,
    loadMs,
    atEndOnLoad,
    follow,
    scrollUp,
    expand,
    pill,
    switch: threadSwitch,
  };
};

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

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  const errors: Array<string> = [];

  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(PAGE_SCRIPT);

  const result = await run(page, port);

  await browser.close();
  await vite.close();

  const checks = {
    follow: result.follow.maxDistancePx <= 1 && result.atEndOnLoad <= 1,
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
    errors: errors.length === 0,
  };

  const ok = Object.values(checks).every(Boolean);

  process.stdout.write(
    `${JSON.stringify({ ok, checks, ...result, errors })}\n`
  );
  process.exitCode = ok ? 0 : 1;
};

await main();
