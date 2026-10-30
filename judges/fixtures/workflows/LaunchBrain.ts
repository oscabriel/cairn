// The scripted brain the workflow surfaces judge (judges/workflow-surfaces.ts, plan 6F) drives: a
// parent that proposes a workflow through a scripted `workflow_plan`, which asks the launch
// approval as a brief (the scripted harness's `askBrief`) and, on Go or Run on 1 first, plays the
// workflow's dispatch ledger (`cairn.workflows`) node by node, phase by phase, as the brain's own
// ledger reads; and a `WorkflowStops` over that play, so the work panel's Stop on a node or on the
// whole workflow reaches it. No script runs, no provider is called, and nothing is billed.
//
// - The parent (the seeded thread): a message "launch <role> <tag>" is answered with one
//   `workflow_plan` call; once the tool answered it says "Tool said: <the tool's text>". Anything
//   else is answered "Noted.".
// - The launch (`LAUNCH_CARD_WORDS`): `review-fan <tag>`, two phases, Read (three readers as <role>) then
//   Judge (one judge as <role>), an estimate with tokens and no list price, a $2.00 budget.
//   Decline and Send back run nothing and say so; Go runs four nodes, Run on 1 first two (the first
//   reader and the judge).
// - A reader settles 300 ms after it starts, except under a tag starting "steps", where it keeps
//   running until the judge calls `release` with its label or a Stop ends it. The judge node
//   starts once every reader ended and settles 300 ms later. A stop of the whole workflow stops
//   every live node and ends the workflow `stopped`; a node's stop ends that node alone.

