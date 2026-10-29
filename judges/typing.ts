// The composer typing judge (ADR 0023's gate): type into the real client's composer at a fixed rate
// while a thread with a long history streams under it, then compare what arrived with what was sent.
//
//   node judges/typing.ts [chromium|webkit] [--seconds 60] [--cps 20] [--throttle 4] [--busy 10]
//                         [--mobile] [--history 500] [--url <thread page url>]
//
// Without --url the judge starts everything itself, on ephemeral loopback ports: a brain from the
// app's own layers with the scripted harness (a thread seeded with --history entries, then a new
// exchange every 250 ms for the length of the run), and the web client's Vite server proxying to it.
// Each key goes out on its own schedule, so a slow frame cannot make the typist wait for the app.
// Then three more checks on the same page: IME composition of 日本 (Chromium, through CDP), and the
// menu case (typing `@`, `/` and `$` opens each of the composer's menus, which the judge waits for,
// and typing on through them loses no character).
// While the typist types, Foldkit's slow-view warnings (dev builds, views over 16 ms) are counted
// and summed, with the Message tags that triggered them, as `slowViews`.
// Prints one JSON line and exits 0 when nothing was dropped or reordered, IME and the menu case are
// intact, the transcript streamed (at least half the judge's own exchanges landed, `stream: ok`),
// and the page logged no error.
/* oxlint-disable no-await-in-loop -- the typist sends one key after another, on purpose */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { CommandId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  References,
  Schedule,
} from "effect";
import { chromium, devices, webkit } from "playwright";
import { createServer as createViteServer } from "vite";

import {
  AppLayer,
  HarnessBoot,
  withCatalog,
} from "../apps/server/src/AppLayer.ts";
import { EventReactors } from "../apps/server/src/brain/EventReactors.ts";
import { HarnessSeam } from "../apps/server/src/brain/HarnessSeam.ts";
import { ModelSource } from "../apps/server/src/brain/ModelSource.ts";
import {
  ScriptedHarness,
  ScriptedModel,
  ScriptedStore,
  ScriptedTools,
  scriptedAnswer,
} from "../apps/server/src/brain/ScriptedHarness.ts";
import { SpendFeed } from "../apps/server/src/brain/SpendFeed.ts";
import { ServerConfig } from "../apps/server/src/Config.ts";
import { ExecutorLink } from "../apps/server/src/executor/ExecutorLink.ts";
import { Identity } from "../apps/server/src/http/Identity.ts";
import { ReachMachine } from "../apps/server/src/reach/ReachLayer.ts";
import { EventSink } from "../apps/server/src/shell/EventSink.ts";
import {
  ProjectRegister,
  ThreadCreate,
} from "../apps/server/src/shell/ShellCommands.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: "string", default: "60" },
    cps: { type: "string", default: "20" },
    throttle: { type: "string", default: "1" },
    busy: { type: "string", default: "0" },
    history: { type: "string", default: "500" },
    mobile: { type: "boolean", default: false },
    url: { type: "string" },
  },
});

const [browserName = "chromium"] = positionals;

const isWebkit = browserName === "webkit";

const seconds = Number(values.seconds);

const cps = Number(values.cps);

const throttle = Number(values.throttle);

const busy = Number(values.busy);

const historyEntries = Number(values.history);

const mobile = values.mobile || isWebkit;

const root = path.join(import.meta.dirname, "..");

const LOOPBACK = "127.0.0.1";

const THREAD_ID = ThreadId.make("019a0000-0000-7000-8000-0000000071e5");

const PROJECT_ID = ProjectId.make("prj_typing_judge");

/** One streamed exchange every this many milliseconds while the typist types. */
const STREAM_INTERVAL = Duration.millis(250);

/** A streamed submit that takes longer than this counts as failed. */
const STREAM_SUBMIT_TIMEOUT = Duration.seconds(5);

/** The stream's failed submits, for the result line. */
const streamFailures = { count: 0, last: "" };

/** A long-ish answer, so each exchange adds real markup to the page. */
const ANSWER =
  "The workflow resumed from its journal after the restart, and the scan's result came back without the scan running again. ".repeat(
    6
  );

