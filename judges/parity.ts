/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one browser step after another, on purpose */
// The parity screenshot harness: one headless Chromium renders t3code and Cairn the same way and saves the pairs.
//   node judges/parity.ts --cairn <url> --session <t3 storage state> --out <dir> [--t3 https://t3.gneiss.run/]
//
// The t3code session comes from a read-only pairing (`t3 pair --scope orchestration:read`). The thread rows and
// draft project t3code shows are copied into Cairn's URL as `#fixture=`, so both apps show the same data. Views: the
// new-thread page at 1440x900, at 390x844, and at 390x844 with the sidebar open. Writes <out>/<view>-{t3,cairn,diff}.png,
// fixture.json, and diff.json with the share of pixels that differ per view.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "playwright";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright";

interface View {
  readonly name: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly mobile: boolean;
  readonly sidebar: boolean;
}

// One sidebar row as Cairn's spike renders it.
interface FixtureRow {
  project: string;
  monogram: string;
  tone: string;
  title: string;
  status: string;
  age: string;
  branch?: string;
}

interface Fixture {
  readonly rows: ReadonlyArray<FixtureRow>;
  readonly settled: number;
  readonly draft: Record<string, string>;
}

const { values } = parseArgs({
  options: {
    t3: { type: "string", default: "https://t3.gneiss.run/" },
    cairn: { type: "string" },
    session: { type: "string" },
    out: { type: "string" },
  },
});

const { t3, cairn, session, out } = values;

if (cairn === undefined || session === undefined || out === undefined) {
  throw new Error(
    "usage: parity.ts --cairn <url> --session <file> --out <dir> [--t3 <url>]"
  );
}

mkdirSync(out, { recursive: true });

const views: ReadonlyArray<View> = [
  {
    name: "1440",
    viewport: { width: 1440, height: 900 },
    mobile: false,
    sidebar: false,
  },
  {
    name: "390",
    viewport: { width: 390, height: 844 },
    mobile: true,
    sidebar: false,
  },
  {
    name: "390-sidebar",
    viewport: { width: 390, height: 844 },
    mobile: true,
    sidebar: true,
  },
];

const browser = await chromium.launch();

const open = async (
  view: View,
  url: string,
  storageState?: string
): Promise<{ context: BrowserContext; page: Page }> => {
  const options: BrowserContextOptions = {
    viewport: view.viewport,
    deviceScaleFactor: 2,
    isMobile: view.mobile,
    hasTouch: view.mobile,
    colorScheme: "dark",
  };

  if (storageState !== undefined) {
    options.storageState = storageState;
  }

  const context = await browser.newContext(options);

  const page = await context.newPage();

  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  return { context, page };
};

// t3code's rows and draft project as Cairn's fixture, read from the desktop page.
const readFixture = async (page: Page): Promise<Fixture> =>
  await page.evaluate(() => {
    // These helpers run in the page, so they must live inside the evaluated function.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const tone = (svg: Element | null | undefined) =>
      /text-\w+-600 dark:text-\w+-400/u.exec(
        svg?.getAttribute("class") ?? ""
      )?.[0] ?? "text-gray-600 dark:text-gray-400";

    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const text = (element: Element | null | undefined) =>
      element?.textContent?.trim() ?? "";

    const rows = [
      ...document.querySelectorAll('[data-testid="sidebar-row-card"]'),
    ].map((card) => {
      const working = text(card.querySelector('[role="status"]')) === "Working";
      const slot = card.querySelector(String.raw`.group\/sidebar-status-slot`);

      const age = working
        ? text(card.querySelector(".tabular-nums"))
        : text(slot?.firstElementChild);

      const branch = text(card.querySelector(String.raw`.mt-0\.5 .truncate`));

      const row: FixtureRow = {
        project: text(card.querySelector(".text-secondary-label.text-xs")),
        monogram: text(card.querySelector("svg text")),
        tone: tone(card.querySelector("svg")),
        title: text(card.querySelector(".mt-1 span")),
        status: working ? "working" : "idle",
        age: age.replace(/^\s*Working\s*/u, "").trim(),
      };

      if (branch !== "") {
        row.branch = branch;
      }

      return row;
    });

    const settled = Number(
      /\((?<count>\d+)\)/u.exec(
        text(document.querySelector('[data-testid="sidebar-settled-header"]'))
      )?.groups?.count ?? 0
    );

    const crumb = document.querySelector(
      'nav[aria-label="Thread breadcrumb"] button'
    );

    const draft = {
      project:
        crumb?.getAttribute("aria-label")?.replace(/^New thread in /u, "") ??
        "",
      monogram: text(crumb?.querySelector("svg text")),
      tone: tone(crumb?.querySelector("svg")),
    };

    return { rows, settled, draft };
  });

