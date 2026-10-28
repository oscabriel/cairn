/* oxlint-disable no-await-in-loop -- the judge's steps run one after another, on purpose */
// J-codex (ADR 0037, models note M8): Cairn's Codex sign-in and its refresh-token rotation against
// a fake OpenAI (`apps/server/src/models/FakeCodexAuth.ts`) that rotates the refresh token on every
// refresh and revokes the grant when a spent one comes back. Every brain is its own process
// (`judges/fixtures/codex-brain.ts`) over a throwaway database and lock, so `kill -9` is real.
//
//   node judges/codex-login.ts
//
// Passes when:
// - sign-in: a device-code sign-in shows the code, ends `SignedIn`, and the grant is stored;
// - kill-poll: a brain killed with `kill -9` while it polls for the code stores nothing, and the
//   next brain holds the lock (the dead brain's `flock` child went with it);
// - rotation: three brains in turn each refresh, every one presenting the token the last one
//   stored (no reuse reaches the fake);
// - second-brain: while one brain holds the lock, a second refuses to refresh or sign in, and after
//   the holder is killed with `kill -9` the next brain refreshes with no reuse;
// - control: the same rotation with a store that never persists a refresh is caught (the fake
//   sees a reused token), so the rotation check can fail.
//
// Prints one line per case and a JSON summary; never a token (the fake's tokens are counters).

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

import { startFakeCodexAuth } from "../apps/server/src/models/FakeCodexAuth.ts";
import type { FakeCodexAuth } from "../apps/server/src/models/FakeCodexAuth.ts";

const BRAIN = path.join(import.meta.dirname, "fixtures", "codex-brain.ts");

/** One JSON line a brain printed. */
interface BrainLine {
  readonly event: string;
  readonly [field: string]: string | number | boolean;
}

interface Place {
  readonly db: string;
  readonly lock: string;
}

const root = mkdtempSync(path.join(tmpdir(), "cairn-codex-judge-"));

let places = 0;

const place = (): Place => {
  places += 1;

  return {
    db: path.join(root, `cairn-${places}.sqlite`),
    lock: path.join(root, `state-${places}`, "oauth.lock"),
  };
};

/** A running brain: its lines as they come, and the process. */
interface Brain {
  readonly child: ChildProcess;
  next(event: string): Promise<BrainLine>;
  done(): Promise<number | null>;
}

const startBrain = (
  fake: FakeCodexAuth,
  where: Place,
  mode: string,
  extra: ReadonlyArray<string> = []
): Brain => {
  const child = spawn(
    process.execPath,
    [
      BRAIN,
      mode,
      "--db",
      where.db,
      "--lock",
      where.lock,
      "--fake",
      fake.base,
      ...extra,
    ],
    { stdio: ["pipe", "pipe", "inherit"] }
  );

  const lines: Array<BrainLine> = [];

  const waiting: Array<{ event: string; resolve: (line: BrainLine) => void }> =
    [];

  const settle = () => {
    for (const [index, wait] of waiting.entries()) {
      const found = lines.findIndex((line) => line.event === wait.event);

      if (found !== -1) {
        const [line] = lines.splice(found, 1);

        waiting.splice(index, 1);

        if (line !== undefined) {
          wait.resolve(line);
        }

        settle();

        return;
      }
    }
  };

  createInterface({ input: child.stdout ?? process.stdin }).on(
    "line",
    (text) => {
      // The brain's own log lines share stdout; only its event lines are JSON objects with `event`.
      if (!text.startsWith('{"event"')) {
        return;
      }

      // SAFETY: the brain prints only `JSON.stringify` of a flat object with an `event` key.
      // Verified by: this judge's own cases (each waits for a named event and reads its fields)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      lines.push(JSON.parse(text) as BrainLine);
      settle();
    }
  );

  return {
    child,
    next: async (event) => {
      const result = Promise.withResolvers<BrainLine>();

      waiting.push({ event, resolve: result.resolve });
      settle();

      const timedOut = (async (): Promise<BrainLine> => {
        await sleep(30_000, undefined, { ref: false });

        return { event: "timeout", waited: event };
      })();

      return await Promise.race([result.promise, timedOut]);
    },
    done: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return child.exitCode;
      }

      await once(child, "exit");

      return child.exitCode;
    },
  };
};

/** Runs a brain that answers once and exits; its one line for `event`. */
const runBrain = async (
  fake: FakeCodexAuth,
  where: Place,
  mode: string,
  event: string,
  extra: ReadonlyArray<string> = []
) => {
  const brain = startBrain(fake, where, mode, extra);
  const line = await brain.next(event);

  await brain.done();

  return line;
};

