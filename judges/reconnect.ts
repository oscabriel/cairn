/* oxlint-disable no-await-in-loop -- a judge drives one kill and restart after another, on purpose */
// The reconnect judge: the client must converge after its brain dies.
//
//   node judges/reconnect.ts [--rounds 5] [--budget-ms 2000] [--headed] [--broken threads]
//
// It starts a dev brain (apps/server/src/dev-main.ts) on an ephemeral loopback port with its own
// throwaway data directory, adds two folder projects and launches a project thread into the first,
// serves the client through Vite proxying to it by way of a gate this judge holds (a loopback TCP
// pipe that can refuse the page's new connections), opens the page in Chromium and waits for it to
// be Live. Then, each round, it `kill -9`s the brain, restarts it on the same port, and times the
// page's first shell frame that makes it current (a snapshot, or the marker that ends a replay)
// from the restarted brain's listening line. Between rounds, while the page is Live, it adds a
// project and launches its project thread through the protocol.
//
// Last comes the crossing, untimed: with the gate held it kills and restarts the brain once more,
// adds the project `last` and launches its project thread straight to the brain, waits until the
// turn of every thread it launched has ended, checks that the gate refused the page and that the
// page is still not Live, and only then opens the gate. So `last` and its project thread reach the
// page through its reconnect alone (the replay after its cursor, or a snapshot), and nothing is
// added after it.
//
// Passes when every round's first frame came within the budget, the page's final list (the rail's
// folder projects, the selected one and its project thread) equals a fresh snapshot from the brain,
// the project compared is `last`, and the page raised no error. The page sits on the hero, so its
// selected bubble must be the brain's most recently updated folder project (the hero's default),
// and that project's project thread must be a real thread on both sides. Prints one JSON line and
// exits 0 on a pass.
//
// Broken control, planted in the page by this judge (never in the app), which must make the list
// check fail:
//   threads  on every reconnect, the frames up to the one that makes the page current lose their
//            thread rows: the snapshot arrives with none and each replayed thread update removes
//            its row, as a shell reducer that drops thread rows on a replay would. Live updates
//            after it pass untouched, so only `last`'s project thread, which crossed the
//            reconnect, never reaches the sidebar.
// The control's run exits 1 when it failed rightly, with listMatches false in its JSON line.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer as createNetServer } from "node:net";
import type { Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { defaultProjectOf } from "@cairn/client-logic/ProjectThread";
import { CommandId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import type { ProjectId } from "@cairn/protocol/Ids";
import { RootWorkspace } from "@cairn/protocol/Launch";
import { CairnRpcs, PROTOCOL_VERSION } from "@cairn/protocol/Rpc";
import type { ShellSnapshot } from "@cairn/protocol/Shell";
import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import { NodeWS } from "@effect/platform-node";
import {
  Effect,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { RpcClientError } from "effect/rpc";
import { Socket } from "effect/socket";
import { createServer as createViteServer } from "vite";

import { FAUX_MODEL } from "../apps/server/src/brain/FauxModels.ts";
import { projectIdFor } from "../apps/server/src/shell/ShellCommands.ts";
import { chromium } from "./lib/Browser.ts";
import { recordOnExit } from "./lib/Record.ts";
import { endedRows, isSettled, SETTLED_READS } from "./lib/TurnsEnded.ts";

recordOnExit(import.meta);

const { values } = parseArgs({
  options: {
    rounds: { type: "string", default: "5" },
    "budget-ms": { type: "string", default: "2000" },
    headed: { type: "boolean", default: false },
    broken: { type: "string", default: "" },
  },
});

const BROKEN_CONTROLS = ["threads"] as const;

type Broken = (typeof BROKEN_CONTROLS)[number] | "";

const isBroken = (value: string): value is Broken =>
  value === "" || BROKEN_CONTROLS.some((control) => control === value);

if (!isBroken(values.broken)) {
  throw new Error(
    `--broken is one of ${BROKEN_CONTROLS.join(", ")}, not ${values.broken}`
  );
}

const broken: Broken = values.broken;

const rounds = Number(values.rounds);

const budgetMs = Number(values["budget-ms"]);

const root = path.join(import.meta.dirname, "..");

const LOOPBACK = "127.0.0.1";

const freePort = async (): Promise<number> => {
  const server = createNetServer().listen(0, LOOPBACK);

  await once(server, "listening");

  const address = server.address();

  server.close();
  await once(server, "close");

  if (address === null || Predicate.isString(address)) {
    throw new Error("judges/reconnect.ts: the kernel gave no loopback port.");
  }

  return address.port;
};

const brainPort = await freePort();

const vitePort = await freePort();

const origin = `http://${LOOPBACK}:${vitePort}`;

const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-reconnect-"));

const brainLog: Array<string> = [];

/** A ready brain and the time (ms since epoch) it said it listens. */
interface Brain {
  readonly process: ChildProcess;
  readonly listeningAt: number;
}

const isListeningLine = (line: string): boolean =>
  /listening\b/iu.test(line) && line.includes(`:${brainPort}`);

// Boot's last line (`Boot.ts`). The listener is up before boot ends and answers `/ws` with 503 until
// then, so the judge's own protocol client waits for it; the page's reconnect is still timed from
// the listening line.
const isReadyLine = (line: string): boolean => /^\s*event: ready$/u.test(line);

const startBrain = async (): Promise<Brain> => {
  const child = spawn(
    process.execPath,
    [path.join(root, "apps/server/src/dev-main.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        // The projects are temporary folders; FolderRules admits only folders under the home.
        HOME: tmpdir(),
        CAIRN_LISTEN_HOST: LOOPBACK,
        CAIRN_PORT: String(brainPort),
        CAIRN_ORIGIN: origin,
        CAIRN_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const listening = Promise.withResolvers<number>();

  const ready = Promise.withResolvers<true>();

  const onLine = (line: string) => {
    brainLog.push(line);

    if (isListeningLine(line)) {
      listening.resolve(Date.now());
    }

    if (isReadyLine(line)) {
      ready.resolve(true);
    }
  };

  createInterface({ input: child.stdout }).on("line", onLine);
  createInterface({ input: child.stderr }).on("line", onLine);
  child.once("exit", (code, signal) => {
    const exited = new Error(
      `judges/reconnect.ts: the brain exited (${String(code ?? signal)}) before it was ready. Last lines:\n${brainLog.slice(-20).join("\n")}`
    );

    listening.reject(exited);
    ready.reject(exited);
  });

  const listeningAt = await listening.promise;

  await ready.promise;

  return { process: child, listeningAt };
};

const killBrain = async (brain: Brain): Promise<void> => {
  if (brain.process.exitCode !== null || brain.process.signalCode !== null) {
    return;
  }

  const exited = once(brain.process, "exit");

  brain.process.kill("SIGKILL");
  await exited;
};

// The judge's own protocol client, straight to the brain with the page's Origin and Host (the guard
// answers any other Host with 421, as it would behind the Vite proxy, which keeps the page's Host).
const ProtocolLive = RpcClient.layerProtocolSocket({
  retryPolicy: Schedule.recurs(0),
}).pipe(
  Layer.provide(
    Socket.layerWebSocket(
      `ws://${LOOPBACK}:${brainPort}/ws?protocol=${PROTOCOL_VERSION}`,
      { headers: { origin, host: new URL(origin).host } }
    ).pipe(Layer.provide(NodeWS.layerWebSocketConstructor))
  ),
  Layer.provide(RpcSerialization.layerJson)
);

type Client = RpcClient.FromGroup<
  typeof CairnRpcs,
  RpcClientError.RpcClientError
>;

const withClient = async <A, E>(
  use: (client: Client) => Effect.Effect<A, E>
): Promise<A> => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(ProtocolLive);

        const client = yield* RpcClient.make(CairnRpcs).pipe(
          Effect.provide(context)
        );

        return yield* use(client);
      })
    )
  );

  return result;
};

/** A UUIDv7 as the client mints command ids: 48 bits of milliseconds, then random bits. */
const uuidv7 = (): string => {
  const time = Date.now().toString(16).padStart(12, "0");
  const random = randomBytes(10).toString("hex");
  const variant = "89ab".charAt(Number.parseInt(random.charAt(3), 16) % 4);

  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(8, 20)}`;
};

const decodeCommandId = Schema.decodeSync(CommandId);

const workspaces: Array<string> = [];

/** Adds a folder project named `name` over a new temporary folder; its id. */
const addProject = async (name: string): Promise<ProjectId> => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), `cairn-${name}-`));

  workspaces.push(workspaceRoot);

  const commandId = decodeCommandId(uuidv7());

  await withClient((client) =>
    client["shell.dispatch"](
      ProjectCreate.make({
        commandId,
        workspaceRoot,
        title: Option.some(name),
      })
    )
  );

  return projectIdFor(commandId);
};

/** Every thread this judge launched, whose turns must end before the brain counts as settled. */
const launched: Array<ThreadId> = [];

/** Launches the project's first top-level thread, which becomes its project thread (ADR 0048). */
const launchProjectThread = async (projectId: ProjectId, name: string) => {
  const threadId = ThreadId.make(uuidv7());

  launched.push(threadId);

  const result = await withClient((client) =>
    client["thread.launch"]({
      commandId: decodeCommandId(uuidv7()),
      threadId,
      projectId,
      title: Option.some(name),
      model: FAUX_MODEL,
      thinkingLevel: "off",
      runtimeMode: "full-access",
      workspace: RootWorkspace.make({ branch: Option.none() }),
      initialMessage: {
        requestId: RequestId.make(
          `req_reconnect_${randomBytes(8).toString("hex")}`
        ),
        text: `Hello from ${name}`,
        attachments: [],
        skillRefs: [],
      },
    })
  );

  return result;
};

/** The brain's own view of the shell: the snapshot a fresh subscription starts with. */
const brainShell = async () => {
  const result = await withClient((client) =>
    client["shell.subscribe"]({
      afterSequence: Option.none(),
      requestCompletionMarker: true,
    }).pipe(
      Stream.runHead,
      Effect.map(
        Option.flatMap((item): Option.Option<ShellSnapshot> =>
          Predicate.isTagged(item, "Snapshot")
            ? Option.some(item.snapshot)
            : Option.none()
        )
      )
    )
  );

  return result;
};

/**
 * The gate between Vite's proxy and the brain. Open, it pipes each connection through to the brain;
 * held, it closes each new one at once, as a brain still down would. Connections already through
 * stay until either side closes.
 */
const gate = { held: false, refused: 0 };

const gateSockets = new Set<NetSocket>();

const gateServer = createNetServer((page) => {
  if (gate.held) {
    gate.refused += 1;
    page.destroy();

    return;
  }

  const upstream = connect(brainPort, LOOPBACK);

  const close = () => {
    page.destroy();
    upstream.destroy();
    gateSockets.delete(page);
    gateSockets.delete(upstream);
  };

  gateSockets.add(page);
  gateSockets.add(upstream);
  page.on("error", close).on("close", close);
  upstream.on("error", close).on("close", close);
  page.pipe(upstream);
  upstream.pipe(page);
}).listen(0, LOOPBACK);

await once(gateServer, "listening");

const gateAddress = gateServer.address();

if (gateAddress === null || Predicate.isString(gateAddress)) {
  throw new Error("judges/reconnect.ts: the kernel gave the gate no port.");
}

let brain = await startBrain();

/**
 * Waits until the turn of every thread this judge launched has ended in the brain's shell, the
 * newest one idle, and `SETTLED_READS` reads in a row show the same rows (`lib/TurnsEnded.ts`), so no
 * live update for them follows what the page is about to read. The dev brain's demo thread keeps
 * moving the shell's sequence; its row is not read.
 */
const brainSettled = async (): Promise<void> => {
  const deadline = Date.now() + 30_000;
  let previous = Option.none<string>();
  let agreeing = 0;

  for (;;) {
    const snapshot = await brainShell();

    const current = Option.flatMap(snapshot, (shell) =>
      endedRows(shell, launched, launched.slice(-1))
    );

    agreeing = isSettled(previous, current) ? agreeing + 1 : 0;

    if (agreeing >= SETTLED_READS - 1) {
      return;
    }

    if (Date.now() > deadline) {
      const rows = Option.match(snapshot, {
        onNone: () => "no snapshot",
        onSome: (shell) =>
          JSON.stringify(
            shell.threads
              .filter((row) => launched.includes(row.id))
              .map((row) => ({
                title: row.title,
                activity: row.activity,
                completed: Option.isSome(row.latestRunCompletedAt),
              }))
          ),
      });

      throw new Error(
        `judges/reconnect.ts: the launched threads' turns never ended and held still: ${rows}`
      );
    }

    previous = current;
    await sleep(250);
  }
};

