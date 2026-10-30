// A workflow's budget and meter (ADR 0036, workflows note W5, "Budgets and meters"): what a run
// spent, where it stands against the budget its launch granted, the admission check every node
// makes, the soft and hard lines, the reactor that acts on them and the stopper task it creates.
//
// - **Spend** is summed over every node's child conversation, from the child itself: tokens from
//   its `pi.usage` totals, dollars priced one response at a time from its `pi.assistant` entries
//   (a tier is chosen by one request's input, so a sum is never priced; ADR 0036). A response that
//   recorded a cost keeps it; one that did not (the Claude bridge) is priced from the catalog, the
//   bridge at its `anthropic` twin's list price; a model with no price adds its tokens to
//   `unpricedTokens`, never zero dollars. Tokens `pi.usage` holds that no response accounts for (a
//   compaction) are unpriced too. A node's subtree is its child alone: a node's child has no
//   delegating tool (`nodeChildTools`), so nothing hangs below it.
// - **The meter** is recomputed inside a commit of the launching conversation: in the reserve
//   commit of every node (so admission reads the meter of that instant), in every settle, and by a
//   running node while its child answers, on each `pi.usage` change of that child and at the
//   minutes line, at most once a second per workflow. It writes `spent` only when it moved.
// - **The lines.** The budget is the launch's (the answer's edit when the user changed it), raised
//   by each accepted `budget_raise` record of this workflow. `maxTokens` counts every token,
//   `maxListMicros` priced tokens only, `maxTurns` model responses over every node, `maxMinutes`
//   time since the workflow began. The first commit whose meter reaches `warnAt` of any limit sets
//   `softAt` and emits `workflow.budget.soft`; the first whose meter reaches a limit sets `spentAt`
//   and emits `workflow.budget.spent`, in the same commit, so each fires once however the brain
//   dies around the crossing. A raise accepted after `spentAt` opens a new epoch: the next meter
//   commit clears both marks, and they fire again at the raised lines.
// - **Admission.** A node's reserve commit refuses it `budget_spent` while the run is at its line;
//   the decision is the row, so a replay reads the row and never the clock.
// - **At the line** the reactor (`cairn.workflow-budget`) writes the `budget_stopped` notice, asks a
//   raise as a pending `budget_raise` record (the approval push carries it to the phone), and
//   creates the stopper task, all in the commit that moves its cursor. The stopper aborts the child
//   conversation of every running node until none runs; each node's tool then settles its row
//   `stopped` and the script sees `null`. Settled results stay; the run ends `partial`,
//   `budget_spent`. At the soft line the reactor writes the `budget_warning` notice.
// - **Usage holds.** A node whose child's run ends on a provider's usage limit is `held`, not
//   failed: it waits for the limit's reset (or `HOLD_RETRY_MILLIS` when the provider names none),
//   then sends its child one input to go on, and other nodes keep running (WorkflowTools.ts).
//
// Ported in intent from pi-subagents' `usageBudget` (github.com/nicobailon/pi-subagents) and the
// research's `budget {usd, tokens}`; the code is Cairn's.

import { setTimeout as sleep } from "node:timers/promises";

import { EntryId } from "@cairn/protocol/Ids";
import type { ModelRef } from "@cairn/protocol/Models";
import { BudgetRaisePayload } from "@cairn/protocol/Policy";
import { Budget } from "@cairn/protocol/Spend";
import type { Budget as BudgetType } from "@cairn/protocol/Spend";
import { NOTICE_ENTRY_KIND } from "@cairn/protocol/Thread";
import type { NoticeEntryData } from "@cairn/protocol/Thread";
import type { JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, Message, Models } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  Cursor,
  EntryRecord,
  Tx,
} from "@earendil-works/pi-durable";
import { defineTask, InboxDoc, UsageDoc } from "@earendil-works/pi-durable";
import { Option, Schema } from "effect";

