/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge compares one pair after another, on purpose */
// The parity pixel judge (plan 4F, D56): compares Cairn's captures with t3code's committed baseline,
// state by state, and writes the pairs, the diffs and a report for the user.
//
//   node judges/capture.ts cairn              # first: Cairn's half, into <out>/cairn/
//   node judges/parity.ts [--out <dir>] [--strict]
//
// For every state in judges/fixtures/parity/t3@fe27e8e3/<group>/states.json it loads t3code's PNG
// and Cairn's, blacks out the state's masks (declared differences, each with its reason) on both,
// and counts the pixels whose colour differs by more than 24 (the sum over red, green and blue) at
// `deviceScaleFactor: 2`. Budget: 0 percent, or 0.05 percent for a state that shows ticking labels.
// A state with no Cairn capture, or one the baseline cannot have (the streaming assistant: the
// read-only pairing cannot start a turn), is listed as missing.
//
// The control must fail as designed: Cairn's phone hero with the sidebar wrongly open
// (`hero/390-control-sidebar-open.png`) against t3code's closed one, unmasked, must differ by more
// than 50 percent, or the judge is blind and exits 1.
//
// Writes <out>/<group>/<view>-<state>-{t3,cairn,diff}.png, <out>/report.json and <out>/index.html.
// Exits 0 when the report is complete and the control failed; `--strict` also requires every state
// within budget, which is wave 5's bar.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";
import { chromium } from "playwright";
import type { Page } from "playwright";

import { Rect } from "./fixtures/parity/Landmarks.ts";

const root = path.join(import.meta.dirname, "..");

const BASELINE = path.join(root, "judges/fixtures/parity/t3@fe27e8e3");

const GROUPS = ["sidebar", "hero", "thread", "settings"] as const;

/** States the baseline cannot hold, with why; reported as missing, not failed silently. */
const UNCAPTURABLE: ReadonlyArray<{
  readonly state: string;
  readonly reason: string;
}> = [
  {
    state: "thread/streaming",
    reason:
      "t3code's read-only pairing cannot start a turn, so a streaming assistant has no baseline",
  },
];

const CONTROL_MIN_PERCENT = 50;

const TICKING_BUDGET = 0.05;

const { values } = parseArgs({
  options: {
    out: {
      type: "string",
      default: path.join(
        homedir(),
        "Developer/agent-artifacts/cairn/v2/phase-1-parity"
      ),
    },
    cairn: { type: "string" },
    strict: { type: "boolean", default: false },
  },
});

const { out } = values;

const cairnDir = values.cairn ?? path.join(out, "cairn");

/** The fields every group's state record shares. */
const StateRecord = Schema.Struct({
  view: Schema.String,
  state: Schema.String,
  clip: Rect,
  masks: Schema.Array(Schema.Struct({ ...Rect.fields, reason: Schema.String })),
});

type StateRecord = typeof StateRecord.Type;

const decodeStates = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(StateRecord))
);

interface Comparison {
  readonly differingPercent: number;
  readonly diff: string;
}

const dataUrl = (file: string) =>
  `data:image/png;base64,${readFileSync(file).toString("base64")}`;

