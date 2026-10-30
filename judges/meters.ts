/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one check after another, on purpose */
// The meters judge (plan wave 6, 6G; surfaces note S9, models note M10): behaviour scripts played
// in the real web client on the `next` views (`?ui=next`) over a real in-process brain on the
// scripted harness (judges/fixtures/meters/MetersApp.ts, seeded with spend, budgets, plan windows
// and the deployed role table, each with a known truth), at 390 px as a phone (touch, coarse
// pointer) and at 1,440 px. Each check prints one line; the run ends with one JSON line. No model
// provider is called.
//
//   node judges/meters.ts [--only meters,roles] [--width 390,1440] [--broken zero|no-save]
//                         [--out <dir>]
//
// Checks:
//   meters  the usage page shows the seeded truth, and nothing unknown as zero: the roll-up's
//           dollars with the unpriced tokens beside them; the model with no list price reads
//           "No price", never a dollar figure; the thread that spent only unpriced tokens shows
//           no dollar sign; a plan's figure says "at API list price" and a metered one "billed";
//           the Claude session window reads 42%, the weekly window reads Unknown with no value on
//           its meter, the spent Opus window reads Limited; Codex, with no login, says there is no
//           Codex subscription and shows no percentage; OpenCode Go says it has no readable
//           windows; the two budgets read past their warning line and reached, and the thread
//           without one is not listed; the default budget reads "No limit" where it sets none.
//           Every reading marked unknown is free of "0%" and "$0.00", and every meter without a
//           value reads Unknown. No sideways scroll at either width.
//   roles   the role table shows `@verifier` bound to Codex with no ready model and says why; a
//           pick of `opencode-go/gpt-6-luna` sends exactly one `settings.update`, the row reads
//           Ready on the new binding, and after a reload of the page the binding, the select and
//           the status are the same (it persisted in the brain). At 390 every select is at least
//           44 px tall and the page does not scroll sideways.
//
// Broken controls, each planted in the page by this judge (never in the app), each of which must
// make the check it names fail:
//   zero     every frame from the brain loses its unknowns on the way in: a null plan-window
//            share and a null list price become 0, and an unpriced model is called metered
//            (meters);
//   no-save  every `settings.update` frame is dropped before it leaves the page (roles).
// Exits 0 when every check passed; a broken control's run exits 1 when it failed rightly, and the
// JSON line names the failing checks.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import {
  BRIDGE_THREAD,
  LUNA_THREAD,
  startMeters,
  UNPRICED_MODEL,
  UNPRICED_THREAD,
} from "./fixtures/meters/MetersApp.ts";

const BROKEN_CONTROLS = ["zero", "no-save"] as const;

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
        "Developer/agent-artifacts/cairn/v2/phase-2-surfaces/meters"
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

/** A failed expectation inside a check, with what was seen. */
class CheckFailedError extends Error {
  override name = "CheckFailedError";
}

const expect = (condition: boolean, what: string) => {
  if (!condition) {
    throw new CheckFailedError(what);
  }
};

// The plants. Page code, kept as text: they patch the browser's own WebSocket and MessageEvent,
// which this module's types cannot describe without casts.

// Every text frame the page reads loses its unknowns: whatever listens, it reads `data` here.
const PLANT_ZERO = `
  const descriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
  Object.defineProperty(MessageEvent.prototype, "data", {
    configurable: true,
    get() {
      const raw = descriptor.get.call(this);
      return typeof raw === "string"
        ? raw
            .replaceAll('"used":null', '"used":0')
            .replaceAll('"listMicros":null', '"listMicros":0')
            .replaceAll('"basis":"unpriced"', '"basis":"metered"')
        : raw;
    },
  });
`;

// Drops every \`settings.update\` frame before it leaves the page.
const PLANT_NO_SAVE = `
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (String(data).includes("settings.update")) return;
    send.call(this, data);
  };
`;

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

  if (broken === "zero") {
    await context.addInitScript({ content: PLANT_ZERO });
  }

  if (broken === "no-save") {
    await context.addInitScript({ content: PLANT_NO_SAVE });
  }

  return context;
};

/** Waits until `ready` holds, up to `timeout` ms; returns whether it did. */
const waitUntil = async (
  ready: () => Promise<boolean>,
  timeout: number
): Promise<boolean> => {
  const until = Date.now() + timeout;

  while (Date.now() < until) {
    if (await ready()) {
      return true;
    }

    await sleep(100);
  }

  return await ready();
};

