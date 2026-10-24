/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one check after another, on purpose */
// The parity behaviour judge (plan 4F): what a screenshot cannot show, driven in the real client
// over a real in-process brain (judges/fixtures/parity/CairnApp.ts) seeded with t3code's imported
// thread. Each check prints one line; the run ends with one JSON line.
//
//   node judges/behaviour.ts [--only <check,...>] [--out <dir>] [--strict]
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
  },
});

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

const app = await startCairn({
  projectTitle: exported.projectTitle,
  threadTitle: exported.title,
  entries: importT3Thread(exported).entries,
});

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

const chromiumBrowser = await chromium.launch();

try {
  const hero = `${app.origin}/`;

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
          // Back to the hero without a reload, so the observer keeps watching.
          await page
            .getByRole("button", { name: "New thread", exact: true })
            .first()
            .click();
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
    app.threadUrl,
    async (page) => {
      await editor(page).click();
      await page.keyboard.type("a thread draft");
      await page.waitForTimeout(800);
      await page.goto(hero, { waitUntil: "networkidle" });
      await editor(page).waitFor({ state: "visible" });

      const heroValue = await value(page);

      await page.goto(app.threadUrl, { waitUntil: "networkidle" });
      await editor(page).waitFor({ state: "visible" });
      await page.waitForTimeout(800);

      return `hero ${JSON.stringify(heroValue)}, thread ${JSON.stringify(await value(page))}`;
    },
    (detail) => detail === 'hero "", thread "a thread draft"'
  );

  await check(
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

  await check(
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

  await check(
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

      await sheet.getByTestId("sidebar-row-card").first().click();
      await page.waitForTimeout(900);

      return `opened ${opened}, closed ${(await sheet.count()) === 0}, at ${new URL(page.url()).pathname}`;
    },
    (detail) => detail.startsWith("opened true, closed true, at /t/")
  );
  // Last: a snoozed thread leaves the active list for every later check.
  await check(
    chromiumBrowser,
    "snooze",
    desktop(1440),
    hero,
    async (page) => {
      await page
        .getByTestId("sidebar-row-card")
        .first()
        .click({ button: "right" });
      await page.locator('[data-level="0"] [data-menu-id="snooze"]').hover();
      await page.waitForTimeout(400);
      await page
        .locator('[data-level="1"] [data-menu-id^="snooze:"]')
        .first()
        .click();
      await page.waitForTimeout(800);

      return `${await page.getByTestId("sidebar-row-card").count()} active cards`;
    },
    (detail) => detail === "0 active cards"
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
      await page.goto(app.threadUrl, { waitUntil: "networkidle" });
      await editor(page).waitFor({ state: "visible", timeout: 15_000 });
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
  path.join(values.out, "behaviour.json"),
  `${JSON.stringify({ judge: "behaviour", passing, checks: results.length, results }, null, 2)}\n`
);

console.log(
  JSON.stringify({ judge: "behaviour", checks: results.length, passing })
);

process.exitCode =
  results.length > 0 && (!values.strict || passing === results.length) ? 0 : 1;
