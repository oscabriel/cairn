// The lifecycle lines the review of D4 found missing (coding standard S57). The approval ledger's
// host-side settlements (an answer, a stop's cancel, an abandoned record's cancel) each leave a
// line, taken or not, so a record's `approval_asked` is never the last word in the journal. And the
// journal maps a thread to its conversation once, where the brain binds them: a launched thread at
// `ensureThread`, a subagent at its start, so a line that names a conversation can be traced to
// the thread the user sees. Kept under `brain/`, where pi-durable may be imported by tests (S42).

import { readFileSync } from "node:fs";
import path from "node:path";

import { TaskId } from "@cairn/protocol/Ids";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createSession,
  defineTask,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Logger, Option, References, Result } from "effect";

import {
  UNDECIDED,
  cancelStoppedApprovals,
  answerApproval,
  cancelAbandonedApprovals,
} from "../approvals/ApprovalLedger.ts";
import type { RecordAnswer } from "../approvals/ApprovalLedger.ts";
import { slackened, testLimit } from "../EventuallyTestKit.ts";
import { Approvals } from "./CairnDocs.ts";
import type { ApprovalRecord } from "./CairnDocs.ts";
import { runScenario } from "./conformance/HarnessConformance.ts";
import { piDurableTarget } from "./conformance/Targets.ts";
import { parseTranscript } from "./conformance/Transcript.ts";
import { piTaskId } from "./PiIds.ts";

const context = BACKGROUND_CONTEXT;

/** The annotations of one log line, as `Logger` hands them over. */
type Annotations = ReturnType<
  typeof References.CurrentLogAnnotations.defaultValue
>;

/** One logged line: its message and its annotations. */
interface Line {
  readonly message: string;
  readonly annotations: Annotations;
}

/** A logger that keeps every line in `lines`, as the app's JSON logger would write it. */
const keeping = (lines: Array<Line>) =>
  Logger.layer(
    [
      Logger.make((options) => {
        lines.push({
          message: String(options.message),
          annotations: options.fiber.getRef(References.CurrentLogAnnotations),
        });
      }),
    ],
    { mergeWithExisting: false }
  );

/** The annotations of every kept line whose `event` is `event`. */
const eventsOf = (lines: ReadonlyArray<Line>, event: string) =>
  lines.filter((line) => line.annotations.event === event);

