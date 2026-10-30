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
// - Brief (`cairn.subagent-brief`), one per `subagent_spawn`: the brief's expiry. It sleeps on
//   pi-durable's clock until the record's `expiresAt` and holds nothing in memory; a brief still
//   pending then expires in one commit with the task that tells the parent, and an answered one
//   ends it. Go never waits on it (ADR 0030).
// - StartChild (`cairn.subagent-start`), created by the Go commit itself (`briefAnswered`, inside
//   the answering transaction), so a brief is accepted and its start exists together or not at
//   all. Idempotent by brief id: it mints the child's thread id from the brief (the same on a
//   rerun), resolves the brief's role (`RoleAliases.resolve`, ADR 0035), makes the child's
//   workspace (`ChildWorkspaces.prepare`: a worktree of its own for a writing role, its parent's
//   cwd for a shared child), then starts the child in one commit (`startChild`): anchor, child
//   conversation in that cwd with Cairn's thread identity and its `cairn.child` link, the registry
//   item with its worktree and dispatch record, the first reporter and the parent's note that it
//   started. A record already started changes nothing. A role that does not resolve or a
//   workspace that cannot be made starts nothing, and the parent is told why. When the crash-loop
//   guard parks it, it waits for a human Retry on the parent: the boot repair does not retry it.
// - BriefTell (`cairn.subagent-brief-tell`), created by the commit that settles a brief without a
//   child (Decline, Send back, expiry, or a start that could not start): tells the parent as a
//   follow-up input, or as a note when the parent is halted, under the answer's request id.
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
//   their reporters settle nothing and the nudge's run settles them all.
//   The relay (ADR 0027): an untyped child's run that completed with a plain answer whose last line
//   asks for a decision (`needsDecision`), with no `report` and not a user's own steer, settles
//   nothing yet. Its commit writes a question record (`source: "answer"`, route parent) in the
//   child's ledger and the same kind of run mark, and `ask` routes it (approvals/QuestionRoute.ts):
//   answered, `answer` gives the child the answer as the run's next input, whose run settles them
//   all; declined, expired or cancelled, the run's own answer settles as its result after all. `report` writes the
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
import type { ResolvedRole } from "@cairn/protocol/Roles";
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
import {
  DateTime,
  Effect,
  Function,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";

import { needsDecision } from "../approvals/NeedsDecision.ts";
import {
  endUnanswered,
  placedMemoOf,
  questionRecord,
  relayedAsk,
  routeQuestion,
} from "../approvals/QuestionRoute.ts";
import type { RouteIo } from "../approvals/QuestionRoute.ts";
import {
  Approvals,
  expirePending,
  Permissions,
  RELAYED_QUESTION_TOOL,
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
  renderAnswer,
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
import { countLive, listParent } from "./BrainCap.ts";
import type { BriefFaultHooks } from "./BriefFaults.ts";
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
  EscalationsDoc,
  isJsonRecord,
  isLinked,
  jsonRecordOf,
  markInputs,
  SubagentsDoc,
} from "./SubagentDocs.ts";
import type {
  JsonRecord,
  RunMarkState,
  SubagentItemState,
  SubagentsState,
} from "./SubagentDocs.ts";
import { awaitDoc, runWait } from "./Waits.ts";

/** The anchor task's name. */
export const ANCHOR_TASK = "cairn.subagent-anchor";

/** The brief task's name: a brief's expiry. */
export const BRIEF_TASK = "cairn.subagent-brief";

/** The start task's name: Go's start of a child (ADR 0030). */
export const START_TASK = "cairn.subagent-start";

/** The name of the task that tells a parent how a brief ended without a child. */
export const BRIEF_TELL_TASK = "cairn.subagent-brief-tell";

/** The reporter task's name. */
export const REPORTER_TASK = "cairn.subagent-reporter";

/**
 * The subagent tasks the boot repair retries when the crash-loop guard parked them. The anchor
 * completes in its first phase and waits on nothing, so the guard never parks it. The start task
 * is left out on purpose (ADR 0030): a parked start means something in the spawn path is broken,
 * and a boot retry would loop on it, so it waits for a human Retry on the parent.
 */
export const SUBAGENT_TASKS: ReadonlySet<string> = new Set([
  BRIEF_TASK,
  BRIEF_TELL_TASK,
  REPORTER_TASK,
]);

/**
 * The tasks no boot repair retries when the crash-loop guard parked them, not even the retry of a
 * thread's parked approval waits (`retryParkedApprovalWaits`): the start task (ADR 0030). A parent
 * with another brief or gated call pending would otherwise have its parked start retried on every
 * boot, the crash loop the guard exists to stop. It waits for a human Retry on the parent.
 */
export const HUMAN_RETRY_TASKS: ReadonlySet<string> = new Set([START_TASK]);

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
        ? [
            SubagentRequestIds.nudge(item.threadId, mark.seq),
            SubagentRequestIds.answer(item.threadId, mark.seq),
          ]
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

  // A reporter in `answer` waits on the answer it gave the child after a question, under a mark
  // of the same kind as a nudge's.
  const nudge =
    (phase === "nudge" || phase === "answer") && Predicate.isNumber(seq)
      ? nudgeMarkOf(item, seq, requestId)
      : undefined;

  if (nudge === undefined || !Predicate.isString(reporter.childThreadId)) {
    return undefined;
  }

  const waitsOn =
    phase === "answer"
      ? SubagentRequestIds.answer(reporter.childThreadId, nudge.seq)
      : SubagentRequestIds.nudge(reporter.childThreadId, nudge.seq);

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
  | {
      phase: "ask";
      /** The run mark's `seq`, which the question's record and answer ids derive from. */
      seq: number;
      approvalId: string;
      question: string;
      /** The run's own result, settled after all when the question ends unanswered. */
      settlement: SettlementState;
      answerEntry: number | null;
      quiet: boolean;
    }
  | { phase: "answer"; seq: number; text: string }
  | { phase: "report"; settlement: SettlementState; quiet: boolean }
  | { phase: "wake"; settlement: SettlementState; wakes: Array<WakeState> };

/** What a brief's tasks act on: its approval record in the parent's `cairn.approvals`. */
export interface BriefInput {
  [key: string]: JsonValue;
  approvalId: string;
}

/**
 * Where a brief task stands: sleeping until the brief expires, or (a task a brain from before the
 * Go commit left there) telling the parent a Decline or Send back. `legacy` marks a `wait` a brain
 * from before the Go commit left (version 1), whose answer may have created nothing.
 */
type BriefState =
  | { phase: "wait"; legacy?: boolean }
  | {
      phase: "tell";
      halted: boolean;
      /** Why an accepted brief started nothing: its workspace could not be made. */
      failure: string | null;
    };

/** A start task's one phase. */
interface StartState {
  [key: string]: JsonValue;
  phase: "start";
  /** How many times the role table could not be read at Go; absent before the first. */
  unread?: number;
}

/**
 * Why an accepted brief started nothing: its role resolved to no ready model (`role`), its role
 * table could not be read however long it was retried (`roles`), the brain already had its most
 * children live (`room`), or no workspace could be made (`workspace`).
 */
export interface StartFailure {
  [key: string]: JsonValue;
  at: "role" | "roles" | "room" | "workspace";
  why: string;
  /** For `room`: how many children the brain had live. */
  live?: number;
}

/** How long a start waits before it reads a role table it could not read again. */
export const ROLE_REREAD_MILLIS = 30_000;

/** How many times a start reads an unreadable role table before it tells the parent (ten minutes). */
export const ROLE_REREADS = 20;

/** What a tell task says, fixed by the commit that settled the brief. */
export interface BriefTellInput {
  [key: string]: JsonValue;
  approvalId: string;
  /** Whether the parent was halted (stopped, failed or parked) when the brief settled. */
  halted: boolean;
  /** Why an accepted brief started nothing; none for a declined, revised or expired one. */
  failure: StartFailure | null;
}

/** A tell task's one phase. */
interface BriefTellState {
  [key: string]: JsonValue;
  phase: "tell";
}

/** What the parent is told of a brief that started nothing. */
const answerOf = (
  record: ApprovalRecord,
  failure: StartFailure | null
): BriefAnswer => {
  if (failure !== null) {
    const unstarted: Record<StartFailure["at"], BriefAnswer> = {
      role: { kind: "noModel", why: failure.why },
      roles: { kind: "rolesUnread", why: failure.why },
      room: { kind: "noRoom", live: failure.live ?? 0 },
      workspace: { kind: "noWorkspace", why: failure.why },
    };

    return unstarted[failure.at];
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
   * The model and thinking level the parent runs on: a child whose brief names no role runs on
   * them too, and its dispatch record names them.
   */
  readonly model: Option.Option<{
    readonly provider: string;
    readonly modelId: string;
  }>;
  readonly thinkingLevel: Option.Option<Agent["thinkingLevel"]>;
  /** The child's thread id, minted from the brief before its workspace (`childThreadIdOf`). */
  readonly childThreadId: ThreadId;
  /** What the brief's role resolved to at Go; none for a brief that names no role. */
  readonly dispatch: Option.Option<ResolvedRole>;
  /**
   * For a brief with no role, the parent's model resolved as a literal spec at Go, which prices
   * the dispatch record and names its family; none when it did not resolve (its provider down).
   */
  readonly literal: Option.Option<ResolvedRole>;
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

/**
 * Tells the parent how a brief ended without a child: declined, sent back, expired, or accepted
 * with no workspace (`failure`). As a follow-up input under the answer's request id, or as a note
 * under it when the parent was halted as the brief settled, so a rerun lands it once. Then ends
 * the task.
 */
const tellParent = async <I, S, H extends object>(
  runtime: TaskRuntime<I, S, null, H>,
  approvalId: string,
  halted: boolean,
  failure: StartFailure | null,
  context: Parameters<typeof runWait>[1]
) => {
  const parent = runtime.conversationId;
  const approvals = await runtime.snapshot(Approvals, parent, context);
  const record = approvals?.items[approvalId];
  const brief = briefOfPayload(record?.payload ?? null);

  if (record !== undefined && Option.isSome(brief)) {
    const text = renderBriefAnswer(
      brief.value.title,
      answerOf(record, failure)
    );

    const requestId = SubagentRequestIds.briefAnswer(approvalId);

    if (halted) {
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
};

/**
 * Why a spec did not resolve: nothing ready answers to it (`retry` false: a `RoleError`, final),
 * or the role table, catalog or providers could not be read (`retry` true:
 * `RoleAliasesUnavailable`, which says nothing about the role and passes). `why` is the error's
 * words for the parent.
 */
export interface RoleFailure {
  readonly retry: boolean;
  readonly why: string;
}

/**
 * A role resolved for the commit that creates a child (`RoleAliases.resolve`, ADR 0035): the
 * resolution, or why it did not resolve.
 */
export interface RoleAccess {
  readonly resolve: (
    spec: string
  ) => Promise<Result.Result<ResolvedRole, RoleFailure>>;
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
  /** Where a judge brain kills itself in a brief's Go (`judges/brief-go.sh`); none elsewhere. */
  readonly briefFaults: BriefFaultHooks;
  /** Resolves a brief's role at Go, right before the commit that creates its child (ADR 0035). */
  readonly roles: RoleAccess;
  /** How many children the whole brain may hold live (`MAX_LIVE_CHILDREN_PER_BRAIN`). */
  readonly maxLivePerBrain: number;
  /** How long a question a child's answer became waits before it expires. */
  readonly questionTtlMillis: number;
  /** How long its parent's model may hold that question (ADR 0027). */
  readonly questionWindowMillis: number;
  /** A judge brain's crash points (`SubagentCrashes`); production's do nothing. */
  readonly crashAt: (point: SubagentCrashPoint) => void;
}

/** A stored brief task's input, whatever version stored it. */
const StoredBriefInput = Schema.Struct({ approvalId: Schema.String });

/** A version 1 brief task's `tell` checkpoint. */
const LegacyTell = Schema.Struct({
  phase: Schema.Literal("tell"),
  halted: Schema.Boolean,
  failure: Schema.optionalKey(Schema.Unknown),
});

/** A stored brief task's approval id, whatever version stored it; empty when it holds none. */
const briefInputId = (input: JsonValue): string =>
  Option.match(Schema.decodeUnknownOption(StoredBriefInput)(input), {
    onNone: () => "",
    onSome: (found) => found.approvalId,
  });

/**
 * A version 1 brief task's checkpoint as version 2 reads it: a `wait` is marked `legacy` (its
 * answer may have created nothing), and a `tell` carries on as it was.
 */
const legacyCheckpoint = (checkpoint: JsonValue): BriefState =>
  Option.match(Schema.decodeUnknownOption(LegacyTell)(checkpoint), {
    onNone: (): BriefState => ({ phase: "wait", legacy: true }),
    onSome: (tell): BriefState => ({
      phase: "tell",
      halted: tell.halted,
      failure: Option.getOrNull(
        Schema.decodeUnknownOption(Schema.String)(tell.failure)
      ),
    }),
  });

/** The most answer tasks of one kind a legacy check reads in a conversation: a runaway stops. */
const ANSWER_SCAN_CEILING = 4096;

/**
 * Whether `parent` already holds a start or tell task for `approvalId`, in any state: the answering
 * commit created it. Table reads: call it before the commit's first table write.
 */
const answerTaskExists = async (
  tx: Tx,
  parent: ConversationId,
  approvalId: string
): Promise<boolean> => {
  for (const kind of [START_TASK, BRIEF_TELL_TASK]) {
    let cursor: Parameters<Tx["scanTasks"]>[2];
    let read = 0;

    do {
      // oxlint-disable-next-line no-await-in-loop -- pages of one scan, in order
      const page = await tx.scanTasks(
        { conversationId: parent, kind },
        256,
        cursor
      );

      if (
        page.items.some((found) => briefInputId(found.input) === approvalId)
      ) {
        return true;
      }

      read += page.items.length;
      cursor = page.next;
    } while (cursor !== undefined && read < ANSWER_SCAN_CEILING);
  }

  return false;
};

/** The answer entry of a settled input, when a run answered it. */
const answerEntryOf = (settled: SettledSubmissionRecord) =>
  settled.type === "input" && settled.status === "done" ? settled.answer : null;

/** A route's view of a reporter task: its commits, its clock and its memo. */
const taskRouteIo = (
  runtime: TaskRuntime<ReporterInput, ReporterState, null, object>,
  context: Parameters<typeof runWait>[1]
): RouteIo => ({
  observer: runtime,
  now: () => runtime.now(),
  placedAt: async (approvalId, candidate) =>
    await runtime.memo(placedMemoOf(approvalId), candidate, context),
  conversation: async (id) => await runtime.conversation(id, context),
  commitDocs: async (change) => {
    await runtime.commit(async (tx) => {
      await change(tx);
    }, context);
  },
  // The kill judge's question windows are `ask_parent`'s; a relayed answer's route has none.
  offered: Function.constVoid,
});

/** The task definitions, closed over the extension's faults and the child's agent change. */
export const subagentTaskSet = (dependencies: TaskDependencies) => {
  const {
    crashAt,
    faults,
    settleDelayMillis,
    briefFaults,
    questionTtlMillis,
    questionWindowMillis,
  } = dependencies;

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
   * Resolves once the question `approvalId` in the child's ledger left `pending`, committing
   * `expired` (decided by expiry) when its `expiresAt` comes first.
   */
  const settledOrExpired = async (
    runtime: TaskRuntime<ReporterInput, ReporterState, null, object>,
    child: ConversationId,
    approvalId: string,
    context: Parameters<typeof runWait>[1]
  ): Promise<void> => {
    const approvals = await runtime.snapshot(Approvals, child, context);
    const record = approvals?.items[approvalId];

    if (record === undefined || record.status !== "pending") {
      return;
    }

    const remaining = Math.max(0, record.expiresAt - runtime.now());

    const found = await runWait(
      awaitDoc(runtime, Approvals, child, (value) => {
        const current = value?.items[approvalId];

        return current === undefined || current.status !== "pending"
          ? Option.some(true)
          : Option.none();
      }).pipe(Effect.timeoutOption(remaining), Effect.map(Option.flatten)),
      context
    );

    if (Option.isNone(found)) {
      await runtime.commit(async (tx) => {
        const ledger = await tx.doc(Approvals, child);
        const expiring = ledger.items[approvalId];

        if (expiring !== undefined) {
          expirePending(expiring, runtime.now());
        }
      }, context);
    }
  };

  /** What the relay reads of the run it may turn into a question. */
  interface RelayedRun {
    readonly input: ReporterInput;
    readonly item: SubagentItemState;
    /** The run's key in the registry's run marks. */
    readonly key: string;
    readonly run: RunInputs;
    readonly answer: EntryRecord | undefined;
    readonly answerEntry: number | null;
    readonly settlement: SettlementState;
    readonly reporterTask: number;
    readonly now: number;
    readonly outcome: SettlementOutcome;
    /** The child called `report` in the run. */
    readonly reported: boolean;
    /** The brief asked for a typed result. */
    readonly typed: boolean;
  }

  /**
   * The relay (ADR 0027), inside the settling commit: a run whose final answer asks for a decision
   * (`needsDecision`) writes a question record (`source: "answer"`, route parent) in the child's
   * ledger and a run mark listing the run's inputs, and the reporter goes on to `ask`. None for an
   * answer that asks nothing, which settles as usual.
   */
  const relayQuestion = async (
    tx: Tx,
    relayed: RelayedRun
  ): Promise<Option.Option<NextTaskState<ReporterState, null>>> => {
    const { input, item } = relayed;

    const asked =
      relayed.answer === undefined ? "" : entryText(relayed.answer.model);

    // Only a completed plain answer: no report, no typed result due, not a user's own steer.
    if (
      relayed.outcome !== "completed" ||
      relayed.reported ||
      relayed.typed ||
      relayed.run.quiet ||
      !needsDecision(asked)
    ) {
      return Option.none();
    }

    const seq = item.runs.length + 1;

    const approvalId = SubagentRequestIds.answerQuestion(
      input.childThreadId,
      seq
    );

    const { question, options } = relayedAsk(asked);
    const { items } = await tx.doc(Approvals, conversationOf(input.child));

    items[approvalId] ??= questionRecord(
      {
        approvalId,
        toolTaskId: relayed.reporterTask,
        tool: RELAYED_QUESTION_TOOL,
        source: "answer",
        askedAt: relayed.now,
        question,
        options,
      },
      questionTtlMillis
    );

    item.questions[approvalId] = { state: "pending", escalatedAt: null };
    item.runs.push({
      run: relayed.key,
      phase: "nudge",
      seq,
      inputs: relayed.run.inputs,
      quiet: relayed.run.quiet,
    });
    setStatus(item, "waiting");

    return Option.some({
      status: "running",
      checkpoint: {
        phase: "ask",
        seq,
        approvalId,
        question,
        settlement: relayed.settlement,
        answerEntry: relayed.answerEntry,
        quiet: relayed.run.quiet,
      },
    });
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
    nudgeSeq: Option.Option<number>,
    reporterTask: number
  ): Promise<NextTaskState<ReporterState, null>> => {
    const child = conversationOf(input.child);

    // Table reads first.
    const answerEntry = answerEntryOf(settled);

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

    // The relay (ADR 0027): an untyped child's completed plain answer that asks for a decision
    // becomes a question to its parent instead of a result. A user's own steer is answered to the
    // user, who reads it in the child's thread.
    const asked = await relayQuestion(tx, {
      input,
      item,
      key: mine.key,
      run,
      answer,
      answerEntry,
      settlement,
      reporterTask,
      now,
      outcome: end.outcome,
      reported: Option.isSome(report),
      typed: Option.isSome(missing) || link.resultSchema !== null,
    });

    if (Option.isSome(asked)) {
      return asked.value;
    }

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
          nudgeSeq,
          Number(runtime.taskId)
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

          if (input.requestId === SubagentRequestIds.brief(input.key)) {
            briefFaults.at("submitted");
          }
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
      // A question the child's final answer became: routed to the parent (ADR 0027), then the
      // answer goes to the child, or the run's own answer settles when none came.
      ask: async (task, runtime, context) => {
        const { input } = task;

        const { seq, approvalId, question, settlement, answerEntry, quiet } =
          task.state.checkpoint;

        const parent = runtime.conversationId;

        const child = conversationOf(input.child);
        const registry = await runtime.snapshot(SubagentsDoc, parent, context);

        // Settled by an answer, a decline or a cancellation, or expired at its expiry, as
        // `ask_parent`'s ledger and the brief task expire theirs.
        const settled = settledOrExpired(runtime, child, approvalId, context);

        await routeQuestion(
          taskRouteIo(runtime, context),
          {
            parent,
            child,
            childThreadId: input.childThreadId,
            approvalId,
            description: registry?.items[input.key]?.description ?? "",
            question,
            windowMillis: questionWindowMillis,
            settled,
            offerHalted: faults.wakeStoppedParent,
            freshId: faults.freshQuestionIds,
          },
          context
        );

        await settled;

        const approvals = await runtime.snapshot(Approvals, child, context);
        const record = approvals?.items[approvalId];

        if (record?.status === "accepted") {
          const text = renderAnswer(
            record.decidedBy?.kind === "thread" ? "parent" : "user",
            record.answer?.answers?.[0]
          );

          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: { phase: "answer", seq, text },
            }),
            context
          );

          return;
        }

        // Unanswered: the run's own answer is its result after all, once.
        await runtime.commit(
          async (tx): Promise<NextTaskState<ReporterState, null>> => {
            // Table reads first.
            const live = await tx.doc(LiveDoc, child);
            const current = await tx.doc(SubagentsDoc, parent);
            const item = current.items[input.key];

            const unadmitted =
              item !== undefined &&
              (await anyUnadmitted(tx, child, item, input.requestId));

            await endUnanswered(tx, {
              parentConversationId: parent,
              childConversationId: child,
              approvalId,
              now: runtime.now(),
            });

            const mark = item?.runs.find(
              (found) => found.phase === "nudge" && found.seq === seq
            );

            if (item === undefined || mark === undefined) {
              return completed();
            }

            const next = item.settlements.length + 1;
            const settling = { ...settlement, seq: next };

            item.settlements.push({
              seq: next,
              outcome: settling.outcome,
              answerEntry,
              reportedAt: runtime.now(),
              inputs: [...markInputs(item, mark)],
            });
            item.runs.push({ run: mark.run, phase: "settled", seq: next });
            settleUnlessWorking(item, live.run !== undefined, unadmitted);

            return {
              status: "running",
              checkpoint: { phase: "report", settlement: settling, quiet },
            };
          },
          context
        );
      },
      // The answer to the child's question, as the run's next input, settled as a nudge's is.
      answer: async (task, runtime, context) => {
        const { input } = task;
        const { seq, text } = task.state.checkpoint;
        const requestId = SubagentRequestIds.answer(input.childThreadId, seq);

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
            requestId,
            content: text,
            whenBusy: "followUp",
          },
          context
        );

        await deliverAndSettle(
          runtime,
          input,
          requestId,
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
    runtime: { readonly now: () => number },
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

    const parentModel = Option.getOrElse(reads.model, () => ({
      provider: "unknown",
      modelId: "unknown",
    }));

    // The child runs on what its dispatch record names (2D's rule): what the brief's role
    // resolved to at Go, or for a brief with no role the parent's model and thinking level.
    const resolved: JsonRecord = Option.match(reads.dispatch, {
      onNone: () => ({
        spec: `${parentModel.provider}/${parentModel.modelId}`,
        role: null,
        model: { provider: parentModel.provider, modelId: parentModel.modelId },
        thinkingLevel: Option.getOrNull(reads.thinkingLevel),
        via: "literal",
        skipped: [],
        // The parent's model as a literal spec, resolved at Go, prices it; unresolved, it runs
        // anyway (the parent's model) and the record says unpriced.
        family: Option.match(reads.literal, {
          onNone: () => familyOf(parentModel),
          onSome: (found) => found.family,
        }),
        priced: Option.exists(reads.literal, (found) => found.priced),
      }),
      onSome: (found) => ({
        spec: found.spec,
        role: found.role,
        model: { ...found.model },
        thinkingLevel: found.thinkingLevel,
        via: found.via,
        skipped: found.skipped.map((skip) => ({
          model: { ...skip.model },
          reason: skip.reason,
        })),
        family: found.family,
        priced: found.priced,
      }),
    });

    const model = Option.match(reads.dispatch, {
      onNone: () => reads.model,
      onSome: (found) => Option.some(found.model),
    });

    const thinkingLevel = Option.match(reads.dispatch, {
      onNone: () => reads.thinkingLevel,
      onSome: (found) => Option.fromNullOr(found.thinkingLevel),
    });

    await configure(tx, child.id, {
      ...dependencies.childAgent(brief.value.resultSchema !== null),
      ...Option.match(model, {
        onNone: () => ({}),
        onSome: (found) => ({ model: { ...found } }),
      }),
      ...Option.match(thinkingLevel, {
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
    // Created now, so the child's stream can watch the index of its own children's escalations.
    await tx.doc(EscalationsDoc, child.id);
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
        spec: brief.value.role,
        resolved,
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

  /** The task that tells the parent how a brief ended without a child. */
  const BriefTell = defineTask<BriefTellInput, BriefTellState, null>({
    name: BRIEF_TELL_TASK,
    version: 1,
    initial: () => ({ phase: "tell" }),
    phases: {
      tell: async (task, runtime, context) => {
        const { approvalId, halted, failure } = task.input;

        await tellParent(runtime, approvalId, halted, failure, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context
      );
    },
  });

  /**
   * Creates the tell task for a brief settled without a child, inside the settling commit. Reads
   * whether the parent is halted before it writes (pi-durable refuses a table read after a write).
   */
  const newTell = async (
    tx: Tx,
    parent: ConversationId,
    approvalId: string,
    failure: StartFailure | null
  ) => {
    const halted = await parentHalted(tx, parent);

    await tx.createTask(
      BriefTell,
      { approvalId, halted, failure },
      { ...BACKGROUND, conversationId: parent }
    );
  };

  /**
   * Starts an accepted brief's child: its thread id minted from the brief (from the moment it was
   * answered, so a rerun mints the same), its workspace made (`prepare` lands on the same worktree
   * on a rerun), then the creating commit, which ends the task. A workspace that cannot be made
   * starts nothing: the same commit ends the task and creates the one that tells the parent why.
   */
  const start = async (
    runtime: TaskRuntime<BriefInput, StartState, null, object>,
    record: ApprovalRecord,
    checkpoint: StartState,
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

    const role = Option.flatMap(brief, (found) =>
      Option.fromNullOr(found.role)
    );

    // The role resolves now, at Go, never at the ask (ADR 0035); a role nothing ready answers to
    // starts nothing, and the parent is told why.
    const dispatch = Option.isNone(role)
      ? Result.succeed(Option.none<ResolvedRole>())
      : Result.map(await dependencies.roles.resolve(role.value), Option.some);

    if (Result.isFailure(dispatch)) {
      const { retry, why } = dispatch.failure;
      const unread = (checkpoint.unread ?? 0) + 1;

      // A role table that could not be read says nothing about the role: the start reads it again
      // in a while, on pi-durable's clock, and tells the parent only once that failed for ten
      // minutes. A role nothing ready answers to is final.
      if (retry && unread < ROLE_REREADS) {
        await runtime.sleepUntil(
          runtime.now() + ROLE_REREAD_MILLIS,
          { phase: "start", unread },
          context
        );

        return;
      }

      await runtime.commit(
        async (tx): Promise<NextTaskState<StartState, null>> => {
          await newTell(tx, parent, record.id, {
            at: retry ? "roles" : "role",
            why,
          });

          return completed();
        },
        context
      );

      return;
    }

    // A brief with no role runs on its parent's model and level; resolved as a literal spec, the
    // dispatch record says whether it is priced. Any failure here leaves the record unpriced.
    const literal =
      Option.isSome(role) || agent.model === undefined
        ? Option.none<ResolvedRole>()
        : Result.getSuccess(
            await dependencies.roles.resolve(
              `${agent.model.provider}/${agent.model.modelId}:${agent.thinkingLevel}`
            )
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

    briefFaults.at("prepared");

    await runtime.commit(
      async (tx): Promise<NextTaskState<StartState, null>> => {
        // The brain's count again, without this start (BrainCap.ts): table reads, so first. The
        // spawn's own count keeps it under the cap; this catches two threads' spawns racing. A
        // worktree made for a brief refused here is removed by the boot's child workspace repair.
        const brain = await countLive(tx, START_TASK, runtime.taskId);

        if (Result.isFailure(prepared)) {
          await newTell(tx, parent, record.id, {
            at: "workspace",
            why: prepared.failure,
          });

          return completed();
        }

        if (brain.live >= dependencies.maxLivePerBrain) {
          await newTell(tx, parent, record.id, {
            at: "room",
            why: "",
            live: brain.live,
          });

          return completed();
        }

        await listParent(tx, parent);
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
          dispatch: dispatch.success,
          literal,
        });

        return completed();
      },
      context
    );

    briefFaults.at("created");
  };

  /**
   * Go's start of a child (ADR 0030): created by the answering commit, so it exists exactly when
   * the brief is accepted. A record that is not accepted, or already started a child, ends it with
   * nothing done, so a second start (a race, a rerun) changes nothing.
   */
  const StartChild = defineTask<BriefInput, StartState, null>({
    name: START_TASK,
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, runtime, context) => {
        briefFaults.at("start");

        const approvals = await runtime.snapshot(
          Approvals,
          runtime.conversationId,
          context
        );

        const record = approvals?.items[task.input.approvalId];

        if (
          record === undefined ||
          record.status !== "accepted" ||
          record.started !== null
        ) {
          await runtime.commit(() => completed(), context);

          return;
        }

        await start(runtime, record, task.state.checkpoint, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context
      );
    },
  });

  /**
   * A brief's expiry (ADR 0030). It sleeps on pi-durable's clock until the record's `expiresAt`, so
   * nothing waits in memory and a restart changes nothing; then a brief still pending expires, in
   * one commit with the task that tells the parent, and an answered one ends the task. Its `tell`
   * phase only finishes a task a brain from before the Go commit left there.
   */
  const Brief = defineTask<BriefInput, BriefState, null>({
    name: BRIEF_TASK,
    // Version 2: Go's commit creates the start (ADR 0030). A version 1 task (3A's) started the
    // child itself after Go, and told the parent of a Decline itself.
    version: 2,
    initial: () => ({ phase: "wait" }),
    migrate: (input, checkpoint) => ({
      input: { approvalId: briefInputId(input) },
      checkpoint: legacyCheckpoint(checkpoint),
    }),
    phases: {
      wait: async (task, runtime, context) => {
        const parent = runtime.conversationId;
        const { approvalId } = task.input;
        const approvals = await runtime.snapshot(Approvals, parent, context);
        const record = approvals?.items[approvalId];

        // A version 1 brief answered before this brain ran it: its answer created no start and no
        // tell, so this commit does, once. A brief this brain answered while the old task still
        // waited already has its start or tell from the answering commit, which the scan finds.
        if (
          task.state.checkpoint.legacy === true &&
          record !== undefined &&
          record.status !== "pending"
        ) {
          await runtime.commit(
            async (tx): Promise<NextTaskState<BriefState, null>> => {
              // Table reads, so before the commit's first table write.
              if (await answerTaskExists(tx, parent, approvalId)) {
                return completed();
              }

              const ledger = await tx.doc(Approvals, parent);
              const answered = ledger.items[approvalId];

              if (
                answered?.status === "accepted" &&
                answered.started === null
              ) {
                await tx.createTask(
                  StartChild,
                  { approvalId },
                  { ...BACKGROUND, conversationId: parent }
                );
              } else if (
                answered?.status === "declined" ||
                answered?.status === "revised" ||
                answered?.status === "expired"
              ) {
                await newTell(tx, parent, approvalId, null);
              }

              return completed();
            },
            context
          );

          return;
        }

        if (record?.status === "pending" && runtime.now() < record.expiresAt) {
          await runtime.sleepUntil(
            record.expiresAt,
            { phase: "wait" },
            context
          );

          return;
        }

        await runtime.commit(
          async (tx): Promise<NextTaskState<BriefState, null>> => {
            const ledger = await tx.doc(Approvals, parent);
            const expiring = ledger.items[approvalId];

            // Answered meanwhile: the answering commit started the child or told the parent.
            if (expiring?.status !== "pending") {
              return completed();
            }

            await newTell(tx, parent, approvalId, null);

            expiring.status = "expired";
            expiring.answeredAt = runtime.now();
            expiring.decidedBy = { kind: "expiry" };

            return completed();
          },
          context
        );
      },
      tell: async (task, runtime, context) => {
        const { halted, failure } = task.state.checkpoint;

        await tellParent(
          runtime,
          task.input.approvalId,
          halted,
          failure === null ? null : { at: "workspace", why: failure },
          context
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context
      );
    },
  });

  /**
   * What a brief's answer starts, inside the answering transaction (ADR 0030): Go creates the start
   * task, so the brief is accepted and its start exists together or not at all; Decline and Send
   * back create the task that tells the parent. A record that is not a subagent's brief (a gated
   * call, a question, a workflow's launch) starts nothing. `record` has just left `pending`.
   */
  const briefAnswered = async (
    tx: Tx,
    parent: ConversationId,
    record: ApprovalRecord
  ): Promise<void> => {
    if (
      record.kind !== "brief" ||
      Option.isNone(briefOfPayload(record.payload))
    ) {
      return;
    }

    if (record.status === "accepted") {
      await tx.createTask(
        StartChild,
        { approvalId: record.id },
        { ...BACKGROUND, conversationId: parent }
      );
    } else if (record.status === "declined" || record.status === "revised") {
      await newTell(tx, parent, record.id, null);
    }
  };

  return {
    Anchor,
    Brief,
    StartChild,
    BriefTell,
    Reporter,
    newReporter,
    briefAnswered,
  };
};

/** The subagent task definitions. */
export type SubagentTasks = ReturnType<typeof subagentTaskSet>;
