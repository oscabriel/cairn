// The user's side of a goal (`goal.setCriteria` and the user's mark) over a real Harness: the user
// binds criteria in one host commit, the rules `goal_criteria` keeps hold (a subagent's thread, a
// model judge of the thread's family, a verification judge), a mark lands only on a criterion the
// user judges, and each refusal reaches the client as the public error it can act on.

import {
  ConversationId as ProtocolConversationId,
  ThreadId,
} from "@cairn/protocol/Ids";
import type { JudgeRef } from "@cairn/protocol/Policy";
import { RoleSpec } from "@cairn/protocol/Roles";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer, Option, Result } from "effect";

import { Brain } from "../brain/Brain.ts";
import { ThreadReceipt } from "../brain/CairnDocs.ts";
import { RoleAliases, RoleError } from "../models/RoleAliases.ts";
import { goalErrorOf } from "../rpc/GoalHandlers.ts";
import { ChildDoc } from "../subagents/SubagentDocs.ts";
import { GoalBook } from "./GoalBook.ts";
import { GoalDoc } from "./GoalDocs.ts";
import { openGoalKit } from "./GoalTestKit.ts";
import type { GoalKit } from "./GoalTestKit.ts";
import { NO_JUDGE_FAULTS } from "./JudgeRun.ts";

const context = BACKGROUND_CONTEXT;

const CLAUDE = { provider: "anthropic", modelId: "claude-test" };

const GOAL = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0001");

const CHILD = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0002");

const MISSING = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0003");

const tests: JudgeRef = {
  kind: "command",
  argv: ["npm", "test"],
  expectExit: 0,
  timeoutSec: 60,
};

const modelJudge = (spec: string): JudgeRef => ({
  kind: "model",
  spec: RoleSpec.make(spec),
  rubric: "Shows the output",
});

/** A thread in the brain with a receipt, as `ensureThread` leaves it; a child when `child`. */
const threadIn = (kit: GoalKit, threadId: ThreadId, child: boolean) =>
  Effect.promise(async () => {
    const conversation = await kit.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: CLAUDE },
        init: async (tx, id) => {
          if (child) {
            const link = await tx.doc(ChildDoc, id);

            link.parentConversationId = 1;
          }
        },
      },
      context
    );

    await kit.harness.commit(async (tx) => {
      const receipt = await tx.doc(ThreadReceipt, threadId, {
        conversationId: 0,
      });

      receipt.conversationId = ProtocolConversationId.make(conversation.id);
    }, context);

    return conversation;
  });

/** The goal service over `kit`'s Harness, with every literal `provider/modelId` resolving. */
const bookOver = (kit: GoalKit) =>
  GoalBook.layerNoDeps.pipe(
    Layer.provide(
      Layer.mock(Brain)({
        session: Effect.succeed({
          harness: kit.harness,
          storage: new MemoryStorage(),
          generation: 1,
        }),
        now: () => 40,
      })
    ),
    Layer.provide(
      Layer.mock(RoleAliases)({
        resolve: (spec) => {
          const [provider, modelId] = spec.split("/");

          return provider === undefined || modelId === undefined
            ? Effect.fail(
                new RoleError({
                  message: `${spec} does not resolve.`,
                  spec,
                  reason: "unbound_role",
                  skipped: [],
                })
              )
            : Effect.succeed({
                spec: RoleSpec.make(spec),
                role: null,
                model: { provider, modelId },
                thinkingLevel: null,
                via: "literal" as const,
                skipped: [],
                family: "other" as const,
                priced: true,
              });
        },
      })
    )
  );

const kitScope = Effect.acquireRelease(
  Effect.promise(
    async () =>
      await openGoalKit(
        {
          storage: new MemoryStorage(),
          model: CLAUDE,
          responses: [],
          judges: {
            resolve: async () =>
              await Promise.resolve(Result.fail("No model judges here.")),
            ask: async () =>
              await Promise.resolve(Result.fail("No model judges here.")),
          },
          faults: NO_JUDGE_FAULTS,
        },
        context
      )
  ),
  (kit) =>
    Effect.promise(async () => {
      await kit.close();
    })
);