/** A task that only has to exist: no Harness runs it, so it stays live and unmarked. */
const IdleTask = defineTask<Record<string, never>, { phase: "idle" }, null>({
  name: "cairn.test.lifecycle-idle",
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

const record = (fields: Partial<ApprovalRecord>): ApprovalRecord => ({
  id: "call-1",
  toolTaskId: 9999,
  tool: "bash",
  kind: "tool-call",
  summary: "Run a command",
  status: "pending",
  askedAt: 1000,
  expiresAt: 100_000,
  answeredAt: null,
  run: null,
  executorRequestId: null,
  ...UNDECIDED,
  ...fields,
});

const accept: RecordAnswer = {
  decision: "accept",
  by: { kind: "user" },
  reason: Option.none(),
  answers: Option.none(),
  launch: Option.none(),
};

/**
 * A session over a memory store with one conversation: a run task, a tool task it owns, and three
 * pending gated calls: `call-run` held by that tool task, `call-gone` whose tool task the store no
 * longer has, and `call-free` for the answers.
 */
const seeded = Effect.promise(async () => {
  const session = createSession(new MemoryStorage());

  const seed = await session.commit(async (tx) => {
    const conversation = await tx.createConversation({
      ownership: { kind: "ownerless" },
    });

    const run = await tx.createTask(
      IdleTask,
      {},
      { conversationId: conversation.id, ownership: { kind: "conversation" } }
    );

    const tool = await tx.createTask(
      IdleTask,
      {},
      {
        conversationId: conversation.id,
        ownership: { kind: "task", taskId: run },
      }
    );

    const doc = await tx.doc(Approvals, conversation.id);

    doc.items["call-run"] = record({
      id: "call-run",
      toolTaskId: Number(tool),
    });
    doc.items["call-gone"] = record({ id: "call-gone", toolTaskId: 9999 });
    doc.items["call-free"] = record({ id: "call-free", toolTaskId: 9998 });

    return { conversationId: conversation.id, run };
  }, context);

  return { session, ...seed };
});

describe("the approval ledger's host-side settlements", () => {
  it.effect("an answer leaves a line whether it was taken or not", () =>
    Effect.gen(function* () {
      const lines: Array<Line> = [];
      const { session, conversationId } = yield* seeded;

      const answer = (approvalId: string) =>
        answerApproval(session, conversationId, approvalId, accept, 1500).pipe(
          Effect.provide(keeping(lines))
        );

      assert.strictEqual(yield* answer("call-free"), "answered");
      assert.strictEqual(yield* answer("call-free"), "already_settled");
      assert.strictEqual(yield* answer("call-missing"), "not_found");

      assert.deepStrictEqual(
        eventsOf(lines, "approval_answered").map((line) => [
          line.message,
          line.annotations.conversationId,
          line.annotations.approvalId,
          line.annotations.outcome,
          line.annotations.status,
          line.annotations.decision,
          line.annotations.decidedBy,
        ]),
        [
          [
            "approval answered",
            conversationId,
            "call-free",
            "answered",
            "accepted",
            "accept",
            "user",
          ],
          [
            "approval answer not taken",
            conversationId,
            "call-free",
            "already_settled",
            "accepted",
            "accept",
            "user",
          ],
          [
            "approval answer not taken",
            conversationId,
            "call-missing",
            "not_found",
            null,
            "accept",
            "user",
          ],
        ]
      );

      yield* Effect.promise(async () => {
        await session.close(context);
      });
    })
  );

  it.effect(
    "a stop's cancel and an abandoned record's cancel each leave a line naming what they cancelled and why",
    () =>
      Effect.gen(function* () {
        const lines: Array<Line> = [];
        const { session, conversationId, run } = yield* seeded;

        const stopped = yield* cancelStoppedApprovals(
          session,
          conversationId,
          [piTaskId(TaskId.make(Number(run)))],
          1500
        ).pipe(Effect.provide(keeping(lines)));

        const abandoned = yield* cancelAbandonedApprovals(
          session,
          conversationId,
          1600,
          "boot"
        ).pipe(Effect.provide(keeping(lines)));

        assert.deepStrictEqual(stopped, ["call-run"]);
        assert.deepStrictEqual(abandoned, ["call-gone", "call-free"]);

        assert.deepStrictEqual(
          eventsOf(lines, "approvals_cancelled").map((line) => [
            line.message,
            line.annotations.conversationId,
            line.annotations.why,
            line.annotations.cancelled,
            line.annotations.approvalIds,
          ]),
          [
            [
              "approvals cancelled",
              conversationId,
              "run-stopped",
              1,
              "call-run",
            ],
            [
              "approvals cancelled",
              conversationId,
              "boot",
              2,
              "call-gone,call-free",
            ],
          ]
        );

        yield* Effect.promise(async () => {
          await session.close(context);
        });
      })
  );

  it.effect("a cancel that ends no record leaves no line", () =>
    Effect.gen(function* () {
      const lines: Array<Line> = [];
      const { session, conversationId } = yield* seeded;

      // A stop whose run held no record, then a boot repair that finds nothing left to cancel.
      const stopped = yield* cancelStoppedApprovals(
        session,
        conversationId,
        [],
        1500
      ).pipe(Effect.provide(keeping(lines)));

      const first = yield* cancelAbandonedApprovals(
        session,
        conversationId,
        1600,
        "boot"
      ).pipe(Effect.provide(keeping(lines)));

      const again = yield* cancelAbandonedApprovals(
        session,
        conversationId,
        1700,
        "boot"
      ).pipe(Effect.provide(keeping(lines)));

      assert.deepStrictEqual(stopped, []);
      assert.deepStrictEqual(first, ["call-gone", "call-free"]);
      assert.deepStrictEqual(again, []);

      assert.deepStrictEqual(
        eventsOf(lines, "approvals_cancelled").map((line) => [
          line.annotations.why,
          line.annotations.cancelled,
        ]),
        [["boot", 2]]
      );

      yield* Effect.promise(async () => {
        await session.close(context);
      });
    })
  );
});

const scenarios = path.join(import.meta.dirname, "conformance", "scenarios");

/** Runs `scenarios/<name>.ndjson` on pi-durable, keeping every line it logged in `lines`. */
const runKeeping = (name: string, lines: Array<Line>) =>
  Effect.gen(function* () {
    const scenario = Result.getOrThrow(
      parseTranscript(
        readFileSync(path.join(scenarios, `${name}.ndjson`), "utf-8")
      )
    );

    const outcome = yield* runScenario(scenario, piDurableTarget, {
      timeout: slackened(Duration.seconds(10)),
      mutations: new Set(),
      awaitAtRest: false,
    }).pipe(Effect.provide(keeping(lines)));

    assert.deepStrictEqual(outcome.failure, Option.none());
  });

describe("the journal's map from a thread to its conversation", () => {
  it.live(
    "a launched thread's binding and a subagent's start each name the thread and its conversation",
    () =>
      Effect.gen(function* () {
        const lines: Array<Line> = [];

        yield* runKeeping("subagent_spawn_after_go", lines);

        const bound = eventsOf(lines, "thread_bound");

        assert.isAtLeast(bound.length, 1, "no thread_bound line");

        const parent = bound[0]?.annotations;

        assert.isString(parent?.threadId);
        assert.isNumber(parent?.conversationId);

        const started = eventsOf(lines, "subagent_start").filter(
          (line) => line.annotations.outcome === "started"
        );

        assert.lengthOf(started, 1, "no subagent_start line for the child");

        const child = started[0]?.annotations;

        // The parent's ids, as the binding wrote them, and the child's own pair.
        assert.strictEqual(child?.conversationId, parent?.conversationId);
        assert.strictEqual(child?.parentThreadId, parent?.threadId);
        assert.isString(child?.childThreadId);
        assert.isNumber(child?.childConversationId);
        assert.notStrictEqual(
          child?.childConversationId,
          parent?.conversationId
        );
      }),
    testLimit(30_000)
  );

  it.live(
    "a user's stop of a gated call leaves a line for its cancel",
    () =>
      Effect.gen(function* () {
        const lines: Array<Line> = [];

        // The scenario's `gate` asks on the conformance suite's own runner, so only the host
        // side's line is kept here; the ask's line is `DurableRunner.test.ts`'s.
        yield* runKeeping("approval_cancelled_on_stop", lines);

        assert.deepStrictEqual(
          eventsOf(lines, "approvals_cancelled").map((line) => [
            line.annotations.why,
            line.annotations.cancelled,
          ]),
          [["run-stopped", 1]]
        );
      }),
    testLimit(30_000)
  );
});
