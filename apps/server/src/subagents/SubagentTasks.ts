// Ported in intent from github.com/earendil-works/pi, packages/durable/test/examples/
// 23-subagent-background.ts at 4a080252 (the anchor that owns a child conversation, the reporter
// task the parent owns), and from github.com/HazAT/ultimate, extensions/subagents/server.ts at
// 8b263386 (one reporter per input to a child, a child that ends without a report is not an empty
// success). The code is rewritten for Cairn.
//
// MIT License. Copyright (c) 2025 Mario Zechner (pi). Copyright (c) 2026 Daniel Griesser
// (Ultimate).
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software. THE
// SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// The subagents' pi-durable tasks (ADR 0028, ADR 0030): each a background task owned by the
// parent's conversation, so a Stop on the parent ends neither them nor the children they serve.
//
// - Anchor (`cairn.subagent-anchor`) completes at once; a child conversation is owned by one, so
//   the parent's run is never held by its children.
// - Brief (`cairn.subagent-brief`), one per `subagent_spawn`: waits for the brief's answer. At Go
//   it mints the child's thread id from the brief (the same on a rerun), makes the child's
//   workspace (`ChildWorkspaces.prepare`: a worktree of its own for a writing role, its parent's
//   cwd for a shared child), then starts the child in one commit (`startChild`): anchor, child
//   conversation in that cwd with Cairn's thread identity and its `cairn.child` link, the registry
//   item with its worktree, the first reporter and the parent's note that it started. A workspace
//   that cannot be made starts nothing, and the parent is told why. Decline and Send back reach the
//   parent as a follow-up input, or as a note when the parent is halted. The briefs package (4A)
//   moves Go into the answer itself.
// - Reporter (`cairn.subagent-reporter`), one per input to a child (the brief, `subagent_send`, a
//   user's steer typed into the child): `deliver` submits the input under its request id (the
//   whole input: its text and images, its entry, its `whenBusy`), mirrors the child's pending
//   records into its registry status while it works, and settles the run that ended it once, in
//   one commit. A run is keyed by its identity (its answer entry; when it ended unanswered, the
//   entry of its first input, found in the committed transcript by how each input was placed: a
//   steer shares the `byTaskId` of the tool-calling entry before it, and inputs one commit placed
//   have adjacent ids), never by a failure's reason or detail; the first reporter to settle it
//   gathers every live peer whose submission the same run ended and writes one settlement listing
//   them all, with a run mark naming it, waking the parent unless all were a user's steers. A
//   reporter whose run or input a mark already names settles nothing.
//   `nudge` sends a typed child that ended without a result its one nudge (`NUDGE_TEXT`); the
//   commit that decides it writes a `nudge` run mark listing every input the nudged run ended, so
//   their reporters settle nothing and the nudge's run settles them all. `report` writes the
//   settlement's note and decides the wake by the parent's state; `wake` submits the wake and marks
//   the settlement delivered. Nudge, note and wake request ids derive from the child and the
//   settlement's `seq`, so a rerun after `kill -9` lands each once.
//
// A typed child's result is `submit_result`'s (models/ResultTool.ts): the payload and divergence of
// the settlement of the run that accepted it come from its `cairn.result` (`readResult`), the
// transcript read only up to that run's end; later runs settle as an untyped child's do. A child
// whose run ends without one, none having come before, gets the nudge while `nudgeDue` says so, and
// otherwise settles `failed`, with `CAP_TEXT` once its attempts are spent. `report` carries the
// summary, the divergence of a text result and a commit.
//
// `SubagentFaults` breaks the delivery on purpose for the conformance suite's mutation check; the
// production layer plants none.

import { setTimeout as sleep } from "node:timers/promises";

import { narrowerMode } from "@cairn/client-logic/EffectiveMode";
import { ThreadId } from "@cairn/protocol/Ids";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import {
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_RESULT_ENTRY,
} from "@cairn/protocol/Subagents";
import type { SettlementOutcome } from "@cairn/protocol/Subagents";
import type { JsonValue } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type {
  Agent,
  AgentChange,
  ConversationId,
  Cursor,
  EntryId,
  EntryQuery,
  EntryRecord,
  InputSubmissionDraft,
  NextTaskState,
  SettledSubmissionRecord,
  Submission,
  SubmissionRecord,
  TaskRuntime,
  Tx,
} from "@earendil-works/pi-durable";
import {
  configure,
  ConversationBusy,
  defineTask,
  InboxDoc,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { DateTime, Effect, Option, Predicate, Result } from "effect";

import {
  Approvals,
  Permissions,
  ThreadMeta,
  ThreadReceipt,
  writeMode,
} from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { messageText } from "../brain/CommitFeed.ts";
import {
  admitNote,
  applyNote,
  noteEntry,
  readNote,
} from "../brain/NoteAdmission.ts";
import { classifyRunFailure } from "../brain/RunFailure.ts";
import type {
  SubagentCrashPoint,
  SubagentFaultSet,
} from "../brain/SubagentFaults.ts";
import {
  BRIEF_ANSWER_ENTRY,
  NO_RESULT_ERROR,
  renderBrief,
  renderBriefAnswer,
  renderQuestion,
  renderSettlement,
  renderWake,
  SubagentRequestIds,
  TYPED_RESULT_SUMMARY,
} from "../brain/SubagentText.ts";
import type { BriefAnswer } from "../brain/SubagentText.ts";
import { familyOf } from "../models/ModelFamily.ts";
import {
  CAP_TEXT,
  markOf,
  MAX_RESULT_ATTEMPTS,
  NUDGE_TEXT,
  nudgeDue,
  readAttemptState,
  readResult,
} from "../models/ResultTool.ts";
import type { ResultState } from "../models/ResultTool.ts";
import type {
  PrepareChildWorkspace,
  PreparedChildWorkspace,
} from "../workspaces/ChildWorkspaces.ts";
import { briefOfPayload } from "./Briefs.ts";
import {
  childThreadIdOf,
  conversationOf,
  parentHalted,
  setStatus,
  settlementOf,
  taskOf,
} from "./Delivery.ts";
import type { SettlementState } from "./Delivery.ts";
import {
  ChildDoc,
  isJsonRecord,
  isLinked,
  jsonRecordOf,
  markInputs,
  SubagentsDoc,
} from "./SubagentDocs.ts";
import type {
  RunMarkState,
  SubagentItemState,
  SubagentsState,
} from "./SubagentDocs.ts";
import { awaitDoc, runWait } from "./Waits.ts";

/** The anchor task's name. */
export const ANCHOR_TASK = "cairn.subagent-anchor";

/** The brief task's name. */
export const BRIEF_TASK = "cairn.subagent-brief";

/** The reporter task's name. */
export const REPORTER_TASK = "cairn.subagent-reporter";

/**
 * The subagent tasks that wait, for the boot repair that retries parked ones. The anchor completes
 * in its first phase and waits on nothing, so the crash-loop guard never parks it.
 */
export const SUBAGENT_TASKS: ReadonlySet<string> = new Set([
  BRIEF_TASK,
  REPORTER_TASK,
]);

/** A conversation-owned background task: a parent's Stop and idle waits never reach it. */
const BACKGROUND = {
  ownership: { kind: "conversation" },
  background: true,
} as const;

const completed = <S>(): NextTaskState<S, null> => ({
  status: "terminal",
  outcome: { status: "completed", result: null },
});

/** The anchor: owns a child conversation and ends at once (example 23). */
export const Anchor = defineTask<null, { phase: "done" }, null>({
  name: ANCHOR_TASK,
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: async (_anchor, runtime, context) => {
      await runtime.commit(() => completed(), context);
    },
  },
  abort: async (_anchor, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context
    );
  },
});

/** One content part of an input, as a task's input keeps it: plain JSON. */
export type InputPartState =
  | { [key: string]: JsonValue; type: "text"; text: string }
  | { [key: string]: JsonValue; type: "image"; data: string; mimeType: string };

/** The entry an input is placed as instead of `pi.user` (an attachment's author, say). */
export interface InputEntryState {
  [key: string]: JsonValue;
  kind: string;
  data: JsonValue;
}

/** One input to a child, as its reporter delivers it: the whole draft, so any submitter admits it. */
export interface ReporterInput {
  [key: string]: JsonValue;
  /** The child's registry key (its brief's approval id). */
  key: string;
  child: number;
  childThreadId: string;
  requestId: string;
  /** Its text, or its text and image parts as the user sent them. */
  content: string | Array<InputPartState>;
  entry: InputEntryState | null;
  whenBusy: "steer" | "followUp" | "reject";
  /** A user's own steer to the child: its result is a note, with no wake. */
  quiet: boolean;
}

