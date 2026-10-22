// The tree cases are ported from github.com/pingdotgg/t3code, apps/web/src/lib/turnDiffTree.test.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: every file carries numbers (t3code's
// "only numeric stats" case is now a sum over zero stats). Cairn's own cases cover the patch
// parser and the checkpoint entry decoder.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
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
import { Option } from "effect";

import {
  buildTurnDiffTree,
  checkpointSummaryOf,
  parsePatch,
  summarizeTurnDiffStats,
} from "./DiffTree.ts";

describe(summarizeTurnDiffStats, () => {
  it("sums every file's stats", () => {
    assert.deepStrictEqual(
      summarizeTurnDiffStats([
        { path: "README.md", additions: 3, deletions: 1 },
        { path: "docs/notes.md", additions: 0, deletions: 0 },
        { path: "src/index.ts", additions: 5, deletions: 2 },
      ]),
      { additions: 8, deletions: 3 }
    );
  });
});

describe(buildTurnDiffTree, () => {
  it("builds nested directory nodes with aggregated stats", () => {
    assert.deepStrictEqual(
      buildTurnDiffTree([
        { path: "src/index.ts", additions: 2, deletions: 1 },
        { path: "src/components/Button.tsx", additions: 4, deletions: 2 },
        { path: "README.md", additions: 1, deletions: 0 },
      ]),
      [
        {
          kind: "directory",
          name: "src",
          path: "src",
          stat: { additions: 6, deletions: 3 },
          children: [
            {
              kind: "directory",
              name: "components",
              path: "src/components",
              stat: { additions: 4, deletions: 2 },
              children: [
                {
                  kind: "file",
                  name: "Button.tsx",
                  path: "src/components/Button.tsx",
                  stat: { additions: 4, deletions: 2 },
                },
              ],
            },
            {
              kind: "file",
              name: "index.ts",
              path: "src/index.ts",
              stat: { additions: 2, deletions: 1 },
            },
          ],
        },
        {
          kind: "file",
          name: "README.md",
          path: "README.md",
          stat: { additions: 1, deletions: 0 },
        },
      ]
    );
  });

  it("keeps zero-valued file stats", () => {
    assert.deepStrictEqual(
      buildTurnDiffTree([
        { path: "docs/notes.md", additions: 0, deletions: 0 },
        { path: "docs/todo.md", additions: 1, deletions: 1 },
      ]),
      [
        {
          kind: "directory",
          name: "docs",
          path: "docs",
          stat: { additions: 1, deletions: 1 },
          children: [
            {
              kind: "file",
              name: "notes.md",
              path: "docs/notes.md",
              stat: { additions: 0, deletions: 0 },
            },
            {
              kind: "file",
              name: "todo.md",
              path: "docs/todo.md",
              stat: { additions: 1, deletions: 1 },
            },
          ],
        },
      ]
    );
  });

  it("normalizes file paths with windows separators", () => {
    assert.deepStrictEqual(
      buildTurnDiffTree([
        { path: "apps\\web\\src\\index.ts", additions: 2, deletions: 1 },
      ]),
      [
        {
          kind: "directory",
          name: "apps/web/src",
          path: "apps/web/src",
          stat: { additions: 2, deletions: 1 },
          children: [
            {
              kind: "file",
              name: "index.ts",
              path: "apps/web/src/index.ts",
              stat: { additions: 2, deletions: 1 },
            },
          ],
        },
      ]
    );
  });

  it("compacts only single-directory chains and stops at branch points", () => {
    assert.deepStrictEqual(
      buildTurnDiffTree([
        { path: "apps/server/src/index.ts", additions: 2, deletions: 1 },
        { path: "apps/server/main.ts", additions: 4, deletions: 0 },
      ]),
      [
        {
          kind: "directory",
          name: "apps/server",
          path: "apps/server",
          stat: { additions: 6, deletions: 1 },
          children: [
            {
              kind: "directory",
              name: "src",
              path: "apps/server/src",
              stat: { additions: 2, deletions: 1 },
              children: [
                {
                  kind: "file",
                  name: "index.ts",
                  path: "apps/server/src/index.ts",
                  stat: { additions: 2, deletions: 1 },
                },
              ],
            },
            {
              kind: "file",
              name: "main.ts",
              path: "apps/server/main.ts",
              stat: { additions: 4, deletions: 0 },
            },
          ],
        },
      ]
    );
  });

  it("preserves leading and trailing whitespace in path segments", () => {
    const tree = buildTurnDiffTree([
      { path: "a/file.ts", additions: 1, deletions: 0 },
      { path: " a/file.ts", additions: 2, deletions: 0 },
    ]);

    const names = tree
      .filter((node) => node.kind === "directory")
      .map((node) => [node.name, node.path]);

    assert.strictEqual(tree.length, 2);
    assert.deepStrictEqual(
      names.toSorted((left, right) =>
        String(left[0]).localeCompare(String(right[0]))
      ),
      [
        [" a", " a"],
        ["a", "a"],
      ]
    );
  });
});

