// `cairn.approvals` version 2 (ADR 0029). The migration judge: a store written by phase 1's version 1
// definition (the records in `fixtures/approvals-v1.json`, as phase 1's ledger wrote them) is opened
// by this brain, read back with the version 2 fields, decoded by the protocol's schema, answered,
// and stays version 2 on disk. Then the record's own rules: an answer moves only the answer fields
// and never the payload, a status leaves `pending` once, and a stop cancels only what a run held.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TaskId } from "@cairn/protocol/Ids";
import { ApprovalsDocument } from "@cairn/protocol/Policy";
import type { ApprovalDecision } from "@cairn/protocol/Policy";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  createSession,
  defineDoc,
  defineTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Predicate, Result, Schema } from "effect";

import {
  answerApproval,
  applyAnswer,
  Approvals,
  cancelAbandonedApprovals,
  cancelStoppedApprovals,
  copyRecord,
  heldByRun,
  migrateApprovals,
  UNDECIDED,
} from "./CairnDocs.ts";
import type {
  ApprovalRecord,
  ApprovalsState,
  JsonRecord,
  RecordAnswer,
} from "./CairnDocs.ts";
import { piTaskId } from "./PiIds.ts";

const context = BACKGROUND_CONTEXT;

const decodeFixture = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      items: Schema.Record(
        Schema.String,
        Schema.Record(Schema.String, Schema.Json)
      ),
    })
  )
);

/** The version 1 records, as phase 1's ledger stored them. */
const v1 = decodeFixture(
  readFileSync(
    path.join(import.meta.dirname, "fixtures", "approvals-v1.json"),
    "utf-8"
  )
);

const copied = copyJson(v1);

const fixture: JsonRecord =
  Predicate.isObject(copied) && !Array.isArray(copied) ? copied : {};

