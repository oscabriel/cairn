// Scene tests for the budget on the request card (ADR 0047; review findings U-6, U-7):
//
// - a subagent's brief and a workflow's launch take a changed budget with Go: Change budget opens
//   dollars and tokens fields from the proposal's budget, the Budget line reads what Go will send,
//   and Go (or Run on 1 first) sends it as the answer's `launch`; a field that is not a budget
//   holds Go and says why, and Keep proposed sends none;
// - a budget raise reads as one: the scope by its title, what it spent against its line and the
//   line proposed, with Decline and Approve only, no tool line and no Allow for this thread.

import { ApprovalId, ThreadId } from "@cairn/protocol/Ids";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import type { Schema } from "effect";
import * as Scene from "foldkit/scene";

import { resolvedCheck } from "./CardFixtures.ts";
import { Message } from "./Message.ts";
import { initial } from "./Model.ts";
import type { Model } from "./Model.ts";
import { inform, RespondToRequest, update } from "./Update.ts";
import { view } from "./View.ts";

type Json = Schema.Json;

const threadId = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0001");

/** The budget the model proposed: two dollars at list price, no token line. */
const proposed = {
  ...DEFAULT_BUDGET,
  maxListMicros: Micros.make(2_000_000),
};

const record = (fields: { readonly [key: string]: Json }): Json => ({
  id: "b-1",
  toolTaskId: 1,
  tool: "subagent_spawn",
  kind: "brief",
  summary: "Count the files",
  status: "pending",
  askedAt: 1000,
  expiresAt: 9000,
  answeredAt: null,
  run: null,
  executorRequestId: null,
  payload: null,
  answer: null,
  decidedBy: null,
  reason: null,
  route: "user",
  escalatedAt: null,
  supersedes: null,
  started: null,
  briefHash: null,
  mirrorOf: null,
  ...fields,
});

const brief = record({
  payload: {
    type: "brief",
    title: "Count the files",
    task: "Count the TypeScript files under src.",
    why: "To size the port.",
    avoid: [],
    doneWhen: [
      { text: "The parent accepts the result.", judge: { kind: "user" } },
    ],
    workspace: "shared",
    base: null,
    writes: [],
    role: null,
    model: null,
    thinking: null,
    mode: "full-access",
    mayCommit: false,
    budget: proposed,
    resultSchema: null,
    wake: "answer",
    decisions: [],
  },
});

const launch = record({
  id: "w-1",
  tool: "workflow_plan",
  summary: "Review the port",
  payload: {
    type: "workflow",
    workflowId: "wf-1",
    name: "Review the port",
    description: "Reads each module and reviews it.",
    phases: [],
    scriptHash: "hash-1",
    scriptRef: "entry:1",
    args: null,
    callSites: [
      {
        spec: "faux/scripted:medium",
        label: "review",
        phase: null,
        schemaName: null,
        readonly: true,
        arms: "host",
        maxCount: null,
      },
    ],
    nodes: { count: 3, unbounded: false },
    estimate: null,
    envelope: {
      scriptHash: "hash-1",
      maxNodes: 3,
      maxConcurrent: 2,
      roles: [{ spec: "faux/scripted:medium", readonly: true, arms: "host" }],
      modes: ["full-access"],
      writes: [],
      budget: proposed,
    },
  },
});

const raise = (payload: { readonly [key: string]: Json }): Json =>
  record({
    id: "r-1",
    tool: "budget_raise",
    kind: "tool-call",
    toolTaskId: 0,
    summary: "Raise the budget to $4.00 at API list price?",
    payload: {
      type: "budget-raise",
      scope: "01890a5d-ac96-774b-bcce-b302099a0001",
      from: proposed,
      to: { ...proposed, maxListMicros: 4_000_000 },
      ...payload,
    },
  });

const doc = (...records: ReadonlyArray<Json>): Json => ({
  items: Object.fromEntries(
    records.map((found, index) => [`r${index}`, found])
  ),
});

const showing = (approvals: Json): Model =>
  inform(initial, {
    threadId: Option.some(threadId),
    approvals,
    hasClient: true,
  }).model;

const bId = ApprovalId.make("b-1");

const wId = ApprovalId.make("w-1");

const rId = ApprovalId.make("r-1");

const config = { update, view };

const goButton = Scene.role("button", { name: "Go" });

const budgetLine = Scene.inside(
  Scene.testId("request-card"),
  Scene.expect(Scene.selector("dl")).toContainText(
    "Budget$0.75 at API list price, 120,000 tokens (changed from $2.00 at API list price)"
  )
);

