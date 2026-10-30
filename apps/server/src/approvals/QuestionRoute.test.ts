// Question routing's automatic escalations over a real pi-durable brain (the conformance suite's
// `piDurableLayer`) and a migrated in-memory shell store (ADR 0027). A parent spawns, the user says
// Go, the child asks with `ask_parent`, and the parent's model holds the question in a run that
// does not end. Then the question reaches the user, indexed in the parent's `cairn.escalations`
// with why, and an answer in the parent thread settles the child's record once, when:
//
// - the parent's model held it past the window after its placement (a short window here, 15
//   minutes in production);
// - the crash-loop guard parked the parent's run (`TaskParked`, which the `QuestionRoutes` fiber
//   hears; a parked background task of the parent escalates nothing);
// - the user archived the parent thread (a shell event the fiber hears);
// - the parent thread was deleted while no fiber ran, and the start scan finds it.
//
// The ADR 0027 gate scenarios and the answered-once race are conformance scenarios
// (`subagent_question_*`, `subagent_answer_*`); the end of the run that was shown the question is
// theirs too.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ApprovalId,
  ConversationId as ConversationIdOf,
  TaskId,
} from "@cairn/protocol/Ids";
import type { ConversationId } from "@cairn/protocol/Ids";
import { ThreadArchive, ThreadDelete } from "@cairn/protocol/ShellCommands";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  PubSub,
  Ref,
  Stream,
} from "effect";
import type { Scope } from "effect";

import { Brain } from "../brain/Brain.ts";
import { Approvals } from "../brain/CairnDocs.ts";
import { RUN_TASK } from "../brain/CommitFeed.ts";
import { piDurableLayer } from "../brain/conformance/Targets.ts";
import { durable } from "../brain/Durable.ts";
import { FauxModels } from "../brain/FauxModels.ts";
import { HarnessSeam, TaskParked } from "../brain/HarnessSeam.ts";
import type { HarnessEvent } from "../brain/HarnessSeam.ts";
import { FAUX_MODEL } from "../brain/ModelSource.ts";
import { piConversationId } from "../brain/PiIds.ts";
import { NO_SUBAGENT_FAULTS } from "../brain/SubagentFaults.ts";
import { EscalationWhy } from "../brain/SubagentText.ts";
import { EventSink } from "../shell/EventSink.ts";
import {
  createProject,
  createThread,
  ShellTestLayer,
  testCommandId,
  testThreadId,
} from "../shell/ShellTestKit.ts";
import type { ThreadRows } from "../shell/ThreadRows.ts";
import { EscalationsDoc, SubagentsDoc } from "../subagents/SubagentDocs.ts";
import { DEFAULT_TOOL_OPTIONS } from "../subagents/SubagentTools.ts";
import type { SubagentToolOptions } from "../subagents/SubagentTools.ts";
import { escalateStrandedQuestions, QuestionRoutes } from "./QuestionRoute.ts";

const PARENT = testThreadId(1);

/** A window long enough for the other triggers to come first. */
const LONG_WINDOW = DEFAULT_TOOL_OPTIONS;

/** Polls `find` until it finds something, for up to ten seconds. */
const waitFor = <A, E, R>(find: Effect.Effect<Option.Option<A>, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = yield* find;

      if (Option.isSome(found)) {
        return found.value;
      }

      yield* Effect.sleep(Duration.millis(50));
    }

    return yield* Effect.die("waited ten seconds for nothing");
  });

/** The parent's registry, as committed. */
const registryOf = (parent: ConversationId) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.orDie(
      Effect.flatMap(Brain, (brain) => brain.session)
    );

    return yield* durable(
      "test.registry",
      async (context) =>
        await harness.snapshot(SubagentsDoc, piConversationId(parent), context)
    );
  });

/** The parent's live run document. */
const liveOf = (parent: ConversationId) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.orDie(
      Effect.flatMap(Brain, (brain) => brain.session)
    );

    return yield* durable(
      "test.live",
      async (context) =>
        await harness.snapshot(LiveDoc, piConversationId(parent), context)
    );
  });

/** How the fiber is set up in a test. */
type Fiber = "none" | "running";

/** Whether the user archives the parent thread after Go and before the child asks. */
type Before = "ask" | "archive-then-ask";

