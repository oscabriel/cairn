// The transcript's entries, read from a thread's projected pi-durable view. t3code derives its
// timeline from orchestration turn items (apps/web/src/session-logic.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92); Cairn's source is pi's own transcript, so this module is
// new code that yields the same two shapes t3code's rows consume, `message` and `work` entries, plus
// the turns they belong to. No t3code text is copied here.
//
// The rules, decided up front (plan 3C, notes/client.md risk 5):
// - A turn is one user message (`pi.user` or `cairn.user`) through the assistant and tool messages
//   before the next user message. Entries before any user message (a compacted thread's head)
//   belong to the turn `turn:start`.
// - A turn's elapsed time is the end of its last assistant message (`timestamp + durationMs`) or
//   tool result, whichever is later, minus the user message's `timestamp`.
// - A turn is interrupted when an assistant message stopped with `aborted`, or a tool result
//   carries the harness's `aborted` diagnostic (a stop during a tool writes no assistant message).
//   It failed when an assistant message stopped with `error`.
// - Tool kinds: `bash` is a command, `read` a read, `edit` and `write` a file change, `grep`,
//   `find` and `ls` a code search, `codemode` a script whose nested Executor calls name their app,
//   and the Executor proxies are dynamic tools labelled by their app.
// - `cairn.user` carries the turn's attachments in `data.attachments`; `cairn.checkpoint` is a
//   display entry; `cairn.hidden` (a `pi.system` entry the wire hides) is skipped.
// - A user message shows the user's words: the parts the brain added for attachments (text blocks
//   and path lines) become chips. An attachment shows once: the wire points an image attachment's
//   content at its attachment id, so an image whose attachment `data.attachments` lists is left to
//   that ref, and only other images (an imported thread's) are kept as images.
// - Row keys are stable across streaming: the n-th assistant message of a turn is `msg:<turn>:<n>`
//   whether it is the live partial in `pi.live` or the committed entry, a tool call is
//   `tool:<callId>` from its first token to its result, and a thought is keyed by its message and
//   content index. So the streaming row and the settled row share a key, as in t3code.
//
// Entries are immutable and the client's applier shares unchanged ones, so each entry's reading is
// cached by identity, and a view whose entries did not change reuses the whole committed reading.
import type { AttachmentRef } from "@cairn/protocol/Attachments";
import {
  AttachmentRef as AttachmentRefSchema,
  parseAttachmentPathLine,
  parseAttachmentText,
} from "@cairn/protocol/Attachments";
import type { EntryId } from "@cairn/protocol/Ids";
import type { ConversationView, Entry } from "@cairn/protocol/Thread";
import {
  NOTICE_ENTRY_KIND,
  NoticeEntryData,
  ProjectedImage,
} from "@cairn/protocol/Thread";
import { Array, Data, Function, Option, Predicate, Schema } from "effect";

import { checkpointSummaryOf } from "./DiffTree.ts";
import type { TurnDiffFile } from "./DiffTree.ts";

// ---------------------------------------------------------------------------------------------
// Types

/** What a tool call did, for its label and its group's summary. */
export type ToolAction =
  | "read"
  | "edit"
  | "command"
  | "code-search"
  | "search"
  | "other";

/** Where a work entry stands. */
export type WorkStatus = "inProgress" | "completed" | "failed" | "stopped";

/** An app a tool reached through Executor: the "Used <name> integration" label. */
export interface ToolSource {
  readonly key: string;
  readonly name: string;
}

/** One call a `codemode` script made, as its result recorded it. */
export interface NestedCall {
  readonly name: string;
  readonly status: "ok" | "error" | "unfinished";
  /** The Executor path a proxy call named, such as `tools.github.issues.list`. */
  readonly path: Option.Option<string>;
}

/** A message the transcript shows: the user's input or the assistant's text. */
export interface TimelineMessage {
  /** The row key: `user:<entryId>` or `msg:<turnId>:<n>`. */
  readonly id: string;
  readonly role: "user" | "assistant";
  /** What the message says, without attachment and skill blocks. */
  readonly text: string;
  readonly turnId: string;
  /** None while the message is the live partial. */
  readonly entryId: Option.Option<EntryId>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly streaming: boolean;
  /** `cairn.user` attachments, as the entry recorded them. */
  readonly attachments: ReadonlyArray<AttachmentRef>;
  /** Attachments the content names (text blocks) that `attachments` does not list. */
  readonly attachmentNames: ReadonlyArray<string>;
  /** Images in the user's content, by reference. */
  readonly images: ReadonlyArray<ProjectedImage>;
  /** Skills the turn expanded (`<skill name="...">` blocks). */
  readonly skills: ReadonlyArray<string>;
}

