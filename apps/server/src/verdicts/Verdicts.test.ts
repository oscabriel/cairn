// The verdict writer (ADR 0026): who may write a goal, and what a binding, a verdict and a mark do.
//
// The architecture check is the briefs note's: outside `verdicts/Verdicts.ts`, no server module
// (nor a judge) opens `cairn.goal` for writing, defines a document of its kind, sets a criterion
// `met` or writes a verdict. It is first shown to catch each planted violation, then run over the
// server's source and the judges.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { GoalDocument } from "@cairn/protocol/Policy";
import type { CriterionProposal, JudgeRef } from "@cairn/protocol/Policy";
import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { judgeState, NO_GOAL } from "./GoalDocs.ts";
import type { GoalState, VerdictState } from "./GoalDocs.ts";
import {
  applyBind,
  applyMark,
  applyVerdict,
  BindOutcome,
  MAX_CRITERIA,
} from "./Verdicts.ts";

const WRITER = path.join("verdicts", "Verdicts.ts");

const DOCS = path.join("verdicts", "GoalDocs.ts");

/** Every way a module could write a goal around the writer, described. */
const goalWrites = (file: string, source: string): ReadonlyArray<string> => {
  const found: Array<string> = [];

  if (file.endsWith(WRITER)) {
    return found;
  }

  if (/\.doc\(\s*GoalDoc\b/u.test(source)) {
    found.push("opens cairn.goal for writing");
  }

  if (
    !file.endsWith(DOCS) &&
    (/kind:\s*GOAL_DOCUMENT/u.test(source) || /"cairn\.goal"/u.test(source))
  ) {
    found.push("defines or names cairn.goal");
  }

  if (/\.state\s*=\s*"met"/u.test(source) || /\bstate:\s*"met"/u.test(source)) {
    found.push("sets a criterion met");
  }

  if (/\.verdict\s*=(?!=)/u.test(source)) {
    found.push("writes a verdict");
  }

  if (/\.tries\s*(?:\+\+|\+=|-=|=(?!=))/u.test(source)) {
    found.push("counts a try");
  }

  return found;
};

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);

    if (statSync(full).isDirectory()) {
      return name === "node_modules" ? [] : sources(full);
    }

    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });

const command = (argv: ReadonlyArray<string>, expectExit = 0): JudgeRef => ({
  kind: "command",
  argv: [argv[0] ?? "true", ...argv.slice(1)],
  expectExit,
  timeoutSec: 60,
});

const proposal = (text: string, judge: JudgeRef): CriterionProposal => ({
  text,
  judge,
});

const USER: JudgeRef = { kind: "user" };

const verdict = (
  judge: JudgeRef,
  ok: boolean,
  runId: string,
  at = 200
): VerdictState => ({
  at,
  ok,
  judge: judgeState(judge),
  evidence: {
    exit: ok ? 0 : 1,
    tail: null,
    sha: null,
    model: null,
    note: null,
  },
  runId,
});

/** A goal holding `criteria`, bound at `now`. */
const goalWith = (
  criteria: ReadonlyArray<CriterionProposal>,
  now = 100
): GoalState => {
  const goal = NO_GOAL();

  applyBind(
    goal,
    { objective: Option.some("Ship it"), criteria, mode: "replace" },
    now
  );

  return goal;
};

const decodeGoal = Schema.decodeUnknownOption(GoalDocument);

