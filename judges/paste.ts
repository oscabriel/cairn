// The paste-to-model judge, automated tier (plan 4B, notes/edges.md "Paste to model"): a screenshot
// pasted into the real web client reaches the model as the same image, fast.
//
//   node judges/paste.ts [--runs 20] [--skip-real] [--headed]
//   node judges/paste.ts --page [--wait 600]
//
// The judge builds this checkout's web app and runs it on a judge brain behind the compressing
// proxy (`judges/load.ts`'s `startLocalApp`), in Chromium at 390 px wide. Each run generates a
// 1170x2532 PNG with a fresh nonce word drawn on it and dispatches a real `ClipboardEvent("paste")`
// carrying it as a `File`.
//
// Timing, `--runs` per profile (`lan`, unthrottled; `throttled`, CDP 10 Mbps each way and 60 ms latency):
// paste to the chip's `ready` state (measured in the page) p95 at most 1,500 ms; send (the click,
// in the page's clock) to the brain's `turn.submitted` line at most 500 ms; and the `provider.request`
// line's image sha256 equals the sha256 of the prepared bytes as the model receives them (base64 of
// `<dataDir>/attachments/<id>.prepared`). Paste and send at once (five runs): the click lands right
// after the paste, the send waits on the upload, and paste to `provider.request` is at most 2,000 ms.
// A 51 MiB PDF is refused with the composer's plain notice (the limit is 50 MiB).
//
// Real models (cents; skipped with `--skip-real`): a second judge brain with pi's model runtime and
// the bridge. A nonce screenshot answered by `claude-bridge/claude-haiku-5-5` and by an `opencode-go`
// model that takes images; through the bridge, a generated 3-page PDF (all three page nonces in the
// answer), a scanned-style PDF (the answer quotes the "no text layer" note) and a DOCX (its nonce).
//
// `--page` is the phone half (wizard stage 4): it writes a page with a fresh nonce under
// ~/Developer/agent-artifacts/cairn/v2/phase-1-paste/ (served at plans.gneiss.run), then follows the
// deployed brain's journal until a phone paste reaches the model and prints `phone-report.ts`'s
// paste verdict.
//
// The pastes go into the app's composer (look track L7).
//
// Prints one JSON line and exits 0 when every case passed.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

import type { ThreadId } from "@cairn/protocol/Ids";
import type { ModelListing, ModelRef } from "@cairn/protocol/Models";
import { ShellSnapshot } from "@cairn/protocol/Shell";
import { NodeServices } from "@effect/platform-node";
import { DateTime, Effect, Option, Schema } from "effect";
import { chromium } from "playwright";
import type { Browser, CDPSession, Page } from "playwright";

import * as Events from "./lib/Events.ts";
import type { BrainEvent } from "./lib/Events.ts";
import type { LocalApp } from "./load.ts";
import { launchThreads, localClient, startLocalApp } from "./load.ts";
import { pasteVerdict, readLog } from "./phone-report.ts";

const PASTE_TO_CHIP_P95_MS = 1500;

const SEND_TO_SUBMITTED_MS = 500;

const PASTE_AND_SEND_MS = 2000;

const AT_ONCE_RUNS = 5;

const REPLY_TIMEOUT_MS = 120_000;

const SCREEN = { width: 1170, height: 2532 };

const THROTTLED = {
  offline: false,
  latency: 60,
  downloadThroughput: 10_000_000 / 8,
  uploadThroughput: 10_000_000 / 8,
};

const BRIDGE_MODEL: ModelRef = {
  provider: "claude-bridge",
  modelId: "claude-haiku-5-5",
};

const WORDS = [
  "MARLIN",
  "CONDOR",
  "BASALT",
  "JUNIPER",
  "OSPREY",
  "QUARTZ",
  "TUNDRA",
  "WALRUS",
];

