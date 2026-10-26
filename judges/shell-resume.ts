// The shell resume judge: the integrated brain's shell store behind its real /ws (guard, identity,
// per-socket RPC server), reached through a TCP proxy that cuts every connection at random points
// while commands commit. A client that applies the stream with @cairn/client-logic's ShellReducer,
// and resubscribes from its cursor after each cut, must hold exactly the database's snapshot within
// 2 s of every cut.
//   node judges/shell-resume.ts [--rounds 24] [--seed <n>]
//
// Rounds alternate plain cuts (the resume replays a short gap) with long outages that commit more
// than 1,000 events (the resume falls back to a snapshot). Prints one JSON line of measured numbers
// and exits 0 only when every round converged within the deadline.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  applyShellStreamItem,
  shellCursor,
} from "@cairn/client-logic/ShellReducer";
import type { ProjectId } from "@cairn/protocol/Ids";
import { CairnRpcs, PROTOCOL_VERSION } from "@cairn/protocol/Rpc";
import { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import type { ShellSnapshot as ShellSnapshotValue } from "@cairn/protocol/Shell";
import {
  ThreadArchive,
  ThreadPin,
  ThreadRename,
  ThreadSettle,
  ThreadUnarchive,
  ThreadUnpin,
  ThreadUnsettle,
  ThreadVisit,
} from "@cairn/protocol/ShellCommands";
import { NodeRuntime, NodeServices, NodeSocket } from "@effect/platform-node";
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Random,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpServer } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

import { AppLayer, ScriptedBrain } from "../apps/server/src/AppLayer.ts";
import { ServerConfig } from "../apps/server/src/Config.ts";
import { ExecutorLink } from "../apps/server/src/executor/ExecutorLink.ts";
import { Identity, USER_HEADER } from "../apps/server/src/http/Identity.ts";
import { Tailscale } from "../apps/server/src/http/Tailscale.ts";
import { EventSink } from "../apps/server/src/shell/EventSink.ts";
import {
  emptyActivityPatch,
  ThreadActivityUpdate,
} from "../apps/server/src/shell/ShellCommands.ts";
import type { ServerShellCommand } from "../apps/server/src/shell/ShellCommands.ts";
import { ShellSnapshot } from "../apps/server/src/shell/ShellSnapshot.ts";
import {
  createProject,
  createThread,
  testThreadId,
} from "../apps/server/src/shell/ShellTestKit.ts";

const { values } = parseArgs({
  options: {
    rounds: { type: "string", default: "24" },
    seed: { type: "string", default: "1" },
  },
});

const ROUNDS = Number(values.rounds);

const DEADLINE_MS = 2000;

const THREADS = 40;

const LONG_OUTAGE_EVENTS = 1100;

// The proxy: plain Node sockets, because cutting TCP under the client is the point.

interface Proxy {
  readonly port: number;
  /** Destroys every open connection at once. */
  readonly cut: Effect.Effect<number>;
  /** While blocked, new connections are refused. */
  readonly setBlocked: (blocked: boolean) => Effect.Effect<void>;
}

const makeProxy = (targetPort: number) =>
  Effect.acquireRelease(
    Effect.callback<Proxy & { readonly server: net.Server }>((resume) => {
      const pairs = new Set<readonly [net.Socket, net.Socket]>();
      let blocked = false;

      const server = net.createServer((client) => {
        if (blocked) {
          client.destroy();

          return;
        }

        const upstream = net.connect(targetPort, "127.0.0.1");
        const pair = [client, upstream] as const;

        const close = () => {
          client.destroy();
          upstream.destroy();
          pairs.delete(pair);
        };

        pairs.add(pair);
        client.on("error", close).on("close", close);
        upstream.on("error", close).on("close", close);
        client.pipe(upstream);
        upstream.pipe(client);
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();

        const port =
          address === null || Predicate.isString(address) ? 0 : address.port;

        resume(
          Effect.succeed({
            server,
            port,
            cut: Effect.sync(() => {
              const count = pairs.size;

              for (const [client, upstream] of pairs) {
                client.resetAndDestroy();
                upstream.resetAndDestroy();
              }

              pairs.clear();

              return count;
            }),
            setBlocked: (next: boolean) =>
              Effect.sync(() => {
                blocked = next;
              }),
          })
        );
      });
    }),
    (proxy) =>
      Effect.callback<undefined>((resume) => {
        proxy.server.close(() => {
          resume(Effect.undefined);
        });
      })
  );

// The server: the integrated brain (AppLayer: the guard, per-socket RPC servers with the real
// ViewerMiddleware, the shell store on a temporary file, GET /api/shell) over the scripted harness,
// with judge-main's identity rules (a fixed tailnet in which loopback is the owner's node).

const OWNER = "owner@loopback";

const ORIGIN = "http://127.0.0.1";

/** The headers Caddy would send, which the guard and the socket's identity check read. */
const CADDY_HEADERS = {
  host: "127.0.0.1",
  origin: ORIGIN,
  [USER_HEADER]: OWNER,
};

const judgeNode = {
  stableId: "judge",
  loginName: OWNER,
  tags: [],
  nodeName: "judge.loopback",
};

const ServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    const directory = yield* fileSystem.makeTempDirectoryScoped({
      directory: os.tmpdir(),
      prefix: "cairn-shell-resume-",
    });

    return AppLayer.pipe(
      Layer.provide(ScriptedBrain),
      Layer.provide(ExecutorLink.layerDisabled),
      Layer.provide(Identity.layerNoDeps),
      Layer.provide(
        Tailscale.fixed(
          new Map([
            ["127.0.0.1", judgeNode],
            ["::ffff:127.0.0.1", judgeNode],
          ])
        )
      ),
      Layer.provide(
        ServerConfig.layerWith({
          host: "127.0.0.1",
          origin: ORIGIN,
          owner: OWNER,
          dataDir: directory,
          webRoot: path.join(directory, "no-web"),
        })
      )
    );
  })
).pipe(Layer.provide(NodeServices.layer));

// The client: one subscription per connection, resubscribing from the reducer's cursor.

interface ClientStats {
  readonly sessions: number;
  readonly snapshots: number;
  readonly items: number;
}

const runClient = (
  proxyPort: number,
  state: Ref.Ref<Option.Option<ShellSnapshotValue>>,
  stats: Ref.Ref<ClientStats>
) => {
  const session = Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
        pingInterval: "3 seconds",
        pingTimeout: "8 seconds",
      }).pipe(
        Layer.provide(
          NodeSocket.layerWebSocket(
            `ws://127.0.0.1:${proxyPort}/ws?protocol=${PROTOCOL_VERSION}`,
            { headers: CADDY_HEADERS }
          )
        ),
        Layer.provide(RpcSerialization.layerJson)
      )
    );

    const client = yield* RpcClient.make(CairnRpcs).pipe(
      Effect.provide(protocol)
    );

    const cursor = shellCursor(yield* Ref.get(state));

    yield* Ref.update(stats, (current) => ({
      ...current,
      sessions: current.sessions + 1,
    }));
    yield* client["shell.subscribe"]({
      afterSequence: cursor,
      requestCompletionMarker: true,
    }).pipe(
      Stream.runForEach((item) =>
        Effect.gen(function* () {
          yield* Ref.update(state, (current) =>
            applyShellStreamItem(current, item)
          );
          yield* Ref.update(stats, (current) => ({
            ...current,
            items: current.items + 1,
            snapshots:
              current.snapshots +
              (Predicate.isTagged(item, "Snapshot") ? 1 : 0),
          }));
        })
      )
    );
  }).pipe(Effect.scoped, Effect.ignore);

  return session.pipe(
    Effect.andThen(Effect.sleep(Duration.millis(20))),
    Effect.forever,
    Effect.forkScoped
  );
};

// The writer: random inbox commands, committed server-side as fast as the store takes them.

const sameShell = Schema.toEquivalence(
  Schema.Struct({
    projects: Schema.Array(ProjectShell),
    threads: Schema.Array(ThreadShell),
  })
);

const byId = <A extends { readonly id: string }>(rows: ReadonlyArray<A>) =>
  rows.toSorted((left, right) => left.id.localeCompare(right.id));

const holdsSnapshot = (
  held: Option.Option<ShellSnapshotValue>,
  truth: ShellSnapshotValue
) =>
  Option.match(held, {
    onNone: () => false,
    onSome: (snapshot) =>
      sameShell(
        { projects: byId(snapshot.projects), threads: byId(snapshot.threads) },
        { projects: byId(truth.projects), threads: byId(truth.threads) }
      ),
  });

const randomCommand = Effect.gen(function* () {
  const sink = yield* EventSink;
  const n = yield* Random.nextIntBetween(1, THREADS);
  const threadId = testThreadId(n);
  const commandId = yield* sink.mintCommandId;
  const pick = yield* Random.nextIntBetween(0, 9);
  const now = yield* DateTime.now;

  const commands: ReadonlyArray<ServerShellCommand> = [
    ThreadRename.make({
      commandId,
      threadId,
      title: `Thread ${n} at ${DateTime.toEpochMillis(now)}`,
    }),
    ThreadSettle.make({ commandId, threadId }),
    ThreadUnsettle.make({ commandId, threadId }),
    ThreadPin.make({ commandId, threadId }),
    ThreadUnpin.make({ commandId, threadId }),
    ThreadVisit.make({ commandId, threadId, at: now }),
    ThreadArchive.make({ commandId, threadId }),
    ThreadUnarchive.make({ commandId, threadId }),
    ThreadActivityUpdate.make({
      commandId,
      threadId,
      patch: { ...emptyActivityPatch, queueLength: Option.some(pick % 3) },
    }),
    ThreadActivityUpdate.make({
      commandId,
      threadId,
      patch: {
        ...emptyActivityPatch,
        activity: Option.some(pick % 2 === 0 ? "running" : "idle"),
        latestRunCompletedAt: Option.some(Option.some(now)),
      },
    }),
  ];

  const command = commands[pick % commands.length] ?? commands[0];

  if (command !== undefined) {
    yield* sink.commitCommand(command).pipe(Effect.ignore);
  }
});

