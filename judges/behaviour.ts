/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one check after another, on purpose */
// The parity behaviour judge (plan 4F): what a screenshot cannot show, driven in the real client
// over a real in-process brain (judges/fixtures/parity/CairnApp.ts) seeded with t3code's imported
// thread. Each check prints one line; the run ends with one JSON line.
//
//   node judges/behaviour.ts [--only <check,...>] [--out <dir>] [--strict] [--broken footer-measure]
//
// Before a check's body runs the page must show the app's frame (`#root[data-ui="next"]`); the
// report is `behaviour-next.json`. The classic views and their checks were deleted at the cutover
// (plan 7A).
//
// Checks:
//   footer-<width>   the composer footer's blocks (full, icon-only, hidden) and its overflow button
//                    at 1440, 1180, 980, 820 and 390, against t3code's readings at the same
//                    widths (the hero landmark files in the committed baseline); the pills are
//                    redrawn (look track L7), so the fold rule holds: nothing in the
//                    left cluster is cut off, blocks fold last first, the overflow button shows
//                    exactly when a block is hidden, nothing folds at 1,180 px and up, and the
//                    fold is the least that fits: the judge draws the left cluster one step less
//                    folded off screen at its natural width (the label of the first icon-only
//                    block back, or the first hidden block back as an icon) and fails the check
//                    when that would have fitted. `--broken footer-measure` is its control: it
//                    makes the page measure every footer label 240 px wider than it is, so the
//                    footer folds labels with room to spare at 980 and 820 px, whose checks must
//                    then fail (the rest of the fold rule passes there; 1,440 and 1,180 px keep
//                    room even so, and 390 px folds to icons either way);
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
//   mobile-sheet     at 390 the sidebar opens as a sheet and closes on navigation;
//   soft-keyboard    WebKit at iPhone width (Chromium's iPhone emulation where WebKit cannot run,
//                    named in the result), with the soft keyboard emulated through a shrunken
//                    `visualViewport`: Enter inserts a newline and sends nothing.
//
// The shell (look track L6): the seed makes the parity thread its project's project thread, gives
// it six managed threads (one in each state, one of them a real thread) and adds two rail projects
// (one with a favicon in its root). The shell has no shelves, search or row menu (the user,
// 2026-10-29); these run at 1,440 and 390 px, each saving its states as screenshots under `<out>/shell-next/`:
//   shell-rail-<w>        one squircle bubble per folder project (a low corner radius, not a
//                         circle), the favicon drawn edge to edge in its bubble, a letter for a
//                         project with none, the selected one marked; a bubble opens its project
//                         (its project thread, or a draft in that project when it has none);
//   shell-list-<w>        the project thread on top opens it under the new header ("project
//                         thread"), and under it the managed threads, newest first, each with
//                         its status mark and word; no Active, Settled, Pinned or Snoozed group;
//   shell-managed-<w>     a managed thread opens, says it is managed, and takes a message that
//                         shows in its transcript; a parked one shows the hold banner with Retry;
//   shell-foot-<w>        Usage opens the usage page and Settings the settings page, and the foot
//                         holds no meter;
//   shell-scratch-<w>     Ctrl+J while typing in the composer (1,440) or the header's button (390)
//                         opens the scratch overlay and moves the keyboard into it; a message
//                         typed without a click lands there, not in the composer, and shows with
//                         its answer; hiding and showing keeps it;
//                         Clear deletes it and shows the empty overlay;
//   shell-refresh-1440    Refresh asks first (Cancel keeps the thread), then starts a new project
//                         thread with the typed message, opens it and lists it on top;
//   shell-start-1440      myr's bubble opens a draft of myr's own; its first message launches in
//                         myr and becomes its project thread, and cairn keeps its own;
//   shell-draft-project-<w>  the hero's project picker chooses oscargabriel-dev: the rail and the
//                         list follow it, and the first message launches there (the header
//                         titles the new project thread with it);
//   shell-add-project-<w> the rail's + bubble, last on the rail and shaped as the project bubbles
//                         (44 px on the phone), opens the add-project picker; a temporary folder
//                         under the home folder, browsed to (1,440) or typed (390), becomes a
//                         project the rail selects, opening its draft with no project thread yet;
//                         adding the same folder again selects it and adds no second project.
// Exits 0 when every check ran and the report was written; `--strict` also requires every check
// to pass, which is wave 5's bar.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  MANAGED_SEED,
  SHELL_SEED,
  startCairn,
} from "./fixtures/parity/CairnApp.ts";
import type { FooterBlockState } from "./fixtures/parity/Landmarks.ts";
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
    broken: { type: "string" },
  },
});

