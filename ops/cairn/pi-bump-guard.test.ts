// The deploy's guard for running workflows (workflows note judge 7): `pi-bump-guard.sh` over a
// scratch repository whose commits change the pi pins or not, and a scratch cairn.sqlite whose
// threads are settled or not. A pin change refuses while a thread runs, waits or is parked; anything
// else passes.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const guard = path.join(import.meta.dirname, "pi-bump-guard.sh");

const root = mkdtempSync(path.join(tmpdir(), "cairn-pi-guard-"));

const repo = path.join(root, "repo");

const run = (command: string, args: ReadonlyArray<string>, cwd = root) => {
  const done = spawnSync(command, args, { cwd, encoding: "utf-8" });

  return {
    status: done.status,
    out: `${done.stdout}${done.stderr}`.trim(),
  };
};

/** Commits a pnpm-workspace.yaml naming pi at `version` and `extra`; the commit's sha. */
const commit = (version: string, extra: string) => {
  writeFileSync(
    path.join(repo, "pnpm-workspace.yaml"),
    `catalog:\n  "@earendil-works/pi-durable": ${version}\n  effect: ${extra}\n`
  );
  run("git", ["add", "."], repo);
  run("git", ["commit", "--quiet", "-m", `${version} ${extra}`], repo);

  return run("git", ["rev-parse", "HEAD"], repo).out;
};

/** A data directory whose cairn.sqlite holds threads with these activities. */
const dataWith = (name: string, activities: ReadonlyArray<string>) => {
  const dir = path.join(root, name);

  const rows = activities
    .map(
      (activity, index) =>
        `('t${String(index)}', '{"activity":"${activity}","queueLength":0}')`
    )
    .join(", ");

  run("mkdir", ["-p", dir]);
  run("sqlite3", [
    path.join(dir, "cairn.sqlite"),
    `create table threads (id text primary key, shell_json text not null); insert into threads values ${rows};`,
  ]);

  return dir;
};

run("git", ["init", "--quiet", repo]);

run("git", ["config", "user.email", "judge@cairn.invalid"], repo);

run("git", ["config", "user.name", "judge"], repo);

const base = commit("1.4.0", "4.0.0");

const effectOnly = commit("1.4.0", "4.0.1");

const piBump = commit("1.5.0", "4.0.1");

const settled = dataWith("settled", ["idle", "failed", "idle"]);

const busy = dataWith("busy", ["idle", "running"]);

const parked = dataWith("parked", ["parked"]);

const waiting = dataWith("waiting", ["waiting", "idle"]);

const guardOf = (from: string, to: string, data: string) =>
  run(guard, [repo, from, to, data]);

describe("pi-bump-guard.sh", () => {
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lets a deploy that keeps the pi pins go while a thread runs", () => {
    const result = guardOf(base, effectOnly, busy);

    expect(result.status).toBe(0);
    expect(result.out).toContain("pi pins unchanged");
  });

  it("lets a pi bump go when every thread is settled", () => {
    const result = guardOf(effectOnly, piBump, settled);

    expect(result.status).toBe(0);
    expect(result.out).toContain("every thread is settled");
  });

  it.each([
    ["running", busy],
    ["parked", parked],
    ["waiting", waiting],
  ])("refuses a pi bump while a thread is %s", (_activity, data) => {
    const result = guardOf(base, piBump, data);

    expect(result.status).toBe(1);
    expect(result.out).toContain("1 thread(s) are not settled");
  });
});
