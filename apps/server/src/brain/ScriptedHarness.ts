// An independent, in-memory implementation of the harness seam that plays scripted model answers
// (plan D14, ADR 0024). It is the deterministic backend for UI tests, screenshots and the dev
// client, and the second side the replay conformance suite judges: it shares no code with
// pi-durable's loop, only the seam, the wire projection and the shapes of pi-durable's view (entry
// kinds, `pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`, `cairn.approvals`, `cairn.subagents`,
// `cairn.child`, `cairn.escalations`), so a client cannot tell the backends apart.
//
// Semantics it keeps, as the seam's contract states them:
// - A run starts when an input arrives at an idle thread; inputs that arrive while it runs queue as
//   steers (placed after the next tool round) or follow-ups (placed when the answer is final), or
//   are refused with `thread_busy`.
// - A stop ends the run as interrupted and keeps the queue; stop with `clearQueue` withdraws it too.
// - A failed answer ends the run as failed and leaves the queue for the next input.
// - A request id is admitted once per thread. Tools run in call order; a tool may ask for approval.
// - A note (a write the model reads) is placed at once on an idle thread and at the next boundary
//   of a running one, ahead of queued inputs; a run that ends by a stop or a failure places it too.
// - State lives in `ScriptedStore`, which outlives a harness instance: a new instance over the same
//   store is a restart, and resumes an interrupted run by asking the model again.
// - `whenEnsured` subscribes to the events before it looks in the store, so an ensure that lands in
//   between still wakes it.
//
// Subagents (ADR 0028, ADR 0027, docs/phase-2/notes/subagents.md sections 1 to 5):
// - `subagent_spawn` records a brief (kind `brief`) and returns at once. Go starts the child in the
//   answering critical section: a thread with a `cairn.child` link, an item in the parent's
//   `cairn.subagents`, and a reporter for the rendered brief. Decline or Send back starts nothing
//   and tells the parent with an input; Go tells it with a note.
// - One reporter per input to a child: it admits the input under its request id, waits for the
//   run that answers it, settles once per run, then writes the note and, by the parent's state,
//   the wake, each under ids derived from the child and the settlement's `seq`. Reporters live in
//   the store, so a restart resumes them where they stood and every write lands once.
// - Wakes obey the parent: none for a quiet spawn or a user's steer to the child (unless the run
//   that answered it also answered the parent's own input), none for a parent the user stopped or
//   whose run failed, at most one queued while the parent runs. A typed result goes with the
//   settlement of the run that accepted it only.
// - A final answer settles the inputs its run placed, and a queued input it places goes on in a
//   new segment of the same run, as pi-durable's final boundary settles them.
// - A child's `ask_parent` question goes to the parent model as an input; `subagent_reply`
//   answers or escalates it, and a parent run that ends with it still open escalates it. An
//   escalation writes the child's record and a mirror in the parent in one critical section, and
//   an answer to either settles both once. A child's approvals are never routed to the parent.
// - A child's permission mode is the narrower of its own and its parent's, read at each ask, and
//   `configure` refuses a child's widening.
// - Stopping a parent leaves its children working unless the stop says `subagents: "stop"`.
// The pi-durable side builds the same behaviour as its subagents extension; `SubagentFaults` can
// break this one on purpose for the conformance suite's mutation check.

import { Buffer } from "node:buffer";

import { isWiderThan, narrowerMode } from "@cairn/client-logic/EffectiveMode";
import {
  ApprovalId,
  ConversationId,
  EntryId,
  RunId,
  SubmissionId,
  TaskId,
  ThreadId,
} from "@cairn/protocol/Ids";
import type { ProjectId } from "@cairn/protocol/Ids";
import type { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import type { Brief, RuntimeMode, WakeMode } from "@cairn/protocol/Policy";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import {
  MAX_LIVE_CHILDREN,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_RESULT_ENTRY,
} from "@cairn/protocol/Subagents";
import type {
  SettlementOutcome,
  SubagentSettlement,
  SubagentStatus,
} from "@cairn/protocol/Subagents";
import { ThreadOpsItem, ThreadSnapshotItem } from "@cairn/protocol/Thread";
import type { JsonValue } from "@earendil-works/chord";
import { copyJson, isJsonValue } from "@earendil-works/chord";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type {
  ConversationView as PiConversationView,
  EntryRecord,
} from "@earendil-works/pi-durable";
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  PubSub,
  Ref,
  Result,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

import {
  ASK_USER_TOOL,
  askUserResult,
  QUESTION_TTL_MILLIS,
  questionAskOf,
} from "../approvals/AskUser.ts";
import { familyOf } from "../models/ModelFamily.ts";
import {
  attemptStateOf,
  CAP_TEXT,
  canSubmit,
  markOf,
  MAX_RESULT_ATTEMPTS,
  NUDGE_TEXT,
  nudgeDue,
  RESULT_TOOL_NAME,
  ResultToolText,
  validateResult,
} from "../models/ResultTool.ts";
import type { ResultState } from "../models/ResultTool.ts";
import type {
  ApprovalRecord,
  ApprovalSettlement,
  AnswerOutcome,
  JsonRecord,
  RecordAnswer,
} from "./CairnDocs.ts";
import {
  applyAnswer,
  approvalIdOf,
  cancelRecord,
  copyRecord,
  heldByRun,
  refusalText,
  settlementOf,
  UNDECIDED,
} from "./CairnDocs.ts";
import { messageText } from "./CommitFeed.ts";
import {
  CompactionEnded,
  CompactionStarted,
  HarnessError,
  HarnessSeam,
  MessageCommitted,
  QueueChanged,
  RunStarted,
  RunTerminal,
  RuntimeRequestUpdated,
  SubagentUpdated,
  ThreadEnsured,
} from "./HarnessSeam.ts";
import type {
  ApprovalAnswerInput,
  EnsureThread,
  HarnessEvent,
  RunFailureInfo,
  HarnessTurnInput,
  InputEntry,
  LiveThreadState,
  PassiveEntry,
  PassiveNote,
  StopOptions,
  ThreadAgentChange,
  ThreadFrame,
} from "./HarnessSeam.ts";
import type { ThreadPermissions } from "./Permissions.ts";
import { piConversationId, piEntryId, piTaskId } from "./PiIds.ts";
import { classifyRunFailure } from "./RunFailure.ts";
import { SubagentFaults } from "./SubagentFaults.ts";
import {
  BRIEF_ANSWER_ENTRY,
  EscalationWhy,
  NO_RESULT_ERROR,
  renderAnswer,
  renderBrief,
  renderBriefAnswer,
  renderQuestion,
  renderSettlement,
  renderWake,
  SPAWN_WAITING,
  SubagentRequestIds,
  SubagentToolText,
  TYPED_RESULT_SUMMARY,
} from "./SubagentText.ts";
import { entryImages, projectEntry, wireProjector } from "./ThreadWire.ts";

type RunStatus = (typeof RunTerminal.Type)["status"];

/** What the scripted model is asked: the thread and its model context. */
export interface ScriptedRequest {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<Message>;
  /**
   * The subagent tools the thread is offered: a parent's five, or a child's two and
   * `submit_result` when its brief is typed. The scripted harness has no other per-thread tools.
   */
  readonly tools: ReadonlyArray<string>;
}

/** An answer of the scripted model with only text. */
export const scriptedAnswer = (
  text: string,
  timestamp: number
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "scripted",
  provider: "scripted",
  model: "scripted",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp,
});

/** The scripted model: the next answer for a request. Interrupting the request abandons it. */
export class ScriptedModel extends Context.Service<
  ScriptedModel,
  { answer(request: ScriptedRequest): Effect.Effect<AssistantMessage> }
>()("cairn/server/brain/ScriptedModel") {
  /** Repeats the last user message after a short pause: the dev client's backend. */
  static readonly layerEcho = Layer.succeed(
    ScriptedModel,
    ScriptedModel.of({
      answer: (request) =>
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(400));

          const asked = request.messages.findLast(
            (message) => message.role === "user"
          );

          const now = yield* Clock.currentTimeMillis;

          return scriptedAnswer(
            `You said: ${asked === undefined ? "" : messageText(asked)}`,
            now
          );
        }),
    })
  );
}

/** What a scripted tool may ask of the harness. */
export interface ScriptedToolApi {
  /**
   * Records an approval for this call (once; a rerun finds it) and waits for its settlement. With
   * `autoAccept` the record is accepted at once by the thread's permission mode.
   */
  ask(summary: string, autoAccept: boolean): Effect.Effect<ApprovalSettlement>;
  /** The thread's effective permission mode: its own, narrowed by every ancestor's. */
  readonly mode: Effect.Effect<RuntimeMode>;
  /**
   * The thread's permissions now (`cairn.permissions`), read at call time as gated tools do, with
   * the effective mode.
   */
  permissions(): ThreadPermissions;
}

/** The result a scripted tool gives the model. */
export interface ScriptedToolResult {
  readonly text: string;
  readonly isError: boolean;
}

/** The tools a scripted model may call. */
export class ScriptedTools extends Context.Service<
  ScriptedTools,
  {
    run(
      call: ToolCall,
      api: ScriptedToolApi
    ): Effect.Effect<ScriptedToolResult>;
  }
>()("cairn/server/brain/ScriptedTools") {
  /** `echo` returns its `text`; any other tool fails as unknown. */
  static readonly layerEcho = Layer.succeed(
    ScriptedTools,
    ScriptedTools.of({
      run: (call) => {
        const { text } = call.arguments;

        return Effect.succeed(
          call.name === "echo"
            ? { text: Predicate.isString(text) ? text : "", isError: false }
            : { text: `Tool ${call.name} not found`, isError: true }
        );
      },
    })
  );
}

/** A tool's result inside the harness: a terminating result ends the run after its round. */
interface ToolOutcome extends ScriptedToolResult {
  readonly terminate: boolean;
}

interface QueuedInput {
  readonly submissionId: number;
  readonly requestId: string;
  readonly mode: "steer" | "followUp";
  readonly content: ReadonlyArray<TextContent | ImageContent>;
  readonly entry: Option.Option<InputEntry>;
}

/** How the run that took a submission ended; `runId` none when it was withdrawn unplaced. */
interface SubmissionEnd {
  readonly runId: Option.Option<number>;
  /** The thread's last entry when the run's segment ended: the run's end, past which nothing is its. */
  readonly lastEntry: Option.Option<number>;
  readonly status: RunStatus;
  readonly failure: Option.Option<RunFailureInfo>;
}

interface Submission {
  readonly id: number;
  status: "queued" | "placed" | "done" | "unanswered";
  /** The entry it became, once placed. */
  placedAs: Option.Option<number>;
  ended: Option.Option<SubmissionEnd>;
}

/** A note waiting for a running thread's next boundary. */
interface PendingWrite {
  readonly id: number;
  readonly kind: string;
  readonly data: JsonValue;
  readonly text: string;
}

interface Run {
  /** The run's id: the first task id it got. */
  readonly runId: number;
  readonly inputs: Array<number>;
  /**
   * The id its inputs settle under. pi-durable settles a run's inputs with each final answer that
   * places queued inputs and goes on with them (its `answer` ends the run and starts the next in
   * one commit, which Cairn's events show as one run), so a new segment starts there.
   */
  segment: number;
}

interface Agent {
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  cwd: string;
}

/** A child's report, with the run it was made in. */
interface ChildReport {
  readonly runId: number;
  readonly summary: string;
  readonly divergence: string;
  readonly commit: Option.Option<string>;
}

/** A subagent's link to its parent: the `cairn.child` document. */
interface ChildLink {
  readonly key: string;
  readonly parentThreadId: ThreadId;
  readonly rootThreadId: ThreadId;
  readonly depth: number;
  readonly briefApprovalId: string;
  readonly description: string;
  readonly resultSchema: JsonRecord | null;
  report: Option.Option<ChildReport>;
  /** `cairn.result`: the first value `submit_result` accepted, kept for good. */
  result: Option.Option<ResultState>;
}

/** One child in its parent's `cairn.subagents`. */
interface SubagentItem {
  readonly threadId: ThreadId;
  readonly conversationId: number;
  readonly anchorTaskId: number;
  readonly briefApprovalId: string;
  readonly description: string;
  readonly dispatch: JsonRecord;
  readonly isolation: "worktree" | "shared";
  status: SubagentStatus;
  readonly wake: WakeMode;
  readonly settlements: Array<{
    readonly seq: number;
    readonly outcome: SettlementOutcome;
    readonly answerEntry: number | null;
    readonly reportedAt: number;
    /** The request ids of every input the settled run ended. */
    readonly inputs: ReadonlyArray<string>;
  }>;
  delivered: number;
  readonly questions: Map<
    string,
    {
      state: "pending" | "answered" | "escalated" | "cancelled";
      escalatedAt: number | null;
    }
  >;
  readonly inputs: Map<string, number>;
  /**
   * `cairn.subagents`' run marks: each run segment nudged or settled, so a run settles once and a
   * nudged run's inputs are settled by the nudge's run.
   */
  readonly runs: Array<ScriptedRunMark>;
}

/** A question offered to this thread's model, by `<child>:<approvalId>`. */
interface OfferedQuestion {
  readonly child: ThreadId;
  readonly approvalId: string;
  readonly requestId: string;
}

