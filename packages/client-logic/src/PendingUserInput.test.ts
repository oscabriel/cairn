// Ported from github.com/pingdotgg/t3code, apps/web/src/pendingUserInput.test.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92: the same cases on Cairn's question shape. Dropped
// with the branches they judged: thread chips in answers, an initial answer kept verbatim, option
// values apart from labels, and attachment-only answers. Added: picks that are not options are
// dropped, and every answer the drafts build passes the brain's own check (`answersProblem`).
//
// MIT License. Copyright (c) 2026 T3 Tools Inc. The permission notice is in PendingUserInput.ts.

import type { Question } from "@cairn/protocol/Policy";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { answersProblem } from "./PendingRequests.ts";
import {
  buildAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  countAnswered,
  deriveProgress,
  EMPTY_DRAFT,
  firstUnansweredIndex,
  pruneResolvedDrafts,
  resolveAnswer,
  setCustomAnswer,
  toggleOption,
} from "./PendingUserInput.ts";

const singleSelect: Question = {
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    {
      label: "Orchestration-first",
      description: "Focus on orchestration first",
      recommended: false,
    },
  ],
  multiSelect: false,
  allowCustomAnswer: true,
};

const multiSelect: Question = {
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    { label: "Server", description: "Server", recommended: false },
    { label: "Web", description: "Web", recommended: false },
  ],
  multiSelect: true,
  allowCustomAnswer: true,
};

const choiceOnly: Question = {
  header: "Result",
  question: "Which result should be used?",
  options: [
    { label: "First", description: "First result", recommended: false },
    { label: "Second", description: "Second result", recommended: false },
  ],
  multiSelect: false,
  allowCustomAnswer: false,
};

const compat: Question = {
  header: "Compat",
  question: "How strict should compatibility be?",
  options: [
    {
      label: "Keep current envelope",
      description: "Preserve current wire format",
      recommended: false,
    },
  ],
  multiSelect: false,
  allowCustomAnswer: true,
};

describe(resolveAnswer, () => {
  it("prefers a custom answer over selected options", () => {
    assert.deepStrictEqual(
      resolveAnswer(
        singleSelect,
        {
          picks: ["Orchestration-first"],
          custom: "Keep the existing envelope for one release",
        },
        0
      ),
      Option.some({
        index: 0,
        picks: [],
        custom: "Keep the existing envelope for one release",
      })
    );
  });

  it("falls back to the selected option for single-select questions", () => {
    assert.deepStrictEqual(
      resolveAnswer(
        singleSelect,
        { picks: ["Orchestration-first"], custom: "" },
        0
      ),
      Option.some({ index: 0, picks: ["Orchestration-first"], custom: null })
    );
  });

  it("returns all selected labels for multi-select questions", () => {
    assert.deepStrictEqual(
      resolveAnswer(multiSelect, { picks: ["Server", "Web"], custom: "" }, 3),
      Option.some({ index: 3, picks: ["Server", "Web"], custom: null })
    );
  });

  it("does not replace a required choice with a custom answer", () => {
    assert.deepStrictEqual(
      resolveAnswer(
        choiceOnly,
        { picks: ["Second"], custom: "Use another result" },
        0
      ),
      Option.some({ index: 0, picks: ["Second"], custom: null })
    );
  });

  it("does not submit labels that are not options", () => {
    assert.isTrue(
      Option.isNone(
        resolveAnswer(choiceOnly, { picks: ["Third"], custom: "" }, 0)
      )
    );
  });

  it("trims the user's words and treats blank words as no answer", () => {
    assert.deepStrictEqual(
      resolveAnswer(compat, { picks: [], custom: "  one release\n" }, 0),
      Option.some({ index: 0, picks: [], custom: "one release" })
    );
    assert.isTrue(
      Option.isNone(resolveAnswer(compat, { picks: [], custom: " \n" }, 0))
    );
  });
});

describe(setCustomAnswer, () => {
  it("clears the preset selection when a custom answer is entered", () => {
    assert.deepStrictEqual(
      setCustomAnswer(
        multiSelect,
        { picks: ["Server", "Web"], custom: "" },
        "doesn't matter"
      ),
      { picks: [], custom: "doesn't matter" }
    );
  });

  it("keeps the picks while the words are blank", () => {
    assert.deepStrictEqual(
      setCustomAnswer(multiSelect, { picks: ["Server"], custom: "x" }, " "),
      { picks: ["Server"], custom: " " }
    );
  });

  it("leaves the draft of a question that takes no words of its own", () => {
    const draft = { picks: ["First"], custom: "" };

    assert.strictEqual(setCustomAnswer(choiceOnly, draft, "typed"), draft);
  });
});

describe(toggleOption, () => {
  it("toggles options for multi-select questions", () => {
    assert.deepStrictEqual(toggleOption(multiSelect, EMPTY_DRAFT, "Server"), {
      picks: ["Server"],
      custom: "",
    });
    assert.deepStrictEqual(
      toggleOption(
        multiSelect,
        { picks: ["Server", "Web"], custom: "" },
        "Server"
      ),
      { picks: ["Web"], custom: "" }
    );
  });

  it("replaces the pick and clears the words on a single-select question", () => {
    assert.deepStrictEqual(
      toggleOption(choiceOnly, { picks: ["First"], custom: "typed" }, "Second"),
      { picks: ["Second"], custom: "" }
    );
  });
});

