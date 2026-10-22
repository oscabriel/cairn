// The durability judge (notes/edges.md, "Durability"): the real judge brain (`judge-main.ts`, the
// production composition with the judge tools and the scripted faux model) runs as a transient
// systemd user unit, and the judge kills its main process with `kill -9` (or restarts it with
// SIGTERM) at chosen points of a turn, then checks what survived.
//   node judges/durability.ts [--window <name>]... [--sabotage skip-snapshot] [--keep]
//
// Windows: streaming (after the 5th partial of a long reply), mid-tool (while `slow` runs),
// between-tool-and-result (right after `mark` wrote its effect, before its result commits),
// mid-commit (after pi-durable committed a run's end and before the shell row did, held by
// `CAIRN_JUDGE_HOLD_PROJECTOR_MS`), send-in-flight (the kill lands before `thread.send` answers;
// the client resends the same request id), during-launch (the kill lands inside `thread.launch`; the
// client resends the same command id), kill-six (five kills while `slow` runs park its tasks, then
// `thread.retryTask` finishes the turn), sigterm-six (six clean restarts while `slow` runs park
// nothing).
//
// `--bridge` adds the bridge windows (wave 3): bridge-streaming (`kill -9` while a Claude reply
// streams) and bridge-tool-parked (while a `bash` call is held in the bridge). Each runs
// `judges/claude-kill.ts` (the judge brain with the real Claude bridge, `judge-main.ts --models
// real`) for that case and reports its line here; its checks are J2's and J9's (once-only marker,
// interrupted result for the parked call, no `claude` child left, prompt cache kept, snapshot within
// 2 s). They cost a few cents of plan usage and are never run by default.
//
// Per window it asserts: every entry committed before the kill is still there; each `mark` label
// ran exactly once, or zero times with a result saying it "may have run"; the restarted brain's
// first thread snapshot reaches a reconnected client within 2 s of its socket opening; after the
// turn ends, the reconnected client's thread view and shell rows equal a fresh client's (exactly,
// by schema equivalence), and the shell row is idle; the expected number of user entries exists.
//
// `--sabotage skip-snapshot` makes the reconnecting client ignore the first snapshot of each new
// subscription and keep its pre-kill view, which is what a server that skipped the snapshot would
// leave it with. Every window must then fail; the judge exits 0 only if they all did.
//
// Prints one JSON line per window: {window, pass, killToUp, upToConverged, effects, entries, notes}.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  applyShellStreamItem,
  shellCursor,
} from "@cairn/client-logic/ShellReducer";
import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import type { TaskId } from "@cairn/protocol/Ids";
import { CommandId, ProjectId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import type { CairnRpcs } from "@cairn/protocol/Rpc";
import { ShellSnapshot } from "@cairn/protocol/Shell";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import { ConversationView } from "@cairn/protocol/Thread";
import type { Entry } from "@cairn/protocol/Thread";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import type { FileSystem } from "effect";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Random,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { RpcClient, RpcClientError, RpcGroup } from "effect/rpc";

import { projectIdFor } from "../apps/server/src/shell/ShellCommands.ts";
import { SCRIPT_PREFIX } from "./fixtures/JudgeModel.ts";
import * as Events from "./lib/Events.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";
import * as Unit from "./lib/Unit.ts";

const WINDOWS = [
  "streaming",
  "mid-tool",
  "between-tool-and-result",
  "mid-commit",
  "send-in-flight",
  "during-launch",
  "kill-six",
  "sigterm-six",
] as const;

/**
 * The shutdown judge's control (`judges/shutdown.sh`), never run by default: a tool that ignores
 * its abort signal outlives a short `TimeoutStopSec`, so systemd must SIGKILL the brain.
 */
const CONTROL_WINDOWS = ["stubborn-control"] as const;

/** The bridge windows, run by `judges/claude-kill.ts` with the real Claude bridge. */
const BRIDGE_WINDOWS = {
  "bridge-streaming": "streaming",
  "bridge-tool-parked": "parked",
} as const;

type BridgeWindow = keyof typeof BRIDGE_WINDOWS;

/** A window this file runs itself. */
type KillWindow = (typeof WINDOWS)[number] | (typeof CONTROL_WINDOWS)[number];

type WindowName = KillWindow | BridgeWindow;

const isBridgeWindow = (name: string): name is BridgeWindow =>
  Object.hasOwn(BRIDGE_WINDOWS, name);

const isWindow = (name: string): name is WindowName =>
  isBridgeWindow(name) ||
  [...WINDOWS, ...CONTROL_WINDOWS].some((window) => window === name);

const { values } = parseArgs({
  options: {
    window: { type: "string", multiple: true },
    sabotage: { type: "string" },
    keep: { type: "boolean", default: false },
    bridge: { type: "boolean", default: false },
  },
});

const chosen = [
  ...(values.window ?? (values.bridge ? [] : [...WINDOWS])),
  ...(values.bridge ? Object.keys(BRIDGE_WINDOWS) : []),
].filter(isWindow);

const sabotage = values.sabotage === "skip-snapshot";

const REPO = path.resolve(import.meta.dirname, "..");

const ORIGIN = "http://judge.cairn.test";

const HOST = "judge.cairn.test";

const OWNER = "owner@loopback";

const CONVERGE_MS = 2000;

const QUIET_TIMEOUT = Duration.seconds(120);

const UP_TIMEOUT = Duration.seconds(60);

const MAY_HAVE_RUN = "may have run";

const USER_KINDS: ReadonlySet<string> = new Set(["pi.user", "cairn.user"]);

/** A check of the judge did not hold; the window fails with its message. */
class WindowFailed extends Schema.TaggedError<WindowFailed>()("WindowFailed", {
  message: Schema.String,
}) {}

const fail = (message: string) => Effect.fail(new WindowFailed({ message }));

type Client = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof CairnRpcs>,
  RpcClientError.RpcClientError
>;

// Ids. Commands and threads take UUIDv7 strings; requests an opaque token.

const hex = (value: number, width: number) =>
  value.toString(16).padStart(width, "0");

const uuid7 = Effect.gen(function* () {
  const time = hex(yield* Clock.currentTimeMillis, 12);

  const parts = yield* Effect.forEach([0, 1, 2, 3, 4], () =>
    Random.nextIntBetween(0, 0xff_ff)
  );

  const [a = 0, b = 0, c = 0, d = 0, e = 0] = parts;

  return [
    time.slice(0, 8),
    time.slice(8, 12),
    `7${hex(a % 0x10_00, 3)}`,
    hex(0x80_00 + (b % 0x40_00), 4),
    `${hex(c, 4)}${hex(d, 4)}${hex(e, 4)}`,
  ].join("-");
});

const newCommandId = Effect.map(uuid7, (id) => CommandId.make(id));

const newThreadId = Effect.map(uuid7, (id) => ThreadId.make(id));

const newRequestId = Effect.map(uuid7, (id) =>
  RequestId.make(`req_${id.replaceAll("-", "")}`)
);

// The brain under test.

interface Brain {
  readonly unit: string;
  readonly dir: string;
  readonly events: string;
  readonly effects: string;
  readonly project: string;
}

/** The port of the brain's next start whose log begins after byte `from`, once it is ready. */
const waitUp = (brain: Brain, from: number) =>
  Effect.gen(function* () {
    const port = yield* Events.waitForListening(brain.events, {
      from,
      timeout: UP_TIMEOUT,
    });

    yield* Events.waitFor(brain.events, "ready", Events.named("ready"), {
      from,
      timeout: UP_TIMEOUT,
    });

    return port;
  });

let unitCount = 0;

/** Starts `judge-main.ts` as a transient unit in a fresh directory and waits until it is ready. */
const startBrain = (
  window: WindowName,
  env: Readonly<Record<string, string>>,
  properties: Readonly<Record<string, string>>
) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(
      path.join(os.tmpdir(), `cairn-durability-${window}-`)
    );

    const project = path.join(dir, "project");

    mkdirSync(project);
    unitCount += 1;

    const brain: Brain = {
      unit: `cairn-judge-durability-${process.pid}-${unitCount}`,
      dir,
      events: path.join(dir, "events.log"),
      effects: path.join(dir, "effects.log"),
      project,
    };

    yield* Unit.start({
      name: brain.unit,
      command: [process.execPath, "apps/server/src/judge-main.ts"],
      cwd: REPO,
      properties: { ...Unit.brainProperties, ...properties },
      env: {
        // The brain's home is the run's folder, so FolderRules admits the project beside it.
        HOME: dir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CAIRN_PORT: "0",
        CAIRN_ORIGIN: ORIGIN,
        CAIRN_OWNER: OWNER,
        CAIRN_DATA_DIR: path.join(dir, "data"),
        CAIRN_CONFIG_DIR: path.join(dir, "config"),
        CAIRN_EVENTS_LOG: brain.events,
        CAIRN_JUDGE_EFFECTS_LOG: brain.effects,
        ...env,
      },
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (!values.keep) {
          rmSync(dir, { recursive: true, force: true });
        }
      })
    );

    const port = yield* waitUp(brain, 0);

    return { brain, port };
  });