import { Approvals, UNDECIDED } from "../brain/CairnDocs.ts";
import type { ApprovalRecord, JsonRecord } from "../brain/CairnDocs.ts";
import { emit, isEventObject, reactor } from "../brain/Events.ts";
import type { Reactor } from "../brain/Events.ts";
import { applyNote, hasQueuedReset, readNote } from "../brain/NoteAdmission.ts";
import { piEntryId } from "../brain/PiIds.ts";
import {
  catalogLookupOf,
  listMicrosOf,
  priceOf,
} from "../models/ModelPrice.ts";
import { conversationOf } from "../subagents/Delivery.ts";
import { isWorkflowEnded, usageTotals, WorkflowsDoc } from "./WorkflowDocs.ts";
import type {
  BudgetState,
  NodeItemState,
  WorkflowItemState,
} from "./WorkflowDocs.ts";

/** The least time between two meter commits of one workflow from its running nodes. */
export const METER_INTERVAL_MILLIS = 1000;

/** How often the stopper looks again for a node that still runs. */
export const STOP_RECHECK_MILLIS = 250;

/** How long a node held by a usage limit that names no reset waits before it tries again. */
export const HOLD_RETRY_MILLIS = 15 * 60_000;

/** The most times one node is held before it fails. */
export const MAX_HOLDS = 20;

/** The stopper task's name. */
export const STOPPER_TASK = "cairn.workflow-budget-stop";

/** The budget reactor's name: stable, its cursor is stored under it. */
export const BUDGET_REACTOR = "cairn.workflow-budget";

/** The tool name a raise record carries (ADR 0036; the same as a thread scope's raise). */
export const RAISE_TOOL = "budget_raise";

/** How long a raise stays answerable: nothing waits on it, so a week, as a thread's. */
const RAISE_TTL_MILLIS = 7 * 24 * 3_600_000;

/** The entry kind pi-durable writes each provider response under. */
const ASSISTANT_ENTRY = "pi.assistant";

/** How many entries one page of a child's scan reads. */
const SCAN_PAGE = 256;

/** The approval id of the raise asked when workflow `workflowId` reached its line at `epoch`. */
export const workflowRaiseIdOf = (workflowId: string, epoch: number) =>
  `budget-raise-${workflowId}-${String(epoch)}`;

/** The request id of a workflow's notice at one line and epoch, so it lands once. */
const noticeIdOf = (
  workflowId: string,
  line: "soft" | "spent",
  epoch: number
) => `${workflowId}-budget-${line}-${String(epoch)}`;

// Spend of one child.

/** What one node's child spent. */
export interface NodeSpend {
  /** Every token its `pi.usage` holds. */
  readonly tokens: number;
  /** The list price of its priced responses, in micros. */
  readonly listMicros: number;
  /** Tokens with no price: unpriced responses and usage no response accounts for. */
  readonly unpricedTokens: number;
  /** Model responses. */
  readonly turns: number;
  /** Responses that had a price; none means the node is unpriced. */
  readonly pricedResponses: number;
}

/** Nothing spent. */
export const NO_SPEND: NodeSpend = {
  tokens: 0,
  listMicros: 0,
  unpricedTokens: 0,
  turns: 0,
  pricedResponses: 0,
};

/** The responses of one child read so far: their sums and the last entry read. */
export interface ScannedResponses {
  readonly after: number;
  readonly responseTokens: number;
  readonly listMicros: number;
  readonly unpricedTokens: number;
  readonly turns: number;
  readonly pricedResponses: number;
}

const NOTHING_SCANNED: ScannedResponses = {
  after: 0,
  responseTokens: 0,
  listMicros: 0,
  unpricedTokens: 0,
  turns: 0,
  pricedResponses: 0,
};

const isAssistant = (
  message: Message | undefined
): message is AssistantMessage => message?.role === "assistant";

/** A token count as a whole, non-negative number. */
const count = (value: number) => Math.max(0, Math.round(value));

/** One response's price in micros: what it recorded, else the catalog's; none when unpriced. */
export const responsePrice = (
  models: Pick<Models, "getModel">,
  message: AssistantMessage
): Option.Option<number> => {
  const { usage } = message;

  if (usage.cost.total > 0) {
    return Option.some(Math.round(usage.cost.total * 1_000_000));
  }

  const model: ModelRef = {
    provider: message.provider,
    modelId: message.model,
  };

  return listMicrosOf(priceOf(model, catalogLookupOf(models)), {
    input: count(usage.input),
    output: count(usage.output),
    cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite),
    cacheWrite1h: count(usage.cacheWrite1h ?? 0),
  });
};

