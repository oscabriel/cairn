// Roles retired from the brain store (ADR 0052). A store a brain wrote before the retirement, its
// documents at their old versions and holding roles (`role`, role names where a spec goes, an
// envelope's `roles`, a resolution's `role`, `via`, `skipped` and `family`, `roleOverrides`), opens
// under today's definitions and reads as today's shapes: every document decodes with its protocol
// schema (a document a client could not read fails the read), a role name reads as no model named, a
// spec `role` held is the `model`, and the rest of each record is as it was; the spend feed, which
// reads a workflow run's child threads from the ledger, reads them too. Each rewrite is safe to run
// twice, and leaves a document already in today's shape as it is.
//
// Kept under `brain/`, where pi-durable may be imported in a test (S42).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId } from "@cairn/protocol/Ids";
import { ApprovalsDocument, GoalDocument } from "@cairn/protocol/Policy";
import { SubagentsDocument } from "@cairn/protocol/Subagents";
import { WorkflowsDocument } from "@cairn/protocol/Workflows";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import {
  createRegistry,
  createSession,
  defineDoc,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";

import { GoalDoc } from "../verdicts/GoalDocs.ts";
import type { JudgeRefState } from "../verdicts/GoalDocs.ts";
import { Brain } from "./Brain.ts";
import { Approvals, ThreadReceipt } from "./CairnDocs.ts";
import {
  retireApprovalRoles,
  retireGoalRoles,
  retireSubagentRoles,
  retireWorkflowRoles,
} from "./RolesRetired.ts";
import { SpendFeed } from "./SpendFeed.ts";
import { SubagentsDoc } from "./SubagentDocs.ts";
import { WorkflowsDoc } from "./WorkflowsDoc.ts";

const context = BACKGROUND_CONTEXT;

/** A document definition as the brain before ADR 0052 had it: `kind` at `version`, no `migrate`. */
const before = (kind: string, version: number) =>
  defineDoc<JsonObject>({
    kind,
    version,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
    checkpointWhen: () => false,
  });

const ApprovalsV2 = before("cairn.approvals", 2);

const WorkflowsV1 = before("cairn.workflows", 1);

const SubagentsV1 = before("cairn.subagents", 1);

const GoalV1 = before("cairn.goal", 1);

const BUDGET = {
  maxListMicros: null,
  maxTokens: null,
  maxTurns: null,
  maxMinutes: null,
  planGuard: null,
  warnAt: 0.8,
};

/** A role table binding, as `roleOverrides` held them. */
const BINDING = {
  model: { provider: "opencode-go", modelId: "gpt-6-luna" },
  thinkingLevel: null,
  fallbacks: [],
  note: null,
};

/** A brief frozen before roles were removed, naming `role` and `model` as it did then. */
const oldBrief = (role: string | null, model: JsonObject | null) => ({
  type: "brief",
  title: "Count the files",
  task: "Count the files in the project root.",
  why: "",
  avoid: [],
  doneWhen: [
    {
      text: "The judge agrees.",
      judge: { kind: "model", spec: "@judge", rubric: "A count." },
    },
  ],
  workspace: "shared",
  base: null,
  writes: [],
  role,
  model,
  thinking: null,
  mode: "full-access",
  mayCommit: false,
  budget: BUDGET,
  resultSchema: null,
  wake: "answer",
  decisions: [],
  roleOverrides: {},
});

/** A workflow's launch frozen before roles were removed: call sites and an envelope keyed by role. */
const OLD_LAUNCH = {
  type: "workflow",
  workflowId: "wf-7",
  name: "council",
  description: "Two advisors and a judge",
  phases: [],
  scriptHash: "sha256-abc",
  scriptRef: "task-7",
  args: { advisors: ["@worker", "@scout"], judge: "@judge" },
  callSites: [
    {
      spec: "@scout",
      label: "Advisor",
      phase: null,
      schemaName: null,
      readonly: true,
      arms: "host",
      maxCount: 2,
    },
    {
      spec: "opencode-go/gpt-6-luna",
      label: "Judge",
      phase: null,
      schemaName: null,
      readonly: true,
      arms: "host",
      maxCount: 1,
    },
  ],
  nodes: { count: 3, unbounded: false },
  estimate: null,
  envelope: {
    scriptHash: "sha256-abc",
    maxNodes: 3,
    maxConcurrent: 2,
    roles: [
      { spec: "@scout", readonly: true, arms: "host" },
      { spec: "opencode-go/gpt-6-luna:high", readonly: false, arms: "host" },
    ],
    modes: ["full-access"],
    writes: [],
    budget: BUDGET,
  },
  roleOverrides: { "@judge": BINDING },
};

/** A version 2 record with `payload`, decided by the user, and `answer`. */
const oldRecord = (
  id: string,
  tool: string,
  kind: string,
  payload: JsonObject,
  answer: JsonObject | null = null
) => ({
  id,
  toolTaskId: 7,
  tool,
  kind,
  summary: id,
  status: "declined",
  askedAt: 1000,
  expiresAt: 2000,
  answeredAt: 1500,
  run: null,
  executorRequestId: null,
  payload,
  answer,
  decidedBy: { kind: "user" },
  reason: null,
  route: "user",
  escalatedAt: null,
  supersedes: null,
  started: null,
  briefHash: null,
  mirrorOf: null,
});

const OLD_APPROVALS = {
  items: {
    "brief-role": oldRecord(
      "brief-role",
      "subagent_spawn",
      "brief",
      oldBrief("@scout:high", null)
    ),
    "brief-spec": oldRecord(
      "brief-spec",
      "subagent_spawn",
      "brief",
      oldBrief("opencode-go/gpt-6-luna:high", null)
    ),
    "brief-ref": oldRecord(
      "brief-ref",
      "subagent_spawn",
      "brief",
      oldBrief(null, { provider: "opencode-go", modelId: "gpt-6-luna" })
    ),
    launch: oldRecord("launch", "workflow_plan", "brief", OLD_LAUNCH, {
      decision: "accept_sample",
      answers: null,
      note: null,
      launch: { budget: BUDGET, roleOverrides: { "@scout": BINDING } },
    }),
    criteria: oldRecord("criteria", "goal_criteria", "criteria", {
      type: "criteria",
      criteria: [
        {
          text: "The count is right.",
          judge: { kind: "model", spec: "@judge:high", rubric: "A count." },
        },
      ],
    }),
  },
};

/** The thread whose conversation holds the old documents. */
const OLD_THREAD = "01900000-0000-7000-8000-000000000001";

/** The child thread a node of the old ledger ran. */
const NODE_CHILD = "01900000-0000-7000-8000-000000000003";

/** A ledger node written before roles were removed, naming `role`. */
const oldNode = (id: string, role: string, childThreadId: string | null) => ({
  id,
  workflowId: "wf-7",
  key: null,
  label: id,
  phase: null,
  index: 0,
  requestId: `wf-wf-7-${id}`,
  briefId: "launch",
  role,
  provider: "faux",
  modelId: "scripted",
  effort: null,
  readonly: true,
  arms: "host",
  state: "settled",
  stage: "answered",
  childThreadId,
  conversationId: null,
  submissionId: null,
  nestedTaskId: 9,
  attempt: 1,
  schemaAttempts: 0,
  receipt: null,
  result: null,
  resultSummary: null,
  refusal: null,
  held: null,
  startedAt: 1,
  endedAt: 2,
  error: null,
});

const OLD_WORKFLOWS = {
  items: {
    "wf-7": {
      id: "wf-7",
      name: "council",
      description: "Two advisors and a judge",
      phases: [],
      scriptHash: "sha256-abc",
      scriptRef: "task-7",
      args: null,
      state: "finished",
      outcome: { kind: "complete" },
      approvalId: "launch",
      decidedBy: { kind: "user" },
      decidedAt: 1,
      sample: null,
      budget: BUDGET,
      estimate: null,
      codemodeTaskId: 8,
      startedAt: 1,
      endedAt: 3,
      result: null,
      nodes: {
        "n-1": oldNode("n-1", "@worker", NODE_CHILD),
        "n-2": oldNode("n-2", "faux/scripted:high", null),
      },
      log: {},
      spent: { tokens: 0, listMicros: 0, unpricedTokens: 0 },
      softAt: null,
      spentAt: null,
    },
  },
};

const OLD_SUBAGENTS = {
  items: {
    "brief-role": {
      threadId: "01900000-0000-7000-8000-000000000002",
      conversationId: 2,
      anchorTaskId: 7,
      briefApprovalId: "brief-role",
      description: "Count the files",
      dispatch: {
        spec: "@worker",
        resolved: {
          spec: "@worker",
          role: "@worker",
          model: { provider: "claude-bridge", modelId: "claude-opus-5-5" },
          thinkingLevel: "medium",
          via: "fallback",
          skipped: [
            {
              model: { provider: "anthropic", modelId: "claude-opus-5-5" },
              reason: "missing_credential",
            },
          ],
          family: "anthropic",
          priced: true,
        },
        previewed: null,
        dispatchedAt: 1_761_000_000_000,
      },
      isolation: "shared",
      worktree: null,
      status: "settled",
      wake: "answer",
      settlements: [],
      runs: [],
      delivered: 0,
      questions: {},
      inputs: {},
    },
  },
};

const MODEL_JUDGE = { kind: "model", spec: "@judge", rubric: "A count." };

const OLD_GOAL = {
  objective: "Count the files",
  criteria: [
    {
      id: "c1",
      text: "The count is right.",
      judge: MODEL_JUDGE,
      state: "met",
      verdict: {
        at: 2,
        ok: true,
        judge: MODEL_JUDGE,
        evidence: {
          exit: null,
          tail: null,
          sha: null,
          model: "opencode-go/gpt-6-luna",
          note: null,
        },
        runId: "run-1",
      },
      tries: 1,
      changedAt: 1,
    },
  ],
  envelope: null,
  closedAt: null,
  closedBy: null,
};

/** Opens a Session over the store at `file`, runs `use`, and closes it. */
const withSession = async <A>(
  file: string,
  use: (session: ReturnType<typeof createSession>) => Promise<A>
): Promise<A> => {
  const session = createSession(await openNodeSqliteStorage(file));

  try {
    return await use(session);
  } finally {
    await session.close(context);
  }
};

/** A store as the brain before ADR 0052 wrote it: one conversation holding every old document. */
const writeOldStore = async (file: string): Promise<ConversationId> =>
  await withSession(
    file,
    async (session) =>
      await session.commit(async (tx) => {
        const conversation = await tx.createConversation({
          ownership: { kind: "ownerless" },
        });

        await tx.doc(ThreadReceipt, OLD_THREAD, {
          conversationId: conversation.id,
        });
        Object.assign(
          await tx.doc(ApprovalsV2, conversation.id),
          structuredClone(OLD_APPROVALS)
        );
        Object.assign(
          await tx.doc(WorkflowsV1, conversation.id),
          structuredClone(OLD_WORKFLOWS)
        );
        Object.assign(
          await tx.doc(SubagentsV1, conversation.id),
          structuredClone(OLD_SUBAGENTS)
        );
        Object.assign(
          await tx.doc(GoalV1, conversation.id),
          structuredClone(OLD_GOAL)
        );

        return conversation.id;
      }, context)
  );

/** Writes the old store in a fresh directory, runs `use` on its file, and removes it. */
const withOldStore = async <A>(
  use: (file: string, conversation: ConversationId) => Promise<A>
): Promise<A> => {
  const root = mkdtempSync(path.join(tmpdir(), "cairn-roles-retired-"));

  try {
    const file = path.join(root, "store.sqlite");

    return await use(file, await writeOldStore(file));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const decodeApprovals = Schema.decodeUnknownSync(ApprovalsDocument);

const decodeWorkflows = Schema.decodeUnknownSync(WorkflowsDocument);

const decodeSubagents = Schema.decodeUnknownSync(SubagentsDocument);

const decodeGoal = Schema.decodeUnknownSync(GoalDocument);

/**
 * Writes the old store, opens it under today's definitions, and reads every document as stored;
 * each must decode with its protocol schema, as a client reads it, or the read throws.
 */
const readOldStore = async () =>
  await withOldStore(async (file, conversation) => {
    const read = await withSession(file, async (session) => ({
      approvals: await session.snapshot(Approvals, conversation, context),
      workflows: await session.snapshot(WorkflowsDoc, conversation, context),
      subagents: await session.snapshot(SubagentsDoc, conversation, context),
      goal: await session.snapshot(GoalDoc, conversation, context),
    }));

    decodeApprovals(read.approvals);
    decodeWorkflows(read.workflows);
    decodeSubagents(read.subagents);
    decodeGoal(read.goal);

    return read;
  });

/** A model judge that runs on the goal thread's model. */
const THREAD_JUDGE: JudgeRefState = {
  kind: "model",
  spec: null,
  rubric: "A count.",
};

describe("a store written before roles were retired", () => {
  it.effect(
    "reads a brief's role as its model: a role name as none, a spec as named",
    () =>
      Effect.promise(async () => {
        const { approvals } = await readOldStore();
        const payloadOf = (id: string) => approvals?.items[id]?.payload;

        // A `model` from before specs (a `ModelRef`) is named as one when `role` named none.
        assert.deepStrictEqual(
          ["brief-role", "brief-spec", "brief-ref"].map((id) => {
            const payload = payloadOf(id);

            return payload?.type === "brief" ? payload.model : "no brief";
          }),
          [null, "opencode-go/gpt-6-luna:high", "opencode-go/gpt-6-luna"]
        );

        const brief = payloadOf("brief-role");

        assert.deepStrictEqual(
          brief?.type === "brief" ? brief.doneWhen[0]?.judge : null,
          THREAD_JUDGE
        );
        assert.notProperty(brief, "role");
        assert.notProperty(brief, "roleOverrides");
      })
  );

  it.effect(
    "reads a launch's envelope as models, without what a role name keyed or overrode",
    () =>
      Effect.promise(async () => {
        const { approvals } = await readOldStore();
        const record = approvals?.items.launch;
        const launch = record?.payload;

        assert.deepStrictEqual(
          launch?.type === "workflow"
            ? [
                launch.envelope.models.map((entry) => entry.spec),
                launch.callSites.map((site) => site.spec),
              ]
            : null,
          [["opencode-go/gpt-6-luna:high"], ["opencode-go/gpt-6-luna"]]
        );
        assert.notProperty(launch, "roleOverrides");
        assert.deepStrictEqual(record?.answer?.launch, { budget: BUDGET });

        const criteria = approvals?.items.criteria?.payload;

        assert.deepStrictEqual(
          criteria?.type === "criteria" ? criteria.criteria[0]?.judge : null,
          THREAD_JUDGE
        );
      })
  );

  it.effect(
    "reads a ledger node's role as its model, and the rest as it was",
    () =>
      Effect.promise(async () => {
        const { workflows } = await readOldStore();
        const nodes = workflows?.items["wf-7"]?.nodes ?? {};

        assert.deepStrictEqual(
          Object.values(nodes).map((node) => [node.id, node.model, node.state]),
          [
            ["n-1", null, "settled"],
            ["n-2", "faux/scripted:high", "settled"],
          ]
        );
        assert.notProperty(nodes["n-1"], "role");
      })
  );

  it.effect(
    "reads a dispatch's role name as none, its resolution as the model it ran on",
    () =>
      Effect.promise(async () => {
        const { subagents } = await readOldStore();

        assert.deepStrictEqual(subagents?.items["brief-role"]?.dispatch, {
          spec: null,
          resolved: {
            spec: "claude-bridge/claude-opus-5-5",
            model: { provider: "claude-bridge", modelId: "claude-opus-5-5" },
            thinkingLevel: "medium",
            priced: true,
          },
          previewed: null,
          dispatchedAt: 1_761_000_000_000,
        });
      })
  );

  it.effect("reads a goal's role-named judges as its thread's model", () =>
    Effect.promise(async () => {
      const { goal } = await readOldStore();
      const criterion = goal?.criteria[0];

      assert.deepStrictEqual(
        [criterion?.judge, criterion?.verdict?.judge],
        [THREAD_JUDGE, THREAD_JUDGE]
      );
      assert.strictEqual(criterion?.state, "met");
    })
  );

  it.live("gives the spend feed a workflow run's child threads", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() =>
          mkdtempSync(path.join(tmpdir(), "cairn-roles-retired-"))
        ),
        (dir) =>
          Effect.sync(() => {
            rmSync(dir, { recursive: true, force: true });
          })
      );

      const file = path.join(root, "store.sqlite");

      yield* Effect.promise(async () => await writeOldStore(file));

      const storage = yield* Effect.promise(
        async () => await openNodeSqliteStorage(file)
      );

      const harness = yield* Effect.acquireRelease(
        Effect.promise(
          async () =>
            await Harness.open(
              storage,
              { models: createModels(), registry: createRegistry() },
              context
            )
        ),
        (open) =>
          Effect.promise(async () => {
            await open.close(context);
          })
      );

      const feed = yield* SpendFeed.pipe(
        Effect.provide(
          SpendFeed.layer.pipe(
            Layer.provide(
              Layer.mock(Brain)({
                session: Effect.succeed({ harness, storage, generation: 1 }),
                subscribeCommits: () => Effect.void,
                now: () => 0,
              })
            )
          )
        )
      );

      assert.deepStrictEqual(
        yield* feed.workflowThreads(ThreadId.make(OLD_THREAD), "wf-7"),
        Option.some([ThreadId.make(NODE_CHILD)])
      );
    }).pipe(Effect.scoped)
  );
});

describe("the role rewrites", () => {
  const cases = [
    ["cairn.approvals", retireApprovalRoles, OLD_APPROVALS],
    ["cairn.workflows", retireWorkflowRoles, OLD_WORKFLOWS],
    ["cairn.subagents", retireSubagentRoles, OLD_SUBAGENTS],
    ["cairn.goal", retireGoalRoles, OLD_GOAL],
  ] as const;

  it("are safe to run twice, and leave today's shape and their input as they are", () => {
    for (const [kind, retire, old] of cases) {
      const input = structuredClone(old);
      const once = retire(input);

      assert.deepStrictEqual(retire(once), once, `${kind} twice`);
      assert.deepStrictEqual(input, old, `${kind} input untouched`);
    }
  });
});
