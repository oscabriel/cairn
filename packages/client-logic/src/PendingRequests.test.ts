import type { Question } from "@cairn/protocol/Policy";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import type { Schema } from "effect";

import {
  answersProblem,
  answerText,
  approvalRecordsOf,
  pendingRequests,
  settledLines,
} from "./PendingRequests.ts";

type Json = Schema.Json;

const questions: ReadonlyArray<Question> = [
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
    header: "Targets",
    question: "Where to deploy?",
    options: [
      { label: "staging", description: null, recommended: false },
      { label: "production", description: null, recommended: false },
    ],
    multiSelect: true,
    allowCustomAnswer: false,
  },
];

const questionsJson: Json = { type: "questions", questions };

/** A record as `cairn.approvals` holds it, plain JSON. */
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

const answered = (decision: string, answers: Json = null) => ({
  decision,
  answers,
  note: null,
  launch: null,
});

describe("the card's requests", () => {
  it("orders approvals before questions before briefs, each oldest first, with i/N", () => {
    const records = approvalRecordsOf(
      doc(
        record({
          id: "q-old",
          kind: "user-input",
          tool: "ask_user",
          askedAt: 100,
          payload: questionsJson,
        }),
        record({
          id: "b-1",
          kind: "brief",
          tool: "subagent_spawn",
          askedAt: 50,
        }),
        record({ id: "a-new", askedAt: 300 }),
        record({ id: "a-old", askedAt: 200 }),
        record({ id: "done", status: "accepted", decidedBy: { kind: "user" } })
      )
    );

    const pending = pendingRequests(records);

    assert.deepStrictEqual(
      pending.map((found) => [
        found.record.id,
        found.body._tag,
        found.position,
        found.total,
      ]),
      [
        ["a-old", "Approval", 1, 4],
        ["a-new", "Approval", 2, 4],
        ["q-old", "Question", 3, 4],
        ["b-1", "Approval", 4, 4],
      ]
    );
  });

  it("leaves out a child's question still with its parent, and records it cannot read", () => {
    const records = approvalRecordsOf(
      doc(
        record({ id: "to-parent", kind: "user-input", route: "parent" }),
        record({ id: "broken", status: "maybe" }),
        record({ id: "mine" })
      )
    );

    assert.deepStrictEqual(
      pendingRequests(records).map((found) => found.record.id),
      ["mine"]
    );
  });

  it("reads a document that is not one as no records", () => {
    assert.deepStrictEqual(approvalRecordsOf(null), []);
    assert.deepStrictEqual(approvalRecordsOf([1, 2]), []);
    assert.deepStrictEqual(approvalRecordsOf({ items: "none" }), []);
  });
});

const problem = (answers: Parameters<typeof answersProblem>[1]) =>
  Option.getOrNull(answersProblem(questions, answers));

describe("answers that fit", () => {
  it("takes picks of offered options, several only where allowed, and own words where allowed", () => {
    assert.isNull(
      problem([
        { index: 0, picks: ["Postgres"], custom: null },
        { index: 1, picks: ["staging", "production"], custom: null },
      ])
    );
    assert.isNull(problem([{ index: 0, picks: [], custom: "MySQL" }]));
    assert.isNull(problem([]));
  });

  it("names what does not fit", () => {
    assert.match(
      problem([{ index: 0, picks: ["MySQL"], custom: null }]) ?? "",
      /"MySQL" is not an option of question 1/u
    );
    assert.match(
      problem([{ index: 0, picks: ["Postgres", "SQLite"], custom: null }]) ??
        "",
      /question 1 takes one pick/u
    );
    assert.match(
      problem([{ index: 1, picks: [], custom: "everywhere" }]) ?? "",
      /question 2 offers only its options/u
    );
    assert.match(
      problem([{ index: 2, picks: [], custom: "x" }]) ?? "",
      /answer 3 names no question/u
    );
    assert.match(
      problem([{ index: 0, picks: [], custom: "  " }]) ?? "",
      /answer 1 says nothing/u
    );
    assert.match(
      problem([{ index: 1, picks: ["staging", "staging"], custom: null }]) ??
        "",
      /picks one option twice/u
    );
    assert.match(
      problem([
        { index: 0, picks: ["Postgres"], custom: null },
        { index: 0, picks: ["SQLite"], custom: null },
      ]) ?? "",
      /question 1 is answered twice/u
    );
  });
});