/** A word no model can guess: a common word and four random digits. */
const nonce = () => {
  const [pick = 0, digits = 0] = crypto.getRandomValues(new Uint16Array(2));

  return `${WORDS[pick % WORDS.length] ?? "MARLIN"}${String(digits % 10_000).padStart(4, "0")}`;
};

// --- Generated documents -------------------------------------------------------------------------

/** A PDF from object bodies (1-based, in order), with a correct cross-reference table. */
const pdfFrom = (objects: ReadonlyArray<string | Buffer>) => {
  const parts: Array<Buffer> = [Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1")];
  const offsets: Array<number> = [];
  let length = parts[0]?.length ?? 0;

  for (const [index, body] of objects.entries()) {
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "latin1"),
      Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"),
      Buffer.from("\nendobj\n", "latin1"),
    ]);

    offsets.push(length);
    parts.push(object);
    length += object.length;
  }

  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(length),
    "%%EOF",
    "",
  ].join("\n");

  return Buffer.concat([...parts, Buffer.from(xref, "latin1")]);
};

const stream = (dictionary: string, content: Buffer) =>
  Buffer.concat([
    Buffer.from(
      `<< ${dictionary} /Length ${content.length} >>\nstream\n`,
      "latin1"
    ),
    content,
    Buffer.from("\nendstream", "latin1"),
  ]);

/** A text PDF, one page per string, in Helvetica. Objects: catalog, pages, font, then page and content pairs. */
export const textPdf = (pages: ReadonlyArray<string>) => {
  const pageObjects = pages.flatMap((text, index) => {
    const pageId = 4 + index * 2;

    return [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
      stream(
        "",
        Buffer.from(`BT /F1 24 Tf 72 700 Td (${text}) Tj ET`, "latin1")
      ),
    ];
  });

  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ");

  return pdfFrom([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pageObjects,
  ]);
};

/** A one-page PDF holding only an image, as a scanner makes: no text layer. */
export const scannedPdf = () => {
  const side = 64;
  const pixels = Buffer.alloc(side * side * 3, 0xee);

  for (let index = 0; index < side * side; index += 7) {
    pixels.fill(0x22, index * 3, index * 3 + 3);
  }

  return pdfFrom([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    stream("", Buffer.from("q 400 0 0 400 106 196 cm /Im1 Do Q", "latin1")),
    stream(
      `/Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8`,
      pixels
    ),
  ]);
};

/** A zip of stored (uncompressed) entries. */
const storedZip = (entries: ReadonlyArray<{ name: string; data: Buffer }>) => {
  const locals: Array<Buffer> = [];
  const centrals: Array<Buffer> = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf-8");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);

    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
};

/** A minimal DOCX with one paragraph. */
export const docx = (text: string) =>
  storedZip([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
      ),
    },
    {
      name: "word/document.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
      ),
    },
  ]);

// --- The brain's side ----------------------------------------------------------------------------

const decodeShell = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(ShellSnapshot))
);

/** The brain's shell snapshot over `GET /api/shell`. */
const shellOf = async (app: LocalApp) => {
  // Through the proxy, which presents the request as Caddy would.
  const response = await fetch(`${app.origin}/api/shell`);

  return decodeShell(await response.text());
};

/** Waits for the thread's next assistant reply after `afterMs` and returns its text. */
const replyAfter = async (
  app: LocalApp,
  threadId: ThreadId,
  afterMs: number
): Promise<Option.Option<string>> => {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling the shell, on purpose
    const shell = await shellOf(app);
    const row = shell.threads.find((thread) => thread.id === threadId);

    const reply = Option.flatMap(Option.fromUndefinedOr(row), (found) =>
      found.activity === "idle" && Option.isNone(found.activeRunId)
        ? Option.filter(
            found.latestVisibleMessage,
            (message) =>
              message.role === "assistant" &&
              DateTime.toEpochMillis(message.at) > afterMs
          )
        : Option.none()
    );

    if (Option.isSome(reply)) {
      return Option.some(reply.value.text);
    }

    if (row?.activity === "failed") {
      return Option.none();
    }

    // oxlint-disable-next-line no-await-in-loop -- polling the shell, on purpose
    await sleep(250);
  }

  return Option.none();
};

