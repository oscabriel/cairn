/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one check after another, on purpose */
// The phase 2 surface judge (plan wave 6; surfaces note "Judges"): behaviour scripts played in the
// real web client on the `next` views (`?ui=next`) over a real in-process brain on the scripted
// harness (judges/fixtures/parity/CairnApp.ts with the asking model of
// judges/fixtures/surfaces/CardBrain.ts, and for the brief checks a second brain with the
// proposing parent of judges/fixtures/surfaces/BriefBrain.ts), at 390 px as a phone (touch,
// coarse pointer, an emulated soft keyboard) and at 1,440 px. Each check prints one line; the run
// ends with one JSON line. No model provider is called.
//
//   node judges/surfaces.ts [--only card-approval,card-question,brief-go,brief-go-back,brief-go-unbound]
//                           [--width 390,1440] [--broken slot|double|advance|undo|nocheck]
//                           [--out <dir>]
//
// Checks (6A, the request card):
//   card-approval  a `gate` call's approval shows on the card with its tool and the call's detail;
//                  at 390 it takes the composer's slot (the composer hidden, the card inside the
//                  screen, every control at least 44 by 44 px, no sideways scroll), at 1,440 it
//                  sits above the visible composer in the same column; Approve sends exactly one
//                  `thread.respond`, closes the card and the model reads "accepted" once; a second
//                  request survives a reload of the page; two devices answering it at once (one
//                  Approve, one Decline with a reason) settle it once, each sending one answer, and
//                  the device that lost shows the winning line.
//   card-question  an `ask_user` call's two questions show one at a time with "1/2"; a pick (the
//                  digit 2 with focus in the options at 1,440, a tap at 390) marks the option at
//                  once and advances after the 200 ms pause (between 150 and 1,500 ms); the
//                  user's own words typed with the soft keyboard open stay as typed; Send opens the
//                  undo bar and Undo sends nothing; Send again sends exactly one answer after the
//                  3 s window, and the model reads both answers, numbered; a second question
//                  declined with a reason sends one answer and the model reads the reason.
//
// Checks (6B, the brief card and Go; ADR 0026, 0030, 0035):
//   brief-go          a `subagent_spawn` brief naming `@worker` shows its words (Do, Why, Runs on
//                     with the model `roles.check` resolved) with Send back, Decline and Go, in the
//                     composer's slot at 390 (44 px targets) and above the composer at 1,440. The
//                     brain restarts while the card waits: the page reconnects, the card still
//                     shows and checks the role again. Then a second device opens it, and Go is
//                     tapped twice on the first while the second taps Go too: each device sends one
//                     `thread.respond`, both cards close, and exactly one child starts (one new
//                     thread in the store, one subagent row for the brief).
//   brief-go-back     Send back opens a notes field; it sends one `revise` with the notes, starts
//                     no child, and the parent reads the notes once.
//   brief-go-unbound  a brief naming `@reviewer`, a role the brain's table does not bind: Go is
//                     blocked with "no role named @reviewer" and a link to the role table (44 px
//                     targets at 390); a tap on Go sends nothing; the link opens the settings page
//                     with the role table; back on the thread, Decline with a reason settles it.
//
// Broken controls, each planted in the page by this judge (never in the app), each of which must
// make the check it names fail:
//   slot     the composer stays drawn under the card on the phone (card-approval at 390);
//   double   every `thread.respond` frame is sent twice (card-approval, card-question, brief-go,
//            brief-go-back);
//   advance  the 200 ms pause fires at once (card-question);
//   undo     the 3 s undo window fires at once (card-question);
//   nocheck  every `roles.check` frame is dropped, so no role is ever checked (brief-go,
//            brief-go-unbound).
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
import type { CairnApp } from "./fixtures/parity/CairnApp.ts";
import {
  BOUND_ROLE,
  BRIEF_ROLES,
  briefBrain,
  UNBOUND_ROLE,
} from "./fixtures/surfaces/BriefBrain.ts";
import { cardBrain } from "./fixtures/surfaces/CardBrain.ts";

const BROKEN_CONTROLS = [
  "slot",
  "double",
  "advance",
  "undo",
  "nocheck",
] as const;

type Broken = (typeof BROKEN_CONTROLS)[number] | "";

const isBroken = (value: string): value is Broken =>
  value === "" || BROKEN_CONTROLS.some((control) => control === value);