/** `kill -9` of the brain's main process, as a crash; systemd starts it again. */
const crash = (brain: Brain) =>
  Effect.gen(function* () {
    const from = yield* Events.size(brain.events);
    const at = yield* Clock.currentTimeMillis;

    yield* Unit.killMain(brain.unit);

    return { from, at };
  });

/** A clean restart through systemd: SIGTERM, then a new start. */
const cleanRestart = (brain: Brain) =>
  Effect.gen(function* () {
    const from = yield* Events.size(brain.events);
    const at = yield* Clock.currentTimeMillis;

    yield* Unit.restart(brain.unit);

    return { from, at };
  });

/** A protocol client in the caller's scope, retried until the brain accepts the socket. */
const connect = (port: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const scope = yield* Scope.make();

      const opened = yield* ProtocolClient.cairn({
        base: `http://127.0.0.1:${port}`,
        origin: ORIGIN,
        headers: { host: HOST, "x-cairn-user": OWNER },
        openTimeout: "2 seconds",
      }).pipe(
        Effect.tap((client) =>
          client["session.hello"]().pipe(Effect.timeout("2 seconds"))
        ),
        Scope.provide(scope),
        Effect.result
      );

      if (Result.isSuccess(opened)) {
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

        return opened.success;
      }

      yield* Scope.close(scope, Exit.void);
      yield* Effect.sleep("50 millis");
    }

    return yield* fail(`no socket to the brain on port ${port} after 10 s`);
  });

