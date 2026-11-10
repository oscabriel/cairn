// Judge records (ADR 0054): a TypeScript judge run by node records one line when it exits, with the
// counts of its last JSON line, and nothing when it is only imported; a shell judge records through
// `record.sh` with its own traps and exit status intact; and the deploy's check accepts only a set
// whose newest clean run on the commit passed.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  countsOf,
  passingSet,
  readRecords,
  recordOf,
  SET_RECORD,
  treeState,
} from "./Record.ts";
import type { JudgeRecord } from "./Record.ts";

const root = mkdtempSync(path.join(tmpdir(), "cairn-judge-records-"));

const recordTs = path.join(import.meta.dirname, "Record.ts");

const recordSh = path.join(import.meta.dirname, "record.sh");

const repo = treeState(import.meta.dirname);

/** Runs `command` with the records file at `records`, as set run `run`. */
const runWith = (
  records: string,
  command: string,
  args: ReadonlyArray<string>
) =>
  spawnSync(command, args, {
    cwd: root,
    encoding: "utf-8",
    env: {
      ...process.env,
      CAIRN_JUDGE_RECORDS: records,
      CAIRN_JUDGE_RUN: "set-probe/0",
    },
  });

/** The pre-deploy set's own record on `commit`. */
const setRecord = (
  commit: string,
  tree: "clean" | "dirty",
  exitCode: number
): JudgeRecord =>
  recordOf({
    file: "run-set.ts",
    args: [],
    commit,
    tree,
    exitCode,
    counts: {},
    startedAt: new Date(0),
    endedAt: new Date(1000),
    run: null,
  });

describe("judge records", () => {
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe(countsOf, () => {
    it("reads the finite numbers of the last JSON object line", () => {
      const output = [
        '{"case":"kills","passed":9}',
        "PASS something",
        '{"summary":"fail","passed":3,"failed":1,"notes":"x","nested":{"n":2}}',
        "a last line that is not JSON",
      ].join("\n");

      assert.deepStrictEqual(countsOf(output), { passed: 3, failed: 1 });
      assert.deepStrictEqual(countsOf("no json here"), {});
      assert.deepStrictEqual(countsOf("[1,2]\n"), {});
    });
  });

  describe("recordOnExit", () => {
    it("records the judge node ran once, with its verdict and counts, and not a judge it imports", () => {
      const records = path.join(root, "ts", "records.jsonl");

      writeFileSync(
        path.join(root, "probe-lib.ts"),
        `import { recordOnExit } from ${JSON.stringify(recordTs)};\nrecordOnExit(import.meta);\nexport const value = 1;\n`
      );
      writeFileSync(
        path.join(root, "probe-judge.ts"),
        `import { recordOnExit } from ${JSON.stringify(recordTs)};\nimport { value } from "./probe-lib.ts";\nrecordOnExit(import.meta);\nconsole.log(JSON.stringify({ case: "a", passed: value }));\nprocess.stdout.write(JSON.stringify({ summary: "fail", passed: 3, failed: 1 }) + "\\n");\nprocess.exitCode = 1;\n`
      );

      const done = runWith(records, process.execPath, [
        path.join(root, "probe-judge.ts"),
        "--case",
        "a",
      ]);

      assert.strictEqual(done.status, 1, done.stderr);
      assert.include(done.stdout, '"summary":"fail"');

      const lines = readRecords(records);

      assert.strictEqual(lines.length, 1);
      assert.deepInclude(lines[0], {
        judge: "probe-judge",
        args: ["--case", "a"],
        commit: repo.commit,
        tree: repo.tree,
        pass: false,
        exitCode: 1,
        counts: { passed: 3, failed: 1 },
        cost: "unregistered",
        run: "set-probe/0",
      });
    });
  });

  describe("record.sh", () => {
    it("records a shell judge's exit status and arguments, keeping its own trap", () => {
      const records = path.join(root, "sh", "records.jsonl");
      const judge = path.join(root, "probe-shell.sh");

      writeFileSync(
        judge,
        `#!/usr/bin/env bash\nset -euo pipefail\nsource ${JSON.stringify(recordSh)} && record_run probe-shell.sh "$@"\ntrap 'echo own trap ran' EXIT\necho "args: $*"\nexit 3\n`
      );

      const done = runWith(records, "bash", [judge, "--port", "3774"]);

      assert.strictEqual(done.status, 3, done.stderr);
      assert.include(done.stdout, "args: --port 3774");
      assert.include(done.stdout, "own trap ran");

      const lines = readRecords(records);

      assert.strictEqual(lines.length, 1);
      assert.deepInclude(lines[0], {
        judge: "probe-shell",
        args: ["--port", "3774"],
        commit: repo.commit,
        tree: repo.tree,
        pass: false,
        exitCode: 3,
        run: "set-probe/0",
      });
    });
  });

  describe(passingSet, () => {
    it("names the set's own record after the registry", () => {
      assert.strictEqual(setRecord("a", "clean", 0).judge, SET_RECORD);
    });

    it("accepts a commit whose newest clean set run passed", () => {
      const records = [
        setRecord("a", "clean", 1),
        setRecord("a", "clean", 0),
        setRecord("a", "dirty", 1),
        setRecord("b", "clean", 1),
      ];

      assert.isTrue(Option.isSome(passingSet(records, "a")));
      assert.isTrue(Option.isNone(passingSet(records, "b")));
      assert.isTrue(Option.isNone(passingSet(records, "c")));
    });

    it("refuses a pass on a dirty tree, and a pass a later clean run failed", () => {
      assert.isTrue(
        Option.isNone(passingSet([setRecord("a", "dirty", 0)], "a"))
      );
      assert.isTrue(
        Option.isNone(
          passingSet(
            [setRecord("a", "clean", 0), setRecord("a", "clean", 1)],
            "a"
          )
        )
      );
    });

    it("is what deploy.sh's `status.ts --require-set` answers", () => {
      const records = path.join(root, "status", "records.jsonl");
      const status = path.join(import.meta.dirname, "..", "status.ts");

      const require = () =>
        runWith(records, process.execPath, [status, "--require-set", "HEAD"]);

      const before = require();

      assert.strictEqual(before.status, 1);
      assert.include(before.stderr, "no passing judge set is recorded");

      mkdirSync(path.dirname(records), { recursive: true });
      writeFileSync(
        records,
        `${JSON.stringify(setRecord(repo.commit, "clean", 0))}\n`
      );

      const after = require();

      assert.strictEqual(after.status, 0, after.stderr);
      assert.include(after.stdout, "the judge set passed on");
    });
  });
});