if (values.broken !== undefined && values.broken !== "footer-measure") {
  throw new Error(`--broken is footer-measure, not ${values.broken}`);
}

/** Fails unless the page shows the app's frame. */
const expectUi = async (page: Page) => {
  await page
    .locator('#root[data-ui="next"]')
    .waitFor({ state: "attached", timeout: 15_000 });
};

const only = new Set(values.only?.split(","));

const wanted = (name: string) => only.size === 0 || only.has(name);

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

const app = await startCairn(
  {
    projectTitle: exported.projectTitle,
    threadTitle: exported.title,
    entries: importT3Thread(exported).entries,
  },
  { shell: SHELL_SEED }
);

const { threadUrl } = app;

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

/** Where the run saves the shell's states, for the look round. */
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

/** Closes the phone's sidebar sheet by its scrim, which the sheet covers at its centre. */
const closeSidebar = async (page: Page) => {
  await page
    .getByTestId("sidebar-sheet")
    .locator('[aria-hidden="true"]')
    .first()
    .dispatchEvent("click");
  await page.getByTestId("sidebar-sheet").waitFor({ state: "detached" });
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
          // A draft of myr's own, never the bare hero (whose launch falls back to another project).
          await page.waitForURL((url) => url.pathname.startsWith("/new/"), {
            timeout: 5000,
          });
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

          // On a desktop the shortcut comes while typing in the main composer, which keeps its
          // words; the overlay takes the keyboard. The phone has no shortcut: its header's button
          // opens the overlay.
          if (width === 1440) {
            await editor(page).click();
            await page.keyboard.press("Control+j");
          } else {
            await page.getByTestId("open-scratch").click();
          }

          await overlay.waitFor({ state: "visible", timeout: 5000 });

          const box = await overlay.boundingBox();
          const empty = await overlay.getByTestId("scratch-empty").count();

          await shot(page, "scratch-empty", width);

          const words = `a scratch question ${Date.now()}`;

          // Typed with no click: the words land where the focus went.
          await page.keyboard.type(words);

          const scratchField = overlay.getByTestId("scratch-editor");
          const inOverlay = (await scratchField.inputValue()) === words;

          const composerText = await editor(page).inputValue();
          const inComposer = composerText.includes(words);

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

          return `opened ${box !== null}, wide ${(box?.width ?? 0) >= (width === 390 ? 360 : 600)}, empty ${empty}, typed in overlay ${inOverlay}, in composer ${inComposer}, sent ${sent}, answered ${answered}, kept ${kept}, cleared ${cleared}`;
        },
        (detail) =>
          detail ===
          "opened true, wide true, empty 1, typed in overlay true, in composer false, sent true, answered true, kept true, cleared true"
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

  // After the refresh, which left the seeded project the user was in most recently: starting
  // myr's project thread from the rail launches in myr, and cairn keeps its project thread.
  await check(
    browser,
    "shell-start-1440",
    desktop(1440),
    projectThreadUrl,
    async (page) => {
      const column = page.getByTestId("shell-column");

      await column.getByRole("button", { name: /^myr/u }).click();
      await page.waitForURL((url) => url.pathname.startsWith("/new/"), {
        timeout: 5000,
      });
      await column
        .getByTestId("shell-no-project-thread")
        .waitFor({ state: "visible", timeout: 5000 });

      const words = `myr's first message ${Date.now()}`;

      await editor(page).click();
      await page.keyboard.type(words);
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.pathname.startsWith("/t/"), {
        timeout: 10_000,
      });

      const shown = await page
        .locator('[data-message-role="user"]', { hasText: words })
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(
          () => true,
          () => false
        );

      // The new thread is myr's project thread: its mark arrives with the shell stream.
      const myrThread = await column
        .locator('[data-testid="shell-project-thread"][aria-current="page"]')
        .waitFor({ timeout: 10_000 })
        .then(
          () => true,
          () => false
        );

      const selected = await column
        .locator('[data-testid="rail-project"][aria-current="true"]')
        .getAttribute("aria-label");

      await page.waitForTimeout(300);
      await shot(page, "started", 1440);

      // Cairn's project thread is still there: its bubble opens it, not the empty project.
      await column
        .getByRole("button", {
          name: new RegExp(`^${exported.projectTitle}`, "u"),
        })
        .click();

      const cairnKept = await page
        .waitForURL((url) => url.pathname.startsWith("/t/"), { timeout: 5000 })
        .then(
          async () =>
            (await column.getByTestId("shell-project-thread").count()) === 1 &&
            (await column.getByTestId("shell-no-project-thread").count()) === 0,
          () => false
        );

      return `shown ${shown}, myr's project thread ${myrThread}, selected ${(selected ?? "").split(",")[0]}, ${exported.projectTitle} kept ${cairnKept}`;
    },
    (detail) =>
      detail ===
      `shown true, myr's project thread true, selected myr, ${exported.projectTitle} kept true`
  );

  // Last of the shell's checks, since it adds a thread the checks above count: the hero's
  // project picker.
  for (const width of [1440, 390] as const) {
    await check(
      browser,
      `shell-draft-project-${width}`,
      shellContext(width),
      hero,
      async (page) => {
        const trigger = page.getByTestId("hero-project-trigger");

        await page.waitForURL((url) => url.pathname.startsWith("/new/"), {
          timeout: 5000,
        });
        await trigger.click();
        await page
          .getByRole("option", { name: "oscargabriel-dev", exact: true })
          .click();

        const chosen = ((await trigger.textContent()) ?? "").trim();

        // The rail and the list follow the draft's project.
        await openSidebar(page, width);

        const side = sidebarOf(page, width);

        const followed = await side
          .locator('[data-testid="rail-project"][aria-current="true"]')
          .getAttribute("aria-label", { timeout: 2000 })
          .then(
            (label) => (label ?? "").split(",")[0],
            () => "none"
          );

        const listed = (
          (await side.getByTestId("shell-project-title").textContent()) ?? ""
        ).trim();

        if (width === 390) {
          await closeSidebar(page);
        }

        const words = `a thread for oscargabriel-dev ${Date.now()}`;

        await editor(page).click();
        await page.keyboard.type(words);
        await page.keyboard.press("Enter");
        await page.waitForURL((url) => url.pathname.startsWith("/t/"), {
          timeout: 10_000,
        });

        const shown = await page
          .locator('[data-message-role="user"]', { hasText: words })
          .first()
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(
            () => true,
            () => false
          );

        // A launch in a project is its project thread, which the header titles with the project.
        const landed = await page
          .getByTestId("next-header-title")
          .filter({ hasText: "oscargabriel-dev" })
          .waitFor({ timeout: 10_000 })
          .then(
            () => "oscargabriel-dev",
            async () =>
              (
                (await page.getByTestId("next-header-title").textContent()) ??
                ""
              ).trim()
          );

        await page.waitForTimeout(300);
        await shot(page, "draft-project", width);

        return `chosen ${chosen}, rail ${followed}, list ${listed}, shown ${shown}, landed in ${landed}`;
      },
      (detail) =>
        detail ===
        "chosen oscargabriel-dev, rail oscargabriel-dev, list oscargabriel-dev, shown true, landed in oscargabriel-dev"
    );
  }
};