// What a client holds: the thread view and the shell, applied from the streams.

interface Follower {
  readonly thread: Ref.Ref<Option.Option<ThreadViewState>>;
  readonly shell: Ref.Ref<Option.Option<ShellSnapshot>>;
  /** Ops frames since the follower was made. */
  readonly ops: Ref.Ref<number>;
  /** When this connection's first thread snapshot arrived. */
  readonly snapshotAt: Ref.Ref<Option.Option<number>>;
  readonly errors: Ref.Ref<ReadonlyArray<string>>;
}

const makeFollower = Effect.gen(function* () {
  return {
    thread: yield* Ref.make(Option.none<ThreadViewState>()),
    shell: yield* Ref.make(Option.none<ShellSnapshot>()),
    ops: yield* Ref.make(0),
    snapshotAt: yield* Ref.make(Option.none<number>()),
    errors: yield* Ref.make<ReadonlyArray<string>>([]),
  } satisfies Follower;
});

/**
 * Follows the thread and the shell on `client` for the scope's life. With `skipSnapshot`, the first
 * thread snapshot of this subscription is dropped while a view is held, as if the server had not
 * sent it.
 */
const follow = (
  client: Client,
  threadId: ThreadId,
  follower: Follower,
  skipSnapshot: boolean
) =>
  Effect.gen(function* () {
    yield* Ref.set(follower.snapshotAt, Option.none());

    let skipped = !skipSnapshot;

    yield* client["thread.subscribe"]({
      threadId,
      conversationId: Option.none(),
    }).pipe(
      Stream.runForEach((item) =>
        Effect.gen(function* () {
          const held = yield* Ref.get(follower.thread);

          if (Predicate.isTagged(item, "Snapshot")) {
            if (!skipped && Option.isSome(held)) {
              skipped = true;

              return;
            }

            const now = yield* Clock.currentTimeMillis;

            yield* Ref.update(follower.snapshotAt, (at) =>
              Option.isSome(at) ? at : Option.some(now)
            );
          } else {
            yield* Ref.update(follower.ops, (count) => count + 1);
          }

          const next = applyThreadStreamItem(held, item);

          if (Result.isFailure(next)) {
            yield* Ref.update(follower.errors, (errors) => [
              ...errors,
              next.failure.message,
            ]);

            return;
          }

          yield* Ref.set(follower.thread, Option.some(next.success));
        })
      ),
      Effect.ignore,
      Effect.forkScoped
    );

    const cursor = shellCursor(yield* Ref.get(follower.shell));

    yield* client["shell.subscribe"]({
      afterSequence: cursor,
      requestCompletionMarker: false,
    }).pipe(
      Stream.runForEach((item) =>
        Ref.update(follower.shell, (state) => applyShellStreamItem(state, item))
      ),
      Effect.ignore,
      Effect.forkScoped
    );
  });

const viewOf = (follower: Follower) =>
  Effect.map(Ref.get(follower.thread), (state) =>
    Option.map(state, (held) => held.view)
  );

const entriesOf = (view: Option.Option<ConversationView>) =>
  Option.match(view, {
    onNone: (): ReadonlyArray<Entry> => [],
    onSome: (found) => found.entries,
  });

const rowOf = (follower: Follower, threadId: ThreadId) =>
  Effect.map(Ref.get(follower.shell), (shell) =>
    Option.flatMap(shell, (snapshot) =>
      Option.fromUndefinedOr(
        snapshot.threads.find((thread) => thread.id === threadId)
      )
    )
  );

