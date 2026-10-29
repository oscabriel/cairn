// Judges the approval push rules on their own: which requests a push may be about, how each kind
// reads, and when a late push or the reminder is owed.

import { assert, describe, it } from "@effect/vitest";
import { Duration, Option } from "effect";

import { testThreadId } from "../shell/ShellTestKit.ts";
import {
  followUpDue,
  newestRequest,
  requestBody,
  requestLine,
  requestsToPush,
} from "./RequestPush.ts";
import type { RequestClaims, RequestPush } from "./RequestPush.ts";
import {
  escalatedQuestion,
  pendingBrief,
  pendingQuestion,
  pendingRecord,
  question,
} from "./RequestTestKit.ts";

const T = 1_792_670_400_000;

const timings = {
  lateAfter: Duration.seconds(60),
  remindAfter: Duration.minutes(15),
};

const noClaims: RequestClaims = {
  first: Option.none(),
  late: Option.none(),
  remind: false,
};

describe(requestsToPush, () => {
  it("keeps pending requests routed to the user, and only the mirror of an escalated question", () => {
    const asked = question("Database", "Which database?");

    const escalated = escalatedQuestion(
      "q-2",
      T,
      T + 5000,
      asked,
      testThreadId(2)
    );

    const records = [
      pendingRecord("tool-1", T),
      pendingQuestion("q-1", T + 1, asked, { route: "parent" }),
      escalated.child,
      escalated.mirror,
      pendingRecord("done-1", T + 2, { status: "accepted" }),
      pendingBrief("brief-1", T + 3, "Fix the parser"),
    ];

    assert.deepStrictEqual(
      requestsToPush(records).map((record) => record.id),
      ["tool-1", "esc-q-2", "brief-1"]
    );
  });
});

describe(requestLine, () => {
  it("says what each kind asks", () => {
    assert.deepStrictEqual(
      [
        pendingBrief("b", T, "Fix the parser"),
        pendingRecord("t", T),
        pendingQuestion("q", T, question("Database", "Which database?")),
        pendingQuestion("q2", T, question("Database", "Which database?"), {
          payload: {
            type: "questions",
            questions: [
              question("Database", "Which database?"),
              question("Name", "What is it called?"),
            ],
          },
        }),
        pendingRecord("s", T, {
          kind: "sign-in",
          summary: "Sign in to Linear",
        }),
        pendingRecord("c", T, {
          kind: "criteria",
          payload: {
            type: "criteria",
            criteria: [
              { text: "pnpm check passes", judge: { kind: "user" } },
              { text: "The page loads", judge: { kind: "user" } },
            ],
          },
        }),
      ].map(requestLine),
      [
        "Go? Fix the parser",
        "Approve bash: pnpm test",
        "Database: Which database?",
        "Database: Which database? (and 1 more)",
        "Sign in to Linear",
        "Approve criteria: pnpm check passes (and 1 more)",
      ]
    );
  });
});

const base = (
  fields: Partial<Omit<RequestPush, "thread">>
): Omit<RequestPush, "thread"> => ({
  request: pendingQuestion("q", T, question("Database", "Which database?")),
  count: 1,
  asker: Option.none(),
  reminder: false,
  ...fields,
});

describe(requestBody, () => {
  it("names the asking child, counts the requests and marks the reminder", () => {
    assert.deepStrictEqual(
      [
        base({}),
        base({ asker: Option.some("Survey the schema") }),
        base({ count: 3 }),
        base({ count: 2, reminder: true, asker: Option.some("Survey") }),
      ].map(requestBody),
      [
        "Database: Which database?",
        "Survey the schema asks: Database: Which database?",
        "3 things need you. Database: Which database?",
        "Still waiting. 2 things need you. Survey asks: Database: Which database?",
      ]
    );
  });
});

describe(newestRequest, () => {
  it("picks the latest asked, and none from none", () => {
    assert.deepStrictEqual(
      Option.map(
        newestRequest([
          pendingRecord("a", T + 10),
          pendingRecord("b", T + 30),
          pendingRecord("c", T + 20),
        ]),
        (record) => record.id
      ),
      Option.some("b")
    );
    assert.isTrue(Option.isNone(newestRequest([])));
  });
});

const sent = (at: number) => Option.some({ outcome: "sent" as const, at });

const suppressed = (at: number) =>
  Option.some({ outcome: "suppressed" as const, at });

describe(followUpDue, () => {
  const request = { askedAt: T };

  it("owes a late push once a suppressed or missed request is 60 s old", () => {
    assert.deepStrictEqual(
      [
        followUpDue(
          request,
          { ...noClaims, first: suppressed(T) },
          T + 59_999,
          timings
        ),
        followUpDue(
          request,
          { ...noClaims, first: suppressed(T) },
          T + 60_000,
          timings
        ),
        followUpDue(request, noClaims, T + 60_000, timings),
        followUpDue(
          request,
          { ...noClaims, first: suppressed(T), late: sent(T + 60_000) },
          T + 61_000,
          timings
        ),
      ],
      [Option.none(), Option.some("late"), Option.some("late"), Option.none()]
    );
  });

  it("owes one reminder 15 minutes after the last push, and nothing after it", () => {
    const fifteen = 15 * 60_000;

    assert.deepStrictEqual(
      [
        followUpDue(
          request,
          { ...noClaims, first: sent(T) },
          T + fifteen - 1,
          timings
        ),
        followUpDue(
          request,
          { ...noClaims, first: sent(T) },
          T + fifteen,
          timings
        ),
        followUpDue(
          request,
          { ...noClaims, first: suppressed(T), late: sent(T + 14 * 60_000) },
          T + fifteen,
          timings
        ),
        followUpDue(
          request,
          { ...noClaims, first: suppressed(T), late: sent(T + 14 * 60_000) },
          T + 29 * 60_000,
          timings
        ),
        followUpDue(
          request,
          { first: sent(T), late: Option.none(), remind: true },
          T + 10 * fifteen,
          timings
        ),
      ],
      [
        Option.none(),
        Option.some("remind"),
        Option.none(),
        Option.some("remind"),
        Option.none(),
      ]
    );
  });
});
