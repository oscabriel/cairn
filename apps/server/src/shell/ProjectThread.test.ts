// The project thread and the scratch clear in the shell store (the user's decisions of 2026-10-29):
// a folder project's first top-level thread is marked as its project thread; a refresh archives the
// marked one and moves the mark in the same commit, idempotently by command id, and refuses when
// the thread it names is no longer the marked one; children are created as before and leave the
// mark alone; archiving or deleting the marked thread clears the mark, and unarchiving a top-level
// thread marks it again or is refused while another is marked; clearing a scratch thread
// deletes it and its subagents' rows and is refused anywhere else.

import { ProjectId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import {
  ThreadArchive,
  ThreadClear,
  ThreadDelete,
  ThreadRename,
  ThreadUnarchive,
} from "@cairn/protocol/ShellCommands";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Predicate, Stream } from "effect";

import { Projects } from "../projects/Projects.ts";
import { EventSink } from "./EventSink.ts";
import { EventStore } from "./EventStore.ts";
import { ProjectRegister } from "./ShellCommands.ts";
import type { ServerShellCommand } from "./ShellCommands.ts";
import {
  createProject,
  createThread,
  ShellTestLayer,
  testCommandId,
  testThreadId,
} from "./ShellTestKit.ts";
import { ThreadRows } from "./ThreadRows.ts";

/** Thread `n` created as the project thread of `projectId`, replacing `replaces` when given. */
const projectThread = (
  projectId: ProjectId,
  n: number,
  replaces: Option.Option<ThreadId> = Option.none()
) => ({ ...createThread(projectId, n), projectThread: { replaces } });

/** Subagent `n` under `parent`, whose root is `root`. */
const subagent = (
  projectId: ProjectId,
  n: number,
  parent: ThreadId,
  root: ThreadId
) => ({
  ...createThread(projectId, n),
  lineage: Option.some({
    parentThreadId: parent,
    relationshipToParent: "subagent" as const,
    rootThreadId: root,
  }),
});

const unarchive = (n: number, threadId: ThreadId) =>
  ThreadUnarchive.make({ commandId: testCommandId(n), threadId });

const commit = (command: ServerShellCommand) =>
  EventSink.use((sink) => sink.commitCommand(command));

const refusal = (command: ServerShellCommand) =>
  commit(command).pipe(Effect.flip);

/** The events committed after `before`, in order. */
const eventsSince = Effect.fn("test.eventsSince")(function* (before: number) {
  const store = yield* EventStore;
  const latest = yield* store.latestSequence;

  return yield* store
    .readRange({ afterSequence: before, throughSequence: latest })
    .pipe(Stream.runCollect);
});

const markOf = Effect.fn("test.markOf")(function* (projectId: ProjectId) {
  const project = yield* (yield* Projects).get(projectId);

  return Option.flatMap(project, (row) => row.shell.projectThreadId);
});

const rowOf = Effect.fn("test.rowOf")(function* (threadId: ThreadId) {
  const row = yield* (yield* ThreadRows).get(threadId);

  assert.isTrue(Option.isSome(row), `thread ${threadId} has a row`);

  return Option.getOrThrow(row);
});

/** The project's live top-level threads: what the sidebar could show as project threads. */
const liveTopLevel = Effect.fn("test.liveTopLevel")(function* (
  projectId: ProjectId
) {
  const rows = yield* (yield* ThreadRows).listByProject(projectId);

  return rows
    .filter(
      (row) =>
        Option.isNone(row.shell.archivedAt) && Option.isNone(row.shell.lineage)
    )
    .map((row) => row.shell.id);
});

const withProject = <A, E, R>(
  body: (projectId: ProjectId) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const { projectId, command } = createProject(1);

    yield* commit(command);

    return yield* body(projectId);
  }).pipe(Effect.provide(ShellTestLayer));