/** Polls `check` every 50 ms until it holds, or fails after `timeout` with `what`. */
const until = (
  what: string,
  check: Effect.Effect<boolean, WindowFailed>,
  timeout: Duration.Input
) =>
  Effect.gen(function* () {
    while (!(yield* check)) {
      yield* Effect.sleep("50 millis");
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => fail(`timed out waiting for ${what}`),
    })
  );

// Reading the view.

const PartsOf = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
    })
  ),
});

const decodeParts = Schema.decodeUnknownOption(PartsOf);

const partsOf = (entry: Entry) =>
  Option.match(decodeParts(entry.model?.[0]), {
    onNone: () => [],
    onSome: (message) => message.content,
  });

/** Whether the thread's newest entry is an assistant call of `tool` with no result after it. */
const toolPending = (entries: ReadonlyArray<Entry>, tool: string) => {
  const last = entries.at(-1);

  return (
    last !== undefined &&
    last.kind === "pi.assistant" &&
    partsOf(last).some((part) => part.type === "toolCall" && part.name === tool)
  );
};

const resultTexts = (entries: ReadonlyArray<Entry>) =>
  entries
    .filter((entry) => entry.kind === "pi.tool-result")
    .flatMap((entry) => partsOf(entry).flatMap((part) => part.text ?? []));

const userEntries = (entries: ReadonlyArray<Entry>) =>
  entries.filter((entry) => USER_KINDS.has(entry.kind)).length;

/** How many times each `mark` label wrote its effect. */
const effectCounts = (brain: Brain) => {
  const counts = new Map<string, number>();
  let text = "";

  try {
    text = readFileSync(brain.effects, "utf-8");
  } catch {
    text = "";
  }

  for (const line of text.split("\n")) {
    const label = /"label":"(?<label>[^"]*)"/u.exec(line)?.groups?.label;

    if (label !== undefined) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  return counts;
};

// One turn's setup.

/** Registers the brain's project folder and launches a thread whose first message is `script`. */
const launch = (
  client: Client,
  brain: Brain,
  script: string,
  options: { readonly worktree: boolean }
) =>
  Effect.gen(function* () {
    const commandId = yield* newCommandId;

    yield* client["shell.dispatch"](
      ProjectCreate.make({
        commandId,
        workspaceRoot: brain.project,
        title: Option.some("durability"),
      })
    );

    const threadId = yield* newThreadId;

    const input = {
      commandId: yield* newCommandId,
      threadId,
      projectId: ProjectId.make(projectIdFor(commandId)),
      title: Option.some("durability"),
      model: { provider: "faux", modelId: "scripted" },
      thinkingLevel: "off" as const,
      runtimeMode: "full-access" as const,
      workspace: options.worktree
        ? {
            _tag: "Worktree" as const,
            baseRef: "main",
            branch: Option.none(),
            startFromOrigin: false,
          }
        : { _tag: "Root" as const, branch: Option.none() },
      initialMessage: {
        requestId: yield* newRequestId,
        text: `${SCRIPT_PREFIX} ${script}`,
        attachments: [],
        skillRefs: [],
      },
    };

    return { threadId, input };
  });

const isQuiet = (row: Option.Option<ThreadShell>) =>
  Option.exists(
    row,
    (thread) =>
      thread.activity === "idle" &&
      Option.isNone(thread.activeRunId) &&
      thread.queueLength === 0 &&
      Option.isSome(thread.latestRunCompletedAt) &&
      Option.exists(
        thread.latestVisibleMessage,
        (message) => message.role === "assistant"
      )
  );

const sameView = Schema.toEquivalence(ConversationView);

const sameShell = Schema.toEquivalence(ShellSnapshot);

// The window's verdict.

interface Expectation {
  /** `mark` labels the script calls; each must have run once (or "may have run" with none). */
  readonly marks: ReadonlyArray<string>;
  readonly userEntries: number;
}

interface Measures {
  readonly killToUp: Array<number>;
  readonly upToConverged: Array<number>;
  readonly notes: Array<string>;
}

/**
 * After the last restart: reconnect, follow until the turn is quiet, then compare with a fresh
 * client and check effects, entries and the row.
 */
