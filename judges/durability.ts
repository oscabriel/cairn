// The durability judge (notes/edges.md, "Durability"): the real judge brain (`judge-main.ts`, the
// production composition with the judge tools) runs as a transient systemd user unit, and the
// judge kills its main process with `kill -9` (or restarts it with SIGTERM) at chosen points of a
// turn, then checks what survived.
//   node judges/durability.ts [--window <name>]... [--bridge] [--slow] [--runs N]
//                             [--sabotage skip-snapshot] [--no-page] [--model claude-haiku-5-5] [--keep]
//   node judges/durability.ts --unit cairn.service --window streaming
//
// `--unit` judges the deployed unit instead (plan 5F): one `kill -9` of its main pid while a reply
// streams, on the bridge's Haiku (production has no faux model), through `lib/DeployedUnit.ts`.
//
// Faux windows (the scripted faux model, the default set): streaming (after the 5th partial of a
// long reply), mid-tool (while `slow` runs), between-tool-and-result (right after `mark` wrote its
// effect, before its result commits), approval-parked (while `gate` waits for an approval; the
// judge accepts it through `thread.respond` after the restart), mid-commit (after pi-durable
// committed a run's end and before the shell row did, held by `CAIRN_JUDGE_HOLD_PROJECTOR_MS`),
// send-in-flight (the kill lands before `thread.send` answers; the client resends the same request
// id), mid-upload (the kill lands while a 20 MB upload streams to its `.part` file; the client
// retries with a new signed URL and sends the turn), during-launch (the kill lands inside
// `thread.launch`; the client resends the same command id), kill-six (five kills while `slow` runs
// park its tasks, then `thread.retryTask` finishes the turn), sigterm-six (six clean restarts while
// `slow` runs park nothing).
//
// Bridge windows (`--bridge`, the real Claude bridge on Haiku through `judge-main.ts --models real`,
// a few cents each, never run by default): bridge-streaming (`kill -9` while Claude's reply
// streams), bridge-tool-parked (while a `bash` call is held in the bridge), bridge-answer (after
// the `bash` result is committed, while Claude writes its answer), bridge-approval-parked (while
// `gate` waits; accepted after the restart). They add J2's and J9's checks: the marker or `mark`
// effect exactly once, an interrupted result for the parked `bash` call, every `claude` child of the
// killed brain gone within 2 s and none outside the unit's cgroup, the first reply after the restart
// keeping the prompt cache (`cacheRead > 0` and `cacheRead >= 10 * cacheWrite`), and, last, a clean
// restart and a stop with the thread's child alive that leave no `claude` outside the cgroup.
// `judges/claude-kill.sh` runs the first three by their J2 names. The
// brain uses the real home (Claude Code's login, pi's models, read only) and a scratch folder under
// `~/cairn-judges`, removed afterwards with the transcripts Claude Code wrote for it.
//
// `--slow` adds bridge-approval-slow (J14): `gate` is held for 20 minutes with no kill, then
// accepted; `mark` runs once, Claude's answer continues, and the stall watchdog never fired.
//
// Per window it asserts: every entry committed before the kill is still there; each `mark` label
// ran exactly once, or zero times with a result saying it "may have run"; the restarted brain's
// first thread snapshot reaches a reconnected Node client within 2 s of its socket opening; after
// the turn ends, the reconnected client's thread view and shell rows equal a fresh client's
// (exactly, by schema equivalence), and the shell row is idle; the expected number of user entries
// exists. Beside the Node client a Chromium page (`fixtures/durability/Page.ts`) follows the
// thread through every kill; it is read every 100 ms from the instant the brain goes quiet, and
// one of those reads within 2 s must equal a fresh page's timeline and thread rows (the same
// renderer, the same build), with no reload on the way. `--no-page` leaves the page out.
//
// `--sabotage skip-snapshot` makes the reconnecting Node client ignore the snapshot of each new
// subscription (and so the ops it cannot apply without one) and keep its pre-kill view, which is what a server that skipped the snapshot
// would leave it with; the page is left out. `--sabotage page-text` is the page's control: a stray
// word goes into the surviving page's timeline before each read after quiet. Either way every window must
// then fail; the judge exits 0 only if they all did.
//
// `--runs N` runs each chosen window N times; `fixtures/durability/nightly.sh` runs the matrix so.
//
// Prints one JSON line per window run: {window, run, pass, killToUp, upToConverged, page, effects,
// entries, checks, notes}, then a summary line.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  applyShellStreamItem,
  shellCursor,
} from "@cairn/client-logic/ShellReducer";
import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { AttachmentRef } from "@cairn/protocol/Attachments";
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
  Deferred,
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
import { chromium } from "playwright";
import type { Browser } from "playwright";

import { projectIdFor } from "../apps/server/src/shell/ShellCommands.ts";
import * as Page from "./fixtures/durability/Page.ts";
import * as Proxy from "./fixtures/durability/Proxy.ts";
import * as Upload from "./fixtures/durability/Upload.ts";
import { SCRIPT_PREFIX } from "./fixtures/JudgeModel.ts";
import * as DeployedUnit from "./lib/DeployedUnit.ts";
import * as Events from "./lib/Events.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";
import * as Unit from "./lib/Unit.ts";
import { buildWeb, freePort } from "./load.ts";

const WINDOWS = [
  "streaming",
  "mid-tool",
  "between-tool-and-result",
  "approval-parked",
  "mid-commit",
  "send-in-flight",
  "mid-upload",
  "during-launch",
  "kill-six",
  "sigterm-six",
] as const;

/**
 * The shutdown judge's control (`judges/shutdown.sh`), never run by default: a tool that ignores
 * its abort signal outlives a short `TimeoutStopSec`, so systemd must SIGKILL the brain.
 */
const CONTROL_WINDOWS = ["stubborn-control"] as const;

/** The windows on the real Claude bridge (`--bridge`). */
const BRIDGE_WINDOWS = [
  "bridge-streaming",
  "bridge-tool-parked",
  "bridge-answer",
  "bridge-approval-parked",
] as const;

/** J14's 20 minute held approval (`--slow`). */
const SLOW_WINDOWS = ["bridge-approval-slow"] as const;

type WindowName =
  | (typeof WINDOWS)[number]
  | (typeof CONTROL_WINDOWS)[number]
  | (typeof BRIDGE_WINDOWS)[number]
  | (typeof SLOW_WINDOWS)[number];

const ALL_WINDOWS: ReadonlyArray<WindowName> = [
  ...WINDOWS,
  ...CONTROL_WINDOWS,
  ...BRIDGE_WINDOWS,
  ...SLOW_WINDOWS,
];

const isWindow = (name: string): name is WindowName =>
  ALL_WINDOWS.some((window) => window === name);

const { values } = parseArgs({
  allowNegative: true,
  options: {
    window: { type: "string", multiple: true },
    sabotage: { type: "string" },
    keep: { type: "boolean", default: false },
    bridge: { type: "boolean", default: false },
    slow: { type: "boolean", default: false },
    runs: { type: "string", default: "1" },
    page: { type: "boolean", default: true },
    model: { type: "string", default: "claude-haiku-5-5" },
    unit: { type: "string" },
  },
});

