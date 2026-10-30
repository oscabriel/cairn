/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one step after another, on purpose */
// The workflow surfaces judge (plan 6F, the behaviour scripts `launch-approval` and `steps`;
// surfaces note "Judges", S7 and S8; ADR 0032): the real web client on the `next` views
// over a real in-process brain on the scripted harness (judges/fixtures/parity/
// CairnApp.ts with the proposing parent of judges/fixtures/workflows/LaunchBrain.ts, whose
// `workflow_plan` asks the launch approval as a brief and plays the workflow's ledger, and whose
// `WorkflowStops` the panel's Stop reaches), at 390 px as a phone (touch, coarse pointer) and at
// 1,440 px, each width on a fresh brain. No model provider is called.
//
//   node judges/workflow-surfaces.ts [--width 390,1440] [--broken double|sample|stop] [--out <dir>]
//
//   launch-approval  a launch of `review-fan` shows its numbers first (Nodes 4; the estimate's cost
//                    unknown, never "$0.00"; the $2.00 budget; Go covers "Up to 4 nodes, 3 at
//                    once"), then what each call site runs as (Read · @worker · reads only · up to
//                    3; Judge · @worker · reads only · once) and its arguments folded until
//                    opened, with Send back, Run on 1 first, Decline and Go, every control at
//                    least 44 px at 390 and nothing scrolling sideways. Send back takes notes,
//                    sends one answer and runs nothing, and the model reads the notes once. Run on
//                    1 first sends one answer and runs two nodes of four (the first reader and the
//                    judge). A launch naming `@reviewer`, which the role table does not bind,
//                    blocks Go and Run on 1 first with "no role named @reviewer"; a tap on Go sends
//                    nothing, and Decline with a reason settles it, running nothing.
//   steps            Go on a launch whose readers keep working: the header's button says "1
//                    workflow" and opens the panel (a column beside the chat at 1,440, a bottom
//                    sheet at 390), where the workflow's phases read Read running with its three
//                    readers, each with Stop, and Judge not started. Stop on the second reader
//                    sends one `workflow.stopNode` and stops it alone: it reads stopped, with no
//                    Stop, while the other two still run. The first reader, released, reads done
//                    with its role, model and tokens. Stop workflow sends one `workflow.stop`: the
//                    third reader reads stopped, the workflow stopped with no Stop left, the tally
//                    "3 nodes · 1 done · 2 stopped", Judge not started, and the model reads that
//                    3 of 4 nodes ran. Nothing scrolls sideways; at 390 every control is 44 px.
//
// Broken controls, each planted in the page by this judge (never in the app), each of which must
// make the check it names fail:
//   double  every `thread.respond` frame is sent twice (launch-approval, steps);
//   sample  Run on 1 first's answer leaves as Go (launch-approval);
//   stop    a click on a workflow's or a node's Stop never reaches the app (steps).
// Each width leaves screenshots in the out folder for the user's round: the launch card, and the
// panel after the stops.
// Exits 0 when every check passed; a broken control's run exits 1 when it failed rightly, and the
// JSON line names the failing checks.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import { startCairn } from "./fixtures/parity/CairnApp.ts";
import { BRIEF_ROLES } from "./fixtures/surfaces/BriefBrain.ts";
import {
  holdAll,
  JUDGE,
  LAUNCH_CARD_WORDS,
  launchBrain,
  outcomes,
  READERS,
  release,
} from "./fixtures/workflows/LaunchBrain.ts";

const BROKEN_CONTROLS = ["double", "sample", "stop"] as const;

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

const BOUND = "@worker";

const UNBOUND = "@reviewer";

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

/** A failed expectation inside a check, with what was seen. */
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

// The plants, each run before the app's own scripts. Page code, kept as text: they patch the
// browser's own WebSocket, which this module's types cannot describe without casts.