describe(parsePatch, () => {
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "index 5626abf..1e1b65b 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,2 @@",
    " one",
    "-two",
    "+deux",
    "\\ No newline at end of file",
    "diff --git a/b.txt b/b.txt",
    "new file mode 100644",
    "index 0000000..a8de70b",
    "--- /dev/null",
    "+++ b/b.txt",
    "@@ -0,0 +1 @@",
    "+bee",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "index a8de70b..0000000",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "diff --git a/old name.txt b/new name.txt",
    "similarity index 100%",
    "rename from old name.txt",
    "rename to new name.txt",
    "diff --git a/logo.png b/logo.png",
    "index 1111111..2222222 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n");

  it("reads files, statuses, numbered lines and stats", () => {
    const files = parsePatch(patch);

    assert.deepStrictEqual(
      files.map((file) => [file.path, file.status, file.binary, file.stat]),
      [
        ["a.txt", "modified", false, { additions: 1, deletions: 1 }],
        ["b.txt", "added", false, { additions: 1, deletions: 0 }],
        ["gone.txt", "deleted", false, { additions: 0, deletions: 1 }],
        ["new name.txt", "renamed", false, { additions: 0, deletions: 0 }],
        ["logo.png", "modified", true, { additions: 0, deletions: 0 }],
      ]
    );
    assert.deepStrictEqual(files[3]?.oldPath, Option.some("old name.txt"));
    assert.deepStrictEqual(files[0]?.oldPath, Option.none());
    assert.deepStrictEqual(files[0]?.hunks[0]?.lines, [
      {
        kind: "context",
        oldNumber: Option.some(1),
        newNumber: Option.some(1),
        text: "one",
      },
      {
        kind: "removed",
        oldNumber: Option.some(2),
        newNumber: Option.none(),
        text: "two",
      },
      {
        kind: "added",
        oldNumber: Option.none(),
        newNumber: Option.some(2),
        text: "deux",
      },
      {
        kind: "note",
        oldNumber: Option.none(),
        newNumber: Option.none(),
        text: "No newline at end of file",
      },
    ]);
  });

  it("reads nothing from an empty or truncated patch without failing", () => {
    assert.deepStrictEqual(parsePatch(""), []);

    const truncated = parsePatch(
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n\n[truncated]"
    );

    assert.strictEqual(truncated.length, 1);
    assert.strictEqual(truncated[0]?.stat.deletions, 1);
  });
});

describe(checkpointSummaryOf, () => {
  it("decodes the brain's entry data and refuses another shape", () => {
    assert.deepStrictEqual(
      checkpointSummaryOf({
        turn: 2,
        ref: "refs/cairn/checkpoints/x/turn/2",
        headOid: null,
        capturedAt: 1_700_000_000_000,
        files: [{ path: "a.txt", additions: 1, deletions: 0 }],
        moreFiles: 0,
      }),
      Option.some({
        turn: 2,
        ref: "refs/cairn/checkpoints/x/turn/2",
        files: [{ path: "a.txt", additions: 1, deletions: 0 }],
        moreFiles: 0,
        userEntryId: Option.none(),
      })
    );
    assert.isTrue(
      Option.isNone(checkpointSummaryOf({ turn: 2, ref: "refs/x" }))
    );
  });
});