/** Compares two PNGs outside the masks: the share of pixels differing by more than 24. */
const compare = async (
  page: Page,
  left: string,
  right: string,
  masks: StateRecord["masks"]
): Promise<Comparison> =>
  await page.evaluate(
    async ([a, b, rects]) => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
      const image = async (src: string) => {
        const element = new Image();

        element.src = src;
        await element.decode();

        return element;
      };

      const leftImage = await image(a);
      const rightImage = await image(b);
      const width = Math.max(leftImage.width, rightImage.width);
      const height = Math.max(leftImage.height, rightImage.height);

      // Sizes that differ count as differing pixels: the missing area is transparent on one side.
      const pixels = (source: HTMLImageElement) => {
        const canvas = document.createElement("canvas");

        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");

        if (context === null) {
          throw new Error("no 2d context");
        }

        context.drawImage(source, 0, 0);
        context.fillStyle = "#000";

        for (const rect of rects) {
          context.fillRect(
            rect.x * 2,
            rect.y * 2,
            rect.width * 2,
            rect.height * 2
          );
        }

        return context.getImageData(0, 0, width, height).data;
      };

      const pa = pixels(leftImage);
      const pb = pixels(rightImage);
      const diff = new ImageData(width, height);
      let differing = 0;

      for (let index = 0; index < pa.length; index += 4) {
        const delta =
          Math.abs((pa[index] ?? 0) - (pb[index] ?? 0)) +
          Math.abs((pa[index + 1] ?? 0) - (pb[index + 1] ?? 0)) +
          Math.abs((pa[index + 2] ?? 0) - (pb[index + 2] ?? 0)) +
          Math.abs((pa[index + 3] ?? 0) - (pb[index + 3] ?? 0));

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
    [left, right, masks] as const
  );

const writeDataUrl = (file: string, url: string) => {
  writeFileSync(file, Buffer.from(url.split(",")[1] ?? "", "base64"));
};

/** One compared state, as the report lists it. */
interface StateResult {
  readonly group: string;
  readonly name: string;
  readonly differingPercent: number;
  readonly budget: number;
  readonly pass: boolean;
  readonly masks: ReadonlyArray<string>;
}

const results: Array<StateResult> = [];

const missing: Array<{ readonly state: string; readonly reason: string }> = [
  ...UNCAPTURABLE,
];

const browser = await chromium.launch();

const page = await browser.newPage();

let control = { differingPercent: 0, pass: false };

try {
  for (const group of GROUPS) {
    const statesFile = path.join(BASELINE, group, "states.json");

    if (!existsSync(statesFile)) {
      missing.push({ state: group, reason: "no baseline for the group" });
      continue;
    }

    const groupOut = path.join(out, group);

    mkdirSync(groupOut, { recursive: true });

    for (const record of decodeStates(readFileSync(statesFile, "utf-8"))) {
      const name = `${record.view}-${record.state}`;
      const t3 = path.join(BASELINE, group, `${name}.png`);
      const cairn = path.join(cairnDir, group, `${name}.png`);

      if (!existsSync(cairn)) {
        missing.push({
          state: `${group}/${name}`,
          reason: "no Cairn capture: run judges/capture.ts cairn",
        });
        continue;
      }

      const result = await compare(
        page,
        dataUrl(t3),
        dataUrl(cairn),
        record.masks
      );

      copyFileSync(t3, path.join(groupOut, `${name}-t3.png`));
      copyFileSync(cairn, path.join(groupOut, `${name}-cairn.png`));
      writeDataUrl(path.join(groupOut, `${name}-diff.png`), result.diff);

      const ticking = record.masks.some((mask) =>
        mask.reason.startsWith("ticking label")
      );

      const budget = ticking ? TICKING_BUDGET : 0;

      results.push({
        group,
        name,
        differingPercent: result.differingPercent,
        budget,
        pass: result.differingPercent <= budget,
        masks: [...new Set(record.masks.map((mask) => mask.reason))],
      });
      console.log(`${group} ${name}: ${result.differingPercent}%`);
    }
  }

  const controlFile = path.join(cairnDir, "hero/390-control-sidebar-open.png");

  if (existsSync(controlFile)) {
    const result = await compare(
      page,
      dataUrl(path.join(BASELINE, "hero/390-hero.png")),
      dataUrl(controlFile),
      []
    );

    writeDataUrl(path.join(out, "hero/390-control-diff.png"), result.diff);
    control = {
      differingPercent: result.differingPercent,
      pass: result.differingPercent > CONTROL_MIN_PERCENT,
    };
    console.log(
      `control (sidebar wrongly open): ${result.differingPercent}% (must exceed ${CONTROL_MIN_PERCENT}%)`
    );
  }
} finally {
  await browser.close();
}

const passing = results.filter((result) => result.pass).length;

const report = {
  judge: "parity",
  baseline: "t3@fe27e8e3",
  states: results.length,
  passing,
  control,
  missing,
  results,
};

writeFileSync(
  path.join(out, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`
);

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const rows = results
  .map(
    (result) => `<section>
  <h2>${escape(`${result.group} ${result.name}`)}: ${result.differingPercent}% (budget ${result.budget}%) ${result.pass ? "pass" : "differs"}</h2>
  <p>Masked: ${escape(result.masks.join("; ") || "nothing")}</p>
  <div class="pair">
    <figure><img src="${result.group}/${result.name}-t3.png" alt="t3code" /><figcaption>t3code</figcaption></figure>
    <figure><img src="${result.group}/${result.name}-cairn.png" alt="Cairn" /><figcaption>Cairn</figcaption></figure>
    <figure><img src="${result.group}/${result.name}-diff.png" alt="Difference" /><figcaption>Difference (magenta)</figcaption></figure>
  </div>
</section>`
  )
  .join("\n");

writeFileSync(
  path.join(out, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Phase 1 parity report</title>
<style>
body { background: #0b0b0b; color: #e5e5e5; font: 14px system-ui, sans-serif; margin: 24px; }
.pair { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
img { width: 100%; border: 1px solid #333; }
h2 { font-size: 15px; font-weight: 600; }
</style>
</head>
<body>
<h1>Phase 1 parity report</h1>
<p>${passing} of ${results.length} states within budget. Control (sidebar wrongly open): ${control.differingPercent}%, ${control.pass ? "failed as designed" : "did not fail: the judge is blind"}.</p>
<p>Missing: ${escape(missing.map((entry) => `${entry.state} (${entry.reason})`).join("; ") || "none")}</p>
${rows}
</body>
</html>
`
);

console.log(
  JSON.stringify({
    judge: "parity",
    states: results.length,
    passing,
    control,
    missing: missing.length,
    out,
  })
);

const complete = control.pass && results.length > 0;

process.exitCode =
  complete && (!values.strict || passing === results.length) ? 0 : 1;