/** A tool call, a thought, an error or a compaction. */
export interface WorkEntry {
  /** `tool:<callId>`, `think:<messageKey>:<index>`, `error:<messageKey>` or `context:<entryId>`. */
  readonly id: string;
  readonly kind: "tool" | "reasoning" | "error" | "compaction";
  readonly turnId: string;
  readonly createdAt: number;
  readonly completedAt: Option.Option<number>;
  readonly status: WorkStatus;
  /** The tool's name, for tool entries. */
  readonly toolName: Option.Option<string>;
  readonly action: ToolAction;
  /** A bash call's command. */
  readonly command: Option.Option<string>;
  /** Files an edit or a write changed, as the call named them. */
  readonly changedFiles: ReadonlyArray<string>;
  /** Files a read named. */
  readonly readPaths: ReadonlyArray<string>;
  /** A search's pattern, a thought's text, an error's text, or a script's code. */
  readonly detail: Option.Option<string>;
  /** The tool's text output, without the harness's diagnostics block. */
  readonly output: Option.Option<string>;
  readonly source: Option.Option<ToolSource>;
  readonly nestedCalls: ReadonlyArray<NestedCall>;
}

/** One entry of the transcript, before rows are derived. */
export type TimelineEntry =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly createdAt: number;
      readonly message: TimelineMessage;
    }
  | {
      readonly kind: "work";
      readonly id: string;
      readonly createdAt: number;
      readonly entry: WorkEntry;
    }
  | {
      readonly kind: "checkpoint";
      readonly id: string;
      readonly createdAt: number;
      readonly turnId: string;
      readonly ref: string;
      readonly turn: number;
      readonly files: ReadonlyArray<TurnDiffFile>;
      readonly moreFiles: number;
    };

/** How a turn ended, or that it is still running. */
export type TurnStatus = "running" | "completed" | "interrupted" | "failed";

/** One turn: a user message and the work and answers after it. */
export interface TimelineTurn {
  readonly id: string;
  readonly userEntryId: Option.Option<EntryId>;
  readonly startedAt: number;
  /** The latest end of an assistant message or a tool result; none before either exists. */
  readonly endedAt: Option.Option<number>;
  readonly status: TurnStatus;
  /** A failed turn's error text: its last assistant message stopped with an error. */
  readonly error: Option.Option<string>;
}

/** The transcript of one thread, read from its view. */
export interface Timeline {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly turns: ReadonlyArray<TimelineTurn>;
  /** True while pi-durable has a run (`pi.live.run`). */
  readonly isWorking: boolean;
  /** The running turn while working. */
  readonly activeTurnId: Option.Option<string>;
  readonly activeTurnStartedAt: Option.Option<number>;
}

/** The turn key of entries before any user message. */
export const START_TURN_ID = "turn:start";

/** A turn's key from its user entry. */
export const turnIdOf = (entryId: number): string => `turn:${entryId}`;

/** Milliseconds a turn took, when it has an end. */
export const turnElapsedMs = (turn: TimelineTurn): Option.Option<number> =>
  Option.map(turn.endedAt, (end) => Math.max(0, end - turn.startedAt));

// ---------------------------------------------------------------------------------------------
// Decoding: entries are JSON the brain owns, so every message is decoded before it is read.

const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const ThinkingPart = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  redacted: Schema.optionalKey(Schema.Boolean),
});

const ToolCallPart = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Json),
});

const decodeText = Schema.decodeUnknownOption(TextPart);

const decodeThinking = Schema.decodeUnknownOption(ThinkingPart);

const decodeToolCall = Schema.decodeUnknownOption(ToolCallPart);

const decodeImage = Schema.decodeUnknownOption(ProjectedImage);

const decodeNotice = Schema.decodeUnknownOption(NoticeEntryData);

const decodeAttachments = Schema.decodeUnknownOption(
  Schema.Struct({ attachments: Schema.Array(AttachmentRefSchema) })
);

const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
  timestamp: Schema.Finite,
});

const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Json),
  stopReason: Schema.String,
  errorMessage: Schema.optionalKey(Schema.String),
  timestamp: Schema.Finite,
  durationMs: Schema.optionalKey(Schema.Finite),
});

const NestedCallRecord = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Json),
  status: Schema.Literals(["ok", "error", "unfinished"]),
});

const ToolResultMessage = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Json),
  isError: Schema.Boolean,
  timestamp: Schema.Finite,
  durationMs: Schema.optionalKey(Schema.Finite),
  nestedCalls: Schema.optionalKey(
    Schema.Struct({ calls: Schema.Array(Schema.Json) })
  ),
});

const decodeUser = Schema.decodeUnknownOption(UserMessage);

const decodeAssistant = Schema.decodeUnknownOption(AssistantMessage);

const decodeToolResult = Schema.decodeUnknownOption(ToolResultMessage);