const PLANT_DOUBLE = `
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    send.call(this, data);
    if (String(data).includes("thread.respond")) send.call(this, data);
  };
`;

const PLANT_SAMPLE = `
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    send.call(this, String(data).replaceAll('"accept_sample"', '"accept"'));
  };
`;

// A click on a workflow's or a node's Stop never reaches the app.
const plantStop = () => {
  document.addEventListener(
    "click",
    (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest(
          '[data-testid="work-node-stop"], [data-testid="work-workflow-stop"]'
        ) !== null
      ) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    { capture: true }
  );
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

  if (broken === "double") {
    await context.addInitScript({ content: PLANT_DOUBLE });
  }

  if (broken === "sample") {
    await context.addInitScript({ content: PLANT_SAMPLE });
  }

  if (broken === "stop") {
    await context.addInitScript(plantStop);
  }

  return context;
};

/** Saves what the page shows, for the user's round or beside a failed check's report. */
const shot = async (page: Page, name: string, width: number) => {
  mkdirSync(values.out, { recursive: true });
  await page
    .screenshot({
      path: path.join(values.out, `workflow-${name}-${width}.png`),
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

/** The frames a page sent that name `method`, counted. */
interface Frames {
  readonly sent: Map<string, number>;
}

const FRAME_METHODS = [
  "thread.respond",
  "workflow.stop",
  "workflow.stopNode",
] as const;

const framesOf = (page: Page): Frames => {
  const sent = new Map<string, number>();

  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const text = String(payload);

      for (const method of FRAME_METHODS) {
        // `workflow.stop` is a prefix of `workflow.stopNode`: match the quoted tag.
        if (text.includes(`"${method}"`)) {
          sent.set(method, (sent.get(method) ?? 0) + 1);
        }
      }
    });
  });

  return { sent };
};

const sentCount = (frames: Frames, method: string): number =>
  frames.sent.get(method) ?? 0;

const card = (page: Page) => page.locator('[data-testid="request-card"]');

const action = (page: Page, name: string) =>
  card(page).locator(`[data-action="${name}"]`);

/** Whether the card's `name` control takes a click. */
const isLive = async (page: Page, name: string): Promise<boolean> =>
  await page.evaluate((selector) => {
    const control = document.querySelector(selector);

    return (
      control !== null &&
      control.getAttribute("aria-disabled") !== "true" &&
      control.getAttribute("aria-busy") !== "true" &&
      !control.hasAttribute("disabled")
    );
  }, `[data-testid="request-card"] [data-action="${name}"]`);

/** Clicks the card's `name` control at once, in the page, without waiting for it. */
const clickNow = async (page: Page, name: string) => {
  await page.evaluate((selector) => {
    document.querySelector<HTMLElement>(selector)?.click();
  }, `[data-testid="request-card"] [data-action="${name}"]`);
};

const editor = (page: Page) =>
  page.locator('[data-testid="composer-editor"]').first();

/** Sends one message from the composer. */
const send = async (page: Page, words: string) => {
  await editor(page).waitFor({ state: "visible", timeout: 15_000 });
  await editor(page).fill(words);
  await page.locator('[data-testid="composer-send"]').first().click();
};

/** Asks the parent for a launch and waits for its card. */
const propose = async (page: Page, role: string, tag: string) => {
  await send(page, `launch ${role} ${tag}`);
  await card(page)
    .filter({ hasText: `(${tag})` })
    .waitFor({ state: "visible", timeout: 15_000 });
  // `roles.check` answers after the card draws.
  await sleep(800);
};

/** The card is gone for `tag`'s launch. */
const cardClosed = async (page: Page, tag: string) => {
  await card(page)
    .filter({ hasText: `(${tag})` })
    .waitFor({ state: "hidden", timeout: 10_000 });
};

/** The model's replies that contain `text`. */
const said = (page: Page, text: string) =>
  page.locator('[data-message-role="assistant"]').filter({ hasText: text });

