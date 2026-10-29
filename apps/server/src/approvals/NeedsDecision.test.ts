// Ported from github.com/HazAT/ultimate, test/triage.test.ts at
// 8b26338680fc5bc970b68c281c4e9b03a09887c1: the endings of real coordinator messages, kept as
// cases. Changed: written with @effect/vitest, plus Cairn's own cases (a plain result, an empty
// answer, a trailing question mark inside emphasis).
//
// MIT License. Copyright (c) 2026 Daniel Griesser.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { assert, describe, it } from "@effect/vitest";

import { decisionOptions, needsDecision } from "./NeedsDecision.ts";

const PLAN_STEPS = [
  "Waiting on worker #293632. When it reports, I'll:\n1. Read its diff and rerun `pnpm check`, `pnpm test` and the messaging e2e tests.\n2. Compare the after screenshots against the before ones.\n3. Run a review, then `workspace submit`.",
  "Once it has landed, I'll:\n1. Update this branch to that main.\n2. Brief one worker with the rename and the cleanup.\n3. Verify with `pnpm check`, `pnpm test`, the messaging e2e tests (including `board-remote`) and before-and-after faux screenshots of #97078.\n4. Run a review, then `workspace submit`.",
  "Still waiting on #250944. Once it reports, a quick re-review of that one fix, then:\n1. Submit this branch.\n2. Deploy the Worker when the client change lands.\n3. Run `pnpm fleet:e2e` against the real Worker with a throwaway project, then clean up.\n4. Ask the coordinator for the restart.",
  "I'm waiting on reviewer #254538's final check of both repos. If it approves:\n1. I submit this branch.\n2. I deploy the Worker when the change lands.\n3. I run `pnpm fleet:e2e` on real infrastructure with a throwaway project, then clean up after it.\n4. I ask the coordinator for the restart.",
  "Reviewer #253701 is re-checking the fixes in both repos. I'm waiting for its verdict. If it approves:\n1. `workspace submit`;\n2. deploy the new Worker, at the same moment the client change lands;\n3. run `pnpm fleet:e2e` on real infrastructure and clean up after it;\n4. ask the coordinator for the restart.",
];

const DECISIONS = [
  "Shall I submit?\n1. Approve: I run `workspace submit` and stop the preview.\n2. Change something first (wording, how quiet the item is, the phone icon).",
  "**Checks:** pnpm check passes. I'll submit only after its verdict and the user's approval.\n\n1. Approve round 2 as shown.\n2. Change something first (say what).",
  "I'm waiting for two things:\n- **Your decision**, relayed through the coordinator:\n  1. Approve round 2 as shown. I submit once the review is clean.\n  2. Change something first; say what.",
  "## Decisions\n1. Fix:\n   1. Anchoring off only while following (recommended).\n   2. `overflow-anchor: none` always.\n2. Go:\n   1. Build it in this branch.\n   2. First catch a real failure on #97078 during a live run.",
  "**Decisions:**\n1. **Build:** (a) the `pnpm reset` script (recommended); (b) only the documented recipe.",
  "Next steps:\n1. **Scope:** (a) fallback only; (b) fallback and setup check.\n2. **Go:** (a) build it; (b) wait.",
  "Merged the worker. Land it now?",
  "Two folders hold sources. Which one should I count, **src or lib?**",
];

const RESULTS = [
  "src has 12 files.",
  "",
  "Done. Is it fine? I checked: it is.",
  "The steps were:\n1. Read the folder.\n2. Count the files.\nsrc has 12 files.",
];

describe(needsDecision, () => {
  it.each(PLAN_STEPS.map((text, index) => [index, text] as const))(
    "reads plan steps after a colon as no decision (%i)",
    (_index, text) => {
      assert.isFalse(needsDecision(text));
    }
  );

  it.each(DECISIONS.map((text, index) => [index, text] as const))(
    "reads a question or options as a decision (%i)",
    (_index, text) => {
      assert.isTrue(needsDecision(text));
    }
  );

  it.each(RESULTS.map((text, index) => [index, text] as const))(
    "reads a plain result as no decision (%i)",
    (_index, text) => {
      assert.isFalse(needsDecision(text));
    }
  );
});

/** Cairn's own: the options a relayed question offers as picks, from the list an answer ends with. */
const OPTIONS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["Which folder should I count?\n1. src\n2. lib", ["src", "lib"]],
  ["Pick one:\n1) fast\n2) safe\n3) both", ["fast", "safe", "both"]],
  ["Which one?\n1. src\n2. lib\n\n", ["src", "lib"]],
  ["Which one?\n2. src\n3. lib", []],
  ["Which one?\n1. src\n3. lib", []],
  ["Which one?\n1. src", []],
  ["Which one?\n1. src\n2. lib\nTell me.", []],
  ["Which folder, src or lib?", []],
  ["", []],
];

describe(decisionOptions, () => {
  it.each(
    OPTIONS.map(([text, options], index) => [index, text, options] as const)
  )(
    "reads the trailing numbered list as options (%i)",
    (_index, text, options) => {
      assert.deepStrictEqual(decisionOptions(text), options);
    }
  );
});
