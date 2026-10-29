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
//   node judges/push.ts --fake
//     Approval push (briefs note B7) end to end, in this process and on loopback only: the whole
//     app over the scripted harness (`fixtures/push/RequestBrain.ts`, the notifier's late check at
//     3 s and reminder at 6 s), a push service of its own (`lib/FakePushService.ts`) that decrypts
//     every push with its subscription's keys, and the phone's protocol calls over the socket
//     (`presence.report`, `thread.launch`, `thread.respond`; the subscription goes straight into
//     the brain's table, since `push.subscribe` admits only https push services). Passes when a
//     request is pushed once with its words, tag and link; a request a page shows is not pushed
//     until the page goes and the request is 3 s old; a request answered first is never pushed; the
//     unanswered one is reminded once; and nothing else arrives. The phone itself is the wizard's.
//
// Prints one JSON line and exits 0 on a pass. Never prints keys or endpoint paths, only hosts.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { applyShellStreamItem } from "@cairn/client-logic/ShellReducer";
import type { ThreadId } from "@cairn/protocol/Ids";
import { RequestId } from "@cairn/protocol/Ids";
import { RootWorkspace } from "@cairn/protocol/Launch";
import type { ShellSnapshot } from "@cairn/protocol/Shell";
import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  References,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpServer } from "effect/http";
import { chromium } from "playwright";
import type { Page } from "playwright";

import { ServerConfig } from "../apps/server/src/Config.ts";
import { PushMessage } from "../apps/server/src/push/Notifier.ts";
import type { NotifierSettings } from "../apps/server/src/push/Notifier.ts";
import {
  PushEndpointRule,
  PushSubscriptions,
} from "../apps/server/src/push/PushSubscriptions.ts";
import { sendTestPush } from "../apps/server/src/push/TestPush.ts";
import { projectIdFor } from "../apps/server/src/shell/ShellCommands.ts";
import {
  testCommandId,
  testThreadId,
} from "../apps/server/src/shell/ShellTestKit.ts";
import { requestBrain } from "./fixtures/push/RequestBrain.ts";
import { startFakePushService } from "./lib/FakePushService.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";

