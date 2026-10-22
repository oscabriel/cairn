// The client-side attachment judge (plan 3B): paste, drop and send against the real web client at
// 390 px wide, in Chromium.
//
//   node judges/paste-client.ts [--real] [--headed] [--screenshot <png after the drops>]
//
// The judge starts a brain from the app's own layers (scripted harness, one seeded thread) and the
// web client's Vite server on ephemeral loopback ports. Until 3A's attachment routes are composed
// into the brain, the judge answers them itself: `attachments.createUploadUrl` and
// `attachments.discard` are answered on the page's protocol socket (every other RPC goes through to
// the brain), and `POST /api/attachments/upload/:token` is answered with an `AttachmentRef` built
// from the bytes it received. With `--real` nothing is stubbed, so the brain's own routes answer.
//
// Cases: a PNG `File` pasted through `DataTransfer` makes one chip and starts one upload, fitted to
// the 1,568 px long edge; a text paste over 32 KiB becomes `pasted-text.txt`; the same text after
// mod+shift+V is left to the editor; an image drop and a non-image drop each make a chip; a send
// pressed while an upload is held waits, then fires with every ready attachment once it answers.
// Prints one JSON line and exits 0 when every case passed and the page logged no error.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  CreateUploadUrlInput,
  DiscardAttachmentInput,
} from "@cairn/protocol/Attachments";
import { CommandId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import {
  Clock,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  References,
  Schema,
} from "effect";
import { chromium } from "playwright";
import type { Page, Route, WebSocketRoute } from "playwright";
import { createServer as createViteServer } from "vite";

import {
  AppLayer,
  HarnessBoot,
  withCatalog,
} from "../apps/server/src/AppLayer.ts";
import { HarnessSeam } from "../apps/server/src/brain/HarnessSeam.ts";
import { ModelSource } from "../apps/server/src/brain/ModelSource.ts";
import {
  ScriptedHarness,
  ScriptedModel,
  ScriptedStore,
  ScriptedTools,
  scriptedAnswer,
} from "../apps/server/src/brain/ScriptedHarness.ts";
import { ServerConfig } from "../apps/server/src/Config.ts";
import { ExecutorLink } from "../apps/server/src/executor/ExecutorLink.ts";
import { Identity } from "../apps/server/src/http/Identity.ts";
import { EventSink } from "../apps/server/src/shell/EventSink.ts";
import {
  ProjectRegister,
  ThreadCreate,
} from "../apps/server/src/shell/ShellCommands.ts";

const { values } = parseArgs({
  options: {
    real: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    screenshot: { type: "string" },
  },
});

const root = path.join(import.meta.dirname, "..");

const LOOPBACK = "127.0.0.1";

const THREAD_ID = ThreadId.make("019a0000-0000-7000-8000-0000000073b1");

const PROJECT_ID = ProjectId.make("prj_paste_judge");

/** The phone width the plan judges at. */
const WIDTH = 390;

/** How long a case may take to show its result. */
const CASE_TIMEOUT_MS = 10_000;

/** How long a send must stay unsent while its upload is held. */
const HOLD_MS = 1500;

const LONG_EDGE = 1568;

const freePort = async (): Promise<number> => {
  const server = createNetServer().listen(0, LOOPBACK);

  await once(server, "listening");

  const address = server.address();

  server.close();
  await once(server, "close");

  if (address === null || Predicate.isString(address)) {
    throw new Error(
      "judges/paste-client.ts: the kernel gave no loopback port."
    );
  }

  return address.port;
};

const Model = Layer.succeed(
  ScriptedModel,
  ScriptedModel.of({
    answer: () =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        scriptedAnswer("Noted.", now)
      ),
  })
);

const Harness = Layer.succeed(
  HarnessBoot,
  HarnessBoot.of({ resume: Effect.void })
).pipe(
  Layer.provideMerge(ScriptedHarness.layerNoDeps),
  Layer.provide(ScriptedStore.layer),
  Layer.provide(Model),
  Layer.provide(ScriptedTools.layerEcho),
  Layer.provideMerge(
    withCatalog(ModelSource.layerFaux({ tokensPerSecond: 200, settings: {} }))
  )
);

