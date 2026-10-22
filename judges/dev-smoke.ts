/* oxlint-disable no-await-in-loop -- the judge samples the page once a second, on purpose */
// The dev smoke judge: `pnpm dev` (tools/dev.ts) on throwaway ports and a throwaway data directory,
// the page opened in Chromium, which must go Live, list the dev demo thread, open it, and show its
// transcript growing while the scripted harness answers the demo's messages.
//
//   node judges/dev-smoke.ts [--seconds 12] [--headed]
//
// Passes when the page is Live, the demo thread's row is listed, its entries grow at least twice
// during the window, and the page raised no error. Prints one JSON line and exits 0 on a pass.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

import { DEV_DEMO_THREAD_ID } from "../apps/server/src/DevDemo.ts";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "12" },
    headed: { type: "boolean", default: false },
  },
});

const root = path.join(import.meta.dirname, "..");

const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-dev-smoke-"));

const dev = spawn(
  process.execPath,
  [path.join(root, "tools/dev.ts"), "--data-dir", dataDir],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true }
);

const lines: Array<string> = [];

const ready = Promise.withResolvers<string>();

const onLine = (line: string) => {
  lines.push(line);

  const match = /^Cairn dev: (?<origin>http:\/\/\S+)/u.exec(line);

  if (match?.groups?.origin !== undefined) {
    ready.resolve(match.groups.origin);
  }
};

createInterface({ input: dev.stdout }).on("line", onLine);

createInterface({ input: dev.stderr }).on("line", onLine);

dev.once("exit", (code) => {
  ready.reject(
    new Error(
      `judges/dev-smoke.ts: pnpm dev exited (${String(code)}). Last lines:\n${lines.slice(-20).join("\n")}`
    )
  );
});

const stopDev = async () => {
  if (
    dev.exitCode === null &&
    dev.signalCode === null &&
    dev.pid !== undefined
  ) {
    const exited = once(dev, "exit");

    process.kill(-dev.pid, "SIGTERM");
    await exited;
  }

  rmSync(dataDir, { recursive: true, force: true });
};

const startedAt = Date.now();

const origin = await ready.promise;

const browser = await chromium.launch({ headless: !values.headed });

const page = await browser.newPage();

const pageErrors: Array<string> = [];

page.on("pageerror", (error) => {
  pageErrors.push(error.message);
});

await page.goto(origin);

await page.waitForSelector(
  '[data-testid="connection-state"][data-state="Live"]',
  { timeout: 30_000 }
);

const liveMs = Date.now() - startedAt;

const row = `[data-testid="shell-thread-row"][data-thread-id="${DEV_DEMO_THREAD_ID}"]`;

await page.waitForSelector(row, { timeout: 10_000 });

await page.goto(`${origin}/t/${DEV_DEMO_THREAD_ID}`);

// The transcript virtualizes its rows, so the judge reads its row count, not the DOM's rows.
const timeline = '[data-testid="timeline"]';

await page.waitForFunction(
  (selector) =>
    Number(document.querySelector<HTMLElement>(selector)?.dataset.rows ?? 0) >
    0,
  timeline,
  { timeout: 15_000 }
);

const entryCount = async () => {
  const rows = await page.locator(timeline).getAttribute("data-rows");

  return Number(rows ?? 0);
};

const samples: Array<number> = [await entryCount()];

for (let second = 0; second < Number(values.seconds); second += 1) {
  await sleep(1000);
  samples.push(await entryCount());
}

let increases = 0;

for (let index = 1; index < samples.length; index += 1) {
  if ((samples[index] ?? 0) > (samples[index - 1] ?? 0)) {
    increases += 1;
  }
}

const lastText = await page
  .locator('[data-testid="timeline-scroll"] [data-virtual-list-item-index]')
  .last()
  .textContent();

await browser.close();

await stopDev();

const pass = increases >= 2 && pageErrors.length === 0;

process.stdout.write(
  `${JSON.stringify({
    judge: "dev-smoke",
    pass,
    liveMs,
    samples,
    increases,
    lastEntry: (lastText ?? "").slice(0, 120),
    pageErrors,
  })}\n`
);

process.exitCode = pass ? 0 : 1;