const { values } = parseArgs({
  options: {
    only: { type: "string", default: "" },
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

const only = new Set(values.only.split(",").filter((name) => name !== ""));

const wanted = (name: string) => only.size === 0 || only.has(name);

const widths = values.width.split(",").map(Number);

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

/** Saves what every page of a failed check shows, beside the report. */
const keepScreens = async (
  check: string,
  width: number,
  contexts: ReadonlyArray<BrowserContext>
) => {
  mkdirSync(values.out, { recursive: true });

  for (const [index, page] of contexts
    .flatMap((context) => context.pages())
    .entries()) {
    await page
      .screenshot({
        path: path.join(values.out, `${check}-${width}-${index}.png`),
      })
      .catch(() => null);
  }
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

// The emulated soft keyboard (as judges/behaviour.ts's soft-keyboard check): a visual viewport the
// judge shrinks by 320 px with an event, as iOS does when the keyboard opens.
const softKeyboard = () => {
  const target = new EventTarget();

  const fake = Object.assign(target, {
    width: innerWidth,
    height: innerHeight,
    offsetTop: 0,
    offsetLeft: 0,
    pageTop: 0,
    pageLeft: 0,
    scale: 1,
    onresize: null,
    onscroll: null,
  });

  Object.defineProperty(globalThis, "visualViewport", {
    configurable: true,
    get: () => fake,
  });
  globalThis.addEventListener("cairn-judge-keyboard", () => {
    fake.height = innerHeight - 320;
    target.dispatchEvent(new Event("resize"));
  });
};

// The plants. Each runs before the app's own scripts.
const plantSlot = () => {
  const style = document.createElement("style");

  style.textContent =
    "[data-chat-composer-docked] { display: block !important; }";
  document.addEventListener("DOMContentLoaded", () => {
    document.head.append(style);
  });
};

// Sends every `thread.respond` frame twice. Page code, kept as text: it patches the browser's own
// WebSocket, which this module's types cannot describe without casts.
const PLANT_DOUBLE = `
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    send.call(this, data);
    if (String(data).includes("thread.respond")) send.call(this, data);
  };
`;

// Drops every `roles.check` frame, so the card never hears what a role resolves to.
const PLANT_NOCHECK = `
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (!String(data).includes("roles.check")) send.call(this, data);
  };
`;

// Makes a sleep of \`delay\` ms fire at once: the app's sleeps go through \`setTimeout\`.
const plantTimeout = (delay: number) => `
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (handler, timeout, ...rest) =>
    original(handler, timeout === ${delay} ? 0 : timeout, ...rest);
`;

const ADVANCE_MS = 200;

const UNDO_MS = 3000;

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

  await context.addInitScript(softKeyboard);

  if (broken === "slot") {
    await context.addInitScript(plantSlot);
  }

  if (broken === "double") {
    await context.addInitScript({ content: PLANT_DOUBLE });
  }

  if (broken === "advance") {
    await context.addInitScript({ content: plantTimeout(ADVANCE_MS) });
  }

  if (broken === "nocheck") {
    await context.addInitScript({ content: PLANT_NOCHECK });
  }

  if (broken === "undo") {
    await context.addInitScript({ content: plantTimeout(UNDO_MS) });
  }

  return context;
};

const editor = (page: Page) =>
  page.locator('[data-testid="composer-editor"]').first();

/** A page and the `thread.respond` and `roles.check` frames it sent, with the time each left. */
interface Device {
  readonly page: Page;
  readonly responds: Array<number>;
  readonly checks: Array<number>;
}

const openThread = async (
  context: BrowserContext,
  url: string
): Promise<Device> => {
  const page = await context.newPage();
  const responds: Array<number> = [];
  const checks: Array<number> = [];

  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (String(payload).includes("thread.respond")) {
        responds.push(Date.now());
      }

      if (String(payload).includes("roles.check")) {
        checks.push(Date.now());
      }
    });
  });

  await page.goto(url, { waitUntil: "networkidle" });
  await page
    .locator('#root[data-ui="next"]')
    .waitFor({ state: "attached", timeout: 15_000 });
  // Attached, not visible: on the phone a pending request hides the composer.
  await editor(page).waitFor({ state: "attached", timeout: 15_000 });

  return { page, responds, checks };
};

const card = (page: Page) => page.locator('[data-testid="request-card"]');

const action = (page: Page, name: string) =>
  card(page).locator(`[data-action="${name}"]`);

/** Clicks the card's `name` control at once, in the page, without waiting for it. */
const clickNow = async (page: Page, name: string) => {
  await page.evaluate((selector) => {
    document.querySelector<HTMLElement>(selector)?.click();
  }, `[data-testid="request-card"] [data-action="${name}"]`);
};