/**
 * The rail's + bubble, after every other check: the projects it adds are the newest, so the hero's
 * draft, which launches in the most recently updated project, would start in one of them.
 */
const addProjectChecks = async (browser: Browser) => {
  const projectThreadUrl = threadUrl;

  // The rail's + bubble adds a folder under the home folder (the only place the brain takes one
  // from), browsed to at 1,440 and typed at 390, and selects it; adding it again selects it again.
  const folders: Array<string> = [];

  try {
    for (const width of [1440, 390] as const) {
      await check(
        browser,
        `shell-add-project-${width}`,
        shellContext(width),
        projectThreadUrl,
        async (page) => {
          const folder = realpathSync(
            mkdtempSync(path.join(homedir(), "cairn-judge-add-"))
          );

          folders.push(folder);

          const name = path.basename(folder);
          const picker = page.getByTestId("add-project");

          const addFolder = async (how: "browse" | "type") => {
            await openSidebar(page, width);
            await sidebarOf(page, width)
              .getByTestId("rail-add-project")
              .click();
            await picker.waitFor({ state: "visible", timeout: 5000 });

            if (how === "browse") {
              await picker
                .getByTestId("add-project-entry")
                .filter({ hasText: name })
                .click();
              await picker
                .getByTestId("add-project-path")
                .filter({ hasText: folder })
                .waitFor({ timeout: 5000 });
            } else {
              await picker.getByTestId("add-project-folder").fill(`${folder}/`);
            }

            await picker.getByTestId("add-project-submit").click();
            await picker.waitFor({ state: "detached", timeout: 10_000 });
          };

          await openSidebar(page, width);

          const plus = sidebarOf(page, width).getByTestId("rail-add-project");

          const look = await plus.evaluate((element) => {
            const box = element.getBoundingClientRect();

            const bubble = element.parentElement?.querySelector(
              '[data-testid="rail-project"]'
            );

            const style = getComputedStyle(element);

            return {
              size: Math.min(box.width, box.height),
              matchesBubbles:
                bubble !== null &&
                bubble !== undefined &&
                getComputedStyle(bubble).borderTopLeftRadius ===
                  style.borderTopLeftRadius &&
                bubble.getBoundingClientRect().width === box.width,
              last: element.nextElementSibling === null,
            };
          });

          const before = await sidebarOf(page, width)
            .getByTestId("rail-project")
            .count();

          await plus.click();
          await picker.waitFor({ state: "visible", timeout: 5000 });
          await picker
            .getByTestId("add-project-entry")
            .first()
            .waitFor({ timeout: 5000 });
          await page.waitForTimeout(300);
          await shot(page, "add-project", width);
          await picker.getByTestId("add-project-cancel").click();
          await picker.waitFor({ state: "detached", timeout: 5000 });

          await addFolder(width === 1440 ? "browse" : "type");
          await page.waitForURL((url) => url.pathname.startsWith("/new/"), {
            timeout: 10_000,
          });
          await openSidebar(page, width);

          const selectedOf = async () =>
            (
              (await sidebarOf(page, width)
                .locator('[data-testid="rail-project"][aria-current="true"]')
                .getAttribute("aria-label")) ?? ""
            ).split(",")[0];

          const selected = await selectedOf();

          const empty = await sidebarOf(page, width)
            .getByTestId("shell-no-project-thread")
            .count();

          const added = await sidebarOf(page, width)
            .getByTestId("rail-project")
            .count();

          if (width === 390) {
            await closeSidebar(page);
          }

          const draftIn = (
            (await page.getByTestId("hero-project-trigger").textContent()) ?? ""
          ).trim();

          await shot(page, "added-project", width);

          // Again, from another project: the same folder selects its project, with no second one.
          await openSidebar(page, width);
          await sidebarOf(page, width)
            .getByRole("button", {
              name: new RegExp(`^${exported.projectTitle}(?:,|$)`, "u"),
            })
            .click();
          await page.waitForURL(/\/t\//u, { timeout: 5000 });
          await addFolder("type");
          await page.waitForURL((url) => url.pathname.startsWith("/new/"), {
            timeout: 10_000,
          });
          await openSidebar(page, width);

          const again = await selectedOf();

          const after = await sidebarOf(page, width)
            .getByTestId("rail-project")
            .count();

          return `plus ${look.size >= (width === 390 ? 44 : 40)} same shape ${look.matchesBubbles} last ${look.last}, added ${added - before}, selected ${selected === name}, no project thread yet ${empty}, draft in ${draftIn === name}, again selected ${again === name} added ${after - added}`;
        },
        (detail) =>
          detail ===
          "plus true same shape true last true, added 1, selected true, no project thread yet 1, draft in true, again selected true added 0"
      );
    }
  } finally {
    for (const folder of folders) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
};

/** The order the footer folds its blocks in: the last block first (client-logic FooterLayout). */
const FOLD_RANK = {
  full: 0,
  "icon-only": 1,
  hidden: 2,
} satisfies Record<typeof FooterBlockState.Type, number>;

/**
 * `--broken footer-measure`: every footer label reads 240 px wider than it is to the page's own
 * measurement (MeasureFooter reads a label's `scrollWidth` for its block's natural width), then
 * the viewport twitches so the measurement runs again. The footer then folds its labels with room
 * to spare, which the fold rule's least-fold part must catch.
 */
const breakFooterMeasure = async (page: Page, width: number) => {
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollWidth"
    );

    Object.defineProperty(Element.prototype, "scrollWidth", {
      configurable: true,
      get(this: Element) {
        const real = Number(original?.get?.call(this) ?? 0);

        return this.matches("[data-composer-control-label]")
          ? real + 240
          : real;
      },
    });
  });

  const height = page.viewportSize()?.height ?? 900;

  await page.setViewportSize({ width: width - 40, height });
  await page.waitForTimeout(300);
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(800);
};

