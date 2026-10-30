/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one step after another, on purpose */
// The subagent rows judge (plan 6C, the behaviour script `rows-subagent`; surfaces note "Judges",
// S4): the real web client on the `next` views (`?ui=next`) over a real in-process brain on the
// scripted harness (judges/fixtures/parity/CairnApp.ts with the spawning model of
// judges/fixtures/subagents/RowsBrain.ts), at 390 px as a phone (touch, coarse pointer) and at
// 1,440 px, each width on a fresh brain. No model provider is called.
//
//   node judges/rows-subagent.ts [--width 390,1440] [--broken state|back] [--out <dir>]
//
// One run per width, in order, each step judged on what the page shows:
//   spawn    the parent spawns three children in one step: one group line, "3 subagents", "3 need
//            you", folded; opened, three rows "Waiting for Go" that link nowhere (no child yet);
//   go       Go on each brief (`thread.respond`, as the brief card will send it): each row's state
//            comes from its child's own shell row: "Done" with the child's answer as its preview
//            (from 640 px), "Failed", "Working"; the tally "1 working · 1 done · 1 failed";
//   open     a click on the done row opens the child's thread at `/t/<child>`, which shows its
//            answer and heads its transcript with the way back, "Subagent of Plan the port";
//   back     a click on the way back returns to the parent at `/t/<parent>`, the group still
//            there and still open;
//   settle   the slow child answers: its row turns "Done", the group is no longer active, and
//            folded again it dims to the quiet ink with "2 done · 1 failed";
//   layout   every row, the group line and the way back are one line, at least 44 px tall on the
//            phone, and nothing scrolls sideways;
//   classic  the same thread on the classic views shows no subagent row (classic is frozen).
//
// Broken controls, each planted in the page by this judge (never in the app), each of which must
// make the step it names fail:
//   state  every subagent row claims to be working, as a row that ignored its child's shell row
//          would (go);
//   back   the way back loses its link (open, back).
// Each width also leaves three screenshots in the out folder for the user's round: the open group
// after Go, the child with the way back, and the folded group at rest.
// Exits 0 when every step passed; a broken control's run exits 1 when it failed rightly, and the
// JSON line names the failing steps.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { approvalRecordsOf } from "@cairn/client-logic/PendingRequests";
import { ApprovalId, ThreadId } from "@cairn/protocol/Ids";
import { APPROVALS_DOCUMENT } from "@cairn/protocol/Policy";
import { Effect, Option, Predicate, Stream } from "effect";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import { PARITY_THREAD_ID, startCairn } from "./fixtures/parity/CairnApp.ts";
import {
  FAILURE,
  holdSlow,
  QUICK_ANSWER,
  releaseSlow,
  rowsBrain,
  SPAWNED,
} from "./fixtures/subagents/RowsBrain.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";

const BROKEN_CONTROLS = ["state", "back"] as const;

type Broken = (typeof BROKEN_CONTROLS)[number] | "";

const isBroken = (value: string): value is Broken =>
  value === "" || BROKEN_CONTROLS.some((control) => control === value);

const { values } = parseArgs({
  options: {
    width: { type: "string", default: "390,1440" },
    broken: { type: "string", default: "" },
    out: {
      type: "string",
      default: path.join(
        homedir(),
        "Developer/agent-artifacts/cairn/v2/phase-2-surfaces"
      ),
    },
  },
});

if (!isBroken(values.broken)) {
  throw new Error(
    `--broken is one of ${BROKEN_CONTROLS.join(", ")}, not ${values.broken}`
  );
}

const broken: Broken = values.broken;

const widths = values.width.split(",").map(Number);

const PARENT_TITLE = "Plan the port";

interface Result {
  readonly check: string;
  readonly width: number;
  readonly pass: boolean;
  readonly detail: string;
}

const results: Array<Result> = [];