const freePort = async (): Promise<number> => {
  const server = createNetServer().listen(0, LOOPBACK);

  await once(server, "listening");

  const address = server.address();

  server.close();
  await once(server, "close");

  if (address === null || Predicate.isString(address)) {
    throw new Error("judges/typing.ts: the kernel gave no loopback port.");
  }

  return address.port;
};

/** The scripted model, fast: answers at once, so seeding a long history takes seconds. */
const FastModel = Layer.succeed(
  ScriptedModel,
  ScriptedModel.of({
    answer: () =>
      Effect.map(Clock.currentTimeMillis, (now) => scriptedAnswer(ANSWER, now)),
  })
);

const Harness = Layer.mergeAll(
  Layer.succeed(HarnessBoot, HarnessBoot.of({ resume: Effect.void })),
  EventReactors.layerOff,
  SpendFeed.layerOff
).pipe(
  Layer.provideMerge(ScriptedHarness.layerNoDeps),
  Layer.provide(ScriptedStore.layer),
  Layer.provide(FastModel),
  Layer.provide(ScriptedTools.layerEcho),
  Layer.provideMerge(
    withCatalog(ModelSource.layerFaux({ tokensPerSecond: 200, settings: {} }))
  )
);

const submit = (text: string) =>
  Effect.gen(function* () {
    const seam = yield* HarnessSeam;
    const now = yield* Clock.currentTimeMillis;

    yield* seam.submit(THREAD_ID, {
      requestId: `typing-${now}-${Math.round(Math.random() * 1e9)}`,
      content: [{ type: "text", text }],
      entry: Option.none(),
      whenBusy: "followUp",
    });
  });

/** The judge's thread: a project, a thread with `historyEntries` entries, then a steady stream. */
const Seed = Layer.effectDiscard(
  Effect.gen(function* () {
    const sink = yield* EventSink;
    const seam = yield* HarnessSeam;

    yield* sink.commitCommand(
      ProjectRegister.make({
        commandId: CommandId.make("019a0000-0000-7000-8000-0000000071e6"),
        projectId: PROJECT_ID,
        kind: "scratch",
        title: "Typing judge",
        workspaceRoot: os.tmpdir(),
        repository: Option.none(),
      })
    );
    yield* sink.commitCommand(
      ThreadCreate.make({
        commandId: CommandId.make("019a0000-0000-7000-8000-0000000071e7"),
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Typing judge",
        provider: "scripted",
        modelId: "echo",
        thinkingLevel: "medium",
        runtimeMode: "full-access",
        branch: Option.none(),
        worktreePath: Option.none(),
      })
    );
    yield* seam.ensureThread({
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      model: { provider: "scripted", modelId: "echo" },
      thinkingLevel: "medium",
      cwd: os.tmpdir(),
      instructions: Option.none(),
      runtimeMode: "full-access",
    });

    for (let index = 0; index < historyEntries / 2; index += 1) {
      yield* submit(`history message ${index}`);
    }

    // The transcript keeps growing for as long as the judge runs. A failed or stuck submit is
    // counted and reported, not hidden, and the stream goes on with the next one.
    let streamed = 0;

    yield* Effect.suspend(() => {
      streamed += 1;

      return submit(`streamed message ${streamed}`);
    }).pipe(
      Effect.timeout(STREAM_SUBMIT_TIMEOUT),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          streamFailures.count += 1;
          streamFailures.last = Cause.pretty(cause).split("\n")[0] ?? "";
        })
      ),
      Effect.repeat(Schedule.spaced(STREAM_INTERVAL)),
      Effect.forkScoped
    );
  })
);

