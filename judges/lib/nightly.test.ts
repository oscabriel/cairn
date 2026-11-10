// The nightly and the judge lock (ADR 0054): `judges/fixtures/durability/nightly.sh` runs under the
// same `flock` as `judges/run-set.ts`, so the two never share the machine. It waits for a holder; a
// night that cannot take the lock in time is skipped, and a second skipped night in a row fails, so a
// stuck holder cannot silence the nightly. Its durability steps record as within the nightly. `node`
// is a stub on PATH here, so no judge runs: it notes whether the lock was held, the outer judge it
// was given and its arguments.

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, assert, describe, it } from "@effect/vitest";

const nightly = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "durability",
  "nightly.sh"
);

const root = mkdtempSync(path.join(tmpdir(), "cairn-nightly-lock-"));

const bin = path.join(root, "bin");

const lock = path.join(root, "judge.lock");

const calls = path.join(root, "node-calls.txt");

mkdirSync(bin);

writeFileSync(
  path.join(bin, "node"),
  `#!/usr/bin/env bash\nheld=free\nflock -n "$CAIRN_JUDGE_LOCK" true || held=held\necho "$held|\${CAIRN_JUDGE_OUTER:-}|$*" >>${JSON.stringify(calls)}\n`
);

chmodSync(path.join(bin, "node"), 0o755);

/** The home whose `cairn-judges/` the nightly writes; one per case. */
const homeOf = (name: string) => {
  const home = path.join(root, name);

  mkdirSync(home, { recursive: true });

  return home;
};

/**
 * Runs the nightly without its slow and bridge steps, waiting at most a second for the lock;
 * `wrapped` runs it as a hand run by convention, `flock <lock> bash nightly.sh`.
 */
const runNightly = (home: string, wrapped = false) => {
  rmSync(calls, { force: true });

  // Empty, as the timer leaves them: no lock held, no outer judge.
  const env = {
    ...process.env,
    CAIRN_JUDGE_LOCK_HELD: "",
    CAIRN_JUDGE_OUTER: "",
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    CAIRN_JUDGE_LOCK: lock,
    CAIRN_NIGHTLY_LOCK_WAIT: "1",
    CAIRN_DURABILITY_LOG: path.join(home, "durability.jsonl"),
  };

  const command = ["bash", nightly, "--no-slow", "--no-bridge"];

  const [program = "bash", ...args] = wrapped
    ? ["flock", lock, ...command]
    : command;

  const done = spawnSync(program, args, { encoding: "utf-8", env });

  return {
    status: done.status,
    out: `${done.stdout}${done.stderr}`,
    calls: existsSync(calls)
      ? readFileSync(calls, "utf-8").trim().split("\n")
      : [],
  };
};

const lockIsHeld = () => spawnSync("flock", ["-n", lock, "true"]).status !== 0;

let holder: ChildProcess | undefined;

/** Another judge holding the lock, as the pre-deploy set does for hours. */
const holdLock = () => {
  // One process holds the lock's descriptor, so killing it frees the lock.
  holder = spawn(
    "bash",
    ["-c", 'exec 9>"$1" && flock 9 && exec sleep 60', "hold", lock],
    { stdio: "ignore" }
  );

  for (let tries = 0; tries < 200 && !lockIsHeld(); tries += 1) {
    spawnSync("sleep", ["0.05"]);
  }

  assert.isTrue(lockIsHeld(), "the holder took the lock");
};

// Each case spawns the script and waits out its lock timeout, about 3 s alone and more under the
// gate's load, so the cases take a longer limit than Vitest's 5 s.
describe("nightly.sh and the judge lock", { timeout: 30_000 }, () => {
  afterEach(() => {
    holder?.kill();
    holder = undefined;

    for (let tries = 0; tries < 200 && lockIsHeld(); tries += 1) {
      spawnSync("sleep", ["0.05"]);
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("runs every step under the lock, each within the nightly, and records itself as its own run", () => {
    const result = runNightly(homeOf("free"));

    assert.strictEqual(result.status, 0, result.out);
    assert.deepStrictEqual(
      result.calls.map((call) => call.split("|").slice(0, 2).join("|")),
      [
        "held|fixtures/durability/nightly.sh",
        "held|fixtures/durability/nightly.sh",
        "held|fixtures/durability/nightly.sh",
        "held|",
      ]
    );
    assert.match(result.calls[0] ?? "", /judges\/durability\.ts --runs 3$/u);
    assert.match(
      result.calls[3] ?? "",
      /judges\/lib\/append-record\.ts --file fixtures\/durability\/nightly\.sh /u
    );
  });

  it("runs its steps under a caller that already holds the lock, as a hand run wraps it", () => {
    const home = homeOf("wrapped");

    const result = runNightly(home, true);

    assert.strictEqual(result.status, 0, result.out);
    assert.notInclude(result.out, '"nightly":"skipped"');
    assert.lengthOf(result.calls, 4, result.out);
    assert.isTrue(
      result.calls.every((call) => call.startsWith("held|")),
      result.out
    );
    assert.isFalse(
      existsSync(path.join(home, "cairn-judges", "nightly-skipped"))
    );
  });

  it("skips a night the lock stays held, and fails the second such night in a row", () => {
    const home = homeOf("held");

    holdLock();

    const first = runNightly(home);

    assert.strictEqual(first.status, 0, first.out);
    assert.deepStrictEqual(first.calls, []);
    assert.include(first.out, '"nightly":"skipped"');
    assert.include(
      readFileSync(path.join(home, "durability.jsonl"), "utf-8"),
      '"nightly":"skipped"'
    );

    const second = runNightly(home);

    assert.strictEqual(second.status, 1, second.out);
    assert.deepStrictEqual(second.calls, []);
    assert.include(second.out, "skipped the night before too");
  });

  it("forgets a skipped night once a night runs", () => {
    const home = homeOf("recovered");

    holdLock();
    assert.strictEqual(runNightly(home).status, 0);
    holder?.kill();

    for (let tries = 0; tries < 200 && lockIsHeld(); tries += 1) {
      spawnSync("sleep", ["0.05"]);
    }

    assert.strictEqual(runNightly(home).status, 0);

    holdLock();

    assert.strictEqual(runNightly(home).status, 0);
  });
});
