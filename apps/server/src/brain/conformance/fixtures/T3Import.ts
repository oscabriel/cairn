// The t3code thread importer (plan 4F): turns a t3code thread's projection into pi-shaped entries,
// so Cairn's transcript shows the same conversation t3code shows and the parity judges can
// compare the two row by row.
//
// The input is the export `judges/capture.ts t3` writes from t3code's
// `orchestration_v2_projection_turn_items` rows (t3code `fe27e8e3`,
// apps/server/src/orchestration-v2/projection): one record per run, its turn items in order. The
// mapping reads t3code's item kinds, not its code, so no source is copied.
//
// - `user_message` is one `pi.user` entry at the run's request time.
// - `reasoning` and `assistant_message` are thinking and text blocks of one assistant message; a
//   tool item adds a tool call to it, and the next item after the tool calls closes it as
//   `toolUse`, followed by one `pi.tool-result` entry per call.
// - Tools take the names Cairn's coding tools have: `command_execution` is `bash`,
//   `file_change` is `write` (a created file) or `edit`, `web_search` is `web_search`, and a
//   `dynamic_tool` keeps its own name, lower-cased (`Read` is `read`).
// - The run's last assistant message ends at the run's completion, so "Worked for" reads the
//   same duration t3code shows.
// - Checkpoints, notices, interrupts, compactions, approvals and subagents have no entry in a
//   pi transcript; they are counted in `skipped`.
import type {
  AssistantMessage,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Option, Schema } from "effect";

/** One t3code turn item, with the fields the importer reads. */
const T3Item = Schema.Struct({
  type: Schema.String,
  startedAtMs: Schema.Finite,
  completedAtMs: Schema.OptionFromNullOr(Schema.Finite),
  /** The text of a message or of reasoning. */
  text: Schema.OptionFromNullOr(Schema.String),
  /** A tool's name, for `dynamic_tool`. */
  toolName: Schema.OptionFromNullOr(Schema.String),
  /** A tool's title as t3code shows it ("Read /tmp/a.png"). */
  title: Schema.OptionFromNullOr(Schema.String),
  /** A command line. */
  input: Schema.OptionFromNullOr(Schema.String),
  /** A dynamic tool's arguments. */
  arguments: Schema.OptionFromNullOr(Schema.Record(Schema.String, Schema.Json)),
  /** What the tool returned, already cut by the exporter. */
  output: Schema.OptionFromNullOr(Schema.String),
  /** The path a file change touched. */
  path: Schema.OptionFromNullOr(Schema.String),
  /** Whether a file change created its file. */
  created: Schema.Boolean,
  isError: Schema.Boolean,
});

export type T3Item = typeof T3Item.Type;

/** One run of the thread: the prompt that started it and everything it did. */
const T3Run = Schema.Struct({
  ordinal: Schema.Int,
  requestedAtMs: Schema.Finite,
  completedAtMs: Schema.OptionFromNullOr(Schema.Finite),
  items: Schema.Array(T3Item),
});

export type T3Run = typeof T3Run.Type;

/** A t3code thread as the capture judge exports it. */
export const T3ThreadExport = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  projectTitle: Schema.String,
  /** The model t3code ran, for the assistant messages' `model`. */
  model: Schema.String,
  runs: Schema.Array(T3Run),
});

export type T3ThreadExport = typeof T3ThreadExport.Type;

const decodeExport = Schema.decodeEffect(Schema.fromJsonString(T3ThreadExport));

/** Parses an export file's text. */
export const parseT3ThreadExport = (text: string) => decodeExport(text);

const encodeExport = Schema.encodeSync(Schema.fromJsonString(T3ThreadExport));

/** Writes an export as the JSON the capture judge commits. */
export const formatT3ThreadExport = (thread: T3ThreadExport): string =>
  encodeExport(thread);

/** One entry of the imported transcript, before a store gives it an id. */
export interface ImportedEntry {
  readonly kind: "pi.user" | "pi.assistant" | "pi.tool-result";
  readonly model: ReadonlyArray<Message>;
}

