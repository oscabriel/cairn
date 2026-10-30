import type { Brief, Question, WorkflowLaunch } from "@cairn/protocol/Policy";
import { RoleSpec } from "@cairn/protocol/Roles";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  approvalDetail,
  briefLines,
  budgetText,
  judgeText,
  requestKindWord,
  requestTitle,
  workflowLines,
} from "./PendingCard.ts";
import { RequestBody } from "./PendingRequests.ts";

const scout = RoleSpec.make("@scout");

const brief: Brief = {
  type: "brief",
  title: "Count the files",
  task: "Count the TypeScript files under src.",
  why: "To size the port.",
  avoid: ["editing files", "network calls"],
  doneWhen: [
    { text: "The parent accepts the result.", judge: { kind: "user" } },
    {
      text: "Tests pass",
      judge: {
        kind: "command",
        argv: ["pnpm", "test"],
        expectExit: 0,
        timeoutSec: 60,
      },
    },
  ],
  workspace: "worktree",
  base: null,
  writes: ["src/count"],
  role: scout,
  model: null,
  thinking: null,
  mode: "auto-accept-edits",
  mayCommit: false,
  budget: { ...DEFAULT_BUDGET, maxTurns: 40 },
  resultSchema: null,
  wake: "answer",
  decisions: [],
};

const question: Question = {
  header: "Database",
  question: "Which database?",
  options: [],
  multiSelect: false,
  allowCustomAnswer: true,
};

describe("the request card's words", () => {
  it("names each body's kind and title", () => {
    const approval = RequestBody.Approval({
      summary: "bash: ls",
      payload: Option.none(),
    });

    assert.strictEqual(requestKindWord(approval), "Approval");
    assert.strictEqual(requestTitle({ tool: "bash" }, approval), "Allow bash?");

    const one = RequestBody.Question({ questions: [question] });
    const two = RequestBody.Question({ questions: [question, question] });

    assert.strictEqual(requestTitle({ tool: "ask_user" }, one), "Database");
    assert.strictEqual(requestTitle({ tool: "ask_user" }, two), "2 questions");

    const briefBody = RequestBody.Brief({ payload: brief });

    assert.strictEqual(requestKindWord(briefBody), "Brief");
    assert.strictEqual(
      requestTitle({ tool: "subagent_spawn" }, briefBody),
      "Count the files"
    );
  });

  it("reads a brief in the card's order, with Avoid only when it has any", () => {
    assert.deepStrictEqual(briefLines(brief), [
      ["Do", "Count the TypeScript files under src."],
      ["Why", "To size the port."],
      ["Avoid", "editing files; network calls"],
      [
        "Judged by",
        "The parent accepts the result. (judged by you); Tests pass (judged by the command `pnpm test` exits 0)",
      ],
      ["Where", "A worktree from the parent's HEAD; writes src/count"],
      ["Who", "@scout, Auto-accept edits"],
      ["Budget", "40 turns"],
    ]);

    assert.deepStrictEqual(
      briefLines({ ...brief, avoid: [] }).map(([label]) => label),
      ["Do", "Why", "Judged by", "Where", "Who", "Budget"]
    );
  });

  it("says each limit of a budget, and No limit for none", () => {
    const budget: Budget = {
      maxListMicros: Micros.make(2_500_000),
      maxTokens: 120_000,
      maxTurns: null,
      maxMinutes: 30,
      planGuard: {
        provider: "claude-bridge",
        windowId: "five_hour",
        maxUsedFraction: 0.5,
      },
      warnAt: 0.8,
    };

    assert.strictEqual(
      budgetText(budget),
      "$2.50 at API list price, 120,000 tokens, 30 min, 50% of the claude-bridge plan window"
    );
    assert.strictEqual(budgetText(DEFAULT_BUDGET), "No limit");
  });

  it("names a model judge by its spec", () => {
    assert.strictEqual(
      judgeText({ kind: "model", spec: scout, rubric: "Is it right?" }),
      "a model (@scout)"
    );
  });

  it("reads a workflow launch with its node count, marked when the dry run hit a cap", () => {
    const launch: WorkflowLaunch = {
      type: "workflow",
      workflowId: "wf-1",
      name: "Council",
      description: "Five reviewers, one verdict.",
      phases: [
        { title: "Review", detail: null },
        { title: "Verdict", detail: null },
      ],
      scriptHash: "abc",
      scriptRef: "entry-1",
      args: null,
      callSites: [],
      nodes: { count: 5, unbounded: true },
      estimate: null,
      envelope: {
        scriptHash: "abc",
        maxNodes: 5,
        maxConcurrent: 2,
        roles: [],
        modes: [],
        writes: [],
        budget: DEFAULT_BUDGET,
      },
      roleOverrides: {},
    };

    assert.deepStrictEqual(workflowLines(launch), [
      ["Does", "Five reviewers, one verdict."],
      ["Nodes", "At least 5"],
      ["Phases", "Review, Verdict"],
      ["Budget", "No limit"],
    ]);
  });

  it("shows a program whole, a call's summary, and nothing for a budget raise", () => {
    assert.deepStrictEqual(
      approvalDetail(
        "executor: run",
        Option.some({ type: "program", code: "await tools.x()" })
      ),
      Option.some("await tools.x()")
    );
    assert.deepStrictEqual(
      approvalDetail("bash: ls", Option.none()),
      Option.some("bash: ls")
    );
    assert.isTrue(
      Option.isNone(
        approvalDetail(
          "raise",
          Option.some({
            type: "budget-raise",
            scope: "thread",
            from: DEFAULT_BUDGET,
            to: DEFAULT_BUDGET,
          })
        )
      )
    );
  });
});