/** The judge's project and thread, open in the harness. */
const Seed = Layer.effectDiscard(
  Effect.gen(function* () {
    const sink = yield* EventSink;
    const seam = yield* HarnessSeam;

    yield* sink.commitCommand(
      ProjectRegister.make({
        commandId: CommandId.make("019a0000-0000-7000-8000-0000000073b2"),
        projectId: PROJECT_ID,
        kind: "scratch",
        title: "Paste judge",
        workspaceRoot: os.tmpdir(),
        repository: Option.none(),
      })
    );
    yield* sink.commitCommand(
      ThreadCreate.make({
        commandId: CommandId.make("019a0000-0000-7000-8000-0000000073b3"),
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Paste judge",
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
    });
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
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cairn-paste-"));

  const App = Seed.pipe(
    Layer.provideMerge(AppLayer),
    Layer.provideMerge(Harness),
    Layer.provide(ExecutorLink.layerDisabled),
    Layer.provide(Identity.layerLoopbackOwner),
    Layer.provide(
      ServerConfig.layerWith({
        host: `${LOOPBACK}:${vitePort}`,
        origin,
        owner: "paste-judge",
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

/** What the stubs and the socket saw. */
interface Observed {
  readonly urlRequests: Array<{ readonly name: string; readonly at: number }>;
  readonly uploads: Array<{
    readonly mimeType: string;
    readonly bytes: number;
    readonly size: Option.Option<{ width: number; height: number }>;
  }>;
  readonly discards: Array<string>;
  readonly sends: Array<{
    readonly tag: string;
    readonly at: number;
    readonly body: string;
  }>;
}

const observed: Observed = {
  urlRequests: [],
  uploads: [],
  discards: [],
  sends: [],
};

/** PNG and baseline/progressive JPEG dimensions, read from the header. */
const imageSize = (
  bytes: Buffer
): Option.Option<{ width: number; height: number }> => {
  if (bytes.subarray(1, 4).toString("latin1") === "PNG") {
    return Option.some({
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    });
  }

  let offset = 2;

  while (bytes[0] === 0xff && bytes[1] === 0xd8 && offset + 9 < bytes.length) {
    const marker = bytes[offset + 1] ?? 0;
    const length = bytes.readUInt16BE(offset + 2);

    if (marker >= 0xc0 && marker <= 0xc2) {
      return Option.some({
        width: bytes.readUInt16BE(offset + 7),
        height: bytes.readUInt16BE(offset + 5),
      });
    }

    offset += 2 + length;
  }

  return Option.none();
};

const kindOf = (mimeType: string) => {
  if (mimeType.startsWith("image/")) {
    return "image";
  }

  if (mimeType === "application/pdf") {
    return "pdf";
  }

  return mimeType.startsWith("text/") ? "text" : "file";
};

interface Token {
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
}

const tokens = new Map<string, Token>();

let nextAttachment = 1;

/** Uploads wait on this while the send case holds them. */
let held: Option.Option<{ readonly release: Promise<boolean> }> = Option.none();

const answerUpload = async (route: Route): Promise<void> => {
  const token = route.request().url().split("/").at(-1) ?? "";
  const claims = tokens.get(token);
  const body = route.request().postDataBuffer() ?? Buffer.alloc(0);
  const mimeType = route.request().headers()["content-type"] ?? "";

  observed.uploads.push({
    mimeType,
    bytes: body.length,
    size: imageSize(body),
  });

  if (Option.isSome(held)) {
    await held.value.release;
  }

  if (claims === undefined) {
    await route.fulfill({ status: 401, json: { message: "Unknown token." } });

    return;
  }

  await route.fulfill({
    status: 200,
    json: {
      id: claims.attachmentId,
      name: claims.name,
      mimeType: claims.mimeType,
      sizeBytes: body.length,
      kind: kindOf(claims.mimeType),
      sha256: createHash("sha256").update(body).digest("hex"),
    },
  });
};

/** A client request on the protocol socket (Effect RPC's JSON encoding). */
const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.Union([Schema.String, Schema.Finite]),
  tag: Schema.String,
  payload: Schema.Unknown,
});

type RpcRequest = typeof RpcRequest.Type;

const decodeRequest = Schema.decodeUnknownOption(RpcRequest);

const decodeUrlInput = Schema.decodeUnknownOption(CreateUploadUrlInput);

const decodeDiscardInput = Schema.decodeUnknownOption(DiscardAttachmentInput);

const Success = Schema.TaggedStruct("Success", {
  value: Schema.optionalKey(Schema.Unknown),
});

/** The server's answer to one request. */
const ResponseExit = Schema.TaggedStruct("Exit", {
  requestId: Schema.Union([Schema.String, Schema.Finite]),
  exit: Success,
});

/** The stub's answer to an attachment RPC, or none to pass the message to the brain. */
const answerRpc = (request: RpcRequest): Option.Option<unknown> => {
  if (request.tag === "attachments.createUploadUrl") {
    return Option.map(decodeUrlInput(request.payload), (input) => {
      const attachmentId = `att_${String(nextAttachment).padStart(4, "0")}`;
      const token = `judge-${nextAttachment}`;

      nextAttachment += 1;
      tokens.set(token, {
        attachmentId,
        name: input.name,
        mimeType: input.mimeType,
      });
      observed.urlRequests.push({ name: input.name, at: performance.now() });

      return ResponseExit.make({
        requestId: request.id,
        exit: Success.make({
          value: {
            attachmentId,
            uploadPath: `/api/attachments/upload/${token}`,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
        }),
      });
    });
  }

  if (request.tag === "attachments.discard") {
    return Option.map(decodeDiscardInput(request.payload), (input) => {
      observed.discards.push(input.attachmentId);

      return ResponseExit.make({
        requestId: request.id,
        exit: Success.make({}),
      });
    });
  }

  return Option.none();
};

/** The thread RPCs the page sent, for the send case. */
const recordThreadRequest = (request: RpcRequest): void => {
  if (request.tag.startsWith("thread.")) {
    observed.sends.push({
      tag: request.tag,
      at: performance.now(),
      body: JSON.stringify(request.payload),
    });
  }
};

/** The socket's frame as one or more messages. */
const framesOf = (raw: string | Buffer): ReadonlyArray<unknown> => {
  const parsed: unknown = JSON.parse(
    Predicate.isString(raw) ? raw : raw.toString("utf-8")
  );

  return Array.isArray(parsed) ? parsed : [parsed];
};

const routeSocket = (ws: WebSocketRoute): void => {
  const server = ws.connectToServer();

  ws.onMessage((raw) => {
    const passed: Array<unknown> = [];

    for (const message of framesOf(raw)) {
      const request = decodeRequest(message);

      Option.map(request, recordThreadRequest);

      Option.match(Option.flatMap(request, answerRpc), {
        onNone: () => {
          passed.push(message);
        },
        onSome: (answer) => {
          ws.send(JSON.stringify(answer));
        },
      });
    }

    for (const message of passed) {
      server.send(JSON.stringify(message));
    }
  });
  server.onMessage((message) => {
    ws.send(message);
  });
};

/** Watches thread RPCs without answering anything (the `--real` run). */
const watchSocket = (ws: WebSocketRoute): void => {
  const server = ws.connectToServer();

  ws.onMessage((raw) => {
    for (const message of framesOf(raw)) {
      Option.map(decodeRequest(message), recordThreadRequest);
    }

    server.send(raw);
  });
  server.onMessage((message) => {
    ws.send(message);
  });
};

const app = await startApp();

const browser = await chromium.launch({ headless: !values.headed });

const context = await browser.newContext({
  viewport: { width: WIDTH, height: 844 },
  deviceScaleFactor: 3,
});

const page: Page = await context.newPage();

const errors: Array<string> = [];

page.on("pageerror", (error) => {
  errors.push(String(error));
});

await page.routeWebSocket(
  (url) => url.pathname === "/ws",
  values.real ? watchSocket : routeSocket
);

if (!values.real) {
  await page.route("**/api/attachments/upload/**", answerUpload);
}

await page.goto(app.url, { waitUntil: "networkidle" });

const editor = page.getByTestId("composer-editor");

await editor.waitFor({ timeout: 30_000 });

const chips = page.getByTestId("attachment-chip");

const chipCount = async () => await chips.count();

/** Waits until `predicate` holds in the page, or the case times out. */
const waitUntil = async (
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = CASE_TIMEOUT_MS
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling one condition, on purpose
    if (await check()) {
      return true;
    }

    // oxlint-disable-next-line no-await-in-loop -- polling one condition, on purpose
    await page.waitForTimeout(25);
  }

  console.error(`judges/paste-client.ts: timed out waiting for ${label}`);

  return false;
};

const readyCount = async () =>
  await page
    .locator('[data-testid="attachment-chip"][data-attachment-state="ready"]')
    .count();

/** Pastes a PNG of `width` by `height` into the editor; returns whether the page claimed it. */
const pastePng = async (width: number, height: number): Promise<boolean> =>
  await page.evaluate(
    async ({ width: w, height: h }) => {
      const canvas = new OffscreenCanvas(w, h);
      const context2d = canvas.getContext("2d");

      if (context2d === null) {
        return false;
      }

      // Stripes rather than noise: a PNG small enough to stay PNG, big enough to need fitting.
      for (let x = 0; x < w; x += 40) {
        context2d.fillStyle = x % 80 === 0 ? "#2a6" : "#fff";
        context2d.fillRect(x, 0, 40, h);
      }

      const blob = await canvas.convertToBlob({ type: "image/png" });
      const transfer = new DataTransfer();

      transfer.items.add(new File([blob], "image.png", { type: "image/png" }));

      const target = document.querySelector('[data-testid="composer-editor"]');

      const event = new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      });

      target?.dispatchEvent(event);

      return event.defaultPrevented;
    },
    { width, height }
  );

/** Pastes `text` as `text/plain` into the editor, after mod+shift+V when `asText`. */
const pasteText = async (text: string, asText: boolean): Promise<boolean> =>
  await page.evaluate(
    ({ text: value, asText: plain }) => {
      const target = document.querySelector('[data-testid="composer-editor"]');

      if (!(target instanceof HTMLTextAreaElement)) {
        return false;
      }

      target.focus();

      if (plain) {
        const isMac = target.dataset.mac === "true";

        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "V",
            shiftKey: true,
            ctrlKey: !isMac,
            metaKey: isMac,
            bubbles: true,
            cancelable: true,
          })
        );
      }

      const transfer = new DataTransfer();

      transfer.setData("text/plain", value);

      const event = new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      });

      target.dispatchEvent(event);

      return event.defaultPrevented;
    },
    { text, asText }
  );

