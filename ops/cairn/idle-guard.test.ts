// The deploy's idle guard (finding E-7, ADR 0054): `idle-guard.sh` over a scratch cairn.sqlite. A
// restart may go only while every live thread is idle or failed with an empty queue; a deleted or
// archived thread never holds it back, and a thread with work queued does.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const guard = path.join(import.meta.dirname, "idle-guard.sh");

const root = mkdtempSync(path.join(tmpdir(), "cairn-idle-guard-"));

interface Row {
  readonly activity: string;
  readonly queueLength?: number;
  readonly deleted?: boolean;
  readonly archived?: boolean;
}

/** A data directory whose cairn.sqlite holds these threads. */
const dataWith = (name: string, rows: ReadonlyArray<Row>) => {
  const dir = path.join(root, name);

  mkdirSync(dir, { recursive: true });

  const values = rows
    .map((row, index) => {
      const shell = JSON.stringify({
        activity: row.activity,
        queueLength: row.queueLength ?? 0,
        archivedAt: row.archived === true ? "2026-11-01T00:00:00.000Z" : null,
      });

      return `('t${String(index)}', ${row.deleted === true ? "1" : "null"}, '${shell}')`;
    })
    .join(", ");

  const done = spawnSync(
    "sqlite3",
    [
      path.join(dir, "cairn.sqlite"),
      `create table threads (id text primary key, deleted_at integer, shell_json text not null); insert into threads values ${values};`,
    ],
    { encoding: "utf-8" }
  );

  expect({ status: done.status, stderr: done.stderr }).toStrictEqual({
    status: 0,
    stderr: "",
  });

  return dir;
};

const guardOf = (data: string) => {
  const done = spawnSync(guard, [data], { encoding: "utf-8" });

  return {
    status: done.status,
    out: `${done.stdout}${done.stderr}`.trim(),
  };
};

describe("idle-guard.sh", () => {
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lets a restart go when every live thread is idle or failed with an empty queue", () => {
    const result = guardOf(
      dataWith("settled", [
        { activity: "idle" },
        { activity: "failed" },
        { activity: "running", deleted: true },
        { activity: "waiting", archived: true },
      ])
    );

    expect(result.status).toBe(0);
    expect(result.out).toContain(
      "every live thread is idle or failed with an empty queue"
    );
  });

  it.each([
    ["running", { activity: "running" }],
    ["waiting", { activity: "waiting" }],
    ["preparing", { activity: "preparing" }],
    ["idle with work queued", { activity: "idle", queueLength: 2 }],
  ])("refuses while a live thread is %s", (_name, row) => {
    const result = guardOf(
      dataWith(`busy-${_name.replaceAll(" ", "-")}`, [
        { activity: "idle" },
        row,
      ])
    );

    expect(result.status).toBe(1);
    expect(result.out).toContain("1 live thread(s) are not settled");
    expect(result.out).toContain("t1");
  });

  it("passes when there is no store yet", () => {
    const result = guardOf(path.join(root, "nothing-here"));

    expect(result.status).toBe(0);
    expect(result.out).toContain("is missing");
  });
});