const decodeNestedCall = Schema.decodeUnknownOption(NestedCallRecord);

const Diagnostics = Schema.Struct({
  diagnostics: Schema.Array(Schema.Struct({ code: Schema.String })),
});

const decodeDiagnostics = Schema.decodeUnknownOption(Diagnostics);

const ToolSlot = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["pending", "running", "done"]),
  output: Schema.optionalKey(Schema.String),
});

const LiveDoc = Schema.Struct({
  run: Schema.optionalKey(Schema.Json),
  generation: Schema.optionalKey(
    Schema.Struct({ message: Schema.optionalKey(Schema.Json) })
  ),
  tools: Schema.optionalKey(Schema.Array(Schema.Json)),
});

const decodeLive = Schema.decodeUnknownOption(LiveDoc);

const decodeSlot = Schema.decodeUnknownOption(ToolSlot);

type UserMessage = typeof UserMessage.Type;

type AssistantMessage = typeof AssistantMessage.Type;

type ToolResultMessage = typeof ToolResultMessage.Type;

const firstModel = (entry: Entry): Option.Option<unknown> =>
  Option.flatMap(Option.fromUndefinedOr(entry.model), Array.head);

// ---------------------------------------------------------------------------------------------
// Tool presentation inputs

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json);

const decodeRecord = Schema.decodeUnknownOption(JsonRecordSchema);

const stringField = (
  args: Option.Option<unknown>,
  key: string
): Option.Option<string> =>
  Option.flatMap(Option.flatMap(args, decodeRecord), (record) => {
    const value = record[key];

    return Predicate.isString(value) && value.trim() !== ""
      ? Option.some(value)
      : Option.none();
  });

const EXECUTOR_PROXY = /^executor[_.](?:call|execute|search|describe|skills)$/u;

/** The app an Executor path names: `tools.github.issues.list` gives `github`. */
export const executorApp = (path: string): Option.Option<string> => {
  const parts = path.split(".").filter((part) => part !== "");
  const app = parts[0] === "tools" ? parts[1] : parts[0];

  return app === undefined ? Option.none() : Option.some(app);
};

const sourceOfApp = (app: string): ToolSource => ({
  key: `executor:${app}`,
  name: app,
});

/** The action a tool name stands for. */
export const toolActionOf = (name: string): ToolAction => {
  switch (name) {
    case "bash": {
      return "command";
    }

    case "read": {
      return "read";
    }

    case "edit":
    case "write": {
      return "edit";
    }

    case "grep":
    case "find":
    case "ls": {
      return "code-search";
    }

    case "web_search":
    case "web_fetch": {
      return "search";
    }

    default: {
      return "other";
    }
  }
};

const HARNESS_BLOCK = /\n?<harness>\n[\s\S]*?\n<\/harness>\s*$/u;

/** A tool result's text, without the diagnostics block the harness appends. */
const resultText = (result: ToolResultMessage): Option.Option<string> => {
  const text = Array.getSomes(result.content.map((part) => decodeText(part)))
    .map((part) => part.text)
    .join("\n")
    .replace(HARNESS_BLOCK, "");

  return text.trim() === "" ? Option.none() : Option.some(text);
};

const nestedCallsOf = (
  result: Option.Option<ToolResultMessage>
): ReadonlyArray<NestedCall> =>
  Option.match(
    Option.flatMap(result, (found) =>
      Option.fromUndefinedOr(found.nestedCalls)
    ),
    {
      onNone: () => [],
      onSome: (nested) =>
        Array.getSomes(nested.calls.map((call) => decodeNestedCall(call))).map(
          (call) => ({
            name: call.name,
            status: call.status,
            path: stringField(Option.fromUndefinedOr(call.arguments), "path"),
          })
        ),
    }
  );

const sourceOfCall = (
  name: string,
  args: Option.Option<unknown>,
  nested: ReadonlyArray<NestedCall>
): Option.Option<ToolSource> => {
  if (EXECUTOR_PROXY.test(name)) {
    return Option.map(
      Option.flatMap(stringField(args, "path"), executorApp),
      sourceOfApp
    );
  }

  return Option.map(
    Array.findFirst(nested, (call) =>
      Option.isSome(Option.flatMap(call.path, executorApp))
    ).pipe(Option.flatMap((call) => Option.flatMap(call.path, executorApp))),
    sourceOfApp
  );
};

const wasAborted = (entry: Entry): boolean =>
  Option.exists(decodeDiagnostics(entry.data), (data) =>
    data.diagnostics.some((diagnostic) => diagnostic.code === "aborted")
  );

interface ToolCallInput {
  readonly callId: string;
  readonly name: string;
  readonly args: Option.Option<unknown>;
  readonly turnId: string;
  readonly createdAt: number;
}