/** Waits until the model said `text` once, then a little longer, and counts it. */
const saidOnce = async (page: Page, text: string): Promise<number> => {
  await said(page, text)
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => null);
  await sleep(800);

  return await said(page, text).count();
};

/** Whether the page scrolls sideways. */
const overflows = async (page: Page) =>
  await page.evaluate(() => {
    const scroller = document.scrollingElement;

    return scroller !== null && scroller.scrollWidth > scroller.clientWidth + 1;
  });

/** Every visible control under `selector` narrower or shorter than `minimum` px. */
const smallTargets = async (page: Page, selector: string, minimum: number) =>
  await page
    .locator(selector)
    .first()
    .evaluate((element, least) => {
      const controls = element.querySelectorAll("a[href], button, summary");

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

const cardText = async (page: Page) =>
  ((await card(page).first().textContent()) ?? "").replaceAll(/\s+/gu, " ");

// ---------------------------------------------------------------------------------------------
// launch-approval

const launchApproval = async (
  page: Page,
  frames: Frames,
  width: number
): Promise<string> => {
  const isPhone = width < 640;
  const back = `back-${width}`;

  // The card's words, numbers first.
  await propose(page, BOUND, back);

  const text = await cardText(page);
  const site = (pattern: string) => pattern.replace("<role>", BOUND);

  for (const [what, words] of [
    ["the node count", `Nodes${LAUNCH_CARD_WORDS.nodes}`],
    ["the unknown cost", "Cost unknown"],
    ["the budget", LAUNCH_CARD_WORDS.budget],
    ["what Go covers", LAUNCH_CARD_WORDS.covers],
    ["the phases", LAUNCH_CARD_WORDS.phases],
    ["the readers' call site", site(LAUNCH_CARD_WORDS.readSite)],
    ["the judge's call site", site(LAUNCH_CARD_WORDS.judgeSite)],
  ] as const) {
    expect(
      text.includes(words),
      `the card lacks ${what} ${JSON.stringify(words)}: ${text}`
    );
  }

  expect(
    !text.includes("$0.00"),
    `the card reads an unknown as $0.00: ${text}`
  );
  expect(
    text.indexOf("Nodes") < text.indexOf("Read · "),
    "the numbers do not come before the call sites"
  );

  const args = card(page).locator('[data-testid="request-card-args"]');

  expect(
    !(await args.evaluate((element) => element.hasAttribute("open"))),
    "the arguments are not folded"
  );
  await args.locator("summary").click();
  expect(
    ((await args.textContent()) ?? "").includes("src/a.ts"),
    "the arguments did not open"
  );

  for (const name of ["send-back", "run-on-one", "decline", "go"]) {
    expect(await isLive(page, name), `${name} does not take a click`);
  }

  const small = await smallTargets(
    page,
    '[data-testid="request-card"]',
    isPhone ? 44 : 16
  );

  expect(small.length === 0, `small targets on the card: ${small.join(", ")}`);
  expect(!(await overflows(page)), "the page scrolls sideways");
  await shot(page, "launch-card", width);

  // Send back: notes required, one answer, nothing runs, the model reads the notes once.
  const notes = `fewer readers, only src/a.ts (${width})`;
  const respondsBefore = sentCount(frames, "thread.respond");

  await action(page, "send-back").click();

  const field = card(page).locator("textarea");

  await field.waitFor({ state: "visible", timeout: 5000 });
  expect(
    !(await isLive(page, "confirm-send-back")),
    "Send back took a click with no notes"
  );
  await field.fill(notes);
  await action(page, "confirm-send-back").click();
  await cardClosed(page, back);

  const readNotes = await saidOnce(page, notes);

  expect(
    sentCount(frames, "thread.respond") - respondsBefore === 1,
    `Send back sent ${sentCount(frames, "thread.respond") - respondsBefore} answers`
  );
  expect(readNotes === 1, `the model read the notes ${readNotes} times`);
  expect(
    outcomes.get(back)?.ran === 0 && outcomes.get(back)?.decision === "revise",
    `Send back ended ${JSON.stringify(outcomes.get(back))}`
  );

  // Run on 1 first: one answer, two nodes of four.
  const one = `one-${width}`;

  await propose(page, BOUND, one);

  const beforeOne = sentCount(frames, "thread.respond");

  await action(page, "run-on-one").click();
  await cardClosed(page, one);

  const ranOne = await saidOnce(page, `review-fan ${one} finished: ran 2 of 4`);

  expect(
    sentCount(frames, "thread.respond") - beforeOne === 1,
    `Run on 1 first sent ${sentCount(frames, "thread.respond") - beforeOne} answers`
  );
  expect(
    ranOne === 1 && outcomes.get(one)?.ran === 2,
    `Run on 1 first ran ${JSON.stringify(outcomes.get(one))}`
  );

  // An unbound role blocks Go and Run on 1 first; Decline settles it.
  const unbound = `unbound-${width}`;

  await propose(page, UNBOUND, unbound);

  const blocked = card(page).locator('[data-testid="request-card-go-blocked"]');

  await blocked.waitFor({ state: "visible", timeout: 10_000 });

  const reason = ((await blocked.textContent()) ?? "").trim();

  expect(
    reason.includes(`no role named ${UNBOUND}`),
    `the card says ${JSON.stringify(reason)}`
  );
  expect(
    !(await isLive(page, "go")) && !(await isLive(page, "run-on-one")),
    "Go or Run on 1 first takes a click on an unbound role"
  );

  const beforeBlocked = sentCount(frames, "thread.respond");

  await clickNow(page, "go");
  await sleep(800);
  expect(
    sentCount(frames, "thread.respond") === beforeBlocked,
    "a tap on the blocked Go sent an answer"
  );

  await action(page, "decline").click();
  await card(page).locator("textarea").fill("no reviewer role yet");
  await action(page, "confirm-decline").click();
  await cardClosed(page, unbound);
  await sleep(500);
  expect(
    outcomes.get(unbound)?.ran === 0 &&
      outcomes.get(unbound)?.decision === "decline",
    `Decline ended ${JSON.stringify(outcomes.get(unbound))}`
  );

  return `numbers first, cost unknown (never $0.00), call sites and folded arguments; Send back 1 answer, notes read once, nothing ran; Run on 1 first ran 2 of 4; ${UNBOUND} blocked: ${JSON.stringify(reason)}, Decline ran nothing`;
};

// ---------------------------------------------------------------------------------------------
// steps

const toggle = (page: Page) => page.locator('[data-testid="work-toggle"]');

const panel = (page: Page) => page.locator('[data-testid="work-panel"]');

const workflow = (page: Page) =>
  panel(page).locator('[data-testid="work-workflow"]').first();

const nodeRow = (page: Page, label: string) =>
  workflow(page)
    .locator('[data-testid="work-node"]')
    .filter({ hasText: label });

/** Each node as `label=status`, and each phase as `title=label`, in the panel's order. */
const ledgerOf = async (page: Page) =>
  await workflow(page).evaluate((element) => ({
    state: element instanceof HTMLElement ? (element.dataset.state ?? "") : "",
    nodes: [...element.querySelectorAll('[data-testid="work-node"]')].map(
      (row) =>
        `${row.querySelector(".truncate")?.textContent ?? ""}=${row instanceof HTMLElement ? (row.dataset.status ?? "") : ""}`
    ),
    phases: [...element.querySelectorAll('[data-testid="work-phase"]')].map(
      (row) =>
        `${row.querySelector(".truncate")?.textContent ?? ""}=${row.querySelector('[data-slot="work-phase-label"]')?.textContent ?? ""}`
    ),
    tally:
      element.querySelector('[data-slot="work-workflow-tally"]')?.textContent ??
      "",
    stops: element.querySelectorAll(
      '[data-testid="work-node-stop"], [data-testid="work-workflow-stop"]'
    ).length,
  }));

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
      viewport: { width: innerWidth, height: innerHeight },
      scrim:
        scrim !== null && scrim.getBoundingClientRect().width > 0
          ? "shown"
          : "hidden",
    };
  });