/** `scanned` with one more entry, when the entry is a response. */
const addResponse = (
  scanned: ScannedResponses,
  entry: EntryRecord,
  models: Pick<Models, "getModel">
): ScannedResponses => {
  const message = entry.model?.[0];

  if (entry.kind !== ASSISTANT_ENTRY || !isAssistant(message)) {
    return { ...scanned, after: entry.id };
  }

  const tokens = message.usage.totalTokens;
  const price = responsePrice(models, message);

  return {
    after: entry.id,
    responseTokens: scanned.responseTokens + tokens,
    listMicros: scanned.listMicros + Option.getOrElse(price, () => 0),
    unpricedTokens:
      scanned.unpricedTokens + (Option.isSome(price) ? 0 : tokens),
    turns: scanned.turns + 1,
    pricedResponses: scanned.pricedResponses + (Option.isSome(price) ? 1 : 0),
  };
};

/**
 * The responses of each child read so far, in memory: entries never change once committed, so a
 * meter reads only what a child appended since it last looked. A restart reads each child once.
 */
export class SpendCache {
  readonly #scanned = new Map<number, ScannedResponses>();

  /** Reads `child`'s responses after the last one this cache saw. Table reads only. */
  async responses(
    tx: Tx,
    child: ConversationId,
    models: Pick<Models, "getModel">
  ): Promise<ScannedResponses> {
    let scanned = this.#scanned.get(child) ?? NOTHING_SCANNED;
    let page: Cursor | undefined;

    do {
      // oxlint-disable-next-line no-await-in-loop -- pages are read in order on the commit's line
      const read = await tx.scanEntries(
        {
          conversationId: child,
          minEntryId: piEntryId(EntryId.make(scanned.after + 1)),
          order: "ascending",
        },
        SCAN_PAGE,
        page
      );

      for (const entry of read.items) {
        scanned = addResponse(scanned, entry, models);
      }

      page = read.next;
    } while (page !== undefined);

    this.#scanned.set(child, scanned);

    return scanned;
  }
}

/** A child's spend from its responses (read first) and its `pi.usage` document. */
export const spendOf = (
  scanned: ScannedResponses,
  usage: Parameters<typeof usageTotals>[0]
): NodeSpend => {
  const tokens = Math.max(
    usageTotals(usage).totalTokens,
    scanned.responseTokens
  );

  return {
    tokens,
    listMicros: scanned.listMicros,
    unpricedTokens: scanned.unpricedTokens + (tokens - scanned.responseTokens),
    turns: scanned.turns,
    pricedResponses: scanned.pricedResponses,
  };
};

/** Whether a node has a child whose spend counts: every node that made one. */
const childOf = (node: Readonly<NodeItemState>): Option.Option<number> =>
  Option.fromNullOr(node.conversationId);

/**
 * Every node's spend in `row`, by node id: the table reads a meter needs, made before any table
 * write of the commit. Its documents are read after, through `tx.doc`.
 */
export const readSpends = async (
  tx: Tx,
  row: Readonly<WorkflowItemState>,
  models: Pick<Models, "getModel">,
  cache: SpendCache
): Promise<Map<string, NodeSpend>> => {
  const scanned = new Map<string, ScannedResponses>();

  for (const node of Object.values(row.nodes)) {
    const child = childOf(node);

    if (Option.isSome(child)) {
      scanned.set(
        node.id,
        // oxlint-disable-next-line no-await-in-loop -- table reads in order on the commit's line
        await cache.responses(tx, conversationOf(child.value), models)
      );
    }
  }

  const spends = new Map<string, NodeSpend>();

  for (const [nodeId, responses] of scanned) {
    const child = row.nodes[nodeId]?.conversationId ?? 0;

    spends.set(
      nodeId,
      // oxlint-disable-next-line no-await-in-loop -- document reads on the commit's line
      spendOf(responses, await tx.doc(UsageDoc, conversationOf(child)))
    );
  }

  return spends;
};

// Where a run stands.