const openNext = async (page: Page, url: string, landmark: string) => {
  await page.goto(url, { waitUntil: "networkidle" });
  await page
    .locator('#root[data-ui="next"]')
    .waitFor({ state: "attached", timeout: 20_000 });
  await page.locator(landmark).waitFor({ state: "visible", timeout: 20_000 });
};

/** An element's words, with its runs of space folded. */
const words = (text: string | null): string =>
  (text ?? "").replaceAll(/\s+/gu, " ").trim();

/** One row of a list on the page: its data attributes and its words. */
interface Row {
  readonly data: Readonly<Record<string, string | undefined>>;
  readonly text: string;
  readonly valueNow: string | null;
  readonly reading: string;
}

/** Every element `selector` matches, read as a row. */
const rowsOf = async (
  page: Page,
  selector: string
): Promise<ReadonlyArray<Row>> => {
  const raw = await page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const data =
        element instanceof HTMLElement
          ? Object.fromEntries(Object.entries(element.dataset))
          : {};

      return {
        data,
        text: element.textContent,
        valueNow:
          element
            .querySelector('[role="meter"]')
            ?.getAttribute("aria-valuenow") ?? null,
        reading: element.querySelector("[data-reading]")?.textContent ?? "",
      };
    })
  );

  return raw.map((row) => ({
    data: row.data,
    text: words(row.text),
    valueNow: row.valueNow,
    reading: words(row.reading),
  }));
};

/** The row whose `key` data attribute is `value`. */
const rowWhere = (
  rows: ReadonlyArray<Row>,
  key: string,
  value: string
): Row | undefined => rows.find((row) => row.data[key] === value);

/** What the usage page shows, read once it has every section's answer. */
interface UsageFacts {
  readonly total: string;
  readonly models: ReadonlyArray<Row>;
  readonly threads: ReadonlyArray<Row>;
  readonly plans: ReadonlyArray<Row>;
  readonly windows: ReadonlyArray<Row>;
  readonly budgets: ReadonlyArray<Row>;
  readonly defaultBudget: string;
  readonly unknown: ReadonlyArray<Row>;
  readonly valuelessMeters: ReadonlyArray<string>;
  readonly sideways: boolean;
}

const usageFacts = async (page: Page): Promise<UsageFacts> => ({
  total: words(
    await page.locator('[data-testid="usage-spend-total"]').textContent()
  ),
  models: await rowsOf(page, '[data-testid="usage-model"]'),
  threads: await rowsOf(page, '[data-testid="usage-thread"]'),
  plans: await rowsOf(page, '[data-testid="usage-plan"]'),
  windows: await rowsOf(page, "[data-window]"),
  budgets: await rowsOf(page, '[data-testid="usage-budget-thread"]'),
  defaultBudget: words(
    await page.locator('[data-testid="usage-default-budget"]').textContent()
  ),
  unknown: await rowsOf(page, '[data-known="false"]'),
  valuelessMeters: await page
    .locator('[role="meter"]:not([aria-valuenow])')
    .evaluateAll((meters) =>
      meters.map((meter) => meter.getAttribute("aria-valuetext") ?? "")
    ),
  sideways: await page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="usage-page"]');

    return (
      document.documentElement.scrollWidth > window.innerWidth ||
      (scroller !== null && scroller.scrollWidth > scroller.clientWidth)
    );
  }),
});

/** Zero as a reading prints it. */
const ZERO = /(?:^|\D)0%|\$0\.00/u;

/** The ledger: the roll-up, each model's basis, and the thread with no priced token. */
const expectLedger = (facts: UsageFacts) => {
  expect(
    facts.total.includes("$1.35 at list price") &&
      facts.total.includes("60k tokens with no price"),
    `the roll-up reads "${facts.total}", not $1.35 plus 60k unpriced tokens`
  );

  const unpriced = rowWhere(facts.models, "model", UNPRICED_MODEL);

  expect(
    unpriced?.data.priced === "false" &&
      unpriced.text.includes("No price") &&
      !unpriced.text.includes("$"),
    `the model with no price reads "${unpriced?.text ?? "nothing"}"`
  );

  const opus = rowWhere(facts.models, "model", "claude-bridge/claude-opus-5-5");

  expect(
    opus?.text.includes("$1.00 at API list price") === true,
    `the bridge model reads "${opus?.text ?? "nothing"}"`
  );

  const metered = rowWhere(facts.models, "model", "openrouter/qwen3.8-flash");

  expect(
    metered?.text.includes("$0.10 billed") === true,
    `the metered model reads "${metered?.text ?? "nothing"}"`
  );

  const free = rowWhere(facts.threads, "threadId", UNPRICED_THREAD);

  expect(
    free?.text.includes("60k tokens") === true && !free.text.includes("$"),
    `the thread with only unpriced tokens reads "${free?.text ?? "nothing"}"`
  );
};