const { values } = parseArgs({
  options: {
    pwa: { type: "boolean", default: false },
    register: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    send: { type: "boolean", default: false },
    fake: { type: "boolean", default: false },
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

const report = (line: PwaLine | SendLine | FakeLine, pass: boolean) => {
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

/** The fake check's line: each case's verdict and what the phone would have shown, in order. */
interface FakeLine {
  readonly mode: "fake";
  readonly cases: Readonly<Record<string, boolean>>;
  readonly pushes: ReadonlyArray<{
    readonly thread: string;
    readonly body: string;
    readonly afterMs: number;
  }>;
  readonly notes: ReadonlyArray<string>;
  readonly error?: string;
}

/** The notifier's timings for the fake check: seconds, not minutes. */
const FAKE_TIMINGS = {
  lateAfter: Duration.seconds(3),
  remindAfter: Duration.seconds(6),
  sweepEvery: Duration.millis(250),
};

/** The deployed settings with the fake check's timings. */
const FAKE_SETTINGS: NotifierSettings = {
  minRunDuration: Duration.seconds(20),
  staleAfter: Duration.minutes(10),
  retryBase: Duration.seconds(1),
  retries: 2,
  ttl: Duration.hours(6),
  claimRetention: Duration.days(30),
  ...FAKE_TIMINGS,
};

/** One push as the phone would show it, and when the judge first saw it. */
interface ShownPush {
  readonly message: PushMessage;
  readonly afterMs: number;
  /** Decrypted with the subscription's keys and signed with a VAPID header. */
  readonly sound: boolean;
}

/** The first push of a request no page showed: at once, in its words, tag and link. */
const isFirstPush = (push: ShownPush | undefined, threadId: ThreadId) =>
  push !== undefined &&
  push.sound &&
  push.afterMs < 2000 &&
  push.message.badge >= 1 &&
  push.message.url === `/t/${threadId}` &&
  push.message.title === "Deploy" &&
  push.message.body === "Approve Deploy the site";

/** The late push of a question a page showed: in its words, once it was old enough. */
const isLatePush = (push: ShownPush | undefined, askedAtMs: number) =>
  push !== undefined &&
  push.message.body === "Database: Which database?" &&
  push.afterMs - askedAtMs >= Duration.toMillis(FAKE_TIMINGS.lateAfter);

/** The reminder: the first push's words, marked, about `remindAfter` after it. */
const isReminder = (
  reminder: ShownPush | undefined,
  first: ShownPush | undefined
) =>
  reminder !== undefined &&
  first !== undefined &&
  reminder.message.body === "Still waiting. Approve Deploy the site" &&
  reminder.afterMs - first.afterMs >=
    Duration.toMillis(FAKE_TIMINGS.remindAfter) - 300;

const decodePush = Schema.decodeUnknownOption(
  Schema.fromJsonString(PushMessage)
);

const fakeCheck = Effect.gen(function* () {
  const service = yield* startFakePushService;

  const scratch = realpathSync(
    mkdtempSync(path.join(tmpdir(), "cairn-push-fake-"))
  );

  const dataDir = path.join(scratch, "data");
  const home = path.join(scratch, "home");
  const project = path.join(home, "project");

  // The brain's folder rules admit projects under the home folder only; this process's home is a
  // throwaway one, so the judge never names a folder of the user's.
  mkdirSync(project, { recursive: true });
  process.env.HOME = home;

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      rmSync(scratch, { recursive: true, force: true });
    })
  );

  const brain = yield* Layer.build(
    requestBrain({
      config: {
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
        owner: "owner@loopback",
        port: 0,
        dataDir,
        configDir: path.join(dataDir, "config"),
        stateDir: path.join(dataDir, "state"),
        webRoot: "/nonexistent/cairn-web",
      },
      notifier: FAKE_SETTINGS,
    })
  );

  const { address } = Context.get(brain, HttpServer.HttpServer);
  const port = "port" in address ? address.port : 0;

  const client = yield* ProtocolClient.cairn({
    base: `http://127.0.0.1:${String(port)}`,
    origin: "http://127.0.0.1",
    headers: { host: "127.0.0.1" },
    openTimeout: "10 seconds",
  });

  yield* client["session.hello"]();

  const shell = yield* Ref.make(Option.none<ShellSnapshot>());

  yield* client["shell.subscribe"]({
    afterSequence: Option.none(),
    requestCompletionMarker: false,
  }).pipe(
    Stream.runForEach((item) =>
      Ref.update(shell, (state) => applyShellStreamItem(state, item))
    ),
    Effect.ignore,
    Effect.forkScoped
  );

  const models = yield* client["models.list"]();
  const [model] = models.models;

  if (model === undefined) {
    return yield* Effect.fail("the judge brain lists no model");
  }

  const projectCommand = testCommandId(1);

  yield* client["shell.dispatch"](
    ProjectCreate.make({
      commandId: projectCommand,
      workspaceRoot: project,
      title: Option.none(),
    })
  );

  // `push.subscribe` admits https push services only, so the fake one's http endpoint is stored
  // through the brain's own subscription table, under the rule that admits it (phase 1 judges the
  // RPC itself).
  yield* Context.get(brain, PushSubscriptions)
    .upsert("owner@loopback", service.subscription("phone"))
    .pipe(
      Effect.provideService(PushEndpointRule, {
        allows: (endpoint: string) =>
          endpoint.startsWith(`${service.base}/push/`),
      })
    );

  const start = yield* Clock.currentTimeMillis;
  const seenAt: Array<number> = [];

  /** What the phone has shown so far, in order, each with when the judge first saw it. */
  const shown = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    while (seenAt.length < service.taken.length) {
      seenAt.push(now - start);
    }

    return service.taken.flatMap((push, index) =>
      Option.toArray(decodePush(push.plaintext)).map((message): ShownPush => ({
        message,
        afterMs: seenAt[index] ?? 0,
        sound: push.decrypted && push.vapid,
      }))
    );
  });

  const askedOf = (threadId: ThreadId) =>
    shown.pipe(
      Effect.map((all) =>
        all.filter((push) => push.message.tag === `ask:${threadId}`)
      )
    );

  /** Waits until `threadId` has `count` approval pushes, or `within` passes. */
  const awaitPushes = (
    threadId: ThreadId,
    count: number,
    within: Duration.Input
  ) =>
    askedOf(threadId).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("100 millis"),
        until: (pushes) => pushes.length >= count,
      }),
      Effect.timeoutOption(within),
      Effect.andThen(askedOf(threadId))
    );

  /** Waits until `threadId`'s row names a pending request; that request. */
  const awaitRequest = (threadId: ThreadId) =>
    Ref.get(shell).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (snapshot) =>
          Option.flatMap(
            Option.fromUndefinedOr(
              snapshot.threads.find((thread) => thread.id === threadId)
            ),
            (thread) => thread.pendingRuntimeRequest
          )
        )
      ),
      Effect.repeat({
        schedule: Schedule.spaced("50 millis"),
        until: Option.isSome,
      }),
      Effect.timeoutOption(Duration.seconds(10)),
      Effect.map(Option.flatten)
    );

  const launch = (n: number, title: string, text: string) =>
    client["thread.launch"]({
      commandId: testCommandId(100 + n),
      threadId: testThreadId(n),
      projectId: projectIdFor(projectCommand),
      title: Option.some(title),
      model: { provider: model.provider, modelId: model.modelId },
      thinkingLevel: "off",
      runtimeMode: "full-access",
      workspace: RootWorkspace.make({ branch: Option.none() }),
      initialMessage: {
        requestId: RequestId.make(`req_push_judge_${String(n)}`),
        text,
        attachments: [],
        skillRefs: [],
      },
    }).pipe(Effect.as(testThreadId(n)));

  const presence = (visible: boolean, threadId: Option.Option<ThreadId>) =>
    client["presence.report"]({
      deviceId: "judge-laptop",
      visible,
      threadId,
    });

  const notes: Array<string> = [];
  const cases: Record<string, boolean> = {};

  // 1. A request no page shows is pushed once, at once, with its words, tag and link.
  const gated = yield* launch(1, "Deploy", "gate: Deploy the site");
  const [firstPush] = yield* awaitPushes(gated, 1, Duration.seconds(5));

  cases.pushedOnce = isFirstPush(firstPush, gated);

  // 2. A question asked while a page shows its thread waits; once the page goes, it is pushed when
  // it is 3 s old.
  yield* presence(true, Option.some(testThreadId(2)));

  const asked = yield* launch(2, "Schema", "ask: Database | Which database?");
  const askedFrom = (yield* Clock.currentTimeMillis) - start;
  const askedRequest = yield* awaitRequest(asked);

  yield* Effect.sleep(Duration.millis(1500));

  const whileWatched = (yield* askedOf(asked)).length;

  yield* presence(false, Option.none());

  const [latePush] = yield* awaitPushes(asked, 1, Duration.seconds(6));

  cases.suppressedThenLate =
    Option.isSome(askedRequest) &&
    whileWatched === 0 &&
    isLatePush(latePush, askedFrom);

  if (Option.isSome(askedRequest)) {
    yield* client["thread.respond"]({
      threadId: asked,
      approvalId: askedRequest.value.id,
      decision: "accept",
      reason: Option.none(),
      answers: Option.some([{ index: 0, picks: ["Yes"], custom: null }]),
      launch: Option.none(),
    });
  }

  // 3. A request answered while its page shows it is never pushed.
  yield* presence(true, Option.some(testThreadId(3)));

  const answered = yield* launch(3, "Restart", "gate: Restart the worker");
  const answeredRequest = yield* awaitRequest(answered);

  if (Option.isSome(answeredRequest)) {
    yield* client["thread.respond"]({
      threadId: answered,
      approvalId: answeredRequest.value.id,
      decision: "accept",
      reason: Option.none(),
      answers: Option.none(),
      launch: Option.none(),
    });
  }

  yield* presence(false, Option.none());

  // 4. The unanswered request is reminded once, 6 s after its push, and nothing more comes.
  const [, reminder] = yield* awaitPushes(gated, 2, Duration.seconds(10));

  yield* Effect.sleep(Duration.seconds(8));

  cases.answeredFirstNeverPushed =
    Option.isSome(answeredRequest) && (yield* askedOf(answered)).length === 0;

  cases.remindedOnce = isReminder(reminder, firstPush);

  const everything = yield* shown;

  const asks = everything.filter((push) => push.message.tag.startsWith("ask:"));

  cases.nothingElse =
    asks.length === 3 &&
    (yield* askedOf(gated)).length === 2 &&
    (yield* askedOf(asked)).length === 1 &&
    everything.every((push) => push.sound);

  if (service.taken.some((push) => !push.decrypted)) {
    notes.push("a push did not decrypt with its subscription's keys");
  }

  return {
    mode: "fake",
    cases,
    pushes: everything.map((push) => ({
      thread: push.message.title,
      body: push.message.body,
      afterMs: push.afterMs,
    })),
    notes,
  } satisfies FakeLine;
}).pipe(
  Effect.scoped,
  // The brain's own log lines would break the one-line report; its failures show in the cases.
  Effect.provideService(References.MinimumLogLevel, "None"),
  Effect.flatMap((line) =>
    Effect.sync(() => {
      report(line, Object.values(line.cases).every(Boolean));
    })
  ),
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      report(
        {
          mode: "fake",
          cases: {},
          pushes: [],
          notes: [],
          error: Cause.pretty(cause).slice(0, 2000),
        },
        false
      );
    })
  )
);

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
} else if (values.fake) {
  NodeRuntime.runMain(fakeCheck);
} else {
  process.stderr.write(
    "usage: node judges/push.ts --pwa [--register] | --send [--wait 300] [--url /] | --fake\n"
  );
  process.exitCode = 2;
}