const dismissNotices = async (page: Page) => {
  const dismiss = page.getByRole("button", { name: "Dismiss" });

  if ((await dismiss.count()) > 0) {
    await dismiss.first().click();
  }

  // The thread details panel is outside the surfaces compared here; Cairn's page leaves it out.
  if ((await page.locator('aside[aria-label="Thread details"]').count()) > 0) {
    await page
      .getByRole("button", { name: "Toggle thread details panel" })
      .click();
  }

  await page.waitForTimeout(400);
};

let fixture: Fixture | undefined;

for (const view of views) {
  const left = await open(view, t3, session);

  await dismissNotices(left.page);
  fixture ??= await readFixture(left.page);

  if (view.sidebar) {
    await left.page
      .getByRole("button", { name: "Toggle main sidebar" })
      .click();
    await left.page.waitForTimeout(800);
  }

  await left.page.screenshot({ path: path.join(out, `${view.name}-t3.png`) });
  await left.context.close();

  const hash = `#fixture=${encodeURIComponent(Buffer.from(JSON.stringify(fixture)).toString("base64"))}`;
  const cairnUrl = new URL(cairn);

  if (view.sidebar) {
    cairnUrl.searchParams.set("sidebar", "1");
  }

  const right = await open(view, cairnUrl.href + hash);

  await right.page.screenshot({
    path: path.join(out, `${view.name}-cairn.png`),
  });
  await right.context.close();
  console.log(`${view.name}: ${view.name}-t3.png ${view.name}-cairn.png`);
}

writeFileSync(
  path.join(out, "fixture.json"),
  `${JSON.stringify(fixture, null, 2)}\n`
);

// Pixel comparison per view: the share of pixels whose colour differs by more than a small tolerance, and an image
// with the differing pixels in magenta over a dimmed copy of t3code's.
const comparer = await browser.newPage();

const report: Record<string, number> = {};

for (const view of views) {
  const load = (side: string) =>
    `data:image/png;base64,${readFileSync(path.join(out, `${view.name}-${side}.png`)).toString("base64")}`;

  const result = await comparer.evaluate(
    async ([a, b]) => {
      // Runs in the page, like readFixture's helpers.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const image = async (src: string) => {
        const element = new Image();

        element.src = src;
        await element.decode();

        return element;
      };

      const left = await image(a);
      const right = await image(b);
      const { width, height } = left;

      const pixels = (source: HTMLImageElement) => {
        const canvas = document.createElement("canvas");

        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");

        if (context === null) {
          throw new Error("no 2d context");
        }

        context.drawImage(source, 0, 0);

        return context.getImageData(0, 0, width, height).data;
      };

      const pa = pixels(left);
      const pb = pixels(right);
      const diff = new ImageData(width, height);
      let differing = 0;

      for (let index = 0; index < pa.length; index += 4) {
        const delta =
          Math.abs((pa[index] ?? 0) - (pb[index] ?? 0)) +
          Math.abs((pa[index + 1] ?? 0) - (pb[index + 1] ?? 0)) +
          Math.abs((pa[index + 2] ?? 0) - (pb[index + 2] ?? 0));

        const differs = delta > 24;

        if (differs) {
          differing += 1;
        }

        diff.data[index] = differs ? 255 : (pa[index] ?? 0) / 3;
        diff.data[index + 1] = differs ? 0 : (pa[index + 1] ?? 0) / 3;
        diff.data[index + 2] = differs ? 255 : (pa[index + 2] ?? 0) / 3;
        diff.data[index + 3] = 255;
      }

      const canvas = document.createElement("canvas");

      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.putImageData(diff, 0, 0);

      return {
        differingPercent: Number(
          ((differing / (width * height)) * 100).toFixed(3)
        ),
        diff: canvas.toDataURL("image/png"),
      };
    },
    [load("t3"), load("cairn")] as const
  );

  writeFileSync(
    path.join(out, `${view.name}-diff.png`),
    Buffer.from(result.diff.split(",")[1] ?? "", "base64")
  );
  report[view.name] = result.differingPercent;
}

writeFileSync(
  path.join(out, "diff.json"),
  `${JSON.stringify(report, null, 2)}\n`
);

console.log("differing pixels (%):", JSON.stringify(report));

await browser.close();
