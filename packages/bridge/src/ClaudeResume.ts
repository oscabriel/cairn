// The resume decision table: which Claude Code session a provider call continues, and how. Cairn's
// own design (plan section 1, "How the bridge plugs in"; notes/bridge.md section 3.3), replacing
// cairn-v1's native-resume.ts, native-fork.ts and rebuild.ts at 1a5cd4a. Cairn never writes or
// rebuilds a Claude Code transcript: the SDK's `resume` with `resumeSessionAt` continues a session,
// `forkSession` copies one, and a history Claude Code cannot hold opens a fresh session whose first
// prompt carries pi's context.
import { Option } from "effect";

import type { Effort } from "./ClaudeGuards.ts";
import type { HeldState, InstructionState } from "./ClaudeInstructions.ts";
import { heldOf, renderInstructions } from "./ClaudeInstructions.ts";
import type { FoundStamp } from "./ClaudeStamp.ts";
import { latestStamp, stampMatches } from "./ClaudeStamp.ts";
import type { ConversationMessage } from "./ClaudeTranscript.ts";

/** A child of this conversation that is still alive and finished its last turn. */
export interface IdleChild {
  readonly ccSessionId: string;
  readonly cwd: string;
  readonly cliModel: string;
  readonly effort: Option.Option<Effort>;
  readonly thinking: "adaptive" | "disabled";
}

/** What this process knows about the conversation's Claude Code sessions, beyond the stamps. */
export interface ResumeMemory {
  /** The held query owns the tool results this call carries. */
  readonly heldOwnsResults: boolean;
  /** A live child that finished its turn and could take the next prompt. */
  readonly idle: Option.Option<IdleChild>;
  /** A session whose last child was killed or failed and may still flush into its file. */
  readonly uncertain: ReadonlySet<string>;
}

/** One provider call, as far as the decision needs it. */
export interface ResumeInput {
  /** pi's provider session id for this conversation (fresh per fork). */
  readonly piSessionId: string;
  readonly messages: ReadonlyArray<ConversationMessage>;
  readonly cwd: string;
  readonly cliModel: string;
  readonly effort: Option.Option<Effort>;
  readonly thinking: "adaptive" | "disabled";
  readonly memory: ResumeMemory;
}

/** Why a fresh session was opened; logged, and reported by the judges. */
export type FreshReason =
  | "first-turn"
  | "no-stamp"
  | "history-diverged"
  | "other-provider"
  | "cwd-changed"
  | "model-changed";

/** What the call does. */
export type ResumeDecision =
  /** Deliver the tool results to the held query's waiting handlers (a steer first). */
  | { readonly kind: "deliver" }
  /** Write the new user turn to the idle child, whose session holds everything before it. */
  | { readonly kind: "reuse"; readonly ccSessionId: string }
  /**
   * Resume the stamped session at `at`; `fork` writes it to a new file because the last child may
   * still be writing the old one.
   */
  | {
      readonly kind: "resume";
      readonly found: FoundStamp;
      readonly fork: boolean;
    }
  /** The stamp is another pi conversation's (this one is a fork of it): fork that session, then resume the copy. */
  | { readonly kind: "fork-stamped"; readonly found: FoundStamp }
  /**
   * Open a new session. `seed` puts pi's history into its first prompt; a first turn has none and
   * asks for pi's provider session id as the session id, so a kill during the first reply still
   * finds its transcript.
   */
  | {
      readonly kind: "fresh";
      readonly reason: FreshReason;
      readonly seed: boolean;
      readonly preferredId: Option.Option<string>;
    };

const onlyInputsAfter = (
  messages: ReadonlyArray<ConversationMessage>,
  index: number
): boolean =>
  messages
    .slice(index + 1)
    .every(
      (message) => message.role === "user" || message.role === "toolResult"
    );

const effortKey = (effort: Option.Option<Effort>): string =>
  Option.getOrElse(effort, () => "default");

const EMPTY_TEXT_HASH = heldOf({ base: "", sections: new Map() }).base;

/**
 * The append a resume passes when the stamped session had one but the thread's instructions now
 * render empty: any non-empty text keeps the agent line, and Claude Code never sends it.
 */
export const HELD_APPEND_PLACEHOLDER = "(no thread instructions)";

/** Whether the instructions a session was stamped with rendered a non-empty append. */
const heldHadAppend = (held: HeldState): boolean =>
  held.base !== EMPTY_TEXT_HASH ||
  Object.values(held.sections).some((hash) => hash !== EMPTY_TEXT_HASH);

/**
 * The append a resumed (or forked) child is launched with. Claude Code sends the system prompt it
 * recorded at the session's first request whatever a later launch passes, so the text is never
 * rendered again; but the line naming the agent ahead of it is recorded only once the first reply
 * finishes. A session killed before then (a tool call held in its first turn) picks that line again
 * from whether the resuming launch has an append, and a different line rewrites the whole prompt
 * cache (`spikes/7-bridge-held-resume/NOTES.md`). So a resume passes an append exactly when the
 * stamped session had one: the current instructions, which Claude Code ignores while it holds its
 * record, or `HELD_APPEND_PLACEHOLDER` when they now render empty.
 */
export const resumeAppend = (
  held: HeldState,
  state: InstructionState
): Option.Option<string> =>
  heldHadAppend(held)
    ? Option.orElseSome(
        renderInstructions(state),
        () => HELD_APPEND_PLACEHOLDER
      )
    : Option.none();

const fresh = (reason: FreshReason): ResumeDecision => ({
  kind: "fresh",
  reason,
  seed: true,
  preferredId: Option.none(),
});

/** The decision for one call; see the module comment and plan section 1 for the table. */
export const decideResume = (input: ResumeInput): ResumeDecision => {
  if (input.memory.heldOwnsResults) {
    return { kind: "deliver" };
  }

  const found = latestStamp(input.messages);

  if (Option.isNone(found)) {
    const hasHistory = input.messages.some(
      (message) => message.role === "assistant"
    );

    return hasHistory
      ? fresh("no-stamp")
      : {
          kind: "fresh",
          reason: "first-turn",
          seed: false,
          preferredId: Option.some(input.piSessionId),
        };
  }

  const { stamp } = found.value;

  if (!onlyInputsAfter(input.messages, found.value.index)) {
    return fresh("other-provider");
  }

  if (!stampMatches(input.messages, found.value)) {
    return fresh("history-diverged");
  }

  if (stamp.cwd !== input.cwd) {
    return fresh("cwd-changed");
  }

  if (stamp.cliModel !== input.cliModel) {
    return fresh("model-changed");
  }

  if (stamp.piSessionId !== input.piSessionId) {
    return { kind: "fork-stamped", found: found.value };
  }

  const tail = input.messages.slice(found.value.index + 1);

  const onlyUserTail =
    tail.length > 0 && tail.every((message) => message.role === "user");

  const reusable = Option.filter(
    input.memory.idle,
    (idle) =>
      onlyUserTail &&
      idle.ccSessionId === stamp.ccSessionId &&
      idle.cwd === input.cwd &&
      idle.cliModel === input.cliModel &&
      idle.thinking === input.thinking &&
      effortKey(idle.effort) === effortKey(input.effort)
  );

  if (Option.isSome(reusable)) {
    return { kind: "reuse", ccSessionId: reusable.value.ccSessionId };
  }

  return {
    kind: "resume",
    found: found.value,
    fork: input.memory.uncertain.has(stamp.ccSessionId),
  };
};