/** Phase 1's definition of the document, unchanged: version 1, no `migrate`. */
const ApprovalsV1 = defineDoc<JsonRecord>({
  kind: "cairn.approvals",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

const decodeDocument = Schema.decodeUnknownResult(ApprovalsDocument);

/** A task that only has to exist: no Harness runs it, so it stays live and unmarked. */
const IdleTask = defineTask<Record<string, never>, { phase: "idle" }, null>({
  name: "cairn.test.idle",
  version: 1,
  initial: () => ({ phase: "idle" }),
  phases: {
    idle: async () => {
      await Promise.resolve();
    },
  },
  abort: async () => {
    await Promise.resolve();
  },
});

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

/** A version 1 store: one conversation whose approvals are the fixture's. */
const writeV1Store = async (file: string): Promise<ConversationId> =>
  await withSession(
    file,
    async (session) =>
      await session.commit(async (tx) => {
        const conversation = await tx.createConversation({
          ownership: { kind: "ownerless" },
        });

        const doc = await tx.doc(ApprovalsV1, conversation.id);

        doc.items = fixture.items ?? {};

        return conversation.id;
      }, context)
  );

const byUser = (
  decision: ApprovalDecision,
  reason: Option.Option<string> = Option.none()
): RecordAnswer => ({
  decision,
  by: { kind: "user" },
  reason,
  answers: Option.none(),
});

const record = (fields: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: "call-7",
  toolTaskId: 7,
  tool: "ask_user",
  kind: "user-input",
  summary: "Which database?",
  status: "pending",
  askedAt: 1000,
  expiresAt: 2000,
  answeredAt: null,
  run: null,
  executorRequestId: null,
  ...UNDECIDED,
  ...fields,
});

describe("cairn.approvals version 1 to 2", () => {
  it.live(
    "a phase 1 store reads back as version 2, and stays version 2 once written",
    () =>
      Effect.promise(async () => {
        const root = mkdtempSync(path.join(tmpdir(), "cairn-approvals-v1-"));
        const file = path.join(root, "brain.sqlite");

        try {
          const conversationId = await writeV1Store(file);

          const migrated = await withSession(
            file,
            async (session) =>
              await session.snapshot(Approvals, conversationId, context)
          );

          const items = migrated?.items ?? {};

          // Every version 1 field is kept as it was.
          for (const [id, before] of Object.entries(v1.items)) {
            const after: JsonRecord = { ...items[id] };

            assert.deepStrictEqual<unknown>(
              Object.fromEntries(
                Object.keys(before).map((key) => [key, after[key]])
              ),
              before
            );
          }

          assert.deepStrictEqual(
            Object.values(items).map((item) => [
              item.id,
              item.status,
              item.decidedBy,
              item.answer?.decision ?? null,
            ]),
            [
              [
                "call-11",
                "accepted",
                { kind: "mode", mode: "full-access" },
                "accept",
              ],
              ["call-12", "accepted", { kind: "user" }, "accept"],
              ["call-13", "declined", { kind: "user" }, "decline"],
              ["call-14", "expired", { kind: "expiry" }, null],
              ["call-15", "pending", null, null],
            ]
          );

          for (const item of Object.values(items)) {
            assert.deepInclude(item, {
              payload: null,
              reason: null,
              route: "user",
              escalatedAt: null,
              supersedes: null,
              started: null,
              briefHash: null,
              mirrorOf: null,
            });
          }

          // The protocol's schema reads the migrated document as the thread stream carries it.
          assert.isTrue(Result.isSuccess(decodeDocument(migrated)));

          // Answering the pending record writes a version 2 base, so phase 1's definition can no
          // longer read the document.
          const outcome = await withSession(
            file,
            async (session) =>
              await Effect.runPromise(
                answerApproval(
                  session,
                  conversationId,
                  "call-15",
                  byUser("decline", Option.some("not today")),
                  1_761_600_500_000
                )
              )
          );

          assert.strictEqual(outcome, "answered");

          const reread = await withSession(file, async (session) => {
            const current = await session.snapshot(
              Approvals,
              conversationId,
              context
            );

            const old = await session
              .snapshot(ApprovalsV1, conversationId, context)
              .then(() => "read", String);

            return { current, old };
          });

          assert.deepInclude(reread.current?.items["call-15"], {
            status: "declined",
            decidedBy: { kind: "user" },
            reason: "not today",
            answeredAt: 1_761_600_500_000,
          });
          assert.match(reread.old, /newer version 2 than 1/u);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      })
  );

  it("keeps every version 1 record, and one no version can read as cancelled", () => {
    const migrated = migrateApprovals(
      { items: { bad: { id: 3, askedAt: 1200 } } },
      1
    );

    assert.deepInclude(migrated.items.bad, {
      id: "bad",
      status: "cancelled",
      decidedBy: { kind: "system", why: "boot" },
      askedAt: 1200,
      answeredAt: 1200,
    });
    assert.include(migrated.items.bad?.summary, '"askedAt":1200');
    // The kept record is one the protocol reads.
    assert.isTrue(Result.isSuccess(decodeDocument(migrated)));

    const kept: ApprovalsState = migrateApprovals(fixture, 1);

    assert.deepStrictEqual(Object.keys(kept.items), [
      "call-11",
      "call-12",
      "call-13",
      "call-14",
      "call-15",
    ]);
  });

  it("refuses a version it has no migration from, instead of dropping its records", () => {
    assert.throws(() => {
      migrateApprovals(fixture, 0);
    }, /no migration from version 0/u);
  });
});

describe("an answer to a record", () => {
  const questions: JsonRecord = {
    type: "questions",
    questions: [
      {
        header: "Database",
        question: "Which one?",
        options: [],
        multiSelect: false,
        allowCustomAnswer: true,
      },
    ],
  };

  it("never changes the payload, whatever the decision", () => {
    const decisions: ReadonlyArray<ApprovalDecision> = [
      "accept",
      "accept_for_thread",
      "accept_sample",
      "decline",
      "revise",
    ];

    const moves = new Set([
      "status",
      "answeredAt",
      "answer",
      "decidedBy",
      "reason",
    ]);

    for (const kind of ["user-input", "brief", "tool-call"] as const) {
      for (const decision of decisions) {
        for (const reason of [Option.none(), Option.some("because")]) {
          const asked = record({ kind, payload: questions });
          const before = copyRecord(asked);

          applyAnswer(asked, byUser(decision, reason), 1500);

          for (const [key, value] of Object.entries(before)) {
            if (!moves.has(key)) {
              assert.deepStrictEqual(
                asked[key],
                value,
                `${kind} ${decision}: ${key}`
              );
            }
          }
        }
      }
    }
  });

  it("records who decided and why, once", () => {
    const asked = record();

    assert.strictEqual(
      applyAnswer(asked, byUser("decline", Option.some("use Postgres")), 1500),
      "answered"
    );
    assert.strictEqual(
      applyAnswer(asked, byUser("accept"), 1600),
      "already_settled"
    );
    assert.deepInclude(asked, {
      status: "declined",
      answeredAt: 1500,
      decidedBy: { kind: "user" },
      reason: "use Postgres",
      answer: { decision: "decline", answers: null, note: null, launch: null },
    });
  });

  it("takes answers only for questions, and Send back only for a brief", () => {
    const answers = Option.some([
      { index: 0, picks: ["Postgres"], custom: null },
    ]);

    const toolCall = record({ kind: "tool-call" });

    assert.strictEqual(
      applyAnswer(toolCall, { ...byUser("accept"), answers }, 1500),
      "refused_answers"
    );
    assert.strictEqual(
      applyAnswer(toolCall, byUser("revise"), 1500),
      "refused_revise"
    );
    assert.strictEqual(toolCall.status, "pending");

    const question = record({ payload: questions });

    assert.strictEqual(
      applyAnswer(question, { ...byUser("accept"), answers }, 1500),
      "answered"
    );
    assert.deepStrictEqual(question.answer?.answers, [
      { index: 0, picks: ["Postgres"], custom: null },
    ]);

    const brief = record({ kind: "brief" });

    assert.strictEqual(
      applyAnswer(brief, byUser("revise", Option.some("narrower")), 1500),
      "answered"
    );
    assert.strictEqual(brief.status, "revised");

    // Send back says what to change: no notes, or blank ones, are refused.
    for (const reason of [Option.none(), Option.some("  ")]) {
      const unsaid = record({ kind: "brief" });

      assert.strictEqual(
        applyAnswer(unsaid, byUser("revise", reason), 1500),
        "refused_revise_reason"
      );
      assert.strictEqual(unsaid.status, "pending");
    }
  });
});

describe("what a stop cancels", () => {
  it("only records a run holds: no brief, criteria, escalated question or mirror", () => {
    assert.deepStrictEqual(
      [
        record(),
        record({ kind: "tool-call" }),
        record({ kind: "brief" }),
        record({ kind: "criteria" }),
        record({ escalatedAt: 1200 }),
        record({
          toolTaskId: 0,
          mirrorOf: { threadId: "t", approvalId: "call-1" },
        }),
        record({ status: "accepted" }),
      ].map(heldByRun),
      [true, true, false, false, false, false, false]
    );
  });

  it.live(
    "only the stopped run's records, and at boot only those whose tool task is gone",
    () =>
      Effect.promise(async () => {
        const root = mkdtempSync(path.join(tmpdir(), "cairn-approvals-own-"));
        const file = path.join(root, "brain.sqlite");

        try {
          await withSession(file, async (session) => {
            // Two runs of one conversation, each with a tool task waiting on its own record, and
            // a record whose tool task the store no longer has.
            const { conversationId, stopped } = await session.commit(
              async (tx) => {
                const conversation = await tx.createConversation({
                  ownership: { kind: "ownerless" },
                });

                const make = async (owner: Option.Option<number>) =>
                  Number(
                    await tx.createTask(
                      IdleTask,
                      {},
                      {
                        conversationId: conversation.id,
                        ownership: Option.match(owner, {
                          onNone: () => ({ kind: "conversation" as const }),
                          onSome: (taskId) => ({
                            kind: "task" as const,
                            taskId: piTaskId(TaskId.make(taskId)),
                          }),
                        }),
                      }
                    )
                  );

                const runA = await make(Option.none());
                const toolA = await make(Option.some(runA));
                const runB = await make(Option.none());
                const toolB = await make(Option.some(runB));
                const doc = await tx.doc(Approvals, conversation.id);

                for (const [id, toolTaskId] of [
                  ["call-a", toolA],
                  ["call-b", toolB],
                  ["call-gone", 9999],
                ] as const) {
                  doc.items[id] = record({
                    id,
                    toolTaskId,
                    kind: "tool-call",
                  });
                }

                return {
                  conversationId: conversation.id,
                  stopped: [piTaskId(TaskId.make(runA))],
                };
              },
              context
            );

            const cancelled = await Effect.runPromise(
              cancelStoppedApprovals(session, conversationId, stopped, 1500)
            );

            assert.deepStrictEqual(cancelled, ["call-a"]);

            // Run B's tool task is live and unmarked, so its record still waits.
            const abandoned = await Effect.runPromise(
              cancelAbandonedApprovals(session, conversationId, 1600)
            );

            assert.deepStrictEqual(abandoned, ["call-gone"]);

            const after = await session.snapshot(
              Approvals,
              conversationId,
              context
            );

            const items = after?.items ?? {};

            assert.deepStrictEqual(
              Object.values(items).map((item) => [
                item.id,
                item.status,
                item.decidedBy,
              ]),
              [
                ["call-a", "cancelled", { kind: "system", why: "run-stopped" }],
                ["call-b", "pending", null],
                ["call-gone", "cancelled", { kind: "system", why: "boot" }],
              ]
            );
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      })
  );
});
