// The look rules judge (plan look track L3, surfaces note "Structure rules without a baseline",
// ADR 0040): the look catalogue at `/__look`, every look candidate in dark and light, at 390 px as a
// phone (touch, coarse pointer) and at 1,440 px, held to the rules a pixel baseline would have
// implied for new screens. In Chromium, with reduced motion so no transition is caught halfway.
//
//   node judges/look-rules.ts [--headed] [--screenshots <dir>]
//
// It starts the web client's Vite server on an ephemeral loopback port (the catalogue needs no
// brain). Rules, on every primitive the catalogue draws:
//   touch     at 390 px, every control (a button, link, field, menu item, `[role=button]` or
//             `[data-action]`) is at least 44 by 44 px: the box itself, which is what a finger
//             hits (WCAG 2.5.5's size; the tokens' `--hit-target`);
//   overflow  no text paints outside a box that holds it: past a box that shows its overflow
//             (a spill), or cut by one that hides it without an ellipsis (a clip). A box that
//             scrolls, or truncates with an ellipsis on purpose, is allowed;
//   focus     every element Tab reaches shows a focus ring (an outline, or a shadow, on itself or
//             on the field shell around it) that it does not show unfocused, unless it is the
//             catalogue's forced-focus specimen (`data-focus`);
//   hscroll   the page does not scroll sideways (judged at 390 px; reported at 1,440).
// Then the controls: one page at 390 px in graphite dark with one violation planted in a real
// primitive (an icon button shrunk to 24 px, a chip whose label spills out of it, a card title cut
// without an ellipsis, a button with its outline removed, a block 600 px wide), each of which must
// fail its rule at the planted element. Prints one JSON line and exits 0 when every clean page
// passes every rule and every plant is caught.

import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";

import { Predicate, Schema } from "effect";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { createServer as createViteServer } from "vite";

/* oxlint-disable no-await-in-loop -- a judge drives one browser page after another, on purpose */

const { values } = parseArgs({
  options: {
    headed: { type: "boolean", default: false },
    screenshots: { type: "string", default: "" },
  },
});

const LOOPBACK = "127.0.0.1";

const root = path.resolve(import.meta.dirname, "..");

const LOOKS = ["graphite", "ink", "stone"] as const;

const THEMES = ["dark", "light"] as const;

/** The two widths: a phone, judged as touch, and a desktop window. */
const WIDTHS = [390, 1440] as const;

type Width = (typeof WIDTHS)[number];

/** The smallest touch target, px (the tokens' `--hit-target`). */
const HIT_TARGET_PX = 44;

/** How far text may pass its box before it counts, px: subpixel rounding. */
const OVERFLOW_TOLERANCE_PX = 1;

const RULES = ["touch", "overflow", "focus", "hscroll"] as const;

type Rule = (typeof RULES)[number];

/** One element that broke a rule: the catalogue state it is in, what it is, and the numbers. */
const Violation = Schema.Struct({
  state: Schema.String,
  element: Schema.String,
  detail: Schema.String,
  planted: Schema.Boolean,
});

type Violation = typeof Violation.Type;

const Violations = Schema.Array(Violation);

const decodeViolations = Schema.decodeUnknownSync(Violations);

/** A rule's run on one page: how many things it looked at, and those that broke it. */
const Checked = Schema.Struct({ checked: Schema.Int, violations: Violations });

type Checked = typeof Checked.Type;

const decodeChecked = Schema.decodeUnknownSync(Checked);

/** What a rule run in the page returns, before it is decoded. */
interface RuleRun {
  readonly checked: number;
  readonly violations: Array<Violation>;
}

const decodeBoolean = Schema.decodeUnknownSync(Schema.Boolean);

const freePort = async (): Promise<number> => {
  const server = createNetServer().listen(0, LOOPBACK);

  await once(server, "listening");

  const address = server.address();

  server.close();
  await once(server, "close");

  if (address === null || Predicate.isString(address)) {
    throw new Error("judges/look-rules.ts: the kernel gave no loopback port.");
  }

  return address.port;
};

// ---------------------------------------------------------------------------------------------
// The rules, run in the page. Each is a self-contained function: Playwright sends its source.

/** Controls a finger hits, and every element smaller than the target. */
const touchRule = (target: number): RuleRun => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
  const describe = (element: Element): string =>
    `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}"`;

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
  const stateOf = (element: Element): string =>
    element.closest<HTMLElement>("[data-look-state]")?.dataset.lookState ??
    "page";

  const controls = document.querySelectorAll(
    'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [data-action]'
  );

  const shown = [...controls].filter((element) => {
    const rect = element.getBoundingClientRect();

    return rect.width > 0 || rect.height > 0;
  });

  const violations = shown.flatMap((element) => {
    const rect = element.getBoundingClientRect();

    return rect.width + 0.5 < target || rect.height + 0.5 < target
      ? [
          {
            state: stateOf(element),
            element: describe(element),
            detail: `${rect.width.toFixed(1)} by ${rect.height.toFixed(1)} px`,
            planted: element.closest("[data-planted]") !== null,
          },
        ]
      : [];
  });

  return { checked: shown.length, violations };
};