// A judge that throws must not leave its brain running: kill whichever brain is current on exit.
process.once("exit", () => {
  brain.process.kill("SIGKILL");
});

await launchProjectThread(await addProject("first"), "first");

await addProject("second");

// vite.config.ts reads this when Vite loads it, just below.
process.env.CAIRN_DEV_BRAIN = `http://${LOOPBACK}:${gateAddress.port}`;

const vite = await createViteServer({
  configFile: path.join(root, "apps/web/vite.config.ts"),
  root: path.join(root, "apps/web"),
  // The proxy reports every refused connection while the brain is down; the JSON line is the output.
  logLevel: "silent",
  server: { host: LOOPBACK, port: vitePort, strictPort: true },
});

await vite.listen();

const browser = await chromium.launch({ headless: !values.headed });

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// The plant. Page code, kept as text: it patches the browser's own WebSocket and MessageEvent,
// which this module's types cannot describe without casts. The page's first protocol socket reads
// the brain as sent; on every later one (each reconnect) the shell frames up to the first that makes
// the page current (a snapshot, or the marker that ends a replay) lose their thread rows, and every
// frame after it reads as sent. Updates are rewritten, not dropped: a plant that dropped them left
// the page never Live again, which fails the rounds and not the list check this control is for.
// Each event's rewrite is kept, so reading its data twice reads the same frame.
const PLANT_THREADS = `
  const Native = window.WebSocket;
  const replaying = new WeakSet();
  const rewritten = new WeakMap();
  let protocolSockets = 0;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      if (String(args[0]).includes("/ws?")) {
        protocolSockets += 1;
        if (protocolSockets > 1) replaying.add(this);
      }
    }
  };
  // Until the socket's replay ends, a snapshot loses its threads and a thread update becomes the
  // removal of its row at the same sequence.
  const withoutThreads = (socket, item) => {
    if (!replaying.has(socket) || item === null || typeof item !== "object") return item;
    if (item._tag === "Synchronized") {
      replaying.delete(socket);
      return item;
    }
    if (item._tag === "Snapshot" && Array.isArray(item.snapshot?.threads)) {
      replaying.delete(socket);
      return { ...item, snapshot: { ...item.snapshot, threads: [] } };
    }
    return item._tag === "ThreadUpdated" && item.thread !== undefined
      ? { _tag: "ThreadRemoved", sequence: item.sequence, threadId: item.thread.id }
      : item;
  };
  const strip = (socket, message) =>
    message !== null && typeof message === "object" && message._tag === "Chunk"
      ? { ...message, values: message.values.map((item) => withoutThreads(socket, item)) }
      : message;
  const descriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
  Object.defineProperty(MessageEvent.prototype, "data", {
    configurable: true,
    get() {
      if (rewritten.has(this)) return rewritten.get(this);
      const raw = descriptor.get.call(this);
      if (typeof raw !== "string" || !replaying.has(this.target)) return raw;
      const message = JSON.parse(raw);
      const frame = JSON.stringify(
        Array.isArray(message)
          ? message.map((one) => strip(this.target, one))
          : strip(this.target, message)
      );
      rewritten.set(this, frame);
      return frame;
    },
  });
`;