const eventsOf = (app: LocalApp) =>
  Events.parseLines(readFileSync(app.events, "utf-8"));

const millis = (event: BrainEvent) => DateTime.toEpochMillis(event.at);

/** The first `name` line at or after `fromMs`, polled until `timeoutMs`. */
const eventAfter = async (
  app: LocalApp,
  name: string,
  fromMs: number,
  timeoutMs = 15_000
): Promise<Option.Option<BrainEvent>> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = eventsOf(app).find(
      (event) => event.event === name && millis(event) >= fromMs
    );

    if (found !== undefined) {
      return Option.some(found);
    }

    // oxlint-disable-next-line no-await-in-loop -- polling the events log, on purpose
    await sleep(20);
  }

  return Option.none();
};

/** The sha256 of the prepared image as the provider receives it: base64 text. */
const preparedSha = (app: LocalApp, attachmentId: string) =>
  createHash("sha256")
    .update(
      readFileSync(
        path.join(app.dataDir, "attachments", `${attachmentId}.prepared`)
      ).toString("base64")
    )
    .digest("hex");

const decodeImages = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ sha256: Schema.String }))
);

const requestImageShas = (event: BrainEvent): ReadonlyArray<string> =>
  Option.match(decodeImages(event.fields.images), {
    onNone: () => [],
    onSome: (images) => images.map((image) => image.sha256),
  });

// --- The page's side -----------------------------------------------------------------------------

const ANY_CHIP = '[data-testid="attachment-chip"]';

const READY_CHIP =
  '[data-testid="attachment-chip"][data-attachment-state="ready"]';

/** Clicks send; resolves with the click's epoch milliseconds. */
const clickSend = async (page: Page): Promise<number> =>
  await page.evaluate(() => {
    const at = performance.timeOrigin + performance.now();

    document
      .querySelector<HTMLButtonElement>('[data-testid="composer-send"]')
      ?.click();

    return at;
  });

/** Types `text` and clicks send; resolves with the click's epoch milliseconds. */
const send = async (page: Page, text: string): Promise<number> => {
  await page.getByTestId("composer-editor").fill(text);

  return await clickSend(page);
};

interface Pasted {
  /** The paste, in the page's epoch milliseconds. */
  readonly pasteAt: number;
  /** Paste to the chip's ready state; -1 when it never got there. */
  readonly pasteToChipMs: number;
  readonly attachmentId: string;
  /** The send click, when `sendAtOnce`, in epoch milliseconds. */
  readonly sendAt: number;
}

/**
 * Pastes a generated file into the composer and waits for its chip to be ready. An image is
 * drawn in the page (`png`, a screenshot-like PNG with `word` on it); other files come as base64.
 */
