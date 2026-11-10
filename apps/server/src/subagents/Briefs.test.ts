// How a spawn's brief says its result will be judged (V-9, ADR 0055): a `done_when` command is
// frozen as a command criterion the card shows and the child is told to run; without one the
// parent accepts the result; a `done_when` that is not a command is refused with the words the
// model reads.

import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { renderBrief, SubagentToolText } from "../brain/SubagentText.ts";
import { briefOf, DONE_WHEN_TIMEOUT_SEC, PARENT_ACCEPTS } from "./Briefs.ts";
import type { SpawnArguments } from "./Briefs.ts";

const spawn = (doneWhen: Option.Option<ReadonlyArray<string>>) =>
  briefOf(
    {
      description: "Fix the parser",
      brief: "Make the parser's tests pass.",
      why: Option.none(),
      isolation: Option.some("worktree"),
      resultSchema: Option.none(),
      wake: Option.none(),
      model: Option.none(),
      doneWhen,
    } satisfies SpawnArguments,
    "auto-accept-edits"
  );

describe("a brief's done_when (V-9)", () => {
  it("freezes the parent's command as a command criterion, and tells the child to run it", () => {
    const brief = Result.getOrThrow(spawn(Option.some(["pnpm", "test"])));

    assert.deepStrictEqual(brief.doneWhen, [
      {
        text: "`pnpm test` exits 0",
        judge: {
          kind: "command",
          argv: ["pnpm", "test"],
          expectExit: 0,
          timeoutSec: DONE_WHEN_TIMEOUT_SEC,
        },
      },
    ]);
    assert.include(
      renderBrief(brief),
      "Done when: `pnpm test` exits 0. Run it in your workspace before you report"
    );
  });

  it("without one, the parent accepts the result, and the child's brief names no command", () => {
    const brief = Result.getOrThrow(spawn(Option.none()));

    assert.deepStrictEqual(brief.doneWhen, [
      { text: PARENT_ACCEPTS, judge: { kind: "user" } },
    ]);
    assert.notInclude(renderBrief(brief), "Done when");
  });

  it("refuses a done_when that is not a command", () => {
    assert.deepStrictEqual(
      [Option.some([]), Option.some(["pnpm", " "])].map((argv) =>
        Result.match(spawn(argv), {
          onFailure: (why) => why,
          onSuccess: () => "",
        })
      ),
      [SubagentToolText.doneWhenInvalid, SubagentToolText.doneWhenInvalid]
    );
  });
});