describe("the user's side of a goal", () => {
  it.live(
    "binds the user's criteria, refuses what cannot judge, and marks only a user's criterion",
    () =>
      Effect.gen(function* () {
        const kit = yield* kitScope;
        const conversation = yield* threadIn(kit, GOAL, false);

        yield* threadIn(kit, CHILD, true);

        const services = yield* Layer.build(bookOver(kit));
        const book = Context.get(services, GoalBook);

        yield* book.setCriteria({
          threadId: GOAL,
          objective: Option.some("Ship the parser"),
          criteria: [
            { text: "Tests pass", judge: tests },
            { text: "The user likes it", judge: { kind: "user" } },
            {
              text: "Docs read well",
              judge: modelJudge("opencode-go/gpt-6-luna"),
            },
          ],
        });

        const goal = yield* Effect.promise(
          async () =>
            await kit.harness.snapshot(GoalDoc, conversation.id, context)
        );

        assert.strictEqual(goal?.objective, "Ship the parser");
        assert.deepStrictEqual(
          goal?.criteria.map((criterion) => [
            criterion.id,
            criterion.state,
            criterion.changedAt,
          ]),
          [
            ["c1", "open", 40],
            ["c2", "open", 40],
            ["c3", "open", 40],
          ]
        );

        const refused = (input: Parameters<typeof book.setCriteria>[0]) =>
          book.setCriteria(input).pipe(Effect.flip);

        const sameFamily = yield* refused({
          threadId: GOAL,
          objective: Option.none(),
          criteria: [
            {
              text: "Reads well",
              judge: modelJudge("opencode-go/claude-haiku-5-5"),
            },
          ],
        });

        assert.strictEqual(sameFamily.reason, "invalid_input");
        assert.include(sameFamily.message, "same family");
        assert.deepStrictEqual(
          sameFamily.field,
          Option.some("criteria[0].judge")
        );

        const verification = yield* refused({
          threadId: GOAL,
          objective: Option.none(),
          criteria: [
            {
              text: "Verified",
              judge: { kind: "verification", recipe: "web" },
            },
          ],
        });

        assert.include(verification.message, "phase 4");

        const child = yield* refused({
          threadId: CHILD,
          objective: Option.none(),
          criteria: [{ text: "Tests pass", judge: tests }],
        });

        assert.include(child.message, "is a subagent");

        const missing = yield* refused({
          threadId: MISSING,
          objective: Option.none(),
          criteria: [],
        });

        assert.strictEqual(missing.reason, "thread_not_found");
        assert.strictEqual(goalErrorOf(missing, "req-1")._tag, "NotFound");
        assert.strictEqual(
          goalErrorOf(sameFamily, "req-1")._tag,
          "InvalidInput"
        );

        // A refused binding changed nothing.
        const after = yield* Effect.promise(
          async () =>
            await kit.harness.snapshot(GoalDoc, conversation.id, context)
        );

        assert.strictEqual(after?.criteria.length, 3);

        const byHand = yield* book
          .mark({
            threadId: GOAL,
            criterionId: "c1",
            ok: true,
            note: Option.none(),
          })
          .pipe(Effect.flip);

        assert.include(byHand.message, "decided by its judge's run");

        assert.strictEqual(
          yield* book.mark({
            threadId: GOAL,
            criterionId: "c2",
            ok: true,
            note: Option.some("Looks right"),
          }),
          "recorded"
        );

        const marked = yield* Effect.promise(
          async () =>
            await kit.harness.snapshot(GoalDoc, conversation.id, context)
        );

        assert.deepStrictEqual(
          marked?.criteria.map((criterion) => criterion.state),
          ["open", "met", "open"]
        );
        assert.strictEqual(marked?.criteria[1]?.verdict?.judge.kind, "user");
      }).pipe(Effect.scoped)
  );
});