const judgeOutcome = (
  brain: Brain,
  port: number,
  threadId: ThreadId,
  follower: Follower,
  committedBefore: ReadonlyArray<Entry>,
  expect: Expectation,
  measures: Measures
) =>
  Effect.gen(function* () {
    const client = yield* connect(port);

    yield* follow(client, threadId, follower, sabotage);

    yield* until(
      "the turn to end",
      Effect.map(rowOf(follower, threadId), isQuiet),
      QUIET_TIMEOUT
    );
    yield* Effect.sleep("300 millis");

    // The oracle: a fresh client's first thread snapshot and shell snapshot.
    const oracle = yield* makeFollower;

    yield* Effect.scoped(
      Effect.gen(function* () {
        const fresh = yield* connect(port);

        yield* follow(fresh, threadId, oracle, false);
        yield* until(
          "the oracle's snapshots",
          Effect.gen(function* () {
            const view = yield* viewOf(oracle);
            const shell = yield* Ref.get(oracle.shell);

            return Option.isSome(view) && Option.isSome(shell);
          }),
          "10 seconds"
        );
      })
    );

    const oracleView = yield* viewOf(oracle);
    const oracleShell = yield* Ref.get(oracle.shell);

    const converged = yield* until(
      "the reconnected client to equal a fresh one",
      Effect.gen(function* () {
        const view = yield* viewOf(follower);
        const shell = yield* Ref.get(follower.shell);

        return (
          Option.isSome(view) &&
          Option.isSome(oracleView) &&
          sameView(view.value, oracleView.value) &&
          Option.isSome(shell) &&
          Option.isSome(oracleShell) &&
          sameShell(shell.value, oracleShell.value)
        );
      }),
      `${CONVERGE_MS} millis`
    ).pipe(Effect.result);

    const errors = yield* Ref.get(follower.errors);

    if (Result.isFailure(converged)) {
      return yield* fail(
        `the reconnected client did not converge${errors.length > 0 ? `: ${errors.join("; ")}` : ""}`
      );
    }

    const entries = entriesOf(oracleView);
    const ids = new Set(entries.map((entry) => entry.id));

    const lost = committedBefore.filter((entry) => !ids.has(entry.id));

    if (lost.length > 0) {
      return yield* fail(
        `${lost.length} entries committed before the kill are gone`
      );
    }

    const counts = effectCounts(brain);
    const results = resultTexts(entries);

    for (const label of expect.marks) {
      const count = counts.get(label) ?? 0;

      const ok =
        count === 1 ||
        (count === 0 && results.some((text) => text.includes(MAY_HAVE_RUN)));

      if (!ok) {
        return yield* fail(`mark ${label} ran ${count} times`);
      }
    }

    const users = userEntries(entries);

    if (users !== expect.userEntries) {
      return yield* fail(
        `${users} user entries, expected ${expect.userEntries}`
      );
    }

    return {
      effects: Object.fromEntries(counts),
      entries: entries.length,
      snapshotAt: yield* Ref.get(follower.snapshotAt),
      measures,
    };
  }).pipe(Effect.scoped);

/**
 * Records kill-to-up and up-to-snapshot for one restart, from a client that reconnects at once and
 * keeps following in the caller's scope.
 */
const measureRestart = (
  brain: Brain,
  restart: { readonly from: number; readonly at: number },
  threadId: ThreadId,
  follower: Follower,
  measures: Measures
) =>
  Effect.gen(function* () {
    const port = yield* waitUp(brain, restart.from);
    const client = yield* connect(port);
    const up = yield* Clock.currentTimeMillis;

    yield* follow(client, threadId, follower, sabotage);

    yield* until(
      "the first snapshot after the restart",
      Effect.map(Ref.get(follower.snapshotAt), Option.isSome),
      "10 seconds"
    ).pipe(Effect.ignore);

    const snapshotAt = yield* Ref.get(follower.snapshotAt);

    measures.killToUp.push(up - restart.at);

    if (Option.isSome(snapshotAt)) {
      const ms = snapshotAt.value - up;

      measures.upToConverged.push(ms);

      if (ms > CONVERGE_MS) {
        return yield* fail(
          `first snapshot came ${ms} ms after the socket opened`
        );
      }
    } else if (!sabotage) {
      return yield* fail("no snapshot after the restart");
    }

    return port;
  });

// The windows. Each returns the brain's port after the last restart and what to expect.

interface Plan {
  readonly env?: Readonly<Record<string, string>>;
  /** Unit properties over `Unit.brainProperties`. */
  readonly properties?: Readonly<Record<string, string>>;
  readonly expect: Expectation;
  readonly worktree?: boolean;
  readonly script: string;
  /** Drives the brain to the window and restarts it; returns the port to settle on. */
  readonly run: (context: {
    readonly brain: Brain;
    readonly port: number;
    readonly client: Client;
    readonly threadId: ThreadId;
    readonly follower: Follower;
    readonly measures: Measures;
    readonly started: Fiber.Fiber<unknown, unknown>;
  }) => Effect.Effect<
    { readonly port: number; readonly committed: ReadonlyArray<Entry> },
    WindowFailed | Unit.UnitError | Events.EventsLogError | Events.EventTimeout,
    | Scope.Scope
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
  >;
}

