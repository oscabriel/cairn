/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one browser state after another, on purpose */
// The look tool (plan look track L5, ADR 0040): captures named states of the real `next` client,
// holds each to the look rules, publishes them as a round for the user, freezes a round the user
// approved, and checks today's client against the frozen round.
//
//   node judges/look.ts capture [--out <dir>] [--only <state,...>] [--strict] [--headed]
//   node judges/look.ts round <n> [--replace] [--only <state,...>] [--strict]
//   node judges/look.ts freeze <n> [--frozen <dir>]
//   node judges/look.ts check [--frozen <dir>] [--tokens-only] [--out <dir>]
//
// `capture` and `round` start the client the parity judges drive (judges/fixtures/parity/CairnApp.ts:
// AppLayer over the scripted harness, with Vite in front, seeded with t3code's imported thread),
// open every page with `?ui=next`, and take each state at 390 px (a phone: touch, coarse pointer)
// and 1,440 px in dark, and in light too where the state lists a light variant. Every page's
// clock is fixed (`FIXED_TIME`), motion is reduced and the caret hidden, so a state draws the same
// pixels each time. Each shot is the viewport, at device scale 2.
//
// The rules are judges/lib/LookRules.ts, run on each shot after its screenshot: touch (at 390),
// overflow and hscroll inside the next frame, tone where a toned element is drawn, and focus by
// Tab. They are findings about the views and go on the round's page; `--strict` makes any of them
// fail the run. The controls must fail as designed whatever the views look like: the thread state
// at 390 px in dark is entered again with four violations planted in real elements (the first
// button shrunk to 24 px, a line of text cut without an ellipsis, a focusable element's ring
// removed, a block 600 px wide in the page), and each plant must be caught by its rule.
//
// `round <n>` publishes to ~/Developer/agent-artifacts/cairn/v2/look/round-<n>/ (served at
// https://plans.gneiss.run/cairn/v2/look/round-<n>/): `index.html`, the screenshots under `shots/`,
// a copy of tokens.css and `report.json`. Rounds 0 and 1 were static mock pages, so it refuses
// rounds below 2, and refuses an existing round without `--replace`.
//
// `freeze <n>` is run on the user's approval of round <n>: it reads that round's `report.json`,
// checks every screenshot still hashes as reported and that today's tokens.css is the one the
// round drew, and writes judges/look/frozen/round-<n>.json (judges/lib/LookFreeze.ts). It refuses
// a round older than the newest frozen one.
//
// `check` judges today against the newest frozen round: tokens.css must hash as frozen (also held
// in `pnpm check` by judges/look.test.ts), and each frozen shot, taken again, must hash as frozen
// or stay within the allowance (LookFreeze's `ALLOWANCE`: no 16 px cell's rounded mean colour
// moves at all; its header gives the measured noise and the smallest changes it must catch). Its
// control re-takes the first frozen shot with `--ink-1` overridden in the page and must see it
// drift. With nothing frozen it passes and says so. `--tokens-only` skips the browser.
//
// Freezing on approval and checking ran end to end on 2026-10-29 against a scratch frozen folder
// (`--frozen`), never the checked-in one; the numbers are in the L5 commit.
//
// Prints one JSON line on stdout at the end (the Vite server's logging goes to stderr).

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { Effect, Schema } from "effect";
import { chromium } from "playwright";
import type { Browser, BrowserContextOptions, Page } from "playwright";

import {
  importT3Thread,
  parseT3ThreadExport,
} from "../apps/server/src/brain/conformance/fixtures/T3Import.ts";
import { SHELL_SEED, startCairn } from "./fixtures/parity/CairnApp.ts";
import type { CairnApp } from "./fixtures/parity/CairnApp.ts";
import {
  ALLOWANCE,
  CELL_CSS_PX,
  FrozenShot,
  LookTheme,
  LookWidth,
  decodePng,
  fingerprintOf,
  formatFrozenRound,
  newestRound,
  parseFrozenRound,
  sha256,
  shotName,
  shotVerdict,
  tokensFinding,
} from "./lib/LookFreeze.ts";
import type { FrozenRound, ShotVerdict } from "./lib/LookFreeze.ts";
import {
  HIT_TARGET_PX,
  OVERFLOW_TOLERANCE_PX,
  Violation,
  decodeChecked,
  decodeViolations,
  focusRule,
  hscrollRule,
  overflowRule,
  toneRule,
  touchRule,
} from "./lib/LookRules.ts";

const root = path.join(import.meta.dirname, "..");

const TOKENS_PATH = "apps/web/src/next/tokens.css";

const FROZEN_DIR = path.join(root, "judges/look/frozen");

const ROUNDS_DIR = path.join(
  homedir(),
  "Developer/agent-artifacts/cairn/v2/look"
);

const ROUNDS_URL = "https://plans.gneiss.run/cairn/v2/look";

/** The first round this tool publishes: rounds 0 and 1 were static mock pages. */
const FIRST_ROUND = 2;

/** Every page's clock: a fixed instant a few days after the seeded thread's last run. */
const FIXED_TIME = Date.parse("2026-10-20T09:00:00Z");

/** The device scale every shot is taken at. */
const SCALE = 2;

/** What the overflow and hscroll rules look inside: the next frame. */
const FRAME = '#root[data-ui="next"]';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "" },
    only: { type: "string", default: "" },
    strict: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    replace: { type: "boolean", default: false },
    frozen: { type: "string", default: FROZEN_DIR },
    rounds: { type: "string", default: ROUNDS_DIR },
    note: { type: "string", default: "" },
    "tokens-only": { type: "boolean", default: false },
  },
});