/** What a workflow's meter reads: the row's `spent` plus responses. */
export interface Meter {
  readonly tokens: number;
  readonly listMicros: number;
  readonly unpricedTokens: number;
  readonly turns: number;
}

/** The sum of every node's spend. */
export const meterOf = (spends: ReadonlyMap<string, NodeSpend>): Meter => {
  let tokens = 0;
  let listMicros = 0;
  let unpricedTokens = 0;
  let turns = 0;

  for (const spend of spends.values()) {
    tokens += spend.tokens;
    listMicros += spend.listMicros;
    unpricedTokens += spend.unpricedTokens;
    turns += spend.turns;
  }

  return { tokens, listMicros, unpricedTokens, turns };
};

/** A limit a workflow budget enforces. */
export type WorkflowLimit = "tokens" | "dollars" | "turns" | "minutes";

/** Where a run stands against its budget. */
export interface Standing {
  /** The first limit reached, if any. */
  readonly reached: Option.Option<WorkflowLimit>;
  /** Whether any limit is at or past its warning fraction. */
  readonly warn: boolean;
  /** The highest fraction of any limit used. */
  readonly fraction: number;
}

/** How far along each limit a run is, as fractions of the limit, in the order they are named. */
const fractionsOf = (
  budget: Readonly<BudgetState>,
  meter: Meter,
  elapsedMillis: number
): ReadonlyArray<readonly [WorkflowLimit, number]> => {
  const fractions: Array<readonly [WorkflowLimit, number]> = [];

  if (budget.maxTokens !== null) {
    fractions.push(["tokens", meter.tokens / budget.maxTokens]);
  }

  if (budget.maxListMicros !== null) {
    fractions.push([
      "dollars",
      budget.maxListMicros === 0
        ? Number.POSITIVE_INFINITY
        : meter.listMicros / budget.maxListMicros,
    ]);
  }

  if (budget.maxTurns !== null) {
    fractions.push(["turns", meter.turns / budget.maxTurns]);
  }

  if (budget.maxMinutes !== null) {
    fractions.push(["minutes", elapsedMillis / (budget.maxMinutes * 60_000)]);
  }

  return fractions;
};

/** Where a run with `meter`, `elapsedMillis` after it began, stands against `budget`. */
export const standingOf = (
  budget: Readonly<BudgetState>,
  meter: Meter,
  elapsedMillis: number
): Standing => {
  const fractions = fractionsOf(budget, meter, elapsedMillis);
  const reached = fractions.find(([, fraction]) => fraction >= 1);
  const fraction = Math.max(0, ...fractions.map(([, used]) => used));

  return {
    reached: Option.map(Option.fromUndefinedOr(reached), ([limit]) => limit),
    warn: fractions.length > 0 && fraction >= budget.warnAt,
    fraction,
  };
};

// The budget as raised.

const decodeRaise = Schema.decodeUnknownOption(BudgetRaisePayload);

const encodeBudget = Schema.encodeSync(Budget);

/** A budget as a document holds it. */
const budgetJson = (budget: BudgetType): BudgetState => {
  const encoded = encodeBudget(budget);

  return {
    maxListMicros: encoded.maxListMicros,
    maxTokens: encoded.maxTokens,
    maxTurns: encoded.maxTurns,
    maxMinutes: encoded.maxMinutes,
    planGuard: encoded.planGuard === null ? null : { ...encoded.planGuard },
    warnAt: encoded.warnAt,
  };
};

/** A raise of this workflow: its record and its payload. */
interface Raise {
  readonly record: Readonly<ApprovalRecord>;
  readonly payload: BudgetRaisePayload;
}

/** Every raise record asked for workflow `workflowId`, oldest first. */
const raisesOf = (
  approvals: Readonly<Record<string, ApprovalRecord>>,
  workflowId: string
): ReadonlyArray<Raise> =>
  Object.values(approvals)
    .filter((record) => record.tool === RAISE_TOOL)
    .flatMap((record) =>
      Option.toArray(
        Option.map(
          Option.filter(
            decodeRaise(record.payload),
            (payload) => payload.scope === workflowId
          ),
          (payload) => ({ record, payload })
        )
      )
    )
    .toSorted((a, b) => a.record.askedAt - b.record.askedAt);

