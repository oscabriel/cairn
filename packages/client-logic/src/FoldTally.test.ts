import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { foldTally, foldTallyText } from "./FoldTally.ts";
import type { ToolAction, WorkEntry } from "./TimelineEntries.ts";

/** A finished call named `tool`, with `action`; a thought, an error or a compaction by `kind`. */
const call = (
  tool: string,
  action: ToolAction,
  kind: WorkEntry["kind"] = "tool"
): WorkEntry => ({
  id: `tool:${tool}`,
  kind,
  turnId: "turn-1",
  createdAt: 0,
  completedAt: Option.some(1),
  status: "completed",
  toolName: kind === "tool" ? Option.some(tool) : Option.none(),
  action,
  command: Option.none(),
  changedFiles: [],
  readPaths: [],
  detail: Option.none(),
  output: Option.none(),
  source: Option.none(),
  nestedCalls: [],
});

describe("FoldTally", () => {
  it("counts each kind of call in the line's order, singular and plural", () => {
    const parts = foldTally([
      call("read", "read"),
      call("edit", "edit"),
      call("bash", "command"),
      call("write", "edit"),
      call("read", "read"),
      call("grep", "code-search"),
      call("web_fetch", "search"),
      call("subagent_spawn", "other"),
      call("executor_call", "other"),
    ]);

    assert.deepStrictEqual(parts, [
      { count: 2, word: "edits" },
      { count: 2, word: "reads" },
      { count: 2, word: "searches" },
      { count: 1, word: "command" },
      { count: 1, word: "agent" },
      { count: 1, word: "tool" },
    ]);
    assert.strictEqual(
      foldTallyText(parts),
      "2 edits · 2 reads · 2 searches · 1 command · 1 agent · 1 tool"
    );
  });

  it("leaves out thoughts, errors and compactions, and is empty with no call", () => {
    assert.deepStrictEqual(
      foldTally([
        call("think", "other", "reasoning"),
        call("error", "other", "error"),
        call("compact", "other", "compaction"),
      ]),
      []
    );
    assert.strictEqual(foldTallyText([]), "");
  });
});