const [command, roundArgument] = positionals;

const USAGE =
  "usage: look.ts capture|round <n>|freeze <n>|check [--out <dir>] [--only <state,...>] [--strict] [--replace] [--frozen <dir>] [--rounds <dir>] [--note <text>] [--tokens-only]";

// ---------------------------------------------------------------------------------------------
// States

/** What a state's steps can reach: the running client. */
interface Reach {
  readonly app: CairnApp;
}

/** One named state of the client: where it opens, how it is entered, and where it is drawn. */
interface LookState {
  readonly name: string;
  /** A sentence-case heading for the round's page. */
  readonly title: string;
  /** What the state shows, for the page. */
  readonly caption: string;
  readonly path: (reach: Reach) => string;
  readonly widths: ReadonlyArray<LookWidth>;
  /** Whether the state is also drawn in light. */
  readonly light: boolean;
  readonly enter: (page: Page, width: LookWidth) => Promise<void>;
}

const editor = (page: Page) =>
  page.locator('[data-testid="composer-editor"]').first();

/** A transcript row's selector outside the list's off-screen measuring box (ADR 0041). */
const drawn = (selector: string): string =>
  `${selector}:not([data-list-probe] ${selector})`;

const settle = async (page: Page, ms = 600) => {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(ms);
};

const waitForThread = async (page: Page) => {
  await page
    .locator(drawn("[data-timeline-row-kind]"))
    .last()
    .waitFor({ state: "attached", timeout: 20_000 });
  await page.waitForTimeout(1200);
};