if (broken === "threads") {
  await page.addInitScript({ content: PLANT_THREADS });
}

const pageErrors: Array<string> = [];

page.on("pageerror", (error) => {
  pageErrors.push(String(error));
});

/** Arrival times of shell frames that make the page current: a snapshot or a replay's end. */
const currentFrames: Array<number> = [];

page.on("websocket", (socket) => {
  if (!socket.url().includes("/ws?")) {
    return;
  }

  socket.on("framereceived", ({ payload }) => {
    const text = Predicate.isString(payload)
      ? payload
      : payload.toString("utf-8");

    if (
      text.includes('"_tag":"Snapshot"') ||
      text.includes('"_tag":"Synchronized"')
    ) {
      currentFrames.push(Date.now());
    }
  });
});

// The shell's connection mark (`shell/ConnectionMark.ts`) is visually hidden while Live, so the
// Live waits ask for it attached, not visible; the mark shows while the socket is down.
const live = '[data-testid="connection-state"][data-state="Live"]';

const notLive = '[data-testid="connection-state"]:not([data-state="Live"])';

await page.goto(`${origin}/`);

await page.waitForSelector(live, { state: "attached", timeout: 30_000 });

/** One kill and restart: how long the page took to be current again. */
interface Round {
  readonly round: number;
  readonly firstFrameMs: number | null;
  readonly pass: boolean;
}