const unknownWindows = (values.window ?? []).filter((name) => !isWindow(name));

const chosen: ReadonlyArray<WindowName> = [
  ...(values.window ?? (values.bridge || values.slow ? [] : [...WINDOWS])),
  ...(values.bridge ? BRIDGE_WINDOWS : []),
  ...(values.slow ? SLOW_WINDOWS : []),
].filter(isWindow);

const runs = Math.max(1, Math.trunc(Number(values.runs)) || 1);

const sabotage = values.sabotage === "skip-snapshot";

/** The page's control: its timeline gets a stray word before the comparison, which must fail. */
const sabotagePage = values.sabotage === "page-text";

/** The Chromium page follows every window unless `--no-page`, and never in a sabotaged run. */
const withPage = values.page && !sabotage;

const REPO = path.resolve(import.meta.dirname, "..");

const OWNER = "owner@loopback";

const CONVERGE_MS = 2000;

/** How long `connect` keeps trying a brain that is coming up. */
const CONNECT_DEADLINE_MS = 10_000;

const QUIET_TIMEOUT = Duration.seconds(120);

/** A bridge turn after a restart resumes Claude Code and may take a minute or more. */
const BRIDGE_QUIET_TIMEOUT = Duration.seconds(300);

const UP_TIMEOUT = Duration.seconds(60);

const MAY_HAVE_RUN = "may have run";

const USER_KINDS: ReadonlySet<string> = new Set(["pi.user", "cairn.user"]);

/** J14: how long the slow window holds the approval before accepting it. */
const SLOW_HOLD = Duration.minutes(20);

/** The `mid-upload` file: 20 MiB of text, paced so the upload lasts about three seconds. */
const UPLOAD_BYTES = 20 * 1024 * 1024;

const UPLOAD_PACING = { chunk: 256 * 1024, delayMs: 40 } as const;

/** A check of the judge did not hold; the window fails with its message. */
class WindowFailed extends Schema.TaggedError<WindowFailed>()("WindowFailed", {
  message: Schema.String,
}) {}

const fail = (message: string) => Effect.fail(new WindowFailed({ message }));

/** Runs a judge-side promise in a finalizer; a failure to close is not the window's. */
const quietly = (evaluate: () => Promise<void>) =>
  Effect.promise(async () => {
    try {
      await evaluate();
    } catch {
      // Closing anyway.
    }
  });