/** What a settling reporter reads about the run it settles, from every input that run ended. */
interface RunInputs {
  /**
   * Whether the run goes without a wake: every input it ended was quiet (a user's own steer). The
   * first reporter to settle a run settles it for all of them, so a user's steer and the parent's
   * send ended together still wake the parent.
   */
  readonly quiet: boolean;
  /** The earliest entry an input of this run (not a nudged one) was placed as. */
  readonly from: EntryId | undefined;
  /** The request ids of every submission the run ended, the waited one first, then any nudged. */
  readonly inputs: Array<string>;
}

/** A child run's identity and extent, from one submission it ended (table reads). */
interface RunSpan {
  /**
   * The run's key in the registry's run marks: `answer:<entry>` for an answered run (every input it
   * answered names that answer); `run:<entry>` for one that ended unanswered, the entry its first
   * input was placed as (`runStart`), read from the committed transcript, so every reporter of the
   * run finds the same key whenever it settles; `input:<submission>` for an input that ran in no
   * run, or whose run's start lies past `RUN_SCAN` entries; such an input settles alone.
   */
  readonly key: string;
  /** The submission's placed entry, when it was placed. */
  readonly start: EntryId | undefined;
  /**
   * The run's last entry: its answer (with the results of the tool round it ended on); for an
   * unanswered run its terminal entry, or the entry before the next run's first input, or the
   * transcript's last entry when nothing came after it; none when not found within `RUN_SCAN`
   * entries, or for an input that settles alone, and then reads of the run are unbounded.
   */
  readonly end: EntryId | undefined;
}

/**
 * How many entries from an input its run's first input and terminal entry are looked for. An input
 * whose run's first input lies further back settles alone. A run whose end lies further on keeps
 * its `run:` key with no end, and its settlement reads its words, turns and typed result to the end
 * of the transcript: unbounded, for a run longer than this.
 */
const RUN_SCAN = 4096;

/** How many entries a run scan reads per page. */
const RUN_PAGE = 256;

/**
 * Entries a run goes on with after an assistant message: a retry, a tool round. A compaction goes on
 * with it only when its generation waited for it (`midRun`).
 */
const RUN_CONTINUES: ReadonlySet<string> = new Set([
  "pi.assistant",
  "pi.tool-result",
]);

/**
 * Whether a run goes on with `entry` after an assistant message (table read): a retry or a tool
 * round, or a compaction a generation owned and waited for (an overflow's). A conversation-owned
 * compaction's summary is a write, placed while the child is idle, after the run's end.
 */
const midRun = async (tx: Tx, entry: EntryRecord): Promise<boolean> => {
  if (RUN_CONTINUES.has(entry.kind)) {
    return true;
  }

  if (entry.kind !== "pi.compaction" || entry.byTaskId === undefined) {
    return false;
  }

  const task = await tx.task(entry.byTaskId);

  return task?.owner !== undefined;
};

/** Whether `entry` is an assistant message that asks for no tool: a run may end on it. */
const mayEnd = (entry: EntryRecord): boolean => {
  const [message] = entry.model ?? [];

  return (
    entry.kind === "pi.assistant" &&
    message?.role === "assistant" &&
    message.stopReason !== "toolUse"
  );
};

/** Whether `entry` is an assistant message that calls tools: its generation's tool round follows. */
const callsTools = (entry: EntryRecord): boolean => {
  const [message] = entry.model ?? [];

  return (
    entry.kind === "pi.assistant" &&
    message?.role === "assistant" &&
    message.stopReason === "toolUse" &&
    message.content.some((part) => part.type === "toolCall")
  );
};

/** Whether `entry` is a reset write: it starts the context at itself, so no run goes on past it. */
const isReset = (entry: EntryRecord): boolean =>
  entry.head !== undefined && entry.head === entry.id;

/**
 * Whether `entry` was placed as an input, or reads as one: an input the registry knows (`placed`),
 * or an entry that gives the model a user message (an input another sender placed, such as a
 * wake from the child's own subagents). Compactions and resets are neither.
 */
const isInput = (
  entry: EntryRecord,
  placed: ReadonlyMap<EntryId, SubmissionRecord>
): boolean => {
  if (placed.has(entry.id)) {
    return true;
  }

  const [message] = entry.model ?? [];

  return (
    entry.kind !== "pi.compaction" &&
    !isReset(entry) &&
    message?.role === "user"
  );
};

/**
 * Whether the input `entry` goes on the run that wrote `before`, the nearest assistant message
 * before it with no reset between, read from pi-durable's committed attribution (`byTaskId`, the
 * task whose commit appended an entry; none for a commit outside a task, such as
 * `Conversation.submit`'s). A steer is placed by the generation that called the tools, in the
 * commit that ends its tool round (the `postTools` boundary), so it shares that assistant entry's
 * `byTaskId`. Anything else starts a run: an input `submit` placed (attributed to no task), or one
 * a final or failure boundary placed (after the run's answer or failure, under a generation that
 * called no tools after it). Cairn installs no `onYield` continuation, whose user message would go
 * on its answer's run.
 */
const goesOn = (entry: EntryRecord, before: EntryRecord | undefined): boolean =>
  before !== undefined &&
  before.byTaskId !== undefined &&
  before.byTaskId === entry.byTaskId &&
  callsTools(before);

/**
 * Whether `entry` was placed in the same commit as `previous`, the input right before it with no
 * assistant message between: one boundary placing several inputs. That is a run's first inputs (an
 * idle `submit` that places the inputs a failed run kept with its own, a final boundary, a failure
 * boundary) or a tool round's steers. pi-durable mints every id from one counter, on one commit line,
 * and a boundary appends its inputs back to back, so one placement's inputs have adjacent ids and
 * one attribution. Every commit that places an input then mints the generation that runs it (or
 * the successor that goes on with a tool round's steers) before it ends, so inputs two commits
 * placed are never adjacent, even under one task or none: two runs that each ended with no entry of
 * their own are never read as one.
 */
const placedWith = (
  entry: EntryRecord,
  previous: EntryRecord | undefined
): boolean =>
  previous !== undefined &&
  entry.id - previous.id === 1 &&
  entry.byTaskId === previous.byTaskId;

/**
 * Where the first input of the unanswered run that the input placed at `from` was in was placed
 * (table reads), found from committed state alone: from `from` back, each input that goes
 * on the run before it (`goesOn`, `placedWith`) leads to the inputs before it, and the first that
 * does not is the run's first. None past `RUN_SCAN` entries.
 *
 * An input placed after a tool round that ended the run (`submit_result`'s `terminate`) reads as
 * that round's steer, so the run it started is keyed by the answered run's first input: a key no
 * unanswered run of its own takes, the same for every input of the run.
 */
const runStart = async (
  tx: Tx,
  child: ConversationId,
  from: EntryId,
  placed: ReadonlyMap<EntryId, SubmissionRecord>
): Promise<EntryId | undefined> => {
  const own = await tx.entry(from);

  if (own === undefined) {
    return undefined;
  }

  // The input whose standing is read now; none while the run's earlier inputs are looked for.
  let pending: EntryRecord | undefined = own;
  let earliest = own;
  let read = 0;
  let cursor: Cursor | undefined;

  do {
    // Pages are read one after another: each cursor comes from the page before.
    // oxlint-disable-next-line no-await-in-loop
    const page: Awaited<ReturnType<Tx["scanEntries"]>> = await tx.scanEntries(
      { conversationId: child, maxEntryId: from, order: "descending" },
      RUN_PAGE,
      cursor
    );

    for (const entry of page.items) {
      if (entry.id === from) {
        continue;
      }

      if (pending === undefined) {
        if (isReset(entry)) {
          return earliest.id;
        }

        if (isInput(entry, placed)) {
          pending = entry;
          earliest = entry;
        }

        continue;
      }

      if (isReset(entry)) {
        return pending.id;
      }

      if (entry.kind === "pi.assistant") {
        if (!goesOn(pending, entry)) {
          return pending.id;
        }

        pending = undefined;
      } else if (isInput(entry, placed)) {
        if (!placedWith(pending, entry)) {
          return pending.id;
        }

        pending = entry;
        earliest = entry;
      }
    }

    read += page.items.length;
    cursor = page.next;
  } while (cursor !== undefined && read < RUN_SCAN);

  return cursor === undefined ? earliest.id : undefined;
};