/** The Claude windows: one read, one unknown, one spent. */
const expectWindows = (facts: UsageFacts) => {
  const session = rowWhere(facts.windows, "window", "five_hour");

  expect(
    session?.reading.startsWith("42% used") === true &&
      session.valueNow === "42",
    `the session window reads "${session?.reading ?? "nothing"}"`
  );

  const weekly = rowWhere(facts.windows, "window", "seven_day");

  expect(
    weekly?.data.known === "false" &&
      weekly.reading === "Unknown" &&
      weekly.valueNow === null,
    `the unknown weekly window reads "${weekly?.reading ?? "nothing"}" (value ${weekly?.valueNow ?? "none"})`
  );

  const opus = rowWhere(facts.windows, "window", "seven_day_opus");

  expect(
    opus?.reading.startsWith("Limited") === true,
    `the spent Opus window reads "${opus?.reading ?? "nothing"}"`
  );
};

/** The plans Cairn cannot read: Codex with no login, OpenCode Go with no windows. */
const expectPlans = (facts: UsageFacts) => {
  const codex = rowWhere(facts.plans, "provider", "openai-codex");

  expect(
    codex?.data.planState === "absent" &&
      codex.text.includes("no Codex subscription") &&
      !codex.text.includes("%"),
    `Codex reads "${codex?.text ?? "nothing"}"`
  );

  const go = rowWhere(facts.plans, "provider", "opencode-go");

  expect(
    go?.data.planState === "unsupported",
    `OpenCode Go's plan reads ${go?.data.planState ?? "nothing"}`
  );
};

/** The budgets: one warned, one reached, the thread with none left out; the default's limits. */
const expectBudgets = (facts: UsageFacts) => {
  const state = (threadId: string) =>
    rowWhere(facts.budgets, "threadId", threadId)?.data.budget;

  expect(
    state(BRIDGE_THREAD) === "warned" &&
      state(LUNA_THREAD) === "exhausted" &&
      state(UNPRICED_THREAD) === undefined,
    `the budgets read ${facts.budgets.map((row) => `${row.data.threadId ?? ""} ${row.data.budget ?? ""}`).join(", ")}`
  );
  expect(
    facts.defaultBudget.includes("200k tokens") &&
      facts.defaultBudget.includes("No limit"),
    `the default budget reads "${facts.defaultBudget}"`
  );
};

/** Nothing unknown reads as zero, and the page does not scroll sideways. */
const expectNoZero = (facts: UsageFacts) => {
  const zeroes = facts.unknown.filter((row) => ZERO.test(row.text));

  expect(
    facts.unknown.length >= 4 && zeroes.length === 0,
    `${facts.unknown.length} unknown readings, ${zeroes.length} read as zero: ${zeroes.map((row) => row.text).join(" | ")}`
  );
  expect(
    facts.valuelessMeters.every((reading) => reading === "Unknown"),
    `a meter with no value reads ${facts.valuelessMeters.join(", ")}`
  );
  expect(!facts.sideways, "the usage page scrolls sideways");
};

/** The usage page has every section's answer. */
const usageReady = async (page: Page): Promise<boolean> => {
  const counts = await Promise.all(
    [
      '[data-testid="usage-spend-total"]',
      '[data-testid="usage-default-budget"]',
      '[data-provider="claude-bridge"][data-plan-state="read"]',
      '[data-testid="usage-budget-thread"]',
    ].map(async (selector) => await page.locator(selector).count())
  );

  return counts.every((count) => count > 0) && (counts[3] ?? 0) >= 2;
};

const checkMeters = async (page: Page, width: number, origin: string) => {
  await openNext(page, `${origin}/usage?ui=next`, '[data-testid="usage-page"]');

  expect(
    await waitUntil(async () => await usageReady(page), 20_000),
    "the usage page never showed every section's answer"
  );

  const facts = await usageFacts(page);

  await page.screenshot({ path: path.join(values.out, `meters-${width}.png`) });

  expectLedger(facts);
  expectWindows(facts);
  expectPlans(facts);
  expectBudgets(facts);
  expectNoZero(facts);

  return `${facts.unknown.length} unknown readings, none zero; ${facts.models.length} models, ${facts.budgets.length} budgets`;
};

const verifierRow = (page: Page) =>
  page.locator('[data-testid="role-row"][data-role="@verifier"]');

