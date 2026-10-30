// A folded turn's tallies (surfaces note S12, plan look track L7): the fold line says what the
// hidden work was, "Worked for 3m 41s · 4 edits · 9 reads · 2 commands · 2 agents", so a reader
// sees the shape of a turn without opening it. MonoCode's `workSummaryLine` ("Edited 3 files · Ran
// 2 commands") and HumanLayer's "Explored 7 items" gave the idea; the words and order are Cairn's.
//
// Only tool calls count: a thought, an error or a compaction says nothing about what the turn did.
// A call's action decides its word (`toolActionOf`); `subagent_spawn` counts as an agent, and
// every other tool (Executor's, a pi tool, the brain's own) as a tool. A part that counts nothing
// is left out, and the parts keep one order, so the line reads the same turn after turn.

import { Option } from "effect";

import type { ToolAction, WorkEntry } from "./TimelineEntries.ts";

/** One count and its word: `{ count: 4, word: "edits" }`. */
export interface FoldTallyPart {
  readonly count: number;
  readonly word: string;
}

/** What a fold's tally counts, in the order the line shows it. */
type FoldTallyKind = "edit" | "read" | "search" | "command" | "agent" | "tool";

const ORDER: ReadonlyArray<FoldTallyKind> = [
  "edit",
  "read",
  "search",
  "command",
  "agent",
  "tool",
];

const WORDS: Readonly<
  Record<FoldTallyKind, readonly [one: string, many: string]>
> = {
  edit: ["edit", "edits"],
  read: ["read", "reads"],
  search: ["search", "searches"],
  command: ["command", "commands"],
  agent: ["agent", "agents"],
  tool: ["tool", "tools"],
};

/** What each tool action counts as. */
const KIND_OF_ACTION: Readonly<Record<ToolAction, FoldTallyKind>> = {
  edit: "edit",
  read: "read",
  "code-search": "search",
  search: "search",
  command: "command",
  other: "tool",
};

/** The tool that starts a subagent (plan 3A). */
const SPAWN_TOOL = "subagent_spawn";

const kindOf = (entry: WorkEntry): FoldTallyKind | undefined => {
  if (entry.kind !== "tool") {
    return undefined;
  }

  if (Option.contains(entry.toolName, SPAWN_TOOL)) {
    return "agent";
  }

  return KIND_OF_ACTION[entry.action];
};

/** The tally of `entries`: each kind that counts something, in the line's order. */
export const foldTally = (
  entries: Iterable<WorkEntry>
): ReadonlyArray<FoldTallyPart> => {
  const counts = new Map<FoldTallyKind, number>();

  for (const entry of entries) {
    const kind = kindOf(entry);

    if (kind !== undefined) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }

  return ORDER.flatMap((kind) => {
    const count = counts.get(kind) ?? 0;
    const [one, many] = WORDS[kind];

    return count === 0 ? [] : [{ count, word: count === 1 ? one : many }];
  });
};

/** The tally as it reads: "4 edits · 9 reads"; empty when nothing counted. */
export const foldTallyText = (parts: ReadonlyArray<FoldTallyPart>): string =>
  parts.map((part) => `${String(part.count)} ${part.word}`).join(" · ");
