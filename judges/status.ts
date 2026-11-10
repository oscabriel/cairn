// The judges' status (ADR 0054): the registry (`judges/index.ts`) joined with each judge's last
// record (`judges/lib/Record.ts`) on a commit, so a handoff can quote what passed on what it hands
// over, and what has no record at all.
//
//   node judges/status.ts [--commit <rev>] [--json]
//   node judges/status.ts --require-set <rev>
//
// One line per judge: its name, how it runs, its cost, what it needs, its last record on the commit
// (default HEAD), else its newest record on another commit, else "no record". A judge run with
// several argument lists on the commit shows the newest failure among each list's newest run, so a
// later pass with other arguments never hides one; a run another judge started (`shutdown.sh`'s
// durability windows) is not the judge's own and is left out. In-gate judges have no records:
// `pnpm check` is their record. `--json` prints the same as one JSON object.
//
// `--require-set` is `ops/cairn/deploy.sh`'s check: exit 0 and one line when the pre-deploy set
// (`judges/run-set.ts`) passed on that commit with a clean tree, else exit 1 and say what is
// missing. Reads `CAIRN_JUDGE_RECORDS` or `~/cairn-judges/records.jsonl`; writes nothing.

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { Option } from "effect";

import { describeCost, JUDGES } from "./index.ts";
import type { Judge } from "./index.ts";
import {
  lastAnywhere,
  lastOnCommit,
  passingSet,
  readRecords,
  recordsFile,
  SET_RECORD,
  worstOf,
} from "./lib/Record.ts";
import type { JudgeRecord } from "./lib/Record.ts";

const { values } = parseArgs({
  options: {
    commit: { type: "string", default: "HEAD" },
    json: { type: "boolean", default: false },
    "require-set": { type: "string" },
  },
});

/** The full sha `rev` names in this checkout; exits 2 when git cannot resolve it. */
const resolve = (rev: string) => {
  try {
    return execFileSync(
      "git",
      ["-C", import.meta.dirname, "rev-parse", "--verify", `${rev}^{commit}`],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    process.stderr.write(`${rev} is not a commit in this checkout\n`);

    return process.exit(2);
  }
};

const records = readRecords();

const short = (sha: string) => sha.slice(0, 7);

const verdictOf = (record: JudgeRecord) =>
  `${record.pass ? "pass" : "FAIL"} ${record.endedAt.slice(0, 16).replace("T", " ")}Z${record.tree === "dirty" ? " (dirty tree)" : ""}`;

if (values["require-set"] !== undefined) {
  const commit = resolve(values["require-set"]);
  const passed = passingSet(records, commit);

  if (Option.isSome(passed)) {
    process.stdout.write(
      `the judge set passed on ${short(commit)} at ${passed.value.endedAt} (${String(passed.value.counts.passed ?? "?")} judges)\n`
    );
    process.exit(0);
  }

  const latest = worstOf(lastOnCommit(records, commit).get(SET_RECORD) ?? []);

  process.stderr.write(
    `no passing judge set is recorded for ${short(commit)} on a clean tree in ${recordsFile()}${Option.isNone(latest) ? "" : ` (its last set run: ${verdictOf(latest.value)})`}; run node judges/run-set.ts on that commit first\n`
  );
  process.exit(1);
}

const commit = resolve(values.commit);

const here = lastOnCommit(records, commit);

const anywhere = lastAnywhere(records);

const lastOf = (judge: Judge) => {
  if (judge.runs.includes("check")) {
    return "in pnpm check";
  }

  const runs = here.get(judge.name) ?? [];
  const worst = worstOf(runs);

  if (Option.isSome(worst)) {
    const failed = runs.filter((record) => !record.pass).length;

    const args =
      runs.length > 1 || worst.value.args.length > 0
        ? ` (${[judge.name, ...worst.value.args].join(" ")})`
        : "";

    const of =
      runs.length > 1
        ? `; ${String(failed)} of ${String(runs.length)} argument lists failed`
        : "";

    return `${verdictOf(worst.value)}${args}${of}`;
  }

  const elsewhere = anywhere.get(judge.name);

  return elsewhere === undefined
    ? "no record"
    : `none here; last ${verdictOf(elsewhere)} on ${short(elsewhere.commit)}`;
};

/** `free` or `paid`, with the flags that change it. */
const costWord = (judge: Judge) => {
  const word = judge.cost.default === "free" ? "free" : "paid";
  const flags = judge.cost.switches.map((change) => change.flag).join(" ");

  return flags === ""
    ? word
    : `${word} (${word === "free" ? "paid" : "free"} with ${flags})`;
};

const rows = JUDGES.map((judge) => ({
  name: judge.name,
  runs: judge.runs.join(","),
  cost: describeCost(judge.cost.default),
  costWord: costWord(judge),
  needs: judge.needs.join(",") || "-",
  control: judge.control,
  last: lastOf(judge),
}));

if (values.json) {
  process.stdout.write(
    `${JSON.stringify({ commit, records: recordsFile(), judges: rows })}\n`
  );
} else {
  process.stdout.write(
    `judges on ${short(commit)} (records: ${recordsFile()})\n`
  );

  for (const row of rows) {
    process.stdout.write(
      `${row.name.padEnd(24)} ${row.runs.padEnd(20)} ${row.costWord.padEnd(28)} ${row.needs.padEnd(16)} ${row.last}\n`
    );
  }

  const gaps = JUDGES.filter((judge) => judge.control === "none").map(
    (judge) => judge.name
  );

  process.stdout.write(
    `\n${String(gaps.length)} judges have no broken control: ${gaps.join(", ")}\n`
  );
}