/** One thread as the scripted store keeps it. */
interface ScriptedThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly conversationId: number;
  agent: Agent;
  readonly entries: Array<EntryRecord>;
  /** Index into `entries` where the active range starts (after a compaction). */
  head: number;
  readonly queue: Array<QueuedInput>;
  readonly pendingWrites: Array<PendingWrite>;
  readonly byRequest: Map<string, Submission>;
  /** Request ids of passive entries already written. */
  readonly writes: Set<string>;
  readonly byId: Map<number, Submission>;
  run: Option.Option<Run>;
  readonly approvals: Map<string, ApprovalRecord>;
  /** Tool call id to the task id its approval is keyed by, so a rerun finds its record. */
  readonly toolTasks: Map<string, number>;
  /** `cairn.permissions`: the mode gated tools read at call time, and the tools allowed. */
  permissions: ThreadPermissions;
  usage: { input: number; output: number };
  /** The user stopped the last run, or it failed, and no user input came since. */
  halted: boolean;
  readonly link: Option.Option<ChildLink>;
  /** Briefs this thread proposed, by approval id, as their records froze them. */
  readonly briefs: Map<string, Brief>;
  readonly subagents: Map<string, SubagentItem>;
  readonly escalations: Map<string, JsonRecord>;
  readonly offered: Map<string, OfferedQuestion>;
}

/** One input to a child and the delivery of its result. */
interface Reporter {
  readonly id: number;
  readonly parent: ThreadId;
  readonly child: ThreadId;
  readonly key: string;
  readonly requestId: string;
  readonly content: ReadonlyArray<TextContent | ImageContent>;
  readonly entry: Option.Option<InputEntry>;
  readonly whenBusy: "steer" | "followUp";
  /** A user's own steer to the child: its result is a note with no wake. */
  readonly quiet: boolean;
  /**
   * Whether the run this reporter settled goes without a wake: only when every input that run
   * answered was quiet, so a user's steer and the parent's send settled by one run still wake it.
   */
  quietRun: boolean;
  phase: "deliver" | "nudge" | "report" | "done";
  /** The seq a nudge was sent for, in the `nudge` phase; its nudge mark lists the run's inputs. */
  nudgeSeq: number;
  settlement: Option.Option<SubagentSettlement>;
}

/** The nudge mark `reporter` wrote for its nudge, listing the inputs of the run it nudged. */
const nudgeMarkOf = (item: SubagentItem, reporter: Reporter) =>
  item.runs.findLast(
    (mark): mark is Extract<ScriptedRunMark, { phase: "nudge" }> =>
      mark.phase === "nudge" &&
      mark.seq === reporter.nudgeSeq &&
      mark.inputs.includes(reporter.requestId)
  );

/**
 * One run mark, as `cairn.subagents` keeps it (`RunMark`), keyed by the run's segment: a nudge mark
 * with the nudged run's inputs, or a settled mark whose inputs are its settlement's.
 */
type ScriptedRunMark =
  | {
      readonly run: string;
      readonly phase: "nudge";
      readonly seq: number;
      readonly inputs: ReadonlyArray<string>;
      readonly quiet: boolean;
    }
  | { readonly run: string; readonly phase: "settled"; readonly seq: number };

/** The inputs a run mark names: a nudge mark's own, a settled mark's settlement's. */
const markInputs = (
  item: SubagentItem,
  mark: ScriptedRunMark
): ReadonlyArray<string> =>
  mark.phase === "nudge"
    ? mark.inputs
    : (item.settlements.find((settled) => settled.seq === mark.seq)?.inputs ??
      []);

/**
 * What a live peer reporter of `child` waits on, when the run segment `end` names ended it: its
 * input, or the nudge it sent with that nudge's inputs.
 */
const peerOf = (
  other: Reporter,
  child: ScriptedThread,
  item: SubagentItem,
  end: SubmissionEnd
) => {
  const nudge = other.phase === "nudge" ? nudgeMarkOf(item, other) : undefined;

  const waitsOn =
    nudge === undefined
      ? other.requestId
      : SubagentRequestIds.nudge(child.threadId, other.nudgeSeq);

  const found = child.byRequest.get(waitsOn);

  if (
    found === undefined ||
    (other.phase !== "deliver" && nudge === undefined) ||
    !Option.exists(found.ended, (ended) =>
      Option.exists(end.runId, (runId) => Option.contains(ended.runId, runId))
    )
  ) {
    return Option.none();
  }

  const inputs = [waitsOn];

  if (nudge !== undefined) {
    inputs.push(...nudge.inputs);
  }

  return Option.some({
    inputs,
    quiet: nudge === undefined ? other.quiet : nudge.quiet,
    placedAs: found.placedAs,
  });
};

/** Settles the inputs the run's current segment placed, as the run's end leaves them. */
const settleInputs = (
  thread: ScriptedThread,
  run: Run,
  status: RunStatus,
  failureInfo: Option.Option<RunFailureInfo>
) => {
  for (const id of run.inputs.splice(0)) {
    const submission = thread.byId.get(id);

    if (submission !== undefined) {
      submission.status = status === "completed" ? "done" : "unanswered";
      submission.ended = Option.some({
        runId: Option.some(run.segment),
        lastEntry: Option.fromUndefinedOr(thread.entries.at(-1)?.id),
        status,
        failure: failureInfo,
      });
    }
  }
};

/** Everything a scripted harness remembers; it outlives one instance, as a store does. */
export class ScriptedStore extends Context.Service<
  ScriptedStore,
  {
    readonly threads: Map<ThreadId, ScriptedThread>;
    readonly reporters: Map<number, Reporter>;
    readonly ids: { next: number };
  }
>()("cairn/server/brain/ScriptedStore") {
  static readonly layer = Layer.sync(ScriptedStore, () =>
    ScriptedStore.of({
      threads: new Map(),
      reporters: new Map(),
      ids: { next: 1 },
    })
  );
}

const failure = (
  reason: HarnessError["reason"],
  threadId: ThreadId,
  message: string
) =>
  new HarnessError({
    message,
    reason,
    retryable: false,
    threadId: Option.some(threadId),
  });

/** A day: scripted records never expire on their own. */
const RECORD_TTL_MILLIS = 86_400_000;

/** The two tools a child has instead of a parent's five (subagents note, section 2). */
const CHILD_TOOLS: ReadonlySet<string> = new Set(["ask_parent", "report"]);

/** The parent's five subagent tools. */
const PARENT_TOOLS: ReadonlyArray<string> = [
  "subagent_spawn",
  "subagent_send",
  "subagent_status",
  "subagent_stop",
  "subagent_reply",
];

/** The subagent tools a thread is offered, as a request names them. */
const offeredTools = (thread: ScriptedThread): ReadonlyArray<string> =>
  Option.match(thread.link, {
    onNone: () => PARENT_TOOLS,
    onSome: (link) =>
      link.resultSchema === null
        ? [...CHILD_TOOLS]
        : [...CHILD_TOOLS, RESULT_TOOL_NAME],
  });

/** The most options an `ask_parent` question offers: the protocol's `Question`. */
const MAX_QUESTION_OPTIONS = 9;

/** The longest question or option label: the protocol's `DisplayText`. */
const MAX_QUESTION_LENGTH = 4096;

/** The longest bounded wait `subagent_status` takes, as on pi-durable. */
const MAX_WAIT_SECONDS = 600;

/** A child's thread id, from a store counter: a valid UUIDv7 no other thread uses. */
const childThreadIdOf = (n: number) =>
  ThreadId.make(`0190f0c0-0000-7000-9000-${n.toString(16).padStart(12, "0")}`);

const textArgument = (call: ToolCall, name: string): Option.Option<string> => {
  const value: unknown = call.arguments[name];

  return Predicate.isString(value) && value.trim() !== ""
    ? Option.some(value)
    : Option.none();
};

const isJsonRecord = (value: JsonValue | undefined): value is JsonRecord =>
  Predicate.isObject(value) && !Array.isArray(value);

const queuedItems = (thread: ScriptedThread) => [
  ...thread.queue.map((item): JsonValue => {
    const queued = {
      id: item.submissionId,
      mode: item.mode,
      content: copyJson(item.content),
    };

    return Option.match(item.entry, {
      onNone: () => queued,
      onSome: (entry) => ({
        ...queued,
        entry: { kind: entry.kind, data: entry.data },
      }),
    });
  }),
  ...thread.pendingWrites.map((item): JsonValue => ({
    id: item.id,
    mode: "write",
    content: [{ type: "text", text: item.text }],
    entry: { kind: item.kind, data: item.data },
  })),
];

const approvalItems = (thread: ScriptedThread) => {
  const items: { [key: string]: JsonValue } = {};

  for (const [id, record] of thread.approvals) {
    items[id] = { ...record };
  }

  return items;
};

const subagentItem = (item: SubagentItem): JsonValue => ({
  threadId: item.threadId,
  conversationId: item.conversationId,
  anchorTaskId: item.anchorTaskId,
  briefApprovalId: item.briefApprovalId,
  description: item.description,
  dispatch: item.dispatch,
  isolation: item.isolation,
  worktree: null,
  status: item.status,
  wake: item.wake,
  settlements: item.settlements.map((mark) => ({
    ...mark,
    inputs: [...mark.inputs],
  })),
  runs: item.runs.map((mark) =>
    mark.phase === "nudge" ? { ...mark, inputs: [...mark.inputs] } : { ...mark }
  ),
  delivered: item.delivered,
  questions: Object.fromEntries(
    [...item.questions].map(([id, question]) => [id, { ...question }])
  ),
  inputs: Object.fromEntries(item.inputs),
});

const childDocument = (
  thread: ScriptedThread,
  link: ChildLink,
  parentConversationId: number
): JsonRecord => ({
  key: link.key,
  parentThreadId: link.parentThreadId,
  parentConversationId,
  rootThreadId: link.rootThreadId,
  depth: link.depth,
  briefApprovalId: link.briefApprovalId,
  resultSchema: link.resultSchema,
  attempts: 0,
  report: Option.match(link.report, {
    onNone: () => null,
    onSome: (report) => ({
      summary: report.summary,
      divergence: report.divergence,
      payload: null,
      commit: Option.getOrNull(report.commit),
    }),
  }),
  permissionMode: thread.permissions.mode,
});

/** The thread's view in pi-durable's shape: active entries and the visible documents. */
const viewOf = (
  thread: ScriptedThread,
  parentConversation: Option.Option<number>
): PiConversationView => {
  // The cairn.* documents a thread has, as pi-durable keeps them: only once there is one. A
  // thread's permissions are written when it is created, so they are always there.
  const cairnDocs: Array<readonly [string, JsonRecord]> = [
    [
      "cairn.permissions",
      {
        mode: thread.permissions.mode,
        allow: [...thread.permissions.allow],
      },
    ],
  ];

  if (thread.approvals.size > 0) {
    cairnDocs.push(["cairn.approvals", { items: approvalItems(thread) }]);
  }

  // Written at ensure on pi-durable, so a thread the host ensured has its registry, empty until a
  // child starts; a subagent, which ensure never made, has one only once it starts a child.
  if (Option.isNone(thread.link) || thread.subagents.size > 0) {
    cairnDocs.push([
      "cairn.subagents",
      {
        items: Object.fromEntries(
          [...thread.subagents].map(([key, item]) => [key, subagentItem(item)])
        ),
      },
    ]);
  }

  if (thread.escalations.size > 0) {
    cairnDocs.push([
      "cairn.escalations",
      { items: Object.fromEntries(thread.escalations) },
    ]);
  }

  if (Option.isSome(thread.link) && Option.isSome(parentConversation)) {
    cairnDocs.push([
      "cairn.child",
      childDocument(thread, thread.link.value, parentConversation.value),
    ]);
  }

  const docs = {
    "pi.agent": {
      model: { ...thread.agent.model },
      thinkingLevel: thread.agent.thinkingLevel,
      cwd: thread.agent.cwd,
    },
    "pi.live": Option.match(thread.run, {
      onNone: () => ({}),
      onSome: (run) => ({
        run: { taskId: run.runId, inputs: [...run.inputs] },
      }),
    }),
    "pi.inbox": { items: queuedItems(thread) },
    "pi.usage": {
      models: {
        [`${thread.agent.model.provider}/${thread.agent.model.modelId}`]: {
          input: thread.usage.input,
          output: thread.usage.output,
        },
      },
      tools: {},
    },
    ...Object.fromEntries(cairnDocs),
  };

  return {
    conversation: {
      id: piConversationId(ConversationId.make(thread.conversationId)),
    },
    entries: thread.entries.slice(thread.head),
    docs,
  };
};

/** The model context: the active entries' messages, in order. */
const contextOf = (thread: ScriptedThread): ReadonlyArray<Message> =>
  thread.entries.slice(thread.head).flatMap((entry) => entry.model ?? []);

/** Tool calls of the newest answer that have no result yet. */
const pendingCalls = (thread: ScriptedThread): ReadonlyArray<ToolCall> => {
  const active = thread.entries.slice(thread.head);
  const lastAnswer = active.findLast((entry) => entry.kind === "pi.assistant");
  const message = lastAnswer?.model?.[0];

  if (lastAnswer === undefined || message?.role !== "assistant") {
    return [];
  }

  const answered = new Set(
    active
      .filter(
        (entry) => entry.id > lastAnswer.id && entry.kind === "pi.tool-result"
      )
      .flatMap((entry) => entry.model ?? [])
      .flatMap((result) =>
        result.role === "toolResult" ? [result.toolCallId] : []
      )
  );

  return message.content.flatMap((part) =>
    part.type === "toolCall" && !answered.has(part.id) ? [part] : []
  );
};

/** Whether `entry` lies within `until` (a run's last entry; the whole transcript without one). */
const within = (entry: EntryRecord, until: Option.Option<number>): boolean =>
  !Option.exists(until, (last) => entry.id > last);

/** The newest assistant entry after `after` and up to `until`, with its text. */
const lastAnswerAfter = (
  thread: ScriptedThread,
  after: Option.Option<number>,
  until: Option.Option<number>
): Option.Option<{ readonly id: number; readonly text: string }> => {
  const floor = Option.getOrElse(after, () => 0);

  const found = thread.entries.findLast(
    (entry) =>
      entry.kind === "pi.assistant" && entry.id > floor && within(entry, until)
  );

  const message = found?.model?.[0];

  return found === undefined || message === undefined
    ? Option.none()
    : Option.some({ id: found.id, text: messageText(message) });
};

