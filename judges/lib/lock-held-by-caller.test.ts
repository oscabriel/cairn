// `judges/lib/lock-held-by-caller.sh` (ADR 0054): the nightly and the pre-deploy set take the judge
// lock themselves, so a caller that already holds it (`flock <lock> node judges/run-set.ts`, the hand
// run convention) must be seen, or the script's own `flock` waits on its caller forever. It answers
// yes only when a process the script descends from holds the lock, never for another holder.

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, assert, describe, it } from "@effect/vitest";

const helper = path.join(import.meta.dirname, "lock-held-by-caller.sh");

const root = mkdtempSync(path.join(tmpdir(), "cairn-lock-caller-"));

const lock = path.join(root, "judge.lock");

/** The helper's exit status when run as `prefix... bash helper <lock>`. */
const statusUnder = (prefix: ReadonlyArray<string>) => {
  const command = [...prefix, "bash", helper, lock];

  return spawnSync(command[0] ?? "bash", command.slice(1), {
    encoding: "utf-8",
  }).status;
};

const lockIsHeld = () => spawnSync("flock", ["-n", lock, "true"]).status !== 0;

let holder: ChildProcess | undefined;

describe("lock-held-by-caller.sh", () => {
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

  it("says no when no one holds the lock", () => {
    assert.strictEqual(statusUnder([]), 1);
  });

  it("says yes under `flock <lock> <command>`, a caller one or more processes up", () => {
    assert.strictEqual(statusUnder(["flock", lock]), 0);
    assert.strictEqual(
      statusUnder(["flock", lock, "bash", "-c", '"$@"', "-"]),
      0
    );
  });

  it("says yes when a calling shell holds the lock on a descriptor", () => {
    const done = spawnSync(
      "bash",
      [
        "-c",
        'exec 9>"$2" && flock 9 && bash "$1" "$2"; echo "status $?"',
        "caller",
        helper,
        lock,
      ],
      { encoding: "utf-8" }
    );

    assert.strictEqual(done.stdout.trim(), "status 0", done.stderr);
  });

  it("says no when another process, not a caller, holds the lock", () => {
    holder = spawn(
      "bash",
      ["-c", 'exec 9>"$1" && flock 9 && exec sleep 60', "hold", lock],
      { stdio: "ignore" }
    );

    for (let tries = 0; tries < 200 && !lockIsHeld(); tries += 1) {
      spawnSync("sleep", ["0.05"]);
    }

    assert.isTrue(lockIsHeld(), "the holder took the lock");
    assert.strictEqual(statusUnder([]), 1);
  });
});