const toolSaid = (page: Page) =>
  page.locator('[data-message-role="assistant"]', { hasText: "Tool said:" });

const send = async (page: Page, words: string) => {
  await editor(page).fill(words);
  await page.locator('[data-testid="composer-send"]').first().click();
};

const settle = async (millis: number) => {
  await sleep(millis);
};

/** Waits until `count` reads `expected`, up to `timeout` ms; returns the last reading. */
const waitForCount = async (
  count: () => Promise<number>,
  expected: number,
  timeout: number
): Promise<number> => {
  const until = Date.now() + timeout;
  let seen = await count();

  while (seen !== expected && Date.now() < until) {
    await settle(100);
    seen = await count();
  }

  return seen;
};

interface SlotGeometry {
  readonly composerVisible: boolean;
  readonly cardTop: number;
  readonly cardBottom: number;
  readonly cardLeft: number;
  readonly cardRight: number;
  readonly composerTop: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly scrollWidth: number;
  readonly smallTargets: ReadonlyArray<string>;
}

const slotGeometry = async (page: Page): Promise<SlotGeometry> =>
  await page.evaluate(() => {
    const cardBox = document
      .querySelector('[data-testid="request-card"]')
      ?.getBoundingClientRect();

    const composer = document.querySelector("[data-chat-composer-docked]");
    const composerBox = composer?.getBoundingClientRect();

    const smallTargets = [
      ...document.querySelectorAll(
        '[data-testid="request-card"] [data-action]'
      ),
    ].flatMap((element) => {
      const box = element.getBoundingClientRect();

      return box.width < 44 || box.height < 44
        ? [
            `${element instanceof HTMLElement ? (element.dataset.action ?? "?") : "?"} ${Math.round(box.width)}x${Math.round(box.height)}`,
          ]
        : [];
    });

    return {
      composerVisible:
        composerBox !== undefined &&
        composerBox.width > 0 &&
        composerBox.height > 0,
      cardTop: cardBox?.top ?? Number.NaN,
      cardBottom: cardBox?.bottom ?? Number.NaN,
      cardLeft: cardBox?.left ?? Number.NaN,
      cardRight: cardBox?.right ?? Number.NaN,
      composerTop: composerBox?.top ?? Number.NaN,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      smallTargets,
    };
  });

const checkSlot = (width: number, geometry: SlotGeometry) => {
  expect(
    geometry.scrollWidth <= geometry.viewportWidth,
    `the page scrolls sideways (${geometry.scrollWidth} > ${geometry.viewportWidth})`
  );
  expect(
    geometry.cardLeft >= 0 &&
      geometry.cardRight <= geometry.viewportWidth + 0.5 &&
      geometry.cardBottom <= geometry.viewportHeight + 0.5,
    `the card leaves the screen (${Math.round(geometry.cardLeft)} to ${Math.round(geometry.cardRight)}, bottom ${Math.round(geometry.cardBottom)})`
  );

  if (width < 640) {
    expect(
      !geometry.composerVisible,
      "the composer is drawn under the card on the phone"
    );
    expect(
      geometry.smallTargets.length === 0,
      `controls under 44 px: ${geometry.smallTargets.join(", ")}`
    );
  } else {
    expect(geometry.composerVisible, "the composer is hidden at 1,440 px");
    expect(
      geometry.cardBottom <= geometry.composerTop + 1,
      `the card is not above the composer (card bottom ${Math.round(geometry.cardBottom)}, composer top ${Math.round(geometry.composerTop)})`
    );
  }
};