const roleFacts = async (page: Page) => ({
  binding: (await verifierRow(page).getAttribute("data-binding")) ?? "",
  status:
    (await verifierRow(page)
      .locator("[data-role-status]")
      .textContent()
      .catch(() => "")) ?? "",
  select: await page.locator("#role-model-verifier").inputValue(),
});

const LUNA = "opencode-go/gpt-6-luna";

const checkRoles = async (page: Page, width: number, origin: string) => {
  const updates: Array<number> = [];

  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (String(payload).includes("settings.update")) {
        updates.push(Date.now());
      }
    });
  });

  await openNext(
    page,
    `${origin}/settings?ui=next`,
    '[data-testid="settings-roles"]'
  );

  const statusOf = async () => {
    const facts = await roleFacts(page);

    return facts.status;
  };

  expect(
    await waitUntil(
      async () => (await statusOf()) === "No ready model",
      20_000
    ),
    `@verifier first reads "${await statusOf()}", not "No ready model"`
  );

  const before = await roleFacts(page);

  expect(
    before.binding === "openai-codex/gpt-6-luna",
    `@verifier starts bound to ${before.binding}`
  );

  const detail =
    (await verifierRow(page).locator("[data-role-detail]").textContent()) ?? "";

  expect(
    detail.includes("openai-codex/gpt-6-luna") &&
      /is not in the catalog|has no credential here/u.test(detail),
    `the row does not say why: "${detail}"`
  );

  if (width < 640) {
    const short = await page.evaluate(() =>
      [
        ...document.querySelectorAll('[data-testid="settings-roles"] select'),
      ].flatMap((select) => {
        const { height } = select.getBoundingClientRect();

        return height < 44 ? [height] : [];
      })
    );

    expect(short.length === 0, `selects under 44 px: ${short.join(", ")}`);
  }

  await verifierRow(page).scrollIntoViewIfNeeded();
  await page.locator("#role-model-verifier").selectOption(LUNA);

  const saved = await waitUntil(async () => {
    const now = await roleFacts(page);

    return now.binding === LUNA && now.status === "Ready";
  }, 10_000);

  const after = await roleFacts(page);

  expect(
    saved,
    `after the pick @verifier reads ${after.binding} "${after.status}"`
  );
  expect(
    updates.length === 1,
    `${updates.length} settings.update frames for one pick`
  );

  await page.reload({ waitUntil: "networkidle" });
  await page
    .locator('[data-testid="settings-roles"]')
    .waitFor({ state: "visible", timeout: 20_000 });

  const persisted = await waitUntil(async () => {
    const now = await roleFacts(page);

    return now.status === "Ready";
  }, 20_000);

  const reloaded = await roleFacts(page);

  await page
    .locator('[data-testid="settings-roles"]')
    .screenshot({ path: path.join(values.out, `roles-${width}.png`) });

  expect(
    persisted && reloaded.binding === LUNA && reloaded.select === LUNA,
    `after a reload @verifier reads ${reloaded.binding} (select ${reloaded.select}) "${reloaded.status}"`
  );

  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );

  expect(!sideways, "the settings page scrolls sideways");

  return `rebound to ${LUNA} with one settings.update; kept across a reload`;
};

const CHECKS: ReadonlyArray<
  readonly [
    string,
    (page: Page, width: number, origin: string) => Promise<string>,
  ]
> = [
  ["meters", checkMeters],
  ["roles", checkRoles],
];

mkdirSync(values.out, { recursive: true });

const browser = await chromium.launch();

try {
  for (const width of widths) {
    // A fresh brain per width: the roles check rebinds a role, and each width starts from the
    // deployed table.
    const app = await startMeters();

    try {
      for (const [name, run] of CHECKS) {
        if (!wanted(name)) {
          continue;
        }

        const context = await newDevice(browser, width);

        const page = await context.newPage();

        page.setDefaultTimeout(20_000);

        try {
          record(name, width, true, await run(page, width, app.origin));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);

          await page
            .screenshot({
              path: path.join(values.out, `${name}-${width}-failed.png`),
            })
            .catch(() => null);
          record(name, width, false, detail);
        } finally {
          await context.close();
        }
      }
    } finally {
      await app.stop();
    }
  }
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.pass);

console.log(
  JSON.stringify({
    judge: "meters",
    broken: broken === "" ? null : broken,
    passed: results.length - failed.length,
    total: results.length,
    failed: failed.map((result) => `${result.check}@${result.width}`),
  })
);

process.exit(failed.length === 0 ? 0 : 1);