/** A run's budget as raised and its epoch, the count of raises the user accepted. */
export interface Effective {
  readonly budget: BudgetState;
  readonly epoch: number;
  /** When the last accepted raise was answered; none before the first. */
  readonly raisedAt: Option.Option<number>;
}

/** The budget `row` runs under: its own, replaced by each accepted raise of it, oldest first. */
export const effectiveBudget = (
  row: Readonly<Pick<WorkflowItemState, "id" | "budget">>,
  approvals: Readonly<Record<string, ApprovalRecord>>
): Effective => {
  let budget: BudgetState = { ...row.budget };
  let epoch = 0;
  let raisedAt = Option.none<number>();

  for (const raise of raisesOf(approvals, row.id)) {
    if (raise.record.status === "accepted") {
      budget = budgetJson(raise.payload.to);
      epoch += 1;
      raisedAt = Option.fromNullOr(raise.record.answeredAt);
    }
  }

  return { budget, epoch, raisedAt };
};

/** Whether `row` is at its line now: marked and not since raised. */
export const budgetStopped = (
  row: Readonly<Pick<WorkflowItemState, "id" | "budget" | "spentAt">>,
  approvals: Readonly<Record<string, ApprovalRecord>>
): boolean => {
  if (row.spentAt === null) {
    return false;
  }

  const { raisedAt } = effectiveBudget(row, approvals);

  return !Option.exists(raisedAt, (at) => at >= (row.spentAt ?? 0));
};

/** A line a raise proposes: unchanged below it, else the larger of double it and the use plus it. */
const raiseLine = (line: number | null, used: number) =>
  line === null || used < line ? line : Math.max(line * 2, used + line);

/** The budget a raise proposes: each reached limit to the larger of double it and the spend plus it. */
export const raisedBudget = (
  budget: Readonly<BudgetState>,
  meter: Meter,
  elapsedMillis: number
): BudgetState => {
  const minutes = Math.ceil(elapsedMillis / 60_000);

  return {
    ...budget,
    maxTokens: raiseLine(budget.maxTokens, meter.tokens),
    maxListMicros: raiseLine(budget.maxListMicros, meter.listMicros),
    maxTurns: raiseLine(budget.maxTurns, meter.turns),
    maxMinutes: raiseLine(budget.maxMinutes, minutes),
  };
};

/** When a running row reaches its `maxMinutes` line, on the Harness clock; none without one. */
export const minutesLineOf = (
  row: Readonly<WorkflowItemState> | undefined
): Option.Option<number> =>
  row === undefined || row.startedAt === null || row.budget.maxMinutes === null
    ? Option.none()
    : Option.some(row.startedAt + row.budget.maxMinutes * 60_000);

// The meter's commit.

/** What a meter commit is given: the launching conversation, its row, and what it read. */
export interface MeterInput {
  readonly conversationId: ConversationId;
  readonly row: WorkflowItemState;
  readonly approvals: Readonly<Record<string, ApprovalRecord>>;
  readonly spends: ReadonlyMap<string, NodeSpend>;
  readonly at: number;
}

/** The data both line events carry. */
const lineData = (
  input: MeterInput,
  meter: Meter,
  effective: Effective,
  limit: Option.Option<WorkflowLimit>
): JsonValue => ({
  workflowId: input.row.id,
  conversationId: input.conversationId,
  epoch: effective.epoch,
  limit: Option.getOrNull(limit),
  spent: { ...meter },
  budget: { ...effective.budget },
});

/** What a meter commit found: where the run stands, and whether it is at its line now. */
export interface Metered {
  readonly standing: Standing;
  /** `spentAt` is set and no raise has been accepted since: admission refuses. */
  readonly stopped: boolean;
}

/**
 * Writes the meter into `input.row` and fires each line once (module header). Call it after the
 * commit's table reads (`readSpends`); it may append events.
 */