describe("who writes a goal", () => {
  it("catches each planted write outside the verdict writer", () => {
    const at = path.join("apps", "server", "src", "elsewhere", "Mine.ts");

    assert.deepStrictEqual(
      goalWrites(at, "const goal = await tx.doc(GoalDoc, id);"),
      ["opens cairn.goal for writing"]
    );
    assert.deepStrictEqual(
      goalWrites(at, 'const D = defineDoc({ kind: "cairn.goal" });'),
      ["defines or names cairn.goal"]
    );
    assert.deepStrictEqual(goalWrites(at, 'criterion.state = "met";'), [
      "sets a criterion met",
    ]);
    assert.deepStrictEqual(
      goalWrites(at, 'goal.criteria.push({ id, state: "met" });'),
      ["sets a criterion met"]
    );
    assert.deepStrictEqual(goalWrites(at, "criterion.verdict = found;"), [
      "writes a verdict",
    ]);
    assert.deepStrictEqual(goalWrites(at, "criterion.tries += 1;"), [
      "counts a try",
    ]);
    assert.deepStrictEqual(
      goalWrites(
        at,
        'if (criterion.state === "met" && criterion.verdict === null) {}'
      ),
      []
    );
    assert.deepStrictEqual(
      goalWrites(
        path.join("apps", "server", "src", WRITER),
        'criterion.state = "met"; criterion.verdict = v; await tx.doc(GoalDoc, id);'
      ),
      []
    );
  });

  it("finds none in the server or the judges", () => {
    const root = path.join(import.meta.dirname, "..", "..", "..", "..");

    const files = [
      ...sources(path.join(root, "apps", "server", "src")),
      ...sources(path.join(root, "judges")),
    ];

    assert.isAbove(files.length, 100);

    const found = files.flatMap((file) =>
      goalWrites(file, readFileSync(file, "utf-8")).map(
        (write) => `${path.relative(root, file)}: ${write}`
      )
    );

    assert.deepStrictEqual(found, []);
  });
});

describe("binding criteria", () => {
  it("binds new criteria open, with fresh ids, and decodes as the protocol's goal", () => {
    const goal = goalWith([
      proposal("Tests pass", command(["npm", "test"])),
      proposal("The user likes it", USER),
    ]);

    assert.deepStrictEqual(
      goal.criteria.map((criterion) => [
        criterion.id,
        criterion.state,
        criterion.tries,
        criterion.changedAt,
      ]),
      [
        ["c1", "open", 0, 100],
        ["c2", "open", 0, 100],
      ]
    );
    assert.strictEqual(goal.objective, "Ship it");
    assert.isTrue(Option.isSome(decodeGoal(goal)));
  });

  it("keeps a criterion bound again with the same words and judge, with its verdict", () => {
    const goal = goalWith([
      proposal("Tests pass", command(["npm", "test"])),
      proposal("Lint is clean", command(["npm", "run", "lint"])),
    ]);

    applyVerdict(goal, {
      criterionId: "c1",
      changedAt: 100,
      verdict: verdict(command(["npm", "test"]), true, "judge-1"),
    });

    const outcome = applyBind(
      goal,
      {
        objective: Option.none(),
        criteria: [
          proposal("Tests pass", command(["npm", "test"])),
          proposal("Docs build", command(["npm", "run", "docs"])),
        ],
        mode: "replace",
      },
      300
    );

    assert.deepStrictEqual(
      outcome,
      BindOutcome.Bound({ kept: ["c1"], added: ["c3"], removed: ["c2"] })
    );
    assert.deepStrictEqual(
      goal.criteria.map((criterion) => [
        criterion.id,
        criterion.state,
        criterion.changedAt,
      ]),
      [
        ["c1", "met", 100],
        ["c3", "open", 300],
      ]
    );
    assert.strictEqual(goal.objective, "Ship it");
  });

  it("treats a changed judge as a new criterion, open until judged", () => {
    const goal = goalWith([proposal("Tests pass", command(["npm", "test"]))]);

    applyVerdict(goal, {
      criterionId: "c1",
      changedAt: 100,
      verdict: verdict(command(["npm", "test"]), true, "judge-1"),
    });
    applyBind(
      goal,
      {
        objective: Option.none(),
        criteria: [proposal("Tests pass", command(["true"]))],
        mode: "replace",
      },
      300
    );

    assert.deepStrictEqual(
      goal.criteria.map((criterion) => [criterion.id, criterion.state]),
      [["c2", "open"]]
    );
  });

  it("appends an approval's criteria, leaving duplicates out", () => {
    const goal = goalWith([proposal("Tests pass", command(["npm", "test"]))]);

    const outcome = applyBind(
      goal,
      {
        objective: Option.none(),
        criteria: [
          proposal("Tests pass", command(["npm", "test"])),
          proposal("The user likes it", USER),
        ],
        mode: "append",
      },
      300
    );

    assert.deepStrictEqual(
      outcome,
      BindOutcome.Bound({ kept: ["c1"], added: ["c2"], removed: [] })
    );
    assert.strictEqual(goal.criteria.length, 2);
  });

  it("refuses more than the most a goal holds and changes nothing", () => {
    const goal = goalWith([proposal("Tests pass", command(["npm", "test"]))]);

    const many = Array.from({ length: MAX_CRITERIA }, (_, n) =>
      proposal(`Criterion ${String(n)}`, USER)
    );

    const outcome = applyBind(
      goal,
      { objective: Option.none(), criteria: many, mode: "append" },
      300
    );

    assert.deepStrictEqual(
      outcome,
      BindOutcome.TooMany({ total: MAX_CRITERIA + 1 })
    );
    assert.strictEqual(goal.criteria.length, 1);
  });
});

