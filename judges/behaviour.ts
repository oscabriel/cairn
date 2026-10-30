/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one check after another, on purpose */
// The parity behaviour judge (plan 4F): what a screenshot cannot show, driven in the real client
// over a real in-process brain (judges/fixtures/parity/CairnApp.ts) seeded with t3code's imported
// thread. Each check prints one line; the run ends with one JSON line.
//
//   node judges/behaviour.ts [--only <check,...>] [--out <dir>] [--strict] [--ui classic|next]
//
// `--ui next` (look track L0, ADR 0040) runs every check on the `next` views: each page the judge
// opens carries `?ui=next`, and before a check's body runs the page must show the `next` frame
// (`#root[data-ui="next"]`); the report is `behaviour-next.json`. With `--ui classic`, the default,
// a page showing the `next` frame fails its check instead, so classic runs stay classic.
//
// Checks:
//   footer-<width>   the composer footer's blocks (full, icon-only, hidden) and its overflow button
//                    at 1440, 1180, 980, 820 and 390 equal what t3code showed at the same widths
//                    (the hero landmark files in the committed baseline);
//   trigger-slash    `/` at line start opens the slash-command menu;
//   trigger-literal  `/tmp/x` leaves no menu open;
//   trigger-at       `@READ` lists README (the time from the keystroke is recorded);
//   trigger-skill    `$` opens the skill menu;
//   paste-image      a PNG `File` pasted through `DataTransfer` makes one attachment chip;
//   paste-long-text  text over 32 KiB pasted becomes an attachment, not editor text;
//   paste-inline     Mod+Shift+V keeps the same text inline (Chromium's own paste command);
//   drop             an image and a text file dropped on the composer make two chips;
//   drafts-reload    the hero's draft survives a reload of the page's URL (t3code moves the hero to
//                    `/draft/<id>`, so its reload restores the draft);
//   drafts-separate  a thread's draft stays with the thread and out of the hero;
//   hero-launch      20 sends from the hero each land on `/t/<id>` and show the sent words in a
//                    user row, and "This thread does not exist." never appears, not even for one
//                    mutation (a DOM observer watches the whole time; the seed's flash was short).
//                    The socket holds each `thread.launch` frame for 500 ms, so the page always
//                    subscribes before the launch reaches the in-process brain, as on a slow link;
//   settle-undo      Settle moves the row to Settled, Undo within 5 s brings it back;
//   snooze           a snooze preset from the row menu takes the row out of the active list;
//   search           search finds the thread by title and shows nothing for a miss;
//   menu-items       the row menu's top level is the ThreadActionMenuId list (client-logic
//                    ThreadMenu.ts), with t3code's trimmed items absent (items are read by Cairn's
//                    `data-menu-id` hook);
//   mobile-sheet     at 390 the sidebar opens as a sheet and closes on navigation;
//   soft-keyboard    WebKit at iPhone width (Chromium's iPhone emulation where WebKit cannot run,
//                    named in the result), with the soft keyboard emulated through a shrunken
//                    `visualViewport`: Enter inserts a newline and sends nothing.
//
// `--ui next` judges the `next` shell (look track L6) instead of the classic sidebar: its seed makes
// the parity thread its project's project thread, gives it six managed threads (one in each state,
// one of them a real thread) and adds two rail projects (one with a favicon in its root). The
// classic sidebar's own checks (settle-undo, search, menu-items, snooze) do not run there, since the
// shell has no shelves, search or row menu (the user, 2026-10-29); these run instead, at 1,440 and
// 390 px, each saving its states as screenshots under `<out>/shell-next/`:
//   shell-rail-<w>        one squircle bubble per folder project (a low corner radius, not a
//                         circle), the favicon drawn edge to edge in its bubble, a letter for a
//                         project with none, the selected one marked; a bubble opens its project
//                         (its project thread, or the composer when it has none);
//   shell-list-<w>        the project thread on top opens it under the new header ("project
//                         thread"), and under it the managed threads, newest first, each with
//                         its status mark and word; no Active, Settled, Pinned or Snoozed group;
//   shell-managed-<w>     a managed thread opens, says it is managed, and takes a message that
//                         shows in its transcript; a parked one shows the hold banner with Retry;
//   shell-foot-<w>        Usage opens the usage page and Settings the settings page, and the foot
//                         holds no meter;
//   shell-scratch-<w>     Ctrl+J (1,440) or the header's button (390) opens the scratch overlay; a
//                         message sent there shows with its answer; hiding and showing keeps it;
//                         Clear deletes it and shows the empty overlay;
//   shell-refresh-1440    Refresh asks first (Cancel keeps the thread), then starts a new project
//                         thread with the typed message, opens it and lists it on top.
// Exits 0 when every check ran and the report was written; `--strict` also requires every check
// to pass, which is wave 5's bar.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { Effect, Predicate, Schema } from "effect";
import { chromium, devices, webkit } from "playwright";
import type { Browser, BrowserContextOptions, Page } from "playwright";