const cardApproval = async (browser: Browser, url: string, width: number) => {
  const contextA = await newDevice(browser, width);
  const contextB = await newDevice(browser, width);

  try {
    const a = await openThread(contextA, url);
    const said = await toolSaid(a.page).count();

    // One approval, answered once.
    await send(a.page, `open the gate (${width})`);
    await card(a.page).waitFor({ state: "visible", timeout: 15_000 });
    expect(
      (await card(a.page).getAttribute("data-request-kind")) === "tool-call",
      "the card is not a tool-call approval"
    );
    const title = (await card(a.page).locator("h3").textContent()) ?? "";

    expect(title.includes("gate"), "the card's title does not name the tool");
    expect(
      (await card(a.page)
        .locator('[data-testid="request-card-detail"]')
        .textContent()) === "Open the gate",
      "the card does not show the call's detail"
    );

    const geometry = await slotGeometry(a.page);

    checkSlot(width, geometry);

    const before = a.responds.length;

    await action(a.page, "approve").click();
    await card(a.page).waitFor({ state: "hidden", timeout: 10_000 });

    const accepted = await waitForCount(
      async () => await toolSaid(a.page).count(),
      said + 1,
      10_000
    );

    await settle(800);
    expect(
      a.responds.length - before === 1,
      `Approve sent ${a.responds.length - before} thread.respond frames`
    );
    expect(
      accepted === said + 1 && (await toolSaid(a.page).count()) === said + 1,
      `the model read ${(await toolSaid(a.page).count()) - said} answers`
    );
    const first = (await toolSaid(a.page).last().textContent()) ?? "";

    expect(
      first.includes("Tool said: accepted"),
      "the model did not read accepted"
    );

    // A second request: it survives a reload, then two devices answer it at once.
    await send(a.page, `open the gate again (${width})`);
    await card(a.page).waitFor({ state: "visible", timeout: 15_000 });
    await a.page.reload({ waitUntil: "networkidle" });
    await card(a.page).waitFor({ state: "visible", timeout: 15_000 });

    const b = await openThread(contextB, url);

    await card(b.page).waitFor({ state: "visible", timeout: 15_000 });
    await action(b.page, "decline").click();
    await card(b.page).locator("textarea").fill("not now");

    const sentA = a.responds.length;
    const sentB = b.responds.length;

    // Both clicks land before either answer comes back: a click through Playwright would wait
    // for a button the other device's answer already took away.
    await action(a.page, "approve").waitFor({ state: "visible" });
    await action(b.page, "confirm-decline").waitFor({ state: "visible" });
    await Promise.all([
      clickNow(a.page, "approve"),
      clickNow(b.page, "confirm-decline"),
    ]);
    await card(a.page).waitFor({ state: "hidden", timeout: 10_000 });
    await card(b.page).waitFor({ state: "hidden", timeout: 10_000 });

    const settled = await waitForCount(
      async () => await toolSaid(a.page).count(),
      said + 2,
      10_000
    );

    await settle(1500);

    const final = (await toolSaid(a.page).last().textContent()) ?? "";
    const declined = final.includes("Tool said: declined: not now");

    expect(
      settled === said + 2 && (await toolSaid(a.page).count()) === said + 2,
      `two devices answering made ${(await toolSaid(a.page).count()) - said - 1} answers reach the model`
    );
    expect(
      declined || final.includes("Tool said: accepted"),
      `the model read ${JSON.stringify(final)}`
    );
    expect(
      a.responds.length - sentA === 1 && b.responds.length - sentB === 1,
      `the devices sent ${a.responds.length - sentA} and ${b.responds.length - sentB} thread.respond frames`
    );

    const loser = declined ? a.page : b.page;
    const line = declined ? "Declined: not now" : "Approved by you";

    const closed =
      (await loser
        .locator('[data-testid="request-card-closed"]')
        .textContent()) ?? "";

    expect(
      closed.includes(line),
      `the device that lost shows ${JSON.stringify(closed)}, not ${line}`
    );

    record(
      "card-approval",
      width,
      true,
      `approve 1 frame, model read accepted once; reload kept the card; race won by ${declined ? "Decline" : "Approve"}, loser shows "${line}"`
    );
  } catch (error) {
    await keepScreens("card-approval", width, [contextA, contextB]);
    record(
      "card-approval",
      width,
      false,
      error instanceof CheckFailedError
        ? error.message
        : (String(error).split("\n")[0] ?? "failed")
    );
  } finally {
    await contextA.close();
    await contextB.close();
  }
};

/**
 * Times the pick and the advance in the page, from the first key or tap after it is armed. The
 * stamps are kept on the root element's dataset, which `advanceStamps` reads back.
 */
const armAdvanceTimer = async (page: Page) => {
  await page.evaluate(() => {
    const stamps = document.documentElement.dataset;

    const start = () => {
      stamps.judgeStart ??= String(performance.now());
    };

    document.addEventListener("keydown", start, { capture: true });
    document.addEventListener("pointerdown", start, { capture: true });

    const watch = () => {
      if (
        stamps.judgePicked === undefined &&
        document.querySelector(
          '[data-option-index="2"][aria-pressed="true"]'
        ) !== null
      ) {
        stamps.judgePicked = String(performance.now());
      }

      if (
        document.querySelector('[data-testid="request-card-header"]')
          ?.textContent === "Name"
      ) {
        stamps.judgeAdvanced = String(performance.now());

        return;
      }

      requestAnimationFrame(watch);
    };

    requestAnimationFrame(watch);
  });
};

