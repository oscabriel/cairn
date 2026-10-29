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
// - Brief (`cairn.subagent-brief`), one per `subagent_spawn`: waits for the brief's answer. Go
//   starts the child in one commit (`startChild`): anchor, child conversation with Cairn's thread
//   identity and its `cairn.child` link, the registry item, the first reporter and the parent's
//   note that it started. Decline and Send back reach the parent as a follow-up input, or as a note
//   when the parent is halted. The briefs package (4A) moves Go into the answer itself.
// - Reporter (`cairn.subagent-reporter`), one per input to a child (the brief, `subagent_send`, a
//   user's steer typed into the child): `deliver` submits the input under its request id (the
//   whole input: its text and images, its entry, its `whenBusy`), mirrors the child's pending
//   records into its registry status while it works, and settles once per run in one commit (a
//   run that ended several inputs, a nudge's included, settles them all and wakes the parent
//   unless all of them were a user's steers; its mark lists their request ids);
//   `nudge` sends a typed child that ended without a result its one nudge (`NUDGE_TEXT`) and
//   settles on that run, with every input the nudged run ended (its checkpoint carries them, and
//   a peer it carries settles nothing); `report` writes the settlement's note and decides the wake by the
//   parent's state; `wake` submits the wake and marks the settlement delivered. Nudge, note and
//   wake request ids derive from the child and the settlement's `seq`, so a rerun after `kill -9`
//   lands each once.
//
// A typed child's result is `submit_result`'s (models/ResultTool.ts): the payload and divergence of
// the settlement of the run that accepted it come from its `cairn.result` (`readResult`); later
// runs settle as an untyped child's do. A child whose run ends without one gets
// the nudge while `nudgeDue` says so, and otherwise settles `failed`, with `CAP_TEXT` once its
// attempts are spent. `report` carries the summary, the divergence of a text result and a commit.
//
// `SubagentFaults` breaks the delivery on purpose for the conformance suite's mutation check; the
// production layer plants none.

import { setTimeout as sleep } from "node:timers/promises";

import { narrowerMode } from "@cairn/client-logic/EffectiveMode";
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
  InputSubmissionDraft,
  NextTaskState,
  SettledSubmissionRecord,
  Submission,
  SubmissionRecord,
  TaskRecord,
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
import { DateTime, Effect, Option, Predicate } from "effect";

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
import type { SubagentFaultSet } from "../brain/SubagentFaults.ts";
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
  SubagentsDoc,
} from "./SubagentDocs.ts";
import type { SubagentItemState, SubagentsState } from "./SubagentDocs.ts";
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
   * Whether the run goes without a wake: `input` is quiet (a user's own steer) and so is every
   * other input it ended. The first reporter to settle a run settles it for all of them, so a
   * user's steer and the parent's send ended together still wake the parent.
   */
  readonly quiet: boolean;
  /** The earliest entry an input it ended was placed as. */
  readonly from: EntryId | undefined;
  /** The request ids (registry keys) of every reporter whose input the run ended, `input`'s first. */
  readonly inputs: Array<string>;
}

/**
 * What a reporter in its `nudge` phase carries from the run it nudged: the request ids of every
 * input that run ended and whether all of them were quiet. The nudge's run settles them with its
 * own, so the reporter that sent the nudge decides that run's wake for all of them.
 */
interface NudgedRun {
  readonly inputs: ReadonlyArray<string>;
  readonly quiet: boolean;
}

/** A run that carries nothing from a nudged one: the reporter's own input only. */
const NOTHING_CARRIED: NudgedRun = { inputs: [], quiet: true };

/** What a reporter in its `nudge` phase carries, from its checkpoint (plain JSON). */
const nudgedRunOf = (
  task: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined
): Option.Option<NudgedRun> => {
  const state = task?.state;

  if (
    state === undefined ||
    state.status === "completing" ||
    state.status === "terminal" ||
    !isJsonRecord(state.checkpoint) ||
    state.checkpoint.phase !== "nudge"
  ) {
    return Option.none();
  }

  const { inputs, quiet } = state.checkpoint;

  return Option.some({
    inputs: Array.isArray(inputs) ? inputs.filter(Predicate.isString) : [],
    quiet: quiet !== false,
  });
};

