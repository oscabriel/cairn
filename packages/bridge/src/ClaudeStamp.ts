// Ported from cairn-v1, apps/server/src/claude/session-map.ts at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0 (Cairn's own code), with the coverage rules of
// w-winter/dot314, extensions/pi-claude-bridge/src/history-digest.ts at
// c157f4e6f9fda15b2d6698a12820e7118d19fbd7 (ideas only: the digest here is written over pi's own
// messages, not over an Anthropic projection). Changed: the stamp gains `ccUuid` (where a resume
// cuts), `piSessionId` (which pi conversation's session it is, so a fork forks it) and `cwd`, loses
// `ccMessageId`, and its details are decoded with a schema.
//
// Every reply the bridge delivers carries a `cairn.claude` diagnostic naming the Claude Code session
// that produced it. pi-durable commits the assistant message as the provider gave it, so the stamp
// commits in the same transaction as the reply: there is no crash window, and it follows the entry
// into forks. A reply that compaction removed has no stamp, and the bridge then opens a fresh session.
//
// Digest coverage, from dot314: message order and roles, user text and images, assistant text, each
// tool call's id, name and arguments, and which tool results follow. Not covered: tool result bodies
// (context pruners rewrite them per call, and Claude keeps the originals harmlessly), thinking blocks,
// system messages (the instructions have their own digest), timestamps and usage.

import { createHash } from "node:crypto";

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { Option, Predicate, Schema } from "effect";

import type { HeldState } from "./ClaudeInstructions.ts";
import type { ConversationMessage } from "./ClaudeTranscript.ts";
import { conversationMessages } from "./ClaudeTranscript.ts";

/** The diagnostic type of a stamp. `ThreadWire` strips it before entries reach a client. */
export const STAMP_TYPE = "cairn.claude";

/** What a delivered reply records about the Claude Code session that produced it. */
export const ClaudeStamp = Schema.Struct({
  /** Claude Code's session id: the transcript under `~/.claude/projects/<escaped cwd>/<id>.jsonl`. */
  ccSessionId: Schema.String,
  /** The chain uuid of the reply's last assistant message in that transcript: where a resume cuts. */
  ccUuid: Schema.String,
  /** pi's provider session id of the conversation the reply was made for. A fork has another. */
  piSessionId: Schema.String,
  /** Digest of pi's history through this reply: what the Claude Code session holds after it. */
  historyDigest: Schema.String,
  /** The instructions the session holds after this reply, whole and per section. */
  held: Schema.Struct({
    digest: Schema.String,
    base: Schema.String,
    sections: Schema.Record(Schema.String, Schema.String),
  }),
  /** The model id sent to Claude Code, `[1m]` included. */
  cliModel: Schema.String,
  /** The realpath the child ran in; transcripts are filed under it. */
  cwd: Schema.String,
});

/** One stamp. */
export type ClaudeStamp = typeof ClaudeStamp.Type;

const decodeStamp = Schema.decodeUnknownOption(ClaudeStamp);

const encodeStamp = Schema.encodeSync(ClaudeStamp);

/** The held state recorded in `stamp`. */
export const heldOfStamp = (stamp: ClaudeStamp): HeldState => stamp.held;

/** Records `stamp` on `message` in place, replacing any earlier stamp. `timestamp` is epoch milliseconds. */
export const stampMessage = (
  message: AssistantMessage,
  stamp: ClaudeStamp,
  timestamp: number
): void => {
  const others = (message.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.type !== STAMP_TYPE
  );

  message.diagnostics = [
    ...others,
    { type: STAMP_TYPE, timestamp, details: encodeStamp(stamp) },
  ];
};

/** The stamp on `message`, or none when it has none or the stamp is not this version's. */
export const stampOf = (message: Message): Option.Option<ClaudeStamp> => {
  if (message.role !== "assistant") {
    return Option.none();
  }

  return Option.fromNullishOr(
    message.diagnostics?.find((diagnostic) => diagnostic.type === STAMP_TYPE)
      ?.details
  ).pipe(Option.flatMap(decodeStamp));
};

/** A stamp and the index, in the conversation messages, of the reply it is on. */
export interface FoundStamp {
  readonly stamp: ClaudeStamp;
  readonly index: number;
}

/** The newest stamped reply in `messages` (conversation messages, no prompt state). */
export const latestStamp = (
  messages: ReadonlyArray<ConversationMessage>
): Option.Option<FoundStamp> => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message === undefined) {
      continue;
    }

    const stamp = stampOf(message);

    if (Option.isSome(stamp)) {
      return Option.some({ stamp: stamp.value, index });
    }
  }

  return Option.none();
};

const DIGEST_VERSION = "h2";

const imageDigest = (data: string): string =>
  createHash("sha256").update(data).digest("hex").slice(0, 16);

const covered = (message: ConversationMessage): ReadonlyArray<string> => {
  switch (message.role) {
    case "user": {
      const content = Predicate.isString(message.content)
        ? [{ type: "text" as const, text: message.content }]
        : message.content;

      return content.map((block) =>
        block.type === "text"
          ? `t:${block.text}`
          : `i:${block.mimeType}:${imageDigest(block.data)}`
      );
    }

    case "assistant": {
      return message.content.flatMap((block) => {
        if (block.type === "text") {
          return block.text.length > 0 ? [`t:${block.text}`] : [];
        }

        if (block.type === "toolCall") {
          return [
            `c:${block.id}:${block.name}:${JSON.stringify(block.arguments)}`,
          ];
        }

        return [];
      });
    }

    case "toolResult": {
      return [`r:${message.toolCallId}`];
    }

    default: {
      return [];
    }
  }
};

/** Versioned digest of `messages` (prompt state is skipped), under the coverage rules above. */
export const historyDigest = (messages: ReadonlyArray<Message>): string => {
  const digest = createHash("sha256");

  for (const message of conversationMessages(messages)) {
    digest.update(JSON.stringify([message.role, covered(message)]));
    digest.update("\n");
  }

  return `${DIGEST_VERSION}:${digest.digest("hex")}`;
};

/** Whether the conversation messages up to and including `found.index` still match the stamp there. */
export const stampMatches = (
  messages: ReadonlyArray<ConversationMessage>,
  found: FoundStamp
): boolean =>
  historyDigest(messages.slice(0, found.index + 1)) ===
  found.stamp.historyDigest;