/** What a test body gets: the parent's conversation, the injected events and the held run. */
interface Asked {
  readonly parent: ConversationId;
  /** Hands the fiber an event as if the brain reported it. */
  readonly inject: (event: HarnessEvent) => Effect.Effect<void>;
  /** Lets the parent's held answer to the question go. */
  readonly release: Effect.Effect<void>;
}

type Services = Scope.Scope | Brain | HarnessSeam | ThreadRows | EventSink;

/**
 * Over a fresh brain and shell: the parent spawns, the user says Go, and the child asks its parent
 * a question, which the parent's model is shown in a run held until `release`. With
 * `archive-then-ask` the user archives the parent between the Go and the child's question, and the
 * test goes on once the question is asked, whether or not the parent's model was shown it.
 */
const withQuestion = <A, E>(
  tuning: SubagentToolOptions,
  fiber: Fiber,
  body: (asked: Asked) => Effect.Effect<A, E, Services>,
  before: Before = "ask"
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-questions-"))),
    (dataDir) =>
      Effect.scoped(
        Effect.gen(function* () {
          const injected = yield* PubSub.unbounded<HarnessEvent>();

          const base = Layer.merge(
            piDurableLayer(dataDir, NO_SUBAGENT_FAULTS, tuning),
            ShellTestLayer
          );

          // The fiber hears the brain's events and the ones a test injects.
          const seamWithInjected = Layer.effect(
            HarnessSeam,
            Effect.gen(function* () {
              const seam = yield* HarnessSeam;

              return HarnessSeam.of({
                ...seam,
                events: Stream.merge(seam.events, Stream.fromPubSub(injected)),
              });
            })
          ).pipe(Layer.provide(base));

          const layer =
            fiber === "running"
              ? Layer.merge(
                  base,
                  QuestionRoutes.pipe(
                    Layer.provide(seamWithInjected),
                    Layer.provide(base)
                  )
                )
              : base;

          const context = yield* Layer.build(layer);
          const seam = Context.get(context, HarnessSeam);
          const brain = Context.get(context, Brain);
          const sink = Context.get(context, EventSink);
          const { faux } = Context.get(context, FauxModels);
          const events = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);
          const gate = Promise.withResolvers<boolean>();
          const childGate = Promise.withResolvers<boolean>();

          if (before === "ask") {
            childGate.resolve(true);
          }

          yield* seam.events.pipe(
            Stream.runForEach((event) =>
              Ref.update(events, (all) => [...all, event])
            ),
            Effect.forkScoped
          );

          const project = createProject(1);

          yield* sink.commitCommand(project.command);
          yield* sink.commitCommand(createThread(project.projectId, 1));

          faux.setResponses([
            fauxAssistantMessage(
              fauxToolCall(
                "subagent_spawn",
                {
                  description: "Count the files",
                  brief: "Count the files in one folder.",
                },
                { id: "call_1" }
              ),
              { stopReason: "toolUse" }
            ),
            fauxAssistantMessage("Waiting for Go."),
            // The child asks once the test lets it.
            async (): Promise<AssistantMessage> => {
              await childGate.promise;

              return fauxAssistantMessage(
                fauxToolCall(
                  "ask_parent",
                  { question: "Which folder?" },
                  { id: "cq" }
                ),
                { stopReason: "toolUse" }
              );
            },
            // The parent's model holds the question until the test lets it go.
            async (): Promise<AssistantMessage> => {
              await gate.promise;

              return fauxAssistantMessage("Still thinking.");
            },
            fauxAssistantMessage("src has 4 files."),
            fauxAssistantMessage("Noted."),
          ]);

          yield* brain.resume;

          const ensured = yield* seam.ensureThread({
            threadId: PARENT,
            projectId: project.projectId,
            model: FAUX_MODEL,
            thinkingLevel: "off",
            cwd: process.cwd(),
            instructions: Option.none(),
            runtimeMode: "full-access",
          });

          yield* seam.submit(PARENT, {
            requestId: "r1",
            content: [{ type: "text", text: "delegate it" }],
            entry: Option.none(),
            whenBusy: "followUp",
          });

          const brief = yield* waitFor(
            Effect.map(Ref.get(events), (all) =>
              Option.firstSomeOf(
                all.map((event) =>
                  Predicate.isTagged(event, "RuntimeRequestUpdated") &&
                  event.kind === "brief" &&
                  event.status === "pending"
                    ? Option.some(event.id)
                    : Option.none()
                )
              )
            )
          );

          yield* seam.respond(PARENT, ApprovalId.make(brief), {
            decision: "accept",
            reason: Option.none(),
            answers: Option.none(),
            launch: Option.none(),
          });

          if (before === "archive-then-ask") {
            yield* sink.commitCommand(
              ThreadArchive.make({
                commandId: testCommandId(41),
                threadId: PARENT,
              })
            );
            childGate.resolve(true);
          }

          // The parent's model was shown the question (asked, and the parent runs again).
          yield* waitFor(
            Effect.gen(function* () {
              const registry = yield* registryOf(ensured.conversationId);
              const live = yield* liveOf(ensured.conversationId);

              const asked = Object.values(registry?.items ?? {}).some(
                (item) => Object.keys(item.questions).length > 0
              );

              return asked &&
                (live?.run !== undefined || before === "archive-then-ask")
                ? Option.some(true)
                : Option.none();
            })
          ).pipe(Effect.provideContext(context));

          const release = Effect.sync(() => {
            gate.resolve(true);
          });

          return yield* body({
            parent: ensured.conversationId,
            inject: (event) =>
              PubSub.publish(injected, event).pipe(Effect.asVoid),
            release,
          }).pipe(Effect.ensuring(release), Effect.provideContext(context));
        })
      ).pipe(Effect.orDie),
    (dataDir) =>
      Effect.sync(() => {
        rmSync(dataDir, { recursive: true, force: true });
      })
  );

