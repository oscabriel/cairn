import { tallyOfRegistry } from "@cairn/client-logic/SubagentTally";
import {
  ProjectCreate,
  ProjectDelete,
  ThreadArchive,
  ThreadMarkUnread,
  ThreadPin,
  ThreadSettle,
  ThreadSnooze,
  ThreadUnarchive,
  ThreadUnsettle,
  ThreadVisit,
} from "@cairn/protocol/ShellCommands";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Option } from "effect";
import type { Scope, Layer } from "effect";
import { TestClock } from "effect/testing";

import { EventSink } from "./EventSink.ts";
import { EventStore, SHELL_EVENT_RETENTION } from "./EventStore.ts";
import {
  emptyActivityPatch,
  ThreadActivityUpdate,
  ThreadAutoSettle,
  ThreadCreate,
  ThreadMessageSent,
} from "./ShellCommands.ts";
import type { ServerShellCommand } from "./ShellCommands.ts";
import { ShellSnapshot } from "./ShellSnapshot.ts";
import {
  createProject,
  createThread,
  ShellTestLayer,
  testCommandId,
  testThreadId,
} from "./ShellTestKit.ts";
import { ThreadRows } from "./ThreadRows.ts";

const run = <A, E>(
  body: Effect.Effect<A, E, Layer.Success<typeof ShellTestLayer> | Scope.Scope>
) => body.pipe(Effect.scoped, Effect.provide(ShellTestLayer));

let commandCount = 0;

const nextCommandId = () => {
  commandCount += 1;

  return testCommandId(commandCount);
};

const commit = Effect.fnUntraced(function* (command: ServerShellCommand) {
  const sink = yield* EventSink;

  return yield* sink.commitCommand(command);
});

const refusal = (command: ServerShellCommand) =>
  Effect.flip(commit(command)).pipe(Effect.map((error) => error._tag));

const thread = Effect.fnUntraced(function* (n: number) {
  const row = yield* (yield* ThreadRows).get(testThreadId(n));

  assert.isTrue(Option.isSome(row));

  return Option.getOrThrow(row).shell;
});

/** One project with thread 1 in it. */
const seed = Effect.gen(function* () {
  const { projectId, command } = createProject(1);

  yield* commit(command);
  yield* commit(createThread(projectId, 1));

  return projectId;
});

const threadId = testThreadId(1);

describe("project commands", () => {
  it.effect(
    "keeps one live project per folder and names it after the folder",
    () =>
      run(
        Effect.gen(function* () {
          yield* commit(
            ProjectCreate.make({
              commandId: nextCommandId(),
              workspaceRoot: "/srv/projects/cairn/",
              title: Option.none(),
            })
          );

          const snapshot = yield* (yield* ShellSnapshot).load;

          assert.deepStrictEqual(
            snapshot.projects.map((project) => [
              project.title,
              project.workspaceRoot,
            ]),
            [["cairn", "/srv/projects/cairn"]]
          );
          assert.strictEqual(
            yield* refusal(
              ProjectCreate.make({
                commandId: nextCommandId(),
                workspaceRoot: "/srv/projects/cairn",
                title: Option.some("Again"),
              })
            ),
            "ProjectWorkspaceConflictError"
          );
          assert.strictEqual(
            yield* refusal(
              ProjectCreate.make({
                commandId: nextCommandId(),
                workspaceRoot: "projects/../etc",
                title: Option.none(),
              })
            ),
            "ShellCommandInvalid"
          );
        })
      )
  );

  it.effect("deletes a project with its threads, in one commit", () =>
    run(
      Effect.gen(function* () {
        const projectId = yield* seed;
        yield* commit(createThread(projectId, 2));

        const result = yield* commit(
          ProjectDelete.make({ commandId: nextCommandId(), projectId })
        );

        const snapshot = yield* (yield* ShellSnapshot).load;

        assert.strictEqual(result.sequence, 6);
        assert.deepStrictEqual(snapshot.projects, []);
        assert.deepStrictEqual(snapshot.threads, []);
        assert.strictEqual(
          yield* refusal(createThread(projectId, 3)),
          "ShellTargetNotFound"
        );
      })
    )
  );
});