/** Text that paints outside a box holding it, unless the box scrolls or truncates on purpose. */
const overflowRule = (tolerance: number): RuleRun => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
  const stateOf = (element: Element): string =>
    element.closest<HTMLElement>("[data-look-state]")?.dataset.lookState ??
    "page";

  const catalogue = document.querySelector("[data-look-catalogue]");

  if (catalogue === null) {
    return {
      checked: 0,
      violations: [
        {
          state: "page",
          element: "catalogue",
          detail: "no [data-look-catalogue] on the page",
          planted: false,
        },
      ],
    };
  }

  const walker = document.createTreeWalker(catalogue, NodeFilter.SHOW_TEXT);
  const found: Array<Violation> = [];
  const range = document.createRange();
  let checked = 0;

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;

    if (parent === null || (node.textContent ?? "").trim() === "") {
      continue;
    }

    range.selectNodeContents(node);
    const text = range.getBoundingClientRect();

    if (text.width === 0 && text.height === 0) {
      continue;
    }

    checked += 1;

    for (
      let box: Element | null = parent;
      box !== null && box !== catalogue.parentElement;
      box = box.parentElement
    ) {
      const style = getComputedStyle(box);

      if (style.display === "inline" || style.display === "contents") {
        continue;
      }

      const rect = box.getBoundingClientRect();

      const past = Math.max(
        rect.left - text.left,
        text.right - rect.right,
        rect.top - text.top,
        text.bottom - rect.bottom
      );

      if (past <= tolerance) {
        continue;
      }

      const scrolls = [style.overflowX, style.overflowY].some(
        (overflow) => overflow === "auto" || overflow === "scroll"
      );

      if (scrolls || style.textOverflow === "ellipsis") {
        break;
      }

      const clips = [style.overflowX, style.overflowY].some(
        (overflow) => overflow === "hidden" || overflow === "clip"
      );

      found.push({
        state: stateOf(box),
        element: `${box.tagName.toLowerCase()} "${(node.textContent ?? "").trim().slice(0, 40)}"`,
        detail: `${clips ? "clipped" : "spills"} ${past.toFixed(1)} px past its box`,
        planted: box.closest("[data-planted]") !== null,
      });
      break;
    }
  }

  return { checked, violations: found };
};

/** Whether the page scrolls sideways, and the elements that reach past its right edge. */
const hscrollRule = (): Array<Violation> => {
  const page = document.documentElement;

  if (page.scrollWidth <= page.clientWidth) {
    return [];
  }

  const past = [...document.querySelectorAll("[data-look-catalogue] *")].filter(
    (element) =>
      element.getBoundingClientRect().right > page.clientWidth + 0.5 &&
      ![...element.children].some(
        (child) => child.getBoundingClientRect().right > page.clientWidth + 0.5
      )
  );

  return [
    {
      state: "page",
      element: "document",
      detail: `scrollWidth ${String(page.scrollWidth)} over clientWidth ${String(page.clientWidth)}; reaching past it: ${past
        .slice(0, 5)
        .map(
          (element) =>
            element.closest<HTMLElement>("[data-look-state]")?.dataset
              .lookState ?? element.tagName.toLowerCase()
        )
        .join(", ")}`,
      planted: past.some(
        (element) => element.closest("[data-planted]") !== null
      ),
    },
  ];
};

/** The focused element's ring: shown focused, and not shown blurred unless forced. */
const focusProbe = (): Violation | "body" | "ok" => {
  const element = document.activeElement;

  if (element === null || element === document.body) {
    return "body";
  }

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
  const transparent = (colour: string) =>
    colour === "transparent" || /rgba\([^)]*,\s*0\)$/u.test(colour);

  const shows = (target: Element | null): boolean => {
    if (target === null) {
      return false;
    }

    const style = getComputedStyle(target);

    const outline =
      style.outlineStyle !== "none" &&
      style.outlineWidth !== "0px" &&
      !transparent(style.outlineColor);

    return outline || style.boxShadow !== "none";
  };

  const ring = () =>
    shows(element) || shows(element.closest("[data-slot=field-shell]"));

  const focused = ring();

  if (!(element instanceof HTMLElement)) {
    return "ok";
  }

  element.blur();
  const blurred = ring();

  element.focus();

  const forced = element.closest("[data-focus]") !== null;

  if (focused && (!blurred || forced)) {
    return "ok";
  }

  return {
    state:
      element.closest<HTMLElement>("[data-look-state]")?.dataset.lookState ??
      "page",
    element: `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}"`,
    detail: focused
      ? "shows the same ring unfocused"
      : "shows no ring when focused",
    planted: element.closest("[data-planted]") !== null,
  };
};

const FocusResult = Schema.Union([Violation, Schema.Literals(["body", "ok"])]);

const decodeFocusResult = Schema.decodeUnknownSync(FocusResult);

