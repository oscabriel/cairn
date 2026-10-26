// The durability judge's second client (notes/edges.md, "Durability"): the real web client in a
// Playwright Chromium page at the judge brain's origin, behind `Proxy.ts`. The page exposes
// nothing for testing; the judge reads what a person would see. Its text is the thread's timeline
// (`[data-testid=timeline]`) and the sidebar's thread rows (`[data-testid=shell-thread-row]`), and
// its oracle is the same text from a fresh page opened once the brain is quiet, so both sides are
// rendered by the same renderer from the same build.

import type { Browser, BrowserContext, Page } from "playwright";

const TIMELINE = '[data-testid="timeline"]';

const ROWS = '[data-testid="shell-thread-row"]';

const CONNECTION = '[data-testid="connection-state"]';

export interface ThreadPage {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Messages the page logged as errors, and uncaught exceptions. */
  readonly errors: Array<string>;
  /** The URL of each full load after the first: a reconnect must never reload the page. */
  readonly reloads: Array<string>;
}

/** Opens `/t/<threadId>` in a fresh context and waits until the timeline shows. */
export const openThread = async (
  browser: Browser,
  origin: string,
  threadId: string
): Promise<ThreadPage> => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  const errors: Array<string> = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${origin}/t/${threadId}`, { waitUntil: "load" });
  await page.waitForSelector(TIMELINE, { timeout: 30_000 });

  const reloads: Array<string> = [];

  page.on("load", () => reloads.push(page.url()));

  return { context, page, errors, reloads };
};

export const close = async (thread: ThreadPage) => {
  await thread.context.close();
};

/** What the page shows: the timeline's text and each thread row's text, whitespace collapsed. */
export interface PageText {
  readonly timeline: string;
  readonly rows: ReadonlyArray<string>;
}

const collapse = (text: string) => text.replaceAll(/\s+/gu, " ").trim();

export const read = async (thread: ThreadPage): Promise<PageText> => {
  const timeline = await thread.page
    .locator(TIMELINE)
    .first()
    .textContent({ timeout: 5000 });

  const rows = await thread.page.locator(ROWS).allInnerTexts();

  return { timeline: collapse(timeline ?? ""), rows: rows.map(collapse) };
};

export const same = (left: PageText, right: PageText) =>
  left.timeline === right.timeline &&
  left.rows.length === right.rows.length &&
  left.rows.every((row, index) => row === right.rows[index]);

/** The connection pill's state (`Live`, `Connecting`, ...), or `missing`. */
export const connection = async (thread: ThreadPage) =>
  (await thread.page
    .locator(CONNECTION)
    .first()
    .getAttribute("data-state", { timeout: 1000 })
    .catch(() => null)) ?? "missing";

const describe = (a: string, b: string, what: string) => {
  let index = 0;

  while (index < a.length && index < b.length && a[index] === b[index]) {
    index += 1;
  }

  return `${what} differs at ${index}: page "${a.slice(Math.max(0, index - 30), index + 60)}" vs oracle "${b.slice(Math.max(0, index - 30), index + 60)}"`;
};

/** The page control (`--sabotage page-text`): a stray word in the timeline, as a stale page shows. */
export const scribble = async (thread: ThreadPage) => {
  await thread.page
    .locator(TIMELINE)
    .first()
    .evaluate((element) => {
      element.append(" sabotaged");
    });
};

/** The first place the two texts differ, for a failure message. */
export const firstDifference = (left: PageText, right: PageText) => {
  if (left.timeline !== right.timeline) {
    return describe(left.timeline, right.timeline, "timeline");
  }

  return describe(left.rows.join(" | "), right.rows.join(" | "), "rows");
};
