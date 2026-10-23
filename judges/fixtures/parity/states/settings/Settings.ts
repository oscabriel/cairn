/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one browser state after another, on purpose */
// The settings capture states (plan 5E, moved here from 4F): the settings page of both apps, for
// judges/parity.ts (pixels) and judges/parity-structure.ts (landmarks). judges/capture.ts runs the
// group as `--group settings`; its two halves are here.
//
// States, each at 1440x900 and 390x844 (`deviceScaleFactor: 2`, dark, reduced motion):
// - `settings-general`: the settings page as it opens (t3code `/settings/general`, Cairn
//   `/settings`, whose first section is General);
// - `settings-appearance`: the appearance settings (t3code `/settings/appearance`; Cairn's
//   Appearance section scrolled to the top of the page's scroller).
// The t3 half writes into the committed baseline judges/fixtures/parity/t3@fe27e8e3/settings/ and
// refuses unless the installed `t3code-nightly-bin` is the version ADR 0015 records (D56). The Cairn
// half runs the real client over the in-process brain (CairnApp.ts) and writes `<out>/settings/`.
// Masks: at desktop widths the left column (t3code's settings navigation, Cairn's main sidebar),
// and t3code's page header (its "Restore device defaults" and settings breadcrumb, which Cairn's
// single settings page has no counterpart for). Toasts are hidden in both apps.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Option } from "effect";
import type { Browser, BrowserContextOptions, Page } from "playwright";

import { startCairn } from "../../CairnApp.ts";
import { readLandmarks } from "../../Landmarks.ts";

const root = path.join(import.meta.dirname, "../../../../..");

/** Where the t3 half writes: the committed baseline. */
export const SETTINGS_BASELINE = path.join(
  root,
  "judges/fixtures/parity/t3@fe27e8e3/settings"
);

const T3_COMMIT = "fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92";

/** One viewport a settings state is captured at. */
interface SettingsView {
  readonly name: "1440" | "390";
  readonly width: number;
  readonly height: number;
  readonly mobile: boolean;
}

const VIEWS: ReadonlyArray<SettingsView> = [
  { name: "1440", width: 1440, height: 900, mobile: false },
  { name: "390", width: 390, height: 844, mobile: true },
];

export type SettingsState = "settings-general" | "settings-appearance";

const STATES: ReadonlyArray<SettingsState> = [
  "settings-general",
  "settings-appearance",
];

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Mask extends Rect {
  readonly reason: string;
}

/** What a capture recorded about one state, in the shape parity.ts and parity-structure.ts read. */
interface SettingsRecord {
  readonly group: "settings";
  readonly view: SettingsView["name"];
  readonly viewport: { readonly width: number; readonly height: number };
  readonly mobile: boolean;
  readonly state: SettingsState;
  readonly clip: Rect;
  readonly capturedAtMs: number;
  readonly masks: ReadonlyArray<Mask>;
}

const HIDE_FLOATING =
  '[data-slot^="toast"]{display:none!important} *{caret-color:transparent!important}';

const contextOptions = (view: SettingsView): BrowserContextOptions => ({
  viewport: { width: view.width, height: view.height },
  deviceScaleFactor: 2,
  isMobile: view.mobile,
  hasTouch: view.mobile,
  colorScheme: "dark",
  reducedMotion: "reduce",
});

const round = (rect: Rect): Rect => ({
  x: Math.floor(rect.x),
  y: Math.floor(rect.y),
  width: Math.ceil(rect.width),
  height: Math.ceil(rect.height),
});

const boxOf = async (page: Page, selector: string): Promise<Option.Option<Rect>> =>
  (await page.locator(selector).count()) === 0
    ? Option.none()
    : Option.fromNullOr(await page.locator(selector).first().boundingBox());

/** The declared differences of a settings state. */
const masksOf = async (
  page: Page,
  view: SettingsView,
  side: "t3" | "cairn"
): Promise<ReadonlyArray<Mask>> => {
  const sidebar = view.mobile
    ? Option.none<Rect>()
    : await boxOf(page, '[data-slot="sidebar-container"]');

  const header =
    side === "t3" ? await boxOf(page, "header") : Option.none<Rect>();

  return [
    ...Option.match(sidebar, {
      onNone: () => [],
      onSome: (box) => [
        {
          ...round(box),
          reason:
            "left column: t3code's settings navigation, Cairn's main sidebar (one settings page, judged by the sidebar group)",
        },
      ],
    }),
    ...Option.match(header, {
      onNone: () => [],
      onSome: (box) => [
        {
          ...round(box),
          reason:
            "t3code's settings header (breadcrumb and Restore device defaults); Cairn's single settings page has none",
        },
      ],
    }),
  ];
};

