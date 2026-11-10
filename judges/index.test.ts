// The registry rule (ADR 0054): every judge file at the top of `judges/` (a `.ts` or `.sh`, not
// `lib/`, `fixtures/` or `look/`) has an entry in `judges/index.ts`, every entry names files that
// exist, and the pre-deploy set holds only free judges that need no deployed brain, Docker or porch.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { costOf, JUDGES, judgeNamed, SET, TOOLS } from "./index.ts";

const here = import.meta.dirname;

const topLevelFiles = readdirSync(here, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:ts|sh)$/u.test(entry.name))
  .map((entry) => entry.name);

const registered = new Set(JUDGES.flatMap((judge) => judge.files));

describe("the judge registry", () => {
  it("has an entry for every judge file at the top of judges/", () => {
    const missing = topLevelFiles.filter(
      (file) => !registered.has(file) && !TOOLS.includes(file)
    );

    assert.deepStrictEqual(
      missing,
      [],
      "add each to JUDGES in judges/index.ts: what it proves, how it runs, its cost, needs and control"
    );
  });

  it("names only files that exist", () => {
    const gone = [...registered, ...TOOLS].filter(
      (file) => !existsSync(path.join(here, file))
    );

    assert.deepStrictEqual(gone, []);
  });

  it("names each judge once, after its first file", () => {
    const names = JUDGES.map((judge) => judge.name);

    assert.strictEqual(new Set(names).size, names.length);

    for (const judge of JUDGES) {
      const first = judge.files[0] ?? "";

      assert.strictEqual(
        judge.name,
        path.basename(first).replace(/\.(?:ts|sh)$/u, ""),
        first
      );
    }

    assert.strictEqual(
      new Set(registered).size,
      JUDGES.flatMap((judge) => judge.files).length,
      "a file belongs to one judge"
    );
  });

  it("states what each judge proves and its broken control or none", () => {
    for (const judge of JUDGES) {
      assert.isAbove(judge.proves.length, 20, judge.name);
      assert.isAbove(judge.control.length, 3, judge.name);
      assert.isAbove(judge.runs.length, 0, judge.name);
    }
  });
});

describe("the pre-deploy set", () => {
  it("is exactly the judges that say they run in it", () => {
    const named = new Set(SET.map((run) => run.judge));

    const marked = JUDGES.filter((judge) => judge.runs.includes("set")).map(
      (judge) => judge.name
    );

    assert.deepStrictEqual([...named].toSorted(), marked.toSorted());
  });

  it("runs only free judges that need no deployed brain, Docker or porch", () => {
    for (const run of SET) {
      const judge = judgeNamed(run.judge);

      assert.isTrue(Option.isSome(judge), run.judge);

      if (Option.isNone(judge)) {
        continue;
      }

      assert.strictEqual(costOf(judge.value, run.args), "free", run.judge);
      assert.deepStrictEqual(
        judge.value.needs.filter((need) => need !== "browser"),
        [],
        run.judge
      );
    }
  });
});
