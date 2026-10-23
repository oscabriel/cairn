// The load judge (plan 4B, notes/edges.md "Load"): cold loads in Chromium, each in a fresh context
// with an empty cache, timed from navigation start to the page's own `cairn:interactive` mark.
//
//   node judges/load.ts [<url>] [--local] [--browser chromium|webkit] [--profile lan|4g|both]
//                       [--runs 20] [--headed]
//   node judges/load.ts --collect --device phone [--log <events.log> | --unit cairn] [--runs 3]
//
// `<url>` defaults to https://code.gneiss.run (the deployed brain, reached through Caddy, whose
// gzip and zstd the loads include). `--local` instead builds this checkout's web app and runs it on
// a judge brain (`apps/server/src/judge-main.ts`, a temporary data dir, 40 seeded threads) behind a
// small compressing proxy that stands in for Caddy on a loopback port, so the bytes match a real
// load. Profiles: `lan` (no shaping) and `4g` (CDP: 60 ms latency, 10 Mbps each way). Pass: p50
// under 1,000 ms and p95 under 1,500 ms for each profile, at most 6 requests before interactive
// (`index.html`, entry JS, CSS, service worker registration, `/ws`), and the control fails: five
// loads whose `index.html` is held 1,500 ms (the plan's `?slow=1500`, done here by the judge's own
// route) must miss the p50.
//
// `--browser webkit` (ADR 0023's WebKit tier, run on the MacBook) loads in Playwright's WebKit,
// which has no CDP: each fresh context still starts with an empty cache, and only the `lan` profile
// runs (a `4g` request is dropped and the line says so in `profilesSkipped`).
//
// `--collect` reads the brain's log instead of loading anything: the phone's `load.report` lines,
// judged by `judges/phone-report.ts` (three cold loads under 1,000 ms each, DERP runs excluded).
//
// Prints one JSON line and exits 0 when the judge passes.
//
// The helpers below (`startLocalApp` and its parts) are shared with `judges/paste.ts`.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