describe("thread inbox commands", () => {
  it.effect(
    "refuses to settle a running thread, and settling clears pin and snooze",
    () =>
      run(
        Effect.gen(function* () {
          yield* seed;
          yield* commit(
            ThreadActivityUpdate.make({
              commandId: nextCommandId(),
              threadId,
              patch: {
                ...emptyActivityPatch,
                activity: Option.some("running"),
              },
            })
          );

          assert.strictEqual(
            yield* refusal(
              ThreadSettle.make({ commandId: nextCommandId(), threadId })
            ),
            "ShellCommandConflict"
          );

          yield* commit(
            ThreadActivityUpdate.make({
              commandId: nextCommandId(),
              threadId,
              patch: { ...emptyActivityPatch, activity: Option.some("idle") },
            })
          );
          yield* commit(
            ThreadPin.make({ commandId: nextCommandId(), threadId })
          );
          yield* commit(
            ThreadSnooze.make({
              commandId: nextCommandId(),
              threadId,
              until: DateTime.makeUnsafe(60_000),
            })
          );
          yield* commit(
            ThreadSettle.make({ commandId: nextCommandId(), threadId })
          );

          const settled = yield* thread(1);

          assert.deepStrictEqual(
            settled.settledOverride,
            Option.some("settled")
          );
          assert.isTrue(Option.isNone(settled.pinnedAt));
          assert.isTrue(Option.isNone(settled.snoozedUntil));

          yield* commit(
            ThreadPin.make({ commandId: nextCommandId(), threadId })
          );

          const pinned = yield* thread(1);

          assert.deepStrictEqual(pinned.settledOverride, Option.some("active"));
          assert.isTrue(Option.isSome(pinned.pinnedAt));
        })
      )
  );

  it.effect(
    "moves the visit time only forward, without touching updatedAt",
    () =>
      run(
        Effect.gen(function* () {
          yield* seed;
          const created = yield* thread(1);

          yield* TestClock.adjust(Duration.seconds(10));
          yield* commit(
            ThreadVisit.make({
              commandId: nextCommandId(),
              threadId,
              at: DateTime.makeUnsafe(5000),
            })
          );
          yield* commit(
            ThreadVisit.make({
              commandId: nextCommandId(),
              threadId,
              at: DateTime.makeUnsafe(1000),
            })
          );

          const visited = yield* thread(1);

          assert.deepStrictEqual(
            visited.lastVisitedAt,
            Option.some(DateTime.makeUnsafe(5000))
          );
          assert.deepStrictEqual(visited.updatedAt, created.updatedAt);
        })
      )
  );

  it.effect(
    "marks a finished run unread, and refuses with no finished run",
    () =>
      run(
        Effect.gen(function* () {
          yield* seed;

          assert.strictEqual(
            yield* refusal(
              ThreadMarkUnread.make({ commandId: nextCommandId(), threadId })
            ),
            "ShellCommandConflict"
          );

          yield* commit(
            ThreadActivityUpdate.make({
              commandId: nextCommandId(),
              threadId,
              patch: {
                ...emptyActivityPatch,
                latestRunCompletedAt: Option.some(
                  Option.some(DateTime.makeUnsafe(9000))
                ),
              },
            })
          );
          yield* commit(
            ThreadMarkUnread.make({ commandId: nextCommandId(), threadId })
          );

          assert.deepStrictEqual(
            (yield* thread(1)).lastVisitedAt,
            Option.some(DateTime.makeUnsafe(8999))
          );
        })
      )
  );

  it.effect(
    "a sent message clears the manual settle state and ends a snooze, so auto-settle applies again",
    () =>
      run(
        Effect.gen(function* () {
          yield* seed;

          const sent = () =>
            ThreadMessageSent.make({ commandId: nextCommandId(), threadId });

          // Nothing to clear: refused, so a send writes no event of its own.
          assert.strictEqual(yield* refusal(sent()), "ShellCommandConflict");

          yield* commit(
            ThreadSettle.make({ commandId: nextCommandId(), threadId })
          );
          yield* TestClock.adjust(Duration.seconds(1));
          yield* commit(sent());

          const cleared = yield* thread(1);

          assert.isTrue(Option.isNone(cleared.settledOverride));
          assert.isTrue(Option.isNone(cleared.settledAt));
          assert.deepStrictEqual(
            cleared.unsettledAt,
            Option.some(cleared.updatedAt)
          );

          yield* commit(
            ThreadAutoSettle.make({
              commandId: nextCommandId(),
              threadId,
              snapshotAt: cleared.updatedAt,
              settledAt: cleared.updatedAt,
            })
          );
          assert.deepStrictEqual(
            (yield* thread(1)).settledOverride,
            Option.some("settled")
          );

          yield* commit(
            ThreadUnsettle.make({ commandId: nextCommandId(), threadId })
          );
          const { unsettledAt } = yield* thread(1);

          yield* TestClock.adjust(Duration.seconds(1));
          yield* commit(
            ThreadSnooze.make({
              commandId: nextCommandId(),
              threadId,
              until: DateTime.makeUnsafe(60_000),
            })
          );
          yield* commit(sent());

          const woken = yield* thread(1);

          assert.isTrue(Option.isNone(woken.settledOverride));
          assert.deepStrictEqual(woken.unsettledAt, unsettledAt);
          assert.isTrue(Option.isNone(woken.snoozedUntil));
          assert.isTrue(Option.isNone(woken.snoozedAt));
        })
      )
  );

  it.effect("takes an archived thread out of the shell and back", () =>
    run(
      Effect.gen(function* () {
        yield* seed;
        const snapshots = yield* ShellSnapshot;

        yield* commit(
          ThreadArchive.make({ commandId: nextCommandId(), threadId })
        );
        assert.deepStrictEqual((yield* snapshots.load).threads, []);
        assert.strictEqual(
          yield* refusal(
            ThreadSettle.make({ commandId: nextCommandId(), threadId })
          ),
          "ShellCommandConflict"
        );

        yield* commit(
          ThreadUnarchive.make({ commandId: nextCommandId(), threadId })
        );
        assert.strictEqual((yield* snapshots.load).threads.length, 1);
      })
    )
  );

  it.effect(
    "refuses an automatic settle when the row changed after the sweep read it",
    () =>
      run(
        Effect.gen(function* () {
          yield* seed;
          const read = yield* thread(1);

          yield* TestClock.adjust(Duration.seconds(1));
          yield* commit(
            ThreadActivityUpdate.make({
              commandId: nextCommandId(),
              threadId,
              patch: { ...emptyActivityPatch, queueLength: Option.some(1) },
            })
          );

          assert.strictEqual(
            yield* refusal(
              ThreadAutoSettle.make({
                commandId: nextCommandId(),
                threadId,
                snapshotAt: read.updatedAt,
                settledAt: read.createdAt,
              })
            ),
            "ShellCommandConflict"
          );
        })
      )
  );
});

