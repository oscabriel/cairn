// Ported from cairn-v1, apps/server/src/claude/system-reminder.ts at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0 (Cairn's own code). Behaviour kept: Claude Code stores a
// session's whole system prompt when the session starts and reuses it on resume, so a later change
// reaches the model as one `<system-reminder>` on the next user message, naming exactly the sections
// that changed or were removed, a long section as a capped line diff. Changed: the effective state is
// replayed with pi-ai 1.4.0's `getCurrentSystemMessage`; the rebuild-only history renderer is gone.
//
// Everything works on the effective (replayed) state, never on raw system messages: a compaction
// writes a complete baseline that restates unchanged values, and that must produce no reminder.

import { createHash } from "node:crypto";

import type { Message } from "@earendil-works/pi-ai";
import { contentText, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { Option } from "effect";

/** The effective instructions: the replayed base content, and each section in replay order. */
export interface InstructionState {
  readonly base: string;
  readonly sections: ReadonlyMap<string, string>;
}

/** What a Claude Code session holds of the instructions: a digest of the whole and one per section. */
export interface HeldState {
  readonly digest: string;
  /** Hash of the base content. */
  readonly base: string;
  /** Hash of each section's text, by name. */
  readonly sections: Readonly<Record<string, string>>;
}

const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The effective instructions after replaying every system message in `messages`. */
export const instructionState = (
  messages: ReadonlyArray<Message>
): InstructionState => {
  const current = getCurrentSystemMessage(messages);

  if (current === undefined) {
    return { base: "", sections: new Map() };
  }

  const sections = new Map<string, string>();

  for (const [name, value] of Object.entries(current.sections ?? {})) {
    if (value !== null) {
      sections.set(name, value);
    }
  }

  return { base: contentText(current.content), sections };
};

/** The held form of `state`. The digest ignores section order: a reordering changes no instruction. */
export const heldOf = (state: InstructionState): HeldState => {
  const sections = Object.fromEntries(
    [...state.sections].map(([name, text]) => [name, hash(text)])
  );

  const base = hash(state.base);

  const sorted = Object.keys(sections)
    .toSorted()
    .map((name) => [name, sections[name] ?? ""]);

  const digest = `s2:${createHash("sha256")
    .update(JSON.stringify([base, sorted]))
    .digest("hex")}`;

  return { digest, base, sections };
};

/** The text of `state` as the preset's append: the base content, then each section in replay order. */
export const renderInstructions = (
  state: InstructionState
): Option.Option<string> => {
  const parts = [state.base, ...state.sections.values()].filter(
    (part) => part.length > 0
  );

  return parts.length > 0 ? Option.some(parts.join("\n\n")) : Option.none();
};

/** Finds the text a section had when it hashed to `digest`. */
export type PriorTexts = (
  name: string,
  digest: string
) => Option.Option<string>;

/**
 * Every value each section takes in `messages`, by its hash. Content-addressed, so a resumed session
 * finds the text it holds in any transcript that still carries it.
 */
export const priorTexts = (messages: ReadonlyArray<Message>): PriorTexts => {
  const texts = new Map<string, string>();

  for (const message of messages) {
    if (message.role !== "system") {
      continue;
    }

    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value !== null) {
        texts.set(`${name}\0${hash(value)}`, value);
      }
    }
  }

  return (name, digest) =>
    Option.fromNullishOr(texts.get(`${name}\0${digest}`));
};

/** A changed section longer than this goes as a line diff against the text the session holds. */
export const DIFF_SECTION_BYTES = 4096;

/** A diff longer than this, or than the section itself, goes as the full text instead. */
export const DIFF_CAP_BYTES = 4096;

/** Lines of unchanged text around each change, so a change inside a block says which block it is in. */
const DIFF_CONTEXT = 2;

/** The largest middle part, after the common prefix and suffix, worth diffing. */
const DIFF_MAX_CELLS = 4_000_000;

const bytes = (text: string): number => Buffer.byteLength(text, "utf-8");

interface DiffOp {
  readonly kind: " " | "-" | "+";
  readonly text: string;
}

/** The common prefix length and the end of each side before the common suffix. */
interface Trim {
  readonly start: number;
  readonly endA: number;
  readonly endB: number;
}

const trimCommon = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>
): Trim => {
  let start = 0;

  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }

  let endA = a.length;
  let endB = b.length;

  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  return { start, endA, endB };
};

/** Longest common subsequence lengths of the middle parts, filled from the end. */
const lcsTable = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  trim: Trim
): ((i: number, j: number) => number) => {
  const n = trim.endA - trim.start;
  const m = trim.endB - trim.start;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  const at = (i: number, j: number): number => table[i * width + j] ?? 0;

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[trim.start + i] === b[trim.start + j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  return at;
};

const diffOps = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>
): Option.Option<ReadonlyArray<DiffOp>> => {
  const trim = trimCommon(a, b);
  const n = trim.endA - trim.start;
  const m = trim.endB - trim.start;

  if (n * m > DIFF_MAX_CELLS) {
    return Option.none();
  }

  const at = lcsTable(a, b, trim);

  const ops: Array<DiffOp> = a
    .slice(0, trim.start)
    .map((text) => ({ kind: " ", text }));

  let i = 0;
  let j = 0;

  while (i < n || j < m) {
    const left = a[trim.start + i] ?? "";
    const right = b[trim.start + j] ?? "";

    if (i < n && j < m && left === right) {
      ops.push({ kind: " ", text: left });
      i += 1;
      j += 1;
    } else if (i < n && (j === m || at(i + 1, j) >= at(i, j + 1))) {
      // Removals before additions, as diff prints a replaced line.
      ops.push({ kind: "-", text: left });
      i += 1;
    } else {
      ops.push({ kind: "+", text: right });
      j += 1;
    }
  }

  for (const text of a.slice(trim.endA)) {
    ops.push({ kind: " ", text });
  }

  return Option.some(ops);
};