describe("the project thread", () => {
  it.effect("the first top-level thread of a folder project is marked", () =>
    withProject((projectId) =>
      Effect.gen(function* () {
        const before = yield* (yield* EventStore).latestSequence;

        yield* commit(projectThread(projectId, 1));

        assert.deepStrictEqual(
          yield* markOf(projectId),
          Option.some(testThreadId(1))
        );

        const events = yield* eventsSince(before);

        assert.deepStrictEqual(
          events.map((event) => [event.type, event.aggregateId]),
          [
            ["thread.created", testThreadId(1)],
            ["project.updated", projectId],
          ]
        );
      })
    )
  );

  it.effect(
    "a refresh archives the old project thread and moves the mark in one commit",
    () =>
      withProject((projectId) =>
        Effect.gen(function* () {
          yield* commit(projectThread(projectId, 1));

          const before = yield* (yield* EventStore).latestSequence;

          const result = yield* commit(
            projectThread(projectId, 2, Option.some(testThreadId(1)))
          );

          const events = yield* eventsSince(before);

          assert.deepStrictEqual(
            events.map((event) => [event.type, event.aggregateId]),
            [
              ["thread.created", testThreadId(2)],
              ["thread.archived", testThreadId(1)],
              ["project.updated", projectId],
            ]
          );
          // One command, one commit: every event carries its command id.
          assert.deepStrictEqual(
            new Set(events.map((event) => event.commandId)),
            new Set([createThread(projectId, 2).commandId])
          );
          assert.strictEqual(result.sequence, events.at(-1)?.sequence);
          assert.deepStrictEqual(
            yield* markOf(projectId),
            Option.some(testThreadId(2))
          );
          assert.isTrue(
            Option.isSome((yield* rowOf(testThreadId(1))).shell.archivedAt)
          );
          assert.deepStrictEqual(yield* liveTopLevel(projectId), [
            testThreadId(2),
          ]);
        })
      )
  );

  it.effect(
    "a refresh with no thread named replaces the current one; a resend changes nothing",
    () =>
      withProject((projectId) =>
        Effect.gen(function* () {
          yield* commit(projectThread(projectId, 1));

          const first = yield* commit(projectThread(projectId, 2));
          const again = yield* commit(projectThread(projectId, 2));

          assert.strictEqual(again.sequence, first.sequence);
          assert.strictEqual(
            yield* (yield* EventStore).latestSequence,
            first.sequence
          );
          assert.deepStrictEqual(
            yield* markOf(projectId),
            Option.some(testThreadId(2))
          );
          assert.deepStrictEqual(yield* liveTopLevel(projectId), [
            testThreadId(2),
          ]);
        })
      )
  );

  it.effect(
    "a refresh naming a thread that is no longer the project thread is refused and changes nothing",
    () =>
      withProject((projectId) =>
        Effect.gen(function* () {
          yield* commit(projectThread(projectId, 1));
          yield* commit(
            projectThread(projectId, 2, Option.some(testThreadId(1)))
          );

          const before = yield* (yield* EventStore).latestSequence;

          const refused = yield* refusal(
            projectThread(projectId, 3, Option.some(testThreadId(1)))
          );

          assert.strictEqual(refused._tag, "ShellCommandInvalid");
          assert.deepStrictEqual(
            Predicate.isTagged(refused, "ShellCommandInvalid")
              ? refused.field
              : Option.none(),
            Option.some("replaces")
          );
          assert.strictEqual(yield* (yield* EventStore).latestSequence, before);
          assert.isTrue(
            Option.isNone(yield* (yield* ThreadRows).get(testThreadId(3)))
          );
          assert.deepStrictEqual(
            yield* markOf(projectId),
            Option.some(testThreadId(2))
          );
        })
      )
  );

  it.effect(
    "subagents are created as before, leave the mark alone and are managed by the project thread",
    () =>
      withProject((projectId) =>
        Effect.gen(function* () {
          yield* commit(projectThread(projectId, 1));
          yield* commit(
            subagent(projectId, 2, testThreadId(1), testThreadId(1))
          );
          yield* commit(
            subagent(projectId, 3, testThreadId(2), testThreadId(1))
          );

          assert.deepStrictEqual(
            yield* markOf(projectId),
            Option.some(testThreadId(1))
          );

          const rows = yield* (yield* ThreadRows).listByProject(projectId);

          assert.deepStrictEqual(
            rows
              .filter((row) =>
                Option.exists(
                  row.shell.lineage,
                  (lineage) => lineage.rootThreadId === testThreadId(1)
                )
              )
              .map((row) => row.shell.id),
            [testThreadId(2), testThreadId(3)]
          );

          // A managed thread takes the user's own commands like any other.
          yield* commit(
            ThreadRename.make({
              commandId: testCommandId(10),
              threadId: testThreadId(2),
              title: "Renamed child",
            })
          );
          assert.strictEqual(
            (yield* rowOf(testThreadId(2))).shell.title,
            "Renamed child"
          );
        })
      )
  );

  it.effect("a subagent cannot take the mark", () =>
    withProject((projectId) =>
      Effect.gen(function* () {
        yield* commit(projectThread(projectId, 1));

        const refused = yield* refusal({
          ...subagent(projectId, 2, testThreadId(1), testThreadId(1)),
          projectThread: { replaces: Option.none() },
        });

        assert.strictEqual(refused._tag, "ShellCommandInvalid");
        assert.deepStrictEqual(
          yield* markOf(projectId),
          Option.some(testThreadId(1))
        );
      })
    )
  );

  it.effect(
    "archiving or deleting the project thread clears the mark; the next launch marks again without archiving",
    () =>
      withProject((projectId) =>
        Effect.gen(function* () {
          yield* commit(projectThread(projectId, 1));
          yield* commit(createThread(projectId, 9));
          yield* commit(
            ThreadArchive.make({
              commandId: testCommandId(20),
              threadId: testThreadId(9),
            })
          );
          assert.deepStrictEqual(
            yield* markOf(projectId),
            Option.some(testThreadId(1))
          );

          yield* commit(
            ThreadArchive.make({
              commandId: testCommandId(21),
              threadId: testThreadId(1),
            })
          );
          assert.deepStrictEqual(yield* markOf(projectId), Option.none());

          yield* commit(projectThread(projectId, 2));
          assert.deepStrictEqual(
            yield* markOf(projectId),
            Option.some(testThreadId(2))
          );

          yield* commit(
            ThreadDelete.make({
              commandId: testCommandId(22),
              threadId: testThreadId(2),
            })
          );
          assert.deepStrictEqual(yield* markOf(projectId), Option.none());

          // A refresh naming a thread that is gone just marks the new one.
          yield* commit(
            projectThread(projectId, 3, Option.some(testThreadId(2)))
          );
          assert.deepStrictEqual(
            yield* markOf(projectId),
            Option.some(testThreadId(3))
          );
          assert.deepStrictEqual(yield* liveTopLevel(projectId), [
            testThreadId(3),
          ]);
        })
      )
  );

  it.effect(
    "unarchiving a top-level thread marks it again, and is refused while another is marked",
    () =>
      withProject((projectId) =>
        Effect.gen(function* () {
          yield* commit(projectThread(projectId, 1));
          yield* commit(
            ThreadArchive.make({
              commandId: testCommandId(30),
              threadId: testThreadId(1),
            })
          );
          assert.deepStrictEqual(yield* markOf(projectId), Option.none());

          // With no project thread, the unarchived one is the project thread again.
          const before = yield* (yield* EventStore).latestSequence;

          yield* commit(unarchive(31, testThreadId(1)));
          assert.deepStrictEqual(
            yield* markOf(projectId),
            Option.some(testThreadId(1))
          );
          assert.deepStrictEqual(
            (yield* eventsSince(before)).map((event) => [
              event.type,
              event.aggregateId,
            ]),
            [
              ["thread.unarchived", testThreadId(1)],
              ["project.updated", projectId],
            ]
          );

          // So the next launch refreshes it instead of making a second one.
          yield* commit(projectThread(projectId, 2));
          assert.deepStrictEqual(yield* liveTopLevel(projectId), [
            testThreadId(2),
          ]);

          // A thread a refresh replaced stays archived while its successor is the project thread.
          const refused = yield* refusal(unarchive(32, testThreadId(1)));

          assert.strictEqual(refused._tag, "ShellCommandInvalid");
          assert.deepStrictEqual(
            Predicate.isTagged(refused, "ShellCommandInvalid")
              ? refused.field
              : Option.none(),
            Option.some("threadId")
          );
          assert.deepStrictEqual(
            yield* markOf(projectId),
            Option.some(testThreadId(2))
          );
          assert.deepStrictEqual(yield* liveTopLevel(projectId), [
            testThreadId(2),
          ]);
        })
      )
  );
});