interface ToolResultInput {
  readonly result: ToolResultMessage;
  readonly aborted: boolean;
}

const toolWork = (
  call: ToolCallInput,
  result: Option.Option<ToolResultInput>,
  liveOutput: Option.Option<string>,
  interruptedTurn: boolean
): WorkEntry => {
  const resultMessage = Option.map(result, (found) => found.result);
  const nested = nestedCallsOf(resultMessage);

  const action = EXECUTOR_PROXY.test(call.name)
    ? "other"
    : toolActionOf(call.name);

  const path = stringField(call.args, "path");

  const status: WorkStatus = Option.match(result, {
    onNone: () => (interruptedTurn ? "stopped" : "inProgress"),
    onSome: (found) => {
      if (found.aborted) {
        return "stopped";
      }

      return found.result.isError ? "failed" : "completed";
    },
  });

  return {
    id: `tool:${call.callId}`,
    kind: "tool",
    turnId: call.turnId,
    createdAt: call.createdAt,
    completedAt: Option.map(resultMessage, (found) => found.timestamp),
    status,
    toolName: Option.some(call.name),
    action,
    command:
      call.name === "bash" ? stringField(call.args, "command") : Option.none(),
    changedFiles: action === "edit" ? Option.toArray(path) : [],
    readPaths: action === "read" ? Option.toArray(path) : [],
    detail: Option.orElse(
      Option.orElse(stringField(call.args, "pattern"), () =>
        stringField(call.args, "query")
      ),
      () =>
        call.name === "codemode"
          ? stringField(call.args, "code")
          : stringField(call.args, "path")
    ),
    output: Option.orElse(
      Option.flatMap(resultMessage, resultText),
      () => liveOutput
    ),
    source: sourceOfCall(call.name, call.args, nested),
    nestedCalls: nested,
  };
};

// ---------------------------------------------------------------------------------------------
// User messages

const SKILL_BLOCK =
  /^<skill name="(?<name>[^"]+)"[^>]*>[\s\S]*?<\/skill>(?<rest>[\s\S]*)$/u;

interface UserReading {
  readonly text: string;
  readonly images: ReadonlyArray<ProjectedImage>;
  readonly attachmentNames: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
}

const readUserContent = (message: UserMessage): UserReading => {
  if (Predicate.isString(message.content)) {
    return {
      text: message.content,
      images: [],
      attachmentNames: [],
      skills: [],
    };
  }

  const texts: Array<string> = [];
  const images: Array<ProjectedImage> = [];
  const attachmentNames: Array<string> = [];
  const skills: Array<string> = [];

  for (const part of message.content) {
    const image = decodeImage(part);

    if (Option.isSome(image)) {
      images.push(image.value);
      continue;
    }

    const text = decodeText(part);

    if (Option.isNone(text)) {
      continue;
    }

    const attachment = parseAttachmentText(text.value.text);

    if (Option.isSome(attachment)) {
      attachmentNames.push(attachment.value.name);
      continue;
    }

    const pathLine = parseAttachmentPathLine(text.value.text);

    // An image's path line follows the image itself, which already shows.
    if (Option.isSome(pathLine)) {
      if (pathLine.value.kind === "file") {
        attachmentNames.push(pathLine.value.name);
      }

      continue;
    }

    const skill = SKILL_BLOCK.exec(text.value.text);
    const name = skill?.groups?.name;

    if (name !== undefined) {
      skills.push(name);

      const rest = (skill?.groups?.rest ?? "").trim();

      if (rest !== "") {
        texts.push(rest);
      }

      continue;
    }

    texts.push(text.value.text);
  }

  return { text: texts.join("\n\n"), images, attachmentNames, skills };
};

// ---------------------------------------------------------------------------------------------
// The committed reading

/** What one entry contributes, decoded once per entry object. */
type EntryReading = Data.TaggedEnum<{
  User: {
    readonly entry: Entry;
    readonly message: UserMessage;
    readonly reading: UserReading;
    readonly attachments: ReadonlyArray<AttachmentRef>;
  };
  Assistant: {
    readonly entry: Entry;
    readonly message: AssistantMessage;
  };
  ToolResult: {
    readonly entry: Entry;
    readonly result: ToolResultMessage;
    readonly aborted: boolean;
  };
  Compaction: {
    readonly entry: Entry;
    /** None for a plain reset, which records no message. */
    readonly at: Option.Option<number>;
    readonly reset: boolean;
  };
  Checkpoint: {
    readonly entry: Entry;
    readonly ref: string;
    readonly turn: number;
    readonly files: ReadonlyArray<TurnDiffFile>;
    readonly moreFiles: number;
    readonly userEntryId: Option.Option<number>;
  };
  /** Display-only text the brain wrote into the transcript, such as why a launch failed. */
  Notice: { readonly entry: Entry; readonly text: string };
  /** An entry the transcript does not show, by its kind. */
  Skip: { readonly kind: string };
}>;