const steps = async (
  page: Page,
  frames: Frames,
  width: number
): Promise<string> => {
  const isPhone = width < 640;
  const tag = `steps-${width}`;
  const [first, second, third] = READERS;

  await propose(page, BOUND, tag);

  const beforeGo = sentCount(frames, "thread.respond");

  await action(page, "go").click();
  await cardClosed(page, tag);
  expect(
    sentCount(frames, "thread.respond") - beforeGo === 1,
    `Go sent ${sentCount(frames, "thread.respond") - beforeGo} answers`
  );

  const count = await until(
    async () => ((await toggle(page).textContent()) ?? "").trim(),
    (seen) => seen.endsWith("1 workflow"),
    15_000
  );

  expect(
    count.endsWith("1 workflow"),
    `the work button reads ${JSON.stringify(count)}`
  );
  await toggle(page).click();
  await panel(page).waitFor({ state: "visible", timeout: 5000 });

  const running = await until(
    async () => await ledgerOf(page),
    (seen) =>
      seen.nodes.length === 3 &&
      seen.nodes.every((node) => node.endsWith("=running")),
    15_000
  );

  expect(
    running.nodes.join(",") ===
      READERS.map((label) => `${label}=running`).join(","),
    `the readers read ${JSON.stringify(running.nodes)}`
  );
  expect(
    running.phases.join(",") === "Read=running,Judge=not started",
    `the phases read ${JSON.stringify(running.phases)}`
  );
  // Three node Stops and the workflow's.
  expect(running.stops === 4, `${running.stops} Stops in the workflow`);

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
          where.scrim === "shown",
        `the phone's panel is not a bottom sheet: ${JSON.stringify(box)}`
      );
    } else {
      expect(
        box.left >= column.right - 1 && where.scrim === "hidden",
        `the panel is not a column beside the chat: panel ${JSON.stringify(box)}, column ${JSON.stringify(column)}`
      );
    }
  }

  const minimum = isPhone ? 44 : 16;
  const small = await smallTargets(page, '[data-testid="work-panel"]', minimum);

  expect(small.length === 0, `small targets in the panel: ${small.join(", ")}`);

  // Stop on the second reader stops it alone.
  const beforeNode = sentCount(frames, "workflow.stopNode");

  await nodeRow(page, second ?? "")
    .locator('[data-testid="work-node-stop"]')
    .click();

  const afterNode = await until(
    async () => await ledgerOf(page),
    (seen) => seen.nodes.includes(`${second}=stopped`),
    10_000
  );

  expect(
    sentCount(frames, "workflow.stopNode") - beforeNode === 1,
    `Stop on a node sent ${sentCount(frames, "workflow.stopNode") - beforeNode} stops`
  );
  expect(
    afterNode.nodes.join(",") ===
      `${first}=running,${second}=stopped,${third}=running`,
    `after a node's Stop the readers read ${JSON.stringify(afterNode.nodes)}`
  );
  expect(
    (await nodeRow(page, second ?? "")
      .locator('[data-testid="work-node-stop"]')
      .count()) === 0,
    "the stopped reader still offers Stop"
  );

  // The first reader, released, reads done with its role, model and tokens.
  release(first ?? "");

  await until(
    async () => await ledgerOf(page),
    (seen) => seen.nodes.includes(`${first}=done`),
    10_000
  );

  const detail = (
    (await nodeRow(page, first ?? "")
      .locator('[data-slot="work-node-detail"]')
      .textContent()) ?? ""
  ).trim();

  expect(
    detail.includes(BOUND) &&
      detail.includes("faux/scripted") &&
      detail.includes("2.1k tokens"),
    `the done reader's detail reads ${JSON.stringify(detail)}`
  );

  // Stop workflow stops the rest; the judge never starts.
  const beforeWhole = sentCount(frames, "workflow.stop");

  await workflow(page).locator('[data-testid="work-workflow-stop"]').click();

  const stopped = await until(
    async () => await ledgerOf(page),
    (seen) => seen.state === "stopped",
    10_000
  );

  expect(
    sentCount(frames, "workflow.stop") - beforeWhole === 1,
    `Stop workflow sent ${sentCount(frames, "workflow.stop") - beforeWhole} stops`
  );
  expect(
    stopped.state === "stopped" &&
      stopped.nodes.join(",") ===
        `${first}=done,${second}=stopped,${third}=stopped`,
    `after Stop workflow: ${stopped.state} ${JSON.stringify(stopped.nodes)}`
  );
  expect(
    stopped.tally.includes("3 nodes · 1 done · 2 stopped"),
    `the tally reads ${JSON.stringify(stopped.tally)}`
  );
  expect(
    stopped.phases.join(",") === "Read=stopped,Judge=not started" &&
      !stopped.nodes.some((node) => node.startsWith(JUDGE)),
    `the phases read ${JSON.stringify(stopped.phases)}`
  );
  expect(
    stopped.stops === 0,
    `${stopped.stops} Stops left on a stopped workflow`
  );
  expect(!(await overflows(page)), "the page scrolls sideways");
  await shot(page, "steps-stopped", width);

  // Close the sheet on the phone, so the transcript shows what the model read.
  if (isPhone) {
    await page
      .locator('[data-testid="work-scrim"]')
      .click({ position: { x: 10, y: 10 } });
  }

  const ran = await saidOnce(page, `review-fan ${tag} stopped: ran 3 of 4`);

  expect(ran === 1, `the model read the stop ${ran} times`);

  return `Go 1 answer; "1 workflow"; Read running with 3 readers and Judge not started; a node's Stop 1 frame, it alone stopped; released reader done (${JSON.stringify(detail)}); Stop workflow 1 frame, tally ${JSON.stringify(stopped.tally)}; the model read 3 of 4 ran`;
};

