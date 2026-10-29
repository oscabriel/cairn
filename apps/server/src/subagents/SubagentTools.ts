// The seven subagent tools (ADR 0028, ADR 0027; docs/phase-2/notes/subagents.md, section 2): five
// for the parent and two for the child, one verb each, flat parameters (Fold's rule: unions confuse
// models), and every text the model reads from `SubagentToolText`, which the scripted harness
// writes too.
//
// - `subagent_spawn` records a brief (kind `brief`, its payload frozen) and its brief task (the
//   brief's expiry) in one commit, and returns at once; Go's commit creates the start. It refuses
//   past the caps: 8 children working or waiting for Go per parent, 32 across the brain
//   (BrainCap.ts), and depth 2.
// - `subagent_send` gives a child one more input through its own reporter.
// - `subagent_status` lists each child's status, never its result (that arrives once, as a note),
//   and with `wait_seconds` waits, bounded, until one reports or asks.
// - `subagent_stop` stops a child's run and withdraws its queue; `unsafe`, since a repeat could stop
//   newer work.
// - `subagent_reply` answers or escalates a child's `ask_parent` question; never an approval.
// - `ask_parent` (child) records a question routed to the parent, offers it to the parent model as
//   an input, and waits like a gated call; a parent run that ends with it open escalates it, as
//   does a parent left idle after a failed or stopped run with the question still queued (it is
//   withdrawn there), and a question that expires unanswered ends its parent's mirror and registry
//   mark too.
// - `report` (child) finishes a brief with a summary, the divergence of a text result and a commit.
//   A typed result goes through `submit_result` (models/ResultTool.ts), which a typed child's
//   creating commit also offers: two attempts, the real schema in the request, first valid wins.
//
// The child's two tools are deferred, so only a child, whose creating commit adds them to its
// `modelTools`, is offered them; the same change takes the parent's five away.

