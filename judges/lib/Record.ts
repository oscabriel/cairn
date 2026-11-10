// Judge records (ADR 0054): one JSON line per judge run, appended when the judge ends, to a file
// outside the repo (`~/cairn-judges/records.jsonl`, created on demand; `CAIRN_JUDGE_RECORDS` moves
// it, which tests do). A line names the judge, the commit it ran on and whether the tree was clean,
// the verdict (exit 0 is a pass), the numbers on the judge's last JSON line, the time and the cost.
// `judges/status.ts` joins them with the registry, and `ops/cairn/deploy.sh` reads the pre-deploy
// set's line through it.
//
// A TypeScript judge records itself with one call after its imports, which does nothing when the
// file is imported rather than run:
//
//   recordOnExit(import.meta);
//
// A shell judge sources `record.sh` beside this file, and `append-record.ts` writes its line.
// `CAIRN_JUDGE_RUN` (set by `judges/run-set.ts`) tags the lines of one set run.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { Option, Predicate, Schema } from "effect";

import { costOf, describeCost, judgeOfFile } from "../index.ts";

/** One judge run. */
export const JudgeRecord = Schema.Struct({
  judge: Schema.String,
  args: Schema.Array(Schema.String),
  commit: Schema.String,
  tree: Schema.Literals(["clean", "dirty"]),
  pass: Schema.Boolean,
  exitCode: Schema.Int,
  /** The finite numbers at the top level of the judge's last JSON line. */
  counts: Schema.Record(Schema.String, Schema.Finite),
  startedAt: Schema.String,
  endedAt: Schema.String,
  seconds: Schema.Finite,
  cost: Schema.String,
  /** The set run this line belongs to (`CAIRN_JUDGE_RUN`), or null. */
  run: Schema.NullOr(Schema.String),
});

export type JudgeRecord = typeof JudgeRecord.Type;

const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(JudgeRecord)
);

const encodeLine = Schema.encodeSync(Schema.fromJsonString(JudgeRecord));

const judgesDir = path.join(import.meta.dirname, "..");

/** The name the pre-deploy set's own line carries. */
export const SET_RECORD = "run-set";

/** Where records go: `CAIRN_JUDGE_RECORDS`, else `~/cairn-judges/records.jsonl`. */
export const recordsFile = () =>
  process.env.CAIRN_JUDGE_RECORDS ??
  path.join(homedir(), "cairn-judges", "records.jsonl");

/** The commit checked out in `dir` and whether its tree is clean; `unknown` and dirty outside git. */
export const treeState = (dir: string) => {
  const git = (args: ReadonlyArray<string>) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

  try {
    const commit = git(["rev-parse", "HEAD"]);
    const status = git(["status", "--porcelain"]);

    return { commit, tree: status === "" ? "clean" : "dirty" } as const;
  } catch {
    return { commit: "unknown", tree: "dirty" } as const;
  }
};