/** Tabs through the page from the top and probes each focused element's ring. */
const focusRule = async (page: Page): Promise<Checked> => {
  await page.evaluate(() => {
    const active = document.activeElement;

    if (active instanceof HTMLElement) {
      active.blur();
    }
  });

  const count = await page.evaluate(
    () =>
      document.querySelectorAll(
        'button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
      ).length
  );

  const found: Array<Violation> = [];
  let stops = 0;

  for (let step = 0; step < count + 2; step += 1) {
    await page.keyboard.press("Tab");

    const result = decodeFocusResult(await page.evaluate(focusProbe));

    if (result === "body") {
      if (step > 0) {
        break;
      }
    } else {
      stops += 1;

      if (result !== "ok") {
        found.push(result);
      }
    }
  }

  return { checked: stops, violations: found };
};

// ---------------------------------------------------------------------------------------------
// Plants: one violation per rule, put into a real primitive on the page.

const PLANTS = [
  "touch",
  "overflow-spill",
  "overflow-clip",
  "focus",
  "hscroll",
] as const;

type Plant = (typeof PLANTS)[number];

const RULE_OF_PLANT: Readonly<Record<Plant, Rule>> = {
  touch: "touch",
  "overflow-spill": "overflow",
  "overflow-clip": "overflow",
  focus: "focus",
  hscroll: "hscroll",
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

const PLANT_IN: Readonly<Record<Plant, () => boolean>> = {
  touch: plantTouch,
  "overflow-spill": plantSpill,
  "overflow-clip": plantClip,
  focus: plantFocus,
  hscroll: plantWide,
};

// ---------------------------------------------------------------------------------------------
// Running

interface PageResult {
  readonly look: string;
  readonly theme: string;
  readonly width: Width;
  readonly coarse: boolean;
  readonly violations: Readonly<Record<Rule, ReadonlyArray<Violation>>>;
  readonly checked: Readonly<Record<Rule, number>>;
}

const openPage = async (
  browser: Browser,
  port: number,
  look: string,
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
  await page.goto(
    `http://${LOOPBACK}:${String(port)}/__look?look=${look}&theme=${theme}`
  );
  await page.waitForSelector(
    `[data-look-catalogue] [data-ui="next"][data-look="${look}"][data-theme="${theme}"]`
  );
  // Two frames, so the first layout and paint are done before any rule reads them.
  await page.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))"
  );

  return { context, page, errors };
};

const judgePage = async (
  page: Page,
  look: string,
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
    await page.evaluate(overflowRule, OVERFLOW_TOLERANCE_PX)
  );

  const hscroll = decodeViolations(await page.evaluate(hscrollRule));
  const focus = await focusRule(page);

  return {
    look,
    theme,
    width,
    coarse,
    violations: {
      touch: touch.violations,
      overflow: overflow.violations,
      focus: focus.violations,
      hscroll,
    },
    checked: {
      touch: touch.checked,
      overflow: overflow.checked,
      focus: focus.checked,
      hscroll: 1,
    },
  };
};

/** The rules a page is held to: hscroll is judged on the phone only. */
const failedRules = (result: PageResult): ReadonlyArray<Rule> =>
  RULES.filter(
    (rule) =>
      result.violations[rule].length > 0 &&
      (rule !== "hscroll" || result.width === 390)
  );

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
  const errors: Array<string> = [];
  const clean: Array<PageResult> = [];

  if (values.screenshots !== "") {
    await mkdir(values.screenshots, { recursive: true });
  }

  try {
    for (const look of LOOKS) {
      for (const theme of THEMES) {
        for (const width of WIDTHS) {
          const opened = await openPage(browser, port, look, theme, width);

          if (values.screenshots !== "") {
            await opened.page.screenshot({
              path: path.join(
                values.screenshots,
                `${look}-${theme}-${String(width)}.png`
              ),
              fullPage: true,
            });
          }

          clean.push(await judgePage(opened.page, look, theme, width));
          errors.push(...opened.errors);
          await opened.context.close();
        }
      }
    }

    const controls = [];

    for (const plant of PLANTS) {
      const opened = await openPage(browser, port, "graphite", "dark", 390);

      const planted = decodeBoolean(
        await opened.page.evaluate(PLANT_IN[plant])
      );

      const result = await judgePage(opened.page, "graphite", "dark", 390);
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
        look: result.look,
        theme: result.theme,
        width: result.width,
        rule,
        violations: result.violations[rule].slice(0, 8),
        count: result.violations[rule].length,
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
        // Per page, the fewest over the pages: controls sized, text nodes placed, Tab stops probed.
        checked: Object.fromEntries(
          (["touch", "overflow", "focus"] as const).map((rule) => [
            rule,
            Math.min(
              ...clean.flatMap((result) =>
                rule !== "touch" || result.width === 390
                  ? [result.checked[rule]]
                  : []
              )
            ),
          ])
        ),
        hscrollAt1440: clean.flatMap((result) =>
          result.width === 1440 && result.violations.hscroll.length > 0
            ? [`${result.look}-${result.theme}`]
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
