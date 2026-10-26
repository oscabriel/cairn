// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/work-log/presentation.test.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the failure and success rules, the group
// summaries (reasoning excluded, integrations deduplicated ahead of ordinary actions, their
// plurality), and `liveThoughtLine`. Changed: entries are Cairn work entries, whose status comes from
// pi's tool results, so the free-text failure heuristics are replaced by status cases; Cairn's own
// cases for command labels and paths are added. Removed: T3 tools, browser, device, computer use,
// pull requests, created threads, command echo details and viewed images.
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

import type { WorkEntry } from "./TimelineEntries.ts";
import {
  commandProgramName,
  liveThoughtLine,
  liveWorkEntryLabel,
  summarizeToolGroup,
  toolGroupSummaryKind,
  workEntryDisplayLabel,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIsVisibleInGroup,
} from "./ToolSummary.ts";

const entry = (id: string, overrides: Partial<WorkEntry> = {}): WorkEntry => ({
  id,
  kind: "tool",
  turnId: "turn:1",
  createdAt: 0,
  completedAt: Option.some(1),
  status: "completed",
  toolName: Option.some("bash"),
  action: "command",
  command: Option.none(),
  changedFiles: [],
  readPaths: [],
  detail: Option.none(),
  output: Option.none(),
  source: Option.none(),
  nestedCalls: [],
  ...overrides,
});

const thought = entry("thought", {
  kind: "reasoning",
  toolName: Option.none(),
  action: "other",
  detail: Option.some("Check the source"),
});

describe(workEntryIndicatesToolFailure, () => {
  it("is true for errors and failed calls, false for settled ones", () => {
    assert.isTrue(workEntryIndicatesToolFailure(entry("e", { kind: "error" })));
    assert.isTrue(
      workEntryIndicatesToolFailure(entry("f", { status: "failed" }))
    );
    assert.isFalse(workEntryIndicatesToolFailure(entry("ok")));
  });

  it("treats successful tool rows as success candidates", () => {
    assert.isTrue(workEntryIndicatesToolSuccess(entry("ok")));
    assert.isFalse(
      workEntryIndicatesToolSuccess(entry("run", { status: "inProgress" }))
    );
    assert.isFalse(
      workEntryIndicatesToolSuccess(entry("stop", { status: "stopped" }))
    );
    assert.isFalse(workEntryIndicatesToolSuccess(thought));
  });

  it("does not count a compaction as a failure", () => {
    assert.isFalse(
      workEntryIndicatesToolFailure(
        entry("c", {
          kind: "compaction",
          detail: Option.some("File not found"),
        })
      )
    );
  });

  it("shows a running call only in the live group, and a thought only with text", () => {
    const running = entry("run", { status: "inProgress" });

    assert.isFalse(workEntryIsVisibleInGroup(running));
    assert.isTrue(workEntryIsVisibleInGroup(running, true));
    assert.isTrue(
      workEntryIsVisibleInGroup(entry("stop", { status: "stopped" }))
    );
    assert.isTrue(workEntryIsVisibleInGroup(thought));
    assert.isFalse(
      workEntryIsVisibleInGroup({ ...thought, detail: Option.some("  ") })
    );
  });
});