/** The stamps `armAdvanceTimer` took, in ms on the page's clock; NaN for one not taken. */
const advanceStamps = async (page: Page) =>
  await page.evaluate(() => {
    const stamps = document.documentElement.dataset;

    return {
      start: Number(stamps.judgeStart),
      picked: Number(stamps.judgePicked),
      advanced: Number(stamps.judgeAdvanced),
    };
  });

const cardQuestion = async (browser: Browser, url: string, width: number) => {
  const context = await newDevice(browser, width);

  try {
    const device = await openThread(context, url);
    const { page } = device;
    const said = await toolSaid(page).count();

    await send(page, `ask me (${width})`);
    await card(page).waitFor({ state: "visible", timeout: 15_000 });
    expect(
      (await card(page).getAttribute("data-request-kind")) === "user-input",
      "the card is not a question"
    );

    const header = card(page).locator('[data-testid="request-card-header"]');

    expect(
      (await header.textContent()) === "Database",
      "the first question is not shown first"
    );
    expect(
      (await card(page)
        .locator('[data-testid="request-card-question-position"]')
        .textContent()) === "1/2",
      "the card does not say 1/2"
    );

    // A pick marks at once and advances after the pause.
    await armAdvanceTimer(page);

    if (width < 640) {
      await card(page).locator('[data-option-index="2"]').tap();
    } else {
      await card(page).locator('[data-testid="request-card-options"]').focus();
      await page.keyboard.press("2");
    }

    await header.filter({ hasText: "Name" }).waitFor({ timeout: 5000 });

    const stamps = await advanceStamps(page);
    const advanceMs = stamps.advanced - stamps.start;

    expect(
      stamps.picked < stamps.advanced,
      "the pick was not marked before the card moved"
    );
    expect(
      advanceMs >= 150 && advanceMs <= 1500,
      `the card moved ${Math.round(advanceMs)} ms after the pick`
    );

    // The user's own words, typed with the soft keyboard open on the phone.
    const field = card(page).locator('input[type="text"]');

    if (width < 640) {
      await page.evaluate(() => {
        globalThis.dispatchEvent(new CustomEvent("cairn-judge-keyboard"));
      });
      await field.tap();
    } else {
      await field.click();
    }

    await page.keyboard.type("kestrel wren");
    await settle(300);
    expect(
      (await field.inputValue()) === "kestrel wren",
      `the field holds ${JSON.stringify(await field.inputValue())}`
    );
    expect(
      await field.evaluate((element) => element === document.activeElement),
      "the field lost focus while typing"
    );

    if (width < 640) {
      const typing = await slotGeometry(page);

      expect(
        !typing.composerVisible,
        "the composer came back under the card with the keyboard open"
      );
    }

    // Send, then Undo: nothing is sent.
    const before = device.responds.length;

    await action(page, "send").click();
    await card(page)
      .locator('[data-testid="request-card-undo"]')
      .waitFor({ state: "visible", timeout: 2000 });
    await action(page, "undo").click();
    await settle(UNDO_MS + 500);
    expect(
      device.responds.length === before,
      `Undo still sent ${device.responds.length - before} thread.respond frames`
    );
    expect(await card(page).isVisible(), "the card closed after Undo");

    // Send again: one answer after the window, and the model reads both answers.
    const sentAt = Date.now();

    await action(page, "send").click();
    await card(page).waitFor({ state: "hidden", timeout: UNDO_MS + 5000 });

    const reached = await waitForCount(
      async () => await toolSaid(page).count(),
      said + 1,
      10_000
    );

    await settle(800);

    const windowMs = (device.responds[before] ?? Number.NaN) - sentAt;

    expect(
      device.responds.length - before === 1,
      `Send sent ${device.responds.length - before} thread.respond frames`
    );
    expect(
      windowMs >= UNDO_MS - 200,
      `the answer left ${Math.round(windowMs)} ms after Send`
    );

    const answer = (await toolSaid(page).last().textContent()) ?? "";

    expect(
      reached === said + 1 &&
        answer.includes("Database: SQLite") &&
        answer.includes("Name: kestrel wren"),
      `the model read ${JSON.stringify(answer)}`
    );

    // A second question, declined with a reason: the way out when no option fits, on the phone
    // too, where the composer (and its Stop) is hidden while the card shows.
    await send(page, `ask me again (${width})`);
    await card(page).waitFor({ state: "visible", timeout: 15_000 });

    const beforeDecline = device.responds.length;

    await action(page, "decline").click();
    // The reason names the width: both widths answer on one thread, whose older lines the
    // transcript may no longer draw, so the judge looks for this run's own line, not a count.
    const reason = `none of these (${width})`;

    await card(page).locator("textarea").fill(reason);
    await action(page, "confirm-decline").click();
    await card(page).waitFor({ state: "hidden", timeout: 10_000 });

    const declinedLine = toolSaid(page).filter({
      hasText: `The user declined to answer: ${reason}`,
    });

    const declinedRead = await declinedLine
      .first()
      .waitFor({ timeout: 10_000 })
      .then(
        () => true,
        () => false
      );

    await settle(800);

    expect(
      device.responds.length - beforeDecline === 1,
      `Decline sent ${device.responds.length - beforeDecline} thread.respond frames`
    );
    expect(
      declinedRead && (await declinedLine.count()) === 1,
      `after Decline the model read ${JSON.stringify((await toolSaid(page).last().textContent()) ?? "")}`
    );

    record(
      "card-question",
      width,
      true,
      `advanced ${Math.round(advanceMs)} ms after the pick; own words kept; Undo sent nothing; Send left after ${Math.round(windowMs)} ms, 1 frame; model read both answers; Decline sent 1 frame with its reason`
    );
  } catch (error) {
    await keepScreens("card-question", width, [context]);
    record(
      "card-question",
      width,
      false,
      error instanceof CheckFailedError
        ? error.message
        : (String(error).split("\n")[0] ?? "failed")
    );
  } finally {
    await context.close();
  }
};