const EntryReading = Data.taggedEnum<EntryReading>();

const readings = new WeakMap<Entry, EntryReading>();

const readEntryUncached = (entry: Entry): EntryReading => {
  switch (entry.kind) {
    case "pi.user":
    case "cairn.user": {
      return Option.match(Option.flatMap(firstModel(entry), decodeUser), {
        onNone: () => EntryReading.Skip({ kind: entry.kind }),
        onSome: (message) =>
          EntryReading.User({
            entry,
            message,
            reading: readUserContent(message),
            attachments: Option.match(decodeAttachments(entry.data), {
              onNone: () => [],
              onSome: (data) => data.attachments,
            }),
          }),
      });
    }

    case "pi.assistant": {
      return Option.match(Option.flatMap(firstModel(entry), decodeAssistant), {
        onNone: () => EntryReading.Skip({ kind: entry.kind }),
        onSome: (message) => EntryReading.Assistant({ entry, message }),
      });
    }

    case "pi.tool-result": {
      return Option.match(Option.flatMap(firstModel(entry), decodeToolResult), {
        onNone: () => EntryReading.Skip({ kind: entry.kind }),
        onSome: (result) =>
          EntryReading.ToolResult({
            entry,
            result,
            aborted: wasAborted(entry),
          }),
      });
    }

    case "pi.compaction":
    case "pi.reset": {
      return EntryReading.Compaction({
        entry,
        reset: entry.kind === "pi.reset",
        at: Option.map(
          Option.flatMap(firstModel(entry), decodeUser),
          (message) => message.timestamp
        ),
      });
    }

    case "cairn.checkpoint": {
      return Option.match(checkpointSummaryOf(entry.data), {
        onNone: () => EntryReading.Skip({ kind: entry.kind }),
        onSome: (data) =>
          EntryReading.Checkpoint({
            entry,
            ref: data.ref,
            turn: data.turn,
            files: data.files,
            moreFiles: data.moreFiles,
            userEntryId: data.userEntryId,
          }),
      });
    }

    case NOTICE_ENTRY_KIND: {
      return Option.match(decodeNotice(entry.data), {
        onNone: () => EntryReading.Skip({ kind: entry.kind }),
        onSome: ({ text }) => EntryReading.Notice({ entry, text }),
      });
    }

    default: {
      return EntryReading.Skip({ kind: entry.kind });
    }
  }
};

const readEntry = (entry: Entry): EntryReading => {
  const cached = readings.get(entry);

  if (cached !== undefined) {
    return cached;
  }

  const reading = readEntryUncached(entry);

  readings.set(entry, reading);

  return reading;
};

const assistantText = (message: AssistantMessage): string =>
  Array.getSomes(message.content.map((part) => decodeText(part)))
    .map((part) => part.text)
    .join("");

const assistantEnd = (message: AssistantMessage): number =>
  message.timestamp + (message.durationMs ?? 0);

/** The live run's state, from `pi.live`. */
interface LiveReading {
  readonly running: boolean;
  readonly partial: Option.Option<AssistantMessage>;
  readonly slots: ReadonlyMap<string, typeof ToolSlot.Type>;
}

const readLive = (docs: ConversationView["docs"]): LiveReading => {
  const live = decodeLive(docs["pi.live"]);

  return {
    running: Option.exists(live, (doc) => doc.run !== undefined),
    partial: Option.flatMap(live, (doc) =>
      Option.flatMap(
        Option.flatMap(Option.fromUndefinedOr(doc.generation), (generation) =>
          Option.fromUndefinedOr(generation.message)
        ),
        decodeAssistant
      )
    ),
    slots: new Map(
      Option.match(live, {
        onNone: () => [],
        onSome: (doc) =>
          Array.getSomes((doc.tools ?? []).map((slot) => decodeSlot(slot))).map(
            (slot) => [slot.callId, slot] as const
          ),
      })
    ),
  };
};

interface TurnBuilder {
  readonly id: string;
  readonly userEntryId: Option.Option<EntryId>;
  readonly startedAt: number;
  endedAt: Option.Option<number>;
  interrupted: boolean;
  error: Option.Option<string>;
  assistantCount: number;
}

const extendEnd = (turn: TurnBuilder, at: number) => {
  turn.endedAt = Option.some(
    Option.match(turn.endedAt, {
      onNone: () => at,
      onSome: (end) => Math.max(end, at),
    })
  );
};