export const applyMeter = async (
  tx: Tx,
  input: MeterInput
): Promise<Metered> => {
  const { row, at } = input;
  const meter = meterOf(input.spends);
  const effective = effectiveBudget(row, input.approvals);
  const elapsed = Math.max(0, at - (row.startedAt ?? at));
  const standing = standingOf(effective.budget, meter, elapsed);

  if (
    row.spent.tokens !== meter.tokens ||
    row.spent.listMicros !== meter.listMicros ||
    row.spent.unpricedTokens !== meter.unpricedTokens
  ) {
    row.spent = {
      tokens: meter.tokens,
      listMicros: meter.listMicros,
      unpricedTokens: meter.unpricedTokens,
    };
  }

  if (isWorkflowEnded(row.state)) {
    return { standing, stopped: row.spentAt !== null };
  }

  // A raise accepted since the run reached its line opens a new epoch.
  if (
    row.spentAt !== null &&
    Option.exists(effective.raisedAt, (raised) => raised >= (row.spentAt ?? 0))
  ) {
    row.spentAt = null;
    row.softAt = null;
  }

  if (standing.warn && row.softAt === null) {
    row.softAt = at;

    await emit(tx, {
      name: "workflow.budget.soft",
      data: lineData(input, meter, effective, standing.reached),
      at,
      context: Option.none(),
    });
  }

  if (Option.isSome(standing.reached) && row.spentAt === null) {
    row.spentAt = at;

    await emit(tx, {
      name: "workflow.budget.spent",
      data: lineData(input, meter, effective, standing.reached),
      at,
      context: Option.none(),
    });
  }

  return { standing, stopped: row.spentAt !== null };
};

/**
 * One meter commit of workflow `workflowId` in `conversationId`: reads every node's spend, then
 * writes the meter and fires its lines. Nothing for a workflow that is not in the ledger.
 */
export const meterCommit = async (
  tx: Tx,
  conversationId: ConversationId,
  workflowId: string,
  at: number,
  models: Pick<Models, "getModel">,
  cache: SpendCache
): Promise<Option.Option<Metered>> => {
  const ledger = await tx.doc(WorkflowsDoc, conversationId);
  const approvals = await tx.doc(Approvals, conversationId);
  const row = ledger.items[workflowId];

  if (row === undefined) {
    return Option.none();
  }

  const spends = await readSpends(tx, row, models, cache);

  return Option.some(
    await applyMeter(tx, {
      conversationId,
      row,
      approvals: approvals.items,
      spends,
      at,
    })
  );
};

// The stopper.

/** What the stopper aborts: each node of `row` still running with a child. */
export const runningChildren = (
  row: Readonly<WorkflowItemState>
): ReadonlyArray<number> =>
  Object.values(row.nodes).flatMap((node) =>
    (node.state === "running" || node.state === "held") &&
    node.conversationId !== null
      ? [node.conversationId]
      : []
  );

/** Nodes of `row` that have not ended. */
const liveNodes = (row: Readonly<WorkflowItemState>) =>
  Object.values(row.nodes).filter(
    (node) =>
      node.state === "running" ||
      node.state === "held" ||
      node.state === "reserved"
  );

/** Resolves after `millis`, or at once when `signal` aborts. */
const pause = async (millis: number, signal: AbortSignal): Promise<void> => {
  await sleep(millis, null, { signal }).catch(() => null);
};

/**
 * The stopper (`cairn.workflow-budget-stop`): created once by the budget reactor in the commit that
 * handles `workflow.budget.spent`, a background task of the launching conversation. It aborts the
 * child conversation of every node still running, and looks again until none runs, since a node
 * that sent its input just after an abort would start its child again; every node tool then sees
 * the run at its line and settles `stopped`. A rerun after `kill -9` aborts again, which changes
 * nothing for a child already idle. Last, it marks the run `partial`, `budget_spent`, unless the
 * run ended already (its watcher writes the same outcome).
 */
export const BudgetStopper = defineTask<
  { workflowId: string },
  { phase: "stop" },
  null
