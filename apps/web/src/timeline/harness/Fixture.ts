// Synthetic threads for the transcript's scroll judge and tests: pi transcripts shaped like the
// recorded ones (judges/fixtures/transcripts), long enough to give thousands of rows, and a reply
// that streams the way pi-durable's `pi.live` doc grows, then commits and gives way to the next.
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { ConversationView, Entry } from "@cairn/protocol/Thread";
import { Schema } from "effect";

const decodeView = Schema.decodeUnknownSync(ConversationView);

const decodeEntry = Schema.decodeUnknownSync(Entry);

const START_MS = 1_792_673_850_000;

const PARAGRAPHS = [
  "The README explains what the project does and how to start with it.",
  "Here is what I found after reading the files: the build script calls `vite build`, and the output lands in `dist/`. Nothing else writes there.",
  "## Summary\n\n- The tests pass.\n- The lint is clean.\n- One warning remains in `src/main.ts`.",
  "```ts\nexport const answer = 42;\nconsole.log(answer);\n```\n\nThat is the whole change.",
  "| File | Lines |\n| --- | ---: |\n| a.ts | 12 |\n| b.ts | 40 |",
];

/** A reply of one to four paragraphs, varied by `turn`. */
export const answerText = (turn: number): string =>
  Array.from(
    { length: 1 + (turn % 4) },
    (_, index) => PARAGRAPHS[(turn + index) % PARAGRAPHS.length] ?? ""
  ).join("\n\n");

const at = (turn: number): number => START_MS + turn * 10_000;

const userEntry = (
  id: number,
  conversationId: number,
  text: string,
  timestamp: number
) =>
  decodeEntry({
    id,
    conversationId,
    kind: "pi.user",
    model: [{ role: "user", content: [{ type: "text", text }], timestamp }],
  });

const assistantEntry = (
  id: number,
  conversationId: number,
  content: Schema.Json,
  stopReason: string,
  timestamp: number
) =>
  decodeEntry({
    id,
    conversationId,
    kind: "pi.assistant",
    model: [
      { role: "assistant", content, stopReason, timestamp, durationMs: 400 },
    ],
  });

const toolResultEntry = (
  id: number,
  conversationId: number,
  callId: string,
  text: string,
  timestamp: number
) =>
  decodeEntry({
    id,
    conversationId,
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: "bash",
        content: [{ type: "text", text }],
        isError: false,
        timestamp,
        durationMs: 20,
      },
    ],
  });

/** One settled turn: a prompt, a command and its result, then an answer; four entries from `id`. */
const turnEntries = (conversationId: number, turn: number, id: number) => {
  const callId = `call-${conversationId}-${turn}`;

  return [
    userEntry(
      id,
      conversationId,
      `Question ${turn}: what does step ${turn} change?`,
      at(turn)
    ),
    assistantEntry(
      id + 1,
      conversationId,
      [
        { type: "text", text: "Let me look." },
        {
          type: "toolCall",
          id: callId,
          name: "bash",
          arguments: { command: `ls -la src/step-${turn}` },
        },
      ],
      "toolUse",
      at(turn) + 1000
    ),
    toolResultEntry(
      id + 2,
      conversationId,
      callId,
      `total ${turn}\n-rw-r--r-- 1 me me 120 a.ts`,
      at(turn) + 1500
    ),
    assistantEntry(
      id + 3,
      conversationId,
      [{ type: "text", text: answerText(turn) }],
      "stop",
      at(turn) + 3000
    ),
  ];
};

/** A thread of `turns` settled turns, about three rows each. */
export const syntheticThread = (
  conversationId: number,
  turns: number
): ThreadViewState => {
  const empty = decodeView({
    conversation: { id: conversationId },
    entries: [],
    docs: { "pi.live": {} },
  });

  return {
    seq: 1,
    view: {
      ...empty,
      entries: Array.from({ length: turns }, (_, turn) =>
        turnEntries(conversationId, turn, 1 + turn * 4)
      ).flat(),
    },
    entriesOffset: 0,
    hasMoreHistory: false,
    older: [],
  };
};

/** Opens turn `turn` with its prompt: the run starts and the reply is empty. */
export const startReply = (
  state: ThreadViewState,
  turn: number
): ThreadViewState => {
  const id = (state.view.entries.at(-1)?.id ?? 0) + 1;

  return {
    ...state,
    seq: state.seq + 1,
    view: {
      ...state.view,
      entries: [
        ...state.view.entries,
        userEntry(
          id,
          state.view.conversation.id,
          `Stream ${turn}: go on.`,
          at(turn)
        ),
      ],
      docs: { ...state.view.docs, "pi.live": { run: { id: `run-${turn}` } } },
    },
  };
};

/** The reply of turn `turn` so far, streaming in `pi.live`. */
export const growReply = (
  state: ThreadViewState,
  turn: number,
  text: string
): ThreadViewState => ({
  ...state,
  seq: state.seq + 1,
  view: {
    ...state.view,
    docs: {
      ...state.view.docs,
      "pi.live": {
        run: { id: `run-${turn}` },
        generation: {
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            stopReason: "stop",
            timestamp: at(turn) + 500,
          },
        },
      },
    },
  },
});

/** Commits turn `turn`'s reply and ends the run. */
export const commitReply = (
  state: ThreadViewState,
  turn: number,
  text: string
): ThreadViewState => {
  const id = (state.view.entries.at(-1)?.id ?? 0) + 1;

  return {
    ...state,
    seq: state.seq + 1,
    view: {
      ...state.view,
      entries: [
        ...state.view.entries,
        assistantEntry(
          id,
          state.view.conversation.id,
          [{ type: "text", text }],
          "stop",
          at(turn) + 500
        ),
      ],
      docs: { ...state.view.docs, "pi.live": {} },
    },
  };
};
