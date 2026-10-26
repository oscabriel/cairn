// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/work-log/presentation.ts
// (`summarizeToolGroup`, `toolGroupSummaryKind`, the action labels and priorities,
// `workEntryIndicatesToolFailure`, `workEntryIndicatesToolSuccess`, `normalizeCompactToolLabel`,
// `liveThoughtLine`), packages/client-runtime/src/work-log/commandLabel.ts (`commandProgramName`,
// `commandDisplayText`), packages/shared/src/toolActivity.ts (`formatReadToolLabel`) and the label
// helpers of apps/web/src/components/chat/MessagesTimeline.logic.ts (`workEntryDisplayLabel`,
// `liveWorkEntryLabel`, `workEntryIsVisibleInGroup`, the single-call label) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the group summary sentence ("Ran 2 commands and
// read 1 file", the two highest-priority groups, "Used <app> integration", "Performed N other
// actions"), the failure and success rules, the live verbs, and the thought line. Changed: entries are
// Cairn's work entries, whose action and status come from pi's tool names and results, so the
// heuristics that guess a tool's kind or failure from free text are gone (a pi tool result says
// `isError`); integrations are the Executor apps a call reached; the shell wrapper parser is reduced
// to environment assignments, `env`, `sudo`, `time` and a leading `cd ... &&`. Removed: T3 MCP tools,
// pull requests, browser, device and thread actions.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { Option } from "effect";

import type {
  ToolAction,
  ToolSource,
  WorkEntry,
  WorkStatus,
} from "./TimelineEntries.ts";

/** The icon family a group's summary shows. */
export type ToolGroupSummaryKind =
  | ToolAction
  | "reasoning"
  | "dynamic-tool"
  | "mixed";

/** Drops a trailing "complete" or "completed" from a tool label. */
export const normalizeCompactToolLabel = (value: string): string =>
  value.replace(/\s+(?:complete|completed)\s*$/iu, "").trim();

/** True for every work entry that stands for model work: tools, thoughts and errors. */
export const workEntryIsToolLike = (entry: WorkEntry): boolean =>
  entry.kind === "tool" || entry.kind === "reasoning" || entry.kind === "error";

/** True when the entry failed, was refused, or is an error. */
export const workEntryIndicatesToolFailure = (entry: WorkEntry): boolean =>
  entry.kind === "error" || entry.status === "failed";

/** True for a tool that finished well; never for a thought, a running call or a stopped one. */
export const workEntryIndicatesToolSuccess = (entry: WorkEntry): boolean =>
  workEntryIsToolLike(entry) &&
  !workEntryIndicatesToolFailure(entry) &&
  entry.kind !== "reasoning" &&
  entry.status !== "inProgress" &&
  entry.status !== "stopped";

/** Neither success nor failure: a thought, a running call or a stopped one. */
export const workEntryIndicatesToolNeutralStatus = (
  entry: WorkEntry
): boolean =>
  workEntryIsToolLike(entry) &&
  !workEntryIndicatesToolFailure(entry) &&
  !workEntryIndicatesToolSuccess(entry);

/**
 * Whether an entry shows inside its group: a thought with text, a failure, a success, a stopped
 * call, and (in the live group) a call still running.
 */