>({
  name: STOPPER_TASK,
  version: 1,
  initial: () => ({ phase: "stop" }),
  phases: {
    stop: async (task, runtime, context) => {
      const { workflowId } = task.input;

      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- one look per round
        const ledger = await runtime.snapshot(
          WorkflowsDoc,
          runtime.conversationId,
          context
        );

        const row = ledger?.items[workflowId];

        if (row === undefined || liveNodes(row).length === 0) {
          break;
        }

        for (const child of runningChildren(row)) {
          // oxlint-disable-next-line no-await-in-loop -- aborts in order
          const handle = await runtime.conversation(
            conversationOf(child),
            context
          );

          // oxlint-disable-next-line no-await-in-loop
          await handle?.abort(context);
        }

        // oxlint-disable-next-line no-await-in-loop
        await pause(STOP_RECHECK_MILLIS, runtime.signal);
        runtime.signal.throwIfAborted();
      }

      await runtime.commit(async (tx) => {
        const ledger = await tx.doc(WorkflowsDoc, runtime.conversationId);
        const row = ledger.items[workflowId];

        if (row !== undefined && !isWorkflowEnded(row.state)) {
          row.outcome = { kind: "partial", reason: "budget_spent" };
        }

        return {
          status: "terminal",
          outcome: { status: "completed", result: null },
        };
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

// Notices and the raise.

/** Micros as dollars to the cent. */
const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/** The words a line's notice shows: what was used of what. */
const limitText = (
  limit: WorkflowLimit,
  meter: Meter,
  budget: Readonly<BudgetState>
): string => {
  const texts: Record<WorkflowLimit, () => string> = {
    tokens: () =>
      `${meter.tokens.toLocaleString("en-US")} of ${(budget.maxTokens ?? 0).toLocaleString("en-US")} tokens`,
    dollars: () =>
      `${dollars(meter.listMicros)} of ${dollars(budget.maxListMicros ?? 0)} at list price`,
    turns: () =>
      `${String(meter.turns)} of ${String(budget.maxTurns ?? 0)} model turns`,
    minutes: () => `its ${String(budget.maxMinutes ?? 0)} minutes`,
  };

  return texts[limit]();
};

/**
 * Appends a display-only `cairn.notice` to `conversationId` under `requestId`, once: at once when
 * no reset is queued (pi-durable appends a display-only entry mid-run too), else admitted as a note
 * is. Reads first, so call it before the handler's first table write.
 */
const appendNotice = async (
  tx: Tx,
  conversationId: ConversationId,
  requestId: string,
  data: NoticeEntryData
): Promise<void> => {
  const reads = await readNote(tx, conversationId, requestId);

  if (reads.existing !== undefined) {
    return;
  }

  const draft = { kind: NOTICE_ENTRY_KIND, data: { ...data } };
  const inbox = await tx.doc(InboxDoc, conversationId);

  if (hasQueuedReset(inbox)) {
    await applyNote(tx, conversationId, requestId, reads, draft);

    return;
  }

  const appended = await tx.appendEntry(conversationId, draft);

  await tx.createSubmission({
    conversationId,
    requestId,
    type: "write",
    status: "done",
    entry: appended.id,
  });
};

/** A line event's data, as the meter wrote it. */
interface LineEvent {
  readonly workflowId: string;
  readonly conversationId: ConversationId;
  readonly epoch: number;
  readonly limit: Option.Option<WorkflowLimit>;
  readonly meter: Meter;
  readonly budget: BudgetState;
}

const LineEventData = Schema.Struct({
  workflowId: Schema.String,
  conversationId: Schema.Int,
  epoch: Schema.Int,
  limit: Schema.NullOr(
    Schema.Literals(["tokens", "dollars", "turns", "minutes"])
  ),
  spent: Schema.Struct({
    tokens: Schema.Finite,
    listMicros: Schema.Finite,
    unpricedTokens: Schema.Finite,
    turns: Schema.Finite,
  }),
  budget: Budget,
});

const decodeLine = Schema.decodeUnknownOption(LineEventData);

/** Reads a line event's data; throws (the event stays pending, the status shows it) when malformed. */
const lineOf = (data: JsonValue): LineEvent => {
  const decoded = isEventObject(data) ? decodeLine(data) : Option.none();

  return Option.getOrThrowWith(
    Option.map(decoded, (line) => ({
      workflowId: line.workflowId,
      conversationId: conversationOf(line.conversationId),
      epoch: line.epoch,
      limit: Option.fromNullOr(line.limit),
      meter: line.spent,
      budget: budgetJson(line.budget),
    })),
    () =>
      new Error(
        "A workflow budget event's data is not the meter's. It stays pending; repair the entry."
      )
  );
};

/** The pending raise record a line asks, keyed by its epoch so it is asked once. */
const raiseRecord = (
  line: LineEvent,
  name: string,
  at: number,
  elapsedMillis: number
): ApprovalRecord => {
  const payload: JsonRecord = {
    type: "budget-raise",
    scope: line.workflowId,
    from: { ...line.budget },
    to: raisedBudget(line.budget, line.meter, elapsedMillis),
  };

  return {
    id: workflowRaiseIdOf(line.workflowId, line.epoch),
    toolTaskId: 0,
    tool: RAISE_TOOL,
    kind: "tool-call",
    summary: `Raise the budget of workflow ${name}?`,
    status: "pending",
    askedAt: at,
    expiresAt: at + RAISE_TTL_MILLIS,
    answeredAt: null,
    run: null,
    executorRequestId: null,
    ...UNDECIDED,
    payload,
  };
};

/** At the soft line: the warning notice. */
const onSoft = async (tx: Tx, line: LineEvent, _at: number): Promise<void> => {
  const ledger = await tx.doc(WorkflowsDoc, line.conversationId);
  const row = ledger.items[line.workflowId];
  const name = row?.name ?? line.workflowId;
  const limit = Option.getOrElse(line.limit, (): WorkflowLimit => "tokens");

  await appendNotice(
    tx,
    line.conversationId,
    noticeIdOf(line.workflowId, "soft", line.epoch),
    {
      reason: "budget_warning",
      text: `Workflow ${name} has used ${limitText(limit, line.meter, line.budget)}.`,
    }
  );
};

/** At the line: the stopped notice, the raise, and the stopper task, in this one commit. */
const onSpent = async (tx: Tx, line: LineEvent, at: number): Promise<void> => {
  const ledger = await tx.doc(WorkflowsDoc, line.conversationId);
  const approvals = await tx.doc(Approvals, line.conversationId);
  const row = ledger.items[line.workflowId];

  if (row === undefined) {
    return;
  }

  const limit = Option.getOrElse(line.limit, (): WorkflowLimit => "tokens");
  const raiseId = workflowRaiseIdOf(line.workflowId, line.epoch);
  const elapsed = Math.max(0, at - (row.startedAt ?? at));

  await appendNotice(
    tx,
    line.conversationId,
    noticeIdOf(line.workflowId, "spent", line.epoch),
    {
      reason: "budget_stopped",
      text: `Workflow ${row.name} stopped at ${limitText(limit, line.meter, line.budget)}. Its running nodes were stopped; raise the budget to let it start more.`,
    }
  );

  if (!isWorkflowEnded(row.state) && approvals.items[raiseId] === undefined) {
    approvals.items[raiseId] = raiseRecord(line, row.name, at, elapsed);
  }

  await tx.createTask(
    BudgetStopper,
    { workflowId: line.workflowId },
    {
      ownership: { kind: "conversation" },
      conversationId: line.conversationId,
      background: true,
    }
  );
};

/**
 * The budget reactor (`cairn.workflow-budget`, from `now`: its stopper reaches into running work,
 * so a deploy that adds it does not replay old lines). Hand-off: listed in `ReactorSet.ts`.
 */
export const workflowBudgetReactor: Reactor = reactor(
  BUDGET_REACTOR,
  { events: ["workflow.budget.soft", "workflow.budget.spent"], from: "now" },
  async (tx, event) => {
    const line = lineOf(event.data);

    const handle = event.name === "workflow.budget.spent" ? onSpent : onSoft;

    await handle(tx, line, event.at);
  }
);

// The end of a run.

/** Cancels this workflow's raise still pending: an ended run starts nothing, so it has no answer. */
export const cancelPendingRaises = (
  approvals: Record<string, ApprovalRecord>,
  workflowId: string,
  at: number
): void => {
  for (const raise of raisesOf(approvals, workflowId)) {
    const record = approvals[raise.record.id];

    if (record?.status === "pending") {
      record.status = "cancelled";
      record.answeredAt = at;
      record.decidedBy = { kind: "system", why: "run-stopped" };
      record.reason = "The workflow ended before the raise was answered.";
    }
  }
};
