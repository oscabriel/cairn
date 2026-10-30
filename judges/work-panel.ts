/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one step after another, on purpose */
// The work panel judge (plan 6E, the behaviour scripts `lineage-stop` and `steps`; surfaces note
// "Judges", S5 and S7): the real web client on the `next` views over a real
// in-process brain on the scripted harness (judges/fixtures/parity/CairnApp.ts with the spawning
// model of judges/fixtures/subagents/WorkBrain.ts), at 390 px as a phone (touch, coarse pointer)
// and at 1,440 px, each width on a fresh brain. No model provider is called.
//
//   node judges/work-panel.ts [--width 390,1440] [--broken stop|state|move|count] [--out <dir>]
//
// One run per width, in order, each step judged on what the page shows. The parent spawns four
// children in one step and each starts by Go through the protocol, as the brief card sends it.
//   lineage-stop  the header's work button says "4 subagents" and opens the panel: at 1,440 a
//                 column beside the chat column, never over it, as tall as the page; at 390 a
//                 bottom sheet over a scrim, the full width, its rows and Stop buttons at least
//                 44 px. Two children work with Stop beside them, the done and the failed one are
//                 under "Previous (2)", folded. Stop on "Read the README" ends that child alone:
//                 its row turns Stopped and moves under "Previous (3)" with no Stop, while "List
//                 the docs" still works; nothing scrolls sideways. A click on the working child's
//                 row opens its thread, whose panel leads the way up with its parent.
//   steps         on that child's page the button reads "2/4 steps" and the steps read Go done,
//                 started done, working now, the answer to do. Released, the child answers: the
//                 steps turn done and the button "4/4 steps", and while they change, sampled every
//                 frame, no step row and not the transcript's box moves by more than 1 px. The
//                 failed child's page marks its work failed (2/4), the done child's reads 4/4.
//
// Broken controls, each planted in the page by this judge (never in the app), each of which must
// make the step it names fail:
//   stop   a click on a Stop button never reaches the app (lineage-stop);
//   state  every child row claims to be working (lineage-stop);
//   move   a step that changes state pushes a 40 px block in above the transcript (steps);
//   count  the button's count always reads "4/4 steps" (steps).
// Each width leaves screenshots in the out folder for the user's round: the parent's panel after
// the stop, and the child's steps once done.
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
  holdAll,
  release,
  SPAWNED,
  workBrain,
} from "./fixtures/subagents/WorkBrain.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";

const BROKEN_CONTROLS = ["stop", "state", "move", "count"] as const;

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

const [DONE_CHILD, FAILED_CHILD, STOPPED_CHILD, WORKING_CHILD] = SPAWNED;

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

// A click on a Stop button never reaches the app.
const plantStop = () => {
  document.addEventListener(
    "click",
    (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="work-child-stop"]') !== null
      ) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    { capture: true }
  );
};