/**
 * Whether the left cluster, one step less folded, would have fitted: an off-screen copy of it at
 * its natural width (`max-content`, so the model picker's label is whole too) with the label of
 * the first icon-only block shown again, or, when blocks are hidden, the first hidden block shown
 * as an icon (and the overflow button gone when it was the last hidden one). The copy sits in the
 * cluster's own parent, so the same styles and media queries apply, and is measured against the
 * cluster's width. "unfolded" when nothing is folded. `seen` is the fold the copy started from,
 * which the caller compares with its own reading: a footer still changing between the two is not
 * settled.
 */
const lessFoldedFits = async (
  page: Page
): Promise<{ readonly verdict: string; readonly seen: string }> =>
  await page.evaluate(() => {
    const controls = document.querySelector<HTMLElement>(
      "[data-chat-composer-controls]"
    );

    if (controls === null || controls.parentElement === null) {
      return { verdict: "no controls", seen: "" };
    }

    const copy = controls.cloneNode(true);

    if (!(copy instanceof HTMLElement)) {
      return { verdict: "no copy", seen: "" };
    }

    const blocks = [
      ...copy.querySelectorAll<HTMLElement>("[data-resting-block]"),
    ];

    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
    const stateOf = (block: HTMLElement) => {
      if (block.dataset.composerBlockHidden === "true") {
        return "hidden";
      }

      return block.dataset.composerBlockIconOnly === "true"
        ? "icon-only"
        : "full";
    };

    const seen = JSON.stringify(
      Object.fromEntries(
        blocks.map((block) => [
          block.dataset.restingBlock ?? "",
          stateOf(block),
        ])
      )
    );

    const hiddenCount = blocks.filter(
      (block) => stateOf(block) === "hidden"
    ).length;

    const firstHidden = blocks.find((block) => stateOf(block) === "hidden");

    const firstIconOnly = blocks.find(
      (block) => stateOf(block) === "icon-only"
    );

    if (firstHidden !== undefined) {
      firstHidden.classList.remove("invisible", "absolute");
      firstHidden.dataset.composerBlockHidden = "false";

      if (hiddenCount === 1) {
        for (const overflow of copy.querySelectorAll<HTMLElement>(
          "[data-resting-controls-overflow]"
        )) {
          overflow.style.display = "none";
        }
      }
    } else if (firstIconOnly === undefined) {
      return { verdict: "unfolded", seen };
    } else {
      for (const label of firstIconOnly.querySelectorAll<HTMLElement>(
        "[data-composer-control-label]"
      )) {
        label.classList.remove("sr-only");
      }

      firstIconOnly.dataset.composerBlockIconOnly = "false";
    }

    copy.classList.remove("invisible", "flex-1");
    delete copy.dataset.chatComposerControls;
    copy.style.position = "absolute";
    copy.style.visibility = "hidden";
    copy.style.left = "0";
    copy.style.top = "0";
    copy.style.width = "max-content";
    copy.style.maxWidth = "none";

    controls.parentElement.append(copy);

    const natural = copy.getBoundingClientRect().width;

    copy.remove();

    const room = controls.clientWidth;

    // A pixel of slack either way, as FooterLayout's own promotions take.
    return {
      verdict:
        natural <= room - 1
          ? `needless (${Math.round(natural)} px fit ${room} px)`
          : `least (${Math.round(natural)} px over ${room} px)`,
      seen,
    };
  });

