// The parity structure judge (plan 4F): where the pixels cannot match (a transcript's text wraps
// differently, a popover lists other items), compare the landmarks instead. For every hero and
// thread state, t3code's landmark file in the committed baseline is matched with Cairn's by key
// (`testid=composer-editor#0`, `row:turn-fold#-1`, `data-chat-composer-form#0`; see
// judges/fixtures/parity/Landmarks.ts), and each pair must agree:
// - box width and height within 1 px;
// - every computed token exactly: font size, line height, weight, colour, background, the four
//   paddings, the radius and the top border width.
// A landmark only t3code has fails its state; one only Cairn has is listed. Class strings are
// compared too and their differences listed, as the guide for writing the view, not as a failure.
//
//   node judges/capture.ts cairn             # first: Cairn's half
//   node judges/parity-structure.ts [--out <dir>] [--strict]
//
// The controls must behave: Cairn's 1440 hero against itself passes, and against the same page
// with one class string sabotaged (`1440-hero.sabotaged.landmarks.json`, the composer editor
// given `text-2xl px-8`) fails on that landmark. Writes <out>/structure.json with every state's
// failures per row kind. Exits 0 when the report is complete and the controls behaved; `--strict`
// also requires every state to pass, which is wave 5's bar.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";

import { LandmarkFile } from "./fixtures/parity/Landmarks.ts";
import type { LandmarkFile as LandmarkFileType } from "./fixtures/parity/Landmarks.ts";

const root = path.join(import.meta.dirname, "..");

const BASELINE = path.join(root, "judges/fixtures/parity/t3@fe27e8e3");

const GROUPS = ["hero", "thread", "settings"] as const;

const BOX_TOLERANCE = 1;

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

type Landmarks = LandmarkFileType;

type Landmark = Landmarks["landmarks"][number];

const decodeLandmarks = Schema.decodeUnknownSync(
  Schema.fromJsonString(LandmarkFile)
);

const StateName = Schema.Struct({ view: Schema.String, state: Schema.String });

const decodeStateNames = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(StateName))
);

const read = (file: string): Landmarks =>
  decodeLandmarks(readFileSync(file, "utf-8"));

/** One landmark that disagrees, with every difference spelled out. */
interface Mismatch {
  readonly key: string;
  readonly differences: ReadonlyArray<string>;
  readonly classOnlyT3: ReadonlyArray<string>;
  readonly classOnlyCairn: ReadonlyArray<string>;
}

/** The comparison of one state. */
interface StateComparison {
  readonly matched: number;
  readonly mismatches: ReadonlyArray<Mismatch>;
  readonly onlyT3: ReadonlyArray<string>;
  readonly onlyCairn: ReadonlyArray<string>;
  /** Per landmark kind (the key without its index): matched, failing and missing counts. */
  readonly kinds: Readonly<
    Record<string, { matched: number; failing: number; missing: number }>
  >;
  readonly pass: boolean;
}

