import { ThreadId } from "@cairn/protocol/Ids";
import { QuestionsPayload } from "@cairn/protocol/Policy";
import type { JsonObject } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";
import { Option, Result, Schema } from "effect";

import { UNDECIDED } from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { askUserResult, questionAskOf } from "./AskUser.ts";

const isQuestionsPayload = Schema.is(QuestionsPayload);

const ask = (args: JsonObject) => Result.getOrThrow(questionAskOf(args));

const refusal = (args: JsonObject) =>
  Option.getOrNull(Result.getFailure(questionAskOf(args)));

describe("the question record ask_user writes", () => {
  it("freezes the questions in the protocol's shape, with defaults filled", () => {
    const found = ask({
      questions: [
        {
          header: "Database",
          question: "Which database?",
          options: [
            { label: "Postgres", recommended: true },
            { label: "SQLite" },
          ],
        },
        { header: "Name", question: "What is it called?" },
      ],
    });

    assert.isTrue(isQuestionsPayload(found.payload));
    assert.deepStrictEqual(found.payload, {
      type: "questions",
      questions: [
        {
          header: "Database",
          question: "Which database?",
          options: [
            { label: "Postgres", description: null, recommended: true },
            { label: "SQLite", description: null, recommended: false },
          ],
          multiSelect: false,
          allowCustomAnswer: true,
        },
        {
          header: "Name",
          question: "What is it called?",
          options: [],
          multiSelect: false,
          allowCustomAnswer: true,
        },
      ],
    });
    assert.strictEqual(found.summary, "Which database? (and 1 more)");
  });

  it("refuses what cannot be asked or answered, naming the fix", () => {
    assert.match(refusal({ questions: [] }) ?? "", /one to 9 questions/u);
    assert.match(refusal({}) ?? "", /Call it again/u);
    assert.match(
      refusal({
        questions: [{ header: "x".repeat(81), question: "Why?" }],
      }) ?? "",
      /at most 80 characters/u
    );
    assert.match(
      refusal({
        questions: [
          { header: "Pick", question: "Which?", allowCustomAnswer: false },
        ],
      }) ?? "",
      /question 1 has no options and allows no answer/u
    );
    assert.match(
      refusal({
        questions: [
          {
            header: "Pick",
            question: "Which?",
            options: [{ label: "a" }, { label: "a" }],
          },
        ],
      }) ?? "",
      /offers one label twice/u
    );
  });

  it("cuts a long first question in the summary", () => {
    const found = ask({
      questions: [{ header: "Long", question: "word ".repeat(200) }],
    });

    assert.isAtMost(found.summary.length, 300);
    assert.isTrue(found.summary.endsWith("..."));
  });
});

describe("what ask_user returns", () => {
  const asked = ask({
    questions: [
      {
        header: "Database",
        question: "Which database?",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
      },
    ],
  });

  const record = (fields: Partial<ApprovalRecord>): ApprovalRecord => ({
    id: "call-1",
    toolTaskId: 1,
    tool: "ask_user",
    kind: "user-input",
    summary: asked.summary,
    status: "pending",
    askedAt: 1,
    expiresAt: 2,
    answeredAt: null,
    run: null,
    executorRequestId: null,
    ...UNDECIDED,
    payload: asked.payload,
    ...fields,
  });

  it("returns the numbered answers, naming a parent that answered", () => {
    const answer = {
      decision: "accept" as const,
      answers: [{ index: 0, picks: ["SQLite"], custom: null }],
      note: null,
      launch: null,
    };

    assert.deepStrictEqual(
      askUserResult(
        record({ status: "accepted", decidedBy: { kind: "user" }, answer }),
        asked.questions
      ),
      { text: "The user answered:\n1. Database: SQLite", isError: false }
    );
    assert.strictEqual(
      askUserResult(
        record({
          status: "accepted",
          decidedBy: {
            kind: "thread",
            threadId: ThreadId.make("0190f0c0-0000-7000-8000-000000000001"),
          },
          answer,
        }),
        asked.questions
      ).text,
      "The parent answered:\n1. Database: SQLite"
    );
  });

  it("is an error result with the reason when nothing was answered", () => {
    assert.deepStrictEqual(
      askUserResult(
        record({
          status: "declined",
          decidedBy: { kind: "user" },
          reason: "decide yourself",
        }),
        asked.questions
      ),
      {
        text: "The user declined to answer: decide yourself. Go on without the answers, or ask differently.",
        isError: true,
      }
    );
    assert.isTrue(
      askUserResult(record({ status: "expired" }), asked.questions).isError
    );
    assert.match(
      askUserResult(record({ status: "cancelled" }), asked.questions).text,
      /were cancelled/u
    );
  });
});