/** Kills once at the moment `aim` holds, and measures the restart. */
const killWhen =
  (
    what: string,
    aim: (
      context: Parameters<Plan["run"]>[0]
    ) => Effect.Effect<boolean, WindowFailed>
  ) =>
  (context: Parameters<Plan["run"]>[0]) =>
    Effect.gen(function* () {
      yield* until(what, aim(context), "60 seconds");

      const committed = entriesOf(yield* viewOf(context.follower));
      const restart = yield* crash(context.brain);

      const port = yield* measureRestart(
        context.brain,
        restart,
        context.threadId,
        context.follower,
        context.measures
      );

      return { port, committed };
    });

const plans: Readonly<Record<KillWindow, Plan>> = {
  streaming: {
    script: "text 600",
    expect: { marks: [], userEntries: 1 },
    run: killWhen("the 5th partial", ({ follower }) =>
      Effect.map(Ref.get(follower.ops), (ops) => ops >= 5)
    ),
  },
  "mid-tool": {
    script: 'tool slow {"ms":4000}; tool mark {"label":"after-slow"}; text 20',
    expect: { marks: ["after-slow"], userEntries: 1 },
    run: killWhen("slow to start", ({ follower }) =>
      Effect.map(viewOf(follower), (view) =>
        toolPending(entriesOf(view), "slow")
      )
    ),
  },
  "between-tool-and-result": {
    script: 'tool mark {"label":"m1"}; text 20',
    expect: { marks: ["m1"], userEntries: 1 },
    run: killWhen("mark's effect", ({ brain }) =>
      Effect.sync(() => (effectCounts(brain).get("m1") ?? 0) >= 1)
    ),
  },
  "mid-commit": {
    script: "text 20",
    env: { CAIRN_JUDGE_HOLD_PROJECTOR_MS: "5000" },
    expect: { marks: [], userEntries: 2 },
    run: (context) =>
      Effect.gen(function* () {
        yield* Events.waitFor(
          context.brain.events,
          "projector_holding",
          Events.named("projector_holding"),
          { timeout: "60 seconds" }
        );

        const committed = entriesOf(yield* viewOf(context.follower));
        const restart = yield* crash(context.brain);

        const port = yield* measureRestart(
          context.brain,
          restart,
          context.threadId,
          context.follower,
          context.measures
        );

        // The shell never committed the run's end; the boot reconcile must have.
        yield* until(
          "the boot reconcile to end the run in the shell",
          Effect.map(rowOf(context.follower, context.threadId), isQuiet),
          `${CONVERGE_MS} millis`
        );

        // A second turn, so the view moves on after the restart too.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(port);

            yield* client["thread.send"]({
              threadId: context.threadId,
              input: {
                requestId: yield* newRequestId,
                text: `${SCRIPT_PREFIX} text 5`,
                attachments: [],
                skillRefs: [],
              },
              whenBusy: "followUp",
            }).pipe(
              Effect.mapError(
                (error) =>
                  new WindowFailed({
                    message: `thread.send after the restart failed: ${String(error)}`,
                  })
              )
            );
          })
        );

        return { port, committed };
      }),
  },
  "send-in-flight": {
    script: "text 5",
    expect: { marks: ["in-flight"], userEntries: 2 },
    run: (context) =>
      Effect.gen(function* () {
        yield* until(
          "the first turn to end",
          Effect.map(rowOf(context.follower, context.threadId), isQuiet),
          QUIET_TIMEOUT
        );

        const committed = entriesOf(yield* viewOf(context.follower));

        const send = {
          threadId: context.threadId,
          input: {
            requestId: yield* newRequestId,
            text: `${SCRIPT_PREFIX} tool mark {"label":"in-flight"}; text 5`,
            attachments: [],
            skillRefs: [],
          },
          whenBusy: "followUp" as const,
        };

        // The send and the kill race; the client never sees an answer.
        yield* context.client["thread.send"](send).pipe(
          Effect.ignore,
          Effect.forkDetach
        );

        const restart = yield* crash(context.brain);

        const port = yield* measureRestart(
          context.brain,
          restart,
          context.threadId,
          context.follower,
          context.measures
        );

        // The outbox resends with the same request id.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(port);

            yield* client["thread.send"](send).pipe(
              Effect.mapError(
                (error) =>
                  new WindowFailed({
                    message: `the resent thread.send failed: ${String(error)}`,
                  })
              )
            );
          })
        );

        return { port, committed };
      }),
  },
  "during-launch": {
    script: 'tool mark {"label":"launch"}; text 5',
    worktree: true,
    expect: { marks: ["launch"], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
        // `started` is the launch itself, raced by this kill once its first steps have begun.
        yield* Effect.sleep("50 millis");

        const restart = yield* crash(context.brain);

        yield* Fiber.interrupt(context.started);

        const port = yield* measureRestart(
          context.brain,
          restart,
          context.threadId,
          context.follower,
          context.measures
        );

        return { port, committed: [] };
      }),
  },
  "kill-six": {
    script: 'tool slow {"ms":30000}; tool mark {"label":"six"}; text 5',
    expect: { marks: ["six"], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
        let { port } = context;
        let committed: ReadonlyArray<Entry> = [];

        for (let kill = 1; kill <= 5; kill += 1) {
          yield* until(
            "slow to run",
            Effect.map(viewOf(context.follower), (view) =>
              toolPending(entriesOf(view), "slow")
            ),
            "60 seconds"
          );

          // Give the resumed tool a moment to be running again before the next crash.
          yield* Effect.sleep(kill === 1 ? "300 millis" : "1500 millis");

          committed = entriesOf(yield* viewOf(context.follower));

          const restart = yield* crash(context.brain);

          port = yield* measureRestart(
            context.brain,
            restart,
            context.threadId,
            context.follower,
            context.measures
          );
        }

        // Five crashes in a row without new state park the tool: the shell lists it with Retry.
        const parked = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(port);
            const watcher = yield* makeFollower;

            yield* follow(client, context.threadId, watcher, false);

            yield* until(
              "the parked task in the shell",
              Effect.map(rowOf(watcher, context.threadId), (row) =>
                Option.exists(row, (thread) => thread.parkedTaskIds.length > 0)
              ),
              "20 seconds"
            );

            const row = yield* rowOf(watcher, context.threadId);

            const tasks = Option.match(row, {
              onNone: (): ReadonlyArray<TaskId> => [],
              onSome: (thread) => thread.parkedTaskIds,
            });

            for (const taskId of tasks) {
              yield* client["thread.retryTask"]({
                threadId: context.threadId,
                taskId,
              }).pipe(
                Effect.mapError(
                  (error) =>
                    new WindowFailed({
                      message: `thread.retryTask ${taskId} failed: ${String(error)}`,
                    })
                )
              );
            }

            return tasks.length;
          })
        );

        context.measures.notes.push(`parked ${parked} tasks, retried each`);

        return { port, committed };
      }),
  },
  "stubborn-control": {
    script: 'tool stubborn {"ms":20000}; text 5',
    properties: { TimeoutStopSec: "3" },
    expect: { marks: [], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
        yield* until(
          "stubborn to run",
          Effect.map(viewOf(context.follower), (view) =>
            toolPending(entriesOf(view), "stubborn")
          ),
          "60 seconds"
        );
        yield* Effect.sleep("500 millis");

        const committed = entriesOf(yield* viewOf(context.follower));
        const restart = yield* cleanRestart(context.brain);

        const port = yield* measureRestart(
          context.brain,
          restart,
          context.threadId,
          context.follower,
          context.measures
        );

        context.measures.notes.push(
          `restart took ${Math.round(context.measures.killToUp.at(-1) ?? 0)} ms`
        );

        return { port, committed };
      }),
  },
  "sigterm-six": {
    script: 'tool slow {"ms":8000}; tool mark {"label":"term"}; text 5',
    expect: { marks: ["term"], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
        let { port } = context;
        let committed: ReadonlyArray<Entry> = [];
        const restartsBefore = yield* Unit.restarts(context.brain.unit);

        for (let restartCount = 1; restartCount <= 6; restartCount += 1) {
          yield* until(
            "slow to run",
            Effect.map(viewOf(context.follower), (view) =>
              toolPending(entriesOf(view), "slow")
            ),
            "60 seconds"
          );
          yield* Effect.sleep("500 millis");

          committed = entriesOf(yield* viewOf(context.follower));

          const restart = yield* cleanRestart(context.brain);

          port = yield* measureRestart(
            context.brain,
            restart,
            context.threadId,
            context.follower,
            context.measures
          );
        }

        const restartsAfter = yield* Unit.restarts(context.brain.unit);

        if (restartsAfter !== restartsBefore) {
          return yield* fail(
            `NRestarts went from ${restartsBefore} to ${restartsAfter}: a clean restart counted as a crash`
          );
        }

        const parkedRow = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(port);
            const watcher = yield* makeFollower;

            yield* follow(client, context.threadId, watcher, false);
            yield* until(
              "the shell after the restarts",
              Effect.map(rowOf(watcher, context.threadId), Option.isSome),
              "10 seconds"
            );

            return yield* rowOf(watcher, context.threadId);
          })
        );

        if (
          Option.exists(parkedRow, (thread) => thread.parkedTaskIds.length > 0)
        ) {
          return yield* fail("a clean restart parked a task");
        }

        context.measures.notes.push("six clean restarts parked nothing");

        return { port, committed };
      }),
  },
};

