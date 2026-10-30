// The look rules judge (plan look track L3, surfaces note "Structure rules without a baseline",
// ADR 0040): the look catalogue at `/__look`, in the one look (Stone revised, L2b) in dark and
// light, at 390 px as a phone (touch, coarse pointer) and at 1,440 px, held to the rules a pixel baseline would have
// implied for new screens. In Chromium, with reduced motion so no transition is caught halfway.
//
//   node judges/look-rules.ts [--headed] [--screenshots <dir>]
//
// It starts the web client's Vite server on an ephemeral loopback port (the catalogue needs no
// brain). Rules, on every primitive the catalogue draws (their code is judges/lib/LookRules.ts,
// which judges/look.ts also runs over the real client's states):
//   touch     at 390 px, every control (a button, link, field, menu item, `[role=button]` or
//             `[data-action]`) is at least 44 by 44 px: the box itself, which is what a finger
//             hits (WCAG 2.5.5's size; the tokens' `--hit-target`);
//   overflow  no text paints outside a box that holds it: past a box that shows its overflow
//             (a spill), or cut by one that hides it without an ellipsis (a clip). A box that
//             scrolls, or truncates with an ellipsis on purpose, is allowed, and words for
//             assistive technology only (`sr-only`) are not painted, so not judged;
//   focus     every element Tab reaches shows a focus ring (an outline, or a shadow, on itself or
//             on the field shell around it) that it does not show unfocused, unless it is the
//             catalogue's forced-focus specimen (`data-focus`);
//   hscroll   the page does not scroll sideways (judged at 390 px; reported at 1,440);
//   tone      what a primitive's meaning names is the colour it computes to: a destructive menu
//             item and its glyph in `--tone-failed`, a field's leading glyph in `--ink-3`;
//   still     opening each live disclosure (fold, phase, previous agents) moves nothing above it
//             and nothing in its own header line, by more than 0.5 px (then it is folded again);
//             the shapes inside a glyph are not watched, since the chevron turns in place;
//   sheet     at 390 px, "Open sheet" opens the sheet over the page as a bottom sheet the width
//             of the screen, focus moves into it, its controls are touch targets, Escape closes
//             it and focus returns to the button that opened it.
// A rule that checked nothing on a page fails that page, so a selector that stops matching cannot
// pass by looking at nothing.
//
// Then the controls: one page at 390 px in dark with one violation planted in a real
// primitive (an icon button shrunk to 24 px, a chip whose label spills out of it, a card title cut
// without an ellipsis, a button with its outline removed, a block 600 px wide, a destructive menu
// item drawn in ink-1 as the old wiring drew it, a disclosure header that grows when it opens, the
// sheet's close button shrunk to 24 px), each of which must fail its rule at the planted element.
// Prints one JSON line on stdout (the Vite server's own logging goes to stderr) and exits 0 when
// every clean page passes every rule and every plant is caught.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { createServer as createViteServer } from "vite";

import {
  HIT_TARGET_PX,
  LOOPBACK,
  OVERFLOW_TOLERANCE_PX,
  decodeBoolean,
  decodeChecked,
  decodeViolations,
  focusRule,
  freePort,
  hscrollRule,
  overflowRule,
  sheetRule,
  stillRule,
  toneRule,
  touchRule,
} from "./lib/LookRules.ts";
import type { Violation } from "./lib/LookRules.ts";

/* oxlint-disable no-await-in-loop -- a judge drives one browser page after another, on purpose */

const { values } = parseArgs({
  options: {
    headed: { type: "boolean", default: false },
    screenshots: { type: "string", default: "" },
  },
});

const root = path.resolve(import.meta.dirname, "..");

/** What the overflow and hscroll rules look inside. */
const CATALOGUE = "[data-look-catalogue]";

const THEMES = ["dark", "light"] as const;

/** The two widths: a phone, judged as touch, and a desktop window. */
const WIDTHS = [390, 1440] as const;

type Width = (typeof WIDTHS)[number];

const RULES = [
  "touch",
  "overflow",
  "focus",
  "hscroll",
  "tone",
  "still",
  "sheet",
] as const;

type Rule = (typeof RULES)[number];

// ---------------------------------------------------------------------------------------------
// Plants: one violation per rule, put into a real primitive on the page.

const PLANTS = [
  "touch",
  "overflow-spill",
  "overflow-clip",
  "focus",
  "hscroll",
  "tone",
  "still",
  "sheet",
] as const;

type Plant = (typeof PLANTS)[number];

const RULE_OF_PLANT: Readonly<Record<Plant, Rule>> = {
  touch: "touch",
  "overflow-spill": "overflow",
  "overflow-clip": "overflow",
  focus: "focus",
  hscroll: "hscroll",
  tone: "tone",
  still: "still",
  sheet: "sheet",
};

// Each plant is sent to the page on its own, so each names its target in full.

/** An icon button shrunk to 24 px. */
const plantTouch = (): boolean => {
  const target = document.querySelector<HTMLElement>(
    '[data-look-state="icon-button/ghost-regular"] button'
  );

  if (target === null) {
    return false;
  }

  target.dataset.planted = "";
  target.style.setProperty("min-width", "0", "important");
  target.style.setProperty("min-height", "0", "important");
  target.style.setProperty("width", "24px", "important");
  target.style.setProperty("height", "24px", "important");

  return true;
};

