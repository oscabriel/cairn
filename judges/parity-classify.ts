// The parity classification (wave 5 review): sorts every landmark the structure judge flags into a
// declared gap (D1 to D7) or an open item for the user's look (R1 to R10), by the rules below, so the
// gate page's parity tables can be regenerated after every capture instead of by hand.
//
//   node judges/parity-structure.ts               # first: structure.json
//   node judges/parity-classify.ts [--structure <file>]
//
// Prints one JSON line: the totals per reason (landmarks, states), and per state the matched count,
// differ / only t3 / only Cairn, how many are declared and which open items remain. Exits 0 when
// every landmark is classified, 1 when some are not (they are listed, so a new difference cannot
// slip into a category unseen).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";

const Structure = Schema.Struct({
  states: Schema.Record(
    Schema.String,
    Schema.Struct({
      matched: Schema.Finite,
      mismatches: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          differences: Schema.Array(Schema.String),
        })
      ),
      onlyT3: Schema.Array(Schema.String),
      onlyCairn: Schema.Array(Schema.String),
    })
  ),
});

type Side = "differ" | "t3" | "cairn";

interface Landmark {
  readonly state: string;
  readonly group: string;
  readonly width: number;
  readonly side: Side;
  readonly base: string;
  readonly differences: ReadonlyArray<string>;
}

type Reason =
  | "D1"
  | "D2"
  | "D3"
  | "D4"
  | "D5"
  | "D6"
  | "R1"
  | "R2"
  | "R3"
  | "R4"
  | "R5"
  | "R6"
  | "R7"
  | "R8"
  | "R9"
  | "R10";

const COMPOSER =
  /^(?:data-chat-composer-|data-composer-|data-chat-provider-|slot=composer-|testid=composer-|slot=combobox-trigger$|slot=composer-context-strip$)/u;

const BANNER =
  /banner|^data-chat-composer-overlay$|^data-composer-drawer-layer$/u;

const LABELS = new Set([
  "data-composer-label",
  "data-composer-label-motion",
  "data-composer-context-control",
  "data-composer-control-label",
]);

const TOGGLES = new Set([
  "slot=tooltip-trigger",
  "slot=toggle",
  "testid=diff-toggle",
]);

const THREAD_BUTTONS = new Set([
  "slot=button",
  "slot=popover-trigger",
  "slot=menu-trigger",
  "slot=inline-button",
  "slot=kbd",
  "slot=separator",
]);

/** Extra rows only the fixtures carry: five projects against one, 194 skills against one command. */
const FIXTURE_ROWS = new Set([
  "data-composer-item-id",
  "data-composer-mention-chip",
  "slot=badge",
  "slot=combobox-item",
  "slot=combobox-item-content",
  "slot=context-chip-label",
  "slot=sidebar-menu",
  "slot=sidebar-menu-item",
  "slot=sidebar-menu-button",
  "slot=collapsible",
  "slot=collapsible-trigger",
  "testid=sidebar-row-card",
]);

const POPOVER_BOX = new Set([
  "slot=input-control",
  "slot=combobox-input",
  "slot=combobox-positioner",
  "slot=combobox-popup",
]);

const isSizeOnly = (differences: ReadonlyArray<string>) =>
  differences.length > 0 &&
  differences.every((line) => /^(?:width|height) /u.test(line));

const thread = (landmark: Landmark) => landmark.group === "thread";

const hasDifference = (landmark: Landmark, property: string) =>
  landmark.differences.some((line) => line.startsWith(`${property} `));