/** Brings a settings page into `state`. */
const enterState = async (
  page: Page,
  state: SettingsState,
  side: "t3" | "cairn"
): Promise<void> => {
  await page.addStyleTag({ content: HIDE_FLOATING });

  if (state === "settings-appearance" && side === "cairn") {
    await page.locator("#appearance").evaluate((element) => {
      element.scrollIntoView({ block: "start" });
    });
  }

  await page.mouse.move(2, 2);
  await page.waitForTimeout(800);
};

const captureOne = async (
  page: Page,
  dir: string,
  view: SettingsView,
  state: SettingsState,
  side: "t3" | "cairn"
): Promise<SettingsRecord> => {
  const clip = { x: 0, y: 0, width: view.width, height: view.height };
  const base = path.join(dir, `${view.name}-${state}`);

  await page.screenshot({ path: `${base}.png`, clip });
  writeFileSync(`${base}.html`, `${await page.content()}\n`);
  writeFileSync(
    `${base}.landmarks.json`,
    `${JSON.stringify(await readLandmarks(page), null, 2)}\n`
  );

  return {
    group: "settings",
    view: view.name,
    viewport: { width: view.width, height: view.height },
    mobile: view.mobile,
    state,
    clip,
    capturedAtMs: await page.evaluate(() => Date.now()),
    masks: await masksOf(page, view, side),
  };
};

/** The installed nightly's version, as ADR 0015 writes it. */
const installedVersion = (): string =>
  execFileSync("pacman", ["-Q", "t3code-nightly-bin"], { encoding: "utf-8" })
    .trim()
    .split(" ")[1]
    ?.replace(/-\d+$/u, "")
    .replaceAll("_", "-") ?? "";

const recordedVersion = (): string =>
  /`(?<version>\d+\.\d+\.\d+-nightly\.\d+\.\d+)`/u.exec(
    readFileSync(
      path.join(root, "docs/decisions/0015-parity-against-t3code-nightly.md"),
      "utf-8"
    )
  )?.groups?.version ?? "";

const t3Url = (base: string, state: SettingsState) =>
  new URL(
    state === "settings-general" ? "settings/general" : "settings/appearance",
    base
  ).toString();

/** The settings group, t3code's half, into the committed baseline. */
export const captureSettingsT3 = async (
  browser: Browser,
  options: { readonly t3: string; readonly session: string }
): Promise<void> => {
  const version = installedVersion();
  const recorded = recordedVersion();

  if (version !== recorded) {
    throw new Error(
      `The installed t3code-nightly-bin is ${version}, but ADR 0015 records ${recorded}. Move the pin first.`
    );
  }

  const records: Array<SettingsRecord> = [];

  mkdirSync(SETTINGS_BASELINE, { recursive: true });

  for (const view of VIEWS) {
    for (const state of STATES) {
      const context = await browser.newContext({
        ...contextOptions(view),
        storageState: options.session,
      });

      const page = await context.newPage();

      await page.goto(t3Url(options.t3, state), { waitUntil: "networkidle" });
      await page.waitForTimeout(2500);
      await enterState(page, state, "t3");
      records.push(
        await captureOne(page, SETTINGS_BASELINE, view, state, "t3")
      );
      await context.close();
      console.log(`t3 settings ${view.name} ${state}`);
    }
  }

  writeFileSync(
    path.join(SETTINGS_BASELINE, "states.json"),
    `${JSON.stringify(records, null, 2)}\n`
  );
  writeFileSync(
    path.join(SETTINGS_BASELINE, "version.json"),
    `${JSON.stringify(
      {
        package: "t3code-nightly-bin",
        version,
        commit: T3_COMMIT,
        capturedAt: new Date(records[0]?.capturedAtMs ?? 0).toISOString(),
      },
      null,
      2
    )}\n`
  );
};

/** The settings group, Cairn's half, over an in-process brain seeded with one project. */
export const captureSettingsCairn = async (
  browser: Browser,
  options: { readonly out: string; readonly projectTitle: string }
): Promise<void> => {
  const dir = path.join(options.out, "settings");

  const app = await startCairn({
    projectTitle: options.projectTitle,
    threadTitle: "Settings",
    entries: [],
  });

  mkdirSync(dir, { recursive: true });

  try {
    for (const view of VIEWS) {
      for (const state of STATES) {
        const context = await browser.newContext(contextOptions(view));
        const page = await context.newPage();

        await page.goto(`${app.origin}/settings`, { waitUntil: "networkidle" });
        await page
          .locator("#general")
          .waitFor({ state: "attached", timeout: 20_000 });
        await page.waitForTimeout(1500);
        await enterState(page, state, "cairn");
        await captureOne(page, dir, view, state, "cairn");
        await context.close();
        console.log(`cairn settings ${view.name} ${state}`);
      }
    }
  } finally {
    await app.stop();
  }
};