/**
 * The last entry of the unanswered run an input placed at `from` was in (table reads): the run goes on
 * up to its terminal entry, the first assistant message at or after `from` that asks for no tool
 * and that the run does not go on from (a retried error is followed by the retry), and never past
 * a reset or an input that does not go on the run (`goesOn`, `placedWith`), the next run's first:
 * a run that ended with no entry of its own ends on the entry before it. None when it is not
 * found within `RUN_SCAN` entries.
 */
const runExtent = async (
  tx: Tx,
  child: ConversationId,
  from: EntryId,
  placed: ReadonlyMap<EntryId, SubmissionRecord>
): Promise<EntryId | undefined> => {
  let candidate: EntryId | undefined;
  let last = from;
  // The nearest assistant message, and the input placed since it with no assistant message between.
  let before: EntryRecord | undefined;
  let previous: EntryRecord | undefined;
  let read = 0;
  let cursor: Cursor | undefined;

  do {
    // Pages are read one after another: each cursor comes from the page before.
    // oxlint-disable-next-line no-await-in-loop
    const page: Awaited<ReturnType<Tx["scanEntries"]>> = await tx.scanEntries(
      { conversationId: child, minEntryId: from, order: "ascending" },
      RUN_PAGE,
      cursor
    );

    for (const entry of page.items) {
      // oxlint-disable-next-line no-await-in-loop -- entries are read in order
      if (candidate !== undefined && !(await midRun(tx, entry))) {
        return candidate;
      }

      if (entry.id === from) {
        previous = entry;
      } else if (isReset(entry)) {
        return last;
      } else if (entry.kind === "pi.assistant") {
        before = entry;
        previous = undefined;
      } else if (isInput(entry, placed)) {
        if (!placedWith(entry, previous) && !goesOn(entry, before)) {
          return last;
        }

        previous = entry;
      }

      candidate = mayEnd(entry) ? entry.id : undefined;
      last = entry.id;
    }

    read += page.items.length;
    cursor = page.next;
  } while (cursor !== undefined && read < RUN_SCAN);

  if (cursor !== undefined) {
    return undefined;
  }

  return last;
};

/**
 * The last entry of a run answered by `answer` (table reads): the answer itself, or, for a run a
 * tool round ended (`submit_result`'s `terminate`), the round's results after it.
 */
const answerEnd = async (
  tx: Tx,
  child: ConversationId,
  answer: EntryId
): Promise<EntryId> => {
  let end = answer;
  let cursor: Cursor | undefined;

  do {
    // Pages are read one after another: each cursor comes from the page before.
    // oxlint-disable-next-line no-await-in-loop
    const page: Awaited<ReturnType<Tx["scanEntries"]>> = await tx.scanEntries(
      { conversationId: child, minEntryId: answer, order: "ascending" },
      RUN_PAGE,
      cursor
    );

    for (const entry of page.items) {
      if (entry.id !== answer && entry.kind !== "pi.tool-result") {
        return end;
      }

      end = entry.id;
    }

    cursor = page.next;
  } while (cursor !== undefined);

  return end;
};

/** What every run identity of a child is read against: its placed inputs. */
interface RunContext {
  /** Each input the registry knows (a reporter's or a nudge's) by the entry it was placed as. */
  readonly placed: ReadonlyMap<EntryId, SubmissionRecord>;
}

/**
 * A child's run context (table reads): every input its registry item knows (each reporter's
 * request, each nudge's) that was placed, by its entry.
 */
const runContext = async (
  tx: Tx,
  child: ConversationId,
  item: SubagentItemState
): Promise<RunContext> => {
  const requestIds = new Set([
    ...Object.keys(item.inputs),
    ...item.runs.flatMap((mark) =>
      mark.phase === "nudge"
        ? [SubagentRequestIds.nudge(item.threadId, mark.seq)]
        : []
    ),
  ]);

  const placed = new Map<EntryId, SubmissionRecord>();

  for (const requestId of requestIds) {
    // oxlint-disable-next-line no-await-in-loop -- reads, before any table write
    const submission = await tx.submissionByRequest(child, requestId);

    if (submission?.entry !== undefined) {
      placed.set(submission.entry, submission);
    }
  }

  return { placed };
};

/**
 * The run `submission` was ended by (table reads). An answered run is keyed by its answer. An
 * unanswered run is keyed by its first input (`runStart`) and bounded by its terminal entry or by
 * the next run's first input (`runExtent`), both read from pi-durable's committed transcript and
 * its attribution, never from what a reporter saw live: a steer placed and stopped before any
 * reporter ran finds its run all the same, and a late reporter never reads a later run's entries
 * as its own.
 */
const runOf = async (
  tx: Tx,
  child: ConversationId,
  submission: SubmissionRecord,
  context: RunContext
): Promise<RunSpan> => {
  const alone = {
    key: `input:${submission.id}`,
    start: submission.entry,
    end: undefined,
  };

  if (submission.type !== "input" || submission.entry === undefined) {
    return alone;
  }

  if (submission.status === "done") {
    return {
      key: `answer:${submission.answer}`,
      start: submission.entry,
      end: await answerEnd(tx, child, submission.answer),
    };
  }

  if (submission.status !== "unanswered") {
    return alone;
  }

  const first = await runStart(tx, child, submission.entry, context.placed);

  if (first === undefined) {
    return alone;
  }

  const end = await runExtent(tx, child, submission.entry, context.placed);

  return { key: `run:${first}`, start: submission.entry, end };
};

/**
 * Whether `other` was ended by the run `mine` names: the same run key, and for an unanswered run
 * the settlement one run end gives all its inputs (a guard only; the key decides).
 */
const inRun = (
  mine: RunSpan,
  settled: SettledSubmissionRecord,
  other: SubmissionRecord,
  theirs: RunSpan
): boolean =>
  theirs.key === mine.key &&
  (settled.status === "done" ||
    (other.status === "unanswered" &&
      other.reason === settled.reason &&
      JSON.stringify(other.detail ?? null) ===
        JSON.stringify(settled.detail ?? null)));

/** A nudge mark: the inputs of the run a nudge was sent for. */
type NudgeMarkState = Extract<RunMarkState, { phase: "nudge" }>;

/** The nudge mark a reporter in its `nudge` phase wrote for `seq`, listing `requestId`. */
const nudgeMarkOf = (
  item: SubagentItemState,
  seq: number,
  requestId: string
): NudgeMarkState | undefined =>
  item.runs.findLast(
    (mark): mark is NudgeMarkState =>
      mark.phase === "nudge" &&
      mark.seq === seq &&
      mark.inputs.includes(requestId)
  );

/** What a live peer reporter waits on: its input, or the nudge it sent with that nudge's mark. */
interface PeerWait {
  /** The request id of the submission it waits on. */
  readonly waitsOn: string;
  readonly submission: SubmissionRecord;
  /** Whether its input, or every input its nudge carries, was quiet. */
  readonly quiet: boolean;
  /** The inputs of the run its nudge was sent for; none for an input. */
  readonly carried: ReadonlyArray<string>;
}

/** What the reporter of `requestId` (task `taskId`) waits on now, if it is live (table reads). */
const peerWait = async (
  tx: Tx,
  item: SubagentItemState,
  child: ConversationId,
  requestId: string,
  taskId: number
): Promise<PeerWait | undefined> => {
  const task = await tx.task(taskOf(taskId));
  const state = task?.state;

  if (
    task === undefined ||
    state === undefined ||
    state.status === "completing" ||
    state.status === "terminal" ||
    !isJsonRecord(state.checkpoint)
  ) {
    return undefined;
  }

  const { phase, seq } = state.checkpoint;
  const reporter = isJsonRecord(task.input) ? task.input : {};

  if (phase === "deliver") {
    const submission = await tx.submissionByRequest(child, requestId);

    return submission === undefined
      ? undefined
      : {
          waitsOn: requestId,
          submission,
          quiet: reporter.quiet !== false,
          carried: [],
        };
  }

  const nudge =
    phase === "nudge" && Predicate.isNumber(seq)
      ? nudgeMarkOf(item, seq, requestId)
      : undefined;

  if (nudge === undefined || !Predicate.isString(reporter.childThreadId)) {
    return undefined;
  }

  const waitsOn = SubagentRequestIds.nudge(reporter.childThreadId, nudge.seq);
  const submission = await tx.submissionByRequest(child, waitsOn);

  return submission === undefined
    ? undefined
    : { waitsOn, submission, quiet: nudge.quiet, carried: nudge.inputs };
};