/** Registers a scratch project; its id is `prj_scratch_test`. */
const withScratch = <A, E, R>(
  body: (scratch: ProjectId, folder: ProjectId) => Effect.Effect<A, E, R>
) =>
  withProject((folder) =>
    Effect.gen(function* () {
      const register = ProjectRegister.make({
        commandId: testCommandId(30),
        projectId: ProjectId.make("prj_scratch_test"),
        kind: "scratch",
        title: "No project",
        workspaceRoot: "/srv/data/scratch",
        repository: Option.none(),
      });

      yield* commit(register);

      return yield* body(register.projectId, folder);
    })
  );

describe("clearing a scratch thread", () => {
  it.effect("the scratch project has no project thread", () =>
    withScratch((scratch) =>
      Effect.gen(function* () {
        const refused = yield* refusal(projectThread(scratch, 1));

        assert.strictEqual(refused._tag, "ShellCommandInvalid");
        assert.deepStrictEqual(yield* markOf(scratch), Option.none());
      })
    )
  );

  it.effect(
    "deletes the thread and its subagents' rows, and only theirs; a resend changes nothing",
    () =>
      withScratch((scratch) =>
        Effect.gen(function* () {
          yield* commit(createThread(scratch, 1));
          yield* commit(subagent(scratch, 2, testThreadId(1), testThreadId(1)));
          yield* commit(createThread(scratch, 3));
          yield* commit(subagent(scratch, 4, testThreadId(3), testThreadId(3)));

          const clear = ThreadClear.make({
            commandId: testCommandId(40),
            threadId: testThreadId(1),
          });

          const first = yield* commit(clear);
          const again = yield* commit(clear);

          assert.strictEqual(again.sequence, first.sequence);

          const rows = yield* (yield* ThreadRows).listByProject(scratch);

          assert.deepStrictEqual(
            rows.map((row) => row.shell.id),
            [testThreadId(3), testThreadId(4)]
          );
          assert.isTrue(
            Option.isSome((yield* rowOf(testThreadId(1))).deletedAt)
          );
          assert.isTrue(
            Option.isSome((yield* rowOf(testThreadId(2))).deletedAt)
          );
        })
      )
  );

  it.effect("is refused for a folder project's thread and for a subagent", () =>
    withScratch((scratch, folder) =>
      Effect.gen(function* () {
        yield* commit(projectThread(folder, 1));
        yield* commit(createThread(scratch, 2));
        yield* commit(subagent(scratch, 3, testThreadId(2), testThreadId(2)));

        for (const [n, threadId] of [
          [50, testThreadId(1)],
          [51, testThreadId(3)],
        ] as const) {
          const refused = yield* refusal(
            ThreadClear.make({ commandId: testCommandId(n), threadId })
          );

          assert.strictEqual(refused._tag, "ShellCommandInvalid");
          assert.isTrue(Option.isNone((yield* rowOf(threadId)).deletedAt));
        }
      })
    )
  );
});
