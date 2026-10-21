/* oxlint-disable no-await-in-loop -- the typist sends one key after another, on purpose */
// The composer typing test: type into the composer at a fixed rate while the transcript streams, then compare.
//   node judges/typing.ts <url> [chromium|webkit] [--seconds 60] [--cps 20] [--throttle 4] [--mobile] [--busy <ms>]
//
// The page must render `[data-testid=composer-editor]` and, with `?stream=1`, a streaming
// `[data-testid=stream][data-paragraphs]`; `?busy=<ms>` adds work to every update. Each key goes out on its own
// schedule, so a slow frame can't make the typist wait for the app. Chromium also composes a word through IME events.
// Prints one JSON line and exits 0 when nothing was dropped or reordered and composition worked.
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { chromium, devices, webkit } from "playwright";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: "string", default: "60" },
    cps: { type: "string", default: "20" },
    throttle: { type: "string", default: "1" },
    busy: { type: "string", default: "0" },
    mobile: { type: "boolean", default: false },
  },
});

const [url, browserName = "chromium"] = positionals;

if (url === undefined) {
  throw new Error(
    "usage: typing.ts <url> [chromium|webkit] [--seconds 60] [--cps 20] [--throttle 4] [--mobile]"
  );
}

const isWebkit = browserName === "webkit";

const engine = isWebkit ? webkit : chromium;

const seconds = Number(values.seconds);

const cps = Number(values.cps);

const throttle = Number(values.throttle);

const busy = Number(values.busy);

const mobile = values.mobile || isWebkit;

// Printable text with spaces and punctuation, deterministic, long enough for the run.
const alphabet =
  "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 .,;:!?-_()[]'\"";

let seed = 7;

const nextCharacter = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

  return alphabet[seed % alphabet.length] ?? "a";
};

const text = Array.from({ length: seconds * cps }, nextCharacter).join("");

const browser = await engine.launch();

const { defaultBrowserType: _ignored, ...phone } = devices["iPhone 15"] ?? {};

const context = await browser.newContext(
  mobile ? phone : { viewport: { width: 1440, height: 900 } }
);

const page = await context.newPage();

const errors: Array<string> = [];

page.on("pageerror", (error) => {
  errors.push(String(error));
});

const target = new URL(url);

target.searchParams.set("stream", "1");

if (busy > 0) {
  target.searchParams.set("busy", String(busy));
}

await page.goto(target.href, { waitUntil: "networkidle" });

if (throttle > 1 && !isWebkit) {
  const cdp = await context.newCDPSession(page);

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
}

const composer = page.getByTestId("composer-editor");

const paragraphs = async () =>
  Number(await page.getByTestId("stream").getAttribute("data-paragraphs"));

await composer.click();

const streamedBefore = await paragraphs();

const started = Date.now();

const late: Array<number> = [];

for (let index = 0; index < text.length; index += 1) {
  const character = text.charAt(index);
  const wait = started + (index * 1000) / cps - Date.now();

  if (wait > 0) {
    await sleep(wait);
  } else {
    late.push(-wait);
  }

  await page.keyboard.type(character);
}

const elapsed = (Date.now() - started) / 1000;

await page.waitForTimeout(1000);

const typed = await composer.inputValue();

const streamedAfter = await paragraphs();

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

let firstDiff = -1;

for (let index = 0; index < Math.max(text.length, typed.length); index += 1) {
  if (text.charAt(index) !== typed.charAt(index)) {
    firstDiff = index;
    break;
  }
}

const result = {
  engine: browserName,
  mobile,
  throttle,
  busy,
  cps,
  sent: text.length,
  received: typed.length,
  match: typed === text,
  firstDiff,
  elapsedSeconds: Number(elapsed.toFixed(1)),
  lateKeys: late.length,
  maxLateMs: Math.round(Math.max(0, ...late)),
  paragraphsStreamed: streamedAfter - streamedBefore,
  ime,
  errors,
};

console.log(JSON.stringify(result));

await browser.close();

process.exitCode =
  result.match && (ime === "ok" || ime === "skipped") && errors.length === 0
    ? 0
    : 1;