// ---------------------------------------------------------------------------------------------
// One width

const runWidth = async (browser: Browser, width: number) => {
  holdAll();

  const app = await startCairn(
    { projectTitle: "Cairn", threadTitle: "Review the fan", entries: [] },
    { brain: launchBrain, roles: BRIEF_ROLES }
  );

  const url = new URL(app.threadUrl);

  const context = await newDevice(browser, width);
  const page = await context.newPage();
  const frames = framesOf(page);

  const check = async (
    name: string,
    body: (page: Page, frames: Frames, width: number) => Promise<string>
  ) => {
    try {
      record(name, width, true, await body(page, frames, width));
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

  try {
    await page.goto(url.href, { waitUntil: "networkidle" });
    await page
      .locator('#root[data-ui="next"]')
      .waitFor({ state: "attached", timeout: 15_000 });

    await check("launch-approval", launchApproval);
    await check("steps", steps);
  } finally {
    await context.close();
    await app.stop();
  }
};

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
    broken === ""
      ? "workflow-surfaces.json"
      : `workflow-surfaces-broken-${broken}.json`
  ),
  `${JSON.stringify({ judge: "workflow-surfaces", broken, passing, checks: results.length, results }, null, 2)}\n`
);

console.log(
  JSON.stringify({
    judge: "workflow-surfaces",
    broken,
    checks: results.length,
    passing,
    failing: results.flatMap((result) =>
      result.pass ? [] : [`${result.check}@${result.width}`]
    ),
  })
);

process.exit(results.length > 0 && passing === results.length ? 0 : 1);