const pasteFile = async (
  page: Page,
  file:
    | { readonly kind: "png"; readonly word: string }
    | {
        readonly kind: "bytes";
        readonly name: string;
        readonly type: string;
        readonly base64: string;
      },
  sendAtOnce: boolean
): Promise<Pasted> => {
  const started = await page.evaluate(
    async ({ file: source, screen, ready }) => {
      const blob = await (async () => {
        if (source.kind === "bytes") {
          const bytes = Uint8Array.from(
            atob(source.base64),
            (char) => char.codePointAt(0) ?? 0
          );

          return new File([bytes], source.name, { type: source.type });
        }

        const canvas = new OffscreenCanvas(screen.width, screen.height);
        const draw = canvas.getContext("2d");

        if (draw === null) {
          throw new Error("judges/paste.ts: no 2d canvas in the page.");
        }

        // A phone screenshot's shape: a status bar, a few grey text lines, the word large.
        draw.fillStyle = "#ffffff";
        draw.fillRect(0, 0, screen.width, screen.height);
        draw.fillStyle = "#d4d4d4";

        for (let line = 0; line < 12; line += 1) {
          draw.fillRect(80, 300 + line * 90, 700 + ((line * 97) % 300), 36);
        }

        draw.fillStyle = "#111111";
        draw.font = "bold 150px sans-serif";
        draw.fillText(source.word, 80, 1700);

        const png = await canvas.convertToBlob({ type: "image/png" });

        return new File([png], "screenshot.png", { type: "image/png" });
      })();

      const editor = document.querySelector('[data-testid="composer-editor"]');
      const before = document.querySelectorAll(ready).length;

      const chipsBefore = document.querySelectorAll(
        '[data-testid="attachment-chip"]'
      ).length;

      const transfer = new DataTransfer();

      transfer.items.add(blob);

      const pasteAt = performance.timeOrigin + performance.now();

      editor?.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        })
      );

      return { pasteAt, before, chipsBefore };
    },
    { file, screen: SCREEN, ready: READY_CHIP }
  );

  if (sendAtOnce) {
    // The user's thumb lands on send as soon as the chip shows, while it is still uploading.
    await page.waitForFunction(
      ({ chip, count }) => document.querySelectorAll(chip).length > count,
      { chip: ANY_CHIP, count: started.chipsBefore },
      { polling: "raf", timeout: 5000 }
    );

    return {
      pasteAt: started.pasteAt,
      pasteToChipMs: -1,
      attachmentId: "",
      sendAt: await clickSend(page),
    };
  }

  const readyAt = await page
    .waitForFunction(
      ({ ready, before }) =>
        document.querySelectorAll(ready).length > before
          ? performance.timeOrigin + performance.now()
          : 0,
      { ready: READY_CHIP, before: started.before },
      { polling: "raf", timeout: 20_000 }
    )
    .then(async (handle) => await handle.jsonValue())
    .catch(() => -1);

  const attachmentId =
    readyAt === -1
      ? ""
      : await page
          .locator(READY_CHIP)
          .last()
          .evaluate((chip) =>
            chip instanceof HTMLElement ? (chip.dataset.attachmentId ?? "") : ""
          );

  return {
    pasteAt: started.pasteAt,
    pasteToChipMs: readyAt === -1 ? -1 : readyAt - started.pasteAt,
    attachmentId,
    sendAt: 0,
  };
};

/** The views the pastes go into: the app's frame (the only views since plan 7A). */
const UI = "next";

const openThread = async (
  browser: Browser,
  app: LocalApp,
  threadId: ThreadId
): Promise<{ page: Page; cdp: CDPSession; close: () => Promise<void> }> => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  await cdp.send("Network.enable");
  await page.goto(`${app.origin}/t/${threadId}`, { waitUntil: "load" });

  await page
    .locator('#root[data-ui="next"]')
    .waitFor({ state: "attached", timeout: 30_000 });

  await page.getByTestId("composer-editor").waitFor({ timeout: 30_000 });

  return {
    page,
    cdp,
    close: async () => {
      await context.close();
    },
  };
};

const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = values.toSorted((a, b) => a - b);

  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0
  );
};

/** One case's measured values, as the result line prints them. */
type Detail = Readonly<Record<string, Schema.Json>>;

const cases: Record<string, Schema.Json> = {};

const failures: Array<string> = [];

const record = (name: string, ok: boolean, detail: Detail) => {
  cases[name] = { ...detail, ok };

  if (!ok) {
    failures.push(name);
  }
};