describe("recording verdicts", () => {
  it("sets met on an ok verdict and failed on another, a try each", () => {
    const judge = command(["npm", "test"]);
    const goal = goalWith([proposal("Tests pass", judge)]);

    assert.strictEqual(
      applyVerdict(goal, {
        criterionId: "c1",
        changedAt: 100,
        verdict: verdict(judge, false, "judge-1"),
      }),
      "recorded"
    );
    assert.strictEqual(goal.criteria[0]?.state, "failed");

    assert.strictEqual(
      applyVerdict(goal, {
        criterionId: "c1",
        changedAt: 100,
        verdict: verdict(judge, true, "judge-2"),
      }),
      "recorded"
    );
    assert.strictEqual(goal.criteria[0]?.state, "met");
    assert.strictEqual(goal.criteria[0]?.tries, 2);
    assert.strictEqual(goal.criteria[0]?.verdict?.runId, "judge-2");
  });

  it("records one run once", () => {
    const judge = command(["npm", "test"]);
    const goal = goalWith([proposal("Tests pass", judge)]);

    const input = {
      criterionId: "c1",
      changedAt: 100,
      verdict: verdict(judge, true, "judge-1"),
    };

    applyVerdict(goal, input);

    assert.strictEqual(applyVerdict(goal, input), "duplicate");
    assert.strictEqual(goal.criteria[0]?.tries, 1);
  });

  it("records nothing for a criterion changed since the run was queued", () => {
    const judge = command(["npm", "test"]);
    const goal = goalWith([proposal("Tests pass", judge)]);

    assert.strictEqual(
      applyVerdict(goal, {
        criterionId: "c1",
        changedAt: 99,
        verdict: verdict(judge, true, "judge-1"),
      }),
      "stale"
    );
    assert.strictEqual(
      applyVerdict(goal, {
        criterionId: "c1",
        changedAt: 100,
        verdict: verdict(command(["true"]), true, "judge-1"),
      }),
      "stale"
    );
    assert.strictEqual(
      applyVerdict(goal, {
        criterionId: "c9",
        changedAt: 100,
        verdict: verdict(judge, true, "judge-1"),
      }),
      "stale"
    );
    assert.strictEqual(goal.criteria[0]?.state, "open");
  });

  it("takes the user's mark only on a criterion the user judges", () => {
    const goal = goalWith([
      proposal("Tests pass", command(["npm", "test"])),
      proposal("The user likes it", USER),
    ]);

    assert.strictEqual(
      applyMark(goal, {
        criterionId: "c1",
        ok: true,
        note: Option.none(),
        at: 200,
      }),
      "not_user_judge"
    );
    assert.strictEqual(goal.criteria[0]?.state, "open");

    assert.strictEqual(
      applyMark(goal, {
        criterionId: "c2",
        ok: true,
        note: Option.some("Looks right"),
        at: 200,
      }),
      "recorded"
    );
    assert.strictEqual(goal.criteria[1]?.state, "met");
    assert.strictEqual(goal.criteria[1]?.verdict?.evidence.note, "Looks right");
    assert.strictEqual(
      applyMark(goal, {
        criterionId: "c7",
        ok: true,
        note: Option.none(),
        at: 200,
      }),
      "not_found"
    );
    assert.isTrue(Option.isSome(decodeGoal(goal)));
  });
});
