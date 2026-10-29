// The subagents extension's host-side pieces over a real pi-durable brain (the conformance suite's,
// `piDurableLayer`) and a migrated in-memory shell store: a parent spawns, the user says Go, and
// the child answers. Then:
//
// - the `SubagentRows` fiber makes the child's shell row as its creating commit lands, with its
//   lineage, the parent's project, the brief's title and the dispatched model;
// - without the fiber, `repairSubagentRows` makes the same row at boot, and a second run makes no
//   other;
// - a user's input to the child whose reporter submits first (the brain dying between the steer's
//   commit and the seam's own submit) still reaches the child whole: its image and its entry, and
//   the client's resend lands on the same submission.
//
// Kept under `brain/`, where pi-durable may be imported in a test (S42).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConversationId, ThreadId } from "@cairn/protocol/Ids";
import { ApprovalId } from "@cairn/protocol/Ids";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Stream,
} from "effect";
import type { Scope } from "effect";

import { EventSink } from "../shell/EventSink.ts";
import {
  createProject,
  createThread,
  ShellTestLayer,
  testThreadId,
} from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { repairSubagentRows, SubagentRows } from "../subagents/SubagentRows.ts";
import { steerReporter } from "../subagents/Subagents.ts";
import { Brain } from "./Brain.ts";
import { piDurableLayer } from "./conformance/Targets.ts";
import { durable } from "./Durable.ts";
import { FauxModels } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import type { HarnessEvent } from "./HarnessSeam.ts";
import { FAUX_MODEL } from "./ModelSource.ts";
import { piConversationId } from "./PiIds.ts";
import { NO_SUBAGENT_FAULTS } from "./SubagentFaults.ts";

/** A 1x1 PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const PARENT = testThreadId(1);

/** The entry a user's attachment input is placed as. */
const STEER_ENTRY = { kind: "cairn.test-attachment", data: { by: "user" } };

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

/** The first event `pick` accepts, waited for. */
const eventWhere = <A>(
  events: Ref.Ref<ReadonlyArray<HarnessEvent>>,
  pick: (event: HarnessEvent) => Option.Option<A>
) =>
  waitFor(
    Effect.map(Ref.get(events), (all) => Option.firstSomeOf(all.map(pick)))
  );

/** What a started child is known by. */
interface StartedChild {
  readonly threadId: ThreadId;
  readonly conversationId: ConversationId;
}

/**
 * Over a fresh brain and shell: the parent's row, a spawn the user approves, and the child's
 * first answer settled. `withRows` adds the `SubagentRows` fiber.
 */
const withChild = <A, E>(
  withRows: boolean,
  body: (
    child: StartedChild
  ) => Effect.Effect<
    A,
    E,
    Scope.Scope | Brain | HarnessSeam | ThreadRows | EventSink
  >
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-subagents-"))),
    (dataDir) =>
      Effect.scoped(
        Effect.gen(function* () {
          const brainLayer = piDurableLayer(dataDir, NO_SUBAGENT_FAULTS);
          const base = Layer.merge(brainLayer, ShellTestLayer);

          const layer = withRows
            ? Layer.merge(base, SubagentRows.pipe(Layer.provide(base)))
            : base;

          const context = yield* Layer.build(layer);
          const seam = Context.get(context, HarnessSeam);
          const brain = Context.get(context, Brain);
          const sink = Context.get(context, EventSink);
          const { faux } = Context.get(context, FauxModels);
          const events = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);

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
                  brief: "Count the files in src.",
                },
                { id: "call_1" }
              ),
              { stopReason: "toolUse" }
            ),
            fauxAssistantMessage("Waiting for Go."),
            fauxAssistantMessage("src has 4 files."),
            fauxAssistantMessage("Noted."),
            fauxAssistantMessage("The image shows one pixel."),
          ]);

          yield* brain.resume;
          yield* seam.ensureThread({
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

          const brief = yield* eventWhere(events, (event) =>
            Predicate.isTagged(event, "RuntimeRequestUpdated") &&
            event.kind === "brief" &&
            event.status === "pending"
              ? Option.some(event.id)
              : Option.none()
          );

          yield* seam.respond(PARENT, ApprovalId.make(brief), {
            decision: "accept",
            reason: Option.none(),
            answers: Option.none(),
          });

          const child = yield* eventWhere(events, (event) =>
            Predicate.isTagged(event, "ThreadEnsured") &&
            Option.isSome(event.parent)
              ? Option.some({
                  threadId: event.threadId,
                  conversationId: event.conversationId,
                })
              : Option.none()
          );

          yield* eventWhere(events, (event) =>
            Predicate.isTagged(event, "SubagentUpdated") &&
            event.child === child.threadId &&
            event.status === "settled"
              ? Option.some(true)
              : Option.none()
          );

          return yield* body(child).pipe(Effect.provideContext(context));
        })
      ).pipe(Effect.orDie),
    (dataDir) =>
      Effect.sync(() => {
        rmSync(dataDir, { recursive: true, force: true });
      })
  );