// The brief checks (6B).

/** Whether the card's `name` control takes a click: drawn, and neither disabled nor busy. */
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

/** Waits until the card's `name` control takes a click; false when it never did. */
const waitLive = async (
  page: Page,
  name: string,
  timeout: number
): Promise<boolean> => {
  const until = Date.now() + timeout;

  while (Date.now() < until) {
    if (await isLive(page, name)) {
      return true;
    }

    await settle(100);
  }

  return false;
};

/** The card's body text, its label and value lines run together. */
const cardLines = async (page: Page): Promise<string> =>
  (await card(page).locator("dl").textContent()) ?? "";

const parentRead = (page: Page, words: string) =>
  page.locator('[data-message-role="assistant"]', {
    hasText: `Parent read: ${words}`,
  });

/** Sends the parent "brief <role> <tag>" and waits for its brief on the card. */
const proposeBrief = async (page: Page, role: string, tag: string) => {
  await send(page, `brief ${role} ${tag}`);
  await card(page)
    .filter({ hasText: `Count the files ${tag}` })
    .waitFor({ state: "visible", timeout: 15_000 });
  expect(
    (await card(page).getAttribute("data-request-body")) === "Brief",
    "the card is not a brief"
  );
};

const briefGo = async (
  browser: Browser,
  app: CairnApp,
  url: string,
  width: number
) => {
  const contextA = await newDevice(browser, width);
  const contextB = await newDevice(browser, width);
  const tag = `go-${width}`;

  try {
    const a = await openThread(contextA, url);

    await proposeBrief(a.page, BOUND_ROLE, tag);

    // The brief's words and what its role runs on, checked as it showed.
    expect(
      await waitLive(a.page, "go", 10_000),
      `Go never took a click (the card says ${JSON.stringify(await cardLines(a.page))})`
    );

    const lines = await cardLines(a.page);

    expect(
      lines.includes("DoCount the TypeScript files under src") &&
        lines.includes(`Runs on${BOUND_ROLE}: faux/scripted at medium`),
      `the card says ${JSON.stringify(lines)}`
    );
    expect(
      (await action(a.page, "send-back").count()) === 1 &&
        (await action(a.page, "decline").count()) === 1,
      "the card has no Send back or no Decline"
    );
    checkSlot(width, await slotGeometry(a.page));

    // The brain restarts while the card waits.
    const threadsBefore = app.threadCount();
    const checksBefore = a.checks.length;

    await app.restartBrain();

    const rechecked = await waitForCount(
      async () =>
        await Promise.resolve(Math.min(a.checks.length - checksBefore, 1)),
      1,
      20_000
    );

    expect(
      rechecked === 1,
      "the card did not check the role again after the brain restarted"
    );
    expect(
      await waitLive(a.page, "go", 15_000),
      "Go never took a click again after the restart"
    );
    const kept = (await card(a.page).textContent()) ?? "";

    expect(
      kept.includes(`Count the files ${tag}`),
      "the card lost the brief across the restart"
    );

    // A second device, then Go twice on the first while the second taps Go too.
    const b = await openThread(contextB, url);

    expect(
      await waitLive(b.page, "go", 15_000),
      "Go never took a click on the second device"
    );

    const sentA = a.responds.length;
    const sentB = b.responds.length;

    await Promise.all([
      clickNow(a.page, "go").then(async () => {
        await clickNow(a.page, "go");
      }),
      clickNow(b.page, "go"),
    ]);
    await card(a.page)
      .filter({ hasText: `Count the files ${tag}` })
      .waitFor({ state: "hidden", timeout: 10_000 });
    await card(b.page)
      .filter({ hasText: `Count the files ${tag}` })
      .waitFor({ state: "hidden", timeout: 10_000 });

    const threads = await waitForCount(
      async () => await Promise.resolve(app.threadCount() - threadsBefore),
      1,
      10_000
    );

    // Long enough for a second start, or a second answer, to show if there were one.
    await settle(2000);

    expect(
      a.responds.length - sentA === 1 && b.responds.length - sentB === 1,
      `the devices sent ${a.responds.length - sentA} and ${b.responds.length - sentB} thread.respond frames`
    );
    expect(
      threads === 1 && app.threadCount() - threadsBefore === 1,
      `Go started ${app.threadCount() - threadsBefore} children`
    );

    const row = a.page.locator('[data-testid="subagent-row"]', {
      hasText: `Count the files ${tag}`,
    });

    await row.first().waitFor({ state: "attached", timeout: 10_000 });
    expect(
      (await row.count()) === 1 &&
        (await row.first().getAttribute("data-child-thread-id")) !== null,
      `the transcript shows ${await row.count()} rows for the brief`
    );

    record(
      "brief-go",
      width,
      true,
      `words and runs-on shown; restart: card kept, role checked again; Go twice and a second device's Go sent 1 and 1 frames; 1 child started`
    );
  } catch (error) {
    await keepScreens("brief-go", width, [contextA, contextB]);
    record(
      "brief-go",
      width,
      false,
      error instanceof CheckFailedError
        ? error.message
        : (String(error).split("\n")[0] ?? "failed")
    );
  } finally {
    await contextA.close();
    await contextB.close();
  }
};