const initRepo = (folder: string) => {
  const git = (...args: Array<string>) =>
    execFileSync("git", ["-C", folder, ...args], { stdio: "ignore" });

  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=Cairn judge",
    "-c",
    "user.email=judge@cairn.test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "start"
  );
};

const runWindow = (window: KillWindow) => {
  // Kept outside the effect, so a failed window still reports its unit, directory and timings.
  const where = { unit: "", dir: "" };
  const measures: Measures = { killToUp: [], upToConverged: [], notes: [] };

  return Effect.gen(function* () {
    const plan = plans[window];

    const { brain, port } = yield* startBrain(
      window,
      plan.env ?? {},
      plan.properties ?? {}
    );

    where.unit = brain.unit;
    where.dir = brain.dir;

    if (plan.worktree === true) {
      initRepo(brain.project);
    }

    const follower = yield* makeFollower;

    const before = yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* connect(port);

        const { threadId, input } = yield* launch(client, brain, plan.script, {
          worktree: plan.worktree === true,
        });

        const started = yield* client["thread.launch"](input).pipe(
          Effect.mapError(
            (error) =>
              new WindowFailed({
                message: `thread.launch failed: ${String(error)}`,
              })
          ),
          Effect.forkScoped
        );

        if (window !== "during-launch") {
          yield* Fiber.join(started);
        }

        yield* follow(client, threadId, follower, false);

        const result = yield* plan.run({
          brain,
          port,
          client,
          threadId,
          follower,
          measures,
          started,
        });

        return { ...result, threadId, input };
      })
    );

    if (window === "during-launch") {
      // The outbox resends the launch with the same command id.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connect(before.port);

          yield* client["thread.launch"](before.input).pipe(
            Effect.mapError(
              (error) =>
                new WindowFailed({
                  message: `the resent thread.launch failed: ${String(error)}`,
                })
            )
          );
        })
      );
    }

    const verdict = yield* judgeOutcome(
      brain,
      before.port,
      before.threadId,
      follower,
      before.committed,
      plan.expect,
      measures
    );

    return {
      window,
      unit: brain.unit,
      dir: brain.dir,
      pass: true,
      killToUp: measures.killToUp,
      upToConverged: measures.upToConverged,
      effects: verdict.effects,
      entries: verdict.entries,
      notes: measures.notes,
    };
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.succeed({
        window,
        unit: where.unit,
        dir: where.dir,
        pass: false,
        killToUp: measures.killToUp,
        upToConverged: measures.upToConverged,
        effects: {},
        entries: 0,
        notes: [
          ...measures.notes,
          Option.match(Cause.findErrorOption(cause), {
            onNone: () => Cause.pretty(cause),
            onSome: (error) =>
              Predicate.isTagged(error, "WindowFailed")
                ? error.message
                : String(error),
          }),
        ],
      })
    )
  );
};