const firstFrameAfter = async (listeningAt: number): Promise<number | null> => {
  const deadline = listeningAt + 10_000;

  while (Date.now() < deadline) {
    const first = currentFrames.find((at) => at >= listeningAt);

    if (first !== undefined) {
      return first - listeningAt;
    }

    await sleep(20);
  }

  return null;
};

const results: Array<Round> = [];

for (let round = 1; round <= rounds; round += 1) {
  await killBrain(brain);
  // The page notices on its own (socket close, or the ping timeout).
  await page.waitForSelector(notLive, { timeout: 15_000 });
  await sleep(200 + (randomBytes(1).readUInt8(0) % 200) * 3);

  brain = await startBrain();

  const firstFrameMs = await firstFrameAfter(brain.listeningAt);

  results.push({
    round,
    firstFrameMs,
    pass: firstFrameMs !== null && firstFrameMs <= budgetMs,
  });

  await page.waitForSelector(live, { state: "attached", timeout: 15_000 });
  await launchProjectThread(
    await addProject(`round-${round}`),
    `round-${round}`
  );
}

// The crossing: `last` and its project thread are made while the gate keeps the page away, so they
// reach it through its reconnect alone. Every launched thread's turn ends first, so no live update
// for an earlier round's thread arrives after the reconnect, and again before the gate opens, so
// none for `last` does either.
const LAST = "last";