describe("the answer the model reads", () => {
  it("numbers the answers as the questions were asked, picks then own words", () => {
    assert.strictEqual(
      answerText("user", questions, [
        { index: 1, picks: ["staging", "production"], custom: null },
        { index: 0, picks: ["Postgres"], custom: "with pgvector" },
      ]),
      "The user answered:\n1. Database: Postgres, with pgvector\n2. Targets: staging, production"
    );
  });

  it("says a question left out had no answer", () => {
    assert.strictEqual(
      answerText("parent", questions, [
        { index: 0, picks: [], custom: "SQLite for now" },
      ]),
      "The parent answered:\n1. Database: SQLite for now\n2. Targets: (no answer)"
    );
  });
});

const lineFor = (fields: { readonly [key: string]: Json }) =>
  settledLines(approvalRecordsOf(doc(record(fields)))).map((line) => line.text);

describe("the settled transcript line", () => {
  it("says who decided and why for every settled status", () => {
    const cases: ReadonlyArray<
      readonly [{ readonly [key: string]: Json }, string]
    > = [
      [
        {
          status: "accepted",
          decidedBy: { kind: "user" },
          answer: answered("accept"),
        },
        "Approved by you",
      ],
      [
        {
          status: "accepted",
          decidedBy: { kind: "user" },
          answer: answered("accept_for_thread"),
        },
        "Allowed for this thread by you",
      ],
      [
        {
          status: "accepted",
          decidedBy: { kind: "mode", mode: "full-access" },
          answer: answered("accept"),
        },
        "Accepted by full access",
      ],
      [
        {
          status: "declined",
          decidedBy: { kind: "user" },
          reason: "not before the review",
          answer: answered("decline"),
        },
        "Declined: not before the review",
      ],
      [
        {
          status: "declined",
          decidedBy: { kind: "user" },
          answer: answered("decline"),
        },
        "Declined by you",
      ],
      [{ status: "expired", decidedBy: { kind: "expiry" } }, "Expired"],
      [
        {
          status: "cancelled",
          decidedBy: { kind: "system", why: "run-stopped" },
        },
        "Stopped",
      ],
      [
        { status: "cancelled", decidedBy: { kind: "system", why: "boot" } },
        "Cancelled at restart",
      ],
      [
        {
          kind: "brief",
          status: "revised",
          decidedBy: { kind: "user" },
          reason: "narrower",
          answer: answered("revise"),
        },
        "Sent back: narrower",
      ],
    ];

    for (const [fields, text] of cases) {
      assert.deepStrictEqual(lineFor(fields), [text], JSON.stringify(fields));
    }
  });

  it("names a parent answering its child's question, with its reason, and keeps the answers", () => {
    const [line] = settledLines(
      approvalRecordsOf(
        doc(
          record({
            kind: "user-input",
            tool: "ask_parent",
            payload: questionsJson,
            status: "accepted",
            decidedBy: {
              kind: "thread",
              threadId: "0190f0c0-0000-7000-8000-000000000001",
            },
            reason: "the brief says docs",
            answer: answered("accept", [
              { index: 0, picks: ["SQLite"], custom: null },
            ]),
          })
        )
      )
    );

    assert.strictEqual(
      line?.text,
      "Answered by its parent thread: the brief says docs"
    );
    assert.deepStrictEqual(line?.answers, [
      { header: "Database", text: "SQLite" },
      { header: "Targets", text: "(no answer)" },
    ]);
  });

  it("leaves pending records out and orders the rest by when they were asked", () => {
    const lines = settledLines(
      approvalRecordsOf(
        doc(
          record({ id: "late", askedAt: 500, status: "expired" }),
          record({ id: "open", askedAt: 100 }),
          record({ id: "early", askedAt: 200, status: "expired" })
        )
      )
    );

    assert.deepStrictEqual(
      lines.map((line) => line.id),
      ["early", "late"]
    );
  });
});