/** One bridge window: `judges/claude-kill.ts` for its case, its JSON line reported as the window's. */
const runBridgeWindow = (window: BridgeWindow) =>
  Effect.sync(() => {
    const args = [
      path.join(REPO, "judges", "claude-kill.ts"),
      "--case",
      BRIDGE_WINDOWS[window],
      ...(values.keep ? ["--keep"] : []),
    ];

    const output = (() => {
      try {
        return execFileSync("node", args, {
          cwd: REPO,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "inherit"],
        });
      } catch (error) {
        const stdout: unknown = Predicate.hasProperty(error, "stdout")
          ? error.stdout
          : "";

        return Predicate.isString(stdout) ? stdout : "";
      }
    })();

    const line = output.split("\n").findLast((text) => text.startsWith("{"));

    const parsed: unknown = line === undefined ? {} : JSON.parse(line);

    const pass = Predicate.hasProperty(parsed, "pass") && parsed.pass === true;

    return { window, pass, killer: "judges/claude-kill.ts", result: parsed };
  });

const main = Effect.gen(function* () {
  let passed = 0;

  for (const window of chosen) {
    const result = isBridgeWindow(window)
      ? yield* runBridgeWindow(window)
      : yield* runWindow(window);

    passed += result.pass ? 1 : 0;
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }

  const failed = chosen.length - passed;

  process.stdout.write(
    `${JSON.stringify({ summary: true, sabotage, windows: chosen.length, passed, failed })}\n`
  );

  const ok = sabotage ? passed === 0 : failed === 0;

  if (!ok) {
    process.exitCode = 1;
  }
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