/** The newest answer of a thread up to `until` that says something; empty for none. */
const lastSpokenIn = (
  thread: ScriptedThread,
  until: Option.Option<number>
): string => {
  for (const entry of thread.entries.toReversed()) {
    if (!within(entry, until)) {
      continue;
    }

    const message = entry.model?.[0];

    const text =
      entry.kind === "pi.assistant" && message !== undefined
        ? messageText(message)
        : "";

    if (text.trim() !== "") {
      return text;
    }
  }

  return "";
};

/**
 * Where the child's accepted result lies against the run from `from` (its first input) to `end`
 * (its last entry), as pi-durable's `resultPlace` says: in it, so its settlement carries it once;
 * before it, delivered with an earlier run; after it, a later run's; or none yet.
 */
const resultPlace = (
  child: ScriptedThread,
  from: Option.Option<number>,
  end: Option.Option<number>,
  accepted: Option.Option<unknown>
): "none" | "before" | "in" | "after" => {
  if (Option.isNone(accepted)) {
    return "none";
  }

  const at = child.entries.find((entry) =>
    Option.contains(markOf(entry), "accepted")
  )?.id;

  if (Option.isNone(from) || at === undefined || at < from.value) {
    return "before";
  }

  return Option.exists(end, (last) => at > last) ? "after" : "in";
};

/**
 * How many answers a thread gave after the entry `after` (its whole transcript without one) and up
 * to `until` (a run's last entry, when given).
 */
const answersAfter = (
  thread: ScriptedThread,
  after: Option.Option<number>,
  until: Option.Option<number> = Option.none()
) => {
  const floor = Option.getOrElse(after, () => 0);

  return thread.entries.filter(
    (entry) =>
      entry.kind === "pi.assistant" && entry.id > floor && within(entry, until)
  ).length;
};

/** Starts the runs a restart interrupted; boot calls it once its subscribers are in place. */
export class ScriptedBoot extends Context.Service<
  ScriptedBoot,
  { readonly resume: Effect.Effect<void> }
>()("cairn/server/brain/ScriptedBoot") {}

const queueChanged = (thread: ScriptedThread) =>
  QueueChanged.make({
    threadId: thread.threadId,
    length: thread.queue.length,
  });

/** What one critical section changed: events to publish, views to refresh, work to start. */
interface Changes {
  readonly events: Array<HarnessEvent>;
  readonly touched: Set<ScriptedThread>;
  readonly runs: Array<ScriptedThread>;
  readonly reporters: Array<Reporter>;
}

const noChanges = (): Changes => ({
  events: [],
  touched: new Set(),
  runs: [],
  reporters: [],
});

/** One input admitted inside the harness: a user's, a reporter's, a wake or a question. */
interface AdmitInput {
  readonly requestId: string;
  readonly content: ReadonlyArray<TextContent | ImageContent>;
  readonly entry: Option.Option<InputEntry>;
  readonly whenBusy: "steer" | "followUp";
}

const textInput = (requestId: string, text: string): AdmitInput => ({
  requestId,
  content: [{ type: "text", text }],
  entry: Option.none(),
  whenBusy: "followUp",
});

/** The brief a `subagent_spawn` call proposes, frozen into its record. */
const briefOf = (
  call: ToolCall,
  description: string,
  task: string,
  mode: RuntimeMode
): Result.Result<Brief, string> => {
  const schema: unknown = call.arguments.result_schema;
  const wake: unknown = call.arguments.wake;
  const isolation: unknown = call.arguments.isolation;

  const resultSchema = isJsonValue(schema) ? copyJson(schema) : null;

  if (schema !== undefined && !isJsonRecord(resultSchema)) {
    return Result.fail(SubagentToolText.resultSchemaNotObject);
  }

  return Result.succeed({
    type: "brief",
    title: description,
    task,
    why: Option.getOrElse(textArgument(call, "why"), () => ""),
    avoid: [],
    doneWhen: [
      { text: "The parent accepts the result.", judge: { kind: "user" } },
    ],
    workspace: isolation === "worktree" ? "worktree" : "shared",
    base: null,
    writes: [],
    role: null,
    model: null,
    thinking: null,
    mode,
    mayCommit: false,
    budget: DEFAULT_BUDGET,
    resultSchema: isJsonRecord(resultSchema) ? resultSchema : null,
    wake: wake === "quiet" ? "quiet" : "answer",
    decisions: [],
  });
};

/** A detached copy of a JSON object a brief holds. */
const copyRecordJson = (value: Schema.JsonObject): JsonRecord => {
  const copied = isJsonValue(value) ? copyJson(value) : null;

  return isJsonRecord(copied) ? copied : {};
};

/** A brief as its record's payload holds it: plain JSON. */
const briefPayload = (brief: Brief): JsonRecord => ({
  type: brief.type,
  title: brief.title,
  task: brief.task,
  why: brief.why,
  avoid: [...brief.avoid],
  doneWhen: brief.doneWhen.map((criterion) => ({
    text: criterion.text,
    judge: { kind: criterion.judge.kind },
  })),
  workspace: brief.workspace,
  base: brief.base,
  writes: [...brief.writes],
  role: brief.role,
  model: brief.model === null ? null : { ...brief.model },
  thinking: brief.thinking,
  mode: brief.mode,
  mayCommit: brief.mayCommit,
  budget: { ...brief.budget, planGuard: null },
  resultSchema:
    brief.resultSchema === null ? null : copyRecordJson(brief.resultSchema),
  wake: brief.wake,
  decisions: [],
});

/** A settlement as a note's `data` holds it. */
const settlementData = (settlement: SubagentSettlement): JsonValue => ({
  subagent: settlement.subagent,
  seq: settlement.seq,
  outcome: settlement.outcome,
  summary: settlement.summary,
  divergence: settlement.divergence,
  payload: copyJson(settlement.payload),
  commit: settlement.commit,
  branch: settlement.branch,
  turns: { ...settlement.turns },
  error: settlement.error,
  usageLimit: settlement.usageLimit,
});

/** An `ask_parent` call's options, when it gave a list of labels. */
const decodeOptions = Schema.decodeUnknownOption(Schema.Array(Schema.String));

/** Marks a submission withdrawn before any run placed it. */
const endUnplaced = (submission: Submission) => {
  submission.status = "unanswered";
  submission.ended = Option.some({
    runId: Option.none(),
    lastEntry: Option.none(),
    status: "interrupted",
    failure: Option.none(),
  });
};

/** Applies an answer to one record in place, with its event; the outcome says if it landed. */
const answerOne = (
  thread: ScriptedThread,
  approvalId: string,
  answer: RecordAnswer,
  at: number,
  changes: Changes
): AnswerOutcome => {
  const record = thread.approvals.get(approvalId);

  if (record === undefined) {
    return "not_found";
  }

  const answered = copyRecord(record);
  const outcome = applyAnswer(answered, answer, at);

  if (outcome === "answered") {
    thread.approvals.set(approvalId, answered);
    changes.touched.add(thread);
    changes.events.push(
      RuntimeRequestUpdated.make({
        threadId: thread.threadId,
        id: ApprovalId.make(approvalId),
        kind: answered.kind,
        status: answered.status,
      })
    );
  }

  return outcome;
};

/** A refused tool call: an error result the model reads. */
const refused = (text: string): ToolOutcome => ({
  text,
  isError: true,
  terminate: false,
});

const said = (text: string): ToolOutcome => ({
  text,
  isError: false,
  terminate: false,
});

/** A refusal naming a subagent this thread does not own. */
const notYours = (call: ToolCall) =>
  refused(
    SubagentToolText.notYours(
      Option.getOrElse(textArgument(call, "subagent"), () => "(none)")
    )
  );

/** Whether any of `items` waits on a question to its parent. */
const asking = (items: ReadonlyArray<SubagentItem>) =>
  items.some((item) =>
    [...item.questions.values()].some(
      (question) => question.state === "pending"
    )
  );

/** `subagent_status`'s text for `items`: one line per child, or the bare word without any. */
const statusText = (items: ReadonlyArray<SubagentItem>) =>
  items.length === 0
    ? SubagentToolText.noSubagents
    : items
        .map((item) =>
          SubagentToolText.statusLine(
            item.threadId,
            item.description,
            item.status,
            asking([item])
          )
        )
        .join("\n");

/** How many settlements `items` have had. */
const settledCount = (items: ReadonlyArray<SubagentItem>) =>
  items.reduce((sum, item) => sum + item.settlements.length, 0);

/**
 * The attempt state of a child, from its transcript's `submit_result` results and nudge: up to
 * `through` when given (a run's last entry, so a later run's result does not count for it).
 */
const attemptStateIn = (
  thread: ScriptedThread,
  through: Option.Option<number> = Option.none()
) =>
  attemptStateOf(
    thread.entries.flatMap((entry) =>
      Option.exists(through, (last) => entry.id > last)
        ? []
        : Option.toArray(markOf(entry))
    )
  );

/** Starts a run's fiber and a reporter's fiber; filled in once the harness defines both. */
interface Starters {
  run: (thread: ScriptedThread) => Effect.Effect<void>;
  reporter: (reporter: Reporter) => Effect.Effect<void>;
}