const kindOf = (key: string) => key.replace(/#-?\d+$/u, "");

const classes = (className: string) =>
  new Set(className.split(" ").filter((token) => token !== ""));

const differencesOf = (
  t3: Landmark,
  cairn: Landmark
): ReadonlyArray<string> => {
  const box = (["width", "height"] as const).flatMap((side) =>
    Math.abs(t3.box[side] - cairn.box[side]) > BOX_TOLERANCE
      ? [`${side} ${t3.box[side]} vs ${cairn.box[side]}`]
      : []
  );

  const tokens = Object.entries(t3.tokens).flatMap(([token, value]) =>
    cairn.tokens[token] === value
      ? []
      : [`${token} ${value} vs ${cairn.tokens[token] ?? "unset"}`]
  );

  return [...box, ...tokens];
};

/** Compares t3code's landmarks with Cairn's, key by key. */
export const compareLandmarks = (
  t3: Landmarks,
  cairn: Landmarks
): StateComparison => {
  const cairnByKey = new Map(
    cairn.landmarks.map((landmark) => [landmark.key, landmark])
  );

  const t3Keys = new Set(t3.landmarks.map((landmark) => landmark.key));

  const kinds: Record<
    string,
    { matched: number; failing: number; missing: number }
  > = {};

  const tally = (key: string, field: "matched" | "failing" | "missing") => {
    const kind = kindOf(key);
    const counts = kinds[kind] ?? { matched: 0, failing: 0, missing: 0 };

    counts[field] += 1;
    kinds[kind] = counts;
  };

  const mismatches: Array<Mismatch> = [];
  const onlyT3: Array<string> = [];
  let matched = 0;

  for (const landmark of t3.landmarks) {
    const other = cairnByKey.get(landmark.key);

    if (other === undefined) {
      onlyT3.push(landmark.key);
      tally(landmark.key, "missing");
      continue;
    }

    const differences = differencesOf(landmark, other);

    if (differences.length === 0) {
      matched += 1;
      tally(landmark.key, "matched");
      continue;
    }

    const ours = classes(other.className);
    const theirs = classes(landmark.className);

    mismatches.push({
      key: landmark.key,
      differences,
      classOnlyT3: [...theirs].filter((token) => !ours.has(token)),
      classOnlyCairn: [...ours].filter((token) => !theirs.has(token)),
    });
    tally(landmark.key, "failing");
  }

  const onlyCairn = cairn.landmarks
    .map((landmark) => landmark.key)
    .filter((key) => !t3Keys.has(key));

  return {
    matched,
    mismatches,
    onlyT3,
    onlyCairn,
    kinds,
    pass: mismatches.length === 0 && onlyT3.length === 0,
  };
};

const states: Record<string, StateComparison> = {};

const missing: Array<string> = [];

for (const group of GROUPS) {
  const statesFile = path.join(BASELINE, group, "states.json");

  if (!existsSync(statesFile)) {
    missing.push(`${group}: no baseline`);
    continue;
  }

  for (const { view, state } of decodeStateNames(
    readFileSync(statesFile, "utf-8")
  )) {
    const name = `${view}-${state}.landmarks.json`;
    const cairnFile = path.join(cairnDir, group, name);

    if (!existsSync(cairnFile)) {
      missing.push(`${group}/${view}-${state}: no Cairn capture`);
      continue;
    }

    const comparison = compareLandmarks(
      read(path.join(BASELINE, group, name)),
      read(cairnFile)
    );

    states[`${group}/${view}-${state}`] = comparison;
    console.log(
      `${group} ${view}-${state}: ${comparison.matched} match, ${comparison.mismatches.length} differ, ${comparison.onlyT3.length} only in t3code`
    );
  }
}

const heroFile = path.join(cairnDir, "hero/1440-hero.landmarks.json");

const sabotagedFile = path.join(
  cairnDir,
  "hero/1440-hero.sabotaged.landmarks.json"
);

const controls = (() => {
  if (!existsSync(heroFile) || !existsSync(sabotagedFile)) {
    return { self: false, sabotage: false, sabotagedKeys: [] };
  }

  const hero = read(heroFile);
  const self = compareLandmarks(hero, hero);
  const sabotaged = compareLandmarks(hero, read(sabotagedFile));

  return {
    self: self.pass,
    sabotage:
      !sabotaged.pass &&
      sabotaged.mismatches.some(
        (mismatch) => mismatch.key === "testid=composer-editor#0"
      ),
    sabotagedKeys: sabotaged.mismatches.map((mismatch) => mismatch.key),
  };
})();

const passing = Object.values(states).filter(
  (comparison) => comparison.pass
).length;

mkdirSync(out, { recursive: true });

writeFileSync(
  path.join(out, "structure.json"),
  `${JSON.stringify({ judge: "parity-structure", passing, controls, missing, states }, null, 2)}\n`
);

console.log(
  JSON.stringify({
    judge: "parity-structure",
    states: Object.keys(states).length,
    passing,
    controls: { self: controls.self, sabotage: controls.sabotage },
    missing: missing.length,
  })
);

const complete =
  controls.self && controls.sabotage && Object.keys(states).length > 0;

process.exitCode =
  complete && (!values.strict || passing === Object.keys(states).length)
    ? 0
    : 1;