/** The parent's escalation index, once it holds an entry. */
const escalationOf = (parent: ConversationId) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.orDie(
      Effect.flatMap(Brain, (brain) => brain.session)
    );

    return yield* waitFor(
      durable("test.escalations", async (context) => {
        const index = await harness.snapshot(
          EscalationsDoc,
          piConversationId(parent),
          context
        );

        return Option.fromUndefinedOr(Object.entries(index?.items ?? {}).at(0));
      })
    );
  });

/**
 * The question reached the user with `why`: answered from the parent thread (its mirror), the
 * child's record settles once, by the user, and the index entry resolves.
 */
const answeredInParent = (parent: ConversationId, why: string) =>
  Effect.gen(function* () {
    const [approvalId, entry] = yield* escalationOf(parent);

    assert.strictEqual(entry.why, why);
    assert.strictEqual(entry.status, "open");

    const { harness } = yield* Effect.orDie(
      Effect.flatMap(Brain, (brain) => brain.session)
    );

    const mirror = yield* durable("test.mirror", async (context) => {
      const approvals = await harness.snapshot(
        Approvals,
        piConversationId(parent),
        context
      );

      return Object.values(approvals?.items ?? {}).find(
        (record) => record.mirrorOf?.approvalId === approvalId
      );
    });

    assert.isDefined(mirror);
    assert.strictEqual(mirror?.status, "pending");

    const seam = yield* HarnessSeam;

    const answer = {
      decision: "accept" as const,
      reason: Option.none(),
      answers: Option.some([{ index: 0, picks: [], custom: "src" }]),
      launch: Option.none(),
    };

    // Answered twice from the parent thread: the second finds it settled and changes nothing.
    yield* seam.respond(PARENT, ApprovalId.make(mirror?.id ?? ""), answer);
    yield* seam.respond(PARENT, ApprovalId.make(mirror?.id ?? ""), {
      ...answer,
      answers: Option.some([{ index: 0, picks: [], custom: "lib" }]),
    });

    const [, resolved] = yield* waitFor(
      Effect.map(escalationOf(parent), (found) =>
        found[1].status === "resolved" ? Option.some(found) : Option.none()
      )
    );

    assert.strictEqual(resolved.why, why);

    const registry = yield* registryOf(parent);

    const marks = Object.values(registry?.items ?? {}).flatMap((item) =>
      Object.values(item.questions)
    );

    assert.deepStrictEqual(
      marks.map((mark) => mark.state),
      ["answered"]
    );

    // The child's own record settled once, by the user, with the first answer.
    const childConversation = Object.values(registry?.items ?? {}).at(
      0
    )?.conversationId;

    const record = yield* durable("test.child-record", async (context) => {
      const approvals = await harness.snapshot(
        Approvals,
        piConversationId(ConversationIdOf.make(childConversation ?? 0)),
        context
      );

      return approvals?.items[approvalId];
    });

    assert.strictEqual(record?.status, "accepted");
    assert.strictEqual(record?.decidedBy?.kind, "user");
    assert.strictEqual(record?.answer?.answers?.[0]?.custom, "src");
  });

