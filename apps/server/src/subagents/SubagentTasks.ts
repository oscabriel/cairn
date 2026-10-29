// The subagents' pi-durable tasks (ADR 0028, ADR 0030), after pi-durable's example 23 (background
// subagents) and Ultimate's reporter: each a background task owned by the parent's conversation,
// so a Stop on the parent ends neither them nor the children they serve.
//
// - Anchor (`cairn.subagent-anchor`) completes at once; a child conversation is owned by one, so
//   the parent's run is never held by its children.
// - Brief (`cairn.subagent-brief`), one per `subagent_spawn`: waits for the brief's answer. Go
//   starts the child in one commit (`startChild`): anchor, child conversation with Cairn's thread
//   identity and its `cairn.child` link, the registry item, the first reporter and the parent's
//   note that it started. Decline and Send back reach the parent as a follow-up input, or as a note
//   when the parent is halted. The briefs package (4A) moves Go into the answer itself.
// - Reporter (`cairn.subagent-reporter`), one per input to a child (the brief, `subagent_send`, a
//   user's steer typed into the child): `deliver` submits the input under its request id, mirrors
//   the child's pending records into its registry status while it works, and settles once per run
//   in one commit; `report` writes the settlement's note and decides the wake by the parent's
//   state; `wake` submits the wake and marks the settlement delivered. Note and wake request ids
//   derive from the child and the settlement's `seq`, so a rerun after `kill -9` lands each once.
//
// `SubagentFaults` breaks the delivery on purpose for the conformance suite's mutation check; the
// production layer plants none.

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
  AgentChange,
  ConversationId,
  EntryId,
  NextTaskState,
  SettledSubmissionRecord,
  TaskRuntime,
  Tx,
} from "@earendil-works/pi-durable";
import { configure, defineTask, LiveDoc } from "@earendil-works/pi-durable";
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
  renderBrief,
  renderBriefAnswer,
  renderQuestion,
  renderSettlement,
  renderWake,
  SubagentRequestIds,
} from "../brain/SubagentText.ts";
import { briefOfPayload } from "./Briefs.ts";
import {
  childThreadIdOf,
  conversationOf,
  parentHalted,
  setStatus,
  settlementOf,
} from "./Delivery.ts";
import type { SettlementState } from "./Delivery.ts";
import {
  ChildDoc,
  isLinked,
  jsonRecordOf,
  REPORT_ATTEMPTS,
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

/** Every subagent task name, for the boot repair that retries parked ones. */
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

/** One input to a child, as its reporter delivers it. */
export interface ReporterInput {
  [key: string]: JsonValue;
  /** The child's registry key (its brief's approval id). */
  key: string;
  child: number;
  childThreadId: string;
  requestId: string;
  text: string;
  whenBusy: "steer" | "followUp";
  /** A user's own steer to the child: its result is a note, with no wake. */
  quiet: boolean;
}

/** One wake a reporter submits. */
interface WakeState {
  [key: string]: JsonValue;
  requestId: string;
  text: string;
}

/** Where a reporter stands. */
type ReporterState =
  | { phase: "deliver" }
  | { phase: "report"; settlement: SettlementState }
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
  failedReport: boolean,
  now: number
): InputEnd => {
  if (failedReport) {
    return {
      outcome: "failed",
      error: `The payload did not match the result schema in ${REPORT_ATTEMPTS} attempts.`,
      usageLimit: false,
    };
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

/** Whether a wake from any child is still queued in the parent (table reads). */
const wakeQueued = async (
  tx: Tx,
  parent: ConversationId,
  registry: Readonly<SubagentsState>
): Promise<boolean> => {
  for (const item of Object.values(registry.items)) {
    for (const mark of item.settlements) {
      // oxlint-disable-next-line no-await-in-loop -- a few reads, before any table write
      const found = await tx.submissionByRequest(
        parent,
        SubagentRequestIds.wake(item.threadId, mark.seq)
      );

      if (found?.status === "queued") {
        return true;
      }
    }
  }

  return false;
};

/** What starting a child needs from outside its commit: read once, before it. */
export interface StartReads {
  /** The parent's own link, when the parent is itself a subagent. */
  readonly parentLink: Option.Option<{
    readonly depth: number;
    readonly rootThreadId: string;
  }>;
  /** The model the parent runs on, recorded as the dispatch (no role is resolved yet). */
  readonly model: Option.Option<{
    readonly provider: string;
    readonly modelId: string;
  }>;
}

/** The parts of the extension a task builds with. */
export interface TaskDependencies {
  readonly faults: SubagentFaultSet;
  /** The agent change a child gets at creation: its tools instead of a parent's. */
  readonly childAgent: () => AgentChange;
}

/** The task definitions, closed over the extension's faults and the child's agent change. */
export const subagentTaskSet = (dependencies: TaskDependencies) => {
  const { faults } = dependencies;

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
   * Settles one input once its run ended, in one commit: one settlement per run (an input another
   * reporter's run already answered settles nothing), built from the child's `report` when it made
   * one, else from its last answer with `not reported`.
   */
  const settle = async (
    tx: Tx,
    parent: ConversationId,
    input: ReporterInput,
    settled: SettledSubmissionRecord,
    now: number
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

    const live = await tx.doc(LiveDoc, child);
    const running = live.run !== undefined;

    if (
      answerEntry !== null &&
      item.settlements.some((mark) => mark.answerEntry === answerEntry)
    ) {
      settleUnlessWorking(item, running, unadmitted);

      return completed();
    }

    const link = await tx.doc(ChildDoc, child);
    const report = Option.fromNullOr(link.report);

    const failedReport =
      Option.isNone(report) && link.attempts >= REPORT_ATTEMPTS;

    const end = endOf(settled, failedReport, now);
    const seq = item.settlements.length + 1;

    const settlement: SettlementState = {
      subagent: input.childThreadId,
      seq,
      outcome: end.outcome,
      summary: Option.match(report, {
        onNone: () =>
          answer === undefined ? cutShort : entryText(answer.model),
        onSome: (found) => found.summary,
      }),
      divergence: Option.match(report, {
        onNone: () => "not reported",
        onSome: (found) => found.divergence,
      }),
      payload: Option.match(report, {
        onNone: () => null,
        onSome: (found) => found.payload,
      }),
      commit: Option.match(report, {
        onNone: () => null,
        onSome: (found) => found.commit,
      }),
      branch: null,
      turns: { thisRun: 1, total: seq },
      error: end.error,
      usageLimit: end.usageLimit,
    };

    item.settlements.push({
      seq,
      outcome: end.outcome,
      answerEntry,
      reportedAt: now,
    });

    // The run's report and attempts are spent; the next run starts with none.
    link.report = null;
    link.attempts = 0;
    settleUnlessWorking(item, running, unadmitted);

    return { status: "running", checkpoint: { phase: "report", settlement } };
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

        const submission = await child.submit(
          {
            type: "input",
            requestId: input.requestId,
            content: input.text,
            whenBusy: input.whenBusy,
          },
          context
        );

        const stop = await followChild(runtime, input, context);
        const settled = await withCleanup(submission.wait(context), stop);

        await runtime.commit(
          async (tx) =>
            await settle(
              tx,
              runtime.conversationId,
              input,
              settled,
              runtime.now()
            ),
          context
        );
      },
      report: async (task, runtime, context) => {
        const { input } = task;
        const { settlement } = task.state.checkpoint;
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
              !input.quiet &&
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

    await configure(tx, child.id, dependencies.childAgent());

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

    const model = Option.getOrElse(reads.model, () => ({
      provider: "unknown",
      modelId: "unknown",
    }));

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
          thinkingLevel: null,
          via: "literal",
          skipped: [],
          family: "other",
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

    registry.items[approvalId] = item;

    await newReporter(tx, item, {
      key: approvalId,
      child: child.id,
      childThreadId,
      requestId: SubagentRequestIds.brief(approvalId),
      text: renderBrief(brief.value),
      whenBusy: "followUp",
      quiet: false,
    });

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
          };

          await runtime.commit(async (tx) => {
            await startChild(tx, runtime, parent, approvalId, reads);

            return completed();
          }, context);

          return;
        }

        const told =
          Option.isSome(record) &&
          (record.value.status === "declined" ||
            record.value.status === "revised");

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
          const text = renderBriefAnswer(brief.value.title, {
            kind: record.status === "revised" ? "revised" : "declined",
            reason: Option.fromNullOr(record.reason),
          });

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