/** Runs a judge-side promise, turning a rejection into the window's failure. */
const attempt = <A>(what: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (error) =>
      new WindowFailed({
        message: `${what}: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

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
  readonly dataDir: string;
  /** The brain's own loopback port, the same after every restart. */
  readonly port: number;
  /** `CAIRN_ORIGIN`: the proxy in front of it, which the page loads. */
  readonly origin: string;
  readonly host: string;
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

const rmdirIfEmpty = (folder: string) => {
  try {
    rmdirSync(folder);
  } catch {
    // Another run still uses it.
  }
};

let unitCount = 0;

/**
 * Starts `judge-main.ts` as a transient unit in a fresh directory on a fixed loopback port and waits
 * until it is ready. A bridge brain runs `--models real` over the real home, with its project
 * under `~/cairn-judges` (FolderRules admits only folders under the home that are not hidden).
 */
const startBrain = (
  window: WindowName,
  plan: Plan,
  web: Option.Option<string>
) =>
  Effect.gen(function* () {
    const bridge = plan.bridge === true;
    const cache = path.join(os.homedir(), "cairn-judges");

    if (bridge) {
      mkdirSync(cache, { recursive: true });
    }

    const dir = mkdtempSync(
      path.join(bridge ? cache : os.tmpdir(), `cairn-durability-${window}-`)
    );

    const project = path.join(dir, "project");

    mkdirSync(project);
    unitCount += 1;

    const port = yield* attempt(
      "a free brain port",
      async () => await freePort()
    );

    const proxyPort = yield* attempt(
      "a free proxy port",
      async () => await freePort()
    );

    const origin = `http://127.0.0.1:${proxyPort}`;

    const brain: Brain = {
      unit: `cairn-judge-durability-${process.pid}-${unitCount}`,
      dir,
      events: path.join(dir, "events.log"),
      effects: path.join(dir, "effects.log"),
      project,
      dataDir: path.join(dir, "data"),
      port,
      origin,
      host: `127.0.0.1:${proxyPort}`,
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (!values.keep) {
          rmSync(dir, { recursive: true, force: true });

          if (bridge) {
            rmSync(
              path.join(
                os.homedir(),
                ".claude",
                "projects",
                project.replaceAll(/[/.]/gu, "-")
              ),
              { recursive: true, force: true }
            );
            rmdirIfEmpty(cache);
          }
        }
      })
    );

    yield* Unit.start({
      name: brain.unit,
      command: [
        process.execPath,
        "apps/server/src/judge-main.ts",
        ...(bridge ? ["--models", "real"] : []),
      ],
      cwd: REPO,
      properties: { ...Unit.brainProperties, ...plan.properties },
      env: {
        // A faux brain's home is the run's folder, so FolderRules admits the project beside it; a
        // bridge brain needs the real home for Claude Code's login.
        HOME: bridge ? os.homedir() : dir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CAIRN_PORT: String(port),
        CAIRN_ORIGIN: origin,
        CAIRN_OWNER: OWNER,
        CAIRN_DATA_DIR: brain.dataDir,
        CAIRN_CONFIG_DIR: path.join(dir, "config"),
        CAIRN_EVENTS_LOG: brain.events,
        CAIRN_JUDGE_EFFECTS_LOG: brain.effects,
        ...Option.match(web, {
          onNone: () => ({}),
          onSome: (root) => ({ CAIRN_WEB_ROOT: root }),
        }),
        ...plan.env,
      },
    });

    yield* waitUp(brain, 0);

    return { brain, proxyPort };
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
const connect = (brain: Brain) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;

    // Bounded by elapsed time, not tries: one try can take its open and hello timeouts (4 s).
    while ((yield* Clock.currentTimeMillis) - startedAt < CONNECT_DEADLINE_MS) {
      const scope = yield* Scope.make();

      const opened = yield* ProtocolClient.cairn({
        base: `http://127.0.0.1:${brain.port}`,
        origin: brain.origin,
        headers: { host: brain.host, "x-cairn-user": OWNER },
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

    const waited = (yield* Clock.currentTimeMillis) - startedAt;

    return yield* fail(
      `no socket to the brain on port ${brain.port} after ${waited} ms`
    );
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
 * Follows the thread and the shell on `client` for the scope's life. With `skipSnapshot` (a
 * reconnect in a sabotaged run) the subscription never gets its snapshot, as if the server had not
 * sent it, and with no base to apply them to, its ops are dropped too. (Dropping only the first
 * snapshot no longer fails every window: when the kill lands where the view and the store agree,
 * such as a pending tool call, the later ops happen to apply cleanly to the stale view, and the
 * windowed projector of wave 4 sends a fresh snapshot when the window moves.)
 */
const follow = (
  client: Client,
  threadId: ThreadId,
  follower: Follower,
  skipSnapshot: boolean
) =>
  Effect.gen(function* () {
    yield* Ref.set(follower.snapshotAt, Option.none());

    // Only reconnects pass `skipSnapshot`; a client with no view yet (the launch was the window)
    // has nothing to keep and gets nothing.
    const blind = skipSnapshot;

    yield* client["thread.subscribe"]({
      threadId,
      conversationId: Option.none(),
    }).pipe(
      Stream.runForEach((item) =>
        Effect.gen(function* () {
          const held = yield* Ref.get(follower.thread);

          if (blind) {
            return;
          }

          if (Predicate.isTagged(item, "Snapshot")) {
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

/** The approval the thread's row says is waiting, if any. */
const pendingApproval = (follower: Follower, threadId: ThreadId) =>
  Effect.map(rowOf(follower, threadId), (row) =>
    Option.map(
      Option.flatMap(row, (thread) => thread.pendingRuntimeRequest),
      (request) => request.id
    )
  );

/** Polls `check` every 50 ms until it holds, or fails after `timeout` with `what`. */
const until = <R>(
  what: string,
  check: Effect.Effect<boolean, WindowFailed, R>,
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

// What the bridge windows read: the reply's usage, the live partial, the marker and the children.

const ModelMessage = Schema.Struct({
  role: Schema.String,
  stopReason: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(
    Schema.Struct({ cacheRead: Schema.Finite, cacheWrite: Schema.Finite })
  ),
});

const decodeModel = Schema.decodeUnknownOption(ModelMessage);

const modelOf = (entry: Entry) => decodeModel(entry.model?.[0]);

/** An assistant entry that ended a model call (a final answer or a tool call). */
const isReply = (entry: Entry) =>
  entry.kind === "pi.assistant" &&
  Option.exists(
    modelOf(entry),
    (message) =>
      message.stopReason === "stop" || message.stopReason === "toolUse"
  );

const LiveDoc = Schema.Struct({
  generation: Schema.optionalKey(
    Schema.Struct({ message: Schema.optionalKey(PartsOf) })
  ),
});

const decodeLive = Schema.decodeUnknownOption(LiveDoc);

/** Characters of text in the reply pi-durable is streaming now (`pi.live`). */
const partialChars = (view: Option.Option<ConversationView>) =>
  Option.match(
    Option.flatMap(view, (found) => decodeLive(found.docs["pi.live"])),
    {
      onNone: () => 0,
      onSome: (live) =>
        (live.generation?.message?.content ?? [])
          .map((part) => part.text ?? "")
          .join("").length,
    }
  );

const markerLines = (marker: string) => {
  try {
    return readFileSync(marker, "utf-8")
      .split("\n")
      .filter((line) => line !== "").length;
  } catch {
    return 0;
  }
};

const CLAUDE_COMMAND = /(?:^|\/)claude(?:\s|$)/u;

/** The `claude` children in the unit's cgroup now. */
const claudeChildren = (unit: string) =>
  Effect.map(Unit.processes(unit), (all) =>
    all.filter(({ command }) => CLAUDE_COMMAND.test(command))
  );

/** Milliseconds until none of `pids` is alive, or none when some outlive `CONVERGE_MS * 5`. */
const goneWithin = (pids: ReadonlyArray<number>, from: number) =>
  Effect.gen(function* () {
    for (;;) {
      const alive = yield* Effect.forEach(pids, (pid) => Unit.commandOf(pid));
      const now = yield* Clock.currentTimeMillis;

      if (alive.every(Option.isNone)) {
        return Option.some(now - from);
      }

      if (now - from > CONVERGE_MS * 5) {
        return Option.none<number>();
      }

      yield* Effect.sleep("50 millis");
    }
  });

/** The ledger: 800 lines a model has no reason to read (about 22K tokens), as v1 built it. */
const ledger = Array.from(
  { length: 800 },
  (_, index) =>
    `Ledger line ${index}: account ${(index * 7919) % 10_007} moved ${(index * 104_729) % 9973} units to bin ${index % 97}.`
).join("\n");

const bridgeMessage = (task: string) =>
  `<ledger>\n${ledger}\n</ledger>\n\nIgnore the ledger. ${task}`;

const markerOf = (brain: Brain) => path.join(brain.project, "marker.txt");

// One turn's setup.

/** Registers the brain's project folder and launches a thread whose first message is the plan's. */
const launch = (client: Client, brain: Brain, plan: Plan) =>
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
      model:
        plan.bridge === true
          ? { provider: "claude-bridge", modelId: values.model }
          : { provider: "faux", modelId: "scripted" },
      thinkingLevel: "off" as const,
      runtimeMode: "full-access" as const,
      workspace:
        plan.worktree === true
          ? {
              _tag: "Worktree" as const,
              baseRef: "main",
              branch: Option.none(),
              startFromOrigin: false,
            }
          : { _tag: "Root" as const, branch: Option.none() },
      initialMessage: {
        requestId: yield* newRequestId,
        text: plan.message(brain),
        attachments: [],
        skillRefs: [],
      },
    };

    return { threadId, input };
  });

const script = (steps: string) => () => `${SCRIPT_PREFIX} ${steps}`;

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
  /** `mark` labels the turn calls; each must have run once (or "may have run" with none). */
  readonly marks: ReadonlyArray<string>;
  readonly userEntries: number;
}

/** A number a window reports beside its checks. */
type Reported =
  | number
  | null
  | { readonly cacheRead: number; readonly cacheWrite: number }
  | { readonly childrenBefore: number; readonly orphans: number };

interface Measures {
  readonly killToUp: Array<number>;
  readonly upToConverged: Array<number>;
  /** Per restart: the kill to the page's connection pill showing `Live` again. */
  readonly pageKillToLive: Array<number>;
  readonly notes: Array<string>;
  /** Named checks a window adds (the bridge's J2 and J9 checks); each must be true. */
  readonly checks: Record<string, boolean>;
  /** Numbers a window reports beside its checks. */
  readonly extra: Record<string, Reported>;
}

/**
 * After the last restart: reconnect, follow until the turn is quiet, then compare with a fresh
 * client and check effects, entries and the row. Answers the oracle's entries.
 */
const judgeOutcome = (
  brain: Brain,
  threadId: ThreadId,
  follower: Follower,
  committedBefore: ReadonlyArray<Entry>,
  plan: Plan,
  quiet: Deferred.Deferred<number>
) =>
  Effect.gen(function* () {
    const client = yield* connect(brain);

    yield* follow(client, threadId, follower, sabotage);

    yield* until(
      "the turn to end",
      Effect.map(rowOf(follower, threadId), isQuiet),
      plan.bridge === true ? BRIDGE_QUIET_TIMEOUT : QUIET_TIMEOUT
    );
    // The instant the brain went quiet; the page's 2 s are counted from here (`capturePage`).
    yield* Deferred.succeed(quiet, yield* Clock.currentTimeMillis);
    yield* Effect.sleep("300 millis");

    // The oracle: a fresh client's first thread snapshot and shell snapshot.
    const oracle = yield* makeFollower;

    yield* Effect.scoped(
      Effect.gen(function* () {
        const fresh = yield* connect(brain);

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

    for (const label of plan.expect.marks) {
      const count = counts.get(label) ?? 0;

      const ok =
        count === 1 ||
        (count === 0 && results.some((text) => text.includes(MAY_HAVE_RUN)));

      if (!ok) {
        return yield* fail(`mark ${label} ran ${count} times`);
      }
    }

    const users = userEntries(entries);

    if (users !== plan.expect.userEntries) {
      return yield* fail(
        `${users} user entries, expected ${plan.expect.userEntries}`
      );
    }

    return { effects: Object.fromEntries(counts), entries };
  }).pipe(Effect.scoped);

/** What the live page showed from the instant the brain went quiet. */
interface PageCapture {
  readonly quietAt: number;
  /** Each read and the instant it finished, 100 ms apart, until `CONVERGE_MS` after quiet. */
  readonly reads: ReadonlyArray<{
    readonly at: number;
    readonly text: Page.PageText;
  }>;
}

/**
 * Waits for `judgeOutcome` to say the brain is quiet, then reads the live page every 100 ms until
 * `CONVERGE_MS` have passed, so the page is judged against the moment the brain went quiet rather
 * than whenever the oracle page settled. Forked in the window's scope beside `judgeOutcome`.
 */
const capturePage = (
  page: Ref.Ref<Option.Option<Page.ThreadPage>>,
  quiet: Deferred.Deferred<number>
) =>
  Effect.gen(function* () {
    const quietAt = yield* Deferred.await(quiet);
    const live = yield* Ref.get(page);
    const reads: Array<PageCapture["reads"][number]> = [];

    if (Option.isNone(live)) {
      return { quietAt, reads };
    }

    while ((yield* Clock.currentTimeMillis) - quietAt < CONVERGE_MS) {
      if (sabotagePage) {
        yield* attempt("writing into the page", async () => {
          await Page.scribble(live.value);
        });
      }

      const text = yield* attempt(
        "reading the page",
        async () => await Page.read(live.value)
      );

      reads.push({ at: yield* Clock.currentTimeMillis, text });
      yield* Effect.sleep("100 millis");
    }

    return { quietAt, reads };
  });

/**
 * The page's verdict: a fresh page opened once the brain is quiet is the oracle, and the page that
 * lived through the kills must have shown the same timeline and rows within `CONVERGE_MS` of the
 * brain going quiet, without reloading. Answers the ms from quiet to the first equal read.
 */
const judgePage = (
  browser: Browser,
  brain: Brain,
  threadId: ThreadId,
  live: Page.ThreadPage,
  capture: PageCapture
) =>
  Effect.gen(function* () {
    const fresh = yield* attempt(
      "the oracle page",
      async () => await Page.openThread(browser, brain.origin, threadId)
    );

    yield* Effect.addFinalizer(() =>
      quietly(async () => {
        await Page.close(fresh);
      })
    );

    // The oracle settles: the same text twice, 500 ms apart.
    let oracle = yield* attempt(
      "reading the oracle page",
      async () => await Page.read(fresh)
    );

    for (let tries = 0; tries < 30; tries += 1) {
      yield* Effect.sleep("500 millis");

      const next = yield* attempt(
        "reading the oracle page",
        async () => await Page.read(fresh)
      );

      if (Page.same(next, oracle) && oracle.timeline !== "") {
        break;
      }

      oracle = next;
    }

    const equal = capture.reads.find(
      ({ at, text }) =>
        at - capture.quietAt <= CONVERGE_MS && Page.same(text, oracle)
    );

    if (equal === undefined) {
      const last = capture.reads.at(-1);

      return yield* fail(
        last === undefined
          ? "the page was never read after the brain went quiet"
          : `the page did not equal a fresh page within ${CONVERGE_MS} ms of quiet: ${Page.firstDifference(last.text, oracle)}`
      );
    }

    if (live.reloads.length > 0) {
      return yield* fail(
        `the page reloaded ${live.reloads.length} times instead of reconnecting`
      );
    }

    if (live.errors.length > 0) {
      return yield* fail(`the page raised: ${live.errors.join("; ")}`);
    }

    return {
      ms: equal.at - capture.quietAt,
      timelineChars: oracle.timeline.length,
      rows: oracle.rows.length,
    };
  }).pipe(Effect.scoped);

/**
 * Records kill-to-up and up-to-snapshot for one restart, from a client that reconnects at once and
 * keeps following in the caller's scope; with a page, also the kill to its pill showing `Live`.
 */
const measureRestart = (
  context: RunContext,
  restart: { readonly from: number; readonly at: number }
) =>
  Effect.gen(function* () {
    const { brain, threadId, follower, measures } = context;

    yield* waitUp(brain, restart.from);

    const client = yield* connect(brain);
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

    const page = yield* Ref.get(context.page);

    if (Option.isSome(page)) {
      // The kill closed the page's socket through the proxy at once, so `Live` here is the
      // reconnected socket; measured after the Node client's snapshot, so an upper bound.
      yield* until(
        "the page to be Live again",
        Effect.map(
          attempt(
            "the page's connection",
            async () => await Page.connection(page.value)
          ).pipe(Effect.orElseSucceed(() => "missing")),
          (state) => state === "Live"
        ),
        "15 seconds"
      );
      measures.pageKillToLive.push(
        (yield* Clock.currentTimeMillis) - restart.at
      );
    }

    return yield* Effect.void;
  });

// The windows.

interface RunContext {
  readonly brain: Brain;
  readonly client: Client;
  readonly threadId: ThreadId;
  readonly follower: Follower;
  readonly measures: Measures;
  readonly started: Fiber.Fiber<unknown, unknown>;
  /** The Chromium page following the thread, once it is open. */
  readonly page: Ref.Ref<Option.Option<Page.ThreadPage>>;
}

type RunError =
  | WindowFailed
  | Unit.UnitError
  | Events.EventsLogError
  | Events.EventTimeout;

type RunNeeds =
  | Scope.Scope
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem;

interface Plan {
  readonly env?: Readonly<Record<string, string>>;
  /** Unit properties over `Unit.brainProperties`. */
  readonly properties?: Readonly<Record<string, string>>;
  readonly expect: Expectation;
  readonly worktree?: boolean;
  /** Runs on the real Claude bridge (`judge-main.ts --models real`). */
  readonly bridge?: boolean;
  /** The thread's first message. */
  readonly message: (brain: Brain) => string;
  /** Drives the brain to the window and restarts it; answers what was committed before the kill. */
  readonly run: (
    context: RunContext
  ) => Effect.Effect<
    { readonly committed: ReadonlyArray<Entry> },
    RunError,
    RunNeeds
  >;
  /**
   * More checks once the turn is quiet, over the oracle's entries and what `run` said was committed
   * before the kill; recorded in `measures`.
   */
  readonly verdict?: (
    context: RunContext,
    entries: ReadonlyArray<Entry>,
    committed: ReadonlyArray<Entry>
  ) => Effect.Effect<void, RunError, RunNeeds>;
}

/** Kills once at the moment `aim` holds, and measures the restart. */
const killWhen =
  (
    what: string,
    aim: (context: RunContext) => Effect.Effect<boolean, WindowFailed>
  ) =>
  (context: RunContext) =>
    Effect.gen(function* () {
      yield* until(what, aim(context), "60 seconds");

      const committed = entriesOf(yield* viewOf(context.follower));
      const restart = yield* crash(context.brain);

      yield* measureRestart(context, restart);

      return { committed };
    });

/** The texts a `gate` result can carry. */
const GATE_RESULTS: ReadonlySet<string> = new Set([
  "accepted",
  "declined",
  "expired",
]);

/**
 * A `thread.respond` accept on a new client. The approval is read from that client's own first
 * shell snapshot, never the follower's view: after a restart the follower still holds the pre-kill
 * row, so only a fresh snapshot shows the approval waiting on the brain that is up now.
 */
const accept = (context: RunContext) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connect(context.brain);
      const watcher = yield* makeFollower;

      yield* follow(client, context.threadId, watcher, false);
      yield* until(
        "the approval to wait in a fresh client's shell",
        Effect.map(pendingApproval(watcher, context.threadId), Option.isSome),
        "60 seconds"
      );

      const approval = yield* pendingApproval(watcher, context.threadId);

      if (Option.isNone(approval)) {
        return yield* fail("no approval to answer");
      }

      return yield* client["thread.respond"]({
        threadId: context.threadId,
        approvalId: approval.value,
        decision: "accept",
      }).pipe(
        Effect.mapError(
          (error) =>
            new WindowFailed({
              message: `thread.respond failed: ${String(error)}`,
            })
        )
      );
    })
  );

/** The gate's result must read `accepted`, exactly once. */
const gateAccepted = (context: RunContext, entries: ReadonlyArray<Entry>) =>
  Effect.gen(function* () {
    const gates = resultTexts(entries).filter((text) => GATE_RESULTS.has(text));

    context.measures.checks.gateAcceptedOnce =
      gates.length === 1 && gates[0] === "accepted";

    if (!context.measures.checks.gateAcceptedOnce) {
      return yield* fail(`gate results: ${JSON.stringify(gates)}`);
    }

    return yield* Effect.void;
  });

/**
 * A bridge window's kill: `kill -9` with a `claude` child alive, then J9's checks (every child gone
 * within 2 s, none outside the unit's cgroup) and the restart measured. Records how many replies
 * were committed before it, for the cache check.
 */
const bridgeCrash = (context: RunContext) =>
  Effect.gen(function* () {
    const { brain, measures } = context;
    const children = yield* claudeChildren(brain.unit);

    if (children.length === 0) {
      return yield* fail("no claude child in the unit before the kill");
    }

    const committed = entriesOf(yield* viewOf(context.follower));
    const before = yield* Unit.snapshot(brain.unit);
    const restart = yield* crash(brain);

    const gone = yield* goneWithin(
      children.map(({ pid }) => pid),
      restart.at
    );

    yield* measureRestart(context, restart);

    const outside = yield* Unit.orphans(
      brain.unit,
      before.filter(({ command }) => CLAUDE_COMMAND.test(command))
    );

    measures.extra.childrenKilled = children.length;
    measures.extra.childrenGoneMs = Option.getOrNull(gone);
    measures.extra.repliesBefore = committed.filter(isReply).length;
    measures.checks.childrenGone = Option.exists(
      gone,
      (ms) => ms <= CONVERGE_MS
    );
    measures.checks.noOrphansAfterKill = outside.length === 0;

    return { committed };
  });

/** Runs `move` on the unit and counts the `claude` processes from before it left outside it. */
const orphansAfter = (
  unit: string,
  move: Effect.Effect<
    unknown,
    Unit.UnitError,
    ChildProcessSpawner.ChildProcessSpawner
  >
) =>
  Effect.gen(function* () {
    const before = yield* Unit.snapshot(unit);

    const children = before.filter(({ command }) =>
      CLAUDE_COMMAND.test(command)
    );

    yield* move;
    yield* Effect.sleep(Duration.millis(CONVERGE_MS));

    const left = yield* Unit.orphans(unit, children);

    return { childrenBefore: children.length, orphans: left.length };
  });

/**
 * J9's other two moves, at the end of a bridge run with the thread's `claude` child still held: a
 * clean restart, then a stop. Neither may leave a `claude` process outside the unit's cgroup.
 */
const j9Moves = (context: RunContext) =>
  Effect.gen(function* () {
    const { brain, measures } = context;
    const from = yield* Events.size(brain.events);

    const restartMove = yield* orphansAfter(
      brain.unit,
      Unit.restart(brain.unit)
    );

    yield* waitUp(brain, from).pipe(Effect.ignore);

    const stopMove = yield* orphansAfter(brain.unit, Unit.stop(brain.unit));

    measures.extra.restartMove = restartMove;
    measures.extra.stopMove = stopMove;
    measures.checks.noOrphansAfterRestart = restartMove.orphans === 0;
    measures.checks.noOrphansAfterStop = stopMove.orphans === 0;
  });

/**
 * J2: the first reply after the restart kept the prompt cache. That reply is the first one whose id
 * was not committed before the kill, so a follower that lagged the store cannot point it at a
 * pre-kill reply.
 */
const cacheKept = (
  context: RunContext,
  entries: ReadonlyArray<Entry>,
  committed: ReadonlyArray<Entry>
) =>
  Effect.sync(() => {
    const before = new Set(committed.map((entry) => entry.id));

    const usage = Option.flatMap(
      Option.fromUndefinedOr(
        entries.find((entry) => isReply(entry) && !before.has(entry.id))
      ),
      (entry) =>
        Option.flatMap(modelOf(entry), (message) =>
          Option.fromUndefinedOr(message.usage)
        )
    );

    context.measures.extra.firstReplyAfterRestart = Option.getOrNull(usage);
    context.measures.checks.cacheKept = Option.exists(
      usage,
      (found) => found.cacheRead > 0 && found.cacheRead >= 10 * found.cacheWrite
    );
  });

const markerOnce = (context: RunContext) =>
  Effect.sync(() => {
    const lines = markerLines(markerOf(context.brain));

    context.measures.extra.marker = lines;
    context.measures.checks.markerOnce = lines === 1;
  });

/** The stall watchdog never fired (J14). */
const noWatchdog = (context: RunContext) =>
  Effect.gen(function* () {
    const events = yield* Events.read(context.brain.events);

    const stalled = events.filter(Events.named("claude child stalled")).length;

    context.measures.extra.watchdogFires = stalled;
    context.measures.checks.noWatchdog = stalled === 0;
  });

const GATE_TASK =
  'Call the gate tool once with summary "durability". After it returns, call the mark tool once with label "gated". Never call either tool a second time, even after an error or an interruption. Then answer with the single word done.';

const plans: Readonly<Record<WindowName, Plan>> = {
  streaming: {
    message: script("text 600"),
    expect: { marks: [], userEntries: 1 },
    run: killWhen("the 5th partial", ({ follower }) =>
      Effect.map(Ref.get(follower.ops), (ops) => ops >= 5)
    ),
  },
  "mid-tool": {
    message: script(
      'tool slow {"ms":4000}; tool mark {"label":"after-slow"}; text 20'
    ),
    expect: { marks: ["after-slow"], userEntries: 1 },
    run: killWhen("slow to start", ({ follower }) =>
      Effect.map(viewOf(follower), (view) =>
        toolPending(entriesOf(view), "slow")
      )
    ),
  },
  "between-tool-and-result": {
    message: script('tool mark {"label":"m1"}; text 20'),
    expect: { marks: ["m1"], userEntries: 1 },
    run: killWhen("mark's effect", ({ brain }) =>
      Effect.sync(() => (effectCounts(brain).get("m1") ?? 0) >= 1)
    ),
  },
  "approval-parked": {
    message: script(
      'tool gate {"summary":"durability"}; tool mark {"label":"gated"}; text 5'
    ),
    expect: { marks: ["gated"], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
        yield* until(
          "the gate's approval",
          Effect.map(
            pendingApproval(context.follower, context.threadId),
            Option.isSome
          ),
          "60 seconds"
        );
        yield* Effect.sleep("300 millis");

        const committed = entriesOf(yield* viewOf(context.follower));
        const restart = yield* crash(context.brain);

        yield* measureRestart(context, restart);
        yield* accept(context);

        return { committed };
      }),
    verdict: gateAccepted,
  },
  "mid-commit": {
    message: script("text 20"),
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

        yield* measureRestart(context, restart);

        // The shell never committed the run's end; the boot reconcile must have.
        yield* until(
          "the boot reconcile to end the run in the shell",
          Effect.map(rowOf(context.follower, context.threadId), isQuiet),
          `${CONVERGE_MS} millis`
        );

        // A second turn, so the view moves on after the restart too.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(context.brain);

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

        return { committed };
      }),
  },
  "send-in-flight": {
    message: script("text 5"),
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

        yield* measureRestart(context, restart);

        // The outbox resends with the same request id.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(context.brain);

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

        // The first turn's quiet row must not be read as the resent turn's end.
        yield* until(
          "the resent message to reach the follower",
          Effect.map(
            viewOf(context.follower),
            (view) => userEntries(entriesOf(view)) >= 2
          ),
          QUIET_TIMEOUT
        );

        return { committed };
      }),
  },
  "mid-upload": {
    message: script("text 5"),
    expect: { marks: [], userEntries: 2 },
    run: (context) =>
      Effect.gen(function* () {
        const { brain, measures } = context;

        yield* until(
          "the first turn to end",
          Effect.map(rowOf(context.follower, context.threadId), isQuiet),
          QUIET_TIMEOUT
        );

        const committed = entriesOf(yield* viewOf(context.follower));

        const bytes = new Uint8Array(
          Buffer.alloc(UPLOAD_BYTES, "durability upload line\n")
        );

        const sha256 = createHash("sha256").update(bytes).digest("hex");

        const file = {
          name: "durability.txt",
          mimeType: "text/plain",
          sizeBytes: bytes.byteLength,
        };

        const target = (port: number, uploadPath: string) => ({
          port,
          path: uploadPath,
          host: brain.host,
          origin: brain.origin,
          owner: OWNER,
          mimeType: file.mimeType,
        });

        const signed = yield* context.client["attachments.createUploadUrl"](
          file
        ).pipe(
          Effect.mapError(
            (error) =>
              new WindowFailed({
                message: `attachments.createUploadUrl failed: ${String(error)}`,
              })
          )
        );

        const first = yield* Effect.promise(
          async () =>
            await Upload.post(
              target(brain.port, signed.uploadPath),
              bytes,
              UPLOAD_PACING
            )
        ).pipe(Effect.forkScoped);

        const tmp = path.join(brain.dataDir, "attachments", ".tmp");

        const parts = () =>
          existsSync(tmp)
            ? readdirSync(tmp).filter((name) => name.endsWith(".part"))
            : [];

        const partBytes = () =>
          parts().reduce(
            (sum, name) => sum + statSync(path.join(tmp, name)).size,
            0
          );

        // Aim: a quarter of the file is in the `.part` file.
        yield* until(
          "the upload's .part file",
          Effect.sync(() => {
            try {
              return partBytes() >= UPLOAD_BYTES / 4;
            } catch {
              return false;
            }
          }),
          "30 seconds"
        );

        measures.extra.partBytesAtKill = partBytes();

        const restart = yield* crash(brain);

        yield* measureRestart(context, restart);

        const broken = yield* Fiber.join(first);

        measures.extra.firstUpload = broken.status;

        if (broken.status === 200) {
          return yield* fail("the upload the kill broke still answered 200");
        }

        const left = parts();

        measures.checks.noPartLeft = left.length === 0;

        if (left.length > 0) {
          return yield* fail(
            `${left.length} .part files left after the restart`
          );
        }

        // The client's retry: a new signed URL, the same file, then the turn that carries it.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(brain);

            const again = yield* client["attachments.createUploadUrl"](
              file
            ).pipe(
              Effect.mapError(
                (error) =>
                  new WindowFailed({
                    message: `the retry's createUploadUrl failed: ${String(error)}`,
                  })
              )
            );

            const answer = yield* Effect.promise(
              async () =>
                await Upload.post(target(brain.port, again.uploadPath), bytes, {
                  chunk: 1024 * 1024,
                  delayMs: 0,
                })
            );

            const ref = Schema.decodeOption(
              Schema.fromJsonString(AttachmentRef)
            )(answer.body);

            if (answer.status !== 200 || Option.isNone(ref)) {
              return yield* fail(
                `the retried upload answered ${answer.status}: ${answer.body.slice(0, 200)}`
              );
            }

            measures.checks.retrySucceeded = ref.value.sha256 === sha256;

            if (!measures.checks.retrySucceeded) {
              return yield* fail("the retried upload's sha256 differs");
            }

            yield* client["thread.send"]({
              threadId: context.threadId,
              input: {
                requestId: yield* newRequestId,
                // Not a script: the attachment's text follows the message, so the faux model
                // answers its plain `ok`.
                text: "Here is the uploaded file.",
                attachments: [ref.value.id],
                skillRefs: [],
              },
              whenBusy: "followUp",
            }).pipe(
              Effect.mapError(
                (error) =>
                  new WindowFailed({
                    message: `thread.send with the upload failed: ${String(error)}`,
                  })
              )
            );

            return yield* Effect.void;
          })
        );

        return { committed };
      }),
  },
  "during-launch": {
    message: script('tool mark {"label":"launch"}; text 5'),
    worktree: true,
    expect: { marks: ["launch"], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
        // `started` is the launch itself, raced by this kill once its first steps have begun.
        yield* Effect.sleep("50 millis");

        const restart = yield* crash(context.brain);

        yield* Fiber.interrupt(context.started);
        yield* measureRestart(context, restart);

        return { committed: [] };
      }),
  },
  "kill-six": {
    message: script(
      'tool slow {"ms":30000}; tool mark {"label":"six"}; text 5'
    ),
    expect: { marks: ["six"], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
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

          yield* measureRestart(context, restart);
        }

        // Five crashes in a row without new state park the tool: the shell lists it with Retry.
        const parked = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(context.brain);
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

        return { committed };
      }),
  },
  "stubborn-control": {
    message: script('tool stubborn {"ms":20000}; text 5'),
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

        yield* measureRestart(context, restart);

        context.measures.notes.push(
          `restart took ${Math.round(context.measures.killToUp.at(-1) ?? 0)} ms`
        );

        return { committed };
      }),
  },
  "sigterm-six": {
    message: script(
      'tool slow {"ms":8000}; tool mark {"label":"term"}; text 5'
    ),
    expect: { marks: ["term"], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
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

          yield* measureRestart(context, restart);
        }

        const restartsAfter = yield* Unit.restarts(context.brain.unit);

        if (restartsAfter !== restartsBefore) {
          return yield* fail(
            `NRestarts went from ${restartsBefore} to ${restartsAfter}: a clean restart counted as a crash`
          );
        }

        const parkedRow = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(context.brain);
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

        return { committed };
      }),
  },
  "bridge-streaming": {
    bridge: true,
    message: (brain) =>
      bridgeMessage(
        `First write the numbers from one to one hundred in words, one per line. Then use bash to run exactly this command, once: echo ran >> ${markerOf(brain)}. Never run it a second time. Then say done.`
      ),
    expect: { marks: [], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
        // Aim at a reply that is really streaming: text in `pi.live` from a live child, before the
        // command ran. Counting ops alone could fire before the child even started.
        yield* until(
          "Claude's reply to stream",
          Effect.gen(function* () {
            const chars = partialChars(yield* viewOf(context.follower));

            if (chars < 80 || markerLines(markerOf(context.brain)) > 0) {
              return false;
            }

            const children = yield* claudeChildren(context.brain.unit).pipe(
              Effect.orElseSucceed(() => [])
            );

            return children.length > 0;
          }),
          "180 seconds"
        );

        return yield* bridgeCrash(context);
      }),
    verdict: (context, entries, committed) =>
      Effect.gen(function* () {
        yield* markerOnce(context);
        yield* cacheKept(context, entries, committed);
      }),
  },
  "bridge-tool-parked": {
    bridge: true,
    message: (brain) =>
      bridgeMessage(
        `Use bash to run exactly this command, once, with a timeout of 120 seconds: echo ran >> ${markerOf(brain)} && sleep 40. Never run it a second time, even if it reports an error or an interruption. Then say in one sentence what happened.`
      ),
    expect: { marks: [], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
        yield* until(
          "the bash call to be held",
          Effect.gen(function* () {
            const entries = entriesOf(yield* viewOf(context.follower));

            return (
              markerLines(markerOf(context.brain)) > 0 &&
              !entries.some((entry) => entry.kind === "pi.tool-result")
            );
          }),
          "180 seconds"
        );
        yield* Effect.sleep("1 second");

        return yield* bridgeCrash(context);
      }),
    verdict: (context, entries, committed) =>
      Effect.gen(function* () {
        yield* markerOnce(context);
        yield* cacheKept(context, entries, committed);
        context.measures.checks.interruptedResult = resultTexts(entries).some(
          (text) => /interrupted/iu.test(text)
        );
      }),
  },
  "bridge-answer": {
    bridge: true,
    message: (brain) =>
      bridgeMessage(
        `Use bash to run exactly this command, once: echo ran >> ${markerOf(brain)}. Never run it a second time. Then write the numbers from one to two hundred in words, one per line.`
      ),
    expect: { marks: [], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
        // Aim after the command's result is committed, while Claude writes its answer.
        yield* until(
          "the answer after the bash result",
          Effect.gen(function* () {
            const entries = entriesOf(yield* viewOf(context.follower));

            return (
              markerLines(markerOf(context.brain)) > 0 &&
              entries.some((entry) => entry.kind === "pi.tool-result")
            );
          }),
          "180 seconds"
        );

        return yield* bridgeCrash(context);
      }),
    verdict: (context, entries, committed) =>
      Effect.gen(function* () {
        yield* markerOnce(context);
        yield* cacheKept(context, entries, committed);
      }),
  },
  "bridge-approval-parked": {
    bridge: true,
    message: () => bridgeMessage(GATE_TASK),
    expect: { marks: ["gated"], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
        yield* until(
          "the gate's approval",
          Effect.map(
            pendingApproval(context.follower, context.threadId),
            Option.isSome
          ),
          "180 seconds"
        );
        yield* Effect.sleep("1 second");

        const result = yield* bridgeCrash(context);

        yield* accept(context);

        return result;
      }),
    verdict: (context, entries, committed) =>
      Effect.gen(function* () {
        yield* gateAccepted(context, entries);
        yield* cacheKept(context, entries, committed);
        context.measures.checks.markOnce =
          (effectCounts(context.brain).get("gated") ?? 0) === 1;
      }),
  },
  "bridge-approval-slow": {
    bridge: true,
    message: () => bridgeMessage(GATE_TASK),
    expect: { marks: ["gated"], userEntries: 1 },
    run: (context) =>
      Effect.gen(function* () {
        yield* until(
          "the gate's approval",
          Effect.map(
            pendingApproval(context.follower, context.threadId),
            Option.isSome
          ),
          "180 seconds"
        );

        const committed = entriesOf(yield* viewOf(context.follower));
        const heldFrom = yield* Clock.currentTimeMillis;

        yield* Effect.sleep(SLOW_HOLD);

        const children = yield* claudeChildren(context.brain.unit);

        context.measures.extra.heldMs =
          (yield* Clock.currentTimeMillis) - heldFrom;
        context.measures.extra.claudeChildrenWhileHeld = children.length;

        yield* accept(context);

        return { committed };
      }),
    verdict: (context, entries) =>
      Effect.gen(function* () {
        yield* gateAccepted(context, entries);
        yield* noWatchdog(context);
        context.measures.checks.markOnce =
          (effectCounts(context.brain).get("gated") ?? 0) === 1;

        // Claude's answer came after the gate's result, not before it.
        const gateAt = entries.findIndex(
          (entry) =>
            entry.kind === "pi.tool-result" &&
            partsOf(entry).some((part) => GATE_RESULTS.has(part.text ?? ""))
        );

        const answered = entries.some(
          (entry, index) =>
            gateAt !== -1 &&
            index > gateAt &&
            entry.kind === "pi.assistant" &&
            Option.exists(
              modelOf(entry),
              (message) => message.stopReason === "stop"
            )
        );

        context.measures.checks.answerContinued = answered;
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

/** The page and the web build every window of this run shares. */
interface Shared {
  readonly browser: Option.Option<Browser>;
  readonly web: Option.Option<string>;
}

/** Opens the Chromium page on the thread behind a proxy that lives as long as the window. */
const openPage = (
  shared: Shared,
  brain: Brain,
  proxyPort: number,
  threadId: ThreadId,
  page: Ref.Ref<Option.Option<Page.ThreadPage>>
) =>
  Effect.gen(function* () {
    if (Option.isNone(shared.browser)) {
      return;
    }

    const browser = shared.browser.value;

    const proxy = yield* attempt(
      "the page's proxy",
      async () => await Proxy.startProxy(proxyPort, brain.port, OWNER)
    );

    yield* Effect.addFinalizer(() =>
      quietly(async () => {
        await proxy.close();
      })
    );

    const opened = yield* attempt(
      "the thread page",
      async () => await Page.openThread(browser, brain.origin, threadId)
    );

    yield* Effect.addFinalizer(() =>
      quietly(async () => {
        await Page.close(opened);
      })
    );

    yield* Ref.set(page, Option.some(opened));
  });

const runWindow = (window: WindowName, run: number, shared: Shared) => {
  // Kept outside the effect, so a failed window still reports its unit, directory and timings.
  const where = { unit: "", dir: "" };

  const measures: Measures = {
    killToUp: [],
    upToConverged: [],
    pageKillToLive: [],
    notes: [],
    checks: {},
    extra: {},
  };

  const pageResult = { convergedMs: Option.none<number>() };

  return Effect.gen(function* () {
    const plan = plans[window];

    const { brain, proxyPort } = yield* startBrain(window, plan, shared.web);

    where.unit = brain.unit;
    where.dir = brain.dir;

    if (plan.worktree === true) {
      initRepo(brain.project);
    }

    const follower = yield* makeFollower;
    const page = yield* Ref.make(Option.none<Page.ThreadPage>());

    // The page lives for the whole window; the clients below only until the last restart.
    const windowScope = yield* Scope.Scope;

    const before = yield* Effect.gen(function* () {
      const client = yield* connect(brain);

      const { threadId, input } = yield* launch(client, brain, plan);

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

      // The page follows the thread from the start, except while the launch itself is the window:
      // the thread does not exist until the launch is resent.
      if (window !== "during-launch") {
        yield* openPage(shared, brain, proxyPort, threadId, page).pipe(
          Scope.provide(windowScope)
        );
      }

      const context: RunContext = {
        brain,
        client,
        threadId,
        follower,
        measures,
        started,
        page,
      };

      const result = yield* plan.run(context);

      return { ...result, context, input };
    }).pipe(Effect.scoped);

    if (window === "during-launch") {
      // The outbox resends the launch with the same command id.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connect(brain);

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

      yield* openPage(shared, brain, proxyPort, before.context.threadId, page);
    }

    const quiet = yield* Deferred.make<number>();
    const captured = yield* capturePage(page, quiet).pipe(Effect.forkScoped);

    const verdict = yield* judgeOutcome(
      brain,
      before.context.threadId,
      follower,
      before.committed,
      plan,
      quiet
    );

    if (plan.verdict !== undefined) {
      yield* plan.verdict(before.context, verdict.entries, before.committed);
    }

    const failedChecks = Object.entries(measures.checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);

    if (failedChecks.length > 0) {
      return yield* fail(`checks failed: ${failedChecks.join(", ")}`);
    }

    const livePage = yield* Ref.get(page);

    if (Option.isSome(livePage) && Option.isSome(shared.browser)) {
      const shown = yield* judgePage(
        shared.browser.value,
        brain,
        before.context.threadId,
        livePage.value,
        yield* Fiber.join(captured)
      );

      pageResult.convergedMs = Option.some(shown.ms);
      measures.extra.pageTimelineChars = shown.timelineChars;
      measures.extra.pageRows = shown.rows;
    }

    // Last, as the stop ends the unit: J9's restart and stop with a live child.
    if (plan.bridge === true) {
      yield* j9Moves(before.context);

      const failedMoves = Object.entries(measures.checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);

      if (failedMoves.length > 0) {
        return yield* fail(`checks failed: ${failedMoves.join(", ")}`);
      }
    }

    return {
      window,
      run,
      unit: brain.unit,
      dir: brain.dir,
      pass: true,
      killToUp: measures.killToUp,
      upToConverged: measures.upToConverged,
      page: Option.isSome(livePage)
        ? {
            killToLive: measures.pageKillToLive,
            convergedMs: Option.getOrNull(pageResult.convergedMs),
          }
        : null,
      effects: verdict.effects,
      entries: verdict.entries.length,
      checks: measures.checks,
      ...measures.extra,
      notes: measures.notes,
    };
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.succeed({
        window,
        run,
        unit: where.unit,
        dir: where.dir,
        pass: false,
        killToUp: measures.killToUp,
        upToConverged: measures.upToConverged,
        page: withPage
          ? {
              killToLive: measures.pageKillToLive,
              convergedMs: Option.getOrNull(pageResult.convergedMs),
            }
          : null,
        effects: {},
        entries: 0,
        checks: measures.checks,
        ...measures.extra,
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

/** Builds the web app once and launches Chromium once, for every window of the run. */
const shared = Effect.gen(function* () {
  if (!withPage) {
    return { browser: Option.none(), web: Option.none() } satisfies Shared;
  }

  const web = mkdtempSync(path.join(os.tmpdir(), "cairn-durability-web-"));

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      rmSync(web, { recursive: true, force: true });
    })
  );

  yield* attempt("building the web app", async () => {
    await buildWeb(web);
  });

  const browser = yield* attempt(
    "launching Chromium",
    async () => await chromium.launch()
  );

  yield* Effect.addFinalizer(() =>
    quietly(async () => {
      await browser.close();
    })
  );

  return {
    browser: Option.some(browser),
    web: Option.some(web),
  } satisfies Shared;
});

const deployed = (unit: string) =>
  Effect.gen(function* () {
    if (chosen.length !== 1 || chosen[0] !== "streaming") {
      process.stderr.write("--unit runs only --window streaming.\n");
      process.exitCode = 2;

      return;
    }

    const result = yield* DeployedUnit.streaming({
      unit,
      model: `claude-bridge/${values.model}`,
      keep: values.keep,
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({ pass: false, notes: [error.message] })
      )
    );

    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.pass ? 0 : 1;
  });

const main = Effect.gen(function* () {
  if (values.unit !== undefined) {
    yield* deployed(values.unit);

    return;
  }

  if (unknownWindows.length > 0) {
    process.stderr.write(
      `Unknown windows: ${unknownWindows.join(", ")}. Known: ${ALL_WINDOWS.join(", ")}.\n`
    );
    process.exitCode = 2;

    return;
  }

  const context = yield* shared;
  let passed = 0;

  for (const window of chosen) {
    for (let run = 1; run <= runs; run += 1) {
      const result = yield* runWindow(window, run, context);

      passed += result.pass ? 1 : 0;
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }

  const total = chosen.length * runs;
  const failed = total - passed;

  process.stdout.write(
    `${JSON.stringify({ summary: true, sabotage: values.sabotage ?? null, windows: chosen.length, runs, total, passed, failed })}\n`
  );

  const ok = sabotage || sabotagePage ? passed === 0 : failed === 0;

  if (!ok) {
    process.exitCode = 1;
  }
}).pipe(Effect.scoped);

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
