import type {
  ProjectShell,
  ShellStreamItem,
  ThreadShell,
} from "@cairn/protocol/Shell";
import {
  ThreadRename,
  ThreadSettle,
  ThreadVisit,
} from "@cairn/protocol/ShellCommands";
import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  DateTime,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Result,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";

import { FolderRules } from "../projects/FolderRules.ts";
import { ShellHandlers } from "../rpc/ShellHandlers.ts";
import { EventSink } from "./EventSink.ts";
import { EventStore } from "./EventStore.ts";
import type { ServerShellCommand } from "./ShellCommands.ts";
import { ShellSnapshot } from "./ShellSnapshot.ts";
import { ShellLiveStreamLimits } from "./ShellStream.ts";
import {
  createProject,
  createThread,
  ShellRpcs,
  ShellTestLayer,
  testCommandId,
  testThreadId,
  ViewerTest,
} from "./ShellTestKit.ts";

// Test projects name folders that do not exist; the folder rules are judged in FolderRules.test.ts.
const AllowAllFolders = Layer.mock(FolderRules)({
  config: { home: "/", deny: [] },
  check: (input) => Effect.succeed(input),
});

const TestLayer = ShellHandlers.pipe(
  Layer.provide(AllowAllFolders),
  Layer.provideMerge(ShellTestLayer),
  Layer.provideMerge(ViewerTest)
);

type TestServices = Layer.Success<typeof TestLayer>;

const run = <A, E>(body: Effect.Effect<A, E, TestServices | Scope.Scope>) =>
  body.pipe(Effect.scoped, Effect.provide(TestLayer));

const makeClient = RpcTest.makeClient(ShellRpcs);

type Client = Effect.Success<typeof makeClient>;

/** Reads a stream item by item, so a test can act between reads. */
const reader = Effect.fnUntraced(function* <E>(
  stream: Stream.Stream<ShellStreamItem, E>
) {
  const pull = yield* Stream.toPull(stream);
  const buffered: Array<ShellStreamItem> = [];

  return (count: number) =>
    Effect.gen(function* () {
      while (buffered.length < count) {
        buffered.push(...(yield* pull));
      }

      return buffered.splice(0, count);
    });
});

/** What a client holds after applying shell items, keyed by id. */
interface Held {
  sequence: number;
  readonly projects: Map<string, ProjectShell>;
  readonly threads: Map<string, ThreadShell>;
}

const emptyHeld = (): Held => ({
  sequence: 0,
  projects: new Map(),
  threads: new Map(),
});

const apply = (held: Held, items: ReadonlyArray<ShellStreamItem>) => {
  for (const item of items) {
    Match.valueTags(item, {
      Snapshot: ({ snapshot }) => {
        held.sequence = snapshot.snapshotSequence;
        held.projects.clear();
        held.threads.clear();

        for (const project of snapshot.projects) {
          held.projects.set(project.id, project);
        }

        for (const thread of snapshot.threads) {
          held.threads.set(thread.id, thread);
        }
      },
      Synchronized: () => {},
      ProjectUpdated: ({ sequence, project }) => {
        if (sequence > held.sequence) {
          held.sequence = sequence;
          held.projects.set(project.id, project);
        }
      },
      ProjectRemoved: ({ sequence, projectId }) => {
        if (sequence > held.sequence) {
          held.sequence = sequence;
          held.projects.delete(projectId);
        }
      },
      ThreadUpdated: ({ sequence, thread }) => {
        if (sequence > held.sequence) {
          held.sequence = sequence;
          held.threads.set(thread.id, thread);
        }
      },
      ThreadRemoved: ({ sequence, threadId }) => {
        if (sequence > held.sequence) {
          held.sequence = sequence;
          held.threads.delete(threadId);
        }
      },
    });
  }

  return held;
};

/** Asserts the held rows equal the database's snapshot. */
const assertHoldsSnapshot = Effect.fnUntraced(function* (held: Held) {
  const snapshot = yield* (yield* ShellSnapshot).load;

  assert.deepStrictEqual(
    Arr.sort([...held.threads.keys()], (left: string, right: string) =>
      left < right ? -1 : 1
    ),
    snapshot.threads.map((thread) => thread.id).toSorted()
  );
  assert.deepStrictEqual(
    [...held.projects.keys()].toSorted(),
    snapshot.projects.map((project) => project.id).toSorted()
  );

  for (const thread of snapshot.threads) {
    assert.deepStrictEqual(held.threads.get(thread.id), thread);
  }
});

const threadUpdate = (item: ShellStreamItem | undefined) =>
  item !== undefined && Predicate.isTagged(item, "ThreadUpdated")
    ? Option.some(item)
    : Option.none();

const tags = (items: ReadonlyArray<ShellStreamItem>) =>
  items.map((item) => item._tag);

const fresh = { afterSequence: Option.none(), requestCompletionMarker: true };