/** The child's row, once it exists. */
const rowOf = (threadId: ThreadId) =>
  Effect.flatMap(ThreadRows, (rows) => rows.get(threadId));

/** Asserts the child's row is the one its parent and dispatch describe. */
const assertChildRow = (child: StartedChild) =>
  Effect.gen(function* () {
    const { shell } = yield* waitFor(rowOf(child.threadId));

    assert.deepStrictEqual(
      shell.lineage,
      Option.some({
        parentThreadId: PARENT,
        relationshipToParent: "subagent" as const,
        rootThreadId: PARENT,
      })
    );
    assert.strictEqual(shell.title, "Count the files");
    assert.strictEqual(shell.provider, FAUX_MODEL.provider);
    assert.strictEqual(shell.modelId, FAUX_MODEL.modelId);
  });

/** The child's entries, oldest first. */
const entriesOf = (conversationId: ConversationId) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.orDie(
      Effect.flatMap(Brain, (brain) => brain.session)
    );

    return yield* durable(
      "test.entries",
      async (context) =>
        await harness.commit(
          async (tx) =>
            await tx.scanEntries(
              {
                conversationId: piConversationId(conversationId),
                order: "ascending",
              },
              100
            ),
          context
        )
    ).pipe(Effect.map((page): ReadonlyArray<EntryRecord> => page.items));
  });

describe("subagents over a pi-durable brain", () => {
  it.live(
    "the SubagentRows fiber makes the child's row as it is created",
    () => withChild(true, assertChildRow),
    30_000
  );

  it.live(
    "the boot repair makes a missing child row, once",
    () =>
      withChild(false, (child) =>
        Effect.gen(function* () {
          assert.isTrue(Option.isNone(yield* rowOf(child.threadId)));

          yield* repairSubagentRows;
          yield* assertChildRow(child);
          yield* repairSubagentRows;

          const rows = yield* ThreadRows;

          assert.lengthOf(
            (yield* rows.listLive).filter(
              (row) => row.shell.id === child.threadId
            ),
            1
          );
        })
      ),
    30_000
  );

  it.live(
    "a steer whose reporter submits first reaches the child with its image and entry",
    () =>
      withChild(false, (child) =>
        Effect.gen(function* () {
          const brain = yield* Brain;
          const { harness } = yield* Effect.orDie(brain.session);

          const content = [
            { type: "text" as const, text: "What does this show?" },
            { type: "image" as const, data: PNG_BASE64, mimeType: "image/png" },
          ];

          // The steer's commit, and no seam submit after it: the brain died in between.
          yield* steerReporter(
            harness,
            piConversationId(child.conversationId),
            {
              type: "input",
              requestId: "u1",
              content,
              whenBusy: "followUp",
              entry: STEER_ENTRY,
            }
          );

          const placed = yield* waitFor(
            Effect.map(entriesOf(child.conversationId), (entries) =>
              Option.fromUndefinedOr(
                entries.find((entry) => entry.kind === STEER_ENTRY.kind)
              )
            )
          );

          assert.deepStrictEqual(placed.data, STEER_ENTRY.data);

          const [message] = placed.model ?? [];

          assert.isTrue(
            message?.role === "user" &&
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === "image")
          );

          // The client's outbox resends after the restart: the same submission, nothing new.
          const seam = yield* HarnessSeam;

          yield* seam.submit(child.threadId, {
            requestId: "u1",
            content,
            entry: Option.some(STEER_ENTRY),
            whenBusy: "followUp",
          });

          const entries = yield* entriesOf(child.conversationId);

          assert.lengthOf(
            entries.filter((entry) => entry.kind === STEER_ENTRY.kind),
            1
          );
        })
      ),
    30_000
  );
});