// Every child row says it works, whatever its child does.
const plantState = () => {
  new MutationObserver(() => {
    for (const row of document.querySelectorAll<HTMLElement>(
      '[data-testid="work-child"]'
    )) {
      if (row.dataset.state !== "working") {
        row.dataset.state = "working";
        const word = row.querySelector('[data-slot="work-child-state"]');

        if (word !== null) {
          word.textContent = "Working";
        }
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true });
};

// A step that changes state pushes a block in above the transcript.
const plantMove = () => {
  new MutationObserver((records) => {
    const changed = records.some(
      (change) =>
        change.type === "attributes" &&
        change.attributeName === "data-step-state"
    );

    const scroller = document.querySelector('[data-testid="timeline-scroll"]');

    if (changed && scroller?.parentElement !== null && scroller !== null) {
      const block = document.createElement("div");

      block.style.height = "40px";
      block.dataset.planted = "move";
      scroller.parentElement.insertBefore(block, scroller);
    }
  }).observe(document, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-step-state"],
  });
};

// The button's count always reads "4/4 steps".
const plantCount = () => {
  new MutationObserver(() => {
    for (const count of document.querySelectorAll(
      '[data-slot="work-toggle-count"]'
    )) {
      if (
        count.textContent !== "4/4 steps" &&
        (count.textContent ?? "").endsWith("steps")
      ) {
        count.textContent = "4/4 steps";
      }
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
};

const PLANTS: Readonly<Record<Exclude<Broken, "">, () => void>> = {
  stop: plantStop,
  state: plantState,
  move: plantMove,
  count: plantCount,
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

  if (broken !== "") {
    await context.addInitScript(PLANTS[broken]);
  }

  return context;
};

/** Saves what the page shows, for the user's round or beside a failed step's report. */
const shot = async (page: Page, name: string, width: number) => {
  mkdirSync(values.out, { recursive: true });
  await page
    .screenshot({
      path: path.join(values.out, `work-panel-${name}-${width}.png`),
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

const toggle = (page: Page) => page.locator('[data-testid="work-toggle"]');

const panel = (page: Page) => page.locator('[data-testid="work-panel"]');

const childRow = (page: Page, description: string) =>
  page
    .locator('[data-testid="work-child"]')
    .filter({ hasText: description })
    .first();

const textOf = async (page: Page, selector: string) =>
  ((await page.locator(selector).first().textContent()) ?? "").trim();

/** Each child row's description and state, in the order the panel lists them. */
const childStates = async (page: Page, list: string) =>
  await page
    .locator(`[data-testid="${list}"] [data-testid="work-child"]`)
    .evaluateAll((rows) =>
      rows.map((row) => {
        const title =
          row.querySelector('[data-slot="work-child-open"] .truncate')
            ?.textContent ?? "";

        return `${title}=${row instanceof HTMLElement ? (row.dataset.state ?? "") : ""}`;
      })
    );

/** Each step as `kind:state`, in order. */
const stepStates = async (page: Page) =>
  await page
    .locator('[data-testid="work-step"]')
    .evaluateAll((steps) =>
      steps.map((step) =>
        step instanceof HTMLElement
          ? `${step.dataset.step ?? ""}:${step.dataset.stepState ?? ""}`
          : ""
      )
    );

const toggleCount = async (page: Page) =>
  await textOf(page, '[data-slot="work-toggle-count"]');

/** Whether the page scrolls sideways. */
const overflows = async (page: Page) =>
  await page.evaluate(() => {
    const scroller = document.scrollingElement;

    return scroller !== null && scroller.scrollWidth > scroller.clientWidth + 1;
  });

/** Every control in the panel narrower or shorter than `minimum` px. */
const smallTargets = async (page: Page, minimum: number) =>
  await panel(page).evaluate((element, least) => {
    const controls = element.querySelectorAll("a[href], button");

    return [...controls].flatMap((control) => {
      const box = control.getBoundingClientRect();

      return box.width > 0 &&
        (box.width < least - 0.5 || box.height < least - 0.5)
        ? [
            `${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 30)} ${box.width.toFixed(0)}x${box.height.toFixed(0)}`,
          ]
        : [];
    });
  }, minimum);

/** The panel's and the chat column's boxes, and whether the scrim shows. */
const placement = async (page: Page) =>
  await page.evaluate(() => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page code: it runs in the browser, where nothing outside this callback exists
    const boxOf = (selector: string) => {
      const element = document.querySelector(selector);

      if (element === null) {
        return null;
      }

      const box = element.getBoundingClientRect();

      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };

    const scrim = document.querySelector('[data-testid="work-scrim"]');

    return {
      panel: boxOf('[data-testid="work-panel"]'),
      column: boxOf('[data-chat-column="true"]'),
      scroller: boxOf('[data-testid="timeline-scroll"]'),
      viewport: { width: innerWidth, height: innerHeight },
      scrim:
        scrim !== null && scrim.getBoundingClientRect().width > 0
          ? "shown"
          : "hidden",
    };
  });

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

/**
 * Samples, every frame until `stopSampling`, the top of every step row and the transcript's box,
 * keeping the largest move of each from where it started on the root's dataset.
 */
const startSampling = async (page: Page) => {
  await page.evaluate(() => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page code: it runs in the browser, where nothing outside this callback exists
    const read = () => {
      const steps = [
        ...document.querySelectorAll('[data-testid="work-step"]'),
      ].map((step) => step.getBoundingClientRect().top);

      const scroller = document
        .querySelector('[data-testid="timeline-scroll"]')
        ?.getBoundingClientRect();

      return {
        steps,
        box:
          scroller === undefined
            ? [0, 0, 0, 0]
            : [scroller.top, scroller.left, scroller.width, scroller.height],
      };
    };

    const start = read();
    const marks = document.documentElement.dataset;
    let frames = 0;
    let steps = 0;
    let box = 0;

    marks.workSampleStop = "";

    const tick = () => {
      const now = read();

      frames += 1;
      steps = Math.max(
        steps,
        ...now.steps.map((top, index) =>
          Math.abs(top - (start.steps[index] ?? top))
        )
      );
      box = Math.max(
        box,
        ...now.box.map((value, index) =>
          Math.abs(value - (start.box[index] ?? value))
        )
      );
      marks.workSampleFrames = String(frames);
      marks.workSampleSteps = String(steps);
      marks.workSampleBox = String(box);

      if (marks.workSampleStop !== "yes") {
        requestAnimationFrame(tick);
      }
    };

    requestAnimationFrame(tick);
  });
};

/** Ends the sampling and reads what it kept. */
const stopSampling = async (page: Page) =>
  await page.evaluate(() => {
    const marks = document.documentElement.dataset;

    marks.workSampleStop = "yes";

    return {
      frames: Number(marks.workSampleFrames ?? "0"),
      steps: Number(marks.workSampleSteps ?? "0"),
      box: Number(marks.workSampleBox ?? "0"),
    };
  });

/** Opens the panel from the header's button unless it is open. */
const openPanel = async (page: Page) => {
  await toggle(page).waitFor({ state: "visible", timeout: 15_000 });

  if ((await toggle(page).getAttribute("aria-expanded")) !== "true") {
    await toggle(page).click();
  }

  await panel(page).waitFor({ state: "visible", timeout: 5000 });
};

/** One width's run: every step in order, each recorded on its own. */
const runWidth = async (browser: Browser, width: number) => {
  holdAll();

  const app = await startCairn(
    { projectTitle: "Cairn", threadTitle: PARENT_TITLE, entries: [] },
    { brain: workBrain }
  );

  const brainUrl = process.env.CAIRN_DEV_BRAIN ?? "";
  const parentUrl = new URL(app.threadUrl);

  const context = await newDevice(browser, width);
  const page = await context.newPage();
  const isPhone = width < 640;
  const minimum = isPhone ? 44 : 28;

  /** Runs one step; a failed step is recorded and the rest still run. */
  const step = async (name: string, body: () => Promise<string>) => {
    try {
      record(name, width, true, await body());
    } catch (error) {
      await shot(page, `failed-${name}`, width);
      record(
        name,
        width,
        false,
        reasonOf(error instanceof Error ? error : new Error(String(error)))
      );
    }
  };

  let workingChildUrl = "";

  try {
    await page.goto(parentUrl.href, { waitUntil: "networkidle" });
    await page
      .locator('#root[data-ui="next"]')
      .waitFor({ state: "attached", timeout: 15_000 });

    await page
      .locator('[data-testid="composer-editor"]')
      .first()
      .fill("delegate the reading");
    await page.locator('[data-testid="composer-send"]').first().click();

    // The four briefs wait for Go; each answer starts one child.
    const asked = await until(
      async () => await page.locator('[data-testid="subagent-group"]').count(),
      (count) => count === 1,
      15_000
    );

    expect(asked === 1, "the parent never spawned its children");
    await sleep(500);

    const answered = await goOnEveryBrief(brainUrl, app.origin);

    expect(answered === SPAWNED.length, `${answered} briefs waited for Go`);

    await step("lineage-stop", async () => {
      const count = await until(
        async () => await toggleCount(page),
        (seen) => seen === "4 subagents",
        15_000
      );

      expect(
        count === "4 subagents",
        `the work button reads ${JSON.stringify(count)}`
      );

      await openPanel(page);

      const settled = await until(
        async () => ({
          active: await childStates(page, "work-children"),
          previous: await textOf(page, '[data-testid="work-previous-toggle"]'),
        }),
        (seen) =>
          seen.active.length === 2 &&
          seen.active.every((row) => row.endsWith("=working")) &&
          seen.previous.includes("Previous (2)"),
        20_000
      );

      expect(
        settled.active.length === 2 &&
          settled.active.every((row) => row.endsWith("=working")),
        `the live children read ${JSON.stringify(settled.active)}`
      );
      expect(
        settled.previous.includes("Previous (2)"),
        `the resting group reads ${JSON.stringify(settled.previous)}`
      );
      expect(
        (await page.locator('[data-testid="work-previous"]').count()) === 0,
        "the previous children are not folded"
      );

      const where = await placement(page);
      const box = where.panel;
      const { column } = where;

      expect(
        box !== null && column !== null,
        "the panel or the chat column is missing"
      );

      if (box !== null && column !== null) {
        if (isPhone) {
          expect(
            Math.abs(box.bottom - where.viewport.height) <= 1 &&
              box.width >= where.viewport.width - 1 &&
              box.top > 0,
            `the phone's panel is not a bottom sheet: ${JSON.stringify(box)}`
          );
          expect(where.scrim === "shown", "the sheet has no scrim");
        } else {
          expect(
            box.left >= column.right - 1 &&
              box.height >= where.viewport.height - 2 &&
              box.right <= where.viewport.width + 1,
            `the panel is not a column beside the chat: panel ${JSON.stringify(box)}, column ${JSON.stringify(column)}`
          );
          expect(where.scrim === "hidden", "a scrim covers the desktop page");
        }
      }

      const small = await smallTargets(page, minimum);

      expect(
        small.length === 0,
        `controls under ${minimum} px: ${small.join("; ")}`
      );
      expect(!(await overflows(page)), "the page scrolls sideways");

      await childRow(page, STOPPED_CHILD.description)
        .locator('[data-testid="work-child-stop"]')
        .click();

      const stopped = await until(
        async () => ({
          active: await childStates(page, "work-children"),
          previous: await textOf(page, '[data-testid="work-previous-toggle"]'),
        }),
        (seen) =>
          seen.active.length === 1 && seen.previous.includes("Previous (3)"),
        15_000
      );

      expect(
        stopped.active.length === 1 &&
          stopped.active[0] === `${WORKING_CHILD.description}=working`,
        `after Stop the live children read ${JSON.stringify(stopped.active)}`
      );
      expect(
        stopped.previous.includes("Previous (3)"),
        `after Stop the resting group reads ${JSON.stringify(stopped.previous)}`
      );

      // The other child keeps working well after the stop.
      await sleep(1500);

      const later = await childStates(page, "work-children");

      expect(
        later.length === 1 &&
          later[0] === `${WORKING_CHILD.description}=working`,
        `1.5 s after Stop the live children read ${JSON.stringify(later)}`
      );

      await page.locator('[data-testid="work-previous-toggle"]').click();

      const resting = await until(
        async () => await childStates(page, "work-previous"),
        (seen) => seen.length === 3,
        5000
      );

      expect(
        resting.toSorted().join(",") ===
          [
            `${DONE_CHILD.description}=done`,
            `${FAILED_CHILD.description}=failed`,
            `${STOPPED_CHILD.description}=stopped`,
          ].join(","),
        `the resting children read ${JSON.stringify(resting)}`
      );
      expect(
        (await page
          .locator(
            '[data-testid="work-previous"] [data-testid="work-child-stop"]'
          )
          .count()) === 0,
        "a resting child offers Stop"
      );
      expect(!(await overflows(page)), "the page scrolls sideways after Stop");

      await shot(page, "after-stop", width);

      const working = childRow(page, WORKING_CHILD.description);
      const childId = (await working.getAttribute("data-thread-id")) ?? "";

      await working.locator('[data-slot="work-child-open"]').click();
      await page.waitForURL(`**/t/${childId}*`, { timeout: 10_000 });
      workingChildUrl = page.url();

      await openPanel(page);

      const parent = await until(
        async () => await textOf(page, '[data-testid="work-ancestor"]'),
        (seen) => seen.includes(PARENT_TITLE),
        5000
      );

      expect(
        parent.includes(PARENT_TITLE) && parent.includes("Parent"),
        `the child's way up reads ${JSON.stringify(parent)}`
      );

      return `4 subagents; ${isPhone ? "a bottom sheet with a scrim" : "a column beside the chat"}; Stop ended "${STOPPED_CHILD.description}" alone (Previous 2 to 3, stopped), "${WORKING_CHILD.description}" still working 1.5 s later; opened its thread, led by its parent`;
    });

    await step("steps", async () => {
      expect(workingChildUrl !== "", "the working child never opened");

      if (!page.url().startsWith(workingChildUrl)) {
        await page.goto(workingChildUrl, { waitUntil: "networkidle" });
      }

      await openPanel(page);

      const before = await until(
        async () => await stepStates(page),
        (seen) =>
          seen.join(",") === "go:done,started:done,working:now,reported:todo",
        10_000
      );

      expect(
        before.join(",") === "go:done,started:done,working:now,reported:todo",
        `the working child's steps read ${before.join(", ")}`
      );

      const count = await toggleCount(page);

      expect(
        count === "2/4 steps",
        `the button reads ${JSON.stringify(count)} while it works`
      );

      await startSampling(page);
      release(WORKING_CHILD.description);

      const after = await until(
        async () => await stepStates(page),
        (seen) => seen.every((one) => one.endsWith(":done")),
        15_000
      );

      await sleep(300);

      const moved = await stopSampling(page);

      expect(
        after.every((one) => one.endsWith(":done")),
        `after its answer the steps read ${after.join(", ")}`
      );

      const done = await until(
        async () => await toggleCount(page),
        (seen) => seen === "4/4 steps",
        5000
      );

      expect(
        done === "4/4 steps",
        `the button reads ${JSON.stringify(done)} once it answered`
      );
      expect(moved.frames > 2, `only ${moved.frames} frames were sampled`);
      expect(
        moved.steps <= 1 && moved.box <= 1,
        `while the steps changed, a step row moved ${moved.steps.toFixed(1)} px and the transcript's box ${moved.box.toFixed(1)} px`
      );

      await shot(page, "child-steps", width);

      const checkChild = async (description: string, expected: string) => {
        await page.goto(parentUrl.href, { waitUntil: "networkidle" });
        await openPanel(page);

        if (
          (await page.locator('[data-testid="work-previous"]').count()) === 0
        ) {
          await page.locator('[data-testid="work-previous-toggle"]').click();
        }

        const row = childRow(page, description);

        await row.waitFor({ state: "visible", timeout: 10_000 });
        await row.locator('[data-slot="work-child-open"]').click();
        await page.waitForURL("**/t/*", { timeout: 10_000 });
        await openPanel(page);

        const seen = await until(
          async () => {
            const steps = await stepStates(page);

            return steps.join(",");
          },
          (steps) => steps === expected,
          10_000
        );

        expect(seen === expected, `"${description}" reads ${seen}`);

        return await toggleCount(page);
      };

      const failedCount = await checkChild(
        FAILED_CHILD.description,
        "go:done,started:done,working:failed,reported:todo"
      );

      expect(
        failedCount === "2/4 steps",
        `the failed child's button reads ${JSON.stringify(failedCount)}`
      );

      const doneCount = await checkChild(
        DONE_CHILD.description,
        "go:done,started:done,working:done,reported:done"
      );

      expect(
        doneCount === "4/4 steps",
        `the done child's button reads ${JSON.stringify(doneCount)}`
      );
      expect(!(await overflows(page)), "a child's page scrolls sideways");

      return `2/4 while working, then 4/4 with every step done; over ${moved.frames} frames no step moved more than ${moved.steps.toFixed(1)} px, the transcript's box ${moved.box.toFixed(1)} px; failed child 2/4 with its work failed, done child 4/4`;
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
    broken === "" ? "work-panel.json" : `work-panel-broken-${broken}.json`
  ),
  `${JSON.stringify({ judge: "work-panel", broken, passing, checks: results.length, results }, null, 2)}\n`
);

console.log(
  JSON.stringify({
    judge: "work-panel",
    broken,
    checks: results.length,
    passing,
    failing: results.flatMap((result) =>
      result.pass ? [] : [`${result.check}@${result.width}`]
    ),
  })
);

process.exit(results.length > 0 && passing === results.length ? 0 : 1);