/** The timing runs on one profile, against the judge-model brain. */
const timingRuns = async (
  app: LocalApp,
  page: Page,
  threadId: ThreadId,
  runs: number
) => {
  const chipMs: Array<number> = [];
  const submitMs: Array<number> = [];
  let shaMatches = 0;

  for (let run = 0; run < runs; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one paste after another, on purpose
    const pasted = await pasteFile(page, { kind: "png", word: nonce() }, false);

    chipMs.push(pasted.pasteToChipMs);

    // oxlint-disable-next-line no-await-in-loop -- one paste after another, on purpose
    const sendAt = await send(page, "What word is in the image?");

    // oxlint-disable-next-line no-await-in-loop -- one paste after another, on purpose
    const submitted = await eventAfter(app, "turn.submitted", sendAt - 5);

    // oxlint-disable-next-line no-await-in-loop -- one paste after another, on purpose
    const request = await eventAfter(app, "provider.request", sendAt - 5);

    submitMs.push(
      Option.match(submitted, {
        onNone: () => Number.POSITIVE_INFINITY,
        onSome: (event) => millis(event) - sendAt,
      })
    );

    if (
      pasted.attachmentId !== "" &&
      Option.exists(request, (event) =>
        requestImageShas(event).includes(preparedSha(app, pasted.attachmentId))
      )
    ) {
      shaMatches += 1;
    }

    // oxlint-disable-next-line no-await-in-loop -- one turn at a time, on purpose
    await replyAfter(app, threadId, sendAt);
  }

  return {
    runs,
    pasteToChipP50: Math.round(percentile(chipMs, 0.5)),
    pasteToChipP95: Math.round(percentile(chipMs, 0.95)),
    sendToSubmittedMax: Math.round(Math.max(...submitMs)),
    sendToSubmittedP50: Math.round(percentile(submitMs, 0.5)),
    shaMatches,
    ok:
      !chipMs.includes(-1) &&
      percentile(chipMs, 0.95) <= PASTE_TO_CHIP_P95_MS &&
      Math.max(...submitMs) <= SEND_TO_SUBMITTED_MS &&
      shaMatches === runs,
  };
};

/** Paste and send at once: paste to the provider request with the image. */
const atOnceRuns = async (app: LocalApp, page: Page, threadId: ThreadId) => {
  const totals: Array<number> = [];

  for (let run = 0; run < AT_ONCE_RUNS; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one paste after another, on purpose
    await page
      .getByTestId("composer-editor")
      .fill("What word is in the image?");

    // oxlint-disable-next-line no-await-in-loop -- one paste after another, on purpose
    const pasted = await pasteFile(page, { kind: "png", word: nonce() }, true);

    // oxlint-disable-next-line no-await-in-loop -- one paste after another, on purpose
    const issued = await eventAfter(
      app,
      "attachment.url_issued",
      pasted.pasteAt
    );

    // oxlint-disable-next-line no-await-in-loop -- one paste after another, on purpose
    await eventAfter(app, "attachment.prepared", pasted.pasteAt);

    const id = Option.flatMap(issued, (event) =>
      Events.stringField(event, "attachmentId")
    );

    // oxlint-disable-next-line no-await-in-loop -- one paste after another, on purpose
    const request = await eventAfter(app, "provider.request", pasted.pasteAt);

    // The request must carry this paste's image, not an earlier one.
    const carried = Option.exists(request, (event) =>
      Option.exists(id, (attachmentId) =>
        requestImageShas(event).includes(preparedSha(app, attachmentId))
      )
    );

    totals.push(
      Option.match(
        Option.filter(request, () => carried),
        {
          onNone: () => Number.POSITIVE_INFINITY,
          onSome: (event) => millis(event) - pasted.pasteAt,
        }
      )
    );

    // oxlint-disable-next-line no-await-in-loop -- one turn at a time, on purpose
    await replyAfter(app, threadId, pasted.pasteAt);
  }

  return {
    runs: AT_ONCE_RUNS,
    pasteToProviderMax: Math.round(Math.max(...totals)),
    pasteToProviderP50: Math.round(percentile(totals, 0.5)),
    ok: Math.max(...totals) <= PASTE_AND_SEND_MS,
  };
};

const bytesFile = (name: string, type: string, data: Buffer) =>
  ({ kind: "bytes", name, type, base64: data.toString("base64") }) as const;