const writeFor = (duration: Duration.Duration) =>
  randomCommand.pipe(
    Effect.andThen(Effect.sleep(Duration.millis(1))),
    Effect.forever,
    Effect.timeoutOrElse({ duration, orElse: () => Effect.void })
  );

/** Commits `count` visits, which are always accepted, so the log grows by exactly `count`. */
const writeVisits = (count: number) =>
  Effect.gen(function* () {
    const sink = yield* EventSink;
    const start = yield* DateTime.now;

    for (let n = 1; n <= count; n += 1) {
      yield* sink.commitCommand(
        ThreadVisit.make({
          commandId: yield* sink.mintCommandId,
          threadId: testThreadId((n % THREADS) + 1),
          at: DateTime.add(start, { milliseconds: n }),
        })
      );
    }
  });

const sameThread = Schema.toEquivalence(ThreadShell);

/** The ids of rows the client holds differently from the database, for the report. */
const differingRows = (
  held: Option.Option<ShellSnapshotValue>,
  truth: ShellSnapshotValue
) => {
  const heldRows = new Map(
    Option.match(held, {
      onNone: () => [],
      onSome: (snapshot) => snapshot.threads,
    }).map((thread) => [thread.id, thread] as const)
  );

  return truth.threads
    .filter((thread) => {
      const mine = heldRows.get(thread.id);

      return mine === undefined || !sameThread(mine, thread);
    })
    .map((thread) => thread.id);
};

const program = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const sink = yield* EventSink;
  const snapshots = yield* ShellSnapshot;
  const serverPort = "port" in server.address ? server.address.port : 0;
  const proxy = yield* makeProxy(serverPort);
  const { projectId, command } = createProject(1, "judged");

  yield* sink.commitCommand(command);

  for (let n = 1; n <= THREADS; n += 1) {
    yield* sink.commitCommand(createThread(projectId satisfies ProjectId, n));
  }

  const state = yield* Ref.make(Option.none<ShellSnapshotValue>());

  const stats = yield* Ref.make<ClientStats>({
    sessions: 0,
    snapshots: 0,
    items: 0,
  });

  yield* runClient(proxy.port, state, stats);

  const diverged: Array<string> = [];

  const waitConverged = Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;

    while (true) {
      const truth = yield* snapshots.load;

      if (holdsSnapshot(yield* Ref.get(state), truth)) {
        return (yield* Clock.currentTimeMillis) - start;
      }

      const elapsed = (yield* Clock.currentTimeMillis) - start;

      if (elapsed > DEADLINE_MS * 3) {
        diverged.push(...differingRows(yield* Ref.get(state), truth));

        return elapsed;
      }

      yield* Effect.sleep(Duration.millis(5));
    }
  });

  const initial = yield* waitConverged;

  const rounds: Array<{
    round: number;
    kind: string;
    cut: number;
    convergedMs: number;
  }> = [];

  for (let round = 1; round <= ROUNDS; round += 1) {
    const longOutage = round % 6 === 0;

    if (longOutage) {
      // Hold the client off while more than 1,000 events commit, so its resume needs a snapshot.
      yield* proxy.setBlocked(true);
      const cut = yield* proxy.cut;

      yield* writeVisits(LONG_OUTAGE_EVENTS);
      yield* proxy.setBlocked(false);

      const convergedMs = yield* waitConverged;

      rounds.push({ round, kind: "outage", cut, convergedMs });
    } else {
      // Cut while commands are committing, at a random point, then let writes run on briefly.
      const before = Duration.millis(yield* Random.nextIntBetween(20, 400));
      const after = Duration.millis(yield* Random.nextIntBetween(0, 200));

      yield* writeFor(before);
      const cut = yield* proxy.cut;
      const cutAt = yield* Clock.currentTimeMillis;

      yield* writeFor(after);

      yield* waitConverged;
      const convergedMs = (yield* Clock.currentTimeMillis) - cutAt;

      rounds.push({ round, kind: "cut", cut, convergedMs });
    }
  }

  const finalStats = yield* Ref.get(stats);
  const worst = Math.max(...rounds.map((round) => round.convergedMs));
  const passed = initial <= DEADLINE_MS && worst <= DEADLINE_MS;

  const sorted = rounds
    .map((round) => round.convergedMs)
    .toSorted((a, b) => a - b);

  const latestSequence = (yield* snapshots.load).snapshotSequence;

  const report = JSON.stringify({
    judge: "shell-resume",
    passed,
    deadlineMs: DEADLINE_MS,
    rounds: rounds.length,
    initialConvergedMs: initial,
    medianConvergedMs: sorted[Math.floor(sorted.length / 2)],
    worstConvergedMs: worst,
    latestSequence,
    clientSessions: finalStats.sessions,
    snapshotsReceived: finalStats.snapshots,
    itemsReceived: finalStats.items,
    perRound: rounds,
  });

  yield* Effect.sync(() => process.stdout.write(`${report}\n`));

  if (!passed) {
    process.exitCode = 1;
  }
}).pipe(Effect.scoped, Random.withSeed(values.seed));

NodeRuntime.runMain(program.pipe(Effect.provide(ServerLayer)));