/** Starts the brain and Vite; resolves with the thread page's URL and a stop function. */
const startApp = async (): Promise<{
  readonly url: string;
  readonly stop: () => Promise<void>;
}> => {
  const vitePort = await freePort();
  const brainPort = await freePort();
  const origin = `http://${LOOPBACK}:${vitePort}`;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cairn-typing-"));

  const App = Seed.pipe(
    Layer.provideMerge(AppLayer),
    Layer.provideMerge(Harness),
    Layer.provide(ReachMachine.layerTest),
    Layer.provide(ExecutorLink.layerDisabled),
    Layer.provide(Identity.layerLoopbackOwner),
    Layer.provide(
      ServerConfig.layerWith({
        host: `${LOOPBACK}:${vitePort}`,
        origin,
        owner: "typing-judge",
        listenHost: LOOPBACK,
        port: brainPort,
        dataDir,
        webRoot: path.join(dataDir, "no-web"),
      })
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error"))
  );

  const runtime = ManagedRuntime.make(App);

  await runtime.runPromise(Effect.void);

  process.env.CAIRN_DEV_BRAIN = `http://${LOOPBACK}:${brainPort}`;

  const vite = await createViteServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    root: path.join(root, "apps/web"),
    logLevel: "error",
    server: { host: LOOPBACK, port: vitePort, strictPort: true },
  });

  await vite.listen();

  return {
    url: `${origin}/t/${THREAD_ID}`,
    stop: async () => {
      await vite.close();
      await runtime.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
};

// Printable text with spaces and punctuation, deterministic, long enough for the run.
const alphabet =
  "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 .,;:!?-_()[]'\"";

let seed = 7;

const nextCharacter = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

  return alphabet[seed % alphabet.length] ?? "a";
};

const text = Array.from({ length: seconds * cps }, nextCharacter).join("");

/**
 * The menu case's text, cut after each trigger character: the judge waits for that trigger's menu
 * to open before it types the next piece.
 */
const MENU_PIECES: ReadonlyArray<readonly [string, string | undefined]> = [
  ["look at @", "path"],
  ["src/app.ts then /", "slash-command"],
  ["model or $", "skill"],
  ["review and @docs done", undefined],
];

const MENU_TEXT = MENU_PIECES.map(([piece]) => piece).join("");

/** How long the menu case waits for one menu to open. */
const MENU_WAIT_MS = 5000;

/** With --url the page's own brain is not the judge's to stop. */
const stopNothing = async (): Promise<void> => {
  // Nothing to stop.
};

const app =
  values.url === undefined
    ? await startApp()
    : { url: values.url, stop: stopNothing };

const browser = await (isWebkit ? webkit : chromium).launch();

const { defaultBrowserType: _ignored, ...phone } = devices["iPhone 15"] ?? {};

const context = await browser.newContext(
  mobile ? phone : { viewport: { width: 1440, height: 900 } }
);

const page = await context.newPage();

const errors: Array<string> = [];

page.on("pageerror", (error) => {
  errors.push(String(error));
});

/** Foldkit's slow-view warnings while the typist types: how many, how long, and what caused them. */
const slowViews = {
  recording: false,
  durations: new Array<number>(),
  triggers: new Map<string, number>(),
};

const SLOW_VIEW =
  /^\[foldkit\] Slow view: (?<ms>[\d.]+)ms .*triggered by (?<trigger>\w+)/u;

page.on("console", (message) => {
  const match = SLOW_VIEW.exec(message.text());

  if (!slowViews.recording || match?.groups === undefined) {
    return;
  }

  const trigger = match.groups.trigger ?? "unknown";

  slowViews.durations.push(Number(match.groups.ms));
  slowViews.triggers.set(trigger, (slowViews.triggers.get(trigger) ?? 0) + 1);
});

const target = new URL(app.url);

if (busy > 0) {
  target.searchParams.set("busy", String(busy));
}

await page.goto(target.href, { waitUntil: "networkidle" });

// The transcript virtualizes its rows, so the judge reads its row count, not the DOM's rows.
const timeline = page.getByTestId("timeline");

const entries = {
  count: async () => Number((await timeline.getAttribute("data-rows")) ?? 0),
};

await page.waitForFunction(
  (expected) =>
    Number(
      document.querySelector<HTMLElement>('[data-testid="timeline"]')?.dataset
        .rows ?? 0
    ) >= expected,
  historyEntries,
  { timeout: 60_000 }
);

const historyRows = await entries.count();

if (throttle > 1 && !isWebkit) {
  const cdp = await context.newCDPSession(page);

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
}

const composer = page.getByTestId("composer-editor");

await composer.click();

/** Types `value` at `cps`, each key on its own schedule; returns how late the late keys were. */
const typeAt = async (value: string): Promise<ReadonlyArray<number>> => {
  const started = Date.now();
  const late: Array<number> = [];

  for (let index = 0; index < value.length; index += 1) {
    const wait = started + (index * 1000) / cps - Date.now();

    if (wait > 0) {
      await sleep(wait);
    } else {
      late.push(-wait);
    }

    await page.keyboard.type(value.charAt(index));
  }

  return late;
};