/** Turns an assistant message (committed or live) into its timeline entries. */
const assistantEntries = (
  message: AssistantMessage,
  turn: TurnBuilder,
  entryId: Option.Option<EntryId>,
  streaming: boolean,
  results: ReadonlyMap<string, ToolResultInput>,
  slots: LiveReading["slots"],
  interruptedTurn: boolean
): ReadonlyArray<TimelineEntry> => {
  const index = turn.assistantCount;
  const key = `msg:${turn.id}:${index}`;
  const out: Array<TimelineEntry> = [];
  const end = assistantEnd(message);

  turn.assistantCount += 1;

  for (const [partIndex, part] of message.content.entries()) {
    const thinking = decodeThinking(part);

    if (
      Option.isSome(thinking) &&
      thinking.value.redacted !== true &&
      thinking.value.thinking.trim() !== ""
    ) {
      const id = `think:${key}:${partIndex}`;

      out.push({
        kind: "work",
        id,
        createdAt: message.timestamp,
        entry: {
          id,
          kind: "reasoning",
          turnId: turn.id,
          createdAt: message.timestamp,
          completedAt: streaming ? Option.none() : Option.some(end),
          status: streaming ? "inProgress" : "completed",
          toolName: Option.none(),
          action: "other",
          command: Option.none(),
          changedFiles: [],
          readPaths: [],
          detail: Option.some(thinking.value.thinking),
          output: Option.none(),
          source: Option.none(),
          nestedCalls: [],
        },
      });
    }
  }

  const text = assistantText(message);

  if (text.trim() !== "") {
    out.push({
      kind: "message",
      id: key,
      createdAt: message.timestamp,
      message: {
        id: key,
        role: "assistant",
        text,
        turnId: turn.id,
        entryId,
        createdAt: message.timestamp,
        updatedAt: end,
        streaming,
        attachments: [],
        attachmentNames: [],
        images: [],
        skills: [],
      },
    });
  }

  for (const part of message.content) {
    const call = decodeToolCall(part);

    if (Option.isNone(call)) {
      continue;
    }

    const slot = Option.fromUndefinedOr(slots.get(call.value.id));

    const work = toolWork(
      {
        callId: call.value.id,
        name: call.value.name,
        args: Option.fromUndefinedOr(call.value.arguments),
        turnId: turn.id,
        createdAt: end,
      },
      Option.fromUndefinedOr(results.get(call.value.id)),
      Option.flatMap(slot, (found) => Option.fromUndefinedOr(found.output)),
      interruptedTurn
    );

    out.push({
      kind: "work",
      id: work.id,
      createdAt: work.createdAt,
      entry: work,
    });
  }

  if (!streaming) {
    turn.error =
      message.stopReason === "error"
        ? Option.some(message.errorMessage ?? "The model request failed.")
        : Option.none();
  }

  if (message.stopReason === "error" && !streaming) {
    const id = `error:${key}`;
    const errorText = message.errorMessage ?? "The model request failed.";

    out.push({
      kind: "work",
      id,
      createdAt: end,
      entry: {
        id,
        kind: "error",
        turnId: turn.id,
        createdAt: end,
        completedAt: Option.some(end),
        status: "failed",
        toolName: Option.none(),
        action: "other",
        command: Option.none(),
        changedFiles: [],
        readPaths: [],
        detail: Option.some(errorText),
        output: Option.none(),
        source: Option.none(),
        nestedCalls: [],
      },
    });
  }

  return out;
};

const newTurn = (
  id: string,
  userEntryId: Option.Option<EntryId>,
  startedAt: number
): TurnBuilder => ({
  id,
  userEntryId,
  startedAt,
  endedAt: Option.none(),
  interrupted: false,
  error: Option.none(),
  assistantCount: 0,
});

interface CommittedReading {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly turns: ReadonlyArray<TurnBuilder>;
  /** The result of every answered tool call, by call id. */
  readonly results: ReadonlyMap<string, ToolResultInput>;
  /** Where in `entries` the tool calls with no result sit: live output is laid over these only. */
  readonly unanswered: ReadonlyArray<{
    readonly index: number;
    readonly callId: string;
  }>;
}

const NO_SLOTS: LiveReading["slots"] = new Map();

// One shared empty page, so a view with no older pages hits the memo by identity.
const NO_OLDER: ReadonlyArray<Entry> = [];

/**
 * Reads the committed entries. `running` decides how an unanswered tool call shows (stopped once
 * the run is over), so it is part of the cache key; its live output is laid over afterwards.
 */