const killNine = async (brain: Brain) => {
  brain.child.kill("SIGKILL");
  await brain.done();
};

/** Signs a new place in, approving the code as soon as it shows. */
const signedIn = async (fake: FakeCodexAuth, where: Place) => {
  const brain = startBrain(fake, where, "login");

  await brain.next("device_code");
  fake.approve();

  const line = await brain.next("login");

  await brain.done();

  return line;
};

interface CaseResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const results: Array<CaseResult> = [];

const record = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}\n`);
};

// sign-in
{
  const fake = await startFakeCodexAuth();
  const where = place();
  const line = await signedIn(fake, where);
  const status = await runBrain(fake, where, "status", "status");

  record(
    "sign-in",
    line.result === "SignedIn" &&
      status.signedIn === true &&
      fake.log.exchanges === 1,
    `result ${String(line.result)}, stored ${String(status.signedIn)}, exchanges ${fake.log.exchanges}`
  );
  await fake.close();
}

// kill-poll
{
  const fake = await startFakeCodexAuth();
  const where = place();
  const brain = startBrain(fake, where, "login");

  await brain.next("device_code");
  await killNine(brain);
  // The user enters the code after the brain died: nothing can store it.
  fake.approve();

  const status = await runBrain(fake, where, "status", "status");

  record(
    "kill-poll",
    status.held === true &&
      status.signedIn === false &&
      fake.log.exchanges === 0,
    `next brain holds ${String(status.held)}, stored ${String(status.signedIn)}, exchanges ${fake.log.exchanges}`
  );
  await fake.close();
}

/** Signs in, then three brains in turn each resolve auth (each one refreshes). */
const rotation = async (extra: ReadonlyArray<string>) => {
  const fake = await startFakeCodexAuth({ accessSeconds: 60 });
  const where = place();

  await signedIn(fake, where);

  const outcomes: Array<string> = [];

  for (const _turn of [1, 2, 3]) {
    const line = await runBrain(fake, where, "auth", "auth", extra);

    outcomes.push(String(line.outcome));
  }

  const log = { ...fake.log };

  await fake.close();

  return { outcomes, log };
};

// rotation
{
  const { outcomes, log } = await rotation([]);

  record(
    "rotation",
    outcomes.every((outcome) => outcome === "ok") &&
      log.refreshes === 3 &&
      log.reuses === 0,
    `auth ${outcomes.join(" ")}, refreshes ${log.refreshes}, reuses ${log.reuses}`
  );
}

// second-brain
{
  const fake = await startFakeCodexAuth({ accessSeconds: 60 });
  const where = place();

  await signedIn(fake, where);

  const holder = startBrain(fake, where, "status", ["--hold"]);
  const holding = await holder.next("holding");
  const second = await runBrain(fake, where, "auth", "auth");
  const secondLogin = await runBrain(fake, where, "login", "login");
  const refreshesWhileHeld = fake.log.refreshes;

  await killNine(holder);

  const after = await runBrain(fake, where, "auth", "auth");

  record(
    "second-brain",
    holding.held === true &&
      second.held === false &&
      second.outcome === "none" &&
      secondLogin.result === "unavailable" &&
      refreshesWhileHeld === 0 &&
      after.held === true &&
      after.outcome === "ok" &&
      fake.log.reuses === 0,
    `second holds ${String(second.held)} auth ${String(second.outcome)} login ${String(secondLogin.result)}, refreshes while held ${refreshesWhileHeld}; after kill -9: holds ${String(after.held)} auth ${String(after.outcome)}, reuses ${fake.log.reuses}`
  );
  await fake.close();
}

// control: a store that never persists a refresh must be caught.
{
  const { outcomes, log } = await rotation(["--control", "no-persist"]);
  const caught = log.reuses > 0 || outcomes.some((outcome) => outcome !== "ok");

  record(
    "control",
    caught,
    `no-persist store: auth ${outcomes.join(" ")}, reuses ${log.reuses} (${caught ? "caught" : "NOT caught"})`
  );
}

const pass = results.every((result) => result.pass);

process.stdout.write(
  `${JSON.stringify({
    judge: "codex-login",
    pass,
    cases: Object.fromEntries(
      results.map((result) => [result.name, result.pass])
    ),
  })}\n`
);

if (existsSync(root)) {
  rmSync(root, { recursive: true, force: true });
}

process.exitCode = pass ? 0 : 1;