const rowsBefore = await entries.count();

const started = Date.now();

slowViews.recording = true;

const late = await typeAt(text);

slowViews.recording = false;

const elapsed = (Date.now() - started) / 1000;

await page.waitForTimeout(1000);

const typed = await composer.inputValue();

const rowsAfter = await entries.count();

/**
 * The judge's own stream lands one exchange (two rows) every 250 ms; a run that saw fewer than half
 * of them typed against a transcript that was not streaming, so it proves nothing. A `--url` page
 * streams whatever its brain streams, so the floor is not checked there.
 */
const STREAM_FLOOR = seconds * 4;

const streamOf = (): "ok" | "dead" | "skipped" => {
  if (values.url !== undefined) {
    return "skipped";
  }

  return rowsAfter - rowsBefore >= STREAM_FLOOR ? "ok" : "dead";
};

const stream = streamOf();

let firstDiff = -1;

for (let index = 0; index < Math.max(text.length, typed.length); index += 1) {
  if (text.charAt(index) !== typed.charAt(index)) {
    firstDiff = index;
    break;
  }
}

// IME: compose a word through the browser's composition events, between plain keys.
let ime = "skipped";

if (!isWebkit) {
  const cdp = await context.newCDPSession(page);

  await composer.fill("");
  await page.waitForTimeout(200);
  await page.keyboard.type("ab");

  for (const step of ["n", "に", "にほ", "にほん", "日本"]) {
    await cdp.send("Input.imeSetComposition", {
      text: step,
      selectionStart: step.length,
      selectionEnd: step.length,
    });
    await page.waitForTimeout(60);
  }

  await cdp.send("Input.insertText", { text: "日本" });
  await page.keyboard.type("cd");
  await page.waitForTimeout(500);

  const value = await composer.inputValue();

  ime = value === "ab日本cd" ? "ok" : `wrong: ${JSON.stringify(value)}`;
}

// The menu case: `@`, `/` and `$` each open their menu (the judge waits for it), and typing on
// through them loses nothing.
await composer.fill("");

await page.waitForTimeout(200);

const menusSeen: Array<string> = [];

const menusMissed: Array<string> = [];

for (const [piece, kind] of MENU_PIECES) {
  await typeAt(piece);

  if (kind !== undefined) {
    const opened = await page
      .waitForSelector(
        `[data-testid="composer-menu"][data-trigger="${kind}"]`,
        { timeout: MENU_WAIT_MS }
      )
      .then(
        () => true,
        () => false
      );

    (opened ? menusSeen : menusMissed).push(kind);
  }
}

await page.waitForTimeout(500);

const menuValue = await composer.inputValue();

let menu = "ok";

if (menuValue !== MENU_TEXT) {
  menu = `wrong: ${JSON.stringify(menuValue)}`;
} else if (menusMissed.length > 0) {
  menu = `menus did not open: ${menusMissed.join(", ")}`;
}

const slowSorted = slowViews.durations.toSorted((left, right) => left - right);

const result = {
  engine: browserName,
  mobile,
  throttle,
  busy,
  cps,
  historyRows,
  sent: text.length,
  received: typed.length,
  match: typed === text,
  firstDiff,
  elapsedSeconds: Number(elapsed.toFixed(1)),
  lateKeys: late.length,
  maxLateMs: Math.round(Math.max(0, ...late)),
  rowsStreamed: rowsAfter - rowsBefore,
  stream,
  streamFailures: streamFailures.count,
  lastStreamFailure: streamFailures.last,
  slowViews: {
    count: slowSorted.length,
    totalMs: Math.round(slowSorted.reduce((sum, ms) => sum + ms, 0)),
    p50Ms: slowSorted[Math.floor(slowSorted.length / 2)] ?? 0,
    maxMs: slowSorted.at(-1) ?? 0,
    triggers: Object.fromEntries(slowViews.triggers),
  },
  ime,
  menu,
  menusSeen: menusSeen.toSorted(),
  errors,
};

console.log(JSON.stringify(result));

await browser.close();

await app.stop();

process.exitCode =
  result.match &&
  (ime === "ok" || ime === "skipped") &&
  menu === "ok" &&
  stream !== "dead" &&
  errors.length === 0
    ? 0
    : 1;