/** Appends `record` as one line to the records file, making its folder first. */
export const appendRecord = (record: JudgeRecord) => {
  const file = recordsFile();

  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${encodeLine(record)}\n`);
};

/** Every well-formed line of the records file, oldest first; none when it does not exist. */
export const readRecords = (file = recordsFile()) =>
  existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .flatMap((line) => Option.toArray(decodeLine(line)))
    : [];

const decodeObjectLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
);

/** The finite numbers at the top level of the last line of `output` that is a JSON object. */
export const countsOf = (output: string): Record<string, number> => {
  for (const line of output.split("\n").toReversed()) {
    const parsed = decodeObjectLine(line.trim());

    if (Option.isSome(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed.value).filter(
          (entry): entry is [string, number] =>
            Predicate.isNumber(entry[1]) && Number.isFinite(entry[1])
        )
      );
    }
  }

  return {};
};

/** What a judge file (relative to `judges/`) costs with `args`, as the record says it. */
export const costLine = (file: string, args: ReadonlyArray<string>) =>
  Option.match(judgeOfFile(file), {
    onNone: () => "unregistered",
    onSome: (judge) => describeCost(costOf(judge, args)),
  });

/** The record name of a judge file: its registry name, else its base name. */
export const nameOf = (file: string) =>
  Option.match(judgeOfFile(file), {
    onNone: () => path.basename(file).replace(/\.(?:ts|sh)$/u, ""),
    onSome: (judge) => judge.name,
  });

/** The fields of a record known when the judge ends. */
export interface RunEnd {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly commit: string;
  readonly tree: "clean" | "dirty";
  readonly exitCode: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly startedAt: Date;
  readonly endedAt: Date;
  /** The set run it belongs to, or null. */
  readonly run: string | null;
}

/** The record of a run that ended as `end` says. */
export const recordOf = (end: RunEnd): JudgeRecord => ({
  judge: nameOf(end.file),
  args: end.args,
  commit: end.commit,
  tree: end.tree,
  pass: end.exitCode === 0,
  exitCode: end.exitCode,
  counts: end.counts,
  startedAt: end.startedAt.toISOString(),
  endedAt: end.endedAt.toISOString(),
  seconds:
    Math.round((end.endedAt.getTime() - end.startedAt.getTime()) / 100) / 10,
  cost: costLine(end.file, end.args),
  run: end.run,
});

/** The set run this process belongs to: `CAIRN_JUDGE_RUN`, or null. */
export const setRunOfEnv = () => process.env.CAIRN_JUDGE_RUN ?? null;

/** How much of the judge's stdout is kept to find its last JSON line. */
const TAIL_BYTES = 256 * 1024;

/**
 * Records this judge's run when the process exits, if `meta` is the module node was asked to run.
 * The commit and tree are read now, as the run starts; the verdict is the exit code, and the counts
 * come from the last JSON line the judge wrote to stdout. A record that cannot be written is
 * reported on stderr and never changes the exit code.
 */
export const recordOnExit = (meta: ImportMeta) => {
  if (!meta.main) {
    return;
  }

  const file = path.relative(judgesDir, meta.filename);
  const args = process.argv.slice(2);
  const { commit, tree } = treeState(judgesDir);
  const startedAt = new Date();
  let tail = "";

  const write = process.stdout.write.bind(process.stdout);

  // Keeps the end of what the judge prints (console.log writes here too); everything still goes
  // out unchanged, through the same overload it was called with.
  process.stdout.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    written?: (error?: Error | null) => void
  ) => {
    tail = `${tail}${Predicate.isString(chunk) ? chunk : Buffer.from(chunk).toString("utf-8")}`;

    if (tail.length > TAIL_BYTES) {
      tail = tail.slice(-TAIL_BYTES);
    }

    return Predicate.isFunction(encoding)
      ? write(chunk, encoding)
      : write(chunk, encoding, written);
  };

  process.on("exit", (code) => {
    try {
      appendRecord(
        recordOf({
          file,
          args,
          commit,
          tree,
          exitCode: code,
          counts: countsOf(tail),
          startedAt,
          endedAt: new Date(),
          run: setRunOfEnv(),
        })
      );
    } catch (error) {
      process.stderr.write(
        `judge record not written to ${recordsFile()}: ${String(error)}\n`
      );
    }
  });
};

/** The newest record of each judge on `commit`, by judge name. */
export const lastOnCommit = (
  records: ReadonlyArray<JudgeRecord>,
  commit: string
) => {
  const last = new Map<string, JudgeRecord>();

  for (const record of records) {
    if (record.commit === commit) {
      last.set(record.judge, record);
    }
  }

  return last;
};

/** The newest record of each judge on any commit, by judge name. */
export const lastAnywhere = (records: ReadonlyArray<JudgeRecord>) => {
  const last = new Map<string, JudgeRecord>();

  for (const record of records) {
    last.set(record.judge, record);
  }

  return last;
};

/**
 * The pre-deploy set's newest record on `commit` with a clean tree, when it passed: a later failing
 * run on the same commit outweighs an earlier pass, and a run on a dirty tree judged no one commit.
 */
export const passingSet = (
  records: ReadonlyArray<JudgeRecord>,
  commit: string
) =>
  Option.filter(
    Option.fromUndefinedOr(
      records.findLast(
        (record) =>
          record.judge === SET_RECORD &&
          record.commit === commit &&
          record.tree === "clean"
      )
    ),
    (record) => record.pass
  );
