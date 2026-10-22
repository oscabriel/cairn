/* oxlint-disable no-await-in-loop -- the PWA check polls the page for its service worker, on purpose */
// The push judge, in two modes.
//
//   node judges/push.ts --pwa [--register] [--headed]
//     `pnpm dev` (tools/dev.ts) on throwaway ports and a throwaway data directory, the page opened in
//     Chromium. Passes when `/manifest.webmanifest` is linked, has the install fields and its icons
//     load, `/sw.js` has no `fetch` listener, and the page registered `/sw.js` at scope `/` with an
//     active worker. `--register` registers the worker from the judge when the page did not (before
//     the push submodel is mounted in the root); the line then says `registeredBy: "judge"`.
//
//   node judges/push.ts --send [--wait 300] [--url /]
//     Wizard stage 2, against the deployed brain's files (read only): the VAPID key from
//     `push.json` and every row of `push_subscriptions` in `cairn.sqlite`. Waits up to `--wait`
//     seconds for a subscription, then sends one test push to each device. Passes when every
//     device's push service answered 2xx; the user confirms the notification on the phone.
//
// Prints one JSON line and exits 0 on a pass. Never prints keys or endpoint paths, only hosts.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Duration, Effect, Layer, Option, Schema } from "effect";
import { chromium } from "playwright";
import type { Page } from "playwright";

import { ServerConfig } from "../apps/server/src/Config.ts";
import { sendTestPush } from "../apps/server/src/push/TestPush.ts";

const { values } = parseArgs({
  options: {
    pwa: { type: "boolean", default: false },
    register: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    send: { type: "boolean", default: false },
    wait: { type: "string", default: "300" },
    url: { type: "string", default: "/" },
  },
});

interface Registration {
  readonly scope: string;
  readonly active: string | null;
}

/** The PWA check's line. */
interface PwaLine {
  readonly mode: "pwa";
  readonly manifestOk: boolean;
  readonly manifestLinked: string | null;
  readonly iconStatuses: ReadonlyArray<number>;
  readonly noFetchListener: boolean;
  readonly registration: Registration | null;
  readonly registeredBy: string | null;
  readonly pageErrors: ReadonlyArray<string>;
}

/** The live send's line: each push service's answer by host, or why nothing was sent. */
interface SendLine {
  readonly mode: "send";
  readonly devices?: number;
  readonly results?: ReadonlyArray<{
    readonly host: string;
    readonly status: number;
  }>;
  readonly error?: string;
}

const report = (line: PwaLine | SendLine, pass: boolean) => {
  process.stdout.write(`${JSON.stringify({ judge: "push", pass, ...line })}\n`);
  process.exitCode = pass ? 0 : 1;
};

const root = path.join(import.meta.dirname, "..");

const Manifest = Schema.Struct({
  name: Schema.String,
  start_url: Schema.String,
  scope: Schema.String,
  display: Schema.String,
  icons: Schema.Array(
    Schema.Struct({
      src: Schema.String,
      sizes: Schema.String,
      purpose: Schema.String,
    })
  ),
});

const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Manifest)
);

/** The manifest's install fields, and the status of every icon it names. */
const checkManifest = async (page: Page, origin: string) => {
  const response = await page.request.get(`${origin}/manifest.webmanifest`);
  const manifest = decodeManifest(await response.text());

  if (Option.isNone(manifest)) {
    return { manifestOk: false, iconStatuses: [] };
  }

  const { icons } = manifest.value;
  const iconStatuses: Array<number> = [];

  for (const icon of icons) {
    const iconResponse = await page.request.get(`${origin}${icon.src}`);

    iconStatuses.push(iconResponse.status());
  }

  const manifestOk =
    manifest.value.name === "Cairn" &&
    manifest.value.start_url === "/" &&
    manifest.value.scope === "/" &&
    manifest.value.display === "standalone" &&
    icons.some((icon) => icon.sizes === "192x192") &&
    icons.some((icon) => icon.sizes === "512x512") &&
    icons.some((icon) => icon.purpose === "maskable") &&
    iconStatuses.every((status) => status === 200);

  return { manifestOk, iconStatuses };
};