/** First match wins; the order is the precedence. */
const RULES: ReadonlyArray<{
  readonly reason: Reason;
  readonly when: (landmark: Landmark) => boolean;
}> = [
  {
    reason: "R10",
    when: (l) =>
      l.group === "settings" &&
      l.width === 1440 &&
      l.side === "differ" &&
      l.base === "slot=select-trigger" &&
      hasDifference(l, "line-height"),
  },
  { reason: "D5", when: (l) => l.group === "settings" },
  { reason: "R3", when: (l) => l.base === "testid=timeline-minimap" },
  {
    reason: "R4",
    when: (l) =>
      l.base === "data-chat-workspace-drop-target" && l.side === "t3",
  },
  { reason: "R1", when: (l) => thread(l) && BANNER.test(l.base) },
  {
    reason: "R6",
    when: (l) =>
      thread(l) &&
      l.width === 1440 &&
      l.side === "differ" &&
      l.base === "testid=sidebar-row-card",
  },
  { reason: "R8", when: (l) => l.base.startsWith("testid=sidebar-draft-") },
  {
    reason: "R9",
    when: (l) =>
      l.state.endsWith("-project-popover") &&
      l.side === "differ" &&
      POPOVER_BOX.has(l.base),
  },
  { reason: "D1", when: (l) => TOGGLES.has(l.base) },
  { reason: "D6", when: (l) => l.base.startsWith("slot=scroll-area-") },
  {
    reason: "D4",
    when: (l) =>
      thread(l) &&
      l.side !== "differ" &&
      (l.base.startsWith("row:") || l.base.startsWith("data-changed-files-")),
  },
  {
    reason: "R5",
    when: (l) => thread(l) && l.side === "t3" && THREAD_BUTTONS.has(l.base),
  },
  { reason: "R2", when: (l) => thread(l) && COMPOSER.test(l.base) },
  {
    reason: "R7",
    when: (l) =>
      l.group === "hero" &&
      (l.width === 390 || l.width === 820) &&
      LABELS.has(l.base),
  },
  {
    reason: "D2",
    when: (l) =>
      (l.side === "differ" && isSizeOnly(l.differences)) ||
      (l.side === "t3" && FIXTURE_ROWS.has(l.base)),
  },
  // A row keyed by its place from the end meets another kind of row once the importer skipped some.
  { reason: "D4", when: (l) => thread(l) && l.base.startsWith("row:") },
  {
    reason: "D3",
    when: (l) =>
      l.side === "cairn" && /^(?:testid=|nav=|h1$|slot=|data-)/u.test(l.base),
  },
];

const classify = (landmark: Landmark) =>
  RULES.find((rule) => rule.when(landmark))?.reason;

const landmarksOf = (
  state: string,
  record: (typeof Structure.Type)["states"][string]
): ReadonlyArray<Landmark> => {
  const [group = "", name = ""] = state.split("/");
  const width = Number(name.split("-")[0]);

  const make = (
    side: Side,
    key: string,
    differences: ReadonlyArray<string>
  ) => ({
    state,
    group,
    width,
    side,
    base: key.replace(/#-?\d+$/u, ""),
    differences,
  });

  return [
    ...record.mismatches.map((item) =>
      make("differ", item.key, item.differences)
    ),
    ...record.onlyT3.map((key) => make("t3", key, [])),
    ...record.onlyCairn.map((key) => make("cairn", key, [])),
  ];
};

const { values } = parseArgs({
  options: {
    structure: {
      type: "string",
      default: path.join(
        homedir(),
        "Developer/agent-artifacts/cairn/v2/phase-1-parity/structure.json"
      ),
    },
  },
});

const structure = Schema.decodeUnknownSync(Structure)(
  JSON.parse(readFileSync(values.structure, "utf-8"))
);

const totals = new Map<Reason, { landmarks: number; states: Set<string> }>();

const unclassified: Array<string> = [];

const states = Object.entries(structure.states).map(([state, record]) => {
  const open = new Map<Reason, number>();
  let declared = 0;

  for (const landmark of landmarksOf(state, record)) {
    const reason = classify(landmark);

    if (reason === undefined) {
      unclassified.push(`${state} ${landmark.side} ${landmark.base}`);
      continue;
    }

    const total = totals.get(reason) ?? { landmarks: 0, states: new Set() };

    total.landmarks += 1;
    total.states.add(state);
    totals.set(reason, total);

    if (reason.startsWith("D")) {
      declared += 1;
    } else {
      open.set(reason, (open.get(reason) ?? 0) + 1);
    }
  }

  return {
    state,
    matched: record.matched,
    differ: record.mismatches.length,
    onlyT3: record.onlyT3.length,
    onlyCairn: record.onlyCairn.length,
    declared,
    open: Object.fromEntries(
      [...open].toSorted(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    ),
  };
});

process.stdout.write(
  `${JSON.stringify({
    judge: "parity-classify",
    pass: unclassified.length === 0,
    reasons: Object.fromEntries(
      [...totals].map(([reason, total]) => [
        reason,
        { landmarks: total.landmarks, states: total.states.size },
      ])
    ),
    states,
    unclassified,
  })}\n`
);

process.exitCode = unclassified.length === 0 ? 0 : 1;