describe(buildAnswers, () => {
  it("returns every answer for complete prompts", () => {
    assert.deepStrictEqual(
      buildAnswers([singleSelect, compat], {
        "0": { picks: ["Orchestration-first"], custom: "" },
        "1": {
          picks: [],
          custom: "Keep the current envelope for one release window",
        },
      }),
      Option.some([
        { index: 0, picks: ["Orchestration-first"], custom: null },
        {
          index: 1,
          picks: [],
          custom: "Keep the current envelope for one release window",
        },
      ])
    );
  });

  it("returns arrays for answered multi-select prompts", () => {
    assert.deepStrictEqual(
      buildAnswers([multiSelect], {
        "0": { picks: ["Server", "Web"], custom: "" },
      }),
      Option.some([{ index: 0, picks: ["Server", "Web"], custom: null }])
    );
  });

  it("returns none when any question is unanswered", () => {
    assert.isTrue(Option.isNone(buildAnswers([singleSelect], {})));
  });

  it("builds only answers the brain accepts", () => {
    const questions = [singleSelect, multiSelect, choiceOnly, compat];

    const drafts = {
      "0": toggleOption(singleSelect, EMPTY_DRAFT, "Orchestration-first"),
      "1": toggleOption(
        multiSelect,
        toggleOption(multiSelect, EMPTY_DRAFT, "Web"),
        "Server"
      ),
      "2": setCustomAnswer(
        choiceOnly,
        toggleOption(choiceOnly, EMPTY_DRAFT, "First"),
        "not allowed here"
      ),
      "3": setCustomAnswer(compat, EMPTY_DRAFT, "strict"),
    };

    const answers = buildAnswers(questions, drafts);

    assert.isTrue(Option.isSome(answers));
    assert.isTrue(
      Option.isNone(
        answersProblem(
          questions,
          Option.getOrElse(answers, () => [])
        )
      )
    );
  });
});

describe("question progress", () => {
  const questions = [singleSelect, compat];

  it("counts only answered questions", () => {
    assert.strictEqual(
      countAnswered(questions, {
        "0": { picks: ["Orchestration-first"], custom: "" },
      }),
      1
    );
  });

  it("finds the first unanswered question", () => {
    assert.strictEqual(
      firstUnansweredIndex(questions, {
        "0": { picks: ["Orchestration-first"], custom: "" },
      }),
      1
    );
  });

  it("returns the last question index when all answers are complete", () => {
    assert.strictEqual(
      firstUnansweredIndex(questions, {
        "0": { picks: ["Orchestration-first"], custom: "" },
        "1": { picks: [], custom: "Keep it for one release window" },
      }),
      1
    );
  });

  it("derives the active question and advancement state", () => {
    const progress = deriveProgress(
      questions,
      { "0": { picks: ["Orchestration-first"], custom: "" } },
      0
    );

    assert.strictEqual(progress.questionIndex, 0);
    assert.deepStrictEqual(progress.activeQuestion, Option.some(singleSelect));
    assert.deepStrictEqual(progress.picks, ["Orchestration-first"]);
    assert.strictEqual(progress.custom, "");
    assert.deepStrictEqual(
      progress.resolvedAnswer,
      Option.some({ index: 0, picks: ["Orchestration-first"], custom: null })
    );
    assert.strictEqual(progress.answeredCount, 1);
    assert.isFalse(progress.isLastQuestion);
    assert.isFalse(progress.isComplete);
    assert.isTrue(progress.canAdvance);
  });

  it("keeps the index inside the questions", () => {
    assert.strictEqual(deriveProgress(questions, {}, 7).questionIndex, 1);
    assert.strictEqual(deriveProgress(questions, {}, -2).questionIndex, 0);
    assert.isTrue(Option.isNone(deriveProgress([], {}, 0).activeQuestion));
  });

  it("treats multi-select questions as answered when they have selected options", () => {
    const progress = deriveProgress(
      [multiSelect],
      { "0": { picks: ["Server", "Web"], custom: "" } },
      0
    );

    assert.deepStrictEqual(progress.picks, ["Server", "Web"]);
    assert.isTrue(progress.canAdvance);
    assert.isTrue(progress.isComplete);
    assert.isTrue(progress.isLastQuestion);
  });

  it("requires an option when custom answers are disabled", () => {
    const drafts = { "0": { picks: [], custom: "Use another result" } };

    assert.isTrue(Option.isNone(buildAnswers([choiceOnly], drafts)));

    const progress = deriveProgress([choiceOnly], drafts, 0);

    assert.strictEqual(progress.custom, "");
    assert.isFalse(progress.usingCustomAnswer);
    assert.isTrue(Option.isNone(progress.resolvedAnswer));
    assert.strictEqual(progress.answeredCount, 0);
    assert.isFalse(progress.canAdvance);
    assert.isFalse(progress.isComplete);
  });
});

describe(pruneResolvedDrafts, () => {
  it("drops drafts of requests that are no longer pending", () => {
    assert.deepStrictEqual(
      pruneResolvedDrafts({ a: 1, b: 2, c: 3 }, ["a", "c"]),
      { a: 1, c: 3 }
    );
  });

  it("returns unchanged input as is", () => {
    const drafts = { a: 1 };

    assert.strictEqual(pruneResolvedDrafts(drafts, ["a", "b"]), drafts);
  });
});

describe(carryDisplacedCustomAnswerIntoPrompt, () => {
  it("keeps the thread draft when nothing was typed into the answer", () => {
    assert.strictEqual(
      carryDisplacedCustomAnswerIntoPrompt("draft", ""),
      "draft"
    );
    assert.strictEqual(
      carryDisplacedCustomAnswerIntoPrompt("draft", "   "),
      "draft"
    );
  });

  it("moves the typed answer into an empty thread draft", () => {
    assert.strictEqual(
      carryDisplacedCustomAnswerIntoPrompt("", "also rename the flag "),
      "also rename the flag"
    );
  });

  it("appends the typed answer after an existing thread draft", () => {
    assert.strictEqual(
      carryDisplacedCustomAnswerIntoPrompt("first half\n", "second half"),
      "first half\n\nsecond half"
    );
  });
});