import {
  importT3Thread,
  parseT3ThreadExport,
} from "../apps/server/src/brain/conformance/fixtures/T3Import.ts";
import { startCairn } from "./fixtures/parity/CairnApp.ts";
import type { ShellSeed } from "./fixtures/parity/CairnApp.ts";
import { LandmarkFile, readLandmarks } from "./fixtures/parity/Landmarks.ts";

const root = path.join(import.meta.dirname, "..");

const BASELINE = path.join(root, "judges/fixtures/parity/t3@fe27e8e3");

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    out: {
      type: "string",
      default: path.join(
        homedir(),
        "Developer/agent-artifacts/cairn/v2/phase-1-parity"
      ),
    },
    strict: { type: "boolean", default: false },
    ui: { type: "string", default: "classic" },
  },
});

if (values.ui !== "classic" && values.ui !== "next") {
  throw new Error(`--ui is classic or next, not ${values.ui}`);
}

const { ui } = values;

/** `url` as the judge opens it: with `?ui=next` when judging the `next` views. */
const withUi = (url: string): string => {
  if (ui === "classic") {
    return url;
  }

  const opened = new URL(url);

  opened.searchParams.set("ui", "next");

  return opened.href;
};

/** Fails unless the page shows the views this run judges. */
const expectUi = async (page: Page) => {
  const frames = page.locator('#root[data-ui="next"]');

  if (ui === "next") {
    await frames.waitFor({ state: "attached", timeout: 15_000 });
  } else if ((await frames.count()) > 0) {
    throw new Error("the page shows the next views on a classic run");
  }
};

const only = new Set(values.only?.split(","));

const wanted = (name: string) => only.size === 0 || only.has(name);

/** The top-level row menu items Cairn keeps (ThreadMenu.ts), and t3code's that it trims. */
const MENU_KEPT = [
  "Pin thread",
  "Settle thread",
  "Snooze",
  "Rename thread",
  "Mark unread",
  "Auto-settle behavior",
  "Copy",
  "Archive thread",
  "Delete",
];

const MENU_TRIMMED = [
  "New thread on main",
  "Regenerate title",
  "Project settings",
];

const decodeLandmarks = Schema.decodeUnknownSync(
  Schema.fromJsonString(LandmarkFile)
);

interface CheckResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const results: Array<CheckResult> = [];

const record = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "pass" : "FAIL"} ${name}: ${detail}`);
};

const exported = await Effect.runPromise(
  parseT3ThreadExport(
    readFileSync(path.join(BASELINE, "thread/thread.json"), "utf-8")
  )
);

/** The managed threads `--ui next` seeds, oldest first; the list shows them newest first. */
const MANAGED_SEED: ShellSeed["managed"] = [
  { title: "Map the favicon resolver", state: "idle", usable: true },
  { title: "Brief: port the fold line tallies", state: "done", usable: false },
  { title: "Steps panel projection", state: "parked", usable: false },
  { title: "Probe the bridge usage endpoint", state: "failed", usable: false },
  { title: "Review: steps panel", state: "working", usable: false },
  {
    title: "Pick the budget meter's thresholds",
    state: "asking",
    usable: false,
  },
];

/** The `next` shell's seed: managed threads and two more rail projects, one with a favicon. */
const SHELL_SEED: ShellSeed = {
  managed: MANAGED_SEED,
  projects: [
    { title: "oscargabriel-dev", favicon: true },
    { title: "myr", favicon: false },
  ],
};

const app = await startCairn(
  {
    projectTitle: exported.projectTitle,
    threadTitle: exported.title,
    entries: importT3Thread(exported).entries,
  },
  ui === "next" ? SHELL_SEED : { managed: [], projects: [] }
);

const threadUrl = withUi(app.threadUrl);

const desktop = (width: number): BrowserContextOptions => ({
  viewport: { width, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
  reducedMotion: "reduce",
});

const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark",
  reducedMotion: "reduce",
};

const editor = (page: Page) =>
  page.locator('[data-testid="composer-editor"]').first();

const menu = (page: Page, trigger: string) =>
  page.locator(`[data-testid="composer-menu"][data-trigger="${trigger}"]`);

const chips = (page: Page) => page.locator('[data-testid="attachment-chip"]');

const settledCount = async (page: Page) =>
  await page.getByTestId("sidebar-settled-shelf-toggle").first().textContent();

/** Runs one check in a fresh context on `url`; a throw is a failure with its message. */
const check = async (
  browser: Browser,
  name: string,
  options: BrowserContextOptions,
  url: string,
  body: (page: Page) => Promise<string>,
  passes: (detail: string) => boolean = () => true
) => {
  if (!wanted(name)) {
    return;
  }

  const context = await browser.newContext(options);
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle" });

    // Vite may reload the page once while it optimizes a dependency it met late; one more load.
    await editor(page)
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(async () => {
        await page.goto(url, { waitUntil: "networkidle" });
        await editor(page).waitFor({ state: "visible", timeout: 15_000 });
      });

    await expectUi(page);

    const detail = await body(page);

    record(name, passes(detail), detail);
  } catch (error) {
    record(name, false, String(error).split("\n")[0] ?? "failed");
  } finally {
    await context.close();
  }
};

/** A check of the classic sidebar, which the `next` shell does not have; skipped on `next`. */
const classicCheck: typeof check = async (...args) => {
  if (ui === "classic") {
    await check(...args);
  }
};

/** Pastes `files` or `text` into the editor through a real `ClipboardEvent`. */
const paste = async (
  page: Page,
  input: {
    readonly text?: string;
    readonly png?: boolean;
  }
) => {
  await editor(page).click();
  await editor(page).evaluate((element, { text, png }) => {
    const data = new DataTransfer();

    if (text !== undefined) {
      data.setData("text/plain", text);
    }

    if (png === true) {
      const bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        ),
        (character) => character.codePointAt(0) ?? 0
      );

      data.items.add(
        new File([bytes], "screenshot.png", { type: "image/png" })
      );
    }

    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      })
    );
  }, input);
};

const value = async (page: Page) => await editor(page).inputValue();

/** Where `--ui next` saves the shell's states, for the look round. */
const SHOTS = path.join(values.out, "shell-next");

/** Saves the page as the shell state `name` at `width`. */
const shot = async (page: Page, name: string, width: number) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`) });
};