const record = (
  check: string,
  width: number,
  pass: boolean,
  detail: string
) => {
  results.push({ check, width, pass, detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${check}@${width} ${detail}`);
};

/** A failed expectation inside a step, with what was seen. */
class CheckFailedError extends Error {
  override name = "CheckFailedError";
}

const expect = (condition: boolean, what: string) => {
  if (!condition) {
    throw new CheckFailedError(what);
  }
};

const reasonOf = (error: Error): string =>
  error instanceof CheckFailedError
    ? error.message
    : (error.message.split("\n")[0] ?? "failed");

// The plants, each run before the app's own scripts.

// Every subagent row says it works, whatever its child does.
const plantState = () => {
  new MutationObserver(() => {
    for (const row of document.querySelectorAll<HTMLElement>(
      '[data-testid="subagent-row"]'
    )) {
      if (row.dataset.state !== "working") {
        row.dataset.state = "working";
        const word = row.querySelector('[data-slot="subagent-state"]');

        if (word !== null) {
          word.textContent = "Working";
        }
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true });
};

// The way back loses its link.
const plantBack = () => {
  new MutationObserver(() => {
    for (const link of document.querySelectorAll(
      '[data-testid="subagent-parent-link"][href]'
    )) {
      link.removeAttribute("href");
    }
  }).observe(document, { subtree: true, childList: true, attributes: true });
};

const newDevice = async (
  browser: Browser,
  width: number
): Promise<BrowserContext> => {
  const context = await browser.newContext(
    width < 640
      ? {
          viewport: { width, height: 844 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 3,
          reducedMotion: "reduce",
        }
      : { viewport: { width, height: 900 }, reducedMotion: "reduce" }
  );

  if (broken === "state") {
    await context.addInitScript(plantState);
  }

  if (broken === "back") {
    await context.addInitScript(plantBack);
  }

  return context;
};

/** Saves what the page shows after a step, for the user's round. */
const shot = async (page: Page, name: string, width: number) => {
  mkdirSync(values.out, { recursive: true });
  await page
    .screenshot({
      path: path.join(values.out, `rows-subagent-${name}-${width}.png`),
    })
    .catch(() => null);
};

/** Saves what the page shows when a step fails, beside the report. */
const keepScreen = async (page: Page, step: string, width: number) => {
  mkdirSync(values.out, { recursive: true });
  await page
    .screenshot({
      path: path.join(values.out, `rows-subagent-${step}-${width}.png`),
    })
    .catch(() => null);
};

/** Polls `read` until `done` holds, up to `timeout` ms; returns the last reading. */
const until = async <A>(
  read: () => Promise<A>,
  done: (value: A) => boolean,
  timeout: number
): Promise<A> => {
  const end = Date.now() + timeout;
  let seen = await read();

  while (!done(seen) && Date.now() < end) {
    await sleep(100);
    seen = await read();
  }

  return seen;
};

/** A row before Go: no child to link to, waiting for Go. */
const isGoRow = ([state, tag, text]: ReadonlyArray<string | undefined>) =>
  state === "go" && tag === "DIV" && (text ?? "").includes("Waiting for Go");

const group = (page: Page) => page.locator('[data-testid="subagent-group"]');

const toggle = (page: Page) =>
  page.locator('[data-testid="subagent-group-toggle"]');

const rows = (page: Page) => page.locator('[data-testid="subagent-row"]');

const tally = (page: Page) =>
  page.locator('[data-slot="subagent-tally"]').first();

const rowFor = (page: Page, description: string) =>
  rows(page).filter({ hasText: description }).first();

const stateOf = async (page: Page, description: string) =>
  (await rowFor(page, description).getAttribute("data-state")) ?? "";

const textOf = async (page: Page, selector: string) =>
  ((await page.locator(selector).first().textContent()) ?? "").trim();

/** Whether the page scrolls sideways. */
const overflows = async (page: Page) =>
  await page.evaluate(() => {
    const scroller = document.scrollingElement;

    return scroller !== null && scroller.scrollWidth > scroller.clientWidth + 1;
  });

/** Each element's height, and whether its title text sits on one line. */
const boxes = async (page: Page, selector: string) =>
  await page.evaluate((query) => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page code: it runs in the browser, where nothing outside this callback exists
    const one = (element: Element) => {
      const title =
        element.querySelector(
          '[data-slot="subagent-title"], [data-slot="parent-title"], .truncate'
        ) ?? element;

      const { height } = element.getBoundingClientRect();
      const style = getComputedStyle(title);
      const line = Number(style.lineHeight.replace("px", ""));

      return {
        height,
        lines: Number.isFinite(line)
          ? Math.round(title.getBoundingClientRect().height / line)
          : 1,
      };
    };

    return [...document.querySelectorAll(query)].map(one);
  }, selector);

/** Answers Go on each pending brief of the parent, through the protocol, as the brief card will. */
const goOnEveryBrief = async (brainUrl: string, origin: string) =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* ProtocolClient.cairn({
          base: brainUrl,
          origin,
          headers: { host: new URL(origin).host },
          openTimeout: "10 seconds",
        });

        yield* client["session.hello"]();

        const first = yield* client["thread.subscribe"]({
          threadId: ThreadId.make(PARITY_THREAD_ID),
        }).pipe(Stream.runHead);

        const approvals = Option.flatMap(first, (item) =>
          Predicate.isTagged(item, "Snapshot")
            ? Option.fromUndefinedOr(item.view.docs[APPROVALS_DOCUMENT])
            : Option.none()
        );

        const briefs = approvalRecordsOf(
          Option.getOrUndefined(approvals)
        ).filter(
          (found) => found.kind === "brief" && found.status === "pending"
        );

        for (const brief of briefs) {
          yield* client["thread.respond"]({
            threadId: ThreadId.make(PARITY_THREAD_ID),
            approvalId: ApprovalId.make(brief.id),
            decision: "accept",
            reason: Option.none(),
            answers: Option.none(),
            launch: Option.none(),
          });
        }

        return briefs.length;
      })
    )
  );

/** One width's run: every step in order, each recorded on its own. */
const runWidth = async (browser: Browser, width: number) => {
  holdSlow();

  const app = await startCairn(
    { projectTitle: "Cairn", threadTitle: PARENT_TITLE, entries: [] },
    rowsBrain
  );

  const brainUrl = process.env.CAIRN_DEV_BRAIN ?? "";
  const parentUrl = new URL(app.threadUrl);

  parentUrl.searchParams.set("ui", "next");

  const context = await newDevice(browser, width);
  const page = await context.newPage();

  /** Runs one step; a failed step is recorded and the rest still run. */
  const step = async (name: string, body: () => Promise<string>) => {
    try {
      record(name, width, true, await body());
    } catch (error) {
      await keepScreen(page, name, width);
      record(
        name,
        width,
        false,
        reasonOf(error instanceof Error ? error : new Error(String(error)))
      );
    }
  };

  try {
    await page.goto(parentUrl.href, { waitUntil: "networkidle" });
    await page
      .locator('#root[data-ui="next"]')
      .waitFor({ state: "attached", timeout: 15_000 });

    await step("spawn", async () => {
      await page
        .locator('[data-testid="composer-editor"]')
        .first()
        .fill("delegate the counting");
      await page.locator('[data-testid="composer-send"]').first().click();

      // The three calls' results land one by one; the group is whole once all three are asked.
      const count = await until(
        async () =>
          (await group(page).count()) === 1
            ? await group(page).getAttribute("data-count")
            : `${String(await group(page).count())} groups`,
        (seen) => seen === "3",
        15_000
      );

      const line = await textOf(page, '[data-testid="subagent-group-toggle"]');
      const words = (await tally(page).textContent()) ?? "";

      expect(count === "3", `the group holds ${count ?? "no"} children`);
      expect(
        line.includes("3 subagents"),
        `the group line reads ${JSON.stringify(line)}`
      );
      expect(
        words === "3 need you",
        `the tally reads ${JSON.stringify(words)}`
      );
      expect(
        (await rows(page).count()) === 0,
        "the group is open before it was opened"
      );

      await toggle(page).click();
      await rows(page).nth(2).waitFor({ state: "visible", timeout: 5000 });

      const states = await rows(page).evaluateAll((elements) =>
        elements.map((element) => [
          element.dataset.state,
          element.tagName,
          element.textContent ?? "",
        ])
      );

      expect(
        states.length === 3 && states.every(isGoRow),
        `the rows before Go are ${JSON.stringify(states)}`
      );

      return `one folded line "3 subagents · 3 need you"; opened, 3 rows "Waiting for Go" with no link`;
    });

    await step("go", async () => {
      const answered = await goOnEveryBrief(brainUrl, app.origin);

      expect(answered === 3, `${answered} briefs waited for Go`);

      const [quick, failing, slowOne] = SPAWNED;

      const settled = await until(
        async () => [
          await stateOf(page, quick.description),
          await stateOf(page, failing.description),
          await stateOf(page, slowOne.description),
        ],
        (seen) => seen.join(",") === "done,failed,working",
        20_000
      );

      expect(
        settled.join(",") === "done,failed,working",
        `the rows read ${settled.join(", ")}`
      );

      const words = (await tally(page).textContent()) ?? "";

      expect(
        words === "1 working · 1 done · 1 failed",
        `the tally reads ${JSON.stringify(words)}`
      );

      const quickRow = rowFor(page, quick.description);
      const linked = (await quickRow.getAttribute("href")) ?? "";

      expect(
        linked.startsWith("/t/"),
        `the done row links to ${JSON.stringify(linked)}`
      );
      expect(
        ((await quickRow.textContent()) ?? "").includes("Done"),
        "the done row does not say Done"
      );

      await shot(page, "after-go", width);

      if (width >= 640) {
        const preview = (
          (await quickRow
            .locator('[data-slot="subagent-detail"]')
            .textContent()) ?? ""
        ).trim();

        expect(
          preview === QUICK_ANSWER,
          `the done row previews ${JSON.stringify(preview)}`
        );

        const failure = (
          (await rowFor(page, failing.description)
            .locator('[data-slot="subagent-detail"]')
            .textContent()
            .catch(() => "")) ?? ""
        ).trim();

        return `Done (preview "${preview}"), Failed (preview "${failure}"), Working; tally "${words}"`;
      }

      return `Done, Failed, Working; tally "${words}"; previews hidden below 640 px`;
    });

    let childUrl = "";

    await step("open", async () => {
      const quickRow = rowFor(page, SPAWNED[0].description);
      const child = (await quickRow.getAttribute("data-child-thread-id")) ?? "";

      await quickRow.click();
      await page.waitForURL(`**/t/${child}*`, { timeout: 10_000 });
      childUrl = page.url();

      const link = page.locator('[data-testid="subagent-parent-link"]');

      await link.waitFor({ state: "visible", timeout: 10_000 });

      const words = await until(
        async () => ((await link.textContent()) ?? "").trim(),
        (seen) => seen.includes(PARENT_TITLE),
        5000
      );

      expect(
        words.includes("Subagent of") && words.includes(PARENT_TITLE),
        `the way back reads ${JSON.stringify(words)}`
      );

      const href = (await link.getAttribute("href")) ?? "";

      expect(
        href === `/t/${PARITY_THREAD_ID}`,
        `the way back links to ${JSON.stringify(href)}`
      );

      const first = await page
        .locator('[data-testid="timeline-scroll"] [data-timeline-row-kind]')
        .first()
        .getAttribute("data-timeline-row-kind");

      expect(
        first === "parent-link",
        `the child's first row is ${first ?? "none"}`
      );

      await page
        .locator('[data-message-role="assistant"]', { hasText: QUICK_ANSWER })
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });

      await shot(page, "child", width);

      return `opened /t/${child}: "${words}" heads the transcript, and the child's answer shows`;
    });

    await step("back", async () => {
      expect(childUrl !== "", "the child never opened");

      const link = page.locator('[data-testid="subagent-parent-link"]');

      await link.click({ timeout: 5000 });
      await page.waitForURL(`**/t/${PARITY_THREAD_ID}*`, { timeout: 5000 });
      await rows(page).nth(2).waitFor({ state: "visible", timeout: 10_000 });

      const count = await group(page).getAttribute("data-count");

      expect(
        count === "3",
        `the group holds ${count ?? "no"} children after the way back`
      );

      return `back at /t/${PARITY_THREAD_ID}, the group still open with its 3 rows`;
    });

    await step("settle", async () => {
      releaseSlow();

      const active = await until(
        async () => (await group(page).getAttribute("data-active")) ?? "",
        (seen) => seen === "false",
        20_000
      );

      expect(
        active === "false",
        "the group stayed active after every child ended"
      );
      expect(
        (await stateOf(page, SPAWNED[2].description)) === "done",
        "the slow row did not turn Done"
      );

      await toggle(page).click();
      await until(
        async () => await rows(page).count(),
        (count) => count === 0,
        5000
      );

      const dimmed = await group(page).evaluate((element) =>
        element.classList.contains("text-ink-3")
      );

      const words = (await tally(page).textContent()) ?? "";

      await shot(page, "at-rest", width);

      expect(dimmed, "the folded group with nothing live did not dim");
      expect(
        words === "2 done · 1 failed",
        `the tally reads ${JSON.stringify(words)}`
      );

      return `the slow row turned Done; folded, the group dims with "${words}"`;
    });

    await step("layout", async () => {
      await toggle(page).click();
      await rows(page).nth(2).waitFor({ state: "visible", timeout: 5000 });

      const minimum = width < 640 ? 44 : 32;

      const lines = [
        ...(await boxes(page, '[data-testid="subagent-row"]')),
        ...(await boxes(page, '[data-testid="subagent-group-toggle"]')),
      ];

      expect(lines.length === 4, `${lines.length} lines measured`);
      expect(
        lines.every((box) => box.height >= minimum - 0.5 && box.lines === 1),
        `rows ${JSON.stringify(lines)} (at least ${minimum} px, one line)`
      );
      expect(!(await overflows(page)), "the parent's page scrolls sideways");

      await page.goto(childUrl, { waitUntil: "networkidle" });

      const back = page.locator('[data-testid="subagent-parent-link"]');

      await back.waitFor({ state: "visible", timeout: 10_000 });

      const [way] = await boxes(page, '[data-testid="subagent-parent-link"]');

      expect(
        way !== undefined && way.height >= minimum - 0.5 && way.lines === 1,
        `the way back is ${JSON.stringify(way)}`
      );
      expect(!(await overflows(page)), "the child's page scrolls sideways");

      const tallest = Math.max(
        ...lines.map((box) => box.height),
        way?.height ?? 0
      );

      return `4 lines and the way back each one line, ${Math.round(minimum)} to ${Math.round(tallest)} px tall; no sideways scroll`;
    });

    await step("classic", async () => {
      // A fresh device: the `ui` setting this one chose (`?ui=next`) stays with its storage.
      const plain = await newDevice(browser, width);
      const classic = await plain.newPage();

      try {
        await classic.goto(app.threadUrl, { waitUntil: "networkidle" });
        await classic
          .locator('[data-testid="timeline"]')
          .waitFor({ state: "visible", timeout: 15_000 });
        await sleep(500);

        const next = await classic.locator('#root[data-ui="next"]').count();

        const drawn = await classic
          .locator(
            '[data-testid="subagent-group"], [data-testid="subagent-row"]'
          )
          .count();

        expect(next === 0, "the classic page drew the next frame");
        expect(drawn === 0, `the classic page drew ${drawn} subagent rows`);

        return "the classic views draw no subagent row";
      } finally {
        await plain.close();
      }
    });
  } finally {
    await context.close();
    await app.stop();
  }
};

// The failing child's reason is the brain's; named here so a reader of the report knows it.
console.log(`(the failing child's run fails with ${JSON.stringify(FAILURE)})`);

const browser = await chromium.launch();

try {
  for (const width of widths) {
    await runWidth(browser, width);
  }
} finally {
  await browser.close();
}

const passing = results.filter((result) => result.pass).length;

mkdirSync(values.out, { recursive: true });

writeFileSync(
  path.join(
    values.out,
    broken === "" ? "rows-subagent.json" : `rows-subagent-broken-${broken}.json`
  ),
  `${JSON.stringify({ judge: "rows-subagent", broken, passing, checks: results.length, results }, null, 2)}\n`
);

console.log(
  JSON.stringify({
    judge: "rows-subagent",
    broken,
    checks: results.length,
    passing,
    failing: results.flatMap((result) =>
      result.pass ? [] : [`${result.check}@${result.width}`]
    ),
  })
);

process.exit(results.length > 0 && passing === results.length ? 0 : 1);
