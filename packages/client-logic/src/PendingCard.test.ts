import { ModelSpec } from "@cairn/protocol/ModelSpecs";
import type { Brief, Question } from "@cairn/protocol/Policy";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { takesBudgetEdit } from "./BriefGo.ts";
import { budgetDraftOf, budgetEditOf } from "./Meters.ts";
import {
  approvalDetail,
  briefLines,
  budgetRaiseLines,
  budgetText,
  judgeText,
  requestKindWord,
  requestTitle,
} from "./PendingCard.ts";
import { RequestBody } from "./PendingRequests.ts";

const luna = ModelSpec.make("opencode-go/gpt-6-luna:high");

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
  role: luna,
  model: null,
  thinking: null,
  mode: "auto-accept-edits",
  mayCommit: false,
  budget: { ...DEFAULT_BUDGET, maxListMicros: Micros.make(1_500_000) },
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
      ["Who", "opencode-go/gpt-6-luna at high, Auto-accept edits"],
      ["Budget", "$1.50 at API list price"],
    ]);

    assert.deepStrictEqual(
      briefLines({ ...brief, avoid: [] }).map(([label]) => label),
      ["Do", "Why", "Judged by", "Where", "Who", "Budget"]
    );
  });

  it("says the dollar and token limits of a budget, no limit nothing sets, and No limit for none", () => {
    const budget: Budget = {
      maxListMicros: Micros.make(2_500_000),
      maxTokens: 120_000,
      maxTurns: 40,
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
      "$2.50 at API list price, 120,000 tokens"
    );
    assert.strictEqual(budgetText(DEFAULT_BUDGET), "No limit");
  });

  it("reads a budget raise by its scope's title, its spend against the line, and the proposed line", () => {
    const from: Budget = {
      ...DEFAULT_BUDGET,
      maxListMicros: Micros.make(2_000_000),
      maxTokens: 100_000,
    };

    assert.deepStrictEqual(
      budgetRaiseLines({
        type: "budget-raise",
        scope: "0190f0c0-0000-7000-8000-0000000000b1",
        title: "Fan out the review",
        spent: { tokens: 104_000, listMicros: Micros.make(2_040_000) },
        from,
        to: { ...from, maxListMicros: Micros.make(4_000_000) },
      }),
      [
        ["Scope", "Fan out the review"],
        ["Spent", "$2.04 of $2.00 at API list price; 104k of 100k tokens"],
        ["Raise to", "$4.00 at API list price, 100,000 tokens"],
      ]
    );

    // A raise asked before it carried its title and spend never shows a raw id or a zero.
    const older = {
      type: "budget-raise" as const,
      from: DEFAULT_BUDGET,
      to: { ...DEFAULT_BUDGET, maxTokens: 200_000 },
    };

    assert.deepStrictEqual(
      budgetRaiseLines({
        ...older,
        scope: "0190f0c0-0000-7000-8000-0000000000b1",
      }),
      [
        ["Scope", "This thread"],
        ["Spent", "Not recorded on this raise"],
        ["Raise to", "200,000 tokens"],
      ]
    );
    assert.deepStrictEqual(budgetRaiseLines({ ...older, scope: "wf-3" })[0], [
      "Scope",
      "A workflow of this thread",
    ]);
  });

  it("takes a budget edit on a subagent's brief and a workflow's launch only", () => {
    const briefBody = RequestBody.Brief({ payload: brief });

    assert.isTrue(
      takesBudgetEdit({ kind: "brief", tool: "subagent_spawn" }, briefBody)
    );
    // A node's own brief is the workflow's envelope's to bound.
    assert.isFalse(
      takesBudgetEdit({ kind: "brief", tool: "agent" }, briefBody)
    );
    assert.isFalse(
      takesBudgetEdit(
        { kind: "tool-call", tool: "bash" },
        RequestBody.Approval({ summary: "bash: ls", payload: Option.none() })
      )
    );
  });

  it("reads a budget field's draft into the budget Go sends, refusing what is not a limit", () => {
    const proposed: Budget = {
      ...DEFAULT_BUDGET,
      maxListMicros: Micros.make(2_000_000),
      warnAt: 0.7,
    };

    assert.deepStrictEqual(budgetDraftOf(proposed), {
      dollars: "2.00",
      tokens: "",
    });

    // Unchanged: Go sends no edit.
    assert.deepStrictEqual(
      budgetEditOf(proposed, Option.some(budgetDraftOf(proposed))),
      Result.succeed(Option.none())
    );
    assert.deepStrictEqual(
      budgetEditOf(proposed, Option.none()),
      Result.succeed(Option.none())
    );

    assert.deepStrictEqual(
      budgetEditOf(
        proposed,
        Option.some({ dollars: "$0.75", tokens: "120,000" })
      ),
      Result.succeed(
        Option.some({
          ...proposed,
          maxListMicros: Micros.make(750_000),
          maxTokens: 120_000,
        })
      )
    );

    // Both empty is no limit, said so.
    assert.deepStrictEqual(
      budgetEditOf(proposed, Option.some({ dollars: " ", tokens: "" })),
      Result.succeed(
        Option.some({ ...proposed, maxListMicros: null, maxTokens: null })
      )
    );

    for (const draft of [
      { dollars: "abc", tokens: "" },
      { dollars: "0", tokens: "" },
      { dollars: "-1", tokens: "" },
      { dollars: "", tokens: "1.5" },
      { dollars: "", tokens: "0" },
    ]) {
      assert.isTrue(
        Result.isFailure(budgetEditOf(proposed, Option.some(draft))),
        JSON.stringify(draft)
      );
    }
  });

  it("names a model judge by its spec", () => {
    assert.strictEqual(
      judgeText({ kind: "model", spec: luna, rubric: "Is it right?" }),
      "a model (opencode-go/gpt-6-luna:high)"
    );
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