/** Scrolls the transcript up until the last turn's fold row is drawn, then opens it. */
const openLastFold = async (page: Page) => {
  const folds = page.locator(drawn('[data-timeline-row-kind="turn-fold"]'));

  for (let step = 0; step < 40 && (await folds.count()) === 0; step += 1) {
    await page
      .locator('[data-testid="timeline-scroll"]')
      .first()
      .evaluate((element) => {
        element.scrollBy({ top: -600 });
      });
    await page.waitForTimeout(250);
  }

  await folds.last().evaluate((element) => {
    element.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(400);
  await folds.last().locator("button").first().click();
  await page.waitForTimeout(600);
  await folds.last().evaluate((element) => {
    element.scrollIntoView({ block: "start" });
  });
};

const STATES: ReadonlyArray<LookState> = [
  {
    name: "hero",
    title: "New thread",
    caption: "The hero with an empty composer, where a new thread starts.",
    path: () => "/",
    widths: [390, 1440],
    light: true,
    enter: async (page) => {
      await editor(page).waitFor({ state: "visible", timeout: 15_000 });
      await settle(page);
    },
  },
  {
    name: "slash-menu",
    title: "Slash commands",
    caption: "The hero's composer with `/` typed, so its command menu is open.",
    path: () => "/",
    widths: [390, 1440],
    light: false,
    enter: async (page) => {
      await editor(page).waitFor({ state: "visible", timeout: 15_000 });
      await editor(page).click();
      await page.keyboard.type("/");
      await page.waitForTimeout(800);
    },
  },
  {
    name: "thread",
    title: "A thread at its end",
    caption:
      "t3code's thread “Executor MCP Stdio Bridges”, imported, at its last reply.",
    path: ({ app }) => new URL(app.threadUrl).pathname,
    widths: [390, 1440],
    light: true,
    enter: async (page) => {
      await waitForThread(page);
      await settle(page);
    },
  },
  {
    name: "thread-fold",
    title: "A turn's work, unfolded",
    caption: "The same thread with its last turn's fold open.",
    path: ({ app }) => new URL(app.threadUrl).pathname,
    widths: [390, 1440],
    light: false,
    enter: async (page) => {
      await waitForThread(page);
      await openLastFold(page);
      await settle(page);
    },
  },
  {
    name: "sidebar",
    title: "The sidebar",
    caption:
      "The project rail of favicon squircles, the project thread and the running list of the threads it manages, and the foot's Usage and Settings. At 390 px it opens as a sheet.",
    path: ({ app }) => new URL(app.threadUrl).pathname,
    widths: [390, 1440],
    light: true,
    enter: async (page, width) => {
      await waitForThread(page);

      if (width === 390) {
        await page
          .getByRole("button", { name: "Toggle main sidebar" })
          .first()
          .click();
        // The sheet's wrapper has no box of its own (its panel and backdrop are fixed), so it is
        // waited for by its presence, as behaviour.ts's mobile-sheet check does.
        await page
          .getByTestId("sidebar-sheet")
          .waitFor({ state: "attached", timeout: 5000 });
      }

      // The visible copy of the sidebar: the sheet on a phone, the column on a desktop.
      await page
        .getByTestId(width === 390 ? "sidebar-sheet" : "shell-column")
        .getByTestId("rail-favicon")
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await settle(page, 900);
    },
  },
  {
    name: "scratch",
    title: "The scratch thread",
    caption:
      "The floating scratch thread with no project, opened with Ctrl+J or Cmd+J (at 390 px, the header's button).",
    path: ({ app }) => new URL(app.threadUrl).pathname,
    widths: [390, 1440],
    light: false,
    enter: async (page, width) => {
      await waitForThread(page);

      if (width === 1440) {
        await editor(page).click();
        await page.keyboard.press("Control+j");
      } else {
        await page.getByTestId("open-scratch").click();
      }

      await page
        .getByTestId("scratch-overlay")
        .waitFor({ state: "visible", timeout: 5000 });
      await settle(page, 600);
    },
  },
  {
    name: "settings",
    title: "Settings",
    caption: "The general settings page.",
    path: () => "/settings",
    widths: [390, 1440],
    light: true,
    enter: async (page) => {
      await page.waitForTimeout(1200);
      await settle(page, 300);
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Shots

const RuleName = Schema.Literals([
  "touch",
  "overflow",
  "hscroll",
  "tone",
  "focus",
]);

type RuleName = typeof RuleName.Type;

const RULE_NAMES = RuleName.literals;

/** One rule's run on one shot. */
const RuleResult = Schema.Struct({
  rule: RuleName,
  /** Whether the rule is judged on this shot (touch and hscroll on the phone only). */
  judged: Schema.Boolean,
  checked: Schema.Int,
  violations: Schema.Array(Violation),
});

type RuleResult = typeof RuleResult.Type;

/** One shot as the report records it. */
const ShotRecord = Schema.Struct({
  state: Schema.String,
  width: LookWidth,
  theme: LookTheme,
  scale: Schema.Int,
  file: Schema.String,
  sha256: Schema.String,
  fingerprint: FrozenShot.fields.fingerprint,
  rules: Schema.Array(RuleResult),
  errors: Schema.Array(Schema.String),
});

type ShotRecord = typeof ShotRecord.Type;

const Control = Schema.Struct({
  plant: Schema.String,
  rule: RuleName,
  planted: Schema.Boolean,
  caught: Schema.Boolean,
  found: Schema.Int,
});

type Control = typeof Control.Type;

/** A capture's report: `report.json` beside its shots. */
const Report = Schema.Struct({
  round: Schema.NullOr(Schema.Int),
  commit: Schema.String,
  tokens: Schema.Struct({ path: Schema.String, sha256: Schema.String }),
  shots: Schema.Array(ShotRecord),
  controls: Schema.Array(Control),
});

type Report = typeof Report.Type;

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(Report));

const encodeReport = Schema.encodeSync(Report);

const contextOptions = (
  width: LookWidth,
  theme: LookTheme
): BrowserContextOptions =>
  width === 390
    ? {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: SCALE,
        isMobile: true,
        hasTouch: true,
        colorScheme: theme,
        reducedMotion: "reduce",
        timezoneId: "UTC",
        locale: "en-US",
      }
    : {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: SCALE,
        colorScheme: theme,
        reducedMotion: "reduce",
        timezoneId: "UTC",
        locale: "en-US",
      };

/** Hides what is not part of a state: toasts and the caret. */
const STILL_STYLE =
  '[data-slot^="toast"]{display:none!important} *{caret-color:transparent!important}';

/** Opens `state` at `width` in `theme`, with the next frame drawn and the state entered. */
const openState = async (
  browser: Browser,
  reach: Reach,
  state: LookState,
  width: LookWidth,
  theme: LookTheme
) => {
  const context = await browser.newContext(contextOptions(width, theme));

  await context.clock.setFixedTime(FIXED_TIME);

  const page = await context.newPage();
  const errors: Array<string> = [];

  page.on("pageerror", (error) => errors.push(error.message));

  const url = new URL(state.path(reach), reach.app.origin);

  url.searchParams.set("ui", "next");

  // Vite may reload the page once while it optimizes a dependency it met late.
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page
    .locator(FRAME)
    .waitFor({ state: "attached", timeout: 15_000 })
    .catch(async () => {
      await page.goto(url.href, { waitUntil: "networkidle" });
      await page.locator(FRAME).waitFor({ state: "attached", timeout: 15_000 });
    });
  await page.addStyleTag({ content: STILL_STYLE });
  await state.enter(page, width);

  return { context, page, errors };
};

/** Runs the rules on a page as it stands; focus last, since Tab moves through the page. */
const judgeShot = async (
  page: Page,
  width: LookWidth
): Promise<ReadonlyArray<RuleResult>> => {
  const phone = width === 390;

  const touch = phone
    ? decodeChecked(await page.evaluate(touchRule, HIT_TARGET_PX))
    : { checked: 0, violations: [] };

  const overflow = decodeChecked(
    await page.evaluate(overflowRule, {
      tolerance: OVERFLOW_TOLERANCE_PX,
      root: FRAME,
    })
  );

  const hscroll = decodeViolations(await page.evaluate(hscrollRule, FRAME));
  const tone = decodeChecked(await page.evaluate(toneRule));
  const focus = await focusRule(page);

  return [
    { rule: "touch", judged: phone, ...touch },
    { rule: "overflow", judged: true, ...overflow },
    { rule: "hscroll", judged: phone, checked: 1, violations: hscroll },
    { rule: "tone", judged: tone.checked > 0, ...tone },
    { rule: "focus", judged: true, ...focus },
  ];
};

/** Whether a rule failed a shot: it broke, or it is judged there and looked at nothing. */
const ruleFails = (result: RuleResult): boolean =>
  result.judged && (result.violations.length > 0 || result.checked === 0);

const shotFails = (shot: ShotRecord): boolean =>
  shot.rules.some(ruleFails) || shot.errors.length > 0;

/** Every shot the states list: each width, in dark, and in light where the state has it. */
const shotsOf = (states: ReadonlyArray<LookState>) =>
  states.flatMap((state) =>
    state.widths.flatMap((width) =>
      (state.light ? (["dark", "light"] as const) : (["dark"] as const)).map(
        (theme) => ({ state, width, theme })
      )
    )
  );

const takeShot = async (
  browser: Browser,
  reach: Reach,
  shot: { state: LookState; width: LookWidth; theme: LookTheme },
  shotsDir: string,
  plant?: (page: Page) => Promise<void>
): Promise<{ record: ShotRecord; png: Buffer }> => {
  const opened = await openState(
    browser,
    reach,
    shot.state,
    shot.width,
    shot.theme
  );

  try {
    if (plant !== undefined) {
      await plant(opened.page);
    }

    const png = await opened.page.screenshot({
      caret: "hide",
      animations: "disabled",
    });

    const name = shotName({
      state: shot.state.name,
      width: shot.width,
      theme: shot.theme,
    });

    const file = `shots/${name}.png`;

    writeFileSync(path.join(shotsDir, `${name}.png`), png);

    const rules = await judgeShot(opened.page, shot.width);

    return {
      png,
      record: {
        state: shot.state.name,
        width: shot.width,
        theme: shot.theme,
        scale: SCALE,
        file,
        sha256: sha256(png),
        fingerprint: fingerprintOf(decodePng(png), CELL_CSS_PX * SCALE),
        rules,
        errors: opened.errors,
      },
    };
  } finally {
    await opened.context.close();
  }
};

// ---------------------------------------------------------------------------------------------
// Controls: violations planted in a real state, each of which its rule must catch.

/** A plant: which rule must catch it, and the page function that puts it in. */
interface Plant {
  readonly name: string;
  readonly rule: RuleName;
  readonly put: () => boolean;
}

// Each plant is sent to the page on its own, so each is self-contained. They pick their target by
// what it is, not by a test id, so they keep working as the look track redraws the views.

/** The first visible button in the frame, shrunk to 24 px. */
const plantTouch = (): boolean => {
  const target = [
    ...document.querySelectorAll<HTMLElement>('#root[data-ui="next"] button'),
  ].find((button) => {
    const rect = button.getBoundingClientRect();

    return rect.width > 0 && rect.top >= 0 && rect.bottom <= innerHeight;
  });

  if (target === undefined) {
    return false;
  }

  target.dataset.planted = "";
  target.style.setProperty("min-width", "0", "important");
  target.style.setProperty("min-height", "0", "important");
  target.style.setProperty("width", "24px", "important");
  target.style.setProperty("height", "24px", "important");

  return true;
};

/** The first visible line of text of 12 characters or more, cut to 40 px without an ellipsis. */
const plantClip = (): boolean => {
  const target = [
    ...document.querySelectorAll<HTMLElement>(
      '#root[data-ui="next"] p, #root[data-ui="next"] span, #root[data-ui="next"] h1, #root[data-ui="next"] h2'
    ),
  ].find((element) => {
    const rect = element.getBoundingClientRect();

    // Painted on top where it stands: the element is what a point at its centre hits.
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );

    return (
      element.children.length === 0 &&
      (element.textContent ?? "").trim().length >= 12 &&
      rect.width > 60 &&
      rect.top >= 0 &&
      rect.bottom <= innerHeight &&
      hit !== null &&
      element.contains(hit)
    );
  });

  if (target === undefined) {
    return false;
  }

  target.dataset.planted = "";
  target.style.setProperty("display", "block", "important");
  target.style.setProperty("width", "40px", "important");
  target.style.setProperty("overflow", "hidden", "important");
  target.style.setProperty("white-space", "nowrap", "important");
  target.style.setProperty("text-overflow", "clip", "important");

  return true;
};

/** Every button in the frame with its focus ring taken away. */
const plantFocus = (): boolean => {
  const style = document.createElement("style");

  style.textContent =
    '#root[data-ui="next"] button:focus, #root[data-ui="next"] button:focus-visible { outline: none !important; box-shadow: none !important; }';
  document.head.append(style);

  for (const button of document.querySelectorAll<HTMLElement>(
    '#root[data-ui="next"] button'
  )) {
    button.dataset.planted = "";
  }

  return document.querySelector('#root[data-ui="next"] button') !== null;
};

/**
 * The frame given a 600 px minimum width. The frame clips sideways overflow inside it, so a wide
 * block within it is cut rather than scrolled; a frame wider than the phone is what scrolls.
 */
const plantWide = (): boolean => {
  const frame = document.querySelector<HTMLElement>('#root[data-ui="next"]');

  if (frame === null) {
    return false;
  }

  frame.dataset.planted = "";
  frame.style.setProperty("min-width", "600px", "important");

  return true;
};

const PLANTS: ReadonlyArray<Plant> = [
  { name: "touch", rule: "touch", put: plantTouch },
  { name: "overflow-clip", rule: "overflow", put: plantClip },
  { name: "focus", rule: "focus", put: plantFocus },
  { name: "hscroll", rule: "hscroll", put: plantWide },
];

/** The state the controls plant into. */
const CONTROL_STATE = "thread";

const runControls = async (
  browser: Browser,
  reach: Reach,
  scratch: string
): Promise<ReadonlyArray<Control>> => {
  const state = STATES.find((candidate) => candidate.name === CONTROL_STATE);

  if (state === undefined) {
    throw new Error(`look.ts: no state ${CONTROL_STATE} for the controls`);
  }

  const controls: Array<Control> = [];

  for (const plant of PLANTS) {
    let planted = false;

    const { record } = await takeShot(
      browser,
      reach,
      { state, width: 390, theme: "dark" },
      scratch,
      async (page) => {
        planted = await page.evaluate(plant.put);
        await page.waitForTimeout(200);
      }
    );

    const result = record.rules.find((rule) => rule.rule === plant.rule);
    const violations = result?.violations ?? [];

    controls.push({
      plant: plant.name,
      rule: plant.rule,
      planted,
      caught: violations.some((violation) => violation.planted),
      found: violations.length,
    });
  }

  return controls;
};

// ---------------------------------------------------------------------------------------------
// Capturing

const commitOf = (): string =>
  execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf-8",
  }).trim();

const tokensText = (): string =>
  readFileSync(path.join(root, TOKENS_PATH), "utf-8");

const startApp = async (): Promise<CairnApp> => {
  const exported = await Effect.runPromise(
    parseT3ThreadExport(
      readFileSync(
        path.join(
          root,
          "judges/fixtures/parity/t3@fe27e8e3/thread/thread.json"
        ),
        "utf-8"
      )
    )
  );

  return await startCairn(
    {
      projectTitle: exported.projectTitle,
      threadTitle: exported.title,
      entries: importT3Thread(exported).entries,
    },
    { shell: SHELL_SEED }
  );
};

const wantedStates = (): ReadonlyArray<LookState> => {
  const only = new Set(values.only.split(",").filter((name) => name !== ""));

  const unknown = [...only].filter(
    (name) => !STATES.some((state) => state.name === name)
  );

  if (unknown.length > 0) {
    throw new Error(
      `look.ts: no state ${unknown.join(", ")}; the states are ${STATES.map((state) => state.name).join(", ")}`
    );
  }

  return only.size === 0
    ? STATES
    : STATES.filter((state) => only.has(state.name));
};

/** Captures the wanted states into `out` and judges them; writes `report.json` there. */
const capture = async (out: string, round: number | null): Promise<Report> => {
  const shotsDir = path.join(out, "shots");

  const scratch = path.join(
    tmpdir(),
    `cairn-look-controls-${String(process.pid)}`
  );

  mkdirSync(shotsDir, { recursive: true });
  mkdirSync(scratch, { recursive: true });

  // The foldkit Vite plugin logs with `console.log`; stdout carries only this judge's JSON line.
  const { log } = console;

  console.log = console.error;

  const app = await startApp();
  const browser = await chromium.launch({ headless: !values.headed });

  try {
    const shots: Array<ShotRecord> = [];

    for (const shot of shotsOf(wantedStates())) {
      const { record } = await takeShot(browser, { app }, shot, shotsDir);

      shots.push(record);
      console.error(
        `${shotFails(record) ? "rules" : "ok   "} ${shotName(record)}`
      );
    }

    const controls = await runControls(browser, { app }, scratch);

    const report: Report = {
      round,
      commit: commitOf(),
      tokens: { path: TOKENS_PATH, sha256: sha256(tokensText()) },
      shots,
      controls,
    };

    writeFileSync(
      path.join(out, "report.json"),
      `${JSON.stringify(encodeReport(report), null, 2)}\n`
    );

    return report;
  } finally {
    await browser.close();
    await app.stop();
    rmSync(scratch, { recursive: true, force: true });
    console.log = log;
  }
};

const summary = (report: Report) => {
  const failing = report.shots.filter(shotFails);

  return {
    shots: report.shots.length,
    clean: report.shots.length - failing.length,
    rules: Object.fromEntries(
      RULE_NAMES.map((rule) => [
        rule,
        report.shots.filter((shot) =>
          shot.rules.some((result) => result.rule === rule && ruleFails(result))
        ).length,
      ])
    ),
    controls: report.controls,
    controlsCaught: report.controls.every(
      (control) => control.planted && control.caught
    ),
    errors: report.shots.flatMap((shot) => shot.errors),
  };
};

const verdictOf = (report: Report): boolean => {
  const { controlsCaught } = summary(report);

  return (
    controlsCaught &&
    report.shots.length > 0 &&
    (!values.strict || report.shots.every((shot) => !shotFails(shot)))
  );
};

// ---------------------------------------------------------------------------------------------
// The round's page

const escape = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Inline code in a caption: `x` becomes <code>x</code>. */
const prose = (text: string): string =>
  escape(text).replaceAll(/`(?<code>[^`]+)`/gu, "<code>$<code></code>");

const RULE_WORDS: Readonly<Record<RuleName, string>> = {
  touch: "touch targets of 44 px",
  overflow: "no text spilling or cut",
  hscroll: "no sideways scroll",
  tone: "tones as named",
  focus: "a focus ring on every Tab stop",
};

const findingsOf = (shot: ShotRecord): string => {
  const failing = shot.rules.filter(ruleFails);

  if (failing.length === 0 && shot.errors.length === 0) {
    return `<p class="cap ok">Every rule passes.</p>`;
  }

  const items = failing.map((result) => {
    const examples = result.violations
      .slice(0, 3)
      .map((violation) => `${violation.element}: ${violation.detail}`)
      .join("; ");

    return `<li><strong>${escape(RULE_WORDS[result.rule])}</strong>: ${
      result.violations.length === 0
        ? "looked at nothing"
        : `${String(result.violations.length)} found (${escape(examples)}${result.violations.length > 3 ? "; and more" : ""})`
    }</li>`;
  });

  const errors = shot.errors.map(
    (error) => `<li><strong>page error</strong>: ${escape(error)}</li>`
  );

  return `<ul class="cap findings">${[...items, ...errors].join("")}</ul>`;
};

const figure = (shot: ShotRecord, title: string): string =>
  `<figure class="shot w${String(shot.width)}"><a href="${shot.file}"><img src="${shot.file}" width="${String(shot.width)}" alt="${escape(`${title} at ${String(shot.width)} px in ${shot.theme}`)}" loading="lazy"></a><figcaption>${String(shot.width)} px, ${shot.theme}</figcaption>${findingsOf(shot)}</figure>`;

const roundPage = (report: Report, round: number): string => {
  const sums = summary(report);

  const byState = (name: string, theme: LookTheme) =>
    report.shots.filter((shot) => shot.state === name && shot.theme === theme);

  const captured = STATES.filter((state) =>
    report.shots.some((shot) => shot.state === state.name)
  );

  const sections = captured
    .map((state) => {
      const dark = byState(state.name, "dark")
        .map((shot) => figure(shot, state.title))
        .join("");

      return `<section class="part" id="${state.name}">