const briefBack = async (
  browser: Browser,
  app: CairnApp,
  url: string,
  width: number
) => {
  const context = await newDevice(browser, width);
  const tag = `back-${width}`;

  try {
    const device = await openThread(context, url);
    const { page } = device;

    await proposeBrief(page, BOUND_ROLE, tag);

    const threadsBefore = app.threadCount();
    const before = device.responds.length;
    const notes = `only src/next, not the tests (${width})`;

    await action(page, "send-back").click();

    const field = card(page).locator("textarea");

    await field.waitFor({ state: "visible", timeout: 5000 });
    expect(
      !(await isLive(page, "confirm-send-back")),
      "Send back took a click with no notes"
    );
    await field.fill(notes);
    await action(page, "confirm-send-back").click();
    await card(page)
      .filter({ hasText: `Count the files ${tag}` })
      .waitFor({ state: "hidden", timeout: 10_000 });

    const read = parentRead(page, "").filter({ hasText: notes });

    const reached = await read
      .first()
      .waitFor({ timeout: 10_000 })
      .then(
        () => true,
        () => false
      );

    await settle(1500);

    expect(
      device.responds.length - before === 1,
      `Send back sent ${device.responds.length - before} thread.respond frames`
    );
    expect(
      reached && (await read.count()) === 1,
      `the parent read the notes ${await read.count()} times`
    );
    expect(
      app.threadCount() === threadsBefore,
      `Send back started ${app.threadCount() - threadsBefore} children`
    );

    record(
      "brief-go-back",
      width,
      true,
      "notes required; Send back sent 1 frame; the parent read the notes once; no child"
    );
  } catch (error) {
    await keepScreens("brief-go-back", width, [context]);
    record(
      "brief-go-back",
      width,
      false,
      error instanceof CheckFailedError
        ? error.message
        : (String(error).split("\n")[0] ?? "failed")
    );
  } finally {
    await context.close();
  }
};