/** True when the served worker has no `fetch` listener (ADR 0021). */
const checkNoFetchListener = async (page: Page, origin: string) => {
  const response = await page.request.get(`${origin}/sw.js`);
  const text = await response.text();

  return (
    !/addEventListener\(\s*["'`]fetch["'`]/u.test(text) &&
    !/\bonfetch\b/u.test(text)
  );
};

const readRegistration = async (page: Page) =>
  await page.evaluate(async (): Promise<Registration | null> => {
    const registration = await navigator.serviceWorker.getRegistration("/");

    return registration === undefined
      ? null
      : {
          scope: registration.scope,
          active: registration.active?.scriptURL ?? null,
        };
  });

/** Waits for the page's registration (and, with `--register`, makes it), then for it to activate. */
const awaitRegistration = async (page: Page) => {
  let registration = await readRegistration(page);
  let registeredBy = "page";

  for (let tries = 0; tries < 20 && registration === null; tries += 1) {
    await sleep(500);
    registration = await readRegistration(page);
  }

  if (registration === null && values.register) {
    registeredBy = "judge";

    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
    });

    registration = await readRegistration(page);
  }

  for (
    let tries = 0;
    tries < 20 && registration !== null && registration.active === null;
    tries += 1
  ) {
    await sleep(250);
    registration = await readRegistration(page);
  }

  return { registration, registeredBy };
};

/** Starts `pnpm dev` on throwaway ports; the Vite origin and a stop function. */
const startDev = async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-push-pwa-"));

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
        `judges/push.ts: pnpm dev exited (${String(code)}). Last lines:\n${lines.slice(-20).join("\n")}`
      )
    );
  });

  const stop = async () => {
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

  try {
    return { origin: await ready.promise, stop };
  } catch (error) {
    await stop();
    throw error;
  }
};

const pwaCheck = async () => {
  const dev = await startDev();

  try {
    const browser = await chromium.launch({ headless: !values.headed });

    try {
      const page = await browser.newPage();
      const pageErrors: Array<string> = [];

      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
      });

      await page.goto(dev.origin);

      const linked = await page
        .locator('link[rel="manifest"]')
        .getAttribute("href");

      const { iconStatuses, manifestOk } = await checkManifest(
        page,
        dev.origin
      );

      const noFetchListener = await checkNoFetchListener(page, dev.origin);
      const { registeredBy, registration } = await awaitRegistration(page);

      const scopeOk =
        registration !== null &&
        registration.scope === `${dev.origin}/` &&
        registration.active === `${dev.origin}/sw.js`;

      report(
        {
          mode: "pwa",
          manifestOk,
          manifestLinked: linked,
          iconStatuses,
          noFetchListener,
          registration,
          registeredBy: registration === null ? null : registeredBy,
          pageErrors,
        },
        manifestOk &&
          linked === "/manifest.webmanifest" &&
          noFetchListener &&
          scopeOk &&
          pageErrors.length === 0
      );
    } finally {
      await browser.close();
    }
  } finally {
    await dev.stop();
  }
};

const send = sendTestPush({
  wait: Duration.seconds(Number(values.wait)),
  url: values.url,
}).pipe(
  Effect.flatMap((results) =>
    Effect.sync(() => {
      report(
        { mode: "send", devices: results.length, results },
        results.every((result) => result.status >= 200 && result.status < 300)
      );
    })
  ),
  Effect.catchTag("TestPushError", (failure) =>
    Effect.sync(() => {
      report({ mode: "send", error: failure.message }, false);
    })
  ),
  Effect.provide(
    ServerConfig.layer.pipe(Layer.provideMerge(NodeServices.layer))
  )
);

if (values.pwa) {
  await pwaCheck();
} else if (values.send) {
  NodeRuntime.runMain(send);
} else {
  process.stderr.write(
    "usage: node judges/push.ts --pwa [--register] | --send [--wait 300] [--url /]\n"
  );
  process.exitCode = 2;
}