/** Whether the run `mine` ended what `peer` waits on (table reads). */
const peerInRun = async (
  tx: Tx,
  child: ConversationId,
  mine: RunSpan,
  settled: SettledSubmissionRecord,
  peer: PeerWait,
  context: RunContext
): Promise<boolean> =>
  (peer.submission.status === "done" ||
    peer.submission.status === "unanswered") &&
  inRun(
    mine,
    settled,
    peer.submission,
    await runOf(tx, child, peer.submission, context)
  );

/**
 * Every input the run `mine` ended (table reads): the submission the settling reporter waited on
 * (`current`), with the nudged run's inputs when it waited on a nudge (`own`, its nudge mark), and
 * each other live reporter whose own submission (its input, or the nudge it sent, with that
 * nudge's inputs) the same run ended.
 */
const runInputs = async (
  tx: Tx,
  input: ReporterInput,
  item: SubagentItemState,
  current: string,
  own: NudgeMarkState | undefined,
  settled: SettledSubmissionRecord,
  mine: RunSpan,
  context: RunContext
): Promise<RunInputs> => {
  const child = conversationOf(input.child);
  const inputs = [current];
  let quiet = own === undefined ? input.quiet : own.quiet;
  let from = mine.start;

  const add = (requestId: string) => {
    if (!inputs.includes(requestId)) {
      inputs.push(requestId);
    }
  };

  for (const requestId of own?.inputs ?? []) {
    add(requestId);
  }

  for (const [requestId, taskId] of Object.entries(item.inputs)) {
    if (requestId === input.requestId) {
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- reads, before any table write
    const peer = await peerWait(tx, item, child, requestId, taskId);

    const joined =
      peer !== undefined &&
      // oxlint-disable-next-line no-await-in-loop -- reads, before any table write
      (await peerInRun(tx, child, mine, settled, peer, context));

    if (joined) {
      add(peer.waitsOn);

      for (const carried of peer.carried) {
        add(carried);
      }

      quiet &&= peer.quiet;

      const { entry } = peer.submission;

      if (entry !== undefined && (from === undefined || entry < from)) {
        from = entry;
      }
    }
  }

  return { quiet, from, inputs };
};

/** Whether an accepted `submit_result` (not a call answered `already`) lies in `range`. */
const acceptedIn = async (
  tx: Tx,
  child: ConversationId,
  range: { readonly minEntryId: EntryId; readonly maxEntryId?: EntryId }
): Promise<boolean> => {
  // Pages are read one after another: each cursor comes from the page before.
  const scan = async (cursor?: Cursor): Promise<boolean> => {
    const page = await tx.scanEntries(
      { conversationId: child, order: "ascending", ...range },
      RUN_PAGE,
      cursor
    );

    if (
      page.items.some((entry) => Option.contains(markOf(entry), "accepted"))
    ) {
      return true;
    }

    return page.next === undefined ? false : await scan(page.next);
  };

  return await scan();
};

/** Where a child's one accepted result lies against the run being settled. */
type ResultPlace = "none" | "before" | "in" | "after";

/**
 * Where the accepted result (`accepted`, read before the commit) lies against the run from `from`
 * to `end` (table reads): in it, so its settlement carries it; before it, delivered with an earlier
 * run; after it, a later run's (a reporter that settles late); or none yet. A run whose end is not
 * in the transcript reaches to its end.
 */
const resultPlace = async (
  tx: Tx,
  child: ConversationId,
  from: EntryId | undefined,
  end: EntryId | undefined,
  accepted: Option.Option<ResultState>
): Promise<ResultPlace> => {
  if (Option.isNone(accepted)) {
    return "none";
  }

  if (from === undefined) {
    return "before";
  }

  if (
    await acceptedIn(
      tx,
      child,
      end === undefined
        ? { minEntryId: from }
        : { minEntryId: from, maxEntryId: end }
    )
  ) {
    return "in";
  }

  // The run's own entries hold no accepted result (read above), so the scan may start on its end.
  return end !== undefined && (await acceptedIn(tx, child, { minEntryId: end }))
    ? "after"
    : "before";
};

/** `content` as a task input keeps it. */
export const inputPartsOf = (
  content: InputSubmissionDraft["content"]
): string | Array<InputPartState> =>
  Predicate.isString(content)
    ? content
    : content.map((part): InputPartState =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image", data: part.data, mimeType: part.mimeType }
      );

/** The draft a reporter submits for `input`. */
const draftOf = (input: ReporterInput): InputSubmissionDraft => {
  const content = Predicate.isString(input.content)
    ? input.content
    : input.content.map((part) =>
        part.type === "text"
          ? { type: "text" as const, text: part.text }
          : {
              type: "image" as const,
              data: part.data,
              mimeType: part.mimeType,
            }
      );

  return input.entry === null
    ? {
        type: "input",
        requestId: input.requestId,
        content,
        whenBusy: input.whenBusy,
      }
    : {
        type: "input",
        requestId: input.requestId,
        content,
        whenBusy: input.whenBusy,
        entry: { kind: input.entry.kind, data: input.entry.data },
      };
};

/** One wake a reporter submits. */
interface WakeState {
  [key: string]: JsonValue;
  requestId: string;
  text: string;
}

/** Where a reporter stands. */
type ReporterState =
  | { phase: "deliver" }
  | { phase: "nudge"; seq: number }
  | { phase: "report"; settlement: SettlementState; quiet: boolean }
  | { phase: "wake"; settlement: SettlementState; wakes: Array<WakeState> };

/** What a brief task waits on: its approval record in the parent's `cairn.approvals`. */
export interface BriefInput {
  [key: string]: JsonValue;
  approvalId: string;
}

/** Where a brief task stands: waiting, or telling the parent a Decline or Send back. */
type BriefState =
  | { phase: "wait" }
  | {
      phase: "tell";
      halted: boolean;
      /** Why an accepted brief started nothing: its workspace could not be made. */
      failure: string | null;
    };

/** What the parent is told of a brief that started nothing. */
const answerOf = (
  record: ApprovalRecord,
  failure: string | null
): BriefAnswer => {
  if (failure !== null) {
    return { kind: "noWorkspace", why: failure };
  }

  if (record.status === "expired") {
    return { kind: "expired" };
  }

  return {
    kind: record.status === "revised" ? "revised" : "declined",
    reason: Option.fromNullOr(record.reason),
  };
};

/** A cwd to configure; none for the empty one a parent with no cwd gives a shared child. */
const nonEmptyCwd = (cwd: string): Option.Option<string> =>
  cwd === "" ? Option.none() : Option.some(cwd);

/** The text of an entry's first message; empty for none. */
const entryText = (model: ReadonlyArray<Message> | undefined) => {
  const [message] = model ?? [];

  return message === undefined ? "" : messageText(message);
};

/** A scan of a child's entries from `from` (when given) up to `until` (when given), in `order`. */
const entriesBetween = (
  conversationId: ConversationId,
  from: EntryId | undefined,
  until: EntryId | undefined,
  order: "ascending" | "descending"
): EntryQuery => {
  if (from === undefined) {
    return until === undefined
      ? { conversationId, order }
      : { conversationId, maxEntryId: until, order };
  }

  return until === undefined
    ? { conversationId, minEntryId: from, order }
    : { conversationId, minEntryId: from, maxEntryId: until, order };
};

/**
 * The newest answer after `after` and up to `until` (the run's end, when known) in a child's
 * transcript (table read), for a run cut short.
 */
const answerAfter = async (
  tx: Tx,
  conversationId: ConversationId,
  after: EntryId,
  until: EntryId | undefined
): Promise<string> => {
  const page = await tx.scanEntries(
    entriesBetween(conversationId, after, until, "descending"),
    50
  );

  const found = page.items.find((entry) => entry.kind === "pi.assistant");

  return entryText(found?.model);
};

/** `work`'s value, after `cleanup` ran whether it settled or threw. */
const withCleanup = async <A>(
  work: Promise<A>,
  cleanup: () => Promise<void>
): Promise<A> => {
  try {
    return await work;
  } finally {
    await cleanup();
  }
};

/** How a settled input ended, in the run vocabulary, and the failure's words. */
interface InputEnd {
  readonly outcome: SettlementOutcome;
  readonly error: string | null;
  readonly usageLimit: boolean;
}

/** How a settled input ended, in the run vocabulary, and the failure's words. */
const endOf = (
  settled: SettledSubmissionRecord,
  noResult: Option.Option<string>,
  now: number
): InputEnd => {
  if (Option.isSome(noResult)) {
    return { outcome: "failed", error: noResult.value, usageLimit: false };
  }

  if (settled.status === "done") {
    return { outcome: "completed", error: null, usageLimit: false };
  }

  if (settled.reason === "aborted") {
    return { outcome: "stopped", error: null, usageLimit: false };
  }

  const detail = Predicate.isString(settled.detail)
    ? settled.detail
    : settled.reason;

  const failure = classifyRunFailure({
    message: detail,
    reason: Option.some(settled.reason),
    at: DateTime.makeUnsafe(now),
  });

  return {
    outcome: "failed",
    error: `The child's run failed before it answered: ${detail}`,
    usageLimit: failure.class === "usage_limit",
  };
};

/** Whether any other input of the child's registry item is not admitted yet (table reads). */
const anyUnadmitted = async (
  tx: Tx,
  child: ConversationId,
  item: SubagentItemState,
  mine: string
): Promise<boolean> => {
  for (const requestId of Object.keys(item.inputs)) {
    if (
      requestId !== mine &&
      // oxlint-disable-next-line no-await-in-loop -- reads, before any table write
      (await tx.submissionByRequest(child, requestId)) === undefined
    ) {
      return true;
    }
  }

  return false;
};

/**
 * Marks a child settled unless it still works (registry, in the caller's commit): a run of its own,
 * or an input a reporter has not admitted yet (read before the commit's first table write).
 */
const settleUnlessWorking = (
  item: SubagentItemState,
  running: boolean,
  unadmitted: boolean
) => {
  if (!running && !unadmitted) {
    setStatus(item, "settled");
  }
};

/**
 * Whether a wake from any child is still queued in the parent (table reads). Nothing is read while
 * the parent's inbox holds no input. Otherwise each waking child's settlements are read newest
 * first, and only until a wake that was placed: wakes are follow-ups, placed in order, so every
 * older one was placed too. Reads stay bounded by what is queued, not by the parent's history.
 */
const wakeQueued = async (
  tx: Tx,
  parent: ConversationId,
  registry: Readonly<SubagentsState>
): Promise<boolean> => {
  const inbox = await tx.doc(InboxDoc, parent);

  if (!inbox.items.some((item) => item.mode !== "write")) {
    return false;
  }

  for (const item of Object.values(registry.items)) {
    if (item.wake === "quiet") {
      continue;
    }

    for (const mark of item.settlements.toReversed()) {
      // oxlint-disable-next-line no-await-in-loop -- a few reads, before any table write
      const found = await tx.submissionByRequest(
        parent,
        SubagentRequestIds.wake(item.threadId, mark.seq)
      );

      if (found?.status === "queued") {
        return true;
      }

      if (found !== undefined) {
        break;
      }
    }
  }

  return false;
};

/** How many entries after an input the turn count reads; a longer run counts this many. */
const TURN_SCAN = 500;

/** How many answers the child gave in the run that answered an input placed at `from`. */
const turnsAfter = async (
  tx: Tx,
  conversationId: ConversationId,
  from: EntryId | undefined,
  until: EntryId | undefined
): Promise<number> => {
  if (from === undefined) {
    return 0;
  }

  const page = await tx.scanEntries(
    entriesBetween(conversationId, from, until, "ascending"),
    TURN_SCAN
  );

  return page.items.filter((entry) => entry.kind === "pi.assistant").length;
};

/** The most entries a child's total turn count reads; a longer history counts this many. */
const TOTAL_TURN_SCAN = 4 * TURN_SCAN;

/** How many answers a child gave over its whole transcript (table reads, bounded). */
const turnsTotal = async (
  tx: Tx,
  conversationId: ConversationId
): Promise<number> => {
  let total = 0;
  let read = 0;
  let cursor: Parameters<Tx["scanEntries"]>[2];

  do {
    // Each page continues from the last one's cursor.
    // oxlint-disable-next-line no-await-in-loop
    const page = await tx.scanEntries(
      { conversationId, order: "ascending" },
      TURN_SCAN,
      cursor
    );

    total += page.items.filter((entry) => entry.kind === "pi.assistant").length;
    read += page.items.length;
    cursor = page.next;
  } while (cursor !== undefined && read < TOTAL_TURN_SCAN);

  return total;
};

/** The newest answer in a child's transcript that says something (table read); empty for none. */
const lastSpoken = async (
  tx: Tx,
  conversationId: ConversationId,
  until: EntryId | undefined
): Promise<string> => {
  const page = await tx.scanEntries(
    entriesBetween(conversationId, undefined, until, "descending"),
    50
  );

  for (const entry of page.items) {
    const text = entry.kind === "pi.assistant" ? entryText(entry.model) : "";

    if (text.trim() !== "") {
      return text;
    }
  }

  return "";
};

/** What starting a child needs from outside its commit: read once, before it. */
export interface StartReads {
  /** The parent's own link, when the parent is itself a subagent. */
  readonly parentLink: Option.Option<{
    readonly depth: number;
    readonly rootThreadId: string;
  }>;
  /**
   * The model and thinking level the parent runs on: the child runs on them too, and its dispatch
   * record names them (a brief names no role until 4A resolves one at Go).
   */
  readonly model: Option.Option<{
    readonly provider: string;
    readonly modelId: string;
  }>;
  readonly thinkingLevel: Option.Option<Agent["thinkingLevel"]>;
  /** The child's thread id, minted from the brief before its workspace (`childThreadIdOf`). */
  readonly childThreadId: ThreadId;
  /** Where the child works: its cwd (empty: the default) and its worktree, when it has one. */
  readonly workspace: PreparedChildWorkspace;
}

/**
 * Where a child works, made before its creating commit (`ChildWorkspaces.prepare`, idempotent per
 * child): its cwd and worktree, or the words the parent is told when none could be made.
 */
export interface ChildWorkspaceAccess {
  readonly prepare: (
    input: PrepareChildWorkspace
  ) => Promise<Result.Result<PreparedChildWorkspace, string>>;
}

/** The parts of the extension a task builds with. */
export interface TaskDependencies {
  readonly faults: SubagentFaultSet;
  /**
   * The agent change a child gets at creation: its tools instead of a parent's, and
   * `submit_result` when its brief asked for a typed result.
   */
  readonly childAgent: (typed: boolean) => AgentChange;
  /** Makes a child's workspace after Go and before the commit that creates the child. */
  readonly workspaces: ChildWorkspaceAccess;
  /** How long a reporter waits before it settles, by whether its input is quiet (tests only). */
  readonly settleDelayMillis: (quiet: boolean) => number;
  /** A judge brain's crash points (`SubagentCrashes`); production's do nothing. */
  readonly crashAt: (point: SubagentCrashPoint) => void;
}

/** The task definitions, closed over the extension's faults and the child's agent change. */
export const subagentTaskSet = (dependencies: TaskDependencies) => {
  const { crashAt, faults, settleDelayMillis } = dependencies;

  /**
   * A submit's request id: `requestId` itself, or with `freshIds` planted one minted again on every
   * attempt, so a rerun after a crash submits again (the kill judge's broken control).
   */
  const submitId = (requestId: string, now: number) =>
    faults.freshIds ? `${requestId}-${String(now)}` : requestId;

  /**
   * While a child works, its pending records set its registry status: `waiting` while any is
   * pending, `working` again once none is. Never over a settled child or one with no run (its
   * settlement decides then). With `routeApprovalToParent` planted, a pending approval is also
   * offered to the parent model, which approvals never are (ADR 0027).
   */
  const followChild = async (
    runtime: TaskRuntime<ReporterInput, ReporterState, null, object>,
    input: ReporterInput,
    context: Parameters<typeof runWait>[1]
  ) => {
    const child = conversationOf(input.child);
    const parent = runtime.conversationId;
    const watch = await runtime.watchDoc(Approvals, child, context);

    const apply = async (
      value: Readonly<{ items: Record<string, ApprovalRecord> }> | null
    ) => {
      const pending = Object.values(value?.items ?? {}).filter(
        (record) => record.status === "pending"
      );

      // What the commit decided to offer the parent, and the child's description.
      const offered: Array<ApprovalRecord> = [];
      let description = Option.none<string>();

      await runtime.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, child);
        const registry = await tx.doc(SubagentsDoc, parent);
        const item = registry.items[input.key];

        if (
          item === undefined ||
          item.status === "settled" ||
          live.run === undefined
        ) {
          return;
        }

        setStatus(item, pending.length > 0 ? "waiting" : "working");

        if (faults.routeApprovalToParent) {
          for (const record of pending) {
            if (
              record.kind !== "user-input" &&
              item.questions[record.id] === undefined
            ) {
              item.questions[record.id] = {
                state: "pending",
                escalatedAt: null,
              };
              offered.push({ ...record });
            }
          }
        }

        description = Option.some(item.description);
      }, context);

      if (offered.length > 0 && Option.isSome(description)) {
        const conversation = await runtime.conversation(parent, context);

        for (const record of offered) {
          // oxlint-disable-next-line no-await-in-loop -- offered in the order asked
          await conversation?.submit(
            {
              type: "input",
              requestId: SubagentRequestIds.question(
                input.childThreadId,
                record.id
              ),
              content: renderQuestion(description.value, record.summary),
              whenBusy: "followUp",
            },
            context
          );
        }
      }
    };

    if (watch === undefined) {
      return async () => {
        await Promise.resolve();
      };
    }

    await apply(watch.value);
    watch.start(async (value) => {
      try {
        await apply(value);
      } catch (error) {
        runtime.report(error);
      }
    });

    return async () => {
      await watch.stop();
    };
  };

  /**
   * Settles the run that ended the submission a reporter waited on (`current`: its input, or the
   * nudge it sent), in one commit: one settlement per run, answered or not. The run is keyed by its
   * identity (`runOf`), and a run mark already naming that run or `current` (a peer settled the
   * run, or nudged it) means this reporter settles nothing. Otherwise every input the run ended is
   * gathered (`runInputs`) and marked with it. The settlement is built from the child's `report`
   * when it made one, else from its last answer with `not reported`.
   *
   * A typed child's payload and divergence are its accepted result (`accepted`, read before the
   * commit) on the settlement of the run that accepted it only, the transcript read up to that
   * run's end. A typed child whose run completed without one, none having come before, is nudged
   * once (`nudge` phase, with a nudge mark listing every input the run ended) while `nudgeDue`
   * allows, its attempts counted up to the run's end; it settles `failed` otherwise. A run after
   * the one that delivered the result settles as an untyped child's does.
   */
  const settle = async (
    tx: Tx,
    parent: ConversationId,
    input: ReporterInput,
    current: string,
    settled: SettledSubmissionRecord,
    accepted: Option.Option<ResultState>,
    now: number,
    nudgeSeq: Option.Option<number>
  ): Promise<NextTaskState<ReporterState, null>> => {
    const child = conversationOf(input.child);

    // Table reads first.
    const answerEntry =
      settled.type === "input" && settled.status === "done"
        ? settled.answer
        : null;

    const answer =
      answerEntry === null ? undefined : await tx.entry(answerEntry);

    const total = await turnsTotal(tx, child);

    const registry = await tx.doc(SubagentsDoc, parent);
    const item = registry.items[input.key];

    if (item === undefined) {
      return completed();
    }

    const unadmitted = await anyUnadmitted(tx, child, item, input.requestId);
    const live = await tx.doc(LiveDoc, child);
    const running = live.run !== undefined;
    const context = await runContext(tx, child, item);
    const mine = await runOf(tx, child, settled, context);

    // The run's own entries only, up to its end: a reporter that settles late never reads a later
    // run's words or turns.
    const cutShort =
      settled.status === "unanswered" && settled.entry !== undefined
        ? await answerAfter(tx, child, settled.entry, mine.end)
        : "";

    const turns = await turnsAfter(tx, child, settled.entry, mine.end);

    // A typed result's summary when the run ended on `submit_result` with no words of its own.
    const spoken = Option.isSome(accepted)
      ? await lastSpoken(tx, child, mine.end)
      : "";

    // A run settles once: whichever of its reporters gets here first marks it. A nudge mark names
    // the inputs whose run its nudge's run settles: the child still works on the nudge, and the
    // nudge's reporter settles it then.
    const marked = item.runs.filter(
      (mark) =>
        mark.run === mine.key || markInputs(item, mark).includes(current)
    );

    if (marked.length > 0) {
      if (marked.some((mark) => mark.phase === "settled")) {
        settleUnlessWorking(item, running, unadmitted);
      }

      return completed();
    }

    const own = Option.getOrUndefined(
      Option.flatMap(nudgeSeq, (seq) =>
        Option.fromUndefinedOr(nudgeMarkOf(item, seq, input.requestId))
      )
    );

    const run = await runInputs(
      tx,
      input,
      item,
      current,
      own,
      settled,
      mine,
      context
    );

    const link = await tx.doc(ChildDoc, child);

    const place = await resultPlace(tx, child, run.from, mine.end, accepted);
    const result = place === "in" ? accepted : Option.none<ResultState>();

    // A typed child whose run completed without a result, and none before it: its attempts, from
    // its transcript up to the run's end.
    const missing =
      link.resultSchema !== null &&
      settled.status === "done" &&
      (place === "none" || place === "after")
        ? Option.some(
            await readAttemptState(tx, child, Option.fromUndefinedOr(mine.end))
          )
        : Option.none();

    const seq = item.settlements.length + 1;

    // The nudge's mark lists every input the run ended: any of their reporters that settles later
    // finds it, and the nudge's run settles them all, waking the parent unless all were quiet.
    if (Option.isSome(missing) && nudgeDue(missing.value)) {
      item.runs.push({
        run: mine.key,
        phase: "nudge",
        seq,
        inputs: run.inputs,
        quiet: run.quiet,
      });

      return {
        status: "running",
        checkpoint: { phase: "nudge", seq },
      };
    }

    const report = Option.fromNullOr(link.report);

    const noResult = Option.map(missing, (state) =>
      state.used >= MAX_RESULT_ATTEMPTS ? CAP_TEXT : NO_RESULT_ERROR
    );

    const end = endOf(settled, noResult, now);

    const worded = Option.match(report, {
      onNone: () => (answer === undefined ? cutShort : entryText(answer.model)),
      onSome: (found) => found.summary,
    });

    const typedSummary = spoken.trim() === "" ? TYPED_RESULT_SUMMARY : spoken;

    const settlement: SettlementState = {
      subagent: input.childThreadId,
      seq,
      outcome: end.outcome,
      summary:
        worded.trim() === "" && Option.isSome(result) ? typedSummary : worded,
      divergence: Option.match(result, {
        onNone: () =>
          Option.match(report, {
            onNone: () => "not reported",
            onSome: (found) => found.divergence,
          }),
        onSome: (found) => found.divergence,
      }),
      payload: Option.match(result, {
        onNone: () => null,
        onSome: (found) => found.result,
      }),
      commit: Option.match(report, {
        onNone: () => null,
        onSome: (found) => found.commit,
      }),
      branch: null,
      turns: { thisRun: turns, total },
      error: end.error,
      usageLimit: end.usageLimit,
    };

    item.settlements.push({
      seq,
      outcome: end.outcome,
      answerEntry,
      reportedAt: now,
      inputs: run.inputs,
    });

    item.runs.push({ run: mine.key, phase: "settled", seq });

    // The run's report is spent; the next run starts with none.
    link.report = null;
    settleUnlessWorking(item, running, unadmitted);

    return {
      status: "running",
      checkpoint: { phase: "report", settlement, quiet: run.quiet },
    };
  };

  /**
   * Follows a child while `submission` (`current`, the input or the nudge) runs, then settles it in
   * one commit with the child's result, read once the run that could have written it ended.
   */
  const deliverAndSettle = async (
    runtime: TaskRuntime<ReporterInput, ReporterState, null, object>,
    input: ReporterInput,
    current: string,
    submission: Submission,
    context: Parameters<typeof runWait>[1],
    nudgeSeq: Option.Option<number>
  ) => {
    const unfollowChild = await followChild(runtime, input, context);

    const settled = await withCleanup(submission.wait(context), async () => {
      await unfollowChild();
    });

    const delay = settleDelayMillis(input.quiet);

    if (delay > 0) {
      await sleep(delay);
    }

    crashAt("reporter-answered");

    const child = conversationOf(input.child);
    const result = await readResult(runtime, child, context);

    await runtime.commit(
      async (tx) =>
        await settle(
          tx,
          runtime.conversationId,
          input,
          current,
          settled,
          result,
          runtime.now(),
          nudgeSeq
        ),
      context
    );
  };

  const Reporter = defineTask<ReporterInput, ReporterState, null>({
    name: REPORTER_TASK,
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, context) => {
        const { input } = task;

        const child = await runtime.conversation(
          conversationOf(input.child),
          context
        );

        if (child === undefined) {
          await runtime.commit(() => completed(), context);

          return;
        }

        let submission: Submission;

        try {
          submission = await child.submit(
            {
              ...draftOf(input),
              requestId: submitId(input.requestId, runtime.now()),
            },
            context
          );
        } catch (error) {
          // A `reject` input the child refused as busy: the user was told `thread_busy`, so the
          // input is dropped from the registry and a resend gets a reporter again.
          if (!(error instanceof ConversationBusy)) {
            throw error;
          }

          await runtime.commit(async (tx) => {
            const registry = await tx.doc(SubagentsDoc, runtime.conversationId);

            const item = registry.items[input.key];

            if (item !== undefined) {
              item.inputs = Object.fromEntries(
                Object.entries(item.inputs).filter(
                  ([requestId]) => requestId !== input.requestId
                )
              );
            }

            return completed();
          }, context);

          return;
        }

        crashAt("reporter-submitted");

        await deliverAndSettle(
          runtime,
          input,
          input.requestId,
          submission,
          context,
          Option.none()
        );
      },
      nudge: async (task, runtime, context) => {
        const { input } = task;
        const { seq } = task.state.checkpoint;
        const nudge = SubagentRequestIds.nudge(input.childThreadId, seq);

        crashAt("nudge-marked");

        const child = await runtime.conversation(
          conversationOf(input.child),
          context
        );

        if (child === undefined) {
          await runtime.commit(() => completed(), context);

          return;
        }

        const submission = await child.submit(
          {
            type: "input",
            requestId: submitId(nudge, runtime.now()),
            content: NUDGE_TEXT,
            whenBusy: "followUp",
          },
          context
        );

        crashAt("nudge-submitted");

        await deliverAndSettle(
          runtime,
          input,
          nudge,
          submission,
          context,
          Option.some(seq)
        );
      },
      report: async (task, runtime, context) => {
        const { input } = task;
        const { settlement, quiet } = task.state.checkpoint;
        const parent = runtime.conversationId;

        crashAt("reporter-settled");

        // A reporter that mints its ids per attempt lands every rerun again (a planted fault).
        const fresh = runtime.now();

        const deliveries = faults.deliverTwice
          ? [1, 2].map((attempt) => ({
              note: `${SubagentRequestIds.note(input.childThreadId, settlement.seq)}-${fresh}-${attempt}`,
              wake: `${SubagentRequestIds.wake(input.childThreadId, settlement.seq)}-${fresh}-${attempt}`,
            }))
          : [
              {
                note: SubagentRequestIds.note(
                  input.childThreadId,
                  settlement.seq
                ),
                wake: SubagentRequestIds.wake(
                  input.childThreadId,
                  settlement.seq
                ),
              },
            ];

        await runtime.commit(
          async (tx): Promise<NextTaskState<ReporterState, null>> => {
            // Table reads first.
            const halted = await parentHalted(tx, parent);
            const registry = await tx.doc(SubagentsDoc, parent);
            const queued = await wakeQueued(tx, parent, registry);
            const notes = [];

            for (const ids of faults.dropNote ? [] : deliveries) {
              // oxlint-disable-next-line no-await-in-loop -- reads, before any table write
              const reads = await readNote(tx, parent, ids.note);

              notes.push({ id: ids.note, reads });
            }

            const item = registry.items[input.key];

            if (item === undefined) {
              return completed();
            }

            for (const note of notes) {
              // oxlint-disable-next-line no-await-in-loop -- notes land in order
              await applyNote(
                tx,
                parent,
                note.id,
                note.reads,
                noteEntry({
                  kind: SUBAGENT_RESULT_ENTRY,
                  data: settlement,
                  text: renderSettlement(
                    item.description,
                    settlementOf(settlement)
                  ),
                  at: runtime.now(),
                })
              );
            }

            const wakes =
              !quiet &&
              item.wake === "answer" &&
              !settlement.usageLimit &&
              (faults.wakeStoppedParent || !halted) &&
              !queued;

            return {
              status: "running",
              checkpoint: {
                phase: "wake",
                settlement,
                wakes: wakes
                  ? deliveries.map((ids) => ({
                      requestId: ids.wake,
                      text: renderWake(item.description),
                    }))
                  : [],
              },
            };
          },
          context
        );
      },
      wake: async (task, runtime, context) => {
        const { input } = task;
        const { settlement, wakes } = task.state.checkpoint;
        const parent = runtime.conversationId;

        crashAt("reporter-noted");

        if (wakes.length > 0) {
          const conversation = await runtime.conversation(parent, context);

          for (const wake of wakes) {
            // oxlint-disable-next-line no-await-in-loop -- in order
            await conversation?.submit(
              {
                type: "input",
                requestId: submitId(wake.requestId, runtime.now()),
                content: wake.text,
                whenBusy: "followUp",
              },
              context
            );
          }
        }

        crashAt("reporter-woken");

        await runtime.commit(async (tx) => {
          const registry = await tx.doc(SubagentsDoc, parent);
          const item = registry.items[input.key];

          if (item !== undefined) {
            item.delivered = Math.max(item.delivered, settlement.seq);
          }

          return completed();
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context
      );
    },
  });

  /** One reporter for `input`, recorded in the item (the caller's commit). */
  const newReporter = async (
    tx: Tx,
    item: SubagentItemState,
    input: ReporterInput
  ) => {
    const taskId = await tx.createTask(Reporter, input, BACKGROUND);

    item.inputs[input.requestId] = taskId;
    setStatus(item, "working");
  };

  /**
   * Starts a brief's child in one commit, once (ADR 0030): its anchor, its conversation with the
   * child's tools, its thread identity, link and mode, the registry item, the reporter of its first
   * input, and the parent's note that it started. A record already started changes nothing.
   */
  const startChild = async (
    tx: Tx,
    runtime: Pick<TaskRuntime<BriefInput, BriefState, null, object>, "now">,
    parent: ConversationId,
    approvalId: string,
    reads: StartReads
  ): Promise<void> => {
    const noteId = SubagentRequestIds.briefAnswer(approvalId);
    const noteReads = await readNote(tx, parent, noteId);
    const approvals = await tx.doc(Approvals, parent);
    const record = approvals.items[approvalId];
    const brief = briefOfPayload(record?.payload ?? null);

    if (
      record === undefined ||
      record.started !== null ||
      Option.isNone(brief)
    ) {
      return;
    }

    const now = runtime.now();
    const { childThreadId, workspace } = reads;
    const parentMeta = await tx.doc(ThreadMeta, parent);
    const parentPermissions = await tx.doc(Permissions, parent);
    const parentMode = parentPermissions.mode;
    const anchor = await tx.createTask(Anchor, null, BACKGROUND);

    const child = await tx.createConversation({
      ownership: { kind: "task", taskId: anchor },
    });

    const model = Option.getOrElse(reads.model, () => ({
      provider: "unknown",
      modelId: "unknown",
    }));

    // The child runs on what its dispatch record names (2D's rule): the parent's model and
    // thinking level, until 4A resolves a brief's role here.
    await configure(tx, child.id, {
      ...dependencies.childAgent(brief.value.resultSchema !== null),
      ...Option.match(reads.model, {
        onNone: () => ({}),
        onSome: (found) => ({ model: { ...found } }),
      }),
      ...Option.match(reads.thinkingLevel, {
        onNone: () => ({}),
        onSome: (level) => ({ thinkingLevel: level }),
      }),
      // The worktree `prepare` made, or the parent's cwd for a shared child.
      ...Option.match(nonEmptyCwd(workspace.cwd), {
        onNone: () => ({}),
        onSome: (cwd) => ({ cwd }),
      }),
    });

    const mode: RuntimeMode = narrowerMode(brief.value.mode, parentMode);

    const receipt = await tx.doc(ThreadReceipt, childThreadId, {
      conversationId: 0,
    });

    receipt.conversationId = child.id;

    const meta = await tx.doc(ThreadMeta, child.id);

    meta.threadId = childThreadId;
    meta.projectId = parentMeta.projectId;

    await tx.doc(Approvals, child.id);
    await writeMode(tx, child.id, mode);

    const link = await tx.doc(ChildDoc, child.id);

    link.key = approvalId;
    link.parentThreadId = parentMeta.threadId;
    link.parentConversationId = parent;
    link.rootThreadId = Option.match(reads.parentLink, {
      onNone: () => parentMeta.threadId,
      onSome: (found) => found.rootThreadId,
    });
    link.depth = Math.min(
      MAX_SUBAGENT_DEPTH,
      Option.match(reads.parentLink, {
        onNone: () => 1,
        onSome: (found) => found.depth + 1,
      })
    );
    link.briefApprovalId = approvalId;
    link.resultSchema =
      brief.value.resultSchema === null
        ? null
        : jsonRecordOf(brief.value.resultSchema);
    link.permissionMode = mode;

    const registry = await tx.doc(SubagentsDoc, parent);

    const item: SubagentItemState = {
      threadId: childThreadId,
      conversationId: child.id,
      anchorTaskId: anchor,
      briefApprovalId: approvalId,
      description: brief.value.title,
      dispatch: {
        spec: null,
        resolved: {
          spec: `${model.provider}/${model.modelId}`,
          role: null,
          model: { provider: model.provider, modelId: model.modelId },
          thinkingLevel: Option.getOrNull(reads.thinkingLevel),
          via: "literal",
          skipped: [],
          family: familyOf(model),
          // Pricing needs the catalog, which 4A's dispatch reads through `RoleAliases.resolve`.
          priced: false,
        },
        previewed: null,
        dispatchedAt: now,
      },
      isolation: brief.value.workspace,
      worktree: Option.match(workspace.worktree, {
        onNone: () => null,
        onSome: (found) => ({
          path: found.path,
          branch: found.branch,
          baseSha: found.baseSha,
        }),
      }),
      status: "working",
      wake: brief.value.wake,
      settlements: [],
      runs: [],
      delivered: 0,
      questions: {},
      inputs: {},
    };

    // The first reporter is recorded in `item.inputs` before the item enters the draft: a later
    // change to the plain object, once it is in the registry, would not be committed.
    await newReporter(tx, item, {
      key: approvalId,
      child: child.id,
      childThreadId,
      requestId: SubagentRequestIds.brief(approvalId),
      content: renderBrief(brief.value),
      entry: null,
      whenBusy: "followUp",
      quiet: false,
    });

    registry.items[approvalId] = item;
    record.started = { childThreadId };

    await applyNote(
      tx,
      parent,
      noteId,
      noteReads,
      noteEntry({
        kind: BRIEF_ANSWER_ENTRY,
        data: {
          briefId: approvalId,
          decision: "accept",
          started: true,
          childThreadId,
        },
        text: renderBriefAnswer(brief.value.title, {
          kind: "go",
          childThreadId,
        }),
        at: now,
      })
    );
  };

  /** The answer `approvalId` reached, once it left `pending` (expired at its expiry). */
  const answered = async (
    runtime: TaskRuntime<BriefInput, BriefState, null, object>,
    approvalId: string,
    context: Parameters<typeof runWait>[1]
  ): Promise<Option.Option<ApprovalRecord>> => {
    const current = await runtime.snapshot(
      Approvals,
      runtime.conversationId,
      context
    );

    const record = current?.items[approvalId];

    if (record === undefined) {
      return Option.none();
    }

    if (record.status === "pending") {
      const remaining = Math.max(0, record.expiresAt - runtime.now());

      const found = await runWait(
        awaitDoc(runtime, Approvals, runtime.conversationId, (value) =>
          Option.filter(
            Option.fromUndefinedOr(value?.items[approvalId]),
            (settled) => settled.status !== "pending"
          )
        ).pipe(Effect.timeoutOption(remaining), Effect.map(Option.flatten)),
        context
      );

      if (Option.isSome(found)) {
        return found;
      }

      // Unanswered at its expiry: the brief expires, and nothing starts.
      await runtime.commit(async (tx) => {
        const ledger = await tx.doc(Approvals, runtime.conversationId);
        const expiring = ledger.items[approvalId];

        if (expiring?.status === "pending") {
          expiring.status = "expired";
          expiring.answeredAt = runtime.now();
          expiring.decidedBy = { kind: "expiry" };
        }
      }, context);

      return Option.none();
    }

    return Option.some(record);
  };

  /**
   * Starts an accepted brief's child: its thread id minted from the brief, its workspace made
   * (`prepare` lands on the same worktree on a rerun), then the creating commit. A workspace that
   * cannot be made starts nothing, and the parent is told why (`tell`).
   */
  const start = async (
    runtime: TaskRuntime<BriefInput, BriefState, null, object>,
    record: ApprovalRecord,
    context: Parameters<typeof runWait>[1]
  ) => {
    const parent = runtime.conversationId;
    const brief = briefOfPayload(record.payload);
    const parentLink = await runtime.snapshot(ChildDoc, parent, context);
    const parentMeta = await runtime.snapshot(ThreadMeta, parent, context);
    const agent = await runtime.agent(context);

    const childThreadId = childThreadIdOf(
      record.answeredAt ?? record.askedAt,
      parent,
      record.id
    );

    const prepared = Option.isNone(brief)
      ? Result.succeed({ cwd: "", worktree: Option.none() })
      : await dependencies.workspaces.prepare({
          child: childThreadId,
          parent: ThreadId.make(parentMeta?.threadId ?? ""),
          parentCwd: agent.cwd ?? "",
          isolation: brief.value.workspace,
          base: Option.fromNullOr(brief.value.base),
        });

    await runtime.commit(
      async (tx): Promise<NextTaskState<BriefState, null>> => {
        if (Result.isFailure(prepared)) {
          return {
            status: "running",
            checkpoint: {
              phase: "tell",
              halted: await parentHalted(tx, parent),
              failure: prepared.failure,
            },
          };
        }

        await startChild(tx, runtime, parent, record.id, {
          parentLink: isLinked(parentLink)
            ? Option.some({
                depth: parentLink.depth,
                rootThreadId: parentLink.rootThreadId,
              })
            : Option.none(),
          model: Option.fromUndefinedOr(agent.model),
          thinkingLevel: Option.some(agent.thinkingLevel),
          childThreadId,
          workspace: prepared.success,
        });

        return completed();
      },
      context
    );
  };

  const Brief = defineTask<BriefInput, BriefState, null>({
    name: BRIEF_TASK,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, context) => {
        const parent = runtime.conversationId;
        const { approvalId } = task.input;
        const record = await answered(runtime, approvalId, context);

        if (Option.isSome(record) && record.value.status === "accepted") {
          await start(runtime, record.value, context);

          return;
        }

        // Declined, sent back, or expired unanswered (ADR 0030): the parent is told.
        const told =
          Option.isNone(record) ||
          record.value.status === "declined" ||
          record.value.status === "revised" ||
          record.value.status === "expired";

        await runtime.commit(
          async (tx): Promise<NextTaskState<BriefState, null>> =>
            told
              ? {
                  status: "running",
                  checkpoint: {
                    phase: "tell",
                    halted: await parentHalted(tx, parent),
                    failure: null,
                  },
                }
              : completed(),
          context
        );
      },
      tell: async (task, runtime, context) => {
        const parent = runtime.conversationId;
        const { approvalId } = task.input;
        const approvals = await runtime.snapshot(Approvals, parent, context);
        const record = approvals?.items[approvalId];
        const brief = briefOfPayload(record?.payload ?? null);

        if (record !== undefined && Option.isSome(brief)) {
          const text = renderBriefAnswer(
            brief.value.title,
            answerOf(record, task.state.checkpoint.failure)
          );

          const requestId = SubagentRequestIds.briefAnswer(approvalId);

          if (task.state.checkpoint.halted) {
            await runtime.commit(async (tx) => {
              await admitNote(
                tx,
                parent,
                requestId,
                noteEntry({
                  kind: BRIEF_ANSWER_ENTRY,
                  // Nothing started: a declined, revised or expired brief, or an accepted one whose
                  // workspace could not be made.
                  data: {
                    briefId: approvalId,
                    decision: record.status,
                    started: false,
                  },
                  text,
                  at: runtime.now(),
                })
              );
            }, context);
          } else {
            const conversation = await runtime.conversation(parent, context);

            await conversation?.submit(
              {
                type: "input",
                requestId,
                content: text,
                whenBusy: "followUp",
              },
              context
            );
          }
        }

        await runtime.commit(() => completed(), context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context
      );
    },
  });

  return { Anchor, Brief, Reporter, newReporter };
};

/** The subagent task definitions. */
export type SubagentTasks = ReturnType<typeof subagentTaskSet>;