/** A chip whose label runs out of it, nothing cutting it. */
const plantSpill = (): boolean => {
  const chip = document.querySelector<HTMLElement>(
    '[data-look-state="chip/tones"] [data-slot="chip"]'
  );

  const label = chip?.querySelector<HTMLElement>("span") ?? null;

  if (chip === null || label === null) {
    return false;
  }

  chip.dataset.planted = "";
  chip.style.setProperty("width", "48px");
  chip.style.setProperty("max-width", "48px");
  chip.style.setProperty("overflow", "visible");
  label.style.setProperty("overflow", "visible");
  label.style.setProperty("text-overflow", "clip");
  label.style.setProperty("white-space", "nowrap");
  label.textContent = "a label that will not fit";

  return true;
};

/** A card title cut short without an ellipsis. */
const plantClip = (): boolean => {
  const title = document.querySelector<HTMLElement>(
    '[data-look-state="card/neutral"] h3'
  );

  if (title === null) {
    return false;
  }

  title.dataset.planted = "";
  title.style.setProperty("width", "64px");
  title.style.setProperty("flex", "none");
  title.style.setProperty("overflow", "hidden");
  title.style.setProperty("white-space", "nowrap");

  return true;
};

/** A button with its focus ring taken away. */
const plantFocus = (): boolean => {
  const target = document.querySelector<HTMLElement>(
    '[data-look-state="button/secondary-regular"] button'
  );

  if (target === null) {
    return false;
  }

  target.dataset.planted = "";
  target.style.setProperty("outline", "none", "important");
  target.style.setProperty("box-shadow", "none", "important");

  return true;
};

/** A block 600 px wide inside a specimen. */
const plantWide = (): boolean => {
  const into = document.querySelector<HTMLElement>(
    '[data-look-state="divider/horizontal"] > div'
  );

  if (into === null) {
    return false;
  }

  const wide = document.createElement("div");

  wide.dataset.planted = "";
  wide.style.setProperty("width", "600px");
  wide.style.setProperty("height", "4px");
  into.append(wide);

  return true;
};

/** A destructive menu item drawn in ink-1, as the old wiring drew it (the tone on its inner span). */
const plantTone = (): boolean => {
  const item = document.querySelector<HTMLElement>(
    '[role="menuitem"][data-variant="destructive"]'
  );

  if (item === null) {
    return false;
  }

  item.dataset.planted = "";
  item.classList.remove("text-tone-failed");
  item.classList.add("text-ink-1");

  return true;
};

/** A disclosure header that grows by 16 px when it opens, pushing its own line down. */
const plantStill = (): boolean => {
  const trigger = document.querySelector<HTMLElement>(
    "[data-look-live-disclosure]"
  );

  if (trigger === null) {
    return false;
  }

  const style = document.createElement("style");

  trigger.dataset.planted = "";
  style.textContent =
    '[data-planted][aria-expanded="true"] { padding-top: 16px !important; }';
  document.head.append(style);

  return true;
};

/** The sheet's close button shrunk to 24 px. */
const plantSheet = (): boolean => {
  const style = document.createElement("style");

  style.id = "look-planted-sheet";
  style.textContent =
    '[data-testid="look-live-sheet"] button[aria-label="Close"] { min-width: 0 !important; min-height: 0 !important; width: 24px !important; height: 24px !important; }';
  document.head.append(style);

  return document.querySelector('[data-testid="look-open-sheet"]') !== null;
};

const PLANT_IN: Readonly<Record<Plant, () => boolean>> = {
  touch: plantTouch,
  "overflow-spill": plantSpill,
  "overflow-clip": plantClip,
  focus: plantFocus,
  hscroll: plantWide,
  tone: plantTone,
  still: plantStill,
  sheet: plantSheet,
};

// ---------------------------------------------------------------------------------------------
// Running

interface PageResult {
  readonly theme: string;
  readonly width: Width;
  readonly coarse: boolean;
  readonly violations: Readonly<Record<Rule, ReadonlyArray<Violation>>>;
  readonly checked: Readonly<Record<Rule, number>>;
}

const openPage = async (
  browser: Browser,
  port: number,
  theme: string,
  width: Width
) => {
  const context = await browser.newContext(
    width === 390
      ? {
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 2,
          reducedMotion: "reduce",
        }
      : {
          viewport: { width: 1440, height: 900 },
          reducedMotion: "reduce",
        }
  );

  const page = await context.newPage();
  const errors: Array<string> = [];

  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://${LOOPBACK}:${String(port)}/__look?theme=${theme}`);
  await page.waitForSelector(
    `[data-look-catalogue] [data-ui="next"][data-theme="${theme}"]`
  );
  // Two frames, so the first layout and paint are done before any rule reads them.
  await page.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))"
  );

  return { context, page, errors };
};