/** The scripted harness over a store, a model and tools. */
const layerNoDeps = Layer.effectContext(
  Effect.gen(function* () {
    const store = yield* ScriptedStore;
    const model = yield* ScriptedModel;
    const tools = yield* ScriptedTools;
    const faults = yield* SubagentFaults;
    const events = yield* PubSub.unbounded<HarnessEvent>();
    // One mutation at a time, as pi-durable's Session line.
    const line = yield* Semaphore.make(1);

    const revisions = new Map<
      ThreadId,
      SubscriptionRef.SubscriptionRef<PiConversationView>
    >();

    const runs = new Map<ThreadId, Fiber.Fiber<void>>();
    const reporting = new Set<number>();
    const scope = yield* Effect.scope;

    const nextId = () => {
      const id = store.ids.next;

      store.ids.next += 1;

      return id;
    };

    const now = Clock.currentTimeMillis;

    const parentConversationOf = (thread: ScriptedThread) =>
      Option.flatMap(thread.link, (link) =>
        Option.map(
          Option.fromUndefinedOr(store.threads.get(link.parentThreadId)),
          (parent) => parent.conversationId
        )
      );

    const currentView = (thread: ScriptedThread) =>
      viewOf(thread, parentConversationOf(thread));

    const revision = Effect.fn("ScriptedHarness.revision")(function* (
      thread: ScriptedThread
    ) {
      const existing = revisions.get(thread.threadId);

      if (existing !== undefined) {
        return existing;
      }

      const created = yield* SubscriptionRef.make(currentView(thread));

      revisions.set(thread.threadId, created);

      return created;
    });

    const find = (threadId: ThreadId) =>
      Effect.fromNullishOr(store.threads.get(threadId)).pipe(
        Effect.mapError(() =>
          failure(
            "thread_not_found",
            threadId,
            `Thread ${threadId} does not exist in the scripted store. Launch it before sending to it.`
          )
        )
      );

    const appendEntry = (
      thread: ScriptedThread,
      kind: string,
      fields: Omit<EntryRecord, "id" | "conversationId" | "kind">
    ) => {
      const entry: EntryRecord = {
        id: piEntryId(EntryId.make(nextId())),
        conversationId: piConversationId(
          ConversationId.make(thread.conversationId)
        ),
        kind,
        ...fields,
      };

      thread.entries.push(entry);

      return entry;
    };

    /** The child's place in its parent's registry, when both still exist. */
    const linkOf = (child: ScriptedThread) =>
      Option.flatMap(child.link, (link) =>
        Option.flatMap(
          Option.fromUndefinedOr(store.threads.get(link.parentThreadId)),
          (parent) =>
            Option.map(
              Option.fromUndefinedOr(parent.subagents.get(link.key)),
              (item) => ({ link, parent, item })
            )
        )
      );

    /** The thread's mode, narrowed by every ancestor's (ADR 0031). */
    const effectiveMode = (thread: ScriptedThread): RuntimeMode =>
      Option.match(linkOf(thread), {
        onNone: () => thread.permissions.mode,
        onSome: ({ parent }) =>
          narrowerMode(thread.permissions.mode, effectiveMode(parent)),
      });

    const setChildStatus = (
      child: ScriptedThread,
      status: SubagentStatus,
      changes: Changes
    ) => {
      for (const { parent, item } of Option.toArray(linkOf(child))) {
        if (item.status !== status) {
          item.status = status;
          changes.touched.add(parent);
          changes.events.push(
            SubagentUpdated.make({
              threadId: parent.threadId,
              child: child.threadId,
              status,
            })
          );
        }
      }
    };

    /** A child waits while any record of its own is pending, and works again once none is. */
    const recordsChanged = (child: ScriptedThread, changes: Changes) => {
      const pending = [...child.approvals.values()].some(
        (record) => record.status === "pending"
      );

      for (const { item } of Option.toArray(linkOf(child))) {
        if (pending) {
          setChildStatus(child, "waiting", changes);
        } else if (item.status === "waiting") {
          setChildStatus(child, "working", changes);
        }
      }
    };

    /** Places one input as an entry. */
    const place = (
      thread: ScriptedThread,
      input: QueuedInput,
      at: number,
      changes: Changes
    ) => {
      const message: Message = {
        role: "user",
        content: [...input.content],
        timestamp: at,
      };

      const entry = Option.match(input.entry, {
        onNone: () => appendEntry(thread, "pi.user", { model: [message] }),
        onSome: (custom) =>
          appendEntry(thread, custom.kind, {
            model: [message],
            data: custom.data,
          }),
      });

      const submission = thread.byId.get(input.submissionId);

      if (submission !== undefined) {
        submission.status = "placed";
        submission.placedAs = Option.some(entry.id);
      }

      if (Option.isSome(thread.run)) {
        thread.run.value.inputs.push(input.submissionId);
      }

      changes.touched.add(thread);
      changes.events.push(
        MessageCommitted.make({
          threadId: thread.threadId,
          entryId: EntryId.make(entry.id),
          role: "user",
          text: messageText(message),
          at: DateTime.makeUnsafe(at),
        })
      );
    };

    /** Places the notes a running thread queued: writes go first at every boundary. */
    const placeWrites = (
      thread: ScriptedThread,
      at: number,
      changes: Changes
    ) => {
      for (const write of thread.pendingWrites.splice(0)) {
        appendEntry(thread, write.kind, {
          model: [
            {
              role: "user",
              content: [{ type: "text", text: write.text }],
              timestamp: at,
            },
          ],
          data: write.data,
        });
        changes.touched.add(thread);
      }
    };

    /** Writes a note once per request id: at once when idle, at the next boundary when running. */
    const writeNote = (
      thread: ScriptedThread,
      note: {
        readonly requestId: string;
        readonly kind: string;
        readonly data: JsonValue;
        readonly text: string;
      },
      at: number,
      changes: Changes
    ) => {
      if (thread.writes.has(note.requestId)) {
        return;
      }

      thread.writes.add(note.requestId);
      changes.touched.add(thread);

      if (Option.isSome(thread.run)) {
        thread.pendingWrites.push({ id: nextId(), ...note });

        return;
      }

      appendEntry(thread, note.kind, {
        model: [
          {
            role: "user",
            content: [{ type: "text", text: note.text }],
            timestamp: at,
          },
        ],
        data: note.data,
      });
    };

    /** Admits one input, idempotent by request id; an idle thread starts a run with it. */
    const admit = (
      thread: ScriptedThread,
      input: AdmitInput,
      at: number,
      changes: Changes
    ): Submission => {
      const existing = thread.byRequest.get(input.requestId);

      if (existing !== undefined) {
        return existing;
      }

      const submission: Submission = {
        id: nextId(),
        status: "queued",
        placedAs: Option.none(),
        ended: Option.none(),
      };

      thread.byRequest.set(input.requestId, submission);
      thread.byId.set(submission.id, submission);
      thread.queue.push({
        submissionId: submission.id,
        requestId: input.requestId,
        mode: input.whenBusy,
        content: input.content,
        entry: input.entry,
      });
      changes.touched.add(thread);

      if (Option.isSome(thread.run)) {
        changes.events.push(queueChanged(thread));

        return submission;
      }

      // Idle: a run starts and takes the oldest queued input first (a failed run left them).
      const [first] = thread.queue.splice(0, 1);
      const runId = nextId();

      thread.run = Option.some({ runId, inputs: [], segment: runId });
      changes.events.push(
        RunStarted.make({
          threadId: thread.threadId,
          runId: RunId.make(runId),
          at: DateTime.makeUnsafe(at),
        })
      );

      if (first !== undefined) {
        place(thread, first, at, changes);
        changes.events.push(queueChanged(thread));
      }

      changes.runs.push(thread);

      return submission;
    };

    /**
     * Escalates a child's question to the user (ADR 0027): the child's record turns to the user and
     * a mirror lands in the parent, both in this critical section, so no half state exists.
     */
    const escalate = (
      parent: ScriptedThread,
      child: ScriptedThread,
      approvalId: string,
      why: string,
      at: number,
      changes: Changes
    ) => {
      const record = child.approvals.get(approvalId);

      if (
        record === undefined ||
        record.status !== "pending" ||
        record.escalatedAt !== null
      ) {
        return;
      }

      const turned = copyRecord(record);

      turned.route = "user";
      turned.escalatedAt = at;
      child.approvals.set(approvalId, turned);

      const mirror: ApprovalRecord = {
        ...copyRecord(turned),
        id: `esc-${child.conversationId}-${approvalId}`,
        toolTaskId: 0,
        askedAt: at,
        escalatedAt: null,
        mirrorOf: { threadId: child.threadId, approvalId },
      };

      parent.approvals.set(mirror.id, mirror);
      parent.escalations.set(approvalId, {
        childThreadId: child.threadId,
        kind: record.kind,
        payload: record.payload,
        askedAt: record.askedAt,
        escalatedAt: at,
        why,
        status: "open",
      });
      parent.offered.delete(`${child.threadId}:${approvalId}`);

      for (const { item } of Option.toArray(linkOf(child))) {
        item.questions.set(approvalId, { state: "escalated", escalatedAt: at });
      }

      changes.touched.add(parent);
      changes.touched.add(child);
      changes.events.push(
        RuntimeRequestUpdated.make({
          threadId: parent.threadId,
          id: ApprovalId.make(mirror.id),
          kind: mirror.kind,
          status: mirror.status,
        })
      );
    };

    /**
     * A parent run that ends with a question it was shown still open escalates it. A halted parent
     * (stopped or failed) also escalates the questions still queued for it, withdrawn from its
     * queue first, since no run will place them until the user writes again (ADR 0027).
     */
    const escalateUnanswered = (
      parent: ScriptedThread,
      at: number,
      changes: Changes
    ) => {
      for (const offered of parent.offered.values()) {
        const shown = parent.byRequest.get(offered.requestId);
        const child = store.threads.get(offered.child);

        if (shown === undefined || child === undefined) {
          continue;
        }

        const queued = shown.status === "queued";

        if (queued && parent.halted) {
          const index = parent.queue.findIndex(
            (item) => item.requestId === offered.requestId
          );

          if (index !== -1) {
            parent.queue.splice(index, 1);
            changes.events.push(queueChanged(parent));
          }

          endUnplaced(shown);
        }

        if (!queued || parent.halted) {
          escalate(
            parent,
            child,
            offered.approvalId,
            EscalationWhy.parentRunEnded,
            at,
            changes
          );
        }
      }
    };

    /** Ends the run, settling its inputs, placing its notes and escalating what it left open. */
    const endRun = (
      thread: ScriptedThread,
      status: RunStatus,
      failureInfo: Option.Option<RunFailureInfo>,
      at: number,
      changes: Changes
    ) => {
      if (Option.isNone(thread.run)) {
        return;
      }

      const run = thread.run.value;

      settleInputs(thread, run, status, failureInfo);

      thread.run = Option.none();
      thread.halted = status !== "completed";
      changes.touched.add(thread);
      changes.events.push(
        RunTerminal.make({
          threadId: thread.threadId,
          runId: RunId.make(run.runId),
          status,
          failure: failureInfo,
          at: DateTime.makeUnsafe(at),
        })
      );
      placeWrites(thread, at, changes);
      escalateUnanswered(thread, at, changes);
    };

    /**
     * At a final answer: notes first, then the next queued input (a steer first) or the end. Either
     * way the inputs placed so far settle with this answer, as pi-durable's final boundary settles
     * them (a new segment of the run takes the next input).
     */
    const continueOrEnd = (
      thread: ScriptedThread,
      at: number,
      changes: Changes
    ) => {
      placeWrites(thread, at, changes);

      const nextIndex = Math.max(
        thread.queue.findIndex((item) => item.mode === "steer"),
        0
      );

      const [next] =
        thread.queue.length > 0 ? thread.queue.splice(nextIndex, 1) : [];

      if (next === undefined || Option.isNone(thread.run)) {
        endRun(thread, "completed", Option.none(), at, changes);

        return;
      }

      const run = thread.run.value;

      settleInputs(thread, run, "completed", Option.none());
      run.segment = nextId();
      changes.touched.add(thread);
      place(thread, next, at, changes);
      changes.events.push(queueChanged(thread));
    };

    /** Offers a child's pending record to its parent's model as an input. */
    const offerToParent = (
      child: ScriptedThread,
      record: ApprovalRecord,
      at: number,
      changes: Changes
    ) => {
      for (const { parent, item, link } of Option.toArray(linkOf(child))) {
        item.questions.set(record.id, { state: "pending", escalatedAt: null });
        changes.touched.add(parent);

        if (parent.halted && !faults.wakeStoppedParent) {
          escalate(
            parent,
            child,
            record.id,
            EscalationWhy.parentStopped,
            at,
            changes
          );
          continue;
        }

        const requestId = SubagentRequestIds.question(
          child.threadId,
          record.id
        );

        parent.offered.set(`${child.threadId}:${record.id}`, {
          child: child.threadId,
          approvalId: record.id,
          requestId,
        });
        admit(
          parent,
          textInput(
            requestId,
            renderQuestion(link.description, record.summary)
          ),
          at,
          changes
        );
      }
    };

    /** After a child's record settled: its question is answered and the child works again. */
    const questionSettled = (
      child: ScriptedThread,
      approvalId: string,
      changes: Changes
    ) => {
      for (const { parent, item } of Option.toArray(linkOf(child))) {
        if (item.questions.has(approvalId)) {
          item.questions.set(approvalId, {
            state: "answered",
            escalatedAt: item.questions.get(approvalId)?.escalatedAt ?? null,
          });
        }

        parent.offered.delete(`${child.threadId}:${approvalId}`);

        const escalation = parent.escalations.get(approvalId);

        if (escalation !== undefined) {
          parent.escalations.set(approvalId, {
            ...escalation,
            status: "resolved",
          });
        }

        changes.touched.add(parent);
      }

      recordsChanged(child, changes);
    };

    const freshThread = (
      threadId: ThreadId,
      projectId: ProjectId,
      agent: Agent,
      mode: RuntimeMode
    ): ScriptedThread => ({
      threadId,
      projectId,
      conversationId: nextId(),
      agent,
      entries: [],
      head: 0,
      queue: [],
      pendingWrites: [],
      byRequest: new Map(),
      writes: new Set(),
      byId: new Map(),
      run: Option.none(),
      approvals: new Map(),
      toolTasks: new Map(),
      usage: { input: 0, output: 0 },
      permissions: { mode, allow: [] },
      halted: false,
      link: Option.none(),
      briefs: new Map(),
      subagents: new Map(),
      escalations: new Map(),
      offered: new Map(),
    });

    /** Records a reporter for one input to a child; the commit starts its fiber. */
    const newReporter = (
      parent: ScriptedThread,
      child: ScriptedThread,
      item: SubagentItem,
      input: AdmitInput,
      quiet: boolean,
      changes: Changes
    ) => {
      const reporter: Reporter = {
        id: nextId(),
        parent: parent.threadId,
        child: child.threadId,
        key: item.briefApprovalId,
        requestId: input.requestId,
        content: input.content,
        entry: input.entry,
        whenBusy: input.whenBusy,
        quiet,
        quietRun: quiet,
        phase: "deliver",
        nudgeSeq: 0,
        settlement: Option.none(),
      };

      store.reporters.set(reporter.id, reporter);
      item.inputs.set(input.requestId, reporter.id);
      changes.reporters.push(reporter);
      changes.touched.add(parent);
      setChildStatus(child, "working", changes);
    };

    /** Starts a brief's child once, in the critical section that accepted it (ADR 0030). */
    const startChild = (
      parent: ScriptedThread,
      record: ApprovalRecord,
      brief: Brief,
      at: number,
      changes: Changes
    ) => {
      if (record.started !== null) {
        return;
      }

      const childThreadId = childThreadIdOf(nextId());

      const depth = Option.match(parent.link, {
        onNone: () => 1,
        onSome: (link) => link.depth + 1,
      });

      const child: ScriptedThread = {
        ...freshThread(
          childThreadId,
          parent.projectId,
          { ...parent.agent },
          brief.mode
        ),
        link: Option.some({
          key: record.id,
          parentThreadId: parent.threadId,
          rootThreadId: Option.match(parent.link, {
            onNone: () => parent.threadId,
            onSome: (link) => link.rootThreadId,
          }),
          depth,
          briefApprovalId: record.id,
          description: brief.title,
          resultSchema:
            brief.resultSchema === null
              ? null
              : copyRecordJson(brief.resultSchema),
          report: Option.none(),
          result: Option.none(),
        }),
      };

      store.threads.set(childThreadId, child);

      const spec = `${parent.agent.model.provider}/${parent.agent.model.modelId}`;

      const item: SubagentItem = {
        threadId: childThreadId,
        conversationId: child.conversationId,
        anchorTaskId: nextId(),
        briefApprovalId: record.id,
        description: brief.title,
        dispatch: {
          spec: null,
          resolved: {
            spec,
            role: null,
            model: { ...parent.agent.model },
            thinkingLevel: parent.agent.thinkingLevel,
            via: "literal",
            skipped: [],
            family: familyOf(parent.agent.model),
            priced: false,
          },
          previewed: null,
          dispatchedAt: at,
        },
        isolation: brief.workspace,
        status: "working",
        wake: brief.wake,
        settlements: [],
        delivered: 0,
        questions: new Map(),
        inputs: new Map(),
        runs: [],
      };

      parent.subagents.set(record.id, item);
      record.started = { childThreadId };
      changes.touched.add(parent);
      changes.touched.add(child);
      changes.events.push(
        ThreadEnsured.make({
          threadId: childThreadId,
          conversationId: ConversationId.make(child.conversationId),
          parent: Option.some(parent.threadId),
        }),
        SubagentUpdated.make({
          threadId: parent.threadId,
          child: childThreadId,
          status: "working",
        })
      );
      newReporter(
        parent,
        child,
        item,
        {
          requestId: SubagentRequestIds.brief(record.id),
          content: [{ type: "text", text: renderBrief(brief) }],
          entry: Option.none(),
          whenBusy: "followUp",
        },
        false,
        changes
      );
      writeNote(
        parent,
        {
          requestId: SubagentRequestIds.briefAnswer(record.id),
          kind: BRIEF_ANSWER_ENTRY,
          data: {
            briefId: record.id,
            decision: "accept",
            started: true,
            childThreadId,
          },
          text: renderBriefAnswer(brief.title, { kind: "go", childThreadId }),
        },
        at,
        changes
      );
    };

    /** A brief's answer: Go starts its child; Decline and Send back tell the parent. */
    const briefAnswered = (
      parent: ScriptedThread,
      record: ApprovalRecord,
      at: number,
      changes: Changes
    ) => {
      const brief = parent.briefs.get(record.id);

      if (brief === undefined) {
        return;
      }

      if (record.status === "accepted") {
        startChild(parent, record, brief, at, changes);

        return;
      }

      const reason = Option.fromNullOr(record.reason);

      const text = renderBriefAnswer(brief.title, {
        kind: record.status === "revised" ? "revised" : "declined",
        reason,
      });

      const requestId = SubagentRequestIds.briefAnswer(record.id);

      if (parent.halted) {
        writeNote(
          parent,
          {
            requestId,
            kind: BRIEF_ANSWER_ENTRY,
            data: {
              briefId: record.id,
              decision: record.status,
              started: false,
            },
            text,
          },
          at,
          changes
        );

        return;
      }

      admit(parent, textInput(requestId, text), at, changes);
    };

    /**
     * Answers one record and everything linked to it, in the caller's critical section: an
     * escalated question and its mirror settle together, a child's question frees the child, and a
     * brief's answer starts or refuses its child.
     */
    const answerRecord = (
      thread: ScriptedThread,
      approvalId: string,
      given: RecordAnswer,
      at: number,
      changes: Changes
    ): AnswerOutcome => {
      const outcome = answerOne(thread, approvalId, given, at, changes);

      if (outcome !== "answered") {
        return outcome;
      }

      const record = thread.approvals.get(approvalId);

      if (record === undefined) {
        return outcome;
      }

      if (record.mirrorOf !== null) {
        const child = store.threads.get(
          ThreadId.make(record.mirrorOf.threadId)
        );

        if (child !== undefined) {
          answerOne(child, record.mirrorOf.approvalId, given, at, changes);
          questionSettled(child, record.mirrorOf.approvalId, changes);
        }
      } else if (Option.isSome(thread.link)) {
        for (const { parent } of Option.toArray(linkOf(thread))) {
          for (const mirror of parent.approvals.values()) {
            if (
              mirror.mirrorOf?.threadId === thread.threadId &&
              mirror.mirrorOf.approvalId === approvalId
            ) {
              answerOne(parent, mirror.id, given, at, changes);
            }
          }
        }

        questionSettled(thread, approvalId, changes);
      }

      if (record.kind === "brief") {
        briefAnswered(thread, record, at, changes);
      }

      return outcome;
    };

    /**
     * Marks a child settled unless it still works: a run of its own, or a reporter whose input it
     * has not admitted yet. A new input that started a run before an earlier settle landed keeps
     * the child working.
     */
    const settledUnlessWorking = (child: ScriptedThread, changes: Changes) => {
      // A reporter in its nudge phase whose nudge is not admitted yet still works too.
      const undelivered = [...store.reporters.values()].some(
        (reporter) =>
          reporter.child === child.threadId &&
          ((reporter.phase === "deliver" &&
            !child.byRequest.has(reporter.requestId)) ||
            (reporter.phase === "nudge" &&
              !child.byRequest.has(
                SubagentRequestIds.nudge(child.threadId, reporter.nudgeSeq)
              )))
      );

      if (Option.isNone(child.run) && !undelivered) {
        setChildStatus(child, "settled", changes);
      }
    };

    /**
     * Every input the run segment that ended `submission` (`current`, the input or nudge `reporter`
     * waited on) ended: with the nudged run's inputs when it waited on a nudge, and each live peer
     * whose own submission (its input, or the nudge it sent, with that nudge's inputs) the same
     * segment ended, answered or not. `quiet` when all were; `from` is the earliest placed.
     */
    const runInputsOf = (
      reporter: Reporter,
      child: ScriptedThread,
      item: SubagentItem,
      current: string,
      submission: Submission,
      end: SubmissionEnd
    ) => {
      const own =
        reporter.phase === "nudge" ? nudgeMarkOf(item, reporter) : undefined;

      const inputs = [current];
      let quiet = own === undefined ? reporter.quiet : own.quiet;
      const placed = [...Option.toArray(submission.placedAs)];

      const add = (requestIds: ReadonlyArray<string>) => {
        for (const requestId of requestIds) {
          if (!inputs.includes(requestId)) {
            inputs.push(requestId);
          }
        }
      };

      add(own?.inputs ?? []);

      for (const other of store.reporters.values()) {
        const peer =
          other.child === child.threadId && other.id !== reporter.id
            ? peerOf(other, child, item, end)
            : Option.none();

        if (Option.isSome(peer)) {
          add(peer.value.inputs);
          quiet &&= peer.value.quiet;
          placed.push(...Option.toArray(peer.value.placedAs));
        }
      }

      return {
        inputs,
        quiet,
        from:
          placed.length === 0
            ? Option.none<number>()
            : Option.some(Math.min(...placed)),
      };
    };

    /** Settles one reporter's input once its run ended: one settlement per run. */
    const settle = (
      reporter: Reporter,
      submission: Submission,
      end: SubmissionEnd,
      at: number,
      changes: Changes
    ) => {
      const child = store.threads.get(reporter.child);
      const linked = Option.flatMap(Option.fromUndefinedOr(child), linkOf);

      if (child === undefined || Option.isNone(linked)) {
        reporter.phase = "done";

        return;
      }

      const { link, parent, item } = linked.value;

      // The run's key: its segment, or the submission alone when it ran in no run.
      const key = Option.match(end.runId, {
        onNone: () => `input:${submission.id}`,
        onSome: (runId) => `seg:${runId}`,
      });

      const current =
        reporter.phase === "nudge"
          ? SubagentRequestIds.nudge(child.threadId, reporter.nudgeSeq)
          : reporter.requestId;

      // A run settles once: whichever of its reporters gets here first marks it. A nudge mark names
      // the inputs whose run its nudge's run settles; the nudge's reporter settles the child then.
      const marked = item.runs.filter(
        (mark) => mark.run === key || markInputs(item, mark).includes(current)
      );

      if (marked.length > 0) {
        reporter.phase = "done";

        if (marked.some((mark) => mark.phase === "settled")) {
          settledUnlessWorking(child, changes);
        }

        return;
      }

      const run = runInputsOf(reporter, child, item, current, submission, end);
      const { inputs, quiet } = run;

      reporter.quietRun = quiet;

      // The report of the run being settled: a settlement spends it, so the next run has none.
      const { report } = link;

      // The run's own entries only, up to its end, as pi-durable reads them: a reporter that settles
      // late never takes a later run's words or turns.
      const answered = lastAnswerAfter(
        child,
        submission.placedAs,
        end.lastEntry
      );

      const seq = item.settlements.length + 1;
      const where = resultPlace(child, run.from, end.lastEntry, link.result);

      // A typed child whose run completed without a result, and none before it: nudged once while
      // its attempts up to the run's end allow (the nudge's run settles the run's inputs), failed
      // otherwise.
      const missing =
        link.resultSchema !== null &&
        end.status === "completed" &&
        (where === "none" || where === "after")
          ? Option.some(attemptStateIn(child, end.lastEntry))
          : Option.none();

      if (Option.isSome(missing) && nudgeDue(missing.value)) {
        item.runs.push({ run: key, phase: "nudge", seq, inputs, quiet });
        reporter.nudgeSeq = seq;
        reporter.phase = "nudge";

        return;
      }

      const noResult = Option.map(missing, (state) =>
        state.used >= MAX_RESULT_ATTEMPTS ? CAP_TEXT : NO_RESULT_ERROR
      );

      let outcome: SettlementOutcome = "completed";

      if (end.status === "interrupted") {
        outcome = "stopped";
      } else if (end.status === "failed" || Option.isSome(noResult)) {
        outcome = "failed";
      }

      const failureMessage = Option.orElse(noResult, () =>
        end.status === "failed"
          ? Option.some("The child's run failed before it answered.")
          : Option.none()
      );

      // A typed result goes to the parent once: with the run that accepted it.
      const result = where === "in" ? link.result : Option.none();

      const worded = Option.match(report, {
        onNone: () =>
          Option.match(answered, {
            onNone: () => "",
            onSome: (found) => found.text,
          }),
        onSome: (found) => found.summary,
      });

      // A typed result's summary when the run ended on `submit_result` with no words of its own.
      const spoken = lastSpokenIn(child, end.lastEntry);
      const typedSummary = spoken.trim() === "" ? TYPED_RESULT_SUMMARY : spoken;

      const settlement: SubagentSettlement = {
        subagent: child.threadId,
        seq,
        outcome,
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
        commit: Option.getOrNull(
          Option.flatMap(report, (found) => found.commit)
        ),
        branch: null,
        turns: {
          thisRun: answersAfter(child, submission.placedAs, end.lastEntry),
          total: answersAfter(child, Option.none()),
        },
        error:
          outcome === "failed"
            ? Option.getOrElse(failureMessage, () => "The child failed.")
            : null,
        usageLimit: Option.exists(
          end.failure,
          (info) => info.class === "usage_limit"
        ),
      };

      item.settlements.push({
        seq: settlement.seq,
        outcome,
        answerEntry: Option.getOrNull(
          Option.map(answered, (found) => found.id)
        ),
        reportedAt: at,
        inputs,
      });
      item.runs.push({ run: key, phase: "settled", seq });
      link.report = Option.none();
      reporter.settlement = Option.some(settlement);
      reporter.phase = "report";
      changes.touched.add(parent);
      settledUnlessWorking(child, changes);
    };

    /** Writes a settlement's note and, by the parent's state, its wake (ADR 0028). */
    const report = (reporter: Reporter, at: number, changes: Changes) => {
      const parent = store.threads.get(reporter.parent);
      const child = store.threads.get(reporter.child);

      const found = Option.flatMap(Option.fromUndefinedOr(child), linkOf);

      if (
        parent === undefined ||
        Option.isNone(found) ||
        Option.isNone(reporter.settlement)
      ) {
        reporter.phase = "done";

        return;
      }

      const settlement = reporter.settlement.value;
      const { item, link } = found.value;

      const deliver = (ids: {
        readonly note: string;
        readonly wake: string;
      }) => {
        if (!faults.dropNote) {
          writeNote(
            parent,
            {
              requestId: ids.note,
              kind: SUBAGENT_RESULT_ENTRY,
              data: settlementData(settlement),
              text: renderSettlement(link.description, settlement),
            },
            at,
            changes
          );
        }

        const wakes =
          !reporter.quietRun &&
          item.wake === "answer" &&
          !settlement.usageLimit &&
          (faults.wakeStoppedParent || !parent.halted);

        const queuedWake = parent.queue.some((queued) =>
          queued.requestId.startsWith("subagent-wake-")
        );

        if (wakes && !queuedWake) {
          admit(
            parent,
            textInput(ids.wake, renderWake(link.description)),
            at,
            changes
          );
        }
      };

      const ids = {
        note: SubagentRequestIds.note(reporter.child, settlement.seq),
        wake: SubagentRequestIds.wake(reporter.child, settlement.seq),
      };

      if (faults.deliverTwice) {
        // A reporter that mints its ids per attempt: every rerun lands again.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const fresh = nextId();

          deliver({
            note: `${ids.note}-${fresh}`,
            wake: `${ids.wake}-${fresh}`,
          });
        }
      } else {
        deliver(ids);
      }

      item.delivered = Math.max(item.delivered, settlement.seq);
      reporter.phase = "done";
      changes.touched.add(parent);
    };

    // The run loop and the reporters commit through `commit`, which starts runs and reporters:
    // the starters are filled in once both are defined, before any commit can run.
    const starters: Starters = {
      run: () => Effect.void,
      reporter: () => Effect.void,
    };

    /** Publishes what one critical section changed and starts the work it created. */
    const commit = Effect.fn("ScriptedHarness.commit")(function* (
      changes: Changes
    ) {
      for (const thread of changes.touched) {
        const ref = yield* revision(thread);

        yield* SubscriptionRef.set(ref, currentView(thread));
      }

      yield* PubSub.publishAll(events, changes.events);

      for (const thread of changes.runs) {
        yield* starters.run(thread);
      }

      for (const reporter of changes.reporters) {
        yield* starters.reporter(reporter);
      }
    });

    /** Runs `change` in the line and commits what it changed. */
    const locked = <A, E>(
      change: (at: number, changes: Changes) => Effect.Effect<A, E>
    ) =>
      line.withPermits(1)(
        Effect.gen(function* () {
          const changes = noChanges();
          const value = yield* change(yield* now, changes);

          yield* commit(changes);

          return value;
        })
      );

    /** Waits until `ready` holds for the thread's view, rechecking at every change. */
    const awaitThread = <A>(
      thread: ScriptedThread,
      ready: () => Option.Option<A>
    ) =>
      Effect.gen(function* () {
        const ref = yield* revision(thread);

        return yield* SubscriptionRef.changes(ref).pipe(
          Stream.map(ready),
          Stream.filter(Option.isSome),
          Stream.map((found) => found.value),
          Stream.runHead
        );
      });

    /** One reporter, from wherever it stood: deliver, then report. */
    const runReporter = (reporter: Reporter): Effect.Effect<void> =>
      Effect.gen(function* () {
        const child = store.threads.get(reporter.child);

        if (child === undefined) {
          return;
        }

        if (reporter.phase === "deliver") {
          const submission = yield* locked((at, changes) =>
            Effect.sync(() => admit(child, reporter, at, changes))
          );

          const end = yield* awaitThread(child, () => submission.ended);

          yield* locked((at, changes) =>
            Effect.sync(() => {
              for (const found of Option.toArray(end)) {
                settle(reporter, submission, found, at, changes);
              }
            })
          );
        }

        // A typed child that ended without a result: its one nudge, and the run that answers it.
        if (reporter.phase === "nudge") {
          const submission = yield* locked((at, changes) =>
            Effect.sync(() =>
              admit(
                child,
                {
                  requestId: SubagentRequestIds.nudge(
                    child.threadId,
                    reporter.nudgeSeq
                  ),
                  content: [{ type: "text", text: NUDGE_TEXT }],
                  entry: Option.none(),
                  whenBusy: "followUp",
                },
                at,
                changes
              )
            )
          );

          const end = yield* awaitThread(child, () => submission.ended);

          yield* locked((at, changes) =>
            Effect.sync(() => {
              for (const found of Option.toArray(end)) {
                settle(reporter, submission, found, at, changes);
              }
            })
          );
        }

        if (reporter.phase === "report") {
          yield* locked((at, changes) =>
            Effect.sync(() => {
              report(reporter, at, changes);
            })
          );
        }
      });

    const startReporter = (reporter: Reporter) =>
      Effect.gen(function* () {
        if (reporting.has(reporter.id) || reporter.phase === "done") {
          return;
        }

        reporting.add(reporter.id);
        yield* runReporter(reporter).pipe(
          Effect.ensuring(Effect.sync(() => reporting.delete(reporter.id))),
          Effect.forkIn(scope)
        );
      });

    const taskOf = (thread: ScriptedThread, call: ToolCall) => {
      const existing = thread.toolTasks.get(call.id);

      if (existing !== undefined) {
        return existing;
      }

      const id = nextId();

      thread.toolTasks.set(call.id, id);

      return id;
    };

    /** Waits until a record leaves `pending`; none when the instance closes first. */
    const settledRecord = (thread: ScriptedThread, approvalId: string) =>
      awaitThread(thread, () =>
        Option.filter(
          Option.fromUndefinedOr(thread.approvals.get(approvalId)),
          (record) => record.status !== "pending"
        )
      );

    const toolApi = (
      thread: ScriptedThread,
      call: ToolCall
    ): ScriptedToolApi => ({
      mode: Effect.sync(() => effectiveMode(thread)),
      permissions: () => ({
        mode: effectiveMode(thread),
        allow: thread.permissions.allow,
      }),
      ask: (summary, autoAccept) =>
        Effect.gen(function* () {
          const taskId = taskOf(thread, call);
          const approvalId = approvalIdOf(taskId);

          yield* locked((askedAt, changes) =>
            Effect.sync(() => {
              if (thread.approvals.has(approvalId)) {
                return;
              }

              const mode = effectiveMode(thread);

              const record: ApprovalRecord = {
                id: approvalId,
                toolTaskId: taskId,
                tool: call.name,
                kind: "tool-call",
                summary,
                status: autoAccept ? "accepted" : "pending",
                askedAt,
                expiresAt: askedAt + RECORD_TTL_MILLIS,
                answeredAt: autoAccept ? askedAt : null,
                run: null,
                executorRequestId: null,
                ...UNDECIDED,
                answer: autoAccept
                  ? {
                      decision: "accept",
                      answers: null,
                      note: null,
                      launch: null,
                    }
                  : null,
                decidedBy: autoAccept ? { kind: "mode", mode } : null,
              };

              thread.approvals.set(approvalId, record);
              changes.touched.add(thread);
              changes.events.push(
                RuntimeRequestUpdated.make({
                  threadId: thread.threadId,
                  id: ApprovalId.make(approvalId),
                  kind: "tool-call",
                  status: record.status,
                })
              );

              if (!autoAccept) {
                recordsChanged(thread, changes);

                // Approvals are the user's (ADR 0027); this fault offers them to the parent.
                if (faults.routeApprovalToParent) {
                  offerToParent(thread, record, askedAt, changes);
                }
              }
            })
          );

          const settled = yield* settledRecord(thread, approvalId);

          return Option.match(settled, {
            onNone: (): ApprovalSettlement => ({
              status: "cancelled",
              decidedBy: Option.none(),
              reason: Option.none(),
            }),
            onSome: settlementOf,
          });
        }),
    });

    /** `subagent_spawn`: records the brief and returns at once; Go starts the child. */
    const spawnTool = (thread: ScriptedThread, call: ToolCall) =>
      locked((askedAt, changes) =>
        Effect.sync((): ToolOutcome => {
          const description = textArgument(call, "description");
          const task = textArgument(call, "brief");

          if (Option.isNone(description) || Option.isNone(task)) {
            return refused(SubagentToolText.spawnNeedsBrief);
          }

          for (const link of Option.toArray(thread.link)) {
            if (link.depth >= MAX_SUBAGENT_DEPTH) {
              return refused(SubagentToolText.depthReached(link.depth));
            }
          }

          const briefId = `brief-${taskOf(thread, call)}`;

          // A replayed call finds its brief before the cap, which may have filled since.
          if (thread.approvals.has(briefId)) {
            return said(SPAWN_WAITING);
          }

          // Briefs still waiting for Go count too: Go starts each without asking again.
          const proposed = [...thread.approvals.values()].filter(
            (record) => record.kind === "brief" && record.status === "pending"
          ).length;

          const live =
            [...thread.subagents.values()].filter(
              (item) => item.status !== "settled"
            ).length + proposed;

          if (live >= MAX_LIVE_CHILDREN) {
            return refused(SubagentToolText.capReached(live));
          }

          const brief = briefOf(
            call,
            description.value,
            task.value,
            effectiveMode(thread)
          );

          if (Result.isFailure(brief)) {
            return refused(brief.failure);
          }

          thread.briefs.set(briefId, brief.success);
          thread.approvals.set(briefId, {
            id: briefId,
            toolTaskId: taskOf(thread, call),
            tool: call.name,
            kind: "brief",
            summary: description.value,
            status: "pending",
            askedAt,
            expiresAt: askedAt + RECORD_TTL_MILLIS,
            answeredAt: null,
            run: null,
            executorRequestId: null,
            ...UNDECIDED,
            payload: briefPayload(brief.success),
          });
          changes.touched.add(thread);
          changes.events.push(
            RuntimeRequestUpdated.make({
              threadId: thread.threadId,
              id: ApprovalId.make(briefId),
              kind: "brief",
              status: "pending",
            })
          );

          return said(SPAWN_WAITING);
        })
      );

    /** The child a parent's tool names, by its thread id. */
    const childNamed = (thread: ScriptedThread, call: ToolCall) =>
      Option.flatMap(textArgument(call, "subagent"), (name) =>
        Option.flatMap(
          Option.fromUndefinedOr(
            [...thread.subagents.values()].find(
              (item) => item.threadId === name
            )
          ),
          (item) =>
            Option.map(
              Option.fromUndefinedOr(store.threads.get(item.threadId)),
              (child) => ({ item, child })
            )
        )
      );

    /** `subagent_reply`: answers or escalates a child's question; never an approval. */
    const replyTool = (thread: ScriptedThread, call: ToolCall) =>
      locked((at, changes) =>
        Effect.sync((): ToolOutcome => {
          const named = childNamed(thread, call);

          if (Option.isNone(named)) {
            return notYours(call);
          }

          const { child } = named.value;
          const request = textArgument(call, "request");

          if (
            Option.isNone(textArgument(call, "answer")) &&
            Option.isNone(textArgument(call, "escalate"))
          ) {
            return refused(SubagentToolText.replyNeedsAnswer);
          }

          // The child's questions for its parent, whatever their status: a second call, or a
          // replay after the answer committed, finds its question settled.
          const questions = [...child.approvals.values()]
            .filter(
              (record) =>
                (faults.routeApprovalToParent ||
                  ((record.route === "parent" || record.escalatedAt !== null) &&
                    record.kind === "user-input")) &&
                (Option.isNone(request) || Option.contains(request, record.id))
            )
            .toSorted((a, b) => a.askedAt - b.askedAt);

          const record =
            questions.find(
              (found) =>
                found.status === "pending" && found.escalatedAt === null
            ) ?? questions.at(Option.isSome(request) ? 0 : -1);

          if (record === undefined) {
            return refused(SubagentToolText.noQuestionWaiting(child.threadId));
          }

          if (record.status !== "pending") {
            return said(SubagentToolText.replyAlreadySettled);
          }

          if (record.escalatedAt !== null) {
            return refused(
              SubagentToolText.replyAfterEscalation(record.id, child.threadId)
            );
          }

          const escalation = textArgument(call, "escalate");

          if (Option.isSome(escalation)) {
            escalate(
              thread,
              child,
              record.id,
              SubagentToolText.parentEscalated(escalation.value),
              at,
              changes
            );

            return said(SubagentToolText.replyEscalated);
          }

          const outcome = answerRecord(
            child,
            record.id,
            {
              decision: "accept",
              by: { kind: "thread", threadId: thread.threadId },
              reason: Option.none(),
              answers:
                record.payload?.type === "questions"
                  ? Option.some([
                      {
                        index: 0,
                        picks: [],
                        custom: Option.getOrElse(
                          textArgument(call, "answer"),
                          () => ""
                        ),
                      },
                    ])
                  : Option.none(),
            },
            at,
            changes
          );

          return said(
            outcome === "answered"
              ? SubagentToolText.replySettled
              : SubagentToolText.replyAlreadySettled
          );
        })
      );

    /** `subagent_send`: one more input to a child, delivered by its own reporter. */
    const sendTool = (thread: ScriptedThread, call: ToolCall) =>
      locked((_at, changes) =>
        Effect.sync((): ToolOutcome => {
          const named = childNamed(thread, call);
          const message = textArgument(call, "message");

          if (Option.isNone(named)) {
            return notYours(call);
          }

          if (Option.isNone(message)) {
            return refused(SubagentToolText.sendNeedsMessage);
          }

          const { item, child } = named.value;
          const requestId = `subagent-send-${taskOf(thread, call)}`;

          if (!item.inputs.has(requestId)) {
            newReporter(
              thread,
              child,
              item,
              {
                requestId,
                content: [{ type: "text", text: message.value }],
                entry: Option.none(),
                whenBusy:
                  call.arguments.mode === "steer" ? "steer" : "followUp",
              },
              false,
              changes
            );
          }

          return said(SubagentToolText.sent(child.threadId));
        })
      );

    /** `ask_parent`: a child's question to its parent model (ADR 0027), waited on like a gate. */
    const askParentTool = (thread: ScriptedThread, call: ToolCall) =>
      Effect.gen(function* () {
        const question = textArgument(call, "question");

        if (Option.isNone(thread.link)) {
          return refused(SubagentToolText.askOutsideSubagent);
        }

        if (Option.isNone(question)) {
          return refused(SubagentToolText.askNeedsQuestion);
        }

        const options = Option.getOrElse(
          decodeOptions(call.arguments.options),
          () => []
        ).filter((label) => label.trim() !== "");

        if (options.length > MAX_QUESTION_OPTIONS) {
          return refused(SubagentToolText.tooManyOptions(MAX_QUESTION_OPTIONS));
        }

        if (
          [question.value, ...options].some(
            (text) => text.length > MAX_QUESTION_LENGTH
          )
        ) {
          return refused(SubagentToolText.tooLong(MAX_QUESTION_LENGTH));
        }

        const approvalId = approvalIdOf(taskOf(thread, call));

        yield* locked((askedAt, changes) =>
          Effect.sync(() => {
            if (thread.approvals.has(approvalId)) {
              return;
            }

            const record: ApprovalRecord = {
              id: approvalId,
              toolTaskId: taskOf(thread, call),
              tool: call.name,
              kind: "user-input",
              summary: question.value,
              status: "pending",
              askedAt,
              expiresAt: askedAt + RECORD_TTL_MILLIS,
              answeredAt: null,
              run: null,
              executorRequestId: null,
              ...UNDECIDED,
              payload: {
                type: "questions",
                questions: [
                  {
                    header: "Question",
                    question: question.value,
                    options: options.map((label) => ({
                      label,
                      description: null,
                      recommended: false,
                    })),
                    multiSelect: false,
                    allowCustomAnswer: true,
                  },
                ],
              },
              route: "parent",
            };

            thread.approvals.set(approvalId, record);
            changes.touched.add(thread);
            changes.events.push(
              RuntimeRequestUpdated.make({
                threadId: thread.threadId,
                id: ApprovalId.make(approvalId),
                kind: "user-input",
                status: "pending",
              })
            );
            recordsChanged(thread, changes);
            offerToParent(thread, record, askedAt, changes);
          })
        );

        const settled = yield* settledRecord(thread, approvalId);

        return Option.match(settled, {
          onNone: () => refused(SubagentToolText.questionCancelled),
          onSome: (record) => {
            if (record.status !== "accepted") {
              return refused(SubagentToolText.questionEnded(record.status));
            }

            return said(
              renderAnswer(
                record.decidedBy?.kind === "thread" ? "parent" : "user",
                record.answer?.answers?.[0]
              )
            );
          },
        });
      });

    /**
     * `ask_user`: questions for the user (briefs note, section 4), a `user-input` record with the
     * questions frozen in its payload, waited on like a gate; the answers come back numbered.
     */
    const askUserTool = (thread: ScriptedThread, call: ToolCall) =>
      Effect.gen(function* () {
        const ask = questionAskOf(call.arguments);

        if (Result.isFailure(ask)) {
          return refused(ask.failure);
        }

        const taskId = taskOf(thread, call);
        const approvalId = approvalIdOf(taskId);

        yield* locked((askedAt, changes) =>
          Effect.sync(() => {
            if (thread.approvals.has(approvalId)) {
              return;
            }

            thread.approvals.set(approvalId, {
              id: approvalId,
              toolTaskId: taskId,
              tool: ASK_USER_TOOL,
              kind: "user-input",
              summary: ask.success.summary,
              status: "pending",
              askedAt,
              expiresAt: askedAt + QUESTION_TTL_MILLIS,
              answeredAt: null,
              run: null,
              executorRequestId: null,
              ...UNDECIDED,
              payload: ask.success.payload,
            });
            changes.touched.add(thread);
            changes.events.push(
              RuntimeRequestUpdated.make({
                threadId: thread.threadId,
                id: ApprovalId.make(approvalId),
                kind: "user-input",
                status: "pending",
              })
            );
            recordsChanged(thread, changes);
          })
        );

        const settled = yield* settledRecord(thread, approvalId);

        return Option.match(settled, {
          onNone: () =>
            refused("The questions were cancelled. Nothing was answered."),
          onSome: (record): ToolOutcome => ({
            ...askUserResult(record, ask.success.questions),
            terminate: false,
          }),
        });
      });

    /** `report`: a child's summary, divergence and commit; the first one of a run stands. */
    const reportTool = (thread: ScriptedThread, call: ToolCall) =>
      locked((_at, _changes) =>
        Effect.sync((): ToolOutcome => {
          const link = Option.getOrUndefined(thread.link);
          const run = Option.getOrUndefined(thread.run);

          if (link === undefined || run === undefined) {
            return refused(SubagentToolText.reportOutsideSubagent);
          }

          if (Option.isSome(link.report)) {
            return {
              text: SubagentToolText.alreadyReported,
              isError: false,
              terminate: true,
            };
          }

          link.report = Option.some({
            runId: run.runId,
            summary: Option.getOrElse(textArgument(call, "summary"), () => ""),
            divergence: Option.getOrElse(
              textArgument(call, "divergence"),
              () => "None"
            ),
            commit: textArgument(call, "commit"),
          });

          return {
            text: SubagentToolText.reported,
            isError: false,
            terminate: true,
          };
        })
      );

    /**
     * `submit_result` (models/ResultTool.ts): the value checked against the brief's schema, two
     * attempts counted from the transcript (a nudge before any call uses the first), the first
     * valid one kept as the child's `cairn.result` and the run ended on it.
     */
    const submitResultTool = (thread: ScriptedThread, call: ToolCall) =>
      locked((_at, _changes) =>
        Effect.sync((): ToolOutcome => {
          const link = Option.getOrUndefined(thread.link);

          if (link?.resultSchema === null || link === undefined) {
            return refused(ResultToolText.notTyped);
          }

          if (Option.isSome(link.result)) {
            return {
              text: ResultToolText.already,
              isError: false,
              terminate: true,
            };
          }

          const state = attemptStateIn(thread);

          if (!canSubmit(state)) {
            return refused(ResultToolText.capped);
          }

          const attempt = state.used + 1;
          const verdict = validateResult(link.resultSchema, call.arguments);

          if (Result.isFailure(verdict)) {
            return refused(ResultToolText.rejected(attempt, verdict.failure));
          }

          link.result = Option.some({
            result: copyJson(verdict.success.result),
            divergence: verdict.success.divergence,
            attempts: attempt,
          });

          return {
            text: ResultToolText.accepted,
            isError: false,
            terminate: true,
          };
        })
      );

    /**
     * `subagent_status`: each child's status, never its result (the result is the note). With
     * `wait_seconds` it waits, bounded, until a child settles again or asks.
     */
    const statusTool = (thread: ScriptedThread, call: ToolCall) =>
      Effect.gen(function* () {
        const name = textArgument(call, "subagent");

        const chosen = () =>
          [...thread.subagents.values()].filter(
            (item) =>
              Option.isNone(name) || Option.contains(name, item.threadId)
          );

        const current = chosen();
        const requested: unknown = call.arguments.wait_seconds;

        const seconds = Math.min(
          MAX_WAIT_SECONDS,
          Predicate.isNumber(requested) && requested > 0 ? requested : 0
        );

        if (seconds === 0 || current.length === 0 || asking(current)) {
          return said(statusText(current));
        }

        const before = settledCount(current);

        const later = yield* awaitThread(thread, () => {
          const items = chosen();

          return settledCount(items) > before || asking(items)
            ? Option.some(items)
            : Option.none();
        }).pipe(
          Effect.timeoutOption(Duration.seconds(seconds)),
          Effect.map(Option.flatten)
        );

        return said(statusText(Option.getOrElse(later, chosen)));
      });

    const stop = (
      threadId: ThreadId,
      options: StopOptions
    ): Effect.Effect<void, HarnessError> =>
      Effect.gen(function* () {
        const thread = yield* find(threadId);
        const fiber = runs.get(threadId);

        if (fiber !== undefined) {
          yield* Fiber.interrupt(fiber);
        }

        yield* locked((at, changes) =>
          Effect.sync(() => {
            if (options.clearQueue) {
              for (const item of thread.queue.splice(0)) {
                const submission = thread.byId.get(item.submissionId);

                if (submission !== undefined) {
                  endUnplaced(submission);
                }
              }

              changes.touched.add(thread);
              changes.events.push(queueChanged(thread));
            }

            const held = Option.isSome(thread.run)
              ? [...thread.approvals.values()].filter(heldByRun)
              : [];

            endRun(thread, "interrupted", Option.none(), at, changes);

            // The run's tools waited on these; nobody can answer them now (ADR 0029).
            for (const record of held) {
              const cancelled = copyRecord(record);

              cancelRecord(cancelled, at, "run-stopped");
              thread.approvals.set(cancelled.id, cancelled);
              changes.events.push(
                RuntimeRequestUpdated.make({
                  threadId,
                  id: ApprovalId.make(cancelled.id),
                  kind: cancelled.kind,
                  status: cancelled.status,
                })
              );
            }

            // A question to the parent ends with the call that asked it: its mirror in the parent
            // is cancelled too, and the parent's registry marks it (ADR 0027).
            for (const { parent, item } of Option.toArray(linkOf(thread))) {
              for (const record of held) {
                if (
                  record.kind !== "user-input" ||
                  (record.route !== "parent" && record.escalatedAt === null)
                ) {
                  continue;
                }

                const mirrorId = `esc-${thread.conversationId}-${record.id}`;
                const mirror = parent.approvals.get(mirrorId);

                if (mirror?.status === "pending") {
                  const cancelled = copyRecord(mirror);

                  cancelRecord(cancelled, at, "run-stopped");
                  parent.approvals.set(mirrorId, cancelled);
                  changes.touched.add(parent);
                  changes.events.push(
                    RuntimeRequestUpdated.make({
                      threadId: parent.threadId,
                      id: ApprovalId.make(mirrorId),
                      kind: cancelled.kind,
                      status: cancelled.status,
                    })
                  );
                }

                item.questions.set(record.id, {
                  state: "cancelled",
                  escalatedAt:
                    item.questions.get(record.id)?.escalatedAt ?? null,
                });
                parent.offered.delete(`${thread.threadId}:${record.id}`);
                changes.touched.add(parent);
              }
            }

            if (held.length > 0) {
              recordsChanged(thread, changes);
            }
          })
        );

        // Stop all: every working child stops too, and their own children with them.
        if (options.subagents === "stop") {
          for (const item of thread.subagents.values()) {
            const child = store.threads.get(item.threadId);

            if (
              child !== undefined &&
              (Option.isSome(child.run) || child.queue.length > 0)
            ) {
              yield* stop(child.threadId, {
                clearQueue: true,
                subagents: "stop",
              });
            }
          }
        }
      }).pipe(Effect.withSpan("ScriptedHarness.stop"));

    /** `subagent_stop`: stops one child's run and withdraws its queue. */
    const stopTool = (thread: ScriptedThread, call: ToolCall) =>
      Effect.gen(function* () {
        const named = childNamed(thread, call);

        if (Option.isNone(named)) {
          return notYours(call);
        }

        const { child } = named.value;

        yield* stop(child.threadId, {
          clearQueue: true,
          subagents: "stop",
        }).pipe(
          Effect.catchTag("HarnessError", (cause) =>
            Effect.logWarning("scripted subagent stop failed").pipe(
              Effect.annotateLogs({
                event: "scripted_subagent_stop_failed",
                error: cause.message,
              })
            )
          )
        );

        return said(SubagentToolText.stopped(child.threadId));
      });

    /** The parent's five subagent tools by name (subagents note, section 2). */
    const parentTools = new Map<
      string,
      (thread: ScriptedThread, call: ToolCall) => Effect.Effect<ToolOutcome>
    >([
      ["subagent_spawn", spawnTool],
      ["subagent_reply", replyTool],
      ["subagent_send", sendTool],
      ["subagent_stop", stopTool],
      ["subagent_status", statusTool],
    ]);

    /** One tool call: the subagent tools are the harness's own, the rest the tools service's. */
    const runTool = (
      thread: ScriptedThread,
      call: ToolCall
    ): Effect.Effect<ToolOutcome> => {
      const isChild = Option.isSome(thread.link);

      if (call.name === ASK_USER_TOOL) {
        return askUserTool(thread, call);
      }

      if (!isChild) {
        const handler = parentTools.get(call.name);

        if (handler !== undefined) {
          return handler(thread, call);
        }
      }

      if (isChild && CHILD_TOOLS.has(call.name)) {
        return call.name === "report"
          ? reportTool(thread, call)
          : askParentTool(thread, call);
      }

      if (isChild && call.name === RESULT_TOOL_NAME) {
        return submitResultTool(thread, call);
      }

      return Effect.map(tools.run(call, toolApi(thread, call)), (result) => ({
        ...result,
        terminate: false,
      }));
    };

    /** One run: answers, tool rounds and boundaries until the answer is final and nothing waits. */
    const runLoop = (thread: ScriptedThread): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (Option.isSome(thread.run)) {
          const calls = pendingCalls(thread);

          if (calls.length > 0) {
            let terminated = true;

            for (const call of calls) {
              const result = yield* runTool(thread, call);

              terminated &&= result.terminate;

              yield* locked((at, changes) =>
                Effect.sync(() => {
                  appendEntry(thread, "pi.tool-result", {
                    model: [
                      {
                        role: "toolResult",
                        toolCallId: call.id,
                        toolName: call.name,
                        content: [{ type: "text", text: result.text }],
                        isError: result.isError,
                        timestamp: at,
                      },
                    ],
                    data: { diagnostics: [] },
                  });
                  changes.touched.add(thread);
                })
              );
            }

            // After the tool round: notes first, then queued steers, before the next request. A
            // round of terminating results ends the run as a final answer does.
            yield* locked((at, changes) =>
              Effect.sync(() => {
                if (terminated) {
                  continueOrEnd(thread, at, changes);

                  return;
                }

                placeWrites(thread, at, changes);

                const steerIndex = thread.queue.findIndex(
                  (item) => item.mode === "steer"
                );

                const [steer] =
                  steerIndex === -1 ? [] : thread.queue.splice(steerIndex, 1);

                if (steer !== undefined) {
                  place(thread, steer, at, changes);
                  changes.events.push(queueChanged(thread));
                }
              })
            );

            continue;
          }

          const answer = yield* model.answer({
            threadId: thread.threadId,
            messages: contextOf(thread),
            tools: offeredTools(thread),
          });

          yield* locked((at, changes) =>
            Effect.sync(() => {
              const entry = appendEntry(thread, "pi.assistant", {
                model: [answer],
              });

              thread.usage = {
                input: thread.usage.input + answer.usage.input,
                output: thread.usage.output + answer.usage.output,
              };

              changes.touched.add(thread);
              changes.events.push(
                MessageCommitted.make({
                  threadId: thread.threadId,
                  entryId: EntryId.make(entry.id),
                  role: "assistant",
                  text: messageText(answer),
                  at: DateTime.makeUnsafe(answer.timestamp),
                })
              );

              if (
                answer.stopReason === "error" ||
                answer.stopReason === "aborted"
              ) {
                endRun(
                  thread,
                  answer.stopReason === "error" ? "failed" : "interrupted",
                  answer.stopReason === "error"
                    ? Option.some(
                        classifyRunFailure({
                          message: answer.errorMessage ?? "",
                          reason: Option.some("model_error"),
                          at: DateTime.makeUnsafe(answer.timestamp),
                        })
                      )
                    : Option.none(),
                  at,
                  changes
                );

                return;
              }

              if (pendingCalls(thread).length === 0) {
                continueOrEnd(thread, at, changes);
              }
            })
          );
        }
      });

    const startRun = (thread: ScriptedThread) =>
      Effect.gen(function* () {
        if (runs.has(thread.threadId)) {
          return;
        }

        const fiber = yield* runLoop(thread).pipe(
          Effect.ensuring(Effect.sync(() => runs.delete(thread.threadId))),
          Effect.forkIn(scope)
        );

        runs.set(thread.threadId, fiber);
      });

    starters.run = startRun;
    starters.reporter = startReporter;

    // After a restart, runs the store left in progress ask the model again, and reporters carry
    // on from the phase they reached, once resumed.
    const resume = Effect.gen(function* () {
      yield* Effect.forEach(
        [...store.threads.values()].filter(
          (thread) => Option.isSome(thread.run) && !runs.has(thread.threadId)
        ),
        startRun,
        { discard: true }
      );
      yield* Effect.forEach(store.reporters.values(), startReporter, {
        discard: true,
      });
    });

    const ensureThread = Effect.fn("ScriptedHarness.ensureThread")(function* (
      input: EnsureThread
    ) {
      return yield* locked((_at, changes) =>
        Effect.sync(() => {
          const existing = store.threads.get(input.threadId);

          if (existing !== undefined) {
            return {
              threadId: input.threadId,
              conversationId: ConversationId.make(existing.conversationId),
              created: false,
            };
          }

          const thread = freshThread(
            input.threadId,
            input.projectId,
            {
              model: input.model,
              thinkingLevel: input.thinkingLevel,
              cwd: input.cwd,
            },
            input.runtimeMode
          );

          store.threads.set(input.threadId, thread);

          const conversationId = ConversationId.make(thread.conversationId);

          changes.touched.add(thread);
          changes.events.push(
            ThreadEnsured.make({
              threadId: input.threadId,
              conversationId,
              parent: Option.none(),
            })
          );

          return { threadId: input.threadId, conversationId, created: true };
        })
      );
    });

    const configure = Effect.fn("ScriptedHarness.configure")(function* (
      threadId: ThreadId,
      change: ThreadAgentChange
    ) {
      const thread = yield* find(threadId);

      return yield* locked((_at, changes) =>
        Effect.gen(function* () {
          if (Option.isSome(change.cwd) && Option.isSome(thread.run)) {
            return yield* failure(
              "invalid_input",
              threadId,
              `Thread ${threadId} is running, so its folder cannot change now. Stop it or wait, then change the folder.`
            );
          }

          for (const mode of Option.toArray(change.runtimeMode)) {
            for (const { parent } of Option.toArray(linkOf(thread))) {
              const ceiling = effectiveMode(parent);

              if (isWiderThan(mode, ceiling)) {
                return yield* failure(
                  "invalid_input",
                  threadId,
                  `A subagent's permission mode cannot be wider than its parent's (${ceiling}). Choose ${ceiling} or a narrower mode.`
                );
              }
            }
          }

          if (Option.isSome(change.runtimeMode) && Option.isSome(thread.run)) {
            return yield* failure(
              "invalid_input",
              threadId,
              `Thread ${threadId} is running, so its permission mode cannot change now. Stop it or wait, then change the mode.`
            );
          }

          thread.permissions = {
            mode: Option.getOrElse(
              change.runtimeMode,
              () => thread.permissions.mode
            ),
            allow: thread.permissions.allow,
          };

          thread.agent = {
            model: Option.getOrElse(change.model, () => thread.agent.model),
            thinkingLevel: Option.getOrElse(
              change.thinkingLevel,
              () => thread.agent.thinkingLevel
            ),
            cwd: Option.getOrElse(change.cwd, () => thread.agent.cwd),
          };

          changes.touched.add(thread);

          return yield* Effect.void;
        })
      );
    });

    const submit = Effect.fn("ScriptedHarness.submit")(function* (
      threadId: ThreadId,
      input: HarnessTurnInput
    ) {
      const thread = yield* find(threadId);

      return yield* locked((at, changes) =>
        Effect.gen(function* () {
          const existing = thread.byRequest.get(input.requestId);

          if (existing !== undefined) {
            return {
              submissionId: SubmissionId.make(existing.id),
              status: existing.status,
            };
          }

          if (Option.isSome(thread.run) && input.whenBusy === "reject") {
            return yield* failure(
              "thread_busy",
              threadId,
              "The thread is running and the input asked not to queue. Send it again when the run ends, or let it queue."
            );
          }

          const admitted: AdmitInput = {
            requestId: input.requestId,
            content: input.content,
            entry: input.entry,
            whenBusy: input.whenBusy === "steer" ? "steer" : "followUp",
          };

          // A user's input clears a stop's hold on wakes.
          thread.halted = false;

          const submission = admit(thread, admitted, at, changes);

          // A user's steer to a subagent is delivered to its parent as a quiet note.
          for (const { parent, item } of Option.toArray(linkOf(thread))) {
            newReporter(parent, thread, item, admitted, true, changes);
          }

          return {
            submissionId: SubmissionId.make(submission.id),
            status: submission.status,
          };
        })
      );
    });

    const withdraw = Effect.fn("ScriptedHarness.withdraw")(function* (
      threadId: ThreadId,
      submissionId: SubmissionId
    ) {
      const thread = yield* find(threadId);

      return yield* locked((_at, changes) =>
        Effect.gen(function* () {
          const submission = thread.byId.get(submissionId);

          if (submission === undefined) {
            return yield* failure(
              "submission_not_found",
              threadId,
              `Input ${submissionId} is not queued on thread ${threadId}. Refresh the thread and try again.`
            );
          }

          const index = thread.queue.findIndex(
            (item) => item.submissionId === submissionId
          );

          if (index === -1) {
            return { withdrawn: false };
          }

          thread.queue.splice(index, 1);
          endUnplaced(submission);
          changes.touched.add(thread);
          changes.events.push(queueChanged(thread));

          return { withdrawn: true };
        })
      );
    });

    const respond = Effect.fn("ScriptedHarness.respond")(function* (
      threadId: ThreadId,
      approvalId: ApprovalId,
      given: ApprovalAnswerInput
    ) {
      const thread = yield* find(threadId);

      return yield* locked((at, changes) =>
        Effect.gen(function* () {
          const outcome = answerRecord(
            thread,
            approvalId,
            { ...given, by: { kind: "user" } },
            at,
            changes
          );

          if (outcome === "not_found") {
            return yield* failure(
              "approval_not_found",
              threadId,
              `Approval ${approvalId} is not on thread ${threadId}. Refresh the thread; it may have been answered elsewhere.`
            );
          }

          const refusedAnswer = refusalText(outcome, approvalId);

          if (Option.isSome(refusedAnswer)) {
            return yield* failure(
              "invalid_input",
              threadId,
              refusedAnswer.value
            );
          }

          const answered = thread.approvals.get(approvalId);

          if (
            outcome === "answered" &&
            given.decision === "accept_for_thread" &&
            answered !== undefined &&
            !thread.permissions.allow.includes(answered.tool)
          ) {
            thread.permissions = {
              mode: thread.permissions.mode,
              allow: [...thread.permissions.allow, answered.tool],
            };
            changes.touched.add(thread);
          }

          return yield* Effect.void;
        })
      );
    });

    const write = Effect.fn("ScriptedHarness.write")(function* (
      threadId: ThreadId,
      entry: PassiveEntry | PassiveNote
    ) {
      const thread = yield* find(threadId);

      return yield* locked((at, changes) =>
        Effect.sync(() => {
          if ("model" in entry) {
            writeNote(
              thread,
              {
                requestId: entry.requestId,
                kind: entry.kind,
                data: entry.data,
                text: entry.model.map((part) => part.text).join("\n"),
              },
              at,
              changes
            );

            return;
          }

          if (!thread.writes.has(entry.requestId)) {
            thread.writes.add(entry.requestId);
            appendEntry(thread, entry.kind, { data: entry.data });
            changes.touched.add(thread);
          }
        })
      );
    });

    const compact = Effect.fn("ScriptedHarness.compact")(function* (
      threadId: ThreadId,
      _instructions: Option.Option<string>
    ) {
      const thread = yield* find(threadId);
      const taskId = TaskId.make(nextId());

      yield* PubSub.publish(
        events,
        CompactionStarted.make({ threadId, taskId })
      );

      const summary = yield* model.answer({
        threadId,
        messages: contextOf(thread),
        tools: [],
      });

      return yield* locked((at, changes) =>
        Effect.sync(() => {
          const kept = thread.entries.at(-1);

          const entry = appendEntry(thread, "pi.compaction", {
            model: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `<summary>\n${messageText(summary)}\n</summary>`,
                  },
                ],
                timestamp: at,
              },
            ],
            data: { reason: "manual" },
          });

          // The view starts at the summary and keeps the newest entry verbatim, as pi-durable's does.
          const withHead: EntryRecord =
            kept === undefined ? entry : { ...entry, head: kept.id };

          thread.entries.pop();
          thread.entries.push(withHead);

          if (kept !== undefined) {
            thread.entries.splice(thread.entries.indexOf(kept), 1);
            thread.entries.push(kept);
          }

          thread.head = thread.entries.indexOf(withHead);
          changes.touched.add(thread);
          changes.events.push(
            CompactionEnded.make({ threadId, taskId, failed: false })
          );
        })
      );
    });

    const watch = (threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const thread = yield* find(threadId);
          const ref = yield* revision(thread);
          const projector = wireProjector();
          const seq = yield* Ref.make(0);

          return SubscriptionRef.changes(ref).pipe(
            Stream.mapEffect((view) =>
              Effect.gen(function* () {
                const next = yield* Ref.getAndUpdate(seq, (n) => n + 1);

                if (next === 0) {
                  const snapshot = yield* Effect.fromResult(
                    projector.snapshot(view)
                  );

                  return Option.some<ThreadFrame>(
                    ThreadSnapshotItem.make({
                      seq: next,
                      view: snapshot,
                      entriesOffset: 0,
                      hasMoreHistory: thread.head > 0,
                    })
                  );
                }

                const ops = yield* Effect.fromResult(projector.advance(view));

                return ops.length === 0
                  ? Option.none<ThreadFrame>()
                  : Option.some<ThreadFrame>(
                      ThreadOpsItem.make({ seq: next, ops })
                    );
              }).pipe(
                Effect.mapError((cause) =>
                  failure("internal", threadId, cause.message)
                )
              )
            ),
            Stream.filter(Option.isSome),
            Stream.map((frame) => frame.value)
          );
        })
      );

    const whenEnsured = Effect.fn("ScriptedHarness.whenEnsured")(function* (
      threadId: ThreadId
    ) {
      const wake = yield* PubSub.subscribe(events);

      if (store.threads.has(threadId)) {
        return;
      }

      yield* PubSub.take(wake).pipe(
        Effect.repeat({
          until: (event) =>
            Predicate.isTagged(event, "ThreadEnsured") &&
            event.threadId === threadId,
        })
      );
    }, Effect.scoped);

    const history = Effect.fn("ScriptedHarness.history")(function* (
      threadId: ThreadId,
      query: { readonly before: EntryId; readonly limit: number }
    ) {
      const thread = yield* find(threadId);
      const older = thread.entries.filter((entry) => entry.id < query.before);
      const kept = older.slice(-query.limit);

      const entries = yield* Effect.forEach(kept, (entry) =>
        Effect.fromResult(projectEntry(entry, "stream")).pipe(
          Effect.mapError((cause) =>
            failure("internal", threadId, cause.message)
          )
        )
      );

      return { entries, hasMore: older.length > kept.length };
    });

    const findEntry = (threadId: ThreadId, entryId: EntryId) =>
      Effect.flatMap(find(threadId), (thread) =>
        Effect.fromNullishOr(
          thread.entries.find((entry) => entry.id === piEntryId(entryId))
        ).pipe(
          Effect.mapError(() =>
            failure(
              "entry_not_found",
              threadId,
              `Entry ${entryId} is not in thread ${threadId}.`
            )
          )
        )
      );

    const entry = Effect.fn("ScriptedHarness.entry")(function* (
      threadId: ThreadId,
      entryId: EntryId
    ) {
      const found = yield* findEntry(threadId, entryId);

      const projected = yield* Effect.fromResult(
        projectEntry(found, "full")
      ).pipe(
        Effect.mapError((cause) => failure("internal", threadId, cause.message))
      );

      return { entry: projected, truncated: false };
    });

    const entryImage = Effect.fn("ScriptedHarness.entryImage")(function* (
      threadId: ThreadId,
      entryId: EntryId,
      index: number
    ) {
      const found = yield* findEntry(threadId, entryId);

      const image = entryImages(found)[index];

      if (image === undefined) {
        return yield* failure(
          "entry_not_found",
          threadId,
          `Entry ${entryId} has no image ${index}.`
        );
      }

      return {
        mimeType: image.mimeType,
        bytes: Uint8Array.from(Buffer.from(image.data, "base64")),
      };
    });

    const inspect = Effect.sync(() => {
      const states: Array<LiveThreadState> = [];

      for (const thread of store.threads.values()) {
        const pending = [...thread.approvals.values()].flatMap((record) =>
          record.status === "pending" ? [ApprovalId.make(record.id)] : []
        );

        if (
          Option.isSome(thread.run) ||
          thread.queue.length > 0 ||
          pending.length > 0
        ) {
          states.push({
            threadId: thread.threadId,
            conversationId: ConversationId.make(thread.conversationId),
            runId: Option.map(thread.run, (run) => RunId.make(run.runId)),
            queueLength: thread.queue.length,
            parkedTaskIds: [],
            pendingApprovals: pending,
          });
        }
      }

      return states;
    });

    const seam = HarnessSeam.of({
      ensureThread,
      configure,
      submit,
      stop,
      withdraw,
      respond,
      write,
      compact,
      watch,
      whenEnsured,
      history,
      entry,
      entryImage,
      events: Stream.fromPubSub(events),
      inspect,
      // Nothing parks in a scripted store.
      retry: (taskId) =>
        Effect.fail(
          new HarnessError({
            message: `Task ${taskId} is not parked; the scripted harness parks nothing.`,
            reason: "task_not_found",
            retryable: false,
            threadId: Option.none(),
          })
        ),
      capabilities: { durable: true, live: false },
    });

    return Context.make(HarnessSeam, seam).pipe(
      Context.add(ScriptedBoot, ScriptedBoot.of({ resume }))
    );
  })
);

/** The scripted harness: `layerNoDeps` over a given store, model and tools; `layer` for dev. */
export const ScriptedHarness = {
  layerNoDeps,
  /** An echoing model and an `echo` tool over a fresh store: the dev client's backend. */
  layer: Layer.effectDiscard(ScriptedBoot.use((boot) => boot.resume)).pipe(
    Layer.provideMerge(layerNoDeps),
    Layer.provide(ScriptedStore.layer),
    Layer.provide(ScriptedModel.layerEcho),
    Layer.provide(ScriptedTools.layerEcho)
  ),
};

/** Internal ids exposed for tests that need a pi-durable task id. */
export const scriptedTaskId = (id: number) => piTaskId(TaskId.make(id));