/**
 * Whether two settled submissions ended in one run (table records only). A failed or stopped run
 * keeps no run id on its inputs, so they match by placed entry, reason and detail. Its limit: a
 * peer whose input an earlier run failed the same way, and whose reporter has not settled yet (a
 * restart between the two runs, say), is grouped into the later run, and the earlier failure's
 * settlement is lost; its parent still hears of the later one.
 */
const sameRun = (
  mine: SettledSubmissionRecord,
  other: SubmissionRecord | undefined
): boolean => {
  if (other?.type !== "input") {
    return false;
  }

  if (mine.status === "done") {
    return other.status === "done" && other.answer === mine.answer;
  }

  // A failed or stopped run settles every input it placed in one commit, with one reason and
  // detail and no answer to compare; an input never placed (withdrawn) ran in no run.
  return (
    mine.type === "input" &&
    mine.entry !== undefined &&
    other.status === "unanswered" &&
    other.entry !== undefined &&
    other.reason === mine.reason &&
    JSON.stringify(other.detail ?? null) === JSON.stringify(mine.detail ?? null)
  );
};

/**
 * The submission a peer reporter waits on now: its own input, or in the `nudge` phase the nudge
 * it sent, whose run may be the one being settled. None for a reporter that settled already.
 */
const peerSubmission = async (
  tx: Tx,
  child: ConversationId,
  requestId: string,
  task: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined
): Promise<SubmissionRecord | undefined> => {
  if (task === undefined) {
    return undefined;
  }

  const { state } = task;

  if (state.status === "completing" || state.status === "terminal") {
    return undefined;
  }

  const checkpoint = isJsonRecord(state.checkpoint) ? state.checkpoint : {};
  const reporter = isJsonRecord(task.input) ? task.input : {};

  if (checkpoint.phase === "nudge") {
    return Predicate.isNumber(checkpoint.seq) &&
      Predicate.isString(reporter.childThreadId)
      ? await tx.submissionByRequest(
          child,
          SubagentRequestIds.nudge(reporter.childThreadId, checkpoint.seq)
        )
      : undefined;
  }

  return checkpoint.phase === "deliver"
    ? await tx.submissionByRequest(child, requestId)
    : undefined;
};

/**
 * The run `settled` ended, over every input it ended (table reads only): another reporter's input
 * belongs to it when its current submission (its own input, or the nudge it sent) was answered by
 * the same answer, or, for a run that ended without one, was placed and ended with the same reason.
 * A reporter that already settled is left out: its run's mark lists it. The inputs of a nudged run
 * come along with its nudge: `carried` for this reporter's own, a peer's checkpoint for its.
 */