/** The 51 MiB PDF: refused before upload with the composer's notice. */
const oversize = async (page: Page) => {
  await page.evaluate(() => {
    const bytes = new Uint8Array(51 * 1024 * 1024);

    bytes.set(new TextEncoder().encode("%PDF-1.4\n"));

    const transfer = new DataTransfer();

    transfer.items.add(
      new File([bytes], "huge.pdf", { type: "application/pdf" })
    );
    document.querySelector('[data-testid="composer-editor"]')?.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      })
    );
  });

  await page.getByTestId("attachment-notice").waitFor({ timeout: 5000 });

  const notice = await page.getByTestId("attachment-notice").textContent();

  return notice ?? "";
};

/** One real-model question about a pasted file; the answer must contain every expected word. */
const ask = async (
  app: LocalApp,
  browser: Browser,
  model: ModelRef,
  file: Parameters<typeof pasteFile>[1],
  question: string,
  expected: ReadonlyArray<string>
) => {
  const [threadId] = await Effect.runPromise(
    launchThreads(app, 1, { model, text: "Reply with the word: ready." })
  );

  if (threadId === undefined) {
    return { ok: false, detail: "no thread launched" };
  }

  await replyAfter(app, threadId, 0);

  const opened = await openThread(browser, app, threadId);

  try {
    const pasted = await pasteFile(opened.page, file, false);
    const sendAt = await send(opened.page, question);
    const reply = await replyAfter(app, threadId, sendAt);

    const text = Option.getOrElse(reply, () => "");

    return {
      ok:
        pasted.pasteToChipMs >= 0 &&
        expected.every((word) =>
          text.toLowerCase().includes(word.toLowerCase())
        ),
      model: `${model.provider}/${model.modelId}`,
      expected,
      answered: Option.isSome(reply),
      // Only whether each expected word appeared, and the answer's length: no reply text.
      found: expected.map((word) =>
        text.toLowerCase().includes(word.toLowerCase())
      ),
      answerChars: text.length,
    };
  } finally {
    await opened.close();
  }
};

const realModels = async (browser: Browser) => {
  const app = await startLocalApp({ models: "real", label: "paste-real" });

  try {
    const models = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* localClient(app);

        return (yield* client["models.list"]()).models;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );

    const openCode = Option.fromUndefinedOr(
      models.find(
        (listing: ModelListing) =>
          listing.provider === "opencode-go" &&
          listing.available &&
          listing.acceptsImages
      )
    );

    const word = nonce();

    record(
      "real-bridge-image",
      ...(await (async () => {
        const result = await ask(
          app,
          browser,
          BRIDGE_MODEL,
          { kind: "png", word },
          "What word is written large in the image? Reply with that word only.",
          [word]
        );

        return [result.ok, result] as const;
      })())
    );

    const openCodeWord = nonce();

    const openCodeResult = await Option.match(openCode, {
      onNone: async () =>
        await Promise.resolve({
          ok: false,
          detail: "no opencode-go model takes images",
        }),
      onSome: async (listing) =>
        await ask(
          app,
          browser,
          { provider: listing.provider, modelId: listing.modelId },
          { kind: "png", word: openCodeWord },
          "What word is written large in the image? Reply with that word only.",
          [openCodeWord]
        ),
    });

    record("real-opencode-image", openCodeResult.ok, openCodeResult);

    const pages = [nonce(), nonce(), nonce()];

    const pdf = await ask(
      app,
      browser,
      BRIDGE_MODEL,
      bytesFile(
        "three-pages.pdf",
        "application/pdf",
        textPdf(
          pages.map((page, index) => `Page ${index + 1} code word: ${page}`)
        )
      ),
      "List the code word on each page of the attached PDF, separated by spaces. Use no tool.",
      pages
    );

    record("real-pdf-three-pages", pdf.ok, pdf);

    const scanned = await ask(
      app,
      browser,
      BRIDGE_MODEL,
      bytesFile("scan.pdf", "application/pdf", scannedPdf()),
      "Quote, word for word, the bracketed note your input gives about the attached PDF. Use no tool.",
      ["no text layer"]
    );

    record("real-pdf-scanned-note", scanned.ok, scanned);

    const docxWord = nonce();

    const document = await ask(
      app,
      browser,
      BRIDGE_MODEL,
      bytesFile(
        "note.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        docx(`The code word is ${docxWord}.`)
      ),
      "What is the code word in the attached document? Reply with the word only. Use no tool.",
      [docxWord]
    );

    record("real-docx", document.ok, document);
  } finally {
    await app.stop();
  }
};