/** The context a shell check opens at `width`: the phone at 390, a desktop window otherwise. */
const shellContext = (width: number): BrowserContextOptions =>
  width === 390 ? PHONE : desktop(width);

/** Opens the phone's sidebar sheet, when the page is a phone; the column shows on a desktop. */
const openSidebar = async (page: Page, width: number) => {
  if (width === 390) {
    await page
      .getByRole("button", { name: "Toggle main sidebar" })
      .first()
      .click();
    await page.getByTestId("sidebar-sheet").waitFor({ state: "attached" });
  }
};

/** The visible copy of the shell's sidebar: the sheet on a phone, the column on a desktop. */
const sidebarOf = (page: Page, width: number) =>
  width === 390
    ? page.getByTestId("sidebar-sheet")
    : page.getByTestId("shell-column");

/** The `next` shell's checks (look track L6), at 1,440 and 390 px. */
const shellChecks = async (browser: Browser, hero: string) => {
  const projectThreadUrl = threadUrl;

  // Each check at both widths before the next one, so a check that changes a thread (a message
  // to a managed thread) runs after every check that reads it as seeded.
  const perWidth: ReadonlyArray<(width: 1440 | 390) => Promise<void>> = [
    async (width) => {
      await check(
        browser,
        `shell-rail-${width}`,
        shellContext(width),
        projectThreadUrl,
        async (page) => {
          await openSidebar(page, width);

          const side = sidebarOf(page, width);
          const bubbles = side.getByTestId("rail-project");

          await side
            .getByTestId("rail-favicon")
            .first()
            .waitFor({ state: "visible", timeout: 10_000 });
          await page.waitForTimeout(400);
          await shot(page, "rail-and-list", width);

          const read = await bubbles.evaluateAll((elements) =>
            elements.map((element) => {
              const box = element.getBoundingClientRect();
              const image = element.querySelector("img");
              const imageBox = image?.getBoundingClientRect();

              const radius = Number(
                getComputedStyle(element).borderTopLeftRadius.replace("px", "")
              );

              return {
                name: element.getAttribute("aria-label") ?? "",
                current: element.getAttribute("aria-current") === "true",
                width: box.width,
                radius,
                favicon:
                  image !== null &&
                  image.complete &&
                  image.naturalWidth > 0 &&
                  getComputedStyle(image).opacity === "1",
                fill:
                  imageBox === undefined
                    ? 0
                    : Math.min(imageBox.width, imageBox.height) / box.width,
                letter:
                  element.querySelector('[data-testid="rail-letter"]')
                    ?.textContent ?? "",
              };
            })
          );

          const names = read.map((bubble) => bubble.name.split(",")[0]);

          const dev = read.find((bubble) =>
            bubble.name.startsWith("oscargabriel-dev")
          );

          const myr = read.find((bubble) => bubble.name.startsWith("myr"));

          const selected = read
            .filter((bubble) => bubble.current)
            .map((bubble) => bubble.name.split(",")[0]);

          // A squircle: rounded, with a radius well under the circle's half width.
          const squircles = read.every(
            (bubble) => bubble.radius > 2 && bubble.radius < bubble.width * 0.3
          );

          await side.getByRole("button", { name: /^myr/u }).click();
          // The hero, which moves to a draft's address as soon as it holds one.
          await page.waitForURL(
            (url) => url.pathname === "/" || url.pathname.startsWith("/new/"),
            { timeout: 5000 }
          );
          await openSidebar(page, width);

          const empty = await sidebarOf(page, width)
            .getByTestId("shell-no-project-thread")
            .count();

          await sidebarOf(page, width)
            .getByTestId("rail-project")
            .first()
            .click();
          await page.waitForURL(/\/t\//u, { timeout: 5000 });

          return `bubbles ${JSON.stringify(names)}, selected ${JSON.stringify(selected)}, squircles ${squircles}, favicon ${dev?.favicon ?? false} fills ${(dev?.fill ?? 0).toFixed(2)}, letter ${myr?.letter ?? ""}, empty project ${empty}, back at ${new URL(page.url()).pathname === new URL(projectThreadUrl).pathname}`;
        },
        (detail) =>
          detail.startsWith(
            `bubbles ["${exported.projectTitle}","oscargabriel-dev","myr"], selected ["${exported.projectTitle}"], squircles true, favicon true fills `
          ) &&
          Number(/fills (?<fill>[\d.]+)/u.exec(detail)?.groups?.fill ?? 0) >=
            0.9 &&
          detail.endsWith("letter M, empty project 1, back at true")
      );
    },
    async (width) => {
      await check(
        browser,
        `shell-list-${width}`,
        shellContext(width),
        hero,
        async (page) => {
          await openSidebar(page, width);

          const side = sidebarOf(page, width);

          const titleTexts = await side
            .getByTestId("shell-row-title")
            .allTextContents();

          const titles = titleTexts.map((text) => text.trim());

          const marks = await side
            .getByTestId("shell-managed-thread")
            .evaluateAll((rows) =>
              rows.map(
                (row) =>
                  row
                    .querySelector('[data-testid="shell-status"]')
                    ?.textContent?.trim() ?? ""
              )
            );

          const groups = await side
            .getByText(/^(?:Active|Settled|Pinned|Snoozed)$/u)
            .count();

          await side.getByTestId("shell-project-thread").click();
          await page.waitForURL(/\/t\//u, { timeout: 5000 });
          await page
            .getByTestId("next-header-role")
            .waitFor({ state: "attached", timeout: 5000 });
          await page.waitForTimeout(400);
          await shot(page, "project-thread", width);

          // Read as text: the phone's header hides the word to keep room for the title.
          const role = (
            (await page.getByTestId("next-header-role").textContent()) ?? ""
          ).trim();

          return `titles ${JSON.stringify(titles)}, marks ${JSON.stringify(marks)}, groups ${groups}, opened ${new URL(page.url()).pathname === new URL(projectThreadUrl).pathname}, role ${role}`;
        },
        (detail) =>
          detail ===
          `titles ${JSON.stringify(MANAGED_SEED.map((seed) => seed.title).toReversed())}, marks ${JSON.stringify(["Approval", "Working", "Failed", "Parked", "Done", "Idle"])}, groups 0, opened true, role project thread`
      );
    },
    async (width) => {
      await check(
        browser,
        `shell-managed-${width}`,
        shellContext(width),
        projectThreadUrl,
        async (page) => {
          await openSidebar(page, width);
          await sidebarOf(page, width)
            .getByTestId("shell-managed-thread")
            .filter({ hasText: "Steps panel projection" })
            .click();
          await page.getByTestId("thread-hold").waitFor({ timeout: 5000 });
          await page.waitForTimeout(300);
          await shot(page, "hold-parked", width);

          const hold =
            (await page.getByTestId("thread-hold").textContent()) ?? "";

          const retry = await page
            .getByTestId("thread-hold")
            .getByRole("button", { name: "Retry" })
            .count();

          await openSidebar(page, width);
          await sidebarOf(page, width)
            .getByTestId("shell-managed-thread")
            .filter({ hasText: "Map the favicon resolver" })
            .click();
          await page.waitForURL(/\/t\//u, { timeout: 5000 });
          await editor(page).waitFor({ state: "visible" });

          const words = `a message to a managed thread ${Date.now()}`;

          await editor(page).click();
          await page.keyboard.type(words);
          await page.keyboard.press("Enter");

          const shown = await page
            .locator('[data-message-role="user"]', { hasText: words })
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .then(
              () => true,
              () => false
            );

          await page.waitForTimeout(400);
          await shot(page, "managed-thread", width);

          const title =
            (await page.getByTestId("next-header-title").textContent()) ?? "";

          return `hold ${hold.includes("Parked")}, retry ${retry}, title ${title}, sent shown ${shown}`;
        },
        (detail) =>
          detail ===
          "hold true, retry 1, title Map the favicon resolver, sent shown true"
      );
    },
    async (width) => {
      await check(
        browser,
        `shell-foot-${width}`,
        shellContext(width),
        hero,
        async (page) => {
          await openSidebar(page, width);

          const foot = sidebarOf(page, width).getByTestId("shell-foot");

          const meters = await foot
            .locator('[role="meter"], [role="progressbar"], meter, progress')
            .count();

          await foot.getByTestId("shell-usage").click();
          await page.getByTestId("usage-page").waitFor({ timeout: 5000 });

          const usageAt = new URL(page.url()).pathname;

          await shot(page, "usage", width);
          await openSidebar(page, width);
          await sidebarOf(page, width)
            .getByTestId("shell-foot")
            .getByTestId("shell-settings")
            .click();
          await page.waitForURL((url) => url.pathname === "/settings", {
            timeout: 5000,
          });

          return `meters ${meters}, usage at ${usageAt}, settings at ${new URL(page.url()).pathname}`;
        },
        (detail) =>
          detail === "meters 0, usage at /usage, settings at /settings"
      );
    },
    async (width) => {
      await check(
        browser,
        `shell-scratch-${width}`,
        shellContext(width),
        projectThreadUrl,
        async (page) => {
          const overlay = page.getByTestId("scratch-overlay");

          // The phone has no keyboard shortcut: its header's button opens the overlay.
          await (width === 390
            ? page.getByTestId("open-scratch").click()
            : page.keyboard.press("Control+j"));
          await overlay.waitFor({ state: "visible", timeout: 5000 });

          const box = await overlay.boundingBox();
          const empty = await overlay.getByTestId("scratch-empty").count();

          await shot(page, "scratch-empty", width);

          const words = `a scratch question ${Date.now()}`;

          await overlay.getByTestId("scratch-editor").click();
          await page.keyboard.type(words);
          await page.keyboard.press("Enter");

          const sent = await overlay
            .locator('[data-message-role="user"]', { hasText: words })
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .then(
              () => true,
              () => false
            );

          const answered = await overlay
            .getByText("Noted.")
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .then(
              () => true,
              () => false
            );

          await page.waitForTimeout(300);
          await shot(page, "scratch-thread", width);

          // Hidden and shown again, it keeps its thread.
          if (width === 390) {
            await overlay.getByTestId("scratch-close").click();
            await overlay.waitFor({ state: "detached", timeout: 5000 });
            await page.getByTestId("open-scratch").click();
          } else {
            await page.keyboard.press("Control+j");
            await overlay.waitFor({ state: "detached", timeout: 5000 });
            await page.keyboard.press("Control+j");
          }

          const kept = await overlay
            .locator('[data-message-role="user"]', { hasText: words })
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .then(
              () => true,
              () => false
            );

          await overlay.getByTestId("scratch-clear").click();

          const cleared = await overlay
            .getByTestId("scratch-empty")
            .waitFor({ state: "visible", timeout: 5000 })
            .then(
              () => true,
              () => false
            );

          return `opened ${box !== null}, wide ${(box?.width ?? 0) >= (width === 390 ? 360 : 600)}, empty ${empty}, sent ${sent}, answered ${answered}, kept ${kept}, cleared ${cleared}`;
        },
        (detail) =>
          detail ===
          "opened true, wide true, empty 1, sent true, answered true, kept true, cleared true"
      );
    },
  ];

  for (const run of perWidth) {
    for (const width of [1440, 390] as const) {
      await run(width);
    }
  }

  // Last of the shell's checks: a refresh archives the seeded project thread.
  await check(
    browser,
    "shell-refresh-1440",
    desktop(1440),
    projectThreadUrl,
    async (page) => {
      const confirm = page.getByTestId("refresh-confirm");

      await page.getByTestId("refresh-project-thread").click();
      await confirm.waitFor({ state: "visible", timeout: 5000 });
      await page.getByTestId("refresh-confirm-cancel").click();
      await confirm.waitFor({ state: "detached", timeout: 5000 });

      const kept =
        new URL(page.url()).pathname === new URL(projectThreadUrl).pathname;

      await page.getByTestId("refresh-project-thread").click();
      await confirm.waitFor({ state: "visible", timeout: 5000 });

      const words = `a fresh project thread ${Date.now()}`;

      await page.getByTestId("refresh-text").fill(words);
      await shot(page, "refresh-confirm", 1440);
      await page.getByTestId("refresh-confirm-go").click();
      await page.waitForURL(
        (url) =>
          url.pathname.startsWith("/t/") &&
          url.pathname !== new URL(projectThreadUrl).pathname,
        { timeout: 10_000 }
      );

      const shown = await page
        .locator('[data-message-role="user"]', { hasText: words })
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(
          () => true,
          () => false
        );

      // The moved mark arrives with the shell stream's next items.
      const top = await page
        .getByTestId("shell-column")
        .locator('[data-testid="shell-project-thread"][aria-current="page"]')
        .waitFor({ timeout: 10_000 })
        .then(
          () => "page",
          () => "none"
        );

      const managed = await page
        .getByTestId("shell-column")
        .getByTestId("shell-managed-thread")
        .count();

      await page.waitForTimeout(300);
      await shot(page, "refreshed", 1440);

      return `cancel kept ${kept}, new thread shown ${shown}, on top ${top === "page"}, managed ${managed}`;
    },
    (detail) =>
      detail ===
      "cancel kept true, new thread shown true, on top true, managed 0"
  );
};

const chromiumBrowser = await chromium.launch();

try {
  const hero = withUi(`${app.origin}/`);

  if (ui === "next") {
    await shellChecks(chromiumBrowser, hero);
  }

  // Footer folding against t3code's readings at the same widths.
  for (const [width, file] of [
    [1440, "1440-hero"],
    [1180, "1180-footer"],
    [980, "980-footer"],
    [820, "820-footer"],
    [390, "390-hero"],
  ] as const) {
    const expected = decodeLandmarks(
      readFileSync(path.join(BASELINE, `hero/${file}.landmarks.json`), "utf-8")
    ).footer;

    await check(
      chromiumBrowser,
      `footer-${width}`,
      width === 390 ? PHONE : desktop(width),
      hero,
      async (page) => {
        await page.waitForTimeout(800);

        const { footer: actual } = await readLandmarks(page);

        const same =
          JSON.stringify(actual.blocks) === JSON.stringify(expected.blocks) &&
          actual.overflow === expected.overflow;

        return `${same ? "same" : "differs"}: t3code ${JSON.stringify(expected)}, Cairn ${JSON.stringify(actual)}`;
      },
      (detail) => detail.startsWith("same")
    );
  }

  await check(
    chromiumBrowser,
    "trigger-slash",
    desktop(1440),
    hero,
    async (page) => {
      await editor(page).click();
      await page.keyboard.type("/");
      await menu(page, "slash-command").waitFor({ timeout: 3000 });

      return "slash-command menu open";
    }
  );

  await check(
    chromiumBrowser,
    "trigger-literal",
    desktop(1440),
    hero,
    async (page) => {
      await editor(page).click();
      await page.keyboard.type("/tmp/x");
      await page.waitForTimeout(600);

      const open = await page
        .locator('[data-testid="composer-menu"]')
        .filter({ visible: true })
        .count();

      return open === 0 ? "no menu" : `${open} menu open`;
    },
    (detail) => detail === "no menu"
  );

  await check(
    chromiumBrowser,
    "trigger-at",
    desktop(1440),
    hero,
    async (page) => {
      await editor(page).click();

      const started = performance.now();

      await page.keyboard.type("@READ");
      await menu(page, "path")
        .getByText("README", { exact: false })
        .first()
        .waitFor({ timeout: 3000 });

      return `README listed ${Math.round(performance.now() - started)} ms after the first key`;
    }
  );

  await check(
    chromiumBrowser,
    "trigger-skill",
    desktop(1440),
    hero,
    async (page) => {
      await editor(page).click();
      await page.keyboard.type("$");
      await menu(page, "skill").waitFor({ timeout: 3000 });

      return "skill menu open";
    }
  );

  await check(
    chromiumBrowser,
    "paste-image",
    desktop(1440),
    hero,
    async (page) => {
      await paste(page, { png: true });
      await page.waitForTimeout(1500);

      return `${await chips(page).count()} chip`;
    },
    (detail) => detail === "1 chip"
  );

  const LONG_TEXT = "a long pasted log line\n".repeat(1500);

  await check(
    chromiumBrowser,
    "paste-long-text",
    desktop(1440),
    hero,
    async (page) => {
      await paste(page, { text: LONG_TEXT });
      await page.waitForTimeout(1500);

      const text = await value(page);

      return `${await chips(page).count()} chip, editor holds ${text.length} characters`;
    },
    (detail) => detail.startsWith("1 chip, editor holds 0 ")
  );

  await check(
    chromiumBrowser,
    "paste-inline",
    {
      ...desktop(1440),
      permissions: ["clipboard-read", "clipboard-write"],
    },
    hero,
    async (page) => {
      await editor(page).click();
      await page.evaluate(async (text) => {
        await navigator.clipboard.writeText(text);
      }, LONG_TEXT);
      await page.keyboard.press("ControlOrMeta+Shift+V");
      await page.waitForTimeout(1500);

      const text = await value(page);

      return `${await chips(page).count()} chip, editor holds ${text.length} characters`;
    },
    (detail) => detail === `0 chip, editor holds ${LONG_TEXT.length} characters`
  );

  await check(
    chromiumBrowser,
    "drop",
    desktop(1440),
    hero,
    async (page) => {
      await editor(page).evaluate((element) => {
        const data = new DataTransfer();

        data.items.add(
          new File(
            [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
            "a.png",
            {
              type: "image/png",
            }
          )
        );
        data.items.add(
          new File(["notes\n"], "notes.txt", { type: "text/plain" })
        );

        const target = element.closest("form") ?? element;

        for (const type of ["dragenter", "dragover", "drop"]) {
          target.dispatchEvent(
            new DragEvent(type, {
              dataTransfer: data,
              bubbles: true,
              cancelable: true,
            })
          );
        }
      });
      await page.waitForTimeout(1500);

      return `${await chips(page).count()} chips`;
    },
    (detail) => detail === "2 chips"
  );

  await check(
    chromiumBrowser,
    "drafts-reload",
    desktop(1440),
    hero,
    async (page) => {
      await editor(page).click();
      await page.keyboard.type("a hero draft");
      await page.waitForTimeout(800);
      await page.reload({ waitUntil: "networkidle" });
      await editor(page).waitFor({ state: "visible" });
      await page.waitForTimeout(800);

      return `after reload: ${JSON.stringify(await value(page))}`;
    },
    (detail) => detail === 'after reload: "a hero draft"'
  );

  await check(
    chromiumBrowser,
    "hero-launch",
    desktop(1440),
    hero,
    async (page) => {
      await page.routeWebSocket(/\/ws(?:\?|$)/u, (socket) => {
        const server = socket.connectToServer();

        socket.onMessage((message) => {
          if (
            Predicate.isString(message) &&
            message.includes('"thread.launch"')
          ) {
            setTimeout(() => {
              server.send(message);
            }, 500);
          } else {
            server.send(message);
          }
        });
      });
      await page.reload({ waitUntil: "networkidle" });
      await editor(page).waitFor({ state: "visible", timeout: 15_000 });
      await page.evaluate(() => {
        // The count lives on <html>, which the client never renders, so the judge reads it back.
        const html = document.documentElement;
        let missing = 0;

        html.dataset.cairnJudgeMissing = "0";

        new MutationObserver(() => {
          const status = document.querySelector(
            '[data-testid="thread-status"]'
          );

          if (
            status?.textContent?.includes("This thread does not exist.") ===
            true
          ) {
            missing += 1;
            html.dataset.cairnJudgeMissing = String(missing);
          }
        }).observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      });

      const launches = 20;
      let landed = 0;

      const missingSeen = async () =>
        await page.locator("html").getAttribute("data-cairn-judge-missing");

      for (let index = 0; index < launches; index += 1) {
        const words = `hero launch ${index} ${Date.now()}`;

        if (index > 0) {
          // Back to the hero without a reload, so the observer keeps watching. The next shell has
          // no "New thread" (a project's new top-level thread comes from refresh), so it goes back
          // through the history the router follows.
          await (ui === "next"
            ? page.evaluate(() => {
                history.pushState(null, "", "/?ui=next");
                dispatchEvent(new PopStateEvent("popstate"));
              })
            : page
                .getByRole("button", { name: "New thread", exact: true })
                .first()
                .click());

          await editor(page).waitFor({ state: "visible" });
        }

        await editor(page).click();
        await page.keyboard.type(words);
        await page.keyboard.press("Enter");
        await page.waitForURL(/\/t\/[0-9a-f-]{36}$/u, { timeout: 10_000 });

        const shown = await page
          .locator('[data-message-role="user"]', { hasText: words })
          .first()
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(
            () => true,
            () => false
          );

        if (!shown) {
          return `${landed}/${launches} landed (launch ${index} showed no user row in 10 s), missing seen ${await missingSeen()} times`;
        }

        landed += 1;
      }

      return `${landed}/${launches} landed, missing seen ${await missingSeen()} times`;
    },
    (detail) => detail === "20/20 landed, missing seen 0 times"
  );

  await check(
    chromiumBrowser,
    "drafts-separate",
    desktop(1440),
    threadUrl,
    async (page) => {
      await editor(page).click();
      await page.keyboard.type("a thread draft");
      await page.waitForTimeout(800);
      await page.goto(hero, { waitUntil: "networkidle" });
      await editor(page).waitFor({ state: "visible" });

      const heroValue = await value(page);

      await page.goto(threadUrl, { waitUntil: "networkidle" });
      await editor(page).waitFor({ state: "visible" });
      await page.waitForTimeout(800);

      return `hero ${JSON.stringify(heroValue)}, thread ${JSON.stringify(await value(page))}`;
    },
    (detail) => detail === 'hero "", thread "a thread draft"'
  );

  await classicCheck(
    chromiumBrowser,
    "settle-undo",
    desktop(1440),
    hero,
    async (page) => {
      const before = await settledCount(page);

      await page.getByTestId("sidebar-row-card").first().hover();
      await page.getByRole("button", { name: "Settle thread" }).first().click();
      await page.waitForTimeout(600);

      const settled = await settledCount(page);

      await page
        .getByTestId("sidebar-undo-notice")
        .getByRole("button")
        .first()
        .click();
      await page.waitForTimeout(600);

      return `${before} -> ${settled} -> ${await settledCount(page)}`;
    },
    (detail) => {
      const [before, settled, after] = detail.split(" -> ");

      return before === after && before !== settled;
    }
  );

  await classicCheck(
    chromiumBrowser,
    "search",
    desktop(1440),
    hero,
    async (page) => {
      const search = page.getByRole("combobox", { name: "Search threads" });

      await search.fill(exported.title.split(" ")[0] ?? "");
      await page.waitForTimeout(1000);

      const hit = await page
        .getByRole("option")
        .filter({ hasText: exported.title.slice(0, 12) })
        .count();

      await search.fill("zzzz-nothing");
      await page.waitForTimeout(1000);

      return `hit ${hit}, miss ${await page.getByRole("option").count()}`;
    },
    (detail) => /^hit [1-9]\d*, miss 0$/u.test(detail)
  );

  await classicCheck(
    chromiumBrowser,
    "menu-items",
    desktop(1440),
    hero,
    async (page) => {
      await page
        .getByTestId("sidebar-row-card")
        .first()
        .click({ button: "right" });
      await page.waitForTimeout(400);

      const texts = await page
        .locator('[data-level="0"] [data-menu-id]')
        .allInnerTexts();

      const labels = texts.map((label) => label.trim());

      const missingKept = MENU_KEPT.filter((label) => !labels.includes(label));

      const trimmedShown = MENU_TRIMMED.filter((label) =>
        labels.includes(label)
      );

      return `items ${JSON.stringify(labels)}; missing ${JSON.stringify(missingKept)}; trimmed shown ${JSON.stringify(trimmedShown)}`;
    },
    (detail) => detail.endsWith("missing []; trimmed shown []")
  );

  await check(
    chromiumBrowser,
    "mobile-sheet",
    PHONE,
    hero,
    async (page) => {
      await page
        .getByRole("button", { name: "Toggle main sidebar" })
        .first()
        .click();
      await page.waitForTimeout(900);

      // The sheet's wrapper has no box of its own (its panel and backdrop are fixed), so it is
      // judged by its presence.
      const sheet = page.getByTestId("sidebar-sheet");
      const opened = (await sheet.count()) > 0;

      await sheet
        .getByTestId(
          ui === "next" ? "shell-project-thread" : "sidebar-row-card"
        )
        .first()
        .click();
      await page.waitForTimeout(900);

      return `opened ${opened}, closed ${(await sheet.count()) === 0}, at ${new URL(page.url()).pathname}`;
    },
    (detail) => detail.startsWith("opened true, closed true, at /t/")
  );
  // Last: a snoozed thread leaves the active list for every later check.
  await classicCheck(
    chromiumBrowser,
    "snooze",
    desktop(1440),
    hero,
    async (page) => {
      // Judged by its own effect, not an empty list: earlier checks (hero-launch) leave threads.
      const cards = page.getByTestId("sidebar-row-card");
      const before = await cards.count();
      const first = cards.first();

      const threadId = await first
        .locator("xpath=ancestor::li[@data-thread-item][1]")
        .getAttribute("data-thread-item");

      await first.click({ button: "right" });
      await page.locator('[data-level="0"] [data-menu-id="snooze"]').hover();
      await page.waitForTimeout(400);
      await page
        .locator('[data-level="1"] [data-menu-id^="snooze:"]')
        .first()
        .click();
      await page.waitForTimeout(800);

      const after = await cards.count();

      const stillActive = await page
        .locator(
          `[data-thread-item="${threadId ?? ""}"] [data-testid="sidebar-row-card"]`
        )
        .count();

      return `active ${before} -> ${after}, snoozed card still active ${stillActive}`;
    },
    (detail) => {
      const match =
        /^active (?<before>\d+) -> (?<after>\d+), snoozed card still active 0$/u.exec(
          detail
        );

      return (
        match?.groups !== undefined &&
        Number(match.groups.after) === Number(match.groups.before) - 1
      );
    }
  );
} finally {
  await chromiumBrowser.close();
}

/** WebKit when this host can run it (the MacBook can, the Beelink lacks its libraries), else Chromium. */
const phoneBrowser = async (): Promise<{
  readonly browser: Browser;
  readonly engine: string;
}> => {
  try {
    return { browser: await webkit.launch(), engine: "webkit" };
  } catch {
    return { browser: await chromium.launch(), engine: "chromium" };
  }
};

if (wanted("soft-keyboard")) {
  const { browser: phone, engine } = await phoneBrowser();

  const { defaultBrowserType: _ignored, ...iphone } =
    devices["iPhone 15"] ?? {};

  try {
    const context = await phone.newContext(iphone);

    // The soft keyboard, emulated: a visual viewport the judge can shrink, as iOS does.
    await context.addInitScript(() => {
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
      // The judge opens the keyboard with an event, so no global needs a type.
      globalThis.addEventListener("cairn-judge-keyboard", () => {
        fake.height = innerHeight - 320;
        target.dispatchEvent(new Event("resize"));
      });
    });

    const page = await context.newPage();

    try {
      await page.goto(threadUrl, { waitUntil: "networkidle" });
      await editor(page).waitFor({ state: "visible", timeout: 15_000 });
      await expectUi(page);
      await editor(page).tap();
      await page.evaluate(() => {
        globalThis.dispatchEvent(new CustomEvent("cairn-judge-keyboard"));
      });
      await page.waitForTimeout(500);

      const flagged = await page.locator('[data-soft-keyboard="true"]').count();

      await page.keyboard.type("one");
      await page.keyboard.press("Enter");
      await page.keyboard.type("two");
      await page.waitForTimeout(500);

      const text = await value(page);

      record(
        "soft-keyboard",
        text === "one\ntwo",
        `${engine}: keyboard flagged on ${flagged} element(s), editor ${JSON.stringify(text)}`
      );
    } finally {
      await context.close();
    }
  } catch (error) {
    record("soft-keyboard", false, String(error).split("\n")[0] ?? "failed");
  } finally {
    await phone.close();
  }
}

await app.stop();

const passing = results.filter((result) => result.pass).length;

mkdirSync(values.out, { recursive: true });

writeFileSync(
  path.join(
    values.out,
    ui === "next" ? "behaviour-next.json" : "behaviour.json"
  ),
  `${JSON.stringify({ judge: "behaviour", ui, passing, checks: results.length, results }, null, 2)}\n`
);

console.log(
  JSON.stringify({ judge: "behaviour", ui, checks: results.length, passing })
);

// Exits outright: a handle the full run leaves open (not one `--only` subsets leave) kept the
// process alive for good after its report.
process.exit(
  results.length > 0 && (!values.strict || passing === results.length) ? 0 : 1
);