const hunksOf = (
  ops: ReadonlyArray<DiffOp>
): ReadonlyArray<[number, number]> => {
  const hunks: Array<[number, number]> = [];

  for (const [index, op] of ops.entries()) {
    if (op.kind === " ") {
      continue;
    }

    const from = Math.max(0, index - DIFF_CONTEXT);
    const to = Math.min(ops.length, index + DIFF_CONTEXT + 1);
    const last = hunks.at(-1);

    if (last !== undefined && from <= last[1]) {
      last[1] = Math.max(last[1], to);
    } else {
      hunks.push([from, to]);
    }
  }

  return hunks;
};

/** The 1-based line number on each side at each op. */
interface LineNumbers {
  readonly a: ReadonlyArray<number>;
  readonly b: ReadonlyArray<number>;
}

const lineNumbers = (ops: ReadonlyArray<DiffOp>): LineNumbers => {
  const a: Array<number> = [];
  const b: Array<number> = [];
  let la = 1;
  let lb = 1;

  for (const op of ops) {
    a.push(la);
    b.push(lb);

    if (op.kind !== "+") {
      la += 1;
    }

    if (op.kind !== "-") {
      lb += 1;
    }
  }

  return { a, b };
};

const renderHunks = (ops: ReadonlyArray<DiffOp>): string => {
  const lines = lineNumbers(ops);
  const out: Array<string> = [];

  for (const [from, to] of hunksOf(ops)) {
    const slice = ops.slice(from, to);
    const countA = slice.filter((op) => op.kind !== "+").length;
    const countB = slice.filter((op) => op.kind !== "-").length;
    const firstA = lines.a[from] ?? 1;
    const firstB = lines.b[from] ?? 1;
    // An empty side starts at the line before, as unified diffs number it.
    const startA = countA === 0 ? firstA - 1 : firstA;
    const startB = countB === 0 ? firstB - 1 : firstB;

    out.push(`@@ -${startA},${countA} +${startB},${countB} @@`);

    for (const op of slice) {
      out.push(`${op.kind}${op.text}`);
    }
  }

  return out.join("\n");
};

/**
 * A unified line diff from `before` to `after` (`-` removed, `+` added, ` ` unchanged, a
 * `@@ -a,b +c,d @@` header per hunk), or none when the texts are equal or too far apart to diff.
 */
export const lineDiff = (
  before: string,
  after: string
): Option.Option<string> =>
  before === after
    ? Option.none()
    : Option.map(diffOps(before.split("\n"), after.split("\n")), renderHunks);

const changedSection = (
  name: string,
  text: string,
  earlier: Option.Option<string>
): string => {
  const diff = Option.filter(
    earlier,
    () => bytes(text) > DIFF_SECTION_BYTES
  ).pipe(
    Option.flatMap((before) => lineDiff(before, text)),
    Option.filter(
      (value) => bytes(value) <= DIFF_CAP_BYTES && bytes(value) < bytes(text)
    )
  );

  return Option.match(diff, {
    onNone: () => `Section "${name}" now reads:\n${text}`,
    onSome: (value) =>
      `Section "${name}" changed. Apply this unified line diff to its earlier text (lines starting "-" are removed, "+" added, " " unchanged):\n${value}`,
  });
};

/**
 * The `<system-reminder>` that brings a session holding `held` up to `state`, or none when nothing
 * changed. Added sections go in full, changed ones in full or as a capped diff against the text the
 * session holds (found through `prior`), and removed ones by name.
 */
export const reminderFor = (
  held: HeldState,
  state: InstructionState,
  prior: PriorTexts
): Option.Option<string> => {
  if (heldOf(state).digest === held.digest) {
    return Option.none();
  }

  const changed = [...state.sections].filter(
    ([name, text]) => held.sections[name] !== hash(text)
  );

  const removed = Object.keys(held.sections).filter(
    (name) => !state.sections.has(name)
  );

  const baseChanged = hash(state.base) !== held.base;

  if (changed.length === 0 && removed.length === 0 && !baseChanged) {
    return Option.none();
  }

  const parts = [
    "Your instructions changed since the system prompt was written. What follows replaces the earlier text: each section below now reads as shown, and removed sections no longer apply.",
  ];

  if (baseChanged) {
    parts.push(
      state.base.length > 0
        ? `The base instructions now read:\n${state.base}`
        : "The base instructions were removed."
    );
  }

  for (const [name, text] of changed) {
    const heldDigest = Option.fromNullishOr(held.sections[name]);

    parts.push(
      Option.match(heldDigest, {
        onNone: () => `New section "${name}" now reads:\n${text}`,
        onSome: (digest) => changedSection(name, text, prior(name, digest)),
      })
    );
  }

  if (removed.length > 0) {
    parts.push(
      `Removed sections: ${removed.map((name) => `"${name}"`).join(", ")}.`
    );
  }

  return Option.some(
    `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`
  );
};