const briefUnbound = async (
  browser: Browser,
  app: CairnApp,
  url: string,
  width: number
) => {
  const context = await newDevice(browser, width);
  const tag = `unbound-${width}`;

  try {
    const device = await openThread(context, url);
    const { page } = device;

    await proposeBrief(page, UNBOUND_ROLE, tag);

    const blocked = card(page).locator(
      '[data-testid="request-card-go-blocked"]'
    );

    await blocked.waitFor({ state: "visible", timeout: 10_000 });

    const reason = (await blocked.textContent()) ?? "";

    expect(
      reason.includes(`no role named ${UNBOUND_ROLE} is in the role table`),
      `the card says ${JSON.stringify(reason)}`
    );
    expect(!(await isLive(page, "go")), "Go takes a click on an unbound role");
    checkSlot(width, await slotGeometry(page));

    const threadsBefore = app.threadCount();
    const before = device.responds.length;

    await clickNow(page, "go");
    await settle(1000);
    expect(
      device.responds.length === before && app.threadCount() === threadsBefore,
      `a tap on the blocked Go sent ${device.responds.length - before} frames`
    );

    // The way to the role table, and back.
    await action(page, "role-table").click();
    await page.waitForURL((found) => found.pathname === "/settings", {
      timeout: 10_000,
    });
    await page
      .locator('[data-testid="settings-roles"]')
      .waitFor({ state: "visible", timeout: 10_000 });

    await page.goBack();
    await card(page)
      .filter({ hasText: `Count the files ${tag}` })
      .waitFor({ state: "visible", timeout: 15_000 });

    // Decline with a reason settles it, so the next check starts from an empty card.
    await action(page, "decline").click();
    await card(page).locator("textarea").fill("no reviewer role yet");
    await action(page, "confirm-decline").click();
    await card(page)
      .filter({ hasText: `Count the files ${tag}` })
      .waitFor({ state: "hidden", timeout: 10_000 });

    record(
      "brief-go-unbound",
      width,
      true,
      `blocked: ${JSON.stringify(reason)}; a tap on Go sent nothing; the role table opened; Decline settled it`
    );
  } catch (error) {
    await keepScreens("brief-go-unbound", width, [context]);
    record(
      "brief-go-unbound",
      width,
      false,
      error instanceof CheckFailedError
        ? error.message
        : (String(error).split("\n")[0] ?? "failed")
    );
  } finally {
    await context.close();
  }
};

const nextUrl = (app: CairnApp): string => {
  const url = new URL(app.threadUrl);

  url.searchParams.set("ui", "next");

  return url.href;
};

const CARD_CHECKS = ["card-approval", "card-question"];

const BRIEF_CHECKS = ["brief-go", "brief-go-back", "brief-go-unbound"];

const browser = await chromium.launch();

try {
  if (CARD_CHECKS.some(wanted)) {
    const app = await startCairn(
      { projectTitle: "Card judge", threadTitle: "Request card", entries: [] },
      { brain: cardBrain }
    );

    try {
      for (const width of widths) {
        if (wanted("card-approval")) {
          await cardApproval(browser, nextUrl(app), width);
        }

        if (wanted("card-question")) {
          await cardQuestion(browser, nextUrl(app), width);
        }
      }
    } finally {
      await app.stop();
    }
  }

  // Its own brain, since `brief-go` restarts it.
  if (BRIEF_CHECKS.some(wanted)) {
    const app = await startCairn(
      { projectTitle: "Brief judge", threadTitle: "Brief card", entries: [] },
      { brain: briefBrain, roles: BRIEF_ROLES }
    );

    try {
      for (const width of widths) {
        if (wanted("brief-go")) {
          await briefGo(browser, app, nextUrl(app), width);
        }

        if (wanted("brief-go-back")) {
          await briefBack(browser, app, nextUrl(app), width);
        }

        if (wanted("brief-go-unbound")) {
          await briefUnbound(browser, app, nextUrl(app), width);
        }
      }
    } finally {
      await app.stop();
    }
  }
} finally {
  await browser.close();
}

const passing = results.filter((result) => result.pass).length;

mkdirSync(values.out, { recursive: true });

writeFileSync(
  path.join(
    values.out,
    broken === "" ? "surfaces.json" : `surfaces-broken-${broken}.json`
  ),
  `${JSON.stringify({ judge: "surfaces", broken, passing, checks: results.length, results }, null, 2)}\n`
);

console.log(
  JSON.stringify({
    judge: "surfaces",
    broken,
    checks: results.length,
    passing,
    failing: results.flatMap((result) =>
      result.pass ? [] : [`${result.check}@${result.width}`]
    ),
  })
);

process.exit(results.length > 0 && passing === results.length ? 0 : 1);