describe("the budget on the request card", () => {
  it("sends the budget the user set on a brief with Go, and the Budget line reads it", () => {
    Scene.scene(
      config,
      Scene.given(showing(doc(brief))),
      Scene.inside(
        Scene.testId("request-card"),
        Scene.expect(Scene.selector("dl")).toContainText(
          "Budget$2.00 at API list price"
        )
      ),
      Scene.click(Scene.role("button", { name: "Change budget" })),
      Scene.expect(Scene.label("Dollars at API list price")).toHaveValue(
        "2.00"
      ),
      Scene.type(Scene.label("Dollars at API list price"), "0.75"),
      Scene.type(Scene.label("Tokens"), "120,000"),
      budgetLine,
      Scene.click(goButton),
      Scene.Command.expectExact(
        RespondToRequest({
          threadId,
          approvalId: bId,
          decision: "accept",
          reason: Option.none(),
          answers: Option.none(),
          launch: Option.some({
            budget: {
              ...proposed,
              maxListMicros: Micros.make(750_000),
              maxTokens: 120_000,
            },
          }),
        })
      ),
      Scene.Command.resolve(
        RespondToRequest,
        Message.SucceededRespond({ approvalId: bId })
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("carries the changed budget on a launch's Run on 1 first", () => {
    const shown = update(
      showing(doc(launch)),
      Message.ReceivedModelChecks({
        approvalId: wId,
        generation: 1,
        checks: resolvedCheck(
          "faux/scripted:medium",
          { provider: "faux", modelId: "scripted" },
          "medium"
        ),
      })
    ).model;

    Scene.scene(
      config,
      Scene.given(shown),
      Scene.click(Scene.role("button", { name: "Change budget" })),
      Scene.type(Scene.label("Dollars at API list price"), ""),
      Scene.type(Scene.label("Tokens"), "50000"),
      Scene.click(Scene.role("button", { name: "Run on 1 first" })),
      Scene.Command.expectExact(
        RespondToRequest({
          threadId,
          approvalId: wId,
          decision: "accept_sample",
          reason: Option.none(),
          answers: Option.none(),
          launch: Option.some({
            budget: { ...proposed, maxListMicros: null, maxTokens: 50_000 },
          }),
        })
      ),
      Scene.Command.resolve(
        RespondToRequest,
        Message.SucceededRespond({ approvalId: wId })
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("holds Go on a field that is not a budget and says why; Keep proposed sends none", () => {
    Scene.scene(
      config,
      Scene.given(showing(doc(brief))),
      Scene.click(Scene.role("button", { name: "Change budget" })),
      Scene.type(Scene.label("Tokens"), "lots"),
      Scene.expect(goButton).toBeDisabled(),
      Scene.expect(Scene.testId("request-card-budget-hint")).toContainText(
        "Tokens must be a whole number above zero"
      ),
      Scene.click(Scene.role("button", { name: "Keep proposed budget" })),
      Scene.expect(goButton).not.toBeDisabled(),
      Scene.click(goButton),
      Scene.Command.expectExact(
        RespondToRequest({
          threadId,
          approvalId: bId,
          decision: "accept",
          reason: Option.none(),
          answers: Option.none(),
          launch: Option.none(),
        })
      ),
      Scene.Command.resolve(
        RespondToRequest,
        Message.SucceededRespond({ approvalId: bId })
      )
    );

    // Go is refused by the update too, not only drawn disabled.
    const typed = update(
      update(
        showing(doc(brief)),
        Message.ClickedChangeBudget({ approvalId: bId })
      ).model,
      Message.ChangedBudgetDollars({ approvalId: bId, value: "free" })
    ).model;

    const clicked = update(
      typed,
      Message.ClickedAccept({ approvalId: bId, decision: "accept" })
    );

    assert.lengthOf(clicked.commands ?? [], 0);
    assert.isTrue(Option.isSome(clicked.model.failure));
  });

  it("reads a budget raise by its scope's title, its spend and the line proposed, with Decline and Approve only", () => {
    Scene.scene(
      config,
      Scene.given(
        showing(
          doc(
            raise({
              title: "Fan out the review",
              spent: { tokens: 104_000, listMicros: 2_040_000 },
            })
          )
        )
      ),
      Scene.expect(Scene.testId("request-card-raise")).toContainText(
        "ScopeFan out the review"
      ),
      Scene.expect(Scene.testId("request-card-raise")).toContainText(
        "Spent$2.04 of $2.00 at API list price"
      ),
      Scene.expect(Scene.testId("request-card-raise")).toContainText(
        "Raise to$4.00 at API list price"
      ),
      Scene.expect(Scene.testId("request-card-tool")).not.toExist(),
      Scene.expect(
        Scene.role("button", { name: "Allow for this thread" })
      ).not.toExist(),
      Scene.expect(Scene.role("button", { name: "Decline" })).toExist(),
      Scene.click(Scene.role("button", { name: "Approve" })),
      Scene.Command.expectExact(
        RespondToRequest({
          threadId,
          approvalId: rId,
          decision: "accept",
          reason: Option.none(),
          answers: Option.none(),
          launch: Option.none(),
        })
      ),
      Scene.Command.resolve(
        RespondToRequest,
        Message.SucceededRespond({ approvalId: rId })
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