/** Drops one file of `type` on the composer's form. */
const dropFile = async (name: string, type: string): Promise<void> => {
  await page.evaluate(
    async ({ name: fileName, type: mimeType }) => {
      const form = document.querySelector("[data-chat-composer-form]");
      const transfer = new DataTransfer();

      if (mimeType === "image/png") {
        const canvas = new OffscreenCanvas(320, 200);
        const context2d = canvas.getContext("2d");

        context2d?.fillRect(0, 0, 160, 100);

        const blob = await canvas.convertToBlob({ type: mimeType });

        transfer.items.add(new File([blob], fileName, { type: mimeType }));
      } else {
        transfer.items.add(
          new File(["%PDF-1.7\n% judge\n"], fileName, { type: mimeType })
        );
      }

      form?.dispatchEvent(
        new DragEvent("dragover", {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        })
      );
      form?.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        })
      );
    },
    { name, type }
  );
};

const cases: Record<string, string> = {};

const pass = (name: string, ok: boolean, detail: string) => {
  cases[name] = ok ? "ok" : `failed: ${detail}`;
};

// 1. A PNG pasted into the editor: one chip, one upload, fitted to the long edge.
{
  const before = await chipCount();
  const claimed = await pastePng(3000, 1500);

  const oneChip = await waitUntil(
    "the PNG chip",
    async () => (await chipCount()) === before + 1
  );

  const ready = await waitUntil(
    "the PNG upload",
    async () => (await readyCount()) === 1
  );

  const [upload] = observed.uploads;
  const size = Option.getOrUndefined(upload?.size ?? Option.none());

  const fitted =
    size !== undefined && Math.max(size.width, size.height) === LONG_EDGE;

  pass(
    "pngPaste",
    claimed && oneChip && ready && observed.uploads.length === 1 && fitted,
    JSON.stringify({
      claimed,
      oneChip,
      ready,
      uploads: observed.uploads.length,
      size,
    })
  );
}