/**
 * The `next` composer's footer at one width (look track L7). Its pills are drawn in the Stone look
 * and are a finger tall on a phone, so they fold at other widths than t3code's; what must hold is
 * the fold rule itself: nothing in the left cluster is cut off, a later block is folded at least as
 * far as an earlier one, the overflow button shows exactly when a block is hidden, at 1,180 px and
 * up nothing folds, and the fold is the least that fits (`lessFoldedFits`). t3code's reading at
 * the same width is reported beside it.
 */
const nextFooterVerdict = async (
  page: Page,
  width: number,
  actual: typeof LandmarkFile.Type.footer,
  expected: typeof LandmarkFile.Type.footer
): Promise<string> => {
  const fits = await page.evaluate(() => {
    const controls = document.querySelector("[data-chat-composer-controls]");

    return controls === null
      ? false
      : controls.scrollWidth <= controls.clientWidth + 1;
  });

  const ranks = Object.values(actual.blocks).map((state) => FOLD_RANK[state]);

  const inOrder = ranks.every(
    (rank, index) => index === 0 || rank >= (ranks[index - 1] ?? 0)
  );

  const hidden = ranks.some((rank) => rank === 2);
  const overflowRight = actual.overflow === hidden;
  const wideFull = width < 1180 || ranks.every((rank) => rank === 0);
  const reading = await lessFoldedFits(page);

  const lessFolded =
    reading.seen === JSON.stringify(actual.blocks)
      ? reading.verdict
      : `unsettled (read ${JSON.stringify(actual.blocks)}, then ${reading.seen})`;

  const least =
    !lessFolded.startsWith("needless") && !lessFolded.startsWith("unsettled");

  const holds = fits && inOrder && overflowRight && wideFull && least;

  return `${holds ? "folds" : "breaks"}: fits ${fits}, in order ${inOrder}, overflow ${actual.overflow} with hidden ${hidden}, wide full ${wideFull}, one step less ${lessFolded}; next ${JSON.stringify(actual)}, t3code ${JSON.stringify(expected)}`;
};