<h2>${escape(state.title)}</h2>
<p class="lede">${prose(state.caption)} <span class="muted">State <code>${state.name}</code>.</span></p>
<div class="shots">${dark}</div>
</section>`;
    })
    .join("\n");

  const light = captured.filter((state) => state.light);

  const lightSection =
    light.length === 0
      ? ""
      : `<section class="part" id="light">
<h2>In light</h2>
<p class="lede">Rounds are judged in dark; these are the states with a light variant, for a glance.</p>
${light
  .map(
    (state) =>
      `<h3>${escape(state.title)}</h3><div class="shots">${byState(
        state.name,
        "light"
      )
        .map((shot) => figure(shot, state.title))
        .join("")}</div>`
  )
  .join("\n")}
</section>`;

  const ruleRows = RULE_NAMES.map(
    (rule) =>
      `<tr><td>${escape(RULE_WORDS[rule])}</td><td class="num">${String(sums.rules[rule] ?? 0)} of ${String(report.shots.length)}</td></tr>`
  ).join("");

  const controlRows = report.controls
    .map(
      (control) =>
        `<tr><td>${escape(control.plant)}</td><td>${escape(RULE_WORDS[control.rule])}</td><td>${control.caught ? "caught" : "missed"}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cairn: look round ${String(round)}</title>
