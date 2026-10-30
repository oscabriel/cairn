// `goal.setCriteria` and `goal.mark` over the stubs, as `Handlers.ts` layers them, with the goal
// service over the scripted harness's goals (`GoalBook.layerScripted`): the user binds a goal, marks
// the criterion a user judge decides, and the thread's `cairn.goal` and its GoalUpdated tally follow
// from the verdict writer; a mark on a criterion a command decides, on one the goal does not hold,
// or on a thread the brain does not hold, is refused with the public error a client acts on, and
// changes nothing. A model judge of the thread's own family is refused at binding.

import { goalOf, goalTallyOf } from "@cairn/client-logic/GoalProgress";
import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { GOAL_DOCUMENT } from "@cairn/protocol/Policy";
import type { CriterionProposal } from "@cairn/protocol/Policy";
import { RoleSpec } from "@cairn/protocol/Roles";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Predicate, Stream } from "effect";
import type { Scope } from "effect";
import { RpcTest } from "effect/rpc";

import { HarnessSeam } from "../brain/HarnessSeam.ts";
import type { GoalUpdated, HarnessEvent } from "../brain/HarnessSeam.ts";
import { ScriptedHarness } from "../brain/ScriptedHarness.ts";
import { ViewerTest } from "../shell/ShellTestKit.ts";
import { GoalBook } from "../verdicts/GoalBook.ts";
import { GoalHandlers } from "./GoalHandlers.ts";
import { stubHandlers } from "./StubHandlers.ts";

const Stubs = CairnRpcs.toLayer(Effect.succeed(CairnRpcs.of(stubHandlers)));

const Services = Layer.mergeAll(
  Stubs,
  GoalHandlers.pipe(Layer.provide(GoalBook.layerScripted))
).pipe(
  Layer.provideMerge(ViewerTest),
  Layer.provideMerge(ScriptedHarness.layer)
);

const makeClient = RpcTest.makeClient(CairnRpcs);

const run = <A, E>(
  body: Effect.Effect<A, E, Layer.Success<typeof Services> | Scope.Scope>
) => body.pipe(Effect.scoped, Effect.provide(Services));

const GOAL = ThreadId.make("0190f0c0-0000-7000-8000-0000000000c1");

const MISSING = ThreadId.make("0190f0c0-0000-7000-8000-0000000000c2");

const CLAUDE = { provider: "anthropic", modelId: "claude-test" };

const CRITERIA: ReadonlyArray<CriterionProposal> = [
  {
    text: "Tests pass",
    judge: {
      kind: "command",
      argv: ["npm", "test"],
      expectExit: 0,
      timeoutSec: 60,
    },
  },
  { text: "The user likes it", judge: { kind: "user" } },
  {
    text: "Docs read well",
    judge: {
      kind: "model",
      spec: RoleSpec.make("opencode-go/gpt-6-luna"),
      rubric: "Reads the docs",
    },
  },
];

/** The goal thread, on a Claude model. */
const ensureGoalThread = Effect.gen(function* () {
  const seam = yield* HarnessSeam;

  yield* seam.ensureThread({
    threadId: GOAL,
    projectId: ProjectId.make("goals"),
    model: CLAUDE,
    thinkingLevel: "off",
    cwd: "/tmp",
    instructions: Option.none(),
    runtimeMode: "full-access",
  });
});

/** The goal thread's `cairn.goal` as the thread stream shows it now. */
const goalNow = Effect.gen(function* () {
  const seam = yield* HarnessSeam;

  const frame = yield* seam
    .watch(GOAL)
    .pipe(Stream.take(1), Stream.runHead, Effect.orDie);

  return Option.flatMap(frame, (item) =>
    Predicate.isTagged(item, "Snapshot")
      ? goalOf(item.view.docs[GOAL_DOCUMENT])
      : Option.none()
  );
});

const statesNow = Effect.map(goalNow, (goal) =>
  Option.match(goal, {
    onNone: () => [],
    onSome: (found) => found.criteria.map((criterion) => criterion.state),
  })
);