import { ThreadId } from "@cairn/protocol/Ids";
import {
  MAX_LIVE_CHILDREN,
  MAX_LIVE_CHILDREN_PER_BRAIN,
  MAX_SUBAGENT_DEPTH,
} from "@cairn/protocol/Subagents";
import type { JsonValue } from "@earendil-works/chord";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type {
  AgentChange,
  ToolExecutionApi,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";
import { Duration, Effect, Option, Result } from "effect";

import {
  endUnanswered,
  escalateIn,
  MAX_ESCALATE_REASON,
  MAX_QUESTION_LENGTH,
  MAX_QUESTION_OPTIONS,
  placedMemoOf,
  QUESTION_WINDOW_MILLIS,
  questionRecord,
  routeQuestion,
} from "../approvals/QuestionRoute.ts";
import type { RouteIo } from "../approvals/QuestionRoute.ts";
import { BRIEF_TTL_MILLIS } from "../brain/BriefTtl.ts";
import {
  applyAnswer,
  approvalIdOf,
  approvalLedger,
  Approvals,
  cancelAbandonedApprovals,
  ThreadMeta,
  UNDECIDED,
} from "../brain/CairnDocs.ts";
import type { ApprovalSettlement } from "../brain/CairnDocs.ts";
import {
  GATED_APPROVAL_TTL_MILLIS,
  readPermissions,
} from "../brain/Permissions.ts";
import type { SubagentFaultSet } from "../brain/SubagentFaults.ts";
import {
  renderAnswer,
  SPAWN_WAITING,
  SubagentToolText,
} from "../brain/SubagentText.ts";
import { offerResultTool } from "../models/ResultTool.ts";
import { countLive, dropIdle, listParent } from "./BrainCap.ts";
import { briefOf, briefPayload } from "./Briefs.ts";
import { conversationOf, setStatus } from "./Delivery.ts";
import {
  ChildDoc,
  isLinked,
  markQuestion,
  SubagentsDoc,
} from "./SubagentDocs.ts";
import type {
  ChildState,
  JsonRecord,
  SubagentItemState,
} from "./SubagentDocs.ts";
import { START_TASK } from "./SubagentTasks.ts";
import type { RoleAccess, SubagentTasks } from "./SubagentTasks.ts";
import { awaitDoc, runWait } from "./Waits.ts";

/** The longest bounded wait `subagent_status` takes. */
const MAX_WAIT_SECONDS = 600;

const said = (text: string): ToolExecutionResult => ({
  output: [{ type: "text", text }],
});

const refused = (text: string): ToolExecutionResult => ({
  output: [{ type: "text", text }],
  isError: true,
});

/** A string argument a model sent, with an empty one read as absent (Fold). */
const textOf = (value: string | undefined): Option.Option<string> =>
  Option.filter(Option.fromUndefinedOr(value), (text) => text.trim() !== "");

/** The child named by a parent's tool call, from its registry; none for one it does not own. */
const childNamed = async (
  api: ToolExecutionApi,
  name: string | undefined,
  context: ChordContext
): Promise<Option.Option<SubagentItemState>> => {
  const wanted = textOf(name);

  if (Option.isNone(wanted)) {
    return Option.none();
  }

  const registry = await api.snapshot(
    SubagentsDoc,
    api.conversationId,
    context
  );

  return Option.fromUndefinedOr(
    Object.values(registry?.items ?? {}).find(
      (item) => item.threadId === wanted.value
    )
  );
};

/** The memo a `report` call keeps its verdict in, so a rerun answers the same. */
const REPORT_MEMO = "cairn.subagent-report";

/** A report verdict, as its memo keeps it. */
interface ReportVerdict {
  [key: string]: JsonValue;
  text: string;
  isError: boolean;
  terminate: boolean;
}

/** One line per child, or the bare word when there are none. */
const statusText = (items: ReadonlyArray<SubagentItemState>) =>
  items.length === 0
    ? SubagentToolText.noSubagents
    : items
        .map((item) =>
          SubagentToolText.statusLine(
            item.threadId,
            item.description,
            item.status,
            Object.values(item.questions).some(
              (question) => question.state === "pending"
            )
          )
        )
        .join("\n");

/** How many settlements `items` have had. */
const settledCount = (items: ReadonlyArray<SubagentItemState>) =>
  items.reduce((sum, item) => sum + item.settlements.length, 0);

/** Whether any of `items` waits on a question to its parent. */
const asking = (items: ReadonlyArray<SubagentItemState>) =>
  items.some((item) =>
    Object.values(item.questions).some(
      (question) => question.state === "pending"
    )
  );

/** The link of a child calling one of its own tools; none outside a subagent. */
const linkOf = async (
  api: ToolExecutionApi,
  context: ChordContext
): Promise<Option.Option<Readonly<ChildState>>> => {
  const link = await api.snapshot(ChildDoc, api.conversationId, context);

  return isLinked(link) ? Option.some(link) : Option.none();
};

/** What a test may tune in the tools; production keeps the defaults. */
export interface SubagentToolOptions {
  /** How long a child's question waits before it expires: a gated call's day. */
  readonly questionTtlMillis: number;
  /** How long a parent's model may hold a child's question it was shown (ADR 0027): 15 minutes. */
  readonly questionWindowMillis: number;
  /**
   * How long a reporter waits, once its input's run ended, before it settles, by whether its
   * input is quiet: none in production. A test delays the waking reporters to make a quiet one
   * settle a shared run first.
   */
  readonly settleDelayMillis: (quiet: boolean) => number;
  /** How long a brief stays answerable before it expires and its parent is told: a week. */
  readonly briefTtlMillis: number;
  /** How many children the whole brain may hold live (`MAX_LIVE_CHILDREN_PER_BRAIN`). */
  readonly maxLivePerBrain: number;
}

/** The tools' production options. */
export const DEFAULT_TOOL_OPTIONS: SubagentToolOptions = {
  questionTtlMillis: GATED_APPROVAL_TTL_MILLIS,
  questionWindowMillis: QUESTION_WINDOW_MILLIS,
  settleDelayMillis: () => 0,
  briefTtlMillis: BRIEF_TTL_MILLIS,
  maxLivePerBrain: MAX_LIVE_CHILDREN_PER_BRAIN,
};

/** Why a spawn's commit refused: the parent's cap or the brain's, with the count it found. */
type CapRefusal =
  | { readonly cap: "parent"; readonly live: number }
  | { readonly cap: "brain"; readonly live: number };

/** A route's view of a replay-safe tool call: its commits, its clock and its memo. */
export const routeIo = (
  api: ToolExecutionApi,
  context: ChordContext
): RouteIo => ({
  observer: api,
  now: () => api.now(),
  placedAt: async (approvalId, candidate) =>
    await api.memo(placedMemoOf(approvalId), candidate, context),
  conversation: async (id) => await api.conversation(id, context),
  commitDocs: async (change) => {
    await api.commit(change, context);
  },
});

/** What a child's `ask_parent` returns once its record settled: the answer, or why there is none. */
const answerOf = async (
  api: Pick<ToolExecutionApi, "snapshot" | "conversationId">,
  approvalId: string,
  settlement: Pick<ApprovalSettlement, "status">,
  context: ChordContext
): Promise<ToolExecutionResult> => {
  const approvals = await api.snapshot(Approvals, api.conversationId, context);
  const record = approvals?.items[approvalId];

  if (settlement.status !== "accepted" || record === undefined) {
    return refused(
      settlement.status === "cancelled"
        ? SubagentToolText.questionCancelled
        : SubagentToolText.questionEnded(settlement.status)
    );
  }

  return said(
    renderAnswer(
      record.decidedBy?.kind === "thread" ? "parent" : "user",
      record.answer?.answers?.[0]
    )
  );
};

/** The tools, closed over the extension's faults, tasks and options. */
export const subagentToolSet = (
  faults: SubagentFaultSet,
  tasks: SubagentTasks,
  roles: RoleAccess,
  tuning: SubagentToolOptions = DEFAULT_TOOL_OPTIONS
) => {
  const spawn = defineTool({
    name: "subagent_spawn",
    description:
      "Propose a subagent: a child thread that works on a brief while you go on. The user approves the brief first; you are told when they answer, and the child's result arrives as a note once it finishes.",
    parameters: Type.Object({
      description: Type.String({
        description:
          "5 to 10 words: the child's title and the label it is listed under.",
      }),
      brief: Type.String({
        description:
          "What to do, why, and how the result will be judged. The child sees only this.",
      }),
      why: Type.Optional(Type.String()),
      isolation: Type.Optional(
        Type.String({
          description:
            "worktree for a child that writes, shared (the default) for one that only reads.",
        })
      ),
      result_schema: Type.Optional(
        Type.Unsafe<JsonRecord>({
          type: "object",
          description:
            "A JSON Schema the child's result payload must match; leave it out for a text result.",
        })
      ),
      wake: Type.Optional(
        Type.String({
          description:
            "answer (the default) wakes you when the child reports; quiet only leaves the note.",
        })
      ),
      role: Type.Optional(
        Type.String({
          description:
            "The role the child runs as (@worker, @scout; the roles tool lists them) or provider/modelId[:level]. Leave it out to run the child on your own model.",
        })
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const description = textOf(args.description);
      const task = textOf(args.brief);

      if (Option.isNone(description) || Option.isNone(task)) {
        return refused(SubagentToolText.spawnNeedsBrief);
      }

      const own = await api.snapshot(ChildDoc, api.conversationId, context);

      if (isLinked(own) && own.depth >= MAX_SUBAGENT_DEPTH) {
        return refused(SubagentToolText.depthReached(own.depth));
      }

      const permissions = await readPermissions(api, context);

      const brief = briefOf(
        {
          description: description.value,
          brief: task.value,
          why: textOf(args.why),
          isolation: textOf(args.isolation),
          resultSchema: Option.fromUndefinedOr(args.result_schema),
          wake: textOf(args.wake),
          role: textOf(args.role),
        },
        permissions.mode
      );

      if (Result.isFailure(brief)) {
        return refused(brief.failure);
      }

      const approvalId = approvalIdOf(api.taskId);

      const asked = await api.snapshot(Approvals, api.conversationId, context);

      // A role is checked at the ask, so the card never offers Go on one nothing ready answers to;
      // it resolves again at Go, which decides (ADR 0035). A replayed call that already asked is
      // not checked again: its brief is pending whatever the role's readiness is now.
      if (
        brief.success.role !== null &&
        asked?.items[approvalId] === undefined
      ) {
        const resolved = await roles.resolve(brief.success.role);

        if (Result.isFailure(resolved)) {
          return refused(
            resolved.failure.retry
              ? SubagentToolText.roleUnchecked(resolved.failure.why)
              : SubagentToolText.roleRefused(resolved.failure.why)
          );
        }
      }

      const committed = await api.commit(async (tx) => {
        // The brain's count reads tables, so it comes before the brief task is created.
        const brain = await countLive(tx, START_TASK, null);
        const approvals = await tx.doc(Approvals, api.conversationId);

        // A replayed call finds its brief before the cap, which may have filled since.
        if (approvals.items[approvalId] !== undefined) {
          return Option.none<CapRefusal>();
        }

        const registry = await tx.doc(SubagentsDoc, api.conversationId);

        // Briefs still waiting for Go count: Go starts each without asking again.
        const proposed = Object.values(approvals.items).filter(
          (record) => record.kind === "brief" && record.status === "pending"
        ).length;

        const live =
          Object.values(registry.items).filter(
            (item) => item.status !== "settled"
          ).length + proposed;

        if (live >= MAX_LIVE_CHILDREN) {
          return Option.some<CapRefusal>({ cap: "parent", live });
        }

        if (brain.live >= tuning.maxLivePerBrain) {
          return Option.some<CapRefusal>({ cap: "brain", live: brain.live });
        }

        await dropIdle(tx, brain, api.conversationId);
        await listParent(tx, api.conversationId);

        const askedAt = api.now();

        approvals.items[approvalId] = {
          id: approvalId,
          toolTaskId: api.taskId,
          tool: "subagent_spawn",
          kind: "brief",
          summary: description.value,
          status: "pending",
          askedAt,
          expiresAt: askedAt + tuning.briefTtlMillis,
          answeredAt: null,
          run: null,
          executorRequestId: null,
          ...UNDECIDED,
          payload: briefPayload(brief.success),
        };

        // Go is answered by the user, never by a mode (ADR 0026), and its commit creates the start;
        // the brief task only expires the brief if no answer comes in time.
        await tx.createTask(
          tasks.Brief,
          { approvalId },
          {
            ownership: { kind: "conversation" },
            background: true,
            conversationId: api.conversationId,
          }
        );

        return Option.none<CapRefusal>();
      }, context);

      return Option.match(committed, {
        onNone: () => said(SPAWN_WAITING),
        onSome: (refusal) =>
          refused(
            refusal.cap === "parent"
              ? SubagentToolText.capReached(refusal.live)
              : SubagentToolText.brainCapReached(refusal.live)
          ),
      });
    },
  });

  const send = defineTool({
    name: "subagent_send",
    description:
      "Send one more message to a subagent you started. Its answer arrives as a note, like its first.",
    parameters: Type.Object({
      subagent: Type.String({ description: "The subagent's thread id." }),
      message: Type.String(),
      mode: Type.Optional(
        Type.String({
          description:
            "followUp (the default) waits for its current answer; steer reaches it at its next step.",
        })
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const named = await childNamed(api, args.subagent, context);
      const message = textOf(args.message);

      if (Option.isNone(named)) {
        return refused(SubagentToolText.notYours(args.subagent));
      }

      if (Option.isNone(message)) {
        return refused(SubagentToolText.sendNeedsMessage);
      }

      const requestId = `subagent-send-${api.taskId}`;
      const { briefApprovalId: key } = named.value;

      await api.commit(async (tx) => {
        const registry = await tx.doc(SubagentsDoc, api.conversationId);
        const item = registry.items[key];

        if (item !== undefined && item.inputs[requestId] === undefined) {
          // A settled child works again: its parent is listed for the brain's count.
          await listParent(tx, api.conversationId);
          await tasks.newReporter(tx, item, {
            key,
            child: item.conversationId,
            childThreadId: item.threadId,
            requestId,
            content: message.value,
            entry: null,
            whenBusy: args.mode === "steer" ? "steer" : "followUp",
            quiet: false,
          });
        }
      }, context);

      return said(SubagentToolText.sent(named.value.threadId));
    },
  });

  const status = defineTool({
    name: "subagent_status",
    description:
      "List your subagents and what each is doing, or one of them. With wait_seconds, wait (up to 600) until one reports or asks. The result itself arrives as a note, never here.",
    parameters: Type.Object({
      subagent: Type.Optional(Type.String()),
      wait_seconds: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const wanted = textOf(args.subagent);

      const chosen = (items: ReadonlyArray<SubagentItemState>) =>
        items.filter((item) =>
          Option.match(wanted, {
            onNone: () => true,
            onSome: (name) => item.threadId === name,
          })
        );

      const registry = await api.snapshot(
        SubagentsDoc,
        api.conversationId,
        context
      );

      const now = chosen(Object.values(registry?.items ?? {}));
      const seconds = Math.min(MAX_WAIT_SECONDS, args.wait_seconds ?? 0);

      if (seconds === 0 || now.length === 0 || asking(now)) {
        return said(statusText(now));
      }

      // A bounded wait that ends early when a child settles again or asks; a restart reruns it
      // with a fresh bound.
      const before = settledCount(now);

      const later = await runWait(
        awaitDoc(api, SubagentsDoc, api.conversationId, (value) => {
          const items = chosen(Object.values(value?.items ?? {}));

          return settledCount(items) > before || asking(items)
            ? Option.some(items)
            : Option.none();
        }).pipe(
          Effect.timeoutOption(Duration.seconds(seconds)),
          Effect.map(Option.flatten)
        ),
        context
      );

      return said(statusText(Option.getOrElse(later, () => now)));
    },
  });

  const stop = defineTool({
    name: "subagent_stop",
    description:
      "Stop a subagent's current work and drop its queued messages. It stays usable; its result note says it was stopped.",
    parameters: Type.Object({ subagent: Type.String() }),
    // A repeat after a restart could stop newer work: an interrupted call reports so instead.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const named = await childNamed(api, args.subagent, context);

      if (Option.isNone(named)) {
        return refused(SubagentToolText.notYours(args.subagent));
      }

      const child = conversationOf(named.value.conversationId);
      const conversation = await api.conversation(child, context);

      await conversation?.abort(context);

      // The stopped run's held records can never be answered now (ADR 0029).
      await Effect.runPromise(
        cancelAbandonedApprovals(api, child, api.now(), "run-stopped").pipe(
          Effect.catchTag("DurableCallError", (failure) =>
            Effect.logWarning("stopped subagent left approvals pending").pipe(
              Effect.annotateLogs({
                event: "subagent_stop_cancel_failed",
                cause: failure.message,
              })
            )
          )
        ),
        { signal: context.abortSignal }
      );

      return said(SubagentToolText.stopped(named.value.threadId));
    },
  });

  const reply = defineTool({
    name: "subagent_reply",
    description:
      "Answer a question one of your subagents asked you, or escalate it to the user. Approvals are the user's and cannot be answered here.",
    parameters: Type.Object({
      subagent: Type.String(),
      request: Type.Optional(
        Type.String({
          description: "The question's id; the open one when left out.",
        })
      ),
      answer: Type.Optional(Type.String()),
      escalate: Type.Optional(
        Type.String({ description: "Why the user should answer instead." })
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const named = await childNamed(api, args.subagent, context);

      if (Option.isNone(named)) {
        return refused(SubagentToolText.notYours(args.subagent));
      }

      const child = conversationOf(named.value.conversationId);
      const request = textOf(args.request);
      const escalation = textOf(args.escalate);
      const answer = textOf(args.answer);
      const childThreadId = named.value.threadId;

      if (Option.isNone(answer) && Option.isNone(escalation)) {
        return refused(SubagentToolText.replyNeedsAnswer);
      }

      if (
        Option.exists(
          escalation,
          (reason) => reason.length > MAX_ESCALATE_REASON
        )
      ) {
        return refused(SubagentToolText.escalateTooLong(MAX_ESCALATE_REASON));
      }

      const text = await api.commit(async (tx) => {
        const meta = await tx.doc(ThreadMeta, api.conversationId);
        const { items } = await tx.doc(Approvals, child);

        // The child's questions for its parent, whatever their status: a second call, or a replay
        // after the answer committed, finds its question settled.
        const questions = Object.values(items)
          .filter(
            (record) =>
              (faults.routeApprovalToParent ||
                ((record.route === "parent" || record.escalatedAt !== null) &&
                  record.kind === "user-input")) &&
              Option.match(request, {
                onNone: () => true,
                onSome: (id) => id === record.id,
              })
          )
          .toSorted((a, b) => a.askedAt - b.askedAt);

        const record =
          questions.find(
            (found) => found.status === "pending" && found.escalatedAt === null
          ) ?? questions.at(Option.isSome(request) ? 0 : -1);

        if (record === undefined) {
          return Result.fail(SubagentToolText.noQuestionWaiting(childThreadId));
        }

        if (record.status !== "pending") {
          return Result.succeed(SubagentToolText.replyAlreadySettled);
        }

        if (record.escalatedAt !== null) {
          return Result.fail(
            SubagentToolText.replyAfterEscalation(record.id, childThreadId)
          );
        }

        if (Option.isSome(escalation)) {
          await escalateIn(tx, {
            parentConversationId: api.conversationId,
            childConversationId: child,
            approvalId: record.id,
            now: api.now(),
            why: SubagentToolText.parentEscalated(escalation.value),
          });

          return Result.succeed(SubagentToolText.replyEscalated);
        }

        const outcome = applyAnswer(
          record,
          {
            decision: "accept",
            by: { kind: "thread", threadId: ThreadId.make(meta.threadId) },
            reason: Option.none(),
            answers:
              record.payload?.type === "questions"
                ? Option.some([
                    {
                      index: 0,
                      picks: [],
                      custom: Option.getOrElse(answer, () => ""),
                    },
                  ])
                : Option.none(),
          },
          api.now()
        );

        if (outcome === "answered") {
          await markQuestion(
            tx,
            api.conversationId,
            child,
            record.id,
            "answered",
            Option.none()
          );
        }

        return Result.succeed(
          outcome === "answered"
            ? SubagentToolText.replySettled
            : SubagentToolText.replyAlreadySettled
        );
      }, context);

      return Result.match(text, { onFailure: refused, onSuccess: said });
    },
  });

  const askParent = defineTool({
    name: "ask_parent",
    description:
      "Ask the thread that started you a question and wait for its answer. Use it when the brief leaves a decision open.",
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Optional(Type.Array(Type.String())),
    }),
    replay: "safe",
    deferred: true,
    execute: async (args, api, context) => {
      const link = await linkOf(api, context);
      const question = textOf(args.question);

      if (Option.isNone(link)) {
        return refused(SubagentToolText.askOutsideSubagent);
      }

      if (Option.isNone(question)) {
        return refused(SubagentToolText.askNeedsQuestion);
      }

      const options = (args.options ?? []).filter(
        (label) => label.trim() !== ""
      );

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

      const parent = conversationOf(link.value.parentConversationId);
      const approvalId = approvalIdOf(api.taskId);
      const meta = await api.snapshot(ThreadMeta, api.conversationId, context);
      const childThreadId = meta?.threadId ?? "";

      const registry = await api.snapshot(SubagentsDoc, parent, context);
      const description = registry?.items[link.value.key]?.description ?? "";

      // Records the question; a rerun finds it.
      await api.commit(async (tx) => {
        const { items } = await tx.doc(Approvals, api.conversationId);

        if (items[approvalId] !== undefined) {
          return;
        }

        items[approvalId] = questionRecord(
          {
            approvalId,
            toolTaskId: api.taskId,
            tool: "ask_parent",
            source: "tool",
            askedAt: api.now(),
            question: question.value,
            options,
          },
          tuning.questionTtlMillis
        );

        const parentRegistry = await tx.doc(SubagentsDoc, parent);
        const item = parentRegistry.items[link.value.key];

        if (item !== undefined) {
          item.questions[approvalId] = {
            state: "pending",
            escalatedAt: null,
          };
          setStatus(item, "waiting");
        }
      }, context);

      const settled = runWait(
        approvalLedger(api).awaitSettlement.pipe(
          Effect.catchTag("ApprovalLedgerError", (failure) =>
            Effect.succeed({
              status: "cancelled" as const,
              decidedBy: Option.none(),
              reason: Option.some(failure.message),
            })
          )
        ),
        context
      );

      await routeQuestion(
        routeIo(api, context),
        {
          parent,
          child: api.conversationId,
          childThreadId,
          approvalId,
          description,
          question: question.value,
          windowMillis: tuning.questionWindowMillis,
          settled,
          offerHalted: faults.wakeStoppedParent,
        },
        context
      );

      const settlement = await settled;

      // A question that ended unanswered (its record expired) ends its parent's side too: each
      // pending mirror takes the record's status and the registry stops counting it as open.
      if (settlement.status !== "accepted") {
        await api.commit(async (tx) => {
          await endUnanswered(tx, {
            parentConversationId: parent,
            childConversationId: api.conversationId,
            approvalId,
            now: api.now(),
          });
        }, context);
      }

      return await answerOf(api, approvalId, settlement, context);
    },
  });

  const report = defineTool({
    name: "report",
    description:
      "Finish your brief: a summary of the result and how it differs from the brief (None if it does not). When the brief asked for a typed result, call submit_result with it as well.",
    parameters: Type.Object({
      summary: Type.String(),
      divergence: Type.String({
        description: "None, or how the result differs from the brief.",
      }),
      commit: Type.Optional(Type.String()),
    }),
    replay: "safe",
    deferred: true,
    execute: async (args, api, context) => {
      const remembered = await api.memo<ReportVerdict>(REPORT_MEMO, context);

      const result = (verdict: ReportVerdict): ToolExecutionResult => ({
        output: [{ type: "text", text: verdict.text }],
        isError: verdict.isError,
        control: { terminate: verdict.terminate },
      });

      if (remembered !== undefined) {
        return result(remembered);
      }

      const link = await linkOf(api, context);

      if (Option.isNone(link)) {
        return refused(SubagentToolText.reportOutsideSubagent);
      }

      const verdict = await api.commit(async (tx): Promise<ReportVerdict> => {
        const child = await tx.doc(ChildDoc, api.conversationId);

        if (child.report !== null) {
          return {
            text: SubagentToolText.alreadyReported,
            isError: false,
            terminate: true,
          };
        }

        child.report = {
          summary: Option.getOrElse(textOf(args.summary), () => ""),
          divergence: Option.getOrElse(textOf(args.divergence), () => "None"),
          // A typed payload is `submit_result`'s, kept in `cairn.result`.
          payload: null,
          commit: Option.getOrNull(textOf(args.commit)),
        };

        return {
          text: SubagentToolText.reported,
          isError: false,
          terminate: true,
        };
      }, context);

      return result(await api.memo(REPORT_MEMO, verdict, context));
    },
  });

  return {
    parent: [spawn, send, status, stop, reply],
    child: [askParent, report],
  };
};

/** The tools `offerResultTool` adds: `modelTools` replaces the filter whole, so a spawn merges them. */
const resultTools = (() => {
  const offered = offerResultTool.modelTools;

  return offered !== undefined && offered !== null && "add" in offered
    ? (offered.add ?? [])
    : [];
})();

/**
 * The tools a child's creating commit offers it: its two instead of a parent's five, and
 * `submit_result` for a typed brief (2E's rule).
 */
export const childAgentOf =
  (tools: ReturnType<typeof subagentToolSet>) =>
  (typed: boolean): AgentChange => ({
    modelTools: {
      remove: tools.parent,
      add: typed ? [...tools.child, ...resultTools] : tools.child,
    },
  });

/**
 * The tools a workflow node's child is offered (4D's hand-off): none of a parent's five, so a node
 * cannot spawn children, nor a child's two, since a node has no subagent parent to ask or report
 * to; `submit_result` for a typed node.
 */
export const nodeAgentOf =
  (tools: ReturnType<typeof subagentToolSet>) =>
  (typed: boolean): AgentChange => ({
    modelTools: {
      remove: tools.parent,
      add: typed ? resultTools : [],
    },
  });