<style>
  :root { --page-bg: #0d0d0d; --page-ink: #ececea; --page-panel: color-mix(in srgb, var(--page-ink) 4%, var(--page-bg)); --page-line: color-mix(in srgb, var(--page-ink) 10%, transparent); --page-line-2: color-mix(in srgb, var(--page-ink) 16%, transparent); --page-fg-2: color-mix(in srgb, var(--page-ink) 74%, var(--page-bg)); --page-fg-3: color-mix(in srgb, var(--page-ink) 58%, var(--page-bg)); --page-warn: #e9b86f; --page-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif; --page-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page-bg); color: var(--page-ink); font: 15px/1.6 var(--page-font); -webkit-font-smoothing: antialiased; }
  a { color: inherit; text-decoration-color: var(--page-line-2); text-underline-offset: 3px; }
  code { font-family: var(--page-mono); font-size: 0.86em; background: var(--page-panel); border: 1px solid var(--page-line); border-radius: 5px; padding: 0.05em 0.35em; }
  .page { max-width: 1900px; margin: 0 auto; padding: 40px 48px 120px; }
  header.hero { padding-bottom: 28px; border-bottom: 1px solid var(--page-line); margin-bottom: 36px; }
  .eyebrow { color: var(--page-fg-3); font-size: 13px; }
  header.hero h1 { font-size: 34px; line-height: 1.15; font-weight: 600; letter-spacing: -0.02em; margin: 8px 0 14px; }
  header.hero p { color: var(--page-fg-2); font-size: 16.5px; margin: 0 0 12px; max-width: 760px; }
  nav.jump { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
  nav.jump a { text-decoration: none; border: 1px solid var(--page-line-2); border-radius: 999px; padding: 3px 12px; font-size: 13.5px; color: var(--page-fg-2); }
  section.part { margin: 0 0 72px; }
  h2 { font-size: 26px; font-weight: 600; letter-spacing: -0.01em; margin: 4px 0 6px; }
  h3 { font-size: 15px; font-weight: 600; margin: 28px 0 12px; color: var(--page-fg-2); }
  p.lede { color: var(--page-fg-2); max-width: 820px; margin: 0 0 16px; }
  .shots { display: flex; gap: 32px; align-items: flex-start; overflow-x: auto; padding: 4px 4px 24px; }
  figure.shot { margin: 0; flex: none; }
  figure.shot img { display: block; height: auto; border: 1px solid var(--page-line-2); border-radius: 12px; }
  figure.w390 img { width: 390px; }
  figure.w1440 img { width: min(1440px, calc(100vw - 96px - 390px - 40px)); min-width: 720px; }
  figcaption, .cap { color: var(--page-fg-3); font-size: 13px; margin-top: 8px; max-width: 520px; }
  .findings { padding-left: 18px; } .findings li { margin: 2px 0; } .ok { color: var(--page-fg-2); }
  .table-wrap { overflow-x: auto; margin: 16px 0 20px; border: 1px solid var(--page-line); border-radius: 12px; max-width: 900px; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; vertical-align: top; padding: 8px 12px; border-bottom: 1px solid var(--page-line); }
  th { font-weight: 600; color: var(--page-fg-2); background: var(--page-panel); font-size: 12.5px; }
  tr:last-child td { border-bottom: 0; }
  td.num { font-variant-numeric: tabular-nums; }
  ul, ol { padding-left: 22px; } li { margin: 4px 0; } li::marker { color: var(--page-fg-3); }
  .callout { border-left: 3px solid var(--page-warn); background: var(--page-panel); border-radius: 0 10px 10px 0; padding: 14px 18px; margin: 16px 0; color: var(--page-fg-2); max-width: 860px; }
  .callout strong { color: var(--page-ink); }
  .muted { color: var(--page-fg-3); }
  @media (max-width: 500px) { .page { padding: 24px 12px 80px; } figure.w1440 img { min-width: 0; width: calc(100vw - 32px); } }
</style>
</head>
<body>
<div class="page">
<header class="hero">
<div class="eyebrow">Cairn · look track · round ${String(round)} · captured at ${escape(report.commit)} · tokens ${escape(report.tokens.sha256.slice(0, 12))}</div>
<h1>The app as it draws today, round ${String(round)}</h1>
<p>Unlike rounds 0 and 1, these are not mock pages. Each picture is the real <code>next</code> client, driven by <code>judges/look.ts</code> over a scripted brain with t3code's imported thread, at 390 px as a phone and at 1,440 px, in dark (and in light where the state has a light variant).</p>
<p>Under each picture are the look rules' findings for it: touch targets, text that spills or is cut, sideways scroll, colour tones and focus rings. A finding is a fault in the views for the look track to fix, not a question for you.</p>
${values.note === "" ? "" : `<div class="callout">${prose(values.note)}</div>`}
<nav class="jump">${captured.map((state) => `<a href="#${state.name}">${escape(state.title)}</a>`).join("")}${light.length > 0 ? `<a href="#light">In light</a>` : ""}<a href="#rules">The rules</a><a href="#call">Your call</a></nav>
</header>
${sections}
${lightSection}
<section class="part" id="rules">
<h2>The rules</h2>
<p class="lede">${String(sums.clean)} of ${String(sums.shots)} pictures pass every rule. The rules run in Chromium after each picture is taken; a rule that looks at nothing fails, so a selector that stops matching cannot pass.</p>
<div class="table-wrap"><table><thead><tr><th>Rule</th><th>Pictures failing it</th></tr></thead><tbody>${ruleRows}</tbody></table></div>
<p class="lede">The judge is not blind: the thread at 390 px in dark is taken again with one fault planted per rule, and each must be caught.</p>
<div class="table-wrap"><table><thead><tr><th>Planted fault</th><th>Rule</th><th>Result</th></tr></thead><tbody>${controlRows}</tbody></table></div>
</section>
<section class="part" id="call">
<h2>Your call</h2>
<p class="lede">Approve round ${String(round)} as the look to hold from now on, or name what to change. On approval the round freezes: <code>look.ts freeze ${String(round)}</code> records each picture's hash and the tokens' hash, and from then on a changed token or a picture that drifts fails <code>look.ts check</code> until a new round is approved.</p>
<ul>
<li>Approve, or name the pictures and what to change in them.</li>
<li>Is any state missing that you want to judge in every round?</li>
<li>Should any state be judged in light as well, or in light only?</li>
</ul>
</section>
</div>
</body>
</html>
`;
};

// ---------------------------------------------------------------------------------------------
// Freezing and checking

const roundNumber = (): number => {
  const round = Number(roundArgument);

  if (!Number.isInteger(round) || round < 0) {
    throw new Error(USAGE);
  }

  return round;
};

const readFrozen = (dir: string): ReadonlyArray<FrozenRound> =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => /^round-\d+\.json$/u.test(file))
        .map((file) =>
          parseFrozenRound(readFileSync(path.join(dir, file), "utf-8"))
        )
    : [];

const freeze = (round: number) => {
  const folder = path.join(values.rounds, `round-${String(round)}`);

  const report = decodeReport(
    readFileSync(path.join(folder, "report.json"), "utf-8")
  );

  if (report.round !== round) {
    throw new Error(
      `look.ts: ${folder}/report.json is not round ${String(round)}`
    );
  }

  const newest = newestRound(readFrozen(values.frozen));

  if (newest !== undefined && newest.round >= round) {
    throw new Error(
      `look.ts: round ${String(newest.round)} is already frozen; freeze a newer round`
    );
  }

  const tokens = sha256(tokensText());

  if (tokens !== report.tokens.sha256) {
    throw new Error(
      `look.ts: ${TOKENS_PATH} hashes ${tokens.slice(0, 12)}, round ${String(round)} drew ${report.tokens.sha256.slice(0, 12)}; publish a new round before freezing`
    );
  }

  for (const shot of report.shots) {
    const today = sha256(readFileSync(path.join(folder, shot.file)));

    if (today !== shot.sha256) {
      throw new Error(
        `look.ts: ${shot.file} changed since round ${String(round)} was published`
      );
    }
  }

  const frozen: FrozenRound = {
    round,
    page: `${ROUNDS_URL}/round-${String(round)}/`,
    commit: report.commit,
    tokens: report.tokens,
    allowance: ALLOWANCE,
    shots: report.shots.map((shot) => ({
      state: shot.state,
      width: shot.width,
      theme: shot.theme,
      scale: shot.scale,
      sha256: shot.sha256,
      fingerprint: shot.fingerprint,
    })),
  };

  mkdirSync(values.frozen, { recursive: true });

  const file = path.join(values.frozen, `round-${String(round)}.json`);

  writeFileSync(file, formatFrozenRound(frozen));

  return {
    ok: true,
    frozen: path.relative(root, file),
    shots: frozen.shots.length,
  };
};

/** The token the check's control nudges, and the value it nudges it to. */
const CONTROL_TOKEN = { name: "--ink-1", value: "rgb(200 200 200)" } as const;

const check = async () => {
  const newest = newestRound(readFrozen(values.frozen));

  if (newest === undefined) {
    return { ok: true, frozen: null, detail: "no round is frozen yet" };
  }

  const tokens = tokensFinding(newest, tokensText());

  if (values["tokens-only"]) {
    return {
      ok: tokens === undefined,
      round: newest.round,
      tokens: tokens ?? "unchanged",
    };
  }

  const out =
    values.out === ""
      ? path.join(tmpdir(), `cairn-look-check-${String(process.pid)}`)
      : values.out;

  mkdirSync(out, { recursive: true });

  const { log } = console;

  console.log = console.error;

  const app = await startApp();
  const browser = await chromium.launch({ headless: !values.headed });

  try {
    const verdicts: Array<ShotVerdict> = [];

    for (const frozen of newest.shots) {
      const state = STATES.find((candidate) => candidate.name === frozen.state);

      if (state === undefined) {
        verdicts.push({
          name: shotName(frozen),
          pass: false,
          exact: false,
          drift: null,
          detail: "the state no longer exists",
        });
        continue;
      }

      const { png } = await takeShot(
        browser,
        { app },
        { state, width: frozen.width, theme: frozen.theme },
        out
      );

      const verdict = shotVerdict(frozen, png, newest.allowance.cellLevels);

      verdicts.push(verdict);
      console.error(
        `${verdict.pass ? "ok   " : "DRIFT"} ${verdict.name}: ${verdict.detail}`
      );
    }

    // The control: the first frozen shot with one token nudged must drift.
    const [first] = newest.shots;

    const firstState = STATES.find(
      (candidate) => candidate.name === first?.state
    );

    let control: ShotVerdict | null = null;

    if (first !== undefined && firstState !== undefined) {
      const { png } = await takeShot(
        browser,
        { app },
        { state: firstState, width: first.width, theme: first.theme },
        out,
        async (page) => {
          await page.addStyleTag({
            content: `[data-ui="next"] { ${CONTROL_TOKEN.name}: ${CONTROL_TOKEN.value} !important; }`,
          });
          await page.waitForTimeout(200);
        }
      );

      control = shotVerdict(first, png, newest.allowance.cellLevels);
    }

    const blind = control === null || control.pass;

    return {
      ok:
        tokens === undefined &&
        verdicts.every((verdict) => verdict.pass) &&
        !blind,
      round: newest.round,
      tokens: tokens ?? "unchanged",
      shots: verdicts.length,
      exact: verdicts.filter((verdict) => verdict.exact).length,
      drifted: verdicts.filter((verdict) => !verdict.pass),
      within: verdicts.filter((verdict) => verdict.pass && !verdict.exact),
      control:
        control === null
          ? "no shot to nudge"
          : { ...control, failedRightly: !control.pass },
      out,
    };
  } finally {
    await browser.close();
    await app.stop();
    console.log = log;
  }
};

// ---------------------------------------------------------------------------------------------
// Main

const main = async (): Promise<boolean> => {
  if (command === "capture") {
    const out =
      values.out === ""
        ? path.join(tmpdir(), "cairn-look-capture")
        : values.out;

    const report = await capture(out, null);
    const ok = verdictOf(report);

    process.stdout.write(
      `${JSON.stringify({ ok, out, ...summary(report) })}\n`
    );

    return ok;
  }

  if (command === "round") {
    const round = roundNumber();

    if (round < FIRST_ROUND) {
      throw new Error(
        `look.ts: rounds 0 and 1 were static mock pages; this tool publishes from round ${String(FIRST_ROUND)}`
      );
    }

    const folder = path.join(values.rounds, `round-${String(round)}`);

    if (existsSync(folder)) {
      if (!values.replace) {
        throw new Error(
          `look.ts: ${folder} exists; pass --replace to publish it again`
        );
      }

      rmSync(folder, { recursive: true, force: true });
    }

    const report = await capture(folder, round);

    copyFileSync(path.join(root, TOKENS_PATH), path.join(folder, "tokens.css"));
    writeFileSync(path.join(folder, "index.html"), roundPage(report, round));

    const ok = verdictOf(report);

    process.stdout.write(
      `${JSON.stringify({ ok, folder, url: `${ROUNDS_URL}/round-${String(round)}/`, ...summary(report) })}\n`
    );

    return ok;
  }

  if (command === "freeze") {
    const result = freeze(roundNumber());

    process.stdout.write(`${JSON.stringify(result)}\n`);

    return result.ok;
  }

  if (command === "check") {
    const result = await check();

    process.stdout.write(`${JSON.stringify(result)}\n`);

    return result.ok;
  }

  throw new Error(USAGE);
};

process.exitCode = (await main()) ? 0 : 1;

process.exit();
