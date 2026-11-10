// The pre-deploy set (ADR 0054): runs `SET` from `judges/index.ts` in order on this checkout's
// commit, under the judge lock, records each result, and exits non-zero when any failed.
// `ops/cairn/deploy.sh` refuses a commit with no passing set record on a clean tree.
//
//   node judges/run-set.ts [--list]
//
// Every judge in the set is free and needs no model, no deployed brain, no Docker and no porch;
// browser judges drive system Chromium. The whole set takes a few hours, so run it on a quiet
// machine. The lock is `flock` on `CAIRN_JUDGE_LOCK` (default /tmp/cairn-judge.lock), held here
// for the whole set. The nightly (`judges/fixtures/durability/nightly.sh`) takes it too, so the set
// waits for a running nightly and a nightly waits for the set (skipping the night if it waits too
// long). A judge run by hand takes it only when its caller does (`flock /tmp/cairn-judge.lock node
// judges/<judge>.ts`): the judges themselves do not. This script takes it itself, so a caller that
// already holds it (`flock /tmp/cairn-judge.lock node judges/run-set.ts`, an ancestor of this
// process) is seen by `judges/lib/lock-held-by-caller.sh` and the set runs under that caller's lock;
// a holder that is not an ancestor must set CAIRN_JUDGE_LOCK_HELD=1, or the set waits for it.
//
// Each judge records itself when it ends (`judges/lib/Record.ts`), tagged with this run's id in
// `CAIRN_JUDGE_RUN`; a judge that died without writing its line gets one here, from its exit code.
// The set's own line (`run-set`) carries the counts, and its tree is dirty when the tree was dirty
// at the start or the commit or tree changed during the run, since then no one commit was judged.
// Prints one JSON line per judge and a summary line. Never runs the deployed brain or a model.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";

import { Option } from "effect";

import { judgeNamed, SET } from "./index.ts";
import {
  appendRecord,
  readRecords,
  recordOf,
  treeState,
} from "./lib/Record.ts";

const { values } = parseArgs({
  options: { list: { type: "boolean", default: false } },
});

const root = path.join(import.meta.dirname, "..");

if (values.list) {
  for (const run of SET) {
    process.stdout.write(`${[run.judge, ...run.args].join(" ")}\n`);
  }

  process.exit(0);
}

const lock = process.env.CAIRN_JUDGE_LOCK ?? "/tmp/cairn-judge.lock";

/** Whether a process this one descends from holds the lock (a caller that wrapped it in `flock`). */
const heldByCaller = () =>
  spawnSync("bash", [
    path.join(import.meta.dirname, "lib", "lock-held-by-caller.sh"),
    lock,
  ]).status === 0;

// Take the lock once for the whole set: run this script again under `flock`, unless this process
// or its caller already holds it (a second `flock` here would wait on that caller forever).
if (process.env.CAIRN_JUDGE_LOCK_HELD !== "1" && !heldByCaller()) {
  process.stderr.write(
    `waiting for the judge lock ${lock} (this script takes it itself; a holder that is not its caller must set CAIRN_JUDGE_LOCK_HELD=1)\n`
  );

  const locked = spawnSync(
    "flock",
    [lock, process.execPath, import.meta.filename, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, CAIRN_JUDGE_LOCK_HELD: "1" },
    }
  );

  process.exit(locked.status ?? 1);
}

const start = treeState(root);

const startedAt = new Date();

const setRun = `${startedAt.toISOString()}-${String(process.pid)}`;

if (start.tree === "dirty") {
  process.stderr.write(
    `the tree is dirty, so this run will not count for a deploy of ${start.commit}\n`
  );
}

const failed: Array<string> = [];

for (const [index, run] of SET.entries()) {
  const judge = judgeNamed(run.judge);

  const file = Option.match(judge, {
    onNone: () => `${run.judge}.ts`,
    onSome: (found) => found.files[0] ?? `${run.judge}.ts`,
  });

  const runId = `${setRun}/${String(index)}`;
  const began = new Date();

  const done = spawnSync(
    file.endsWith(".sh") ? "bash" : process.execPath,
    [path.join(import.meta.dirname, file), ...run.args],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CAIRN_JUDGE_RUN: runId },
    }
  );

  const exitCode = done.status ?? 1;

  const name = Option.match(judge, {
    onNone: () => run.judge,
    onSome: (found) => found.name,
  });

  const recorded = readRecords().some(
    (record) => record.run === runId && record.judge === name
  );

  if (!recorded) {
    appendRecord(
      recordOf({
        file,
        args: run.args,
        commit: start.commit,
        tree: start.tree,
        exitCode,
        counts: {},
        startedAt: began,
        endedAt: new Date(),
        run: runId,
        within: null,
      })
    );
  }

  if (exitCode !== 0) {
    failed.push([run.judge, ...run.args].join(" "));
  }

  process.stdout.write(
    `${JSON.stringify({
      set: run.judge,
      args: run.args,
      pass: exitCode === 0,
      exitCode,
      signal: done.signal,
      seconds: Math.round((Date.now() - began.getTime()) / 1000),
    })}\n`
  );
}

const end = treeState(root);

const tree =
  start.tree === "clean" && end.tree === "clean" && end.commit === start.commit
    ? "clean"
    : "dirty";

appendRecord(
  recordOf({
    file: "run-set.ts",
    args: [],
    commit: start.commit,
    tree,
    exitCode: failed.length === 0 ? 0 : 1,
    counts: {
      passed: SET.length - failed.length,
      failed: failed.length,
      total: SET.length,
    },
    startedAt,
    endedAt: new Date(),
    run: setRun,
    within: null,
  })
);

process.stdout.write(
  `${JSON.stringify({
    set: failed.length === 0 ? "pass" : "fail",
    commit: start.commit,
    tree,
    passed: SET.length - failed.length,
    total: SET.length,
    failed,
  })}\n`
);

process.exit(failed.length === 0 ? 0 : 1);