describe(summarizeToolGroup, () => {
  const command = entry("command", { command: Option.some("vp test run") });

  it("excludes reasoning from mixed tool counts and icons", () => {
    assert.deepStrictEqual(
      summarizeToolGroup([thought, command, { ...thought, id: "t2" }]),
      {
        summary: "Ran 1 command",
        hasFailure: false,
      }
    );
    assert.strictEqual(toolGroupSummaryKind([thought, command]), "command");
    assert.strictEqual(summarizeToolGroup([thought]).summary, "Thought");
    assert.strictEqual(
      summarizeToolGroup([thought, { ...thought, id: "t2" }]).summary,
      "Thought (×2)"
    );
    assert.strictEqual(toolGroupSummaryKind([thought]), "reasoning");
  });

  it("deduplicates named sources ahead of ordinary actions", () => {
    const source = Option.some({ key: "executor:github", name: "github" });

    assert.strictEqual(
      summarizeToolGroup([
        entry("open", { action: "other", source }),
        entry("inspect", { action: "other", source }),
        entry("command", { command: Option.some("git status") }),
      ]).summary,
      "Used github integration and ran 1 command"
    );
  });

  it.each([
    [["Foo", "Foo"], "Used Foo integration and ran 1 command"],
    [["Foo", "Bar", "Foo"], "Used Foo and Bar integrations and ran 1 command"],
  ] as const)(
    "uses the displayed source names for integration plurality: %j",
    (names, expected) => {
      assert.strictEqual(
        summarizeToolGroup([
          ...names.map((name, index) =>
            entry(`integration-${index}`, {
              action: "other",
              source: Option.some({ key: `integration-${index}`, name }),
            })
          ),
          command,
        ]).summary,
        expected
      );
    }
  );

  it("names the two highest-priority actions and counts the rest", () => {
    assert.deepStrictEqual(
      summarizeToolGroup([
        entry("r1", { action: "read", readPaths: ["a.ts"] }),
        command,
        entry("e1", { action: "edit", changedFiles: ["a.ts"] }),
        entry("e2", { action: "edit", changedFiles: ["a.ts"] }),
        entry("s1", { action: "code-search", status: "failed" }),
      ]),
      {
        summary: "Ran 1 command, changed 1 file, and performed 2 other actions",
        hasFailure: true,
      }
    );
  });
});

describe("labels", () => {
  it("names a command's program past wrappers and a leading cd", () => {
    assert.deepStrictEqual(
      commandProgramName("cd app && FOO=1 env pnpm test"),
      Option.some("pnpm")
    );
    assert.deepStrictEqual(
      commandProgramName("/usr/bin/git status"),
      Option.some("git")
    );
    assert.deepStrictEqual(commandProgramName("   "), Option.none());
  });

  it("uses the live verb for a command", () => {
    const running = entry("r", {
      status: "inProgress",
      command: Option.some("pnpm test"),
    });

    assert.strictEqual(
      liveWorkEntryLabel(running, Option.none(), true),
      "Running pnpm"
    );
    assert.strictEqual(
      liveWorkEntryLabel(
        { ...running, status: "completed" },
        Option.none(),
        false
      ),
      "Ran pnpm"
    );
    assert.strictEqual(
      liveWorkEntryLabel(
        { ...running, status: "stopped" },
        Option.none(),
        true
      ),
      "Stopped pnpm"
    );
  });

  it("shows reads relative to the workspace", () => {
    assert.strictEqual(
      workEntryDisplayLabel(
        entry("r", {
          action: "read",
          toolName: Option.some("read"),
          readPaths: ["/w/src/a.ts"],
        }),
        Option.some("/w/")
      ),
      "Read src/a.ts"
    );
  });
});

describe(liveThoughtLine, () => {
  it("keeps the first sentence, including a closing quote", () => {
    assert.strictEqual(
      liveThoughtLine(
        'Found the cause: the repo has no commits, so `git worktree add` fails with "invalid reference: main." Now checking the UI.'
      ),
      'Found the cause: the repo has no commits, so git worktree add fails with "invalid reference: main."'
    );
  });

  it("does not cut at dots inside file names or long dashes", () => {
    assert.strictEqual(
      liveThoughtLine(
        "I read ThreadLaunchService.ts — it skips the fetch. Next step."
      ),
      "I read ThreadLaunchService.ts — it skips the fetch."
    );
  });

  it("uses a bold-only opening line as the whole line", () => {
    assert.strictEqual(
      liveThoughtLine(
        "**Narrowing dispatch files**\n\nI should check the adapter. Then more."
      ),
      "Narrowing dispatch files"
    );
    assert.strictEqual(
      liveThoughtLine(
        "**Narrowing dispatch files**\r\n\r\nI should check the adapter."
      ),
      "Narrowing dispatch files"
    );
  });

  it("returns unpunctuated text whole and flattens markdown", () => {
    assert.strictEqual(
      liveThoughtLine("- Checking [the docs](https://x.dev) for **limits**"),
      "Checking the docs for limits"
    );
    assert.strictEqual(
      liveThoughtLine("This is *really* ~~not~~ _fine_ in snake_case_names."),
      "This is really not fine in snake_case_names."
    );
    assert.strictEqual(liveThoughtLine("   "), "");
  });
});