const pasteToRequestMs = await chips
  .first()
  .getAttribute("data-paste-to-request-ms");

// 2. Text over 32 KiB becomes a file, and the editor stays empty.
const LONG_TEXT = "a fairly long line of pasted log output\n".repeat(1000);

{
  const before = await chipCount();
  const claimed = await pasteText(LONG_TEXT, false);

  const folded = await waitUntil(
    "the folded text chip",
    async () =>
      (await page
        .locator(
          '[data-testid="attachment-chip"][data-attachment-name="pasted-text.txt"]'
        )
        .count()) === 1
  );

  const value = await editor.inputValue();

  pass(
    "longTextFolds",
    claimed && folded && (await chipCount()) === before + 1 && value === "",
    JSON.stringify({
      claimed,
      folded,
      bytes: LONG_TEXT.length,
      value: value.length,
    })
  );
}

// 3. The same text after mod+shift+V is left to the editor: no chip, the paste not prevented.
{
  const before = await chipCount();
  const claimed = await pasteText(LONG_TEXT, true);

  await page.waitForTimeout(300);

  pass(
    "modShiftVKeepsInline",
    !claimed && (await chipCount()) === before,
    JSON.stringify({ claimed, chips: await chipCount(), before })
  );
}

// 4. An image drop and a non-image drop each make a chip of their kind.
{
  const before = await chipCount();

  await dropFile("dropped.png", "image/png");
  await dropFile("notes.pdf", "application/pdf");

  const both = await waitUntil(
    "the dropped chips",
    async () => (await chipCount()) === before + 2
  );

  const image = await page
    .locator(
      '[data-testid="attachment-chip"][data-attachment-name="dropped.png"][data-attachment-kind="image"]'
    )
    .count();

  const file = await page
    .locator(
      '[data-testid="attachment-chip"][data-attachment-name="notes.pdf"][data-attachment-kind="file"]'
    )
    .count();

  pass(
    "drops",
    both && image === 1 && file === 1,
    JSON.stringify({ both, image, file })
  );
}