const resumeAfter = (sequence: number) => ({
  afterSequence: Option.some(sequence),
  requestCompletionMarker: true,
});

/** Commits a server-side command (thread creation is not a client command). */
const launch = Effect.fnUntraced(function* (command: ServerShellCommand) {
  const sink = yield* EventSink;

  return yield* sink.commitCommand(command);
});

/** One project (through the client) with `threads` threads (through the event sink). */
const seed = Effect.fnUntraced(function* (client: Client, threads: number) {
  const { projectId, command } = createProject(1);

  yield* client["shell.dispatch"](command);

  for (let n = 1; n <= threads; n += 1) {
    yield* launch(createThread(projectId, n));
  }

  return projectId;
});

let nextCommand = 0;

const rename = (n: number, title: string) => {
  nextCommand += 1;

  return ThreadRename.make({
    commandId: testCommandId(nextCommand),
    threadId: testThreadId(n),
    title,
  });
};

const visit = (n: number, at: DateTime.Utc) => {
  nextCommand += 1;

  return ThreadVisit.make({
    commandId: testCommandId(nextCommand),
    threadId: testThreadId(n),
    at,
  });
};

describe("ShellStream over RPC", () => {
  it.live("sends a snapshot, the completion marker, then live rows", () =>
    run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        yield* seed(client, 2);
        const take = yield* reader(client["shell.subscribe"](fresh));
        const [snapshot, marker] = yield* take(2);

        assert.deepStrictEqual(
          tags([snapshot, marker].filter((item) => item !== undefined)),
          ["Snapshot", "Synchronized"]
        );

        const held = apply(
          emptyHeld(),
          [snapshot, marker].filter((item) => item !== undefined)
        );

        assert.strictEqual(held.threads.size, 2);
        assert.strictEqual(held.sequence, 3);

        const result = yield* client["shell.dispatch"](rename(1, "Renamed"));
        const [update] = yield* take(1);

        assert.strictEqual(result.sequence, 4);
        assert.deepStrictEqual(
          Option.map(threadUpdate(update), (item) => [
            item.sequence,
            item.thread.title,
          ]),
          Option.some([4, "Renamed"])
        );
      })
    )
  );

  it.live("replays the rows changed after the cursor, with no snapshot", () =>
    run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        yield* seed(client, 3);
        const cursor = yield* (yield* EventStore).latestSequence;

        yield* client["shell.dispatch"](rename(1, "First"));
        yield* client["shell.dispatch"](rename(1, "Second"));
        yield* client["shell.dispatch"](rename(2, "Other"));

        const take = yield* reader(
          client["shell.subscribe"](resumeAfter(cursor))
        );

        const items = yield* take(3);

        assert.deepStrictEqual(tags(items), [
          "ThreadUpdated",
          "ThreadUpdated",
          "Synchronized",
        ]);

        const held = apply(emptyHeld(), items);

        assert.strictEqual(held.threads.get(testThreadId(1))?.title, "Second");
        assert.strictEqual(held.threads.get(testThreadId(2))?.title, "Other");
        assert.strictEqual(held.sequence, cursor + 3);
      })
    )
  );

  it.live("sends a snapshot when the gap is over 1,000 events", () =>
    run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        yield* seed(client, 1);
        const cursor = yield* (yield* EventStore).latestSequence;
        const start = yield* DateTime.now;

        for (let n = 1; n <= 1001; n += 1) {
          yield* client["shell.dispatch"](
            visit(1, DateTime.add(start, { seconds: n }))
          );
        }

        const take = yield* reader(
          client["shell.subscribe"](resumeAfter(cursor))
        );

        const [first] = yield* take(1);

        assert.strictEqual(first?._tag, "Snapshot");
      })
    )
  );

  it.live("replays exactly 1,000 events without a snapshot", () =>
    run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        yield* seed(client, 1);
        const cursor = yield* (yield* EventStore).latestSequence;
        const start = yield* DateTime.now;

        for (let n = 1; n <= 1000; n += 1) {
          yield* client["shell.dispatch"](
            visit(1, DateTime.add(start, { seconds: n }))
          );
        }

        const take = yield* reader(
          client["shell.subscribe"](resumeAfter(cursor))
        );

        const items = yield* take(2);

        assert.deepStrictEqual(tags(items), ["ThreadUpdated", "Synchronized"]);
      })
    )
  );

  it.live("sends a snapshot for a cursor above the high-water mark", () =>
    run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        yield* seed(client, 1);
        const highWater = yield* (yield* EventStore).latestSequence;

        const take = yield* reader(
          client["shell.subscribe"](resumeAfter(highWater + 10))
        );

        const items = yield* take(2);

        assert.deepStrictEqual(tags(items), ["Snapshot", "Synchronized"]);
      })
    )
  );

  it.live("sends a snapshot for a cursor below the pruned floor", () =>
    run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        yield* seed(client, 6);
        const sql = yield* SqlClient.SqlClient;

        // Events 1 to 5 are gone, as if pruned.
        yield* sql`DELETE FROM shell_events WHERE sequence <= 5`;

        const below = yield* reader(client["shell.subscribe"](resumeAfter(3)));

        assert.deepStrictEqual(tags(yield* below(1)), ["Snapshot"]);

        const atFloor = yield* reader(
          client["shell.subscribe"](resumeAfter(5))
        );

        const replayed = yield* atFloor(3);

        assert.deepStrictEqual(tags(replayed), [
          "ThreadUpdated",
          "ThreadUpdated",
          "Synchronized",
        ]);
      })
    )
  );

  it.live("skips a stored event of a kind this build does not know", () =>
    run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        yield* seed(client, 2);
        const cursor = yield* (yield* EventStore).latestSequence;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`
          INSERT INTO shell_events (
            aggregate_kind, aggregate_id, event_type, occurred_at, command_id, payload_json
          )
          VALUES ('thread', ${testThreadId(1)}, 'thread.from-a-newer-build', 0, 'x', '{}')
        `;
        yield* client["shell.dispatch"](rename(2, "After the unknown row"));

        const take = yield* reader(
          client["shell.subscribe"](resumeAfter(cursor))
        );

        const items = yield* take(2);

        assert.deepStrictEqual(tags(items), ["ThreadUpdated", "Synchronized"]);
        assert.deepStrictEqual(
          Option.map(threadUpdate(items[0]), (item) => item.thread.id),
          Option.some(testThreadId(2))
        );
      })
    )
  );

  it.live(
    "fails a stalled subscriber with LiveStreamOverflow, then a resubscribe converges",
    () =>
      run(
        Effect.gen(function* () {
          const client = yield* makeClient;
          const projectId = yield* seed(client, 0);
          const take = yield* reader(client["shell.subscribe"](fresh));
          const held = apply(emptyHeld(), yield* take(2));

          // The reader stops pulling: the client's own buffer fills, then the server's.
          for (let n = 1; n <= 60; n += 1) {
            yield* launch(createThread(projectId, n));
          }

          const drained: Array<ShellStreamItem> = [];

          const ended = yield* Effect.gen(function* () {
            while (true) {
              drained.push(...(yield* take(1)));
            }
          }).pipe(Effect.result);

          assert.isTrue(Result.isFailure(ended));

          if (Result.isFailure(ended)) {
            assert.strictEqual(ended.failure._tag, "LiveStreamOverflow");
          }

          apply(held, drained);
          assert.isBelow(held.threads.size, 60);

          const resumed = yield* reader(
            client["shell.subscribe"](resumeAfter(held.sequence))
          );

          const items: Array<ShellStreamItem> = [];

          while (!items.some(Predicate.isTagged("Synchronized"))) {
            items.push(...(yield* resumed(1)));
          }

          apply(held, items);
          yield* assertHoldsSnapshot(held);
        }).pipe(
          Effect.provideService(ShellLiveStreamLimits, {
            maxItems: 2,
            maxSerializedBytes: 8 * 1024 * 1024,
          })
        )
      )
  );

  it.live(
    "returns the first answer to a resent command and appends nothing",
    () =>
      run(
        Effect.gen(function* () {
          const client = yield* makeClient;
          yield* seed(client, 1);
          const command = rename(1, "Once");
          const first = yield* client["shell.dispatch"](command);
          const second = yield* client["shell.dispatch"](command);
          const events = yield* EventStore;

          assert.deepStrictEqual(second, first);
          assert.strictEqual(yield* events.latestSequence, first.sequence);

          nextCommand += 1;

          const settleMissing = ThreadSettle.make({
            commandId: testCommandId(nextCommand),
            threadId: testThreadId(99),
          });

          const refused = yield* Effect.flip(
            client["shell.dispatch"](settleMissing)
          );

          const refusedAgain = yield* Effect.flip(
            client["shell.dispatch"](settleMissing)
          );

          assert.strictEqual(refused._tag, "NotFound");
          assert.deepStrictEqual(refusedAgain, refused);
          assert.strictEqual(yield* events.latestSequence, first.sequence);
        })
      )
  );

  it.live("delivers concurrent commits in sequence order", () =>
    run(
      Effect.gen(function* () {
        const client = yield* makeClient;
        const projectId = yield* seed(client, 0);
        const take = yield* reader(client["shell.subscribe"](fresh));

        yield* take(2);
        yield* Effect.forEach(
          Arr.range(1, 40),
          (n) => launch(createThread(projectId, n)),
          { concurrency: "unbounded", discard: true }
        );

        const items = yield* take(40);

        const updates = Arr.getSomes(items.map(threadUpdate));
        const sequences = updates.map((item) => item.sequence);

        assert.deepStrictEqual(sequences, Arr.range(2, 41));
        assert.strictEqual(
          new Set(updates.map((item) => item.thread.id)).size,
          40
        );
      })
    )
  );
});
