// The look rules (plan look track L3 and L5, surfaces note "Structure rules without a baseline",
// ADR 0040), run in a Chromium page: the rules a pixel baseline would have implied for new screens.
// judges/look-rules.ts holds the look catalogue at `/__look` to them, and judges/look.ts holds
// each named state of the real `next` client to them. Each rule that reads the page is a
// self-contained function, because Playwright sends its source into the page:
//   touch     every control (a button, link, field, menu item, `[role=button]` or `[data-action]`)
//             is at least 44 by 44 px, the box a finger hits (WCAG 2.5.5; the tokens'
//             `--hit-target`); judged at 390 px;
//   overflow  no text inside `root` paints outside a box that holds it: a spill past a box that
//             shows its overflow, or a clip by one that hides it without an ellipsis. A box that
//             scrolls or truncates with an ellipsis on purpose is allowed; `sr-only`, hidden and
//             fully transparent words are not painted, so not judged;
//   hscroll   the page does not scroll sideways, naming what inside `root` reaches past its edge;
//   tone      a destructive menu item and its glyph compute to `--tone-failed`, a field's leading
//             glyph to `--ink-3`;
//   still     opening each live disclosure moves nothing above it or in its own header line;
//   focus     every element Tab reaches shows a focus ring it does not show unfocused, unless it
//             is a forced-focus specimen (`data-focus`);
//   sheet     the catalogue's live sheet opens as a bottom sheet, takes focus, has touch-sized
//             controls, closes on Escape and gives focus back.
// A violation names the `[data-look-state]` it sits in ("page" outside one) and whether it sits
// inside a `[data-planted]` element, so a control can tell its plant from the page's own faults.

import { once } from "node:events";
import { createServer as createNetServer } from "node:net";

import { Predicate, Schema } from "effect";
import type { Page } from "playwright";

/* oxlint-disable no-await-in-loop -- a rule drives the page one step after another, on purpose */

export const LOOPBACK = "127.0.0.1";

/** The smallest touch target, px (the tokens' `--hit-target`). */
export const HIT_TARGET_PX = 44;

/** How far text may pass its box before it counts, px: subpixel rounding. */
export const OVERFLOW_TOLERANCE_PX = 1;

/** One element that broke a rule: the catalogue state it is in, what it is, and the numbers. */
export const Violation = Schema.Struct({
  state: Schema.String,
  element: Schema.String,
  detail: Schema.String,
  planted: Schema.Boolean,
});

export type Violation = typeof Violation.Type;

export const Violations = Schema.Array(Violation);

export const decodeViolations = Schema.decodeUnknownSync(Violations);

/** A rule's run on one page: how many things it looked at, and those that broke it. */
export const Checked = Schema.Struct({
  checked: Schema.Int,
  violations: Violations,
});

export type Checked = typeof Checked.Type;

export const decodeChecked = Schema.decodeUnknownSync(Checked);

/** What a rule run in the page returns, before it is decoded. */
export interface RuleRun {
  readonly checked: number;
  readonly violations: Array<Violation>;
}

export const decodeBoolean = Schema.decodeUnknownSync(Schema.Boolean);

export const freePort = async (): Promise<number> => {
  const server = createNetServer().listen(0, LOOPBACK);

  await once(server, "listening");

  const address = server.address();

  server.close();
  await once(server, "close");

  if (address === null || Predicate.isString(address)) {
    throw new Error(
      "judges/lib/LookRules.ts: the kernel gave no loopback port."
    );
  }

  return address.port;
};

// ---------------------------------------------------------------------------------------------
// The rules, run in the page. Each is a self-contained function: Playwright sends its source.