const settled = await waitUntil(
  "every upload so far",
  async () => (await readyCount()) === (await chipCount())
);

if (values.screenshot !== undefined) {
  await page.screenshot({ path: values.screenshot });
}

// 5. A send pressed while an upload is held waits, then fires with every ready attachment.
let sendWaitedMs = 0;

let sendAfterReleaseMs = 0;

{
  const gate = Promise.withResolvers<boolean>();

  held = Option.some({ release: gate.promise });

  const sendsBefore = observed.sends.filter(
    ({ tag }) => tag === "thread.send"
  ).length;

  await pastePng(800, 600);
  await waitUntil(
    "the held upload",
    async () =>
      (await page
        .locator(
          '[data-testid="attachment-chip"][data-attachment-state="uploading"]'
        )
        .count()) === 1
  );

  await editor.click();
  await page.keyboard.type("Here are the files.");

  const pressedAt = performance.now();

  await page.keyboard.press("Enter");

  const waiting = await waitUntil(
    "the waiting note",
    async () => (await page.getByTestId("attachment-waiting").count()) === 1
  );

  await page.waitForTimeout(HOLD_MS);

  const sentEarly =
    observed.sends.filter(({ tag }) => tag === "thread.send").length >
    sendsBefore;

  sendWaitedMs = Math.round(performance.now() - pressedAt);

  const releasedAt = performance.now();

  gate.resolve(true);
  held = Option.none();

  const fired = await waitUntil(
    "the send after the upload",
    async () =>
      await Promise.resolve(
        observed.sends.filter(({ tag }) => tag === "thread.send").length >
          sendsBefore
      )
  );

  const send = observed.sends.findLast(({ tag }) => tag === "thread.send");

  sendAfterReleaseMs = Math.round((send?.at ?? releasedAt) - releasedAt);

  const carried = (send?.body.match(/att_\d{4}/gu) ?? []).length;

  const trayEmpty = await waitUntil(
    "the tray to empty",
    async () => (await chipCount()) === 0
  );

  pass(
    "sendWaitsForUpload",
    settled && waiting && !sentEarly && fired && carried === 5 && trayEmpty,
    JSON.stringify({ settled, waiting, sentEarly, fired, carried, trayEmpty })
  );
}

const result = {
  width: WIDTH,
  stubbed: !values.real,
  cases,
  pasteToRequestMs: Option.getOrNull(
    Option.map(Option.fromNullishOr(pasteToRequestMs), Number)
  ),
  urlRequests: observed.urlRequests.length,
  uploads: observed.uploads.map(({ bytes, mimeType, size }) => ({
    mimeType,
    bytes,
    size: Option.getOrNull(size),
  })),
  sendWaitedMs,
  sendAfterReleaseMs,
  errors,
};

console.log(JSON.stringify(result));

await browser.close();

await app.stop();

process.exitCode =
  Object.values(cases).every((outcome) => outcome === "ok") &&
  errors.length === 0
    ? 0
    : 1;