await brainSettled();

gate.held = true;

await killBrain(brain);

await page.waitForSelector(notLive, { timeout: 15_000 });

brain = await startBrain();

await launchProjectThread(await addProject(LAST), LAST);

await brainSettled();

// The gate held: the page tried to reconnect and was refused, and is still not Live, so a change
// that routes the page around the gate fails this run and not only the control.
const liveWhileHeld = (await page.locator(live).count()) > 0;

if (gate.refused === 0 || liveWhileHeld) {
  throw new Error(
    `judges/reconnect.ts: the gate did not hold the page away (it refused ${gate.refused} connections; the page was ${liveWhileHeld ? "" : "not "}Live).`
  );
}

const openedAt = Date.now();

gate.held = false;

await page.waitForSelector(live, { state: "attached", timeout: 30_000 });

// Reported, not judged: the page may be waiting out its reconnect backoff when the gate opens.
const crossingFirstFrameMs = await firstFrameAfter(openedAt);

// Let the reconnect's frames settle in the page, then compare it with the brain's own snapshot.
await sleep(1000);

const snapshot = await brainShell();

const attributes = async (selector: string, attribute: string) => {
  const elements = await page.locator(selector).all();

  return await Promise.all(
    elements.map(
      async (element) => (await element.getAttribute(attribute)) ?? ""
    )
  );
};

// What the shell shows of the list: the rail's bubble per folder project (its title), the
// selected bubble, and that project's project thread in the sidebar (glossary: Project rail).
const [selectedTitle = null] = await attributes(
  '[data-testid="rail-project"][aria-current="true"]',
  "title"
);

const [pageProjectThread = null] = await attributes(
  '[data-testid="shell-project-thread"]',
  "data-thread-item"
);

const pageList = {
  projects: await attributes('[data-testid="rail-project"]', "title"),
  selected: selectedTitle,
  projectThread: pageProjectThread,
};

const brainList = Option.match(snapshot, {
  onNone: () => ({ projects: [], selected: null, projectThread: null }),
  onSome: (shell) => {
    const folders = shell.projects.filter(
      (project) => project.kind === "folder"
    );

    // The page sits on the hero, whose selected project is its default: the brain's most recently
    // updated folder project. The page's own reading never picks the brain's side.
    const selected = defaultProjectOf(shell.projects);

    return {
      projects: folders.map((project) => project.title),
      selected: Option.getOrNull(
        Option.map(selected, (project) => project.title)
      ),
      projectThread: Option.getOrNull(
        Option.flatMap(selected, (project) =>
          Option.map(project.projectThreadId, String)
        )
      ),
    };
  },
});

const sameIds = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean =>
  JSON.stringify(left.toSorted()) === JSON.stringify(right.toSorted());

const listMatches =
  Option.isSome(snapshot) &&
  sameIds(pageList.projects, brainList.projects) &&
  pageList.selected !== null &&
  pageList.selected === brainList.selected &&
  brainList.projectThread !== null &&
  pageList.projectThread === brainList.projectThread;

// The project compared is the one made during the crossing, so its project thread crossed a
// reconnect.
const crossed = brainList.selected === LAST;

await browser.close();

await vite.close();

await killBrain(brain);

for (const socket of gateSockets) {
  socket.destroy();
}

gateServer.close();

rmSync(dataDir, { recursive: true, force: true });

for (const workspace of workspaces) {
  rmSync(workspace, { recursive: true, force: true });
}

const pass =
  results.every((result) => result.pass) &&
  listMatches &&
  crossed &&
  pageErrors.length === 0;

console.log(
  JSON.stringify({
    judge: "reconnect",
    pass,
    broken: broken === "" ? null : broken,
    budgetMs,
    rounds: results,
    worstFirstFrameMs: Math.max(
      ...results.map(
        (result) => result.firstFrameMs ?? Number.POSITIVE_INFINITY
      )
    ),
    crossingFirstFrameMs,
    listMatches,
    crossed,
    page: pageList,
    brain: brainList,
    pageErrors,
  })
);

process.exit(pass ? 0 : 1);