/** Controls a finger hits, and every element smaller than the target. */
export const touchRule = (target: number): RuleRun => {
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
export const overflowRule = ({
  tolerance,
  root,
}: {
  readonly tolerance: number;
  readonly root: string;
}): RuleRun => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
  const stateOf = (element: Element): string =>
    element.closest<HTMLElement>("[data-look-state]")?.dataset.lookState ??
    "page";

  // Words for assistive technology only (`sr-only`: a 1 px box that clips them, on the text's
  // element or any element around it inside `within`) are never painted, nor is text that is
  // hidden or fully transparent (a row action that shows on hover).
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
  const unpainted = (element: Element, within: Element): boolean => {
    if (
      !element.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
      })
    ) {
      return true;
    }

    for (
      let around: Element | null = element;
      around !== null && around !== within.parentElement;
      around = around.parentElement
    ) {
      const holder = around.getBoundingClientRect();

      if (
        holder.width <= 1 &&
        holder.height <= 1 &&
        getComputedStyle(around).overflow === "hidden"
      ) {
        return true;
      }
    }

    return false;
  };

  const scope = document.querySelector(root);

  if (scope === null) {
    return {
      checked: 0,
      violations: [
        {
          state: "page",
          element: root,
          detail: `no ${root} on the page`,
          planted: false,
        },
      ],
    };
  }

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
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

    if (unpainted(parent, scope)) {
      continue;
    }

    checked += 1;

    for (
      let box: Element | null = parent;
      box !== null && box !== scope.parentElement;
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
export const hscrollRule = (root: string): Array<Violation> => {
  const page = document.documentElement;

  if (page.scrollWidth <= page.clientWidth) {
    return [];
  }

  const past = [...document.querySelectorAll(`${root} *`)].filter(
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

/** Elements whose meaning names a colour token, against the colour that token computes to. */
export const toneRule = (): RuleRun => {
  const EXPECTED: ReadonlyArray<readonly [string, string, string]> = [
    [
      '[role="menuitem"][data-variant="destructive"]',
      "--tone-failed",
      "destructive menu item",
    ],
    [
      '[role="menuitem"][data-variant="destructive"] svg',
      "--tone-failed",
      "destructive menu item's glyph",
    ],
    ['[data-slot="field-shell"] > svg', "--ink-3", "field's leading glyph"],
  ];

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
  const tokenColour = (scope: Element, token: string): string => {
    const probe = document.createElement("span");

    probe.style.setProperty("color", `var(${token})`);
    scope.append(probe);
    const colour = getComputedStyle(probe).color;

    probe.remove();

    return colour;
  };

  let checked = 0;

  const violations = EXPECTED.flatMap(([selector, token, what]) =>
    [...document.querySelectorAll(selector)].flatMap((element) => {
      checked += 1;

      const actual = getComputedStyle(element).color;
      const expected = tokenColour(element.parentElement ?? element, token);

      return actual === expected
        ? []
        : [
            {
              state:
                element.closest<HTMLElement>("[data-look-state]")?.dataset
                  .lookState ?? "page",
              element: what,
              detail: `computes ${actual}, ${token} is ${expected}`,
              planted: element.closest("[data-planted]") !== null,
            },
          ];
    })
  );

  return { checked, violations };
};

/**
 * Opens each live disclosure and checks that nothing above it, and nothing in its header line,
 * moved; then folds it again. Async: it waits two frames for each render.
 */
export const stillRule = async (tolerance: number): Promise<RuleRun> => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
  const frames = async (): Promise<void> => {
    // oxlint-disable-next-line promise/avoid-new -- in the page a frame is only a callback
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  };

  const triggers = [
    ...document.querySelectorAll<HTMLElement>("[data-look-live-disclosure]"),
  ];

  const found: Array<Violation> = [];
  let checked = 0;

  for (const trigger of triggers) {
    const specimen = trigger.closest("[data-look-state]") ?? document.body;

    trigger.scrollIntoView({ block: "center" });
    await frames();

    const { top } = trigger.getBoundingClientRect();

    // The chevron turns in place on purpose: its box stays put, but its path's box turns with it,
    // so the shapes inside a glyph are not watched.
    const watched = [
      trigger,
      ...[...trigger.querySelectorAll("*")].filter(
        (element) => element.parentElement?.closest("svg") === null
      ),
      ...[...specimen.querySelectorAll("*")].filter(
        (element) =>
          !trigger.contains(element) &&
          element.getBoundingClientRect().bottom <= top + tolerance
      ),
    ];

    const before = watched.map((element) => element.getBoundingClientRect());
    const was = trigger.getAttribute("aria-expanded");

    trigger.click();
    await frames();

    const toggled = trigger.getAttribute("aria-expanded") !== was;

    const moved = watched.flatMap((element, index) => {
      const from = before[index];
      const to = element.getBoundingClientRect();

      if (from === undefined) {
        return [];
      }

      const by = Math.max(
        Math.abs(from.top - to.top),
        Math.abs(from.left - to.left),
        Math.abs(from.width - to.width),
        Math.abs(from.height - to.height)
      );

      return by > tolerance ? [{ element, by }] : [];
    });

    if (toggled) {
      trigger.click();
      await frames();
    }

    checked += 1;

    const [first] = moved;

    if (!toggled || first !== undefined) {
      found.push({
        state:
          trigger.closest<HTMLElement>("[data-look-state]")?.dataset
            .lookState ?? "page",
        element: `disclosure "${(trigger.textContent ?? "").trim().slice(0, 40)}"`,
        detail: toggled
          ? `opening it moved ${String(moved.length)} element(s) at or above its header, the first (${first?.element.tagName.toLowerCase() ?? ""}) by ${first?.by.toFixed(1) ?? "0"} px`
          : "a click did not toggle it",
        planted: trigger.closest("[data-planted]") !== null,
      });
    }
  }

  return { checked, violations: found };
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
export const focusRule = async (page: Page): Promise<Checked> => {
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

/** The open sheet over the page: where it sits, where focus is, and its controls' sizes. */
const sheetProbe = () => {
  const panel = document.querySelector('[data-testid="look-live-sheet"]');

  if (panel === null) {
    return null;
  }

  const rect = panel.getBoundingClientRect();

  return {
    focusInside: panel.contains(document.activeElement),
    bottom: rect.bottom,
    width: rect.width,
    viewportWidth: document.documentElement.clientWidth,
    viewportHeight: window.innerHeight,
    planted: document.querySelector("#look-planted-sheet") !== null,
    controls: [
      ...panel.querySelectorAll("button, a[href], input, textarea"),
    ].map((control) => {
      const box = control.getBoundingClientRect();

      return {
        name: (
          control.getAttribute("aria-label") ??
          control.textContent ??
          ""
        ).trim(),
        width: box.width,
        height: box.height,
      };
    }),
  };
};

const SheetProbe = Schema.NullOr(
  Schema.Struct({
    focusInside: Schema.Boolean,
    bottom: Schema.Finite,
    width: Schema.Finite,
    viewportWidth: Schema.Finite,
    viewportHeight: Schema.Finite,
    planted: Schema.Boolean,
    controls: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        width: Schema.Finite,
        height: Schema.Finite,
      })
    ),
  })
);

const decodeSheetProbe = Schema.decodeUnknownSync(SheetProbe);

/** Whether the focused element is the catalogue's "Open sheet" button. */
const focusOnOpener = (): boolean =>
  document.activeElement?.closest('[data-testid="look-open-sheet"]') !== null &&
  document.activeElement !== null;

/** Opens the sheet over the page and holds it to the sheet rule; leaves it closed. */
export const sheetRule = async (page: Page): Promise<Checked> => {
  const found: Array<Violation> = [];

  const fail = (element: string, detail: string, planted = false) =>
    found.push({ state: "sheet/live", element, detail, planted });

  await page.click('[data-testid="look-open-sheet"]');

  const opened = await page
    .locator('[data-testid="look-live-sheet"]')
    .waitFor({ state: "visible", timeout: 5000 })
    .then(
      () => true,
      () => false
    );

  if (!opened) {
    fail("sheet", "Open sheet did not open it");

    return { checked: 0, violations: found };
  }

  await page.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))"
  );

  const probe = decodeSheetProbe(await page.evaluate(sheetProbe));

  if (probe === null) {
    fail("sheet", "the sheet left the page while open");

    return { checked: 0, violations: found };
  }

  if (!probe.focusInside) {
    fail("sheet", "focus did not move into the sheet");
  }

  if (
    Math.abs(probe.bottom - probe.viewportHeight) > 1 ||
    Math.abs(probe.width - probe.viewportWidth) > 1
  ) {
    fail(
      "sheet",
      `not a bottom sheet: bottom ${probe.bottom.toFixed(1)} of ${String(probe.viewportHeight)}, width ${probe.width.toFixed(1)} of ${String(probe.viewportWidth)}`
    );
  }

  for (const control of probe.controls) {
    if (
      control.width + 0.5 < HIT_TARGET_PX ||
      control.height + 0.5 < HIT_TARGET_PX
    ) {
      fail(
        `button "${control.name}"`,
        `${control.width.toFixed(1)} by ${control.height.toFixed(1)} px`,
        probe.planted
      );
    }
  }

  await page.keyboard.press("Escape");

  const closed = await page
    .locator('[data-testid="look-live-sheet"]')
    .waitFor({ state: "detached", timeout: 5000 })
    .then(
      () => true,
      () => false
    );

  if (!closed) {
    fail("sheet", "Escape did not close it");
  } else if (!decodeBoolean(await page.evaluate(focusOnOpener))) {
    fail("sheet", "focus did not return to Open sheet");
  }

  return { checked: probe.controls.length, violations: found };
};
