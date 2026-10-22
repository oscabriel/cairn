/* oxlint-disable no-await-in-loop -- a judge drives one kill and restart after another, on purpose */
// The reconnect judge: the client must converge after its brain dies.
//
//   node judges/reconnect.ts [--rounds 5] [--budget-ms 2000] [--headed]
//
// It starts a dev brain (apps/server/src/dev-main.ts) on an ephemeral loopback port with its own
// throwaway data directory, serves the client through Vite proxying to it, opens the page in
// Chromium and waits for it to be Live. Then, each round, it `kill -9`s the brain, restarts it on
// the same port, and times the page's first shell frame that makes it current (a snapshot, or the
// marker that ends a replay) from the restarted brain's listening line. Between rounds it adds a
// project through the protocol, so every reconnect has something new to pick up.
//
// Passes when every round's first frame came within the budget, the page's final project and
// thread list equals a fresh snapshot from the brain, and the page raised no error. Prints one JSON
// line and exits 0 on a pass.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { CommandId } from "@cairn/protocol/Ids";
import { CairnRpcs, PROTOCOL_VERSION } from "@cairn/protocol/Rpc";
import type { ShellSnapshot } from "@cairn/protocol/Shell";
import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import { NodeSocket } from "@effect/platform-node";
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
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";

const { values } = parseArgs({
  options: {
    rounds: { type: "string", default: "5" },
    "budget-ms": { type: "string", default: "2000" },
    headed: { type: "boolean", default: false },
  },
});

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

/** A running brain and the time (ms since epoch) it said it listens. */
interface Brain {
  readonly process: ChildProcess;
  readonly listeningAt: number;
}

const isListeningLine = (line: string): boolean =>
  /listening\b/iu.test(line) && line.includes(`:${brainPort}`);

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

  const onLine = (line: string) => {
    brainLog.push(line);

    if (isListeningLine(line)) {
      listening.resolve(Date.now());
    }
  };

  createInterface({ input: child.stdout }).on("line", onLine);
  createInterface({ input: child.stderr }).on("line", onLine);
  child.once("exit", (code, signal) => {
    listening.reject(
      new Error(
        `judges/reconnect.ts: the brain exited (${String(code ?? signal)}) before it listened. Last lines:\n${brainLog.slice(-20).join("\n")}`
      )
    );
  });

  return { process: child, listeningAt: await listening.promise };
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
    NodeSocket.layerWebSocket(
      `ws://${LOOPBACK}:${brainPort}/ws?protocol=${PROTOCOL_VERSION}`,
      { headers: { origin, host: new URL(origin).host } }
    )
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

const addProject = async (name: string) => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), `cairn-${name}-`));

  workspaces.push(workspaceRoot);

  const result = await withClient((client) =>
    client["shell.dispatch"](
      ProjectCreate.make({
        commandId: decodeCommandId(uuidv7()),
        workspaceRoot,
        title: Option.some(name),
      })
    )
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

let brain = await startBrain();

// A judge that throws must not leave its brain running: kill whichever brain is current on exit.
process.once("exit", () => {
  brain.process.kill("SIGKILL");
});

await addProject("first");

await addProject("second");

// vite.config.ts reads this when Vite loads it, just below.
process.env.CAIRN_DEV_BRAIN = `http://${LOOPBACK}:${brainPort}`;

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

const live = '[data-testid="connection-state"][data-state="Live"]';

await page.goto(`${origin}/`);

await page.waitForSelector(live, { timeout: 30_000 });

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
  await page.waitForSelector(
    '[data-testid="connection-state"]:not([data-state="Live"])',
    { timeout: 15_000 }
  );
  await sleep(200 + (randomBytes(1).readUInt8(0) % 200) * 3);

  brain = await startBrain();

  const firstFrameMs = await firstFrameAfter(brain.listeningAt);

  results.push({
    round,
    firstFrameMs,
    pass: firstFrameMs !== null && firstFrameMs <= budgetMs,
  });

  await page.waitForSelector(live, { timeout: 15_000 });
  await addProject(`round-${round}`);
}

// Let the last project reach the page, then compare it with the brain's own snapshot.
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

const pageIds = {
  projects: await attributes("[data-testid=shell-project]", "data-project-id"),
  threads: await attributes("[data-testid=shell-thread-row]", "data-thread-id"),
};

const brainIds = Option.match(snapshot, {
  onNone: () => ({ projects: [], threads: [] }),
  onSome: (shell) => ({
    projects: shell.projects.map((project) => String(project.id)),
    threads: shell.threads.map((thread) => String(thread.id)),
  }),
});

const sameIds = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean =>
  JSON.stringify(left.toSorted()) === JSON.stringify(right.toSorted());

const listMatches =
  Option.isSome(snapshot) &&
  sameIds(pageIds.projects, brainIds.projects) &&
  sameIds(pageIds.threads, brainIds.threads);

await browser.close();

await vite.close();

await killBrain(brain);

rmSync(dataDir, { recursive: true, force: true });

for (const workspace of workspaces) {
  rmSync(workspace, { recursive: true, force: true });
}

const pass =
  results.every((result) => result.pass) &&
  listMatches &&
  pageErrors.length === 0;

console.log(
  JSON.stringify({
    judge: "reconnect",
    pass,
    budgetMs,
    rounds: results,
    worstFirstFrameMs: Math.max(
      ...results.map(
        (result) => result.firstFrameMs ?? Number.POSITIVE_INFINITY
      )
    ),
    listMatches,
    page: pageIds,
    brain: brainIds,
    pageErrors,
  })
);

process.exit(pass ? 0 : 1);
