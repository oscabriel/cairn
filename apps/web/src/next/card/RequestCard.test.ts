// Scene tests for the request card (plan 6A): what it shows for an approval, a question and a
// brief; that a question advances only after its pause and only for the pick that armed it; that
// Send waits out the undo window and Undo sends nothing; that one answer is in flight at a time and
// an answered request hides until the stream settles it; that a request settled elsewhere
// closes with its line and keeps what the user typed; and that an answer's lifecycle survives a
// dropped connection, a thread switch and another request answered during its undo window.

import { ApprovalId, ThreadId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import type { Schema } from "effect";
import * as Scene from "foldkit/scene";

import { Message as ComposerMessage } from "../../composer/Message.ts";
import { ConnectionState } from "../../connection/Reconnect.ts";
import { Message as RootMessage } from "../../Message.ts";
import type { Model as RootModel } from "../../Model.ts";
import { liveModel, sendItem } from "../../TestFixtures.ts";
import { update as rootUpdate } from "../../Update.ts";
import { resolvedCheck, unreadyCheck } from "./CardFixtures.ts";
import { Message, OutMessage } from "./Message.ts";
import { initial } from "./Model.ts";
import type { Model } from "./Model.ts";
import {
  CheckModels,
  composerBlurred,
  composerFocused,
  composerSent,
  composerTyped,
  inform,
  RespondToRequest,
  shownRequest,
  update,
  WaitToAdvance,
  WaitToSend,
  WaitTypingPause,
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
    role: "claude-bridge/claude-sonnet-5-5:high",
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
          launch: Option.none(),
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
          launch: Option.none(),
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
          launch: Option.none(),
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
    // Its model resolves (6B holds Go until `models.check` says so: `BriefCard.test.ts`).
    const checked = update(
      showing(doc(brief)),
      Message.ReceivedModelChecks({
        approvalId: ApprovalId.make("b-1"),
        generation: 1,
        checks: resolvedCheck(
          "claude-bridge/claude-sonnet-5-5:high",
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
          "DoCount the TypeScript files under src.WhyTo size the port.Judged byNo outside judge; the parent accepts the result"
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
          launch: Option.none(),
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

    const informed = inform(typed, {
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
    });

    const settled = informed.model;

    // The typed words go back into the thread's composer draft, once (look track L7).
    assert.deepStrictEqual(
      informed.outMessage,
      OutMessage.CarriedTypedWords({ threadId, text: "MariaDB, please" })
    );
    assert.isUndefined(
      inform(settled, {
        threadId: Option.some(threadId),
        approvals: settled.approvals,
        hasClient: false,
      }).outMessage
    );

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
          launch: Option.none(),
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

/** Whether the root tells the card it has a client, after one update from `model`. */
const toldHasClient = (model: RootModel) =>
  rootUpdate(model, RootMessage.CompletedNavigateInternal()).model.requestCard
    .hasClient;

describe("the root's connection, as the card is told it", () => {
  it("counts a client only once the connection is Live, not while it is Syncing", () => {
    const live = liveModel(2);

    const syncing: RootModel = {
      ...live,
      connection: { epoch: 2, state: ConnectionState.Syncing({ attempt: 0 }) },
      requestCard: { ...live.requestCard, hasClient: true },
    };

    assert.deepStrictEqual(
      [toldHasClient(syncing), toldHasClient(live)],
      [false, true]
    );
  });
});

const oneQuestion = record({
  ...questionFields,
  payload: {
    type: "questions",
    questions: [questionFields.payload.questions[0] ?? null],
  },
});

const threadY = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0002");

interface Step {
  readonly model: Model;
  readonly commands: NonNullable<ReturnType<typeof update>["commands"]>;
}

/** Runs messages through `update` from `model`, keeping the last step's commands. */
const run = (model: Model, ...messages: ReadonlyArray<Message>): Step => {
  let step: Step = { model, commands: [] };

  for (const message of messages) {
    const next = update(step.model, message);

    step = { model: next.model, commands: next.commands ?? [] };
  }

  return step;
};

const informed = (
  model: Model,
  approvals: Json,
  hasClient = true,
  thread = threadId
): Step => {
  const next = inform(model, {
    threadId: Option.some(thread),
    approvals,
    hasClient,
  });

  return { model: next.model, commands: next.commands ?? [] };
};

const responds = (step: Step) =>
  step.commands.filter((command) => command.name === RespondToRequest.name);

/** A one-question card picked "SQLite", with its undo window open (timer 2). */
const inUndoWindow = (approvals: Json): Model =>
  run(
    showing(approvals),
    Message.PickedOption({ approvalId: qId, index: 0, label: "SQLite" }),
    Message.ElapsedAdvance({ approvalId: qId, index: 0, timer: 1 })
  ).model;

describe("the request card's answer lifecycle", () => {
  it("sends the answers once the connection is back when the undo window ended while it was down", () => {
    const opened = inUndoWindow(doc(oneQuestion));

    assert.isTrue(Option.isSome(opened.undo));

    const offline = informed(opened, opened.approvals, false);

    const elapsed = run(
      offline.model,
      Message.ElapsedUndo({ approvalId: qId, timer: 2 })
    );

    assert.lengthOf(responds(elapsed), 0);

    // The bar says when they go now, and Undo still takes them back.
    Scene.scene(
      config,
      Scene.given(elapsed.model),
      Scene.expect(Scene.testId("request-card-undo")).toContainText(
        "Sending your answers once Cairn is back."
      ),
      Scene.expect(Scene.role("button", { name: "Undo" })).toExist()
    );

    const back = informed(elapsed.model, elapsed.model.approvals, true);

    assert.deepStrictEqual(
      responds(back).map((command) => command.args),
      [
        {
          threadId,
          approvalId: qId,
          decision: "accept",
          reason: Option.none(),
          answers: Option.some([{ index: 0, picks: ["SQLite"], custom: null }]),
          launch: Option.none(),
        },
      ],
      "the answers go once Cairn is back"
    );
  });

  it("says the answers wait for the answer on its way, not for Cairn, while connected", () => {
    const opened = inUndoWindow(doc(oneQuestion));

    const elapsed = run(
      { ...opened, sending: Option.some(aId) },
      Message.ElapsedUndo({ approvalId: qId, timer: 2 })
    );

    assert.lengthOf(responds(elapsed), 0);

    Scene.scene(
      config,
      Scene.given(elapsed.model),
      Scene.expect(Scene.testId("request-card-undo")).toContainText(
        "Sending your answers after the ones on their way."
      )
    );
  });

  it("does not let an undo window's timer from before a thread switch end a later window", () => {
    const opened = inUndoWindow(doc(oneQuestion));
    const away = informed(opened, null, true, threadY).model;
    const back = informed(away, doc(oneQuestion)).model;

    const reopened = run(
      back,
      Message.PickedOption({ approvalId: qId, index: 0, label: "Postgres" })
    );

    const advanced = update(
      reopened.model,
      Message.ElapsedAdvance({
        approvalId: qId,
        index: 0,
        timer: reopened.model.timer,
      })
    ).model;

    // The first window's wait, which no thread switch stops, ends now.
    const early = run(
      advanced,
      Message.ElapsedUndo({ approvalId: qId, timer: 2 })
    );

    assert.lengthOf(
      responds(early),
      0,
      "the earlier window's timer sent the new answers"
    );
    assert.isTrue(Option.isSome(early.model.undo));
  });

  it("applies a respond answer only to the request it was for", () => {
    const bId = ApprovalId.make("a-2");

    const sentA = run(
      showing(doc(approval)),
      Message.ClickedAccept({ approvalId: aId, decision: "accept" })
    ).model;

    const onY = informed(sentA, doc(record({ id: "a-2" })), true, threadY);

    const sentB = run(
      onY.model,
      Message.ClickedAccept({ approvalId: bId, decision: "accept" })
    );

    assert.lengthOf(responds(sentB), 1);

    const failedA = run(
      sentB.model,
      Message.FailedRespond({
        approvalId: aId,
        message: "The answer did not reach Cairn. Try again.",
      })
    ).model;

    assert.deepStrictEqual(
      [failedA.failure, failedA.sending],
      [Option.none(), Option.some(bId)],
      "A's failure landed on B's card"
    );

    const succeededA = run(
      sentB.model,
      Message.SucceededRespond({ approvalId: aId })
    ).model;

    assert.deepStrictEqual(succeededA.sending, Option.some(bId));
  });

  it.each(["after", "before"] as const)(
    "sends a question's answers when an approval that arrived in its undo window is answered %s the window ends",
    (order) => {
      const opened = inUndoWindow(doc(oneQuestion));
      const withApproval = informed(opened, doc(approval, oneQuestion)).model;

      const approved = run(
        withApproval,
        Message.ClickedAccept({ approvalId: aId, decision: "accept" })
      );

      assert.lengthOf(responds(approved), 1);

      const steps =
        order === "after"
          ? [
              Message.SucceededRespond({ approvalId: aId }),
              Message.ElapsedUndo({ approvalId: qId, timer: 2 }),
            ]
          : [
              Message.ElapsedUndo({ approvalId: qId, timer: 2 }),
              Message.SucceededRespond({ approvalId: aId }),
            ];

      const settled = run(approved.model, ...steps);

      assert.deepStrictEqual(
        responds(settled).map((command) => command.args?.approvalId),
        [qId],
        "the question's answers were never sent"
      );
    }
  );
});

/** Runs the composer's reports (`composerFocused`, `composerTyped`, ...) on the card from `model`. */
const report = (
  model: Model,
  ...reports: ReadonlyArray<(card: Model) => ReturnType<typeof update>>
): Step => {
  let step: Step = { model, commands: [] };

  for (const told of reports) {
    const next = told(step.model);

    step = { model: next.model, commands: next.commands ?? [] };
  }

  return step;
};

/** The card with the composer focused and typed in once (its pause timer 1), and no request. */
const typingInComposer = (): Step =>
  report(showing(null), composerFocused, composerTyped);

/** The request the card shows, by id; what `data-request-card-up` and the card draw from. */
const shownId = (model: Model) =>
  Option.map(shownRequest(model), (request) => request.record.id);

const cardIsUp = (model: Model, approvalId: ApprovalId) => {
  assert.deepStrictEqual(shownId(model), Option.some(approvalId));
  Scene.scene(
    config,
    Scene.given(model),
    Scene.expect(Scene.testId("request-card")).toHaveAttr(
      "data-approval-id",
      approvalId
    ),
    Scene.expect(Scene.selector('[data-request-card-up="true"]')).toExist()
  );
};

const cardWaits = (model: Model) => {
  assert.isTrue(Option.isNone(shownId(model)), "the card did not wait");
  Scene.scene(
    config,
    Scene.given(model),
    Scene.expect(Scene.testId("request-card")).toBeAbsent(),
    Scene.expect(Scene.selector('[data-request-card-up="false"]')).toExist()
  );
};

describe("the request card while the user types in the composer (W-1)", () => {
  it("waits for the typing to pause before it takes the composer's slot", () => {
    const typing = typingInComposer();

    assert.deepStrictEqual(
      typing.commands.map((command) => command.name),
      [WaitTypingPause.name]
    );

    const arrived = informed(typing.model, doc(approval));

    cardWaits(arrived.model);

    // Another keystroke starts the pause over, so the first one's end is stale.
    const more = report(arrived.model, composerTyped);

    assert.deepStrictEqual(
      more.commands.map((command) => command.args),
      [{ timer: 2 }]
    );

    const stale = run(more.model, Message.ElapsedTypingPause({ timer: 1 }));

    cardWaits(stale.model);

    const paused = run(stale.model, Message.ElapsedTypingPause({ timer: 2 }));

    cardIsUp(paused.model, aId);
    assert.deepStrictEqual(paused.model.shown, Option.some(aId));
  });

  it.each([
    ["sends", composerSent],
    ["leaves the composer", composerBlurred],
  ] as const)(
    "shows a waiting request at once when the user %s",
    (_name, release) => {
      const arrived = informed(typingInComposer().model, doc(approval));

      assert.deepStrictEqual(arrived.model.typing.held, [aId]);
      cardWaits(arrived.model);

      const released = report(arrived.model, release).model;

      assert.deepStrictEqual(released.typing.held, []);
      cardIsUp(released, aId);
    }
  );

  it("shows a request at once while the composer is focused but idle, or typed in and left", () => {
    const idle = informed(
      report(showing(null), composerFocused).model,
      doc(approval)
    ).model;

    const left = informed(
      report(typingInComposer().model, composerBlurred).model,
      doc(approval)
    ).model;

    assert.deepStrictEqual([idle.typing.held, left.typing.held], [[], []]);
    cardIsUp(idle, aId);
    cardIsUp(left, aId);
  });

  it("keeps a request that already showed when typing starts, and holds only the new one", () => {
    const shown = report(
      showing(doc(question)),
      composerFocused,
      composerTyped
    ).model;

    cardIsUp(shown, qId);

    // An approval sorts first, but it arrived mid-word: the question stays until the pause.
    const arrived = informed(shown, doc(approval, question)).model;

    assert.deepStrictEqual(shownId(arrived), Option.some(qId));
    Scene.scene(
      config,
      Scene.given(arrived),
      Scene.expect(Scene.testId("request-card")).toHaveAttr(
        "data-request-kind",
        "user-input"
      ),
      Scene.expect(Scene.testId("request-card-position")).toBeAbsent()
    );

    const paused = run(arrived, Message.ElapsedTypingPause({ timer: 1 })).model;

    assert.deepStrictEqual(shownId(paused), Option.some(aId));
    Scene.scene(
      config,
      Scene.given(paused),
      Scene.expect(Scene.testId("request-card")).toHaveAttr(
        "data-request-kind",
        "tool-call"
      ),
      Scene.expect(Scene.testId("request-card-position")).toHaveText("1/2")
    );
  });

  it("checks a held brief's models only once it shows", () => {
    const arrived = informed(typingInComposer().model, doc(brief));

    assert.lengthOf(arrived.commands, 0);

    const paused = run(arrived.model, Message.ElapsedTypingPause({ timer: 1 }));

    assert.deepStrictEqual(
      paused.commands.map((command) => command.name),
      [CheckModels.name]
    );
  });
});

const inBody = (testId: string) =>
  Scene.selector(`[data-testid="request-card-body"] [data-testid="${testId}"]`);

const inStatus = (testId: string) =>
  Scene.selector(
    `[data-testid="request-card-status"] [data-testid="${testId}"]`
  );

describe("the card's status, pinned with its actions (U-5)", () => {
  it("keeps why Go is blocked out of the scrolling body", () => {
    const blocked = update(
      showing(doc(brief)),
      Message.ReceivedModelChecks({
        approvalId: ApprovalId.make("b-1"),
        generation: 1,
        checks: unreadyCheck(
          "claude-bridge/claude-sonnet-5-5:high",
          "unknown_model"
        ),
      })
    ).model;

    Scene.scene(
      config,
      Scene.given(blocked),
      Scene.expect(
        Scene.selector('[data-testid="request-card-body"][data-scroll-edges]')
      ).toExist(),
      Scene.expect(inStatus("request-card-go-blocked")).toExist(),
      Scene.expect(inBody("request-card-go-blocked")).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("keeps the undo bar and a failed answer out of the scrolling body", () => {
    const opened = inUndoWindow(doc(oneQuestion));

    assert.isTrue(Option.isSome(opened.undo));
    Scene.scene(
      config,
      Scene.given(opened),
      Scene.expect(inStatus("request-card-undo")).toExist(),
      Scene.expect(inBody("request-card-undo")).toBeAbsent()
    );

    const failed = run(
      showing(doc(approval)),
      Message.ClickedAccept({ approvalId: aId, decision: "accept" }),
      Message.FailedRespond({
        approvalId: aId,
        message: "The answer did not reach Cairn. Try again.",
      })
    ).model;

    Scene.scene(
      config,
      Scene.given(failed),
      Scene.expect(inStatus("request-card-failure")).toContainText(
        "The answer did not reach Cairn."
      ),
      Scene.expect(inBody("request-card-failure")).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("draws no status area when there is nothing to say", () => {
    Scene.scene(
      config,
      Scene.given(showing(doc(approval))),
      Scene.expect(Scene.testId("request-card")).toExist(),
      Scene.expect(Scene.testId("request-card-status")).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

const multiQuestion = record({
  ...questionFields,
  payload: {
    type: "questions",
    questions: [
      {
        header: "Checks",
        question: "Which checks should run?",
        options: [option("lint"), option("test")],
        multiSelect: true,
        allowCustomAnswer: false,
      },
    ],
  },
});

describe("the card's options, marked as choices (U-17)", () => {
  it("leads a one-answer question's options with a radio, filled once picked", () => {
    Scene.scene(
      config,
      Scene.given(showing(doc(question))),
      Scene.expect(
        Scene.selector(
          '[data-option-index="1"] [data-option-mark="radio"][data-picked="false"]'
        )
      ).toExist(),
      Scene.click(Scene.selector('[data-option-index="1"]')),
      Scene.expect(
        Scene.selector(
          '[data-option-index="1"] [data-option-mark="radio"][data-picked="true"]'
        )
      ).toExist(),
      Scene.expect(
        Scene.selector(
          '[data-option-index="2"] [data-option-mark="radio"][data-picked="false"]'
        )
      ).toExist(),
      Scene.Command.resolve(
        WaitToAdvance({ approvalId: qId, index: 0, timer: 1 }),
        Message.ElapsedAdvance({ approvalId: qId, index: 0, timer: 1 })
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("leads a question of several answers' options with a check box", () => {
    Scene.scene(
      config,
      Scene.given(showing(doc(multiQuestion))),
      Scene.click(Scene.selector('[data-option-index="2"]')),
      Scene.expect(
        Scene.selector(
          '[data-option-index="1"] [data-option-mark="check"][data-picked="false"]'
        )
      ).toExist(),
      Scene.expect(
        Scene.selector(
          '[data-option-index="2"] [data-option-mark="check"][data-picked="true"]'
        )
      ).toExist(),
      // Several answers: a pick toggles and waits for Send, with no pause to advance.
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

/** The root after the composer reports `message`, from `model`. */
const afterComposer = (model: RootModel, message: ComposerMessage): RootModel =>
  rootUpdate(model, RootMessage.GotComposerMessage({ message })).model;

describe("the composer's focus and typing, as the card is told them", () => {
  it("tells the card when the composer is focused, typed in, sent from and left", () => {
    const focused = afterComposer(
      liveModel(2),
      ComposerMessage.FocusedEditor()
    );

    const typed = afterComposer(
      focused,
      ComposerMessage.ChangedDraft({ value: "h" })
    );

    const sent = afterComposer(
      typed,
      ComposerMessage.PreparedTurn({
        draftKey: "draft",
        item: sendItem("r1"),
        navigateTo: Option.none(),
        attachments: [],
      })
    );

    const left = afterComposer(sent, ComposerMessage.BlurredEditor());

    assert.deepStrictEqual(
      [focused, typed, sent, left].map(({ requestCard: { typing } }) => [
        typing.focused,
        Option.isSome(typing.lastTypedAt),
      ]),
      [
        [true, false],
        [true, true],
        [true, false],
        [false, false],
      ]
    );
  });
});
