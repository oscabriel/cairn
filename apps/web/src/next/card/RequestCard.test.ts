// Scene tests for the request card (plan 6A): what it shows for an approval, a question and a
// brief; that a question advances only after its pause and only for the pick that armed it; that
// Send waits out the undo window and Undo sends nothing; that one answer is in flight at a time and
// an answered request hides until the stream settles it; and that a request settled elsewhere
// closes with its line and keeps what the user typed.

import { ApprovalId, ThreadId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import type { Schema } from "effect";
import * as Scene from "foldkit/scene";

import { resolvedCheck } from "./CardFixtures.ts";
import { Message } from "./Message.ts";
import { initial } from "./Model.ts";
import type { Model } from "./Model.ts";
import {
  inform,
  RespondToRequest,
  update,
  WaitToAdvance,
  WaitToSend,
} from "./Update.ts";
import { view } from "./View.ts";

type Json = Schema.Json;

const threadId = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0001");

const record = (fields: { readonly [key: string]: Json }): Json => ({
  id: "call-1",
  toolTaskId: 1,
  tool: "gate",
  kind: "tool-call",
  summary: "Open the gate",
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

const doc = (...records: ReadonlyArray<Json>): Json => ({
  items: Object.fromEntries(
    records.map((found, index) => [`r${index}`, found])
  ),
});

const option = (label: string, recommended = false): Json => ({
  label,
  description: null,
  recommended,
});

const questionFields = {
  id: "q-1",
  kind: "user-input",
  tool: "ask_user",
  summary: "Two questions",
  askedAt: 2000,
  payload: {
    type: "questions",
    questions: [
      {
        header: "Database",
        question: "Which database?",
        options: [option("Postgres", true), option("SQLite")],
        multiSelect: false,
        allowCustomAnswer: true,
      },
      {
        header: "Name",
        question: "What should it be called?",
        options: [option("heron"), option("wren")],
        multiSelect: false,
        allowCustomAnswer: true,
      },
    ],
  },
};

const question = record(questionFields);

const approval = record({ id: "a-1" });

const brief = record({
  id: "b-1",
  kind: "brief",
  tool: "subagent_spawn",
  summary: "Count the files",
  askedAt: 3000,
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
    role: "@scout",
    model: null,
    thinking: null,
    mode: "approval-required",
    mayCommit: false,
    budget: {
      maxListMicros: 2_000_000,
      maxTokens: null,
      maxTurns: null,
      maxMinutes: null,
      planGuard: null,
      warnAt: 0.8,
    },
    resultSchema: null,
    wake: "answer",
    decisions: [],
  },
});

const showing = (approvals: Json): Model =>
  inform(initial, {
    threadId: Option.some(threadId),
    approvals,
    hasClient: true,
  }).model;

const config = { update, view };

const qId = ApprovalId.make("q-1");

const aId = ApprovalId.make("a-1");

describe("the request card", () => {
  it("shows an approval with its tool and detail, and approves it once", () => {
    Scene.scene(
      config,
      Scene.given(showing(doc(approval, question))),
      Scene.expect(Scene.testId("request-card")).toHaveAttr(
        "data-request-kind",
        "tool-call"
      ),
      Scene.expect(Scene.testId("request-card-position")).toHaveText("1/2"),
      Scene.expect(Scene.testId("request-card-tool")).toContainText("gate"),
      Scene.expect(Scene.testId("request-card-detail")).toHaveText(
        "Open the gate"
      ),
      Scene.click(Scene.role("button", { name: "Approve" })),
      Scene.Command.expectExact(RespondToRequest),
      Scene.expect(Scene.role("button", { name: "Approve" })).toHaveAttr(
        "aria-busy",
        "true"
      ),
      Scene.Command.resolve(
        RespondToRequest({
          threadId,
          approvalId: aId,
          decision: "accept",
          reason: Option.none(),
          answers: Option.none(),
        }),
        Message.SucceededRespond({ approvalId: aId })
      ),
      // Hidden at once, though the stream still shows it pending: the question is next.
      Scene.expect(Scene.testId("request-card")).toHaveAttr(
        "data-request-kind",
        "user-input"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("asks for a reason on Decline and sends it", () => {
    Scene.scene(
      config,
      Scene.given(showing(doc(approval))),
      Scene.click(Scene.role("button", { name: "Decline" })),
      Scene.type(
        Scene.label("Why not? (optional)"),
        "  not before the review "
      ),
      Scene.click(Scene.role("button", { name: "Decline" })),
      Scene.Command.resolve(
        RespondToRequest({
          threadId,
          approvalId: aId,
          decision: "decline",
          reason: Option.some("not before the review"),
          answers: Option.none(),
        }),
        Message.SucceededRespond({ approvalId: aId })
      ),
      Scene.expect(Scene.testId("request-card")).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("advances a question after the pause, picks by digit, and sends after the undo window", () => {
    Scene.scene(
      config,
      Scene.given(showing(doc(question))),
      Scene.expect(Scene.testId("request-card-question-position")).toHaveText(
        "1/2"
      ),
      Scene.expect(Scene.testId("request-card-options")).toContainText(
        "Recommended"
      ),
      Scene.keydown(Scene.testId("request-card-options"), "2"),
      Scene.expect(Scene.selector('[data-option-index="2"]')).toHaveAttr(
        "aria-pressed",
        "true"
      ),
      // Not yet: the card moves only when the pause ends.
      Scene.expect(Scene.testId("request-card-header")).toHaveText("Database"),
      Scene.Command.resolve(
        WaitToAdvance({ approvalId: qId, index: 0, timer: 1 }),
        Message.ElapsedAdvance({ approvalId: qId, index: 0, timer: 1 })
      ),
      Scene.expect(Scene.testId("request-card-header")).toHaveText("Name"),
      Scene.type(Scene.label("Something else"), "kestrel"),
      Scene.click(Scene.role("button", { name: "Send" })),
      Scene.expect(Scene.testId("request-card-undo")).toExist(),
      Scene.Command.expectExact(WaitToSend),
      Scene.Command.resolve(
        WaitToSend({ approvalId: qId, timer: 4 }),
        Message.ElapsedUndo({ approvalId: qId, timer: 4 })
      ),
      Scene.Command.expectHas(
        RespondToRequest({
          threadId,
          approvalId: qId,
          decision: "accept",
          reason: Option.none(),
          answers: Option.some([
            { index: 0, picks: ["SQLite"], custom: null },
            { index: 1, picks: [], custom: "kestrel" },
          ]),
        })
      ),
      Scene.Command.resolve(
        RespondToRequest,
        Message.SucceededRespond({ approvalId: qId })
      ),
      Scene.expect(Scene.testId("request-card")).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("sends nothing when Undo is pressed, and a stale pause does not advance", () => {
    Scene.scene(
      config,
      Scene.given(showing(doc(question))),
      Scene.click(Scene.selector('[data-option-index="1"]')),
      Scene.click(Scene.selector('[data-option-index="2"]')),
      // The first pick's pause ends after the second pick: it is stale.
      Scene.Command.resolve(
        WaitToAdvance({ approvalId: qId, index: 0, timer: 1 }),
        Message.ElapsedAdvance({ approvalId: qId, index: 0, timer: 1 })
      ),
      Scene.expect(Scene.testId("request-card-header")).toHaveText("Database"),
      Scene.Command.resolve(
        WaitToAdvance({ approvalId: qId, index: 0, timer: 2 }),
        Message.ElapsedAdvance({ approvalId: qId, index: 0, timer: 2 })
      ),
      Scene.expect(Scene.testId("request-card-header")).toHaveText("Name"),
      Scene.click(Scene.selector('[data-option-index="1"]')),
      Scene.Command.resolve(
        WaitToAdvance({ approvalId: qId, index: 1, timer: 4 }),
        Message.ElapsedAdvance({ approvalId: qId, index: 1, timer: 4 })
      ),
      // The last question's advance opens the undo window.
      Scene.expect(Scene.testId("request-card-undo")).toExist(),
      Scene.click(Scene.role("button", { name: "Undo" })),
      Scene.expect(Scene.testId("request-card-undo")).toBeAbsent(),
      Scene.Command.resolve(
        WaitToSend({ approvalId: qId, timer: 5 }),
        Message.ElapsedUndo({ approvalId: qId, timer: 5 })
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      }),
      Scene.expect(Scene.testId("request-card")).toExist()
    );
  });

  it("draws a brief's fields in reading order with Go", () => {
    // Its role resolves (6B holds Go until `roles.check` says so: `BriefCard.test.ts`).
    const checked = update(
      showing(doc(brief)),
      Message.ReceivedRoleChecks({
        approvalId: ApprovalId.make("b-1"),
        generation: 1,
        checks: resolvedCheck(
          "@scout",
          { provider: "claude-bridge", modelId: "claude-sonnet-5-5" },
          "high"
        ),
      })
    ).model;

    Scene.scene(
      config,
      Scene.given(checked),
      Scene.expect(Scene.testId("request-card")).toHaveAttr(
        "data-request-body",
        "Brief"
      ),
      Scene.inside(
        Scene.testId("request-card"),
        Scene.expect(Scene.selector("dl")).toContainText(
          "DoCount the TypeScript files under src.WhyTo size the port.Judged byThe parent accepts the result. (judged by you)"
        ),
        Scene.expect(Scene.selector("dl")).toContainText(
          "Budget$2.00 at API list price"
        )
      ),
      Scene.click(Scene.role("button", { name: "Go" })),
      Scene.Command.expectHas(
        RespondToRequest({
          threadId,
          approvalId: ApprovalId.make("b-1"),
          decision: "accept",
          reason: Option.none(),
          answers: Option.none(),
        })
      ),
      Scene.Command.resolve(
        RespondToRequest,
        Message.SucceededRespond({ approvalId: ApprovalId.make("b-1") })
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("closes a request answered elsewhere with its line, keeping what was typed", () => {
    const typed = update(
      showing(doc(question)),
      Message.ChangedCustom({
        approvalId: qId,
        index: 0,
        value: "MariaDB, please",
      })
    ).model;

    const settled = inform(typed, {
      threadId: Option.some(threadId),
      approvals: doc(
        record({
          ...questionFields,
          status: "accepted",
          answeredAt: 2500,
          decidedBy: { kind: "user" },
          answer: {
            decision: "accept",
            answers: [{ index: 0, picks: ["Postgres"], custom: null }],
            note: null,
            launch: null,
          },
        })
      ),
      hasClient: true,
    }).model;

    Scene.scene(
      config,
      Scene.given(settled),
      Scene.expect(Scene.testId("request-card")).toBeAbsent(),
      Scene.expect(Scene.testId("request-card-closed")).toContainText(
        "Answered by you"
      ),
      Scene.expect(Scene.testId("request-card-closed-typed")).toHaveText(
        "MariaDB, please"
      ),
      Scene.click(Scene.role("button", { name: "Dismiss" })),
      Scene.expect(Scene.testId("request-card-closed")).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("closes with the winning line when another device's different answer landed first", () => {
    let declined = showing(doc(approval));

    for (const message of [
      Message.ClickedDecline({ approvalId: aId }),
      Message.ClickedConfirmDecline({ approvalId: aId }),
      Message.SucceededRespond({ approvalId: aId }),
    ]) {
      declined = update(declined, message).model;
    }

    const settled = inform(declined, {
      threadId: Option.some(threadId),
      approvals: doc(
        record({
          id: "a-1",
          status: "accepted",
          answeredAt: 1500,
          decidedBy: { kind: "user" },
          answer: {
            decision: "accept",
            answers: null,
            note: null,
            launch: null,
          },
        })
      ),
      hasClient: true,
    }).model;

    assert.deepStrictEqual(
      Option.map(settled.closed, (closed) => closed.text),
      Option.some("Approved by you")
    );

    const own = inform(declined, {
      threadId: Option.some(threadId),
      approvals: doc(
        record({
          id: "a-1",
          status: "declined",
          answeredAt: 1500,
          decidedBy: { kind: "user" },
          answer: {
            decision: "decline",
            answers: null,
            note: null,
            launch: null,
          },
        })
      ),
      hasClient: true,
    }).model;

    assert.isTrue(Option.isNone(own.closed));
  });

  it.each([
    ["cancelled", "Stopped", { kind: "system", why: "run-stopped" }],
    ["expired", "Expired", null],
  ] as const)(
    "closes a shown request that went %s with no answer, keeping what was typed",
    (status, line, decidedBy) => {
      let typed = update(
        showing(doc(question)),
        Message.ChangedCustom({ approvalId: qId, index: 0, value: "MariaDB" })
      ).model;

      for (const message of [
        Message.ClickedDecline({ approvalId: qId }),
        Message.ChangedReason({ approvalId: qId, value: "not yet" }),
      ]) {
        typed = update(typed, message).model;
      }

      const settled = inform(typed, {
        threadId: Option.some(threadId),
        approvals: doc(
          record({
            ...questionFields,
            status,
            answeredAt: 2500,
            decidedBy,
          })
        ),
        hasClient: true,
      }).model;

      assert.deepStrictEqual(
        Option.map(settled.closed, (closed) => closed.text),
        Option.some(line)
      );

      Scene.scene(
        config,
        Scene.given(settled),
        Scene.expect(Scene.testId("request-card")).toBeAbsent(),
        Scene.expect(Scene.testId("request-card-closed")).toContainText(line),
        Scene.expect(Scene.testId("request-card-closed-typed")).toHaveText(
          "MariaDB\n\nnot yet"
        )
      );
    }
  );

  it("declines a question with a reason and no answers", () => {
    Scene.scene(
      config,
      Scene.given(showing(doc(question))),
      Scene.click(Scene.role("button", { name: "Decline" })),
      Scene.expect(Scene.testId("request-card-options")).toBeAbsent(),
      Scene.type(Scene.label("Why not? (optional)"), "ask me later"),
      Scene.click(Scene.role("button", { name: "Decline" })),
      Scene.Command.expectHas(
        RespondToRequest({
          threadId,
          approvalId: qId,
          decision: "decline",
          reason: Option.some("ask me later"),
          answers: Option.none(),
        })
      ),
      Scene.Command.resolve(
        RespondToRequest,
        Message.SucceededRespond({ approvalId: qId })
      ),
      Scene.expect(Scene.testId("request-card")).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("takes no second answer while one is in flight", () => {
    const sending = update(
      showing(doc(approval)),
      Message.ClickedAccept({ approvalId: aId, decision: "accept" })
    );

    assert.lengthOf(sending.commands ?? [], 1);

    const again = update(
      sending.model,
      Message.ClickedAccept({ approvalId: aId, decision: "accept_for_thread" })
    );

    assert.lengthOf(again.commands ?? [], 0);
  });

  it("starts over on another thread", () => {
    const typed = update(
      showing(doc(approval)),
      Message.ClickedDecline({ approvalId: aId })
    ).model;

    const moved = inform(typed, {
      threadId: Option.some(
        ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0002")
      ),
      approvals: null,
      hasClient: true,
    }).model;

    assert.isTrue(Option.isNone(moved.declining));
    assert.isTrue(Option.isNone(moved.closed));
  });
});