/** Sets thread 1's tally of working and asking children. */
const tally = (working: number, asking: number) =>
  ThreadActivityUpdate.make({
    commandId: nextCommandId(),
    threadId,
    patch: {
      ...emptyActivityPatch,
      subagents: Option.some({ working, asking, settled: 0, failed: 0 }),
    },
  });

describe("subagents on the shelf", () => {
  /** Thread 2, a subagent of thread 1. */
  const seedChild = Effect.gen(function* () {
    const projectId = yield* seed;

    yield* commit(
      ThreadCreate.make({
        ...createThread(projectId, 2),
        lineage: Option.some({
          parentThreadId: threadId,
          relationshipToParent: "subagent",
          rootThreadId: threadId,
        }),
      })
    );
  });

  it.effect(
    "refuses to settle a parent, by hand or by the sweep, while a child works or asks",
    () =>
      run(
        Effect.gen(function* () {
          yield* seedChild;

          for (const [working, asking] of [
            [1, 0],
            [0, 1],
          ] as const) {
            yield* commit(tally(working, asking));

            const read = yield* thread(1);

            assert.deepStrictEqual(
              [
                yield* refusal(
                  ThreadSettle.make({ commandId: nextCommandId(), threadId })
                ),
                yield* refusal(
                  ThreadAutoSettle.make({
                    commandId: nextCommandId(),
                    threadId,
                    snapshotAt: read.updatedAt,
                    settledAt: read.createdAt,
                  })
                ),
              ],
              ["ShellCommandConflict", "ShellCommandConflict"]
            );
          }

          yield* commit(tally(0, 0));
          yield* commit(
            ThreadSettle.make({ commandId: nextCommandId(), threadId })
          );

          assert.deepStrictEqual(
            (yield* thread(1)).settledOverride,
            Option.some("settled")
          );
        })
      )
  );

  it.effect(
    "refuses to settle a parent while a settled child's result is still on the way",
    () =>
      run(
        Effect.gen(function* () {
          yield* seedChild;

          /** The parent's tally as its registry reads, one child settled and `delivered` of 1. */
          const fromRegistry = (delivered: number) =>
            ThreadActivityUpdate.make({
              commandId: nextCommandId(),
              threadId,
              patch: {
                ...emptyActivityPatch,
                subagents: Option.some(
                  tallyOfRegistry({
                    items: {
                      "call-1": {
                        status: "settled",
                        settlements: [{ outcome: "completed" }],
                        delivered,
                      },
                    },
                  })
                ),
              },
            });

          yield* commit(fromRegistry(0));

          const read = yield* thread(1);

          assert.deepStrictEqual(
            [
              yield* refusal(
                ThreadSettle.make({ commandId: nextCommandId(), threadId })
              ),
              yield* refusal(
                ThreadAutoSettle.make({
                  commandId: nextCommandId(),
                  threadId,
                  snapshotAt: read.updatedAt,
                  settledAt: read.createdAt,
                })
              ),
            ],
            ["ShellCommandConflict", "ShellCommandConflict"]
          );

          yield* commit(fromRegistry(1));
          yield* commit(
            ThreadSettle.make({ commandId: nextCommandId(), threadId })
          );

          assert.deepStrictEqual(
            (yield* thread(1)).settledOverride,
            Option.some("settled")
          );
        })
      )
  );

  it.effect(
    "refuses to settle, snooze, pin or archive a subagent's own row: its parent's row holds it",
    () =>
      run(
        Effect.gen(function* () {
          yield* seedChild;

          const child = testThreadId(2);
          const read = yield* thread(2);

          const refused = yield* Effect.forEach(
            [
              ThreadSettle.make({
                commandId: nextCommandId(),
                threadId: child,
              }),
              ThreadSnooze.make({
                commandId: nextCommandId(),
                threadId: child,
                until: DateTime.makeUnsafe(60_000),
              }),
              ThreadPin.make({ commandId: nextCommandId(), threadId: child }),
              ThreadArchive.make({
                commandId: nextCommandId(),
                threadId: child,
              }),
              ThreadAutoSettle.make({
                commandId: nextCommandId(),
                threadId: child,
                snapshotAt: read.updatedAt,
                settledAt: read.createdAt,
              }),
            ],
            refusal
          );

          assert.deepStrictEqual(refused, [
            "ShellCommandInvalid",
            "ShellCommandInvalid",
            "ShellCommandInvalid",
            "ShellCommandInvalid",
            "ShellCommandInvalid",
          ]);

          const after = yield* thread(2);

          assert.deepStrictEqual(
            [after.settledOverride, after.pinnedAt, after.archivedAt],
            [Option.none(), Option.none(), Option.none()]
          );
        })
      )
  );

  it.effect("a tally moves no `updatedAt`", () =>
    run(
      Effect.gen(function* () {
        yield* seedChild;

        const before = yield* thread(1);

        yield* TestClock.adjust(Duration.seconds(1));
        yield* commit(tally(1, 0));

        const after = yield* thread(1);

        assert.deepStrictEqual(
          [after.subagents.working, after.updatedAt],
          [1, before.updatedAt]
        );
      })
    )
  );
});

describe("the event log", () => {
  it.effect(
    "keeps the newest 5,000 events and the receipts they cover",
    () =>
      run(
        Effect.gen(function* () {
          yield* seed;
          const events = yield* EventStore;

          for (let n = 1; n <= SHELL_EVENT_RETENTION + 10; n += 1) {
            yield* commit(
              ThreadVisit.make({
                commandId: nextCommandId(),
                threadId,
                at: DateTime.makeUnsafe(n),
              })
            );
          }

          const latest = yield* events.latestSequence;
          const floor = yield* events.earliestRetainedSequence;

          assert.strictEqual(latest, SHELL_EVENT_RETENTION + 12);
          assert.deepStrictEqual(
            floor,
            Option.some(latest - SHELL_EVENT_RETENTION + 1)
          );
        })
      ),
    { timeout: 60_000 }
  );
});