/** The parent's newest run task. */
const runTaskOf = (parent: ConversationId) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.orDie(
      Effect.flatMap(Brain, (brain) => brain.session)
    );

    return yield* durable(
      "test.run-task",
      async (context) =>
        await harness.commit(async (tx) => {
          const page = await tx.scanTasks(
            {
              conversationId: piConversationId(parent),
              kind: RUN_TASK,
              order: "descending",
            },
            1
          );

          return page.items.at(0)?.id;
        }, context)
    );
  });

/** Whether nothing escalated within a short wait. */
const nothingEscalated = (parent: ConversationId) =>
  Effect.gen(function* () {
    yield* Effect.sleep(Duration.millis(400));

    const registry = yield* registryOf(parent);

    return Object.values(registry?.items ?? {}).every((item) =>
      Object.values(item.questions).every((mark) => mark.state === "pending")
    );
  });

describe("question routing's automatic escalations", () => {
  it.live(
    "a question the parent's model holds past the window goes to the user",
    () =>
      withQuestion(
        { ...DEFAULT_TOOL_OPTIONS, questionWindowMillis: 300 },
        "none",
        ({ parent }) => answeredInParent(parent, EscalationWhy.parentSlow(300))
      ),
    30_000
  );

  it.live(
    "a question whose parent's run is parked goes to the user, and a parked background task does nothing",
    () =>
      withQuestion(LONG_WINDOW, "running", ({ parent, inject }) =>
        Effect.gen(function* () {
          const run = yield* runTaskOf(parent);

          assert.isDefined(run);

          // A parked task that is not the run's: the parent's model is still free to answer.
          const registry = yield* registryOf(parent);

          const anchor = Object.values(registry?.items ?? {}).at(
            0
          )?.anchorTaskId;

          yield* inject(
            TaskParked.make({
              threadId: PARENT,
              taskId: TaskId.make(anchor ?? 0),
            })
          );

          assert.isTrue(yield* nothingEscalated(parent));

          yield* inject(
            TaskParked.make({ threadId: PARENT, taskId: TaskId.make(run ?? 0) })
          );

          yield* answeredInParent(parent, EscalationWhy.parentParked);
        })
      ),
    30_000
  );

  it.live(
    "a question whose parent thread is archived goes to the user",
    () =>
      withQuestion(LONG_WINDOW, "running", ({ parent }) =>
        Effect.gen(function* () {
          const sink = yield* EventSink;

          yield* Effect.orDie(
            sink.commitCommand(
              ThreadArchive.make({
                commandId: testCommandId(42),
                threadId: PARENT,
              })
            )
          );

          yield* answeredInParent(parent, EscalationWhy.parentArchived);
        })
      ),
    30_000
  );

  it.live(
    "a question asked of a parent the user already archived goes to the user",
    () =>
      withQuestion(
        LONG_WINDOW,
        "running",
        ({ parent }) => answeredInParent(parent, EscalationWhy.parentArchived),
        "archive-then-ask"
      ),
    30_000
  );

  it.live(
    "the start scan escalates a question whose parent was deleted while no fiber ran",
    () =>
      withQuestion(LONG_WINDOW, "none", ({ parent }) =>
        Effect.gen(function* () {
          const sink = yield* EventSink;

          yield* Effect.orDie(
            sink.commitCommand(
              ThreadDelete.make({
                commandId: testCommandId(43),
                threadId: PARENT,
              })
            )
          );

          assert.isTrue(yield* nothingEscalated(parent));
          assert.strictEqual(yield* Effect.orDie(escalateStrandedQuestions), 1);
          assert.strictEqual(yield* Effect.orDie(escalateStrandedQuestions), 0);

          yield* answeredInParent(parent, EscalationWhy.parentDeleted);
        })
      ),
    30_000
  );
});