describe("goal RPCs", () => {
  it.live(
    "goal.mark records the user's verdict on a user criterion, and only there",
    () =>
      run(
        Effect.gen(function* () {
          yield* ensureGoalThread;

          const seam = yield* HarnessSeam;
          const client = yield* makeClient;

          // Every GoalUpdated from here on, so the tally the shell row is set from is checked too.
          const updates = yield* seam.events.pipe(
            Stream.filter(
              (event: HarnessEvent): event is typeof GoalUpdated.Type =>
                Predicate.isTagged(event, "GoalUpdated")
            ),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped
          );

          yield* Effect.sleep("10 millis");

          // Before any binding, the thread has no goal document at all.
          assert.isTrue(Option.isNone(yield* goalNow));

          yield* client["goal.setCriteria"]({
            threadId: GOAL,
            objective: Option.some("Ship the parser"),
            criteria: CRITERIA,
          });

          assert.deepStrictEqual(yield* statesNow, ["open", "open", "open"]);

          yield* client["goal.mark"]({
            threadId: GOAL,
            criterionId: "c2",
            ok: true,
            note: Option.some("Looks right"),
          });

          const marked = yield* goalNow;

          assert.deepStrictEqual(yield* statesNow, ["open", "met", "open"]);
          assert.deepStrictEqual(
            Option.map(marked, (goal) => {
              const verdict = goal.criteria[1]?.verdict;

              return [verdict?.judge.kind, verdict?.evidence.note, verdict?.ok];
            }),
            Option.some(["user", "Looks right", true])
          );

          const tallies = yield* Fiber.join(updates);

          assert.deepStrictEqual(
            [...tallies].map((event) => Option.getOrNull(event.tally)),
            [
              { total: 3, met: 0, failed: 0 },
              { total: 3, met: 1, failed: 0 },
            ]
          );
          assert.deepStrictEqual(
            goalTallyOf(marked),
            Option.some({ total: 3, met: 1, failed: 0 })
          );

          // The user changes their mind: a later mark wins, and the criterion is not met.
          yield* client["goal.mark"]({
            threadId: GOAL,
            criterionId: "c2",
            ok: false,
            note: Option.none(),
          });

          assert.deepStrictEqual(yield* statesNow, ["open", "failed", "open"]);

          const byHand = yield* client["goal.mark"]({
            threadId: GOAL,
            criterionId: "c1",
            ok: true,
            note: Option.none(),
          }).pipe(Effect.flip);

          assert.strictEqual(byHand._tag, "InvalidInput");
          assert.include(byHand.message, "decided by its judge's run");
          assert.deepStrictEqual(
            Predicate.isTagged(byHand, "InvalidInput")
              ? byHand.field
              : Option.none(),
            Option.some("criterionId")
          );

          const unknown = yield* client["goal.mark"]({
            threadId: GOAL,
            criterionId: "c9",
            ok: true,
            note: Option.none(),
          }).pipe(Effect.flip);

          assert.strictEqual(unknown._tag, "InvalidInput");
          assert.include(unknown.message, "is not on thread");

          const missing = yield* client["goal.mark"]({
            threadId: MISSING,
            criterionId: "c2",
            ok: true,
            note: Option.none(),
          }).pipe(Effect.flip);

          assert.strictEqual(missing._tag, "NotFound");

          // None of the refused marks changed the goal.
          assert.deepStrictEqual(yield* statesNow, ["open", "failed", "open"]);
        })
      )
  );

  it.live("goal.setCriteria refuses a model judge of the thread's family", () =>
    run(
      Effect.gen(function* () {
        yield* ensureGoalThread;

        const client = yield* makeClient;

        const refused = yield* client["goal.setCriteria"]({
          threadId: GOAL,
          objective: Option.none(),
          criteria: [
            {
              text: "Reads well",
              judge: {
                kind: "model",
                spec: RoleSpec.make("anthropic/claude-other"),
                rubric: "Reads the docs",
              },
            },
          ],
        }).pipe(Effect.flip);

        assert.strictEqual(refused._tag, "InvalidInput");
        assert.include(refused.message, "same family");
        assert.isTrue(Option.isNone(yield* goalNow));
      })
    )
  );
});