export const workEntryIsVisibleInGroup = (
  entry: WorkEntry,
  expandedToolGroupEntry = false
): boolean => {
  if (entry.kind === "reasoning") {
    return Option.exists(entry.detail, (detail) => detail.trim() !== "");
  }

  return (
    (expandedToolGroupEntry && entry.status === "inProgress") ||
    entry.status === "stopped" ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
};

/** The action a work entry counts as in its group. */
export const toolGroupAction = (entry: WorkEntry): ToolAction => entry.action;

const toolGroupActionCount = (
  action: ToolAction,
  entries: ReadonlyArray<WorkEntry>
): number => {
  if (action !== "edit") {
    return entries.length;
  }

  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;

  for (const entry of entries) {
    if (entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
    } else {
      for (const file of entry.changedFiles) {
        changedFiles.add(file);
      }
    }
  }

  return changedFiles.size + editsWithoutFileDetails;
};

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const ACTION_LABELS: Readonly<Record<ToolAction, (count: number) => string>> = {
  read: (count) => `Read ${plural(count, "file", "files")}`,
  edit: (count) => `Changed ${plural(count, "file", "files")}`,
  command: (count) => `Ran ${plural(count, "command", "commands")}`,
  search: (count) => `Searched the web ${plural(count, "time", "times")}`,
  "code-search": (count) => `Searched code ${plural(count, "time", "times")}`,
  other: (count) => `Used ${plural(count, "tool", "tools")}`,
};

const toolGroupActionLabel = (action: ToolAction, count: number): string =>
  ACTION_LABELS[action](count);

const ACTION_PRIORITY: Readonly<Record<ToolAction, number>> = {
  command: 0,
  edit: 0,
  read: 1,
  search: 1,
  "code-search": 1,
  other: 2,
};

const summaryActionPriority = (action: ToolAction): number =>
  ACTION_PRIORITY[action];

const joinNames = (names: ReadonlyArray<string>): string => {
  if (names.length < 2) {
    return names[0] ?? "";
  }

  if (names.length === 2) {
    return names.join(" and ");
  }

  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1) ?? ""}`;
};

/** A tool group's one-line summary and whether any call in it failed. */
export interface ToolGroupSummary {
  readonly summary: string;
  readonly hasFailure: boolean;
}

/**
 * The one-line summary of a tool group: "Thought" for thoughts alone, else the integrations used,
 * the two highest-priority actions with their counts, and how many other actions there were.
 */
export const summarizeToolGroup = (
  entries: ReadonlyArray<WorkEntry>
): ToolGroupSummary => {
  const toolEntries = entries.filter((entry) => entry.kind !== "reasoning");

  if (entries.length > 0 && toolEntries.length === 0) {
    return {
      summary:
        entries.length === 1 ? "Thought" : `Thought (×${entries.length})`,
      hasFailure: false,
    };
  }

  const groups = new Map<ToolAction, Array<WorkEntry>>();
  const sources = new Map<string, ToolSource>();
  let sourcedCount = 0;

  for (const entry of toolEntries) {
    if (Option.isSome(entry.source)) {
      sources.set(entry.source.value.key, entry.source.value);
      sourcedCount += 1;
      continue;
    }

    const action = toolGroupAction(entry);
    const group = groups.get(action);

    if (group === undefined) {
      groups.set(action, [entry]);
    } else {
      group.push(entry);
    }
  }

  const summaries = [...groups].map(([action, group], index) => ({
    index,
    count: group.length,
    priority: summaryActionPriority(action),
    label: toolGroupActionLabel(action, toolGroupActionCount(action, group)),
    failedCount: group.filter(workEntryIndicatesToolFailure).length,
  }));

  const selected = summaries
    .toSorted((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .toSorted((a, b) => a.index - b.index);

  const labels = selected.map(({ label }) => label);

  if (sources.size > 0) {
    const names = [
      ...new Set([...sources.values()].map((source) => source.name)),
    ];

    labels.unshift(
      `Used ${joinNames(names)} ${names.length === 1 ? "integration" : "integrations"}`
    );
  }

  const remainingCount =
    toolEntries.length -
    sourcedCount -
    selected.reduce((count, group) => count + group.count, 0);

  if (remainingCount > 0) {
    labels.push(
      `Performed ${remainingCount} other ${remainingCount === 1 ? "action" : "actions"}`
    );
  }

  const sentence = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)
  );

  return {
    summary:
      sentence.length < 3
        ? sentence.join(" and ")
        : `${sentence.slice(0, -1).join(", ")}, and ${sentence.at(-1) ?? ""}`,
    hasFailure:
      summaries.some((group) => group.failedCount > 0) ||
      toolEntries.some(
        (entry) =>
          Option.isSome(entry.source) && workEntryIndicatesToolFailure(entry)
      ),
  };
};

/** The icon family for a group: one action, thoughts alone, integrations, or mixed. */
export const toolGroupSummaryKind = (
  entries: ReadonlyArray<WorkEntry>
): ToolGroupSummaryKind => {
  const toolEntries = entries.filter((entry) => entry.kind !== "reasoning");

  if (entries.length > 0 && toolEntries.length === 0) {
    return "reasoning";
  }

  if (
    toolEntries.length > 0 &&
    toolEntries.every((entry) => Option.isSome(entry.source))
  ) {
    return "dynamic-tool";
  }

  const actions = new Set(toolEntries.map(toolGroupAction));
  const [only] = actions;

  return actions.size === 1 && only !== undefined ? only : "mixed";
};

// ---------------------------------------------------------------------------------------------
// Labels

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/u;

const WRAPPERS: ReadonlySet<string> = new Set([
  "env",
  "sudo",
  "time",
  "command",
  "exec",
  "nohup",
]);

/** A command as one line: its first non-empty line, with a marker when more follow. */
export const commandDisplayText = (command: string): string => {
  const lines = command
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const [first = ""] = lines;

  return lines.length > 1 ? `${first} …` : first;
};

/** The program a shell command runs, past assignments, wrappers and a leading `cd <dir> &&`. */
export const commandProgramName = (command: string): Option.Option<string> => {
  let rest = command.trim();
  const cdPrefix = /^cd\s+\S+\s*&&\s*/u.exec(rest);

  if (cdPrefix !== null) {
    rest = rest.slice(cdPrefix[0].length);
  }

  const words = rest.split(/\s+/u).filter((word) => word !== "");

  for (const word of words) {
    if (
      ENV_ASSIGNMENT.test(word) ||
      WRAPPERS.has(word) ||
      word.startsWith("-")
    ) {
      continue;
    }

    const program = word.replaceAll(/^["'(]+|["');|&]+$/gu, "");
    const base = program.split("/").at(-1) ?? program;

    return base === "" ? Option.none() : Option.some(base);
  }

  return Option.none();
};

/** "Read <path>", with "+N more" when the call named more files. */
export const formatReadToolLabel = (path: string, extraCount = 0): string => {
  const trimmed = path.trim();
  const suffix = extraCount > 0 ? ` +${extraCount} more` : "";

  return trimmed === "" ? `Read file${suffix}` : `Read ${trimmed}${suffix}`;
};

/** A path relative to the workspace root when it lies inside it. */
export const formatWorkspaceRelativePath = (
  path: string,
  workspaceRoot: Option.Option<string>
): string =>
  Option.match(workspaceRoot, {
    onNone: () => path,
    onSome: (root) => {
      const base = root.replace(/\/+$/u, "");

      return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
    },
  });

const oneLine = (text: string) => text.trim().replaceAll(/\s+/gu, " ");

const capitalize = (text: string) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The label of a settled work entry. */
export const workEntryDisplayLabel = (
  entry: WorkEntry,
  workspaceRoot: Option.Option<string>
): string => {
  if (entry.kind === "reasoning") {
    return Option.match(entry.detail, {
      onNone: () => "Thought",
      onSome: (detail) => oneLine(detail) || "Thought",
    });
  }

  if (entry.kind !== "tool") {
    return Option.getOrElse(entry.detail, () => "Error");
  }

  if (Option.isSome(entry.command)) {
    return commandDisplayText(entry.command.value);
  }

  const [firstRead] = entry.readPaths;

  if (entry.action === "read" && firstRead !== undefined) {
    return formatReadToolLabel(
      formatWorkspaceRelativePath(firstRead, workspaceRoot),
      entry.readPaths.length - 1
    );
  }

  const [firstChanged] = entry.changedFiles;

  if (firstChanged !== undefined) {
    const path = formatWorkspaceRelativePath(firstChanged, workspaceRoot);

    return entry.changedFiles.length === 1
      ? path
      : `${path} +${entry.changedFiles.length - 1} more`;
  }

  const name = Option.getOrElse(entry.toolName, () => "tool");

  if (entry.action === "code-search") {
    return Option.match(entry.detail, {
      onNone: () => capitalize(normalizeCompactToolLabel(name)),
      onSome: (detail) =>
        name === "ls"
          ? `Listed ${oneLine(detail)}`
          : `Searched ${oneLine(detail)}`,
    });
  }

  if (Option.isSome(entry.source)) {
    return `${capitalize(entry.source.value.name)}: ${name.replace(/^executor[_.]/u, "")}`;
  }

  if (name === "codemode") {
    return "Ran a script";
  }

  return capitalize(normalizeCompactToolLabel(name));
};

/** The label of a group of one call: an edit names its group summary, other calls their own label. */
export const singleToolCallLabel = (
  entry: WorkEntry,
  workspaceRoot: Option.Option<string>
): string =>
  entry.kind === "tool" && entry.action === "edit"
    ? summarizeToolGroup([entry]).summary
    : workEntryDisplayLabel(entry, workspaceRoot);

const SETTLED_VERBS: Readonly<Record<WorkStatus, string>> = {
  inProgress: "Running",
  completed: "Ran",
  failed: "Failed",
  stopped: "Stopped",
};

/**
 * The live row's label: a command in the present or past tense ("Running vitest", "Ran vitest"), a
 * thought's text or "Thinking", else the settled label.
 */
export const liveWorkEntryLabel = (
  entry: WorkEntry,
  workspaceRoot: Option.Option<string>,
  active: boolean
): string => {
  const inProgress =
    entry.status === "inProgress" ||
    (active && entry.status !== "failed" && entry.status !== "stopped");

  if (entry.kind === "reasoning") {
    return Option.match(entry.detail, {
      onNone: () => (inProgress ? "Thinking" : "Thought"),
      onSome: (detail) =>
        oneLine(detail) || (inProgress ? "Thinking" : "Thought"),
    });
  }

  if (Option.isSome(entry.command)) {
    const verb = inProgress ? "Running" : SETTLED_VERBS[entry.status];

    return `${verb} ${Option.getOrElse(commandProgramName(entry.command.value), () => "command")}`;
  }

  return workEntryDisplayLabel(entry, workspaceRoot);
};

/**
 * The first sentence of a thought, or its bold opening line, with markdown flattened: the line the
 * live row shows while the model thinks.
 */
export const liveThoughtLine = (markdown: string): string => {
  const heading = /^\s*\*\*(?<heading>[^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/u.exec(
    markdown
  )?.groups?.heading;

  const text = (heading ?? markdown)
    .replaceAll(/!?\[(?<label>[^\]]*)\]\([^)]*\)/gu, "$<label>")
    .replaceAll(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gmu, "")
    .replaceAll(/`+|\*\*|~~/gu, "")
    .replaceAll(
      /(?<before>^|[^\w*])[*_](?<inner>[^*_\n]+)[*_](?![\w*])/gu,
      "$<before>$<inner>"
    )
    .replaceAll(/\s+/gu, " ")
    .trim();

  if (heading !== undefined) {
    return text;
  }

  const end = /[.?!]["'”’)]?(?=\s)/u.exec(text);

  return end === null ? text : text.slice(0, end.index + end[0].length);
};