import { CommandId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import { RootWorkspace } from "@cairn/protocol/Launch";
import type { ModelRef } from "@cairn/protocol/Models";
import { NodeServices } from "@effect/platform-node";
import { Effect, Option, Predicate } from "effect";
import { chromium, webkit } from "playwright";
import type { Browser, Page } from "playwright";
import { build } from "vite";

import * as Events from "./lib/Events.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";
import { loadVerdict, PHONE_AGENT, readLog } from "./phone-report.ts";

export const REPO = path.join(import.meta.dirname, "..");

export const LOOPBACK = "127.0.0.1";

/** The owner the judge brain admits; the proxy sends it as Caddy's copied identity header. */
export const OWNER = "owner@loopback";

const INTERACTIVE_MARK = "cairn:interactive";

const P50_LIMIT_MS = 1000;

const P95_LIMIT_MS = 1500;

const MAX_REQUESTS = 6;

const CONTROL_DELAY_MS = 1500;

const CONTROL_RUNS = 5;

/** CDP's network shaping for the `4g` profile: 60 ms latency, 10 Mbps each way. */
const FOUR_G = {
  offline: false,
  latency: 60,
  downloadThroughput: 10_000_000 / 8,
  uploadThroughput: 10_000_000 / 8,
};

export const freePort = async (): Promise<number> => {
  const server = net.createServer().listen(0, LOOPBACK);

  await once(server, "listening");

  const address = server.address();

  server.close();
  await once(server, "close");

  if (address === null || Predicate.isString(address)) {
    throw new Error("judges/load.ts: the kernel gave no loopback port.");
  }

  return address.port;
};

/** Builds this checkout's web app into `outDir`. */
export const buildWeb = async (outDir: string) => {
  await build({
    configFile: path.join(REPO, "apps/web/vite.config.ts"),
    root: path.join(REPO, "apps/web"),
    logLevel: "error",
    build: { outDir, emptyOutDir: true },
  });
};

/** The `listening` port in the events log, polled until it appears or `timeoutMs` passes. */
const waitListening = async (events: string, timeoutMs: number) => {
  const deadline = performance.now() + timeoutMs;

  while (performance.now() < deadline) {
    const text = (() => {
      try {
        return readFileSync(events, "utf-8");
      } catch {
        return "";
      }
    })();

    const port = Events.parseLines(text)
      .filter(Events.named("listening"))
      .flatMap((event) => Option.toArray(Events.numberField(event, "port")))
      .at(-1);

    if (port !== undefined) {
      return port;
    }

    // oxlint-disable-next-line no-await-in-loop -- polling one file, on purpose
    await sleep(50);
  }

  throw new Error(
    `judges/load.ts: the judge brain wrote no listening line to ${events} within ${timeoutMs} ms; read it to see how far boot got.`
  );
};

const STREAMED_TYPES = /text|javascript|json|css|xml|svg|manifest/u;

/**
 * A loopback reverse proxy standing in for Caddy: it adds the copied identity header, compresses
 * text responses with gzip when the browser accepts it, and passes WebSocket upgrades through.
 */
const startProxy = async (port: number, target: number) => {
  const server = http.createServer((request, response) => {
    const upstream = http.request(
      {
        host: LOOPBACK,
        port: target,
        method: request.method,
        path: request.url,
        headers: {
          ...request.headers,
          "accept-encoding": "identity",
          "x-cairn-user": OWNER,
        },
      },
      (answer) => {
        const accepts = request.headers["accept-encoding"] ?? "";
        const type = answer.headers["content-type"] ?? "";

        const gzip =
          accepts.includes("gzip") &&
          STREAMED_TYPES.test(type) &&
          answer.headers["content-encoding"] === undefined;

        const headers = { ...answer.headers };

        if (gzip) {
          delete headers["content-length"];
          headers["content-encoding"] = "gzip";
          headers.vary = "Accept-Encoding";
        }

        response.writeHead(answer.statusCode ?? 502, headers);

        const done = (error: NodeJS.ErrnoException | null) => {
          if (error !== null) {
            response.destroy();
          }
        };

        if (gzip) {
          pipeline(answer, zlib.createGzip(), response, done);
        } else {
          pipeline(answer, response, done);
        }
      }
    );

    upstream.on("error", () => {
      response.destroy();
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request, socket, head) => {
    const upstream = net.connect(target, LOOPBACK, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];

      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        lines.push(
          `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`
        );
      }

      lines.push(`x-cairn-user: ${OWNER}`, "", "");
      upstream.write(lines.join("\r\n"));
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on("error", () => {
      socket.destroy();
    });
    socket.on("error", () => {
      upstream.destroy();
    });
  });

  server.listen(port, LOOPBACK);
  await once(server, "listening");

  return server;
};

export interface LocalApp {
  /** The page's origin: the proxy. */
  readonly origin: string;
  /** The brain's own loopback port, for the judge's protocol client. */
  readonly brainPort: number;
  /** The brain's events log. */
  readonly events: string;
  /** The brain's data directory. */
  readonly dataDir: string;
  readonly stop: () => Promise<void>;
}

/**
 * Builds the web app and starts a judge brain serving it behind the compressing proxy, in a fresh
 * temporary directory. `models: "real"` runs pi's model runtime with the bridge (cents a turn).
 */
export const startLocalApp = async (options: {
  readonly models: "judge" | "real";
  readonly label: string;
}): Promise<LocalApp> => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cairn-${options.label}-`));
  const webRoot = path.join(dir, "web");
  const events = path.join(dir, "events.log");
  const dataDir = path.join(dir, "data");

  await buildWeb(webRoot);

  const proxyPort = await freePort();
  const origin = `http://${LOOPBACK}:${proxyPort}`;

  const child: ChildProcess = spawn(
    process.execPath,
    [
      "apps/server/src/judge-main.ts",
      ...(options.models === "real" ? ["--models", "real"] : []),
    ],
    {
      cwd: REPO,
      stdio: "ignore",
      env: {
        ...process.env,
        CAIRN_PORT: "0",
        CAIRN_ORIGIN: origin,
        CAIRN_OWNER: OWNER,
        CAIRN_DATA_DIR: dataDir,
        CAIRN_CONFIG_DIR: path.join(dir, "config"),
        CAIRN_WEB_ROOT: webRoot,
        CAIRN_EVENTS_LOG: events,
      },
    }
  );

  const brainPort = await waitListening(events, 60_000);
  const proxy = await startProxy(proxyPort, brainPort);

  return {
    origin,
    brainPort,
    events,
    dataDir,
    stop: async () => {
      proxy.closeAllConnections();
      proxy.close();
      child.kill("SIGTERM");

      if (child.exitCode === null) {
        await once(child, "exit");
      }

      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const hex = (value: number, width: number) =>
  value.toString(16).padStart(width, "0");

/** A UUIDv7 string, as the client mints thread and command ids. */
export const uuid7 = () => {
  const time = hex(Date.now(), 12);
  const random = crypto.getRandomValues(new Uint16Array(5));
  const [a = 0, b = 0, c = 0, d = 0, e = 0] = random;

  return [
    time.slice(0, 8),
    time.slice(8, 12),
    `7${hex(a % 0x10_00, 3)}`,
    hex(0x80_00 + (b % 0x40_00), 4),
    `${hex(c, 4)}${hex(d, 4)}${hex(e, 4)}`,
  ].join("-");
};

/** A protocol client to the local brain, as Caddy would present it, in the caller's scope. */
export const localClient = (app: LocalApp) =>
  ProtocolClient.cairn({
    base: `http://${LOOPBACK}:${app.brainPort}`,
    origin: app.origin,
    headers: {
      host: new URL(app.origin).host,
      "x-cairn-user": OWNER,
    },
    openTimeout: "5 seconds",
  });

/**
 * Launches `count` threads in the scratch project on `model` (the first available model when
 * none), each with a one-line first message; resolves with their ids.
 */
export const launchThreads = (
  app: LocalApp,
  count: number,
  options: { readonly model?: ModelRef; readonly text?: string } = {}
) =>
  Effect.gen(function* () {
    const client = yield* localClient(app);
    const scratch = yield* client["projects.ensureScratch"]();
    const listing = yield* client["models.list"]();

    const model = Option.getOrElse(
      Option.fromUndefinedOr(options.model),
      (): ModelRef => {
        const found = listing.models.find((candidate) => candidate.available);

        if (found === undefined) {
          throw new Error("judges/load.ts: the judge brain offers no model.");
        }

        return { provider: found.provider, modelId: found.modelId };
      }
    );

    return yield* Effect.forEach(
      Array.from({ length: count }, (_, index) => index),
      (index) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(uuid7());

          yield* client["thread.launch"]({
            commandId: CommandId.make(uuid7()),
            threadId,
            projectId: scratch.id,
            title: Option.some(`Load judge thread ${index + 1}`),
            model,
            thinkingLevel: "off",
            runtimeMode: "full-access",
            workspace: RootWorkspace.make({ branch: Option.none() }),
            initialMessage: {
              requestId: RequestId.make(`req_${uuid7().replaceAll("-", "")}`),
              text: options.text ?? "Reply with one word.",
              attachments: [],
              skillRefs: [],
            },
          });

          return threadId;
        })
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

export interface LoadSample {
  readonly interactiveMs: number;
  readonly requestsBeforeInteractive: number;
  readonly transferBytes: number;
  /** The boot JSON the server inlined in the head; 0 when it inlined none. */
  readonly bootJsonChars: number;
}

/** One cold load in a fresh context; `holdDocumentMs` delays the document as the control. */
const coldLoad = async (
  browser: Browser,
  url: string,
  profile: "lan" | "4g",
  holdDocumentMs: number,
  cdp = true
): Promise<LoadSample> => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "allow",
  });

  try {
    const page: Page = await context.newPage();

    // WebKit has no CDP; its fresh context's cache is empty anyway.
    if (cdp) {
      const session = await context.newCDPSession(page);

      await session.send("Network.enable");
      await session.send("Network.setCacheDisabled", { cacheDisabled: true });

      if (profile === "4g") {
        await session.send("Network.emulateNetworkConditions", FOUR_G);
      }
    }

    let sockets = 0;

    page.on("websocket", () => {
      sockets += 1;
    });

    if (holdDocumentMs > 0) {
      await page.route(url, async (route) => {
        await sleep(holdDocumentMs);
        await route.continue();
      });
    }

    await page.goto(url, { waitUntil: "commit", timeout: 30_000 });
    await page.waitForFunction(
      (mark) => performance.getEntriesByName(mark).length > 0,
      INTERACTIVE_MARK,
      { timeout: 30_000, polling: 16 }
    );

    const measured = await page.evaluate((mark) => {
      const at = performance.getEntriesByName(mark)[0]?.startTime ?? 0;
      const [navigation] = performance.getEntriesByType("navigation");

      // The service worker's script and the page's own load report start as the app comes up,
      // never ahead of it; WebKit stamps them a few ms before the mark where Chromium does not.
      const resources = performance
        .getEntriesByType("resource")
        .filter((entry) => entry.startTime <= at)
        .filter((entry) => {
          const { pathname } = new URL(entry.name);

          return pathname !== "/sw.js" && pathname !== "/api/load-report";
        });

      const bytes = resources.reduce(
        (sum, entry) =>
          sum +
          (entry instanceof PerformanceResourceTiming ? entry.transferSize : 0),
        navigation instanceof PerformanceNavigationTiming
          ? navigation.transferSize
          : 0
      );

      const boot =
        document.querySelector("head #cairn-boot")?.textContent ?? "";

      return { at, resources: resources.length, bytes, boot: boot.length };
    }, INTERACTIVE_MARK);

    return {
      interactiveMs: Math.round(measured.at),
      requestsBeforeInteractive: 1 + measured.resources + Math.min(sockets, 1),
      transferBytes: measured.bytes,
      bootJsonChars: measured.boot,
    };
  } finally {
    await context.close();
  }
};

const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = values.toSorted((a, b) => a - b);

  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0
  );
};