const chromiumBrowser = await chromium.launch();

try {
  const hero = `${app.origin}/`;

  await shellChecks(chromiumBrowser, hero);

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

        if (values.broken === "footer-measure") {
          await breakFooterMeasure(page, width);
        }

        const { footer: actual } = await readLandmarks(page);

        return await nextFooterVerdict(page, width, actual, expected);
      },
      (detail) => detail.startsWith("folds")
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
          // Back to the hero without a reload, so the observer keeps watching. The shell has no
          // "New thread" (a project's new top-level thread comes from refresh), so it goes back
          // through the history the router follows.
          await page.evaluate(() => {
            history.pushState(null, "", "/");
            dispatchEvent(new PopStateEvent("popstate"));
          });

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

      await sheet.getByTestId("shell-project-thread").first().click();
      await page.waitForTimeout(900);

      return `opened ${opened}, closed ${(await sheet.count()) === 0}, at ${new URL(page.url()).pathname}`;
    },
    (detail) => detail.startsWith("opened true, closed true, at /t/")
  );

  await addProjectChecks(chromiumBrowser);
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
  path.join(values.out, "behaviour-next.json"),
  `${JSON.stringify({ judge: "behaviour", ui: "next", passing, checks: results.length, results }, null, 2)}\n`
);

console.log(
  JSON.stringify({
    judge: "behaviour",
    ui: "next",
    checks: results.length,
    passing,
  })
);

// Exits outright: a handle the full run leaves open (not one `--only` subsets leave) kept the
// process alive for good after its report.
process.exit(
  results.length > 0 && (!values.strict || passing === results.length) ? 0 : 1
);