/** The imported transcript, and how many t3code items had no pi entry, by type. */
export interface ImportedThread {
  readonly entries: ReadonlyArray<ImportedEntry>;
  readonly skipped: Readonly<Record<string, number>>;
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const TOOL_ITEMS = new Set([
  "command_execution",
  "file_change",
  "dynamic_tool",
  "web_search",
]);

const TEXT_ITEMS = new Set(["reasoning", "assistant_message"]);

/** The pi tool call a t3code tool item stands for. */
const toolCallOf = (item: T3Item, id: string): ToolCall => {
  if (item.type === "command_execution") {
    return {
      type: "toolCall",
      id,
      name: "bash",
      arguments: {
        command: Option.getOrElse(item.input, () => ""),
      },
    };
  }

  if (item.type === "file_change") {
    return {
      type: "toolCall",
      id,
      name: item.created ? "write" : "edit",
      arguments: { path: Option.getOrElse(item.path, () => "") },
    };
  }

  if (item.type === "web_search") {
    return {
      type: "toolCall",
      id,
      name: "web_search",
      arguments: { query: Option.getOrElse(item.title, () => "") },
    };
  }

  return {
    type: "toolCall",
    id,
    name: Option.getOrElse(item.toolName, () => "tool").toLowerCase(),
    arguments: Option.getOrElse(item.arguments, () => ({})),
  };
};

const endOf = (item: T3Item) =>
  Option.getOrElse(item.completedAtMs, () => item.startedAtMs);

/** Imports one run: its prompt, then its assistant messages and tool results in order. */
const importRun = (
  run: T3Run,
  model: string,
  skipped: Map<string, number>
): ReadonlyArray<ImportedEntry> => {
  const entries: Array<ImportedEntry> = [];

  let content: Array<TextContent | ThinkingContent | ToolCall> = [];
  let calls: Array<{ readonly call: ToolCall; readonly item: T3Item }> = [];
  let startedAt = run.requestedAtMs;
  let endedAt = run.requestedAtMs;

  const close = (stopReason: "toolUse" | "stop", end: number) => {
    if (content.length === 0) {
      return;
    }

    const message: AssistantMessage = {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "anthropic",
      model,
      usage: ZERO_USAGE,
      stopReason,
      timestamp: startedAt,
      durationMs: Math.max(0, end - startedAt),
    };

    entries.push({ kind: "pi.assistant", model: [message] });

    for (const { call, item } of calls) {
      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          { type: "text", text: Option.getOrElse(item.output, () => "") },
        ],
        isError: item.isError,
        timestamp: endOf(item),
      };

      entries.push({ kind: "pi.tool-result", model: [result] });
    }

    content = [];
    calls = [];
  };

  for (const [index, item] of run.items.entries()) {
    if (item.type === "user_message") {
      close("toolUse", endedAt);
      entries.push({
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: [
              { type: "text", text: Option.getOrElse(item.text, () => "") },
            ],
            timestamp: item.startedAtMs,
          },
        ],
      });
      startedAt = endOf(item);
      endedAt = startedAt;

      continue;
    }

    const isTool = TOOL_ITEMS.has(item.type);
    const isText = TEXT_ITEMS.has(item.type);

    if (!isTool && !isText) {
      skipped.set(item.type, (skipped.get(item.type) ?? 0) + 1);

      continue;
    }

    // A text block after tool calls starts the next model call.
    if (isText && calls.length > 0) {
      close("toolUse", item.startedAtMs);
      startedAt = item.startedAtMs;
    }

    if (content.length === 0) {
      startedAt = item.startedAtMs;
    }

    if (item.type === "reasoning") {
      content.push({
        type: "thinking",
        thinking: Option.getOrElse(item.text, () => ""),
      });
    } else if (item.type === "assistant_message") {
      content.push({
        type: "text",
        text: Option.getOrElse(item.text, () => ""),
      });
    } else {
      const call = toolCallOf(item, `t3-${run.ordinal}-${index}`);

      content.push(call);
      calls.push({ call, item });
    }

    endedAt = endOf(item);
  }

  const runEnd = Option.getOrElse(run.completedAtMs, () => endedAt);

  close(calls.length > 0 ? "toolUse" : "stop", runEnd);

  return entries;
};

/** Imports a whole export, run by run. */
export const importT3Thread = (thread: T3ThreadExport): ImportedThread => {
  const skipped = new Map<string, number>();

  const entries = thread.runs.flatMap((run) =>
    importRun(run, thread.model, skipped)
  );

  return { entries, skipped: Object.fromEntries(skipped) };
};