const readCommitted = (
  source: ReadonlyArray<Entry>,
  running: boolean
): CommittedReading => {
  const slots = NO_SLOTS;
  const decoded = source.map(readEntry);
  const results = new Map<string, ToolResultInput>();

  for (const reading of decoded) {
    if (EntryReading.$is("ToolResult")(reading)) {
      results.set(reading.result.toolCallId, {
        result: reading.result,
        aborted: reading.aborted,
      });
    }
  }

  // A turn is interrupted when a stop aborted one of its messages or tools; decided before its
  // entries are built, because an unanswered call of an interrupted turn shows as stopped.
  const interruptedTurns = new Set<string>();
  let currentTurnId = START_TURN_ID;

  for (const reading of decoded) {
    if (EntryReading.$is("User")(reading)) {
      currentTurnId = turnIdOf(reading.entry.id);
    } else if (
      (EntryReading.$is("Assistant")(reading) &&
        reading.message.stopReason === "aborted") ||
      (EntryReading.$is("ToolResult")(reading) && reading.aborted)
    ) {
      interruptedTurns.add(currentTurnId);
    }
  }

  const entries: Array<TimelineEntry> = [];
  const turns: Array<TurnBuilder> = [];
  let turn: TurnBuilder | undefined;

  const currentTurn = (at: number): TurnBuilder => {
    if (turn === undefined) {
      turn = newTurn(START_TURN_ID, Option.none(), at);
      turns.push(turn);
    }

    return turn;
  };

  const read = EntryReading.$match({
    User: (found) => {
      const id = turnIdOf(found.entry.id);

      turn = newTurn(id, Option.some(found.entry.id), found.message.timestamp);
      turns.push(turn);

      const key = `user:${found.entry.id}`;

      entries.push({
        kind: "message",
        id: key,
        createdAt: found.message.timestamp,
        message: {
          id: key,
          role: "user",
          text: found.reading.text,
          turnId: id,
          entryId: Option.some(found.entry.id),
          createdAt: found.message.timestamp,
          updatedAt: found.message.timestamp,
          streaming: false,
          attachments: found.attachments,
          attachmentNames: found.reading.attachmentNames.filter(
            (name) =>
              !found.attachments.some((attachment) => attachment.name === name)
          ),
          images: found.reading.images.filter((image) => {
            const { ref } = image;

            return !(
              Predicate.isTagged(ref, "Attachment") &&
              found.attachments.some(
                (attachment) => attachment.id === ref.attachmentId
              )
            );
          }),
          skills: found.reading.skills,
        },
      });
    },

    Assistant: (found) => {
      const owner = currentTurn(found.message.timestamp);
      const interrupted = interruptedTurns.has(owner.id);

      extendEnd(owner, assistantEnd(found.message));
      owner.interrupted ||= found.message.stopReason === "aborted";
      entries.push(
        ...assistantEntries(
          found.message,
          owner,
          Option.some(found.entry.id),
          false,
          results,
          slots,
          interrupted || !running
        )
      );
    },

    ToolResult: (found) => {
      const owner = currentTurn(found.result.timestamp);

      extendEnd(owner, found.result.timestamp);
      owner.interrupted ||= found.aborted;
    },

    Compaction: (found) => {
      const previousEnd = Option.flatMap(
        Option.fromUndefinedOr(turn),
        (previous) =>
          Option.orElse(previous.endedAt, () => Option.some(previous.startedAt))
      );

      const at = Option.getOrElse(
        Option.orElse(found.at, () => previousEnd),
        () => 0
      );

      const owner = currentTurn(at);
      const id = `context:${found.entry.id}`;

      entries.push({
        kind: "work",
        id,
        createdAt: at,
        entry: {
          id,
          kind: "compaction",
          turnId: owner.id,
          createdAt: at,
          completedAt: Option.some(at),
          status: "completed",
          toolName: Option.none(),
          action: "other",
          command: Option.none(),
          changedFiles: [],
          readPaths: [],
          detail: Option.some(
            found.reset ? "Context reset" : "Context compacted"
          ),
          output: Option.none(),
          source: Option.none(),
          nestedCalls: [],
        },
      });
    },

    Checkpoint: (found) => {
      // The turn of the user entry the run answered: the next turn may already have started when
      // the capture lands. Older entries without it go to the newest turn.
      const owner = Option.getOrElse(
        Option.flatMap(found.userEntryId, (userEntryId) =>
          Option.fromUndefinedOr(
            turns.findLast((candidate) =>
              Option.contains(candidate.userEntryId, userEntryId)
            )
          )
        ),
        () => currentTurn(0)
      );

      entries.push({
        kind: "checkpoint",
        id: `checkpoint:${found.entry.id}`,
        createdAt: Option.getOrElse(owner.endedAt, () => owner.startedAt),
        turnId: owner.id,
        ref: found.ref,
        turn: found.turn,
        files: found.files,
        moreFiles: found.moreFiles,
      });
    },

    Notice: (found) => {
      // A notice has no time of its own: it follows the newest turn, as a failed row.
      const owner = currentTurn(0);
      const at = Option.getOrElse(owner.endedAt, () => owner.startedAt);
      const id = `notice:${found.entry.id}`;

      entries.push({
        kind: "work",
        id,
        createdAt: at,
        entry: {
          id,
          kind: "error",
          turnId: owner.id,
          createdAt: at,
          completedAt: Option.some(at),
          status: "failed",
          toolName: Option.none(),
          action: "other",
          command: Option.none(),
          changedFiles: [],
          readPaths: [],
          detail: Option.some(found.text),
          output: Option.none(),
          source: Option.none(),
          nestedCalls: [],
        },
      });
    },

    Skip: Function.constVoid,
  });

  for (const reading of decoded) {
    read(reading);
  }

  const unanswered = entries.flatMap((entry, index) => {
    if (entry.kind !== "work" || entry.entry.kind !== "tool") {
      return [];
    }

    const callId = entry.id.slice("tool:".length);

    return results.has(callId) ? [] : [{ index, callId }];
  });

  return { entries, turns, results, unanswered };
};