/** The phone half: a nonce page, then the deployed brain's journal until a paste reaches the model. */
const phonePage = async (waitSeconds: number) => {
  const word = nonce();

  const dir = path.join(
    os.homedir(),
    "Developer/agent-artifacts/cairn/v2/phase-1-paste"
  );

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paste judge</title><body style="font:600 18vw system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#fff;color:#111">${word}</body>\n`
  );

  process.stdout.write(
    `${JSON.stringify({
      page: "https://plans.gneiss.run/cairn/v2/phase-1-paste/",
      word,
      steps:
        "Screenshot the page on the phone, paste it into a Cairn thread, ask what word it shows, and send.",
    })}\n`
  );

  // journalctl reads a bare timestamp in the machine's zone; say UTC outright.
  const since = `${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;
  const deadline = Date.now() + waitSeconds * 1000;

  while (Date.now() < deadline) {
    const verdict = pasteVerdict(
      Events.parseLines(readLog({ log: Option.none(), unit: "cairn", since }))
    );

    if (verdict.verdict !== "incomplete") {
      process.stdout.write(`${JSON.stringify(verdict)}\n`);
      process.exitCode = verdict.verdict === "pass" ? 0 : 1;

      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- polling the journal, on purpose
    await sleep(2000);
  }

  process.stdout.write(`${JSON.stringify({ verdict: "incomplete" })}\n`);
  process.exitCode = 2;
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "20" },
      "skip-real": { type: "boolean", default: false },
      headed: { type: "boolean", default: false },
      page: { type: "boolean", default: false },
      wait: { type: "string", default: "600" },
    },
  });

  if (values.page) {
    await phonePage(Number(values.wait));

    return;
  }

  const runs = Number(values.runs);
  const browser = await chromium.launch({ headless: !values.headed });

  try {
    const app = await startLocalApp({ models: "judge", label: "paste" });

    try {
      const [threadId] = await Effect.runPromise(launchThreads(app, 1));

      if (threadId === undefined) {
        throw new Error("judges/paste.ts: no thread launched.");
      }

      await replyAfter(app, threadId, 0);

      const opened = await openThread(browser, app, threadId);

      try {
        const lan = await timingRuns(app, opened.page, threadId, runs);

        record("timing-lan", lan.ok, lan);

        await opened.cdp.send("Network.emulateNetworkConditions", THROTTLED);

        const throttled = await timingRuns(app, opened.page, threadId, runs);

        record("timing-throttled", throttled.ok, throttled);

        await opened.cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });

        const atOnce = await atOnceRuns(app, opened.page, threadId);

        record("paste-and-send-at-once", atOnce.ok, atOnce);

        const huge = await oversize(opened.page);

        record("pdf-51-mib-refused", huge.includes("are refused"), {
          notice: huge,
        });
      } finally {
        await opened.close();
      }
    } finally {
      await app.stop();
    }

    if (!values["skip-real"]) {
      await realModels(browser);
    }
  } finally {
    await browser.close();
  }

  const pass = failures.length === 0;

  process.stdout.write(
    `${JSON.stringify({ pass, ui: UI, failures, cases })}\n`
  );
  process.exitCode = pass ? 0 : 1;
};

if (import.meta.main) {
  await main();
}