const summarize = (samples: ReadonlyArray<LoadSample>) => {
  const times = samples.map((sample) => sample.interactiveMs);
  const p50 = percentile(times, 0.5);
  const p95 = percentile(times, 0.95);

  const maxRequests = Math.max(
    ...samples.map((sample) => sample.requestsBeforeInteractive)
  );

  return {
    runs: samples.length,
    p50,
    p95,
    max: Math.max(...times),
    maxRequests,
    transferBytes: samples[0]?.transferBytes ?? 0,
    bootJsonChars: samples[0]?.bootJsonChars ?? 0,
    pass:
      p50 < P50_LIMIT_MS && p95 < P95_LIMIT_MS && maxRequests <= MAX_REQUESTS,
  };
};

const collect = (values: {
  readonly log: string | undefined;
  readonly unit: string;
  readonly since: string;
  readonly runs: string;
  readonly device: string;
}) => {
  const verdict = loadVerdict(
    Events.parseLines(
      readLog({
        log: Option.fromUndefinedOr(values.log),
        unit: values.unit,
        since: values.since,
      })
    ),
    {
      agent:
        values.device === "phone"
          ? PHONE_AGENT
          : new RegExp(values.device, "u"),
      runs: Number(values.runs),
    }
  );

  process.stdout.write(`${JSON.stringify({ collect: verdict })}\n`);
  process.exitCode = verdict.verdict === "pass" ? 0 : 1;
};

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      local: { type: "boolean", default: false },
      profile: { type: "string", default: "both" },
      browser: { type: "string", default: "chromium" },
      runs: { type: "string" },
      headed: { type: "boolean", default: false },
      collect: { type: "boolean", default: false },
      device: { type: "string", default: "phone" },
      log: { type: "string" },
      unit: { type: "string", default: "cairn" },
      since: { type: "string", default: "15 min ago" },
    },
  });

  if (values.collect) {
    collect({
      log: values.log,
      unit: values.unit,
      since: values.since,
      device: values.device,
      runs: values.runs ?? "3",
    });

    return;
  }

  const runs = Number(values.runs ?? "20");

  const app = values.local
    ? Option.some(await startLocalApp({ models: "judge", label: "load" }))
    : Option.none<LocalApp>();

  try {
    if (Option.isSome(app)) {
      await Effect.runPromise(launchThreads(app.value, 40));
      // Let the seeded threads' first replies finish, so the loads measure the page, not them.
      await sleep(5000);
    }

    const url = Option.match(app, {
      onNone: () => positionals[0] ?? "https://code.gneiss.run",
      onSome: ({ origin }) => `${origin}/`,
    });

    const isWebkit = values.browser === "webkit";

    const browser = await (isWebkit ? webkit : chromium).launch({
      headless: !values.headed,
    });

    try {
      const asked = (
        values.profile === "both" ? ["lan", "4g"] : [values.profile]
      ).filter((profile): profile is "lan" | "4g" =>
        ["lan", "4g"].includes(profile)
      );

      // Shaping needs CDP, so WebKit runs the unshaped profile only.
      const profiles = isWebkit
        ? asked.filter((profile) => profile === "lan")
        : asked;

      const results: Record<string, ReturnType<typeof summarize>> = {};

      for (const profile of profiles) {
        const samples: Array<LoadSample> = [];

        for (let run = 0; run < runs; run += 1) {
          // oxlint-disable-next-line no-await-in-loop -- cold loads one after another, on purpose
          samples.push(await coldLoad(browser, url, profile, 0, !isWebkit));
        }

        results[profile] = summarize(samples);
      }

      const controlSamples: Array<LoadSample> = [];

      for (let run = 0; run < CONTROL_RUNS; run += 1) {
        controlSamples.push(
          // oxlint-disable-next-line no-await-in-loop -- cold loads one after another, on purpose
          await coldLoad(browser, url, "lan", CONTROL_DELAY_MS, !isWebkit)
        );
      }

      const control = summarize(controlSamples);
      const controlFailed = !control.pass;

      const pass =
        profiles.length > 0 &&
        Object.values(results).every((result) => result.pass) &&
        controlFailed;

      // The page's own reports, as the brain logged them (local runs only: the deployed brain's
      // log is the unit's journal, which `--collect` reads).
      const reports = Option.map(app, ({ events }) =>
        Events.parseLines(readFileSync(events, "utf-8")).filter(
          Events.named("load.report")
        )
      );

      process.stdout.write(
        `${JSON.stringify({
          url,
          browser: isWebkit ? "webkit" : "chromium",
          profilesSkipped: asked.filter(
            (profile) => !profiles.includes(profile)
          ),
          local: values.local,
          pass,
          profiles: results,
          control: { ...control, failedAsDesigned: controlFailed },
          loadReports: Option.getOrNull(
            Option.map(reports, (lines) => ({
              logged: lines.length,
              medianInteractiveMs: percentile(
                lines.flatMap((line) =>
                  Option.toArray(Events.numberField(line, "interactiveMs"))
                ),
                0.5
              ),
            }))
          ),
        })}\n`
      );
      process.exitCode = pass ? 0 : 1;
    } finally {
      await browser.close();
    }
  } finally {
    if (Option.isSome(app)) {
      await app.value.stop();
    }
  }
};

if (import.meta.main) {
  await main();
}