// One-slot memo of the committed reading, keyed on the two pages' identities rather than their
// concatenation (a new array every call) and not on the live tool output: streaming and tool
// output change only `pi.live`, so most views share the previous view's entries.
let lastCommitted:
  | {
      readonly older: ReadonlyArray<Entry>;
      readonly entries: ReadonlyArray<Entry>;
      readonly running: boolean;
      readonly reading: CommittedReading;
    }
  | undefined;

const committedReading = (
  older: ReadonlyArray<Entry>,
  entries: ReadonlyArray<Entry>,
  running: boolean
): CommittedReading => {
  if (
    lastCommitted !== undefined &&
    lastCommitted.older === older &&
    lastCommitted.entries === entries &&
    lastCommitted.running === running
  ) {
    return lastCommitted.reading;
  }

  const source = older.length === 0 ? entries : [...older, ...entries];
  const reading = readCommitted(source, running);

  lastCommitted = { older, entries, running, reading };

  return reading;
};

/**
 * The committed entries with each unanswered tool call's live output laid over it. Only those
 * calls get new objects, so every settled entry keeps its identity from view to view.
 */
const withLiveOutput = (
  committed: CommittedReading,
  slots: LiveReading["slots"]
): Array<TimelineEntry> => {
  const entries = [...committed.entries];

  for (const { callId, index } of committed.unanswered) {
    const output = slots.get(callId)?.output;
    const found = entries[index];

    if (output !== undefined && found?.kind === "work") {
      entries[index] = {
        ...found,
        entry: { ...found.entry, output: Option.some(output) },
      };
    }
  }

  return entries;
};

const freezeTurn = (turn: TurnBuilder, status: TurnStatus): TimelineTurn => ({
  id: turn.id,
  userEntryId: turn.userEntryId,
  startedAt: turn.startedAt,
  endedAt: turn.endedAt,
  status,
  error: turn.error,
});

/**
 * The transcript of a projected view: its committed entries (older pages first), the live partial
 * and running tools from `pi.live`, the turns, and whether a run is working.
 */
export const entriesFromPi = (
  view: Pick<ConversationView, "entries" | "docs">,
  older: ReadonlyArray<Entry> = NO_OLDER
): Timeline => {
  const live = readLive(view.docs);
  const committed = committedReading(older, view.entries, live.running);
  const lastBuilder = committed.turns.at(-1);
  const entries = withLiveOutput(committed, live.slots);
  let liveTurnEnd: Option.Option<number> = Option.none();

  if (
    live.running &&
    lastBuilder !== undefined &&
    Option.isSome(live.partial)
  ) {
    // A copy, so the cached committed turn keeps its count for the next view.
    const scratch: TurnBuilder = { ...lastBuilder };

    entries.push(
      ...assistantEntries(
        live.partial.value,
        scratch,
        Option.none(),
        true,
        committed.results,
        live.slots,
        false
      )
    );
    liveTurnEnd = scratch.endedAt;
  }

  const turns = committed.turns.map((turn, index) => {
    const isLast = index === committed.turns.length - 1;

    if (isLast && live.running) {
      return {
        ...freezeTurn(turn, "running"),
        endedAt: Option.orElse(liveTurnEnd, () => turn.endedAt),
      };
    }

    if (turn.interrupted) {
      return freezeTurn(turn, "interrupted");
    }

    return freezeTurn(turn, Option.isSome(turn.error) ? "failed" : "completed");
  });

  const activeTurn = live.running
    ? Option.fromUndefinedOr(turns.at(-1))
    : Option.none();

  return {
    entries,
    turns,
    isWorking: live.running,
    activeTurnId: Option.map(activeTurn, (turn) => turn.id),
    activeTurnStartedAt: Option.map(activeTurn, (turn) => turn.startedAt),
  };
};