const runInputs = async (
  tx: Tx,
  input: ReporterInput,
  item: SubagentItemState,
  others: ReadonlyArray<string>,
  settled: SettledSubmissionRecord,
  carried: NudgedRun
): Promise<RunInputs> => {
  let quiet = input.quiet && carried.quiet;
  let from = settled.entry;
  const inputs = [input.requestId];
  const child = conversationOf(input.child);

  const add = (requestId: string) => {
    if (!inputs.includes(requestId)) {
      inputs.push(requestId);
    }
  };

  for (const requestId of carried.inputs) {
    add(requestId);
  }

  if (settled.status === "unanswered" && settled.entry === undefined) {
    return { quiet, from, inputs };
  }

  for (const requestId of others) {
    const taskId = item.inputs[requestId];

    if (taskId === undefined) {
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- reads, before any table write
    const task = await tx.task(taskOf(taskId));
    // oxlint-disable-next-line no-await-in-loop -- reads, before any table write
    const submission = await peerSubmission(tx, child, requestId, task);

    if (submission !== undefined && sameRun(settled, submission)) {
      if (
        submission.entry !== undefined &&
        (from === undefined || submission.entry < from)
      ) {
        from = submission.entry;
      }

      const reporter = isJsonRecord(task?.input) ? task.input : {};
      const nudged = Option.getOrElse(nudgedRunOf(task), () => NOTHING_CARRIED);

      if (reporter.quiet === false || !nudged.quiet) {
        quiet = false;
      }

      add(requestId);

      for (const carriedId of nudged.inputs) {
        add(carriedId);
      }
    }
  }

  return { quiet, from, inputs };
};

/**
 * Whether a peer reporter in its `nudge` phase carries `requestId`: the run that ended it was
 * nudged, and the nudge's run settles it (table reads only).
 */
const nudgedByPeer = async (
  tx: Tx,
  item: SubagentItemState,
  others: ReadonlyArray<string>,
  requestId: string
): Promise<boolean> => {
  for (const other of others) {
    const taskId = item.inputs[other];

    if (taskId !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- reads, before any table write
      const nudged = nudgedRunOf(await tx.task(taskOf(taskId)));

      if (Option.exists(nudged, (found) => found.inputs.includes(requestId))) {
        return true;
      }
    }
  }

  return false;
};

/** How many entries `resultOfRun` reads per page. */
const RESULT_PAGE = 256;

/**
 * `accepted` when the run being settled accepted it: an accepted `submit_result` (not a later
 * call answered `already`) lies at or after `from`, the run's first input (table reads, paged to
 * the end of the transcript). A typed result goes to the parent once, with its run; the child's
 * later runs settle without it, and so does an input that ran in no run.
 */
const resultOfRun = async (
  tx: Tx,
  child: ConversationId,
  from: EntryId | undefined,
  accepted: Option.Option<ResultState>
): Promise<Option.Option<ResultState>> => {
  if (Option.isNone(accepted) || from === undefined) {
    return Option.none();
  }

  // Pages are read one after another: each cursor comes from the page before.
  const scan = async (cursor?: Cursor): Promise<boolean> => {
    const page = await tx.scanEntries(
      { conversationId: child, minEntryId: from, order: "ascending" },
      RESULT_PAGE,
      cursor
    );

    if (
      page.items.some((entry) => Option.contains(markOf(entry), "accepted"))
    ) {
      return true;
    }

    return page.next === undefined ? false : await scan(page.next);
  };

  return (await scan()) ? accepted : Option.none();
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
  | { phase: "nudge"; seq: number; inputs: Array<string>; quiet: boolean }
  | { phase: "report"; settlement: SettlementState; quiet: boolean }
  | { phase: "wake"; settlement: SettlementState; wakes: Array<WakeState> };

/** What a brief task waits on: its approval record in the parent's `cairn.approvals`. */
export interface BriefInput {
  [key: string]: JsonValue;
  approvalId: string;
}

/** Where a brief task stands: waiting, or telling the parent a Decline or Send back. */
type BriefState = { phase: "wait" } | { phase: "tell"; halted: boolean };

/** The text of an entry's first message; empty for none. */
const entryText = (model: ReadonlyArray<Message> | undefined) => {
  const [message] = model ?? [];

  return message === undefined ? "" : messageText(message);
};

/** The newest answer after `after` in a child's transcript (table read), for a run cut short. */
const answerAfter = async (
  tx: Tx,
  conversationId: ConversationId,
  after: EntryId
): Promise<string> => {
  const page = await tx.scanEntries(
    { conversationId, minEntryId: after, order: "descending" },
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
  from: EntryId | undefined
): Promise<number> => {
  if (from === undefined) {
    return 0;
  }

  const page = await tx.scanEntries(
    { conversationId, minEntryId: from, order: "ascending" },
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
  conversationId: ConversationId
): Promise<string> => {
  const page = await tx.scanEntries(
    { conversationId, order: "descending" },
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
}

/** The parts of the extension a task builds with. */
export interface TaskDependencies {
  readonly faults: SubagentFaultSet;
  /**
   * The agent change a child gets at creation: its tools instead of a parent's, and
   * `submit_result` when its brief asked for a typed result.
   */
  readonly childAgent: (typed: boolean) => AgentChange;
  /** How long a reporter waits before it settles, by whether its input is quiet (tests only). */
  readonly settleDelayMillis: (quiet: boolean) => number;
}

/** The task definitions, closed over the extension's faults and the child's agent change. */
export const subagentTaskSet = (dependencies: TaskDependencies) => {
  const { faults, settleDelayMillis } = dependencies;

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
   * Settles one input once its run ended, in one commit: one settlement per run, answered or not
   * (an input whose run another reporter settled, as that settlement's mark lists, settles
   * nothing), built from the child's `report` when it made
   * one, else from its last answer with `not reported`. A typed child's payload and divergence are
   * its accepted result (`accepted`, read before the commit), on the settlement of the run that
   * accepted it only; a typed child whose run completed without one is nudged once (`nudge` phase)
   * while `nudgeDue` allows (the transcript's nudge mark says when it was sent), and settles
   * `failed` otherwise. A later run of a child whose result was already delivered settles as an
   * untyped child's does.
   */
  const settle = async (
    tx: Tx,
    parent: ConversationId,
    input: ReporterInput,
    settled: SettledSubmissionRecord,
    accepted: Option.Option<ResultState>,
    now: number,
    carried: NudgedRun
  ): Promise<NextTaskState<ReporterState, null>> => {
    const child = conversationOf(input.child);

    // Table reads first.
    const answerEntry =
      settled.type === "input" && settled.status === "done"
        ? settled.answer
        : null;

    const answer =
      answerEntry === null ? undefined : await tx.entry(answerEntry);

    const cutShort =
      settled.status === "unanswered" && settled.entry !== undefined
        ? await answerAfter(tx, child, settled.entry)
        : "";

    const turns = await turnsAfter(tx, child, settled.entry);
    const total = await turnsTotal(tx, child);

    // A typed result's summary when the run ended on `submit_result` with no words of its own.
    const spoken = Option.isSome(accepted) ? await lastSpoken(tx, child) : "";

    const registry = await tx.doc(SubagentsDoc, parent);
    const item = registry.items[input.key];

    if (item === undefined) {
      return completed();
    }

    const others = Object.keys(item.inputs).filter(
      (requestId) => requestId !== input.requestId
    );

    let unadmitted = false;

    for (const requestId of others) {
      // oxlint-disable-next-line no-await-in-loop -- reads, before any table write
      if ((await tx.submissionByRequest(child, requestId)) === undefined) {
        unadmitted = true;
      }
    }

    const run = await runInputs(tx, input, item, others, settled, carried);
    const nudged = await nudgedByPeer(tx, item, others, input.requestId);
    const result = await resultOfRun(tx, child, run.from, accepted);

    const link = await tx.doc(ChildDoc, child);

    // A typed child whose run completed without a result: its attempts, from its transcript.
    const missing =
      link.resultSchema !== null &&
      settled.status === "done" &&
      Option.isNone(accepted)
        ? Option.some(await readAttemptState(tx, child))
        : Option.none();

    const live = await tx.doc(LiveDoc, child);
    const running = live.run !== undefined;

    // A run settles once: whichever of its inputs' reporters settles first lists them all.
    if (
      item.settlements.some(
        (mark) =>
          mark.inputs.includes(input.requestId) ||
          (answerEntry !== null && mark.answerEntry === answerEntry)
      )
    ) {
      settleUnlessWorking(item, running, unadmitted);

      return completed();
    }

    // A peer nudged the run that ended this input: the nudge's run settles it, so the child still
    // works and this reporter settles nothing (not `failed`, its nudge being spent).
    if (nudged) {
      return completed();
    }

    const seq = item.settlements.length + 1;

    // The nudge carries every input the run ended: its run settles them all, and wakes the parent
    // unless all of them were quiet, whichever of their reporters got here first.
    if (Option.isSome(missing) && nudgeDue(missing.value)) {
      return {
        status: "running",
        checkpoint: {
          phase: "nudge",
          seq,
          inputs: run.inputs.filter(
            (requestId) => requestId !== input.requestId
          ),
          quiet: run.quiet,
        },
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

    // The run's report is spent; the next run starts with none.
    link.report = null;
    settleUnlessWorking(item, running, unadmitted);

    return {
      status: "running",
      checkpoint: { phase: "report", settlement, quiet: run.quiet },
    };
  };

  /**
   * Follows a child while `submission` runs, then settles it in one commit with the child's result,
   * read once the run that could have written it ended.
   */
  const deliverAndSettle = async (
    runtime: TaskRuntime<ReporterInput, ReporterState, null, object>,
    input: ReporterInput,
    submission: Submission,
    context: Parameters<typeof runWait>[1],
    carried: NudgedRun
  ) => {
    const stop = await followChild(runtime, input, context);
    const settled = await withCleanup(submission.wait(context), stop);
    const delay = settleDelayMillis(input.quiet);

    if (delay > 0) {
      await sleep(delay);
    }

    const child = conversationOf(input.child);
    const result = await readResult(runtime, child, context);

    await runtime.commit(
      async (tx) =>
        await settle(
          tx,
          runtime.conversationId,
          input,
          settled,
          result,
          runtime.now(),
          carried
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
          submission = await child.submit(draftOf(input), context);
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

        await deliverAndSettle(
          runtime,
          input,
          submission,
          context,
          NOTHING_CARRIED
        );
      },
      nudge: async (task, runtime, context) => {
        const { input } = task;
        const { seq, inputs, quiet } = task.state.checkpoint;

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
            requestId: SubagentRequestIds.nudge(input.childThreadId, seq),
            content: NUDGE_TEXT,
            whenBusy: "followUp",
          },
          context
        );

        await deliverAndSettle(runtime, input, submission, context, {
          inputs,
          quiet,
        });
      },
      report: async (task, runtime, context) => {
        const { input } = task;
        const { settlement, quiet } = task.state.checkpoint;
        const parent = runtime.conversationId;

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

        if (wakes.length > 0) {
          const conversation = await runtime.conversation(parent, context);

          for (const wake of wakes) {
            // oxlint-disable-next-line no-await-in-loop -- in order
            await conversation?.submit(
              {
                type: "input",
                requestId: wake.requestId,
                content: wake.text,
                whenBusy: "followUp",
              },
              context
            );
          }
        }

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
    });

    const childThreadId = childThreadIdOf(now, child.id);
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
      worktree: null,
      status: "working",
      wake: brief.value.wake,
      settlements: [],
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
        data: { briefId: approvalId, decision: "accept", childThreadId },
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
          const parentLink = await runtime.snapshot(ChildDoc, parent, context);
          const agent = await runtime.agent(context);

          const reads: StartReads = {
            parentLink: isLinked(parentLink)
              ? Option.some({
                  depth: parentLink.depth,
                  rootThreadId: parentLink.rootThreadId,
                })
              : Option.none(),
            model: Option.fromUndefinedOr(agent.model),
            thinkingLevel: Option.some(agent.thinkingLevel),
          };

          await runtime.commit(async (tx) => {
            await startChild(tx, runtime, parent, approvalId, reads);

            return completed();
          }, context);

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
          const reason = Option.fromNullOr(record.reason);

          const text = renderBriefAnswer(
            brief.value.title,
            record.status === "expired"
              ? { kind: "expired" }
              : {
                  kind: record.status === "revised" ? "revised" : "declined",
                  reason,
                }
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
                  data: { briefId: approvalId, decision: record.status },
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