import { NotFound } from "@cairn/protocol/Errors";
import { ApprovalId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { WorkflowLaunch } from "@cairn/protocol/Policy";
import { WorkflowLaunch as WorkflowLaunchSchema } from "@cairn/protocol/Policy";
import { RoleSpec } from "@cairn/protocol/Roles";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { NodeRecord, WorkflowRecord } from "@cairn/protocol/Workflows";
import {
  NOTHING_SPENT,
  WORKFLOWS_DOCUMENT,
  WorkflowsDocument,
} from "@cairn/protocol/Workflows";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import {
  Clock,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";

import { messageText } from "../../../apps/server/src/brain/CommitFeed.ts";
import {
  ScriptedModel,
  ScriptedTools,
  scriptedAnswer,
} from "../../../apps/server/src/brain/ScriptedHarness.ts";
import type {
  ScriptedToolApi,
  ScriptedToolResult,
} from "../../../apps/server/src/brain/ScriptedHarness.ts";
import { jsonRecordOf } from "../../../apps/server/src/subagents/SubagentDocs.ts";
import { WorkflowStops } from "../../../apps/server/src/workflows/WorkflowStop.ts";
import type { CairnBrain } from "../parity/CairnApp.ts";
import { PARITY_THREAD_ID } from "../parity/CairnApp.ts";

/** The readers of the Read phase, in order, and the judge of the Judge phase. */
export const READERS = ["Read src/a.ts", "Read src/b.ts", "Read src/c.ts"];

export const JUDGE = "Judge the reads";

/** What the card should show for the launch, by line. */
export const LAUNCH_CARD_WORDS = {
  nodes: "4",
  budget: "$2.00 at API list price",
  covers: "Up to 4 nodes, 3 at once",
  phases: "Read, Judge",
  readSite: "Read · <role> · reads only · up to 3",
  judgeSite: "Judge · <role> · reads only · once",
} as const;

/** What a settled node used: tokens, no list price (the faux model has none). */
const NODE_TOKENS = 2100;

const SETTLE_MS = 300;

// The judge releases a held reader from the same process; a set of labels, read by the play.
const released = new Set<string>();

/** Lets a held reader settle. */
export const release = (label: string): void => {
  released.add(label);
};

/** Holds every reader of a "steps" launch again, for the judge's next width. */
export const holdAll = (): void => {
  released.clear();
};

/** A Stop asked of a running workflow: the whole of it, or one node; `applied` once played. */
interface StopAsk {
  readonly nodeId: string | null;
  applied: boolean;
}

/** The workflows this brain is playing, by id, with the stops asked of each. */
const playing = new Map<string, Array<StopAsk>>();

/** Workflows this brain played to their end. */
const ended = new Set<string>();

/** How each launch ended, by its tag: what the judge reads in-process. */
export interface LaunchOutcome {
  readonly decision: string;
  readonly ran: number;
}

export const outcomes = new Map<string, LaunchOutcome>();

const toolText = (message: Message): string =>
  message.role === "toolResult"
    ? message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
    : "";

const ASK = /^launch (?<role>@[a-z-]+) (?<tag>\S+)$/u;

const parentAnswer = (messages: ReadonlyArray<Message>, now: number) => {
  const last = messages.at(-1);

  if (last === undefined) {
    return scriptedAnswer("Noted.", now);
  }

  if (last.role === "toolResult") {
    return scriptedAnswer(`Tool said: ${toolText(last)}`, now);
  }

  const asked = ASK.exec(messageText(last).trim());

  if (asked === null) {
    return scriptedAnswer("Noted.", now);
  }

  return fauxAssistantMessage(
    [
      fauxToolCall(
        "workflow_plan",
        { role: asked.groups?.role ?? "", tag: asked.groups?.tag ?? "" },
        { id: `plan-${String(now)}` }
      ),
    ],
    { stopReason: "toolUse" }
  );
};

const LaunchModel = Layer.succeed(
  ScriptedModel,
  ScriptedModel.of({
    answer: (request) =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        request.threadId === PARITY_THREAD_ID
          ? parentAnswer(request.messages, now)
          : scriptedAnswer("Noted.", now)
      ),
  })
);

/** The launch a `workflow_plan` call proposes. */
export const launchOf = (
  workflowId: string,
  role: string,
  tag: string
): WorkflowLaunch => {
  const spec = RoleSpec.make(role);

  return {
    type: "workflow",
    workflowId,
    name: `review-fan ${tag}`,
    description: `Three readers read src, then a judge weighs what they found (${tag}).`,
    phases: [
      { title: "Read", detail: null },
      { title: "Judge", detail: null },
    ],
    scriptHash: `hash-${workflowId}`,
    scriptRef: `entry-${workflowId}`,
    args: { paths: ["src/a.ts", "src/b.ts", "src/c.ts"] },
    callSites: [
      {
        spec,
        label: "Read",
        phase: "Read",
        schemaName: null,
        readonly: true,
        arms: "host",
        maxCount: 3,
      },
      {
        spec,
        label: "Judge",
        phase: "Judge",
        schemaName: "Verdict",
        readonly: true,
        arms: "host",
        maxCount: 1,
      },
    ],
    nodes: { count: 4, unbounded: false },
    estimate: {
      nodes: 4,
      tokensLow: 6000,
      tokensHigh: 12_000,
      listMicrosLow: null,
      listMicrosHigh: null,
      basis: "4 nodes; no history yet.",
    },
    envelope: {
      scriptHash: `hash-${workflowId}`,
      maxNodes: 4,
      maxConcurrent: 3,
      roles: [{ spec, readonly: true, arms: "host" }],
      modes: [],
      writes: [],
      budget: { ...DEFAULT_BUDGET, maxListMicros: Micros.make(2_000_000) },
    },
    roleOverrides: {},
  };
};

const encodeLaunch = Schema.encodeSync(WorkflowLaunchSchema);

const encodeLedger = Schema.encodeSync(WorkflowsDocument);

const nodeOf = (
  workflowId: string,
  index: number,
  label: string,
  phase: string,
  role: string,
  at: number
): NodeRecord => {
  const id = `n-${workflowId}-${String(index)}`;

  return {
    id,
    workflowId,
    key: null,
    label,
    phase,
    index,
    requestId: `wf-${workflowId}-${id}`,
    briefId: null,
    role: RoleSpec.make(role),
    provider: "faux",
    modelId: "scripted",
    effort: null,
    readonly: true,
    arms: "host",
    state: "running",
    stage: "submitted",
    childThreadId: null,
    conversationId: null,
    submissionId: null,
    nestedTaskId: null,
    attempt: 1,
    schemaAttempts: 0,
    receipt: null,
    result: null,
    resultSummary: null,
    refusal: null,
    held: null,
    startedAt: at,
    endedAt: null,
    error: null,
  };
};

const settled = (node: NodeRecord, at: number): NodeRecord => ({
  ...node,
  state: "settled",
  stage: "answered",
  endedAt: at,
  resultSummary: `${node.label}: read.`,
  receipt: {
    answerEntry: null,
    input: 1500,
    output: 600,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: NODE_TOKENS,
    listMicros: null,
    toolCalls: 1,
    durationMs: Math.max(0, at - (node.startedAt ?? at)),
  },
});

const stoppedNode = (node: NodeRecord, at: number): NodeRecord => ({
  ...node,
  state: "stopped",
  endedAt: at,
});

/** One launch played: the record the ledger holds, rewritten whole on every change. */
const play = Effect.fnUntraced(function* (
  api: ScriptedToolApi,
  launch: WorkflowLaunch,
  approvalId: string,
  sample: boolean,
  hold: boolean
) {
  const now = yield* Clock.currentTimeMillis;
  const role = launch.envelope.roles[0]?.spec ?? "@worker";
  const asks: Array<StopAsk> = [];

  let record: WorkflowRecord = {
    id: launch.workflowId,
    name: launch.name,
    description: launch.description,
    phases: launch.phases,
    scriptHash: launch.scriptHash,
    scriptRef: launch.scriptRef,
    args: launch.args,
    state: "running",
    outcome: null,
    approvalId: ApprovalId.make(approvalId),
    decidedBy: { kind: "user" },
    decidedAt: now,
    sample: sample ? 1 : null,
    budget: launch.envelope.budget,
    estimate: launch.estimate,
    codemodeTaskId: null,
    startedAt: now,
    endedAt: null,
    result: null,
    nodes: {},
    log: {},
    spent: NOTHING_SPENT,
    softAt: null,
    spentAt: null,
  };

  const write = () =>
    api.writeDocument(
      WORKFLOWS_DOCUMENT,
      jsonRecordOf(encodeLedger({ items: { [record.id]: record } })) ?? {
        items: {},
      }
    );

  const setNode = (node: NodeRecord) => {
    record = { ...record, nodes: { ...record.nodes, [node.id]: node } };
  };

  const spentNow = () => {
    const tokens = Object.values(record.nodes).reduce(
      (sum, node) => sum + (node.receipt?.totalTokens ?? 0),
      0
    );

    record = {
      ...record,
      spent: {
        tokens,
        listMicros: Micros.make(0),
        unpricedTokens: tokens,
      },
    };
  };

  /** Plays the stops asked so far; whether the whole workflow was stopped. */
  const applyStops = (at: number): boolean => {
    let whole = false;

    for (const ask of asks) {
      if (ask.applied) {
        continue;
      }

      for (const node of Object.values(record.nodes)) {
        const live = node.state === "running";

        if (live && (ask.nodeId === null || ask.nodeId === node.id)) {
          setNode(stoppedNode(node, at));
        }
      }

      whole ||= ask.nodeId === null;
    }

    return whole;
  };

  const markApplied = () => {
    for (const ask of asks) {
      ask.applied = true;
    }
  };

  const end = Effect.fnUntraced(function* (stopped: boolean) {
    const at = yield* Clock.currentTimeMillis;

    record = {
      ...record,
      state: stopped ? "stopped" : "finished",
      outcome: stopped
        ? { kind: "partial", reason: "stopped" }
        : { kind: "complete" },
      endedAt: at,
    };
    yield* write();
    markApplied();
    playing.delete(record.id);
    ended.add(record.id);
  });

  /** Whether every node of `ids` ended. */
  const allEnded = (ids: ReadonlyArray<string>): boolean =>
    ids.every((id) => record.nodes[id]?.state !== "running");

  playing.set(record.id, asks);
  yield* write();

  /** Runs one phase's nodes until each ended; whether the whole workflow was stopped. */
  const phase = Effect.fnUntraced(function* (
    labels: ReadonlyArray<string>,
    title: string,
    first: number,
    held: boolean
  ) {
    const at = yield* Clock.currentTimeMillis;
    const ids: Array<string> = [];

    for (const [offset, label] of labels.entries()) {
      const node = nodeOf(record.id, first + offset, label, title, role, at);

      ids.push(node.id);
      setNode(node);
    }

    yield* write();

    for (;;) {
      yield* Effect.sleep(Duration.millis(50));

      const tick = yield* Clock.currentTimeMillis;
      const whole = applyStops(tick);

      for (const id of ids) {
        const node = record.nodes[id];

        if (
          node?.state === "running" &&
          (held
            ? released.has(node.label)
            : tick - (node.startedAt ?? tick) >= SETTLE_MS)
        ) {
          setNode(settled(node, tick));
        }
      }

      spentNow();
      yield* write();
      markApplied();

      if (whole) {
        return true;
      }

      if (allEnded(ids)) {
        return false;
      }
    }
  });

  const readers = sample ? READERS.slice(0, 1) : READERS;

  const stoppedInRead = yield* phase(readers, "Read", 0, hold);

  const stopped =
    stoppedInRead || (yield* phase([JUDGE], "Judge", readers.length, false));

  yield* end(stopped);

  const nodes = Object.values(record.nodes);
  const done = nodes.filter((node) => node.state === "settled").length;
  const stops = nodes.filter((node) => node.state === "stopped").length;

  return {
    ran: nodes.length,
    text: `Workflow ${record.name} ${stopped ? "stopped" : "finished"}: ran ${String(nodes.length)} of ${String(launch.nodes.count)} nodes, ${String(done)} done, ${String(stops)} stopped.`,
  };
});

const planTool = Effect.fnUntraced(function* (
  call: ToolCall,
  api: ScriptedToolApi
) {
  const { role, tag } = call.arguments;

  if (!Predicate.isString(role) || !Predicate.isString(tag)) {
    return { text: "workflow_plan takes a role and a tag", isError: true };
  }

  const workflowId = `wf-${call.id}`;
  const launch = launchOf(workflowId, role, tag);
  const payload = jsonRecordOf(encodeLaunch(launch));

  if (payload === null) {
    return { text: "the launch did not encode", isError: true };
  }

  const answered = yield* api.askBrief(
    `Launch workflow ${launch.name}`,
    payload
  );

  if (Option.isNone(answered)) {
    return { text: "The launch's record is gone.", isError: true };
  }

  const record = answered.value;
  const decision = record.answer?.decision ?? record.status;

  if (record.status !== "accepted") {
    outcomes.set(tag, { decision, ran: 0 });

    return {
      text:
        record.status === "revised"
          ? `Sent back ${launch.name}: ${record.reason ?? ""}. Nothing ran.`
          : `Launch ${launch.name} ${record.status}${record.reason === null ? "" : `: ${record.reason}`}. Nothing ran.`,
      isError: false,
    };
  }

  const ran = yield* play(
    api,
    launch,
    record.id,
    decision === "accept_sample",
    tag.startsWith("steps")
  );

  outcomes.set(tag, { decision, ran: ran.ran });

  return { text: ran.text, isError: false };
});

const LaunchTools = Layer.succeed(
  ScriptedTools,
  ScriptedTools.of({
    run: (call, api): Effect.Effect<ScriptedToolResult> =>
      call.name === "workflow_plan"
        ? planTool(call, api)
        : Effect.succeed({
            text: `Tool ${call.name} not found`,
            isError: true,
          }),
  })
);

/** Asks a Stop of a workflow this brain plays and waits until the play applied it. */
const askStop = (
  threadId: ThreadId,
  workflowId: string,
  nodeId: string | null
): Effect.Effect<void, NotFound> => {
  const asks = playing.get(workflowId);

  // A stop of a workflow that ended succeeds and changes nothing, as `WorkflowStops` answers.
  if (asks === undefined) {
    return ended.has(workflowId)
      ? Effect.void
      : Effect.fail(
          new NotFound({
            message: `Workflow ${workflowId} is not in thread ${threadId}'s ledger.`,
            resource: "workflow",
            id: workflowId,
          })
        );
  }

  const ask: StopAsk = { nodeId, applied: false };

  asks.push(ask);

  return Effect.gen(function* () {
    while (!ask.applied && playing.has(workflowId)) {
      yield* Effect.sleep(Duration.millis(25));
    }
  });
};

const LaunchStops = Layer.succeed(
  WorkflowStops,
  WorkflowStops.of({
    stop: (input) => askStop(input.threadId, input.workflowId, null),
    stopNode: (input) =>
      askStop(input.threadId, input.workflowId, input.nodeId),
  })
);

/** The workflow surfaces judge's brain: the proposing parent, its launches and their stops. */
export const launchBrain: CairnBrain = {
  model: LaunchModel,
  tools: LaunchTools,
  stops: LaunchStops,
};