const judgePage = async (
  page: Page,
  theme: string,
  width: Width
): Promise<PageResult> => {
  const coarse = decodeBoolean(
    await page.evaluate(() => matchMedia("(pointer: coarse)").matches)
  );

  const touch =
    width === 390
      ? decodeChecked(await page.evaluate(touchRule, HIT_TARGET_PX))
      : { checked: 0, violations: [] };

  const overflow = decodeChecked(
    await page.evaluate(overflowRule, {
      tolerance: OVERFLOW_TOLERANCE_PX,
      root: CATALOGUE,
    })
  );

  const hscroll = decodeViolations(await page.evaluate(hscrollRule, CATALOGUE));
  const focus = await focusRule(page);
  const tone = decodeChecked(await page.evaluate(toneRule));

  const still = decodeChecked(
    await page.evaluate(stillRule, OVERFLOW_TOLERANCE_PX / 2)
  );

  const sheet =
    width === 390 ? await sheetRule(page) : { checked: 0, violations: [] };

  return {
    theme,
    width,
    coarse,
    violations: {
      touch: touch.violations,
      overflow: overflow.violations,
      focus: focus.violations,
      hscroll,
      tone: tone.violations,
      still: still.violations,
      sheet: sheet.violations,
    },
    checked: {
      touch: touch.checked,
      overflow: overflow.checked,
      focus: focus.checked,
      hscroll: 1,
      tone: tone.checked,
      still: still.checked,
      sheet: sheet.checked,
    },
  };
};

/** The rules judged at a width: touch, hscroll and the sheet on the phone only. */
const judgedAt = (rule: Rule, width: Width): boolean =>
  width === 390 || !["touch", "hscroll", "sheet"].includes(rule);

/** The rules a page fails: one broken, or one that checked nothing where it is judged. */
const failedRules = (result: PageResult): ReadonlyArray<Rule> =>
  RULES.filter(
    (rule) =>
      judgedAt(rule, result.width) &&
      (result.violations[rule].length > 0 || result.checked[rule] === 0)
  );

const main = async () => {
  const port = await freePort();

  // The foldkit Vite plugin logs its dev-tools connections with `console.log`; stdout carries only
  // this judge's JSON line, so everything else the server says goes to stderr.
  console.log = console.error;

  const vite = await createViteServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    root: path.join(root, "apps/web"),
    logLevel: "error",
    server: { host: LOOPBACK, port, strictPort: true },
  });

  await vite.listen();

  const browser = await chromium.launch({ headless: !values.headed });
  const errors: Array<string> = [];
  const clean: Array<PageResult> = [];

  if (values.screenshots !== "") {
    await mkdir(values.screenshots, { recursive: true });
  }

  try {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const opened = await openPage(browser, port, theme, width);

        if (values.screenshots !== "") {
          await opened.page.screenshot({
            path: path.join(
              values.screenshots,
              `${theme}-${String(width)}.png`
            ),
            fullPage: true,
          });
        }

        clean.push(await judgePage(opened.page, theme, width));
        errors.push(...opened.errors);
        await opened.context.close();
      }
    }

    const controls = [];

    for (const plant of PLANTS) {
      const opened = await openPage(browser, port, "dark", 390);

      const planted = decodeBoolean(
        await opened.page.evaluate(PLANT_IN[plant])
      );

      const result = await judgePage(opened.page, "dark", 390);
      const rule = RULE_OF_PLANT[plant];

      controls.push({
        plant,
        rule,
        planted,
        caught: result.violations[rule].some((violation) => violation.planted),
        found: result.violations[rule].length,
      });
      await opened.context.close();
    }

    const failures = clean.flatMap((result) =>
      failedRules(result).map((rule) => ({
        theme: result.theme,
        width: result.width,
        rule,
        violations: result.violations[rule].slice(0, 8),
        count: result.violations[rule].length,
        checked: result.checked[rule],
      }))
    );

    const coarse = clean
      .filter((result) => result.width === 390)
      .every((result) => result.coarse);

    const ok =
      failures.length === 0 &&
      coarse &&
      errors.length === 0 &&
      controls.every((control) => control.planted && control.caught);

    process.stdout.write(
      `${JSON.stringify({
        ok,
        pages: clean.length,
        coarse,
        checks: Object.fromEntries(
          RULES.map((rule) => [
            rule,
            clean.every((result) => !failedRules(result).includes(rule)),
          ])
        ),
        failures,
        // Per page, the fewest over the pages where the rule is judged: controls sized, text nodes
        // placed, Tab stops probed, colours resolved, disclosures opened, sheet controls sized.
        checked: Object.fromEntries(
          RULES.flatMap((rule) =>
            rule === "hscroll"
              ? []
              : [
                  [
                    rule,
                    Math.min(
                      ...clean.flatMap((result) =>
                        judgedAt(rule, result.width)
                          ? [result.checked[rule]]
                          : []
                      )
                    ),
                  ],
                ]
          )
        ),
        hscrollAt1440: clean.flatMap((result) =>
          result.width === 1440 && result.violations.hscroll.length > 0
            ? [result.theme]
            : []
        ),
        controls,
        errors,
      })}\n`
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
    await vite.close();
  }
};

await main();

process.exit();
