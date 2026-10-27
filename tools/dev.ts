// `pnpm dev`: a dev brain and the web client's Vite server, both on ephemeral loopback ports, so the
// deployed brain's 3774 is never touched (plan D49).
//
//   node tools/dev.ts [--models real] [--data-dir <path>]
//
// Vite's port is chosen first, because the brain must know the page's origin (CAIRN_ORIGIN) for its
// Origin guard. The brain starts from apps/server/src/dev-main.ts with CAIRN_PORT=0 and prints the
// address it bound; Vite then proxies /ws, /api and /_cairn to it. The dev brain keeps its data
// under ~/.local/share/cairn-dev unless --data-dir says otherwise, never in production's store.
// Ctrl-C stops both.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { Predicate } from "effect";
import { createServer as createViteServer } from "vite";

const root = path.join(import.meta.dirname, "..");

const { values } = parseArgs({
  options: {
    models: { type: "string", default: "scripted" },
    "data-dir": {
      type: "string",
      default: path.join(homedir(), ".local", "share", "cairn-dev"),
    },
  },
});

const LOOPBACK = "127.0.0.1";

/** A port the kernel just handed out on loopback, free again by the time it is returned. */
const freePort = async (): Promise<number> => {
  const server = createNetServer().listen(0, LOOPBACK);

  await once(server, "listening");

  const address = server.address();

  server.close();
  await once(server, "close");

  if (address === null || Predicate.isString(address)) {
    throw new Error("tools/dev.ts: the kernel gave no loopback port.");
  }

  return address.port;
};

/** The port in a log line that says the brain listens, as Effect's `HttpServer.logAddress` writes it. */
const listeningPort = (line: string): number | undefined => {
  const match =
    /listening\b.*?(?:127\.0\.0\.1|localhost|\[::1\]):(?<port>\d+)/iu.exec(
      line
    );

  return match?.groups?.port === undefined
    ? undefined
    : Number(match.groups.port);
};

/**
 * Echoes the brain's output and resolves with the port it binds; rejects if it exits first.
 */
const brainListening = async (brain: ChildProcess): Promise<number> => {
  const listening = Promise.withResolvers<number>();

  const onLine = (line: string) => {
    console.log(`[brain] ${line}`);

    const port = listeningPort(line);

    if (port !== undefined) {
      listening.resolve(port);
    }
  };

  if (brain.stdout !== null) {
    createInterface({ input: brain.stdout }).on("line", onLine);
  }

  if (brain.stderr !== null) {
    createInterface({ input: brain.stderr }).on("line", onLine);
  }

  brain.once("exit", (code) => {
    listening.reject(
      new Error(
        `tools/dev.ts: the dev brain exited (${String(code)}) before it said where it listens.`
      )
    );
  });

  const port = await listening.promise;

  return port;
};

const vitePort = await freePort();

const origin = `http://${LOOPBACK}:${vitePort}`;

const dataDir = path.resolve(values["data-dir"]);

mkdirSync(dataDir, { recursive: true });

const modelFlags = values.models === "real" ? ["--models", "real"] : [];

const brain = spawn(
  process.execPath,
  [path.join(root, "apps/server/src/dev-main.ts"), ...modelFlags],
  {
    cwd: root,
    env: {
      ...process.env,
      CAIRN_LISTEN_HOST: LOOPBACK,
      CAIRN_PORT: "0",
      CAIRN_ORIGIN: origin,
      CAIRN_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

const brainPort = await brainListening(brain);

const brainUrl = `http://${LOOPBACK}:${String(brainPort)}`;

// vite.config.ts reads this when Vite loads it, just below.
process.env.CAIRN_DEV_BRAIN = brainUrl;

const vite = await createViteServer({
  configFile: path.join(root, "apps/web/vite.config.ts"),
  root: path.join(root, "apps/web"),
  server: { host: LOOPBACK, port: vitePort, strictPort: true },
});

await vite.listen();

console.log(
  `Cairn dev: ${origin} (brain on ${brainUrl}, data in ${dataDir}, models ${values.models})`
);

const stop = () => {
  brain.kill("SIGTERM");
  process.exit(0);
};

process.once("SIGINT", stop);

process.once("SIGTERM", stop);

brain.once("exit", (code) => {
  console.log(`[brain] exited (${String(code)}); stopping.`);
  process.exit(code ?? 1);
});
