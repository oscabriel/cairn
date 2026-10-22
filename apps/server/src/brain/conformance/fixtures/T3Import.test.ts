// The t3code importer on a small run shaped like a real export: the entry order, the tool names
// Cairn's coding tools use, the stop reasons, the run's duration, and the protocol accepting every
// entry once a store gives it an id.
import { Entry } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import {
  formatT3ThreadExport,
  importT3Thread,
  parseT3ThreadExport,
} from "./T3Import.ts";
import type { T3Item, T3ThreadExport } from "./T3Import.ts";

const item = (
  type: string,
  startedAtMs: number,
  fields: Partial<T3Item> = {}
): T3Item => ({
  type,
  startedAtMs,
  completedAtMs: Option.some(startedAtMs + 100),
  text: Option.none(),
  toolName: Option.none(),
  title: Option.none(),
  input: Option.none(),
  arguments: Option.none(),
  output: Option.none(),
  path: Option.none(),
  created: false,
  isError: false,
  ...fields,
});

const thread: T3ThreadExport = {
  threadId: "t3-thread",
  title: "A thread",
  projectTitle: "project",
  model: "claude-opus-5-5",
  runs: [
    {
      ordinal: 1,
      requestedAtMs: 1000,
      completedAtMs: Option.some(60_000),
      items: [
        item("user_message", 1000, { text: Option.some("Build it") }),
        item("reasoning", 2000, { text: Option.some("Thinking it over") }),
        item("assistant_message", 3000, { text: Option.some("Looking.") }),
        item("command_execution", 4000, {
          input: Option.some("ls"),
          output: Option.some("a.ts"),
        }),
        item("dynamic_tool", 5000, {
          toolName: Option.some("Read"),
          arguments: Option.some({ file_path: "/tmp/a.png" }),
          output: Option.some("image"),
        }),
        item("file_change", 6000, {
          path: Option.some("/repo/a.ts"),
          created: true,
        }),
        item("assistant_message", 7000, { text: Option.some("Done.") }),
        item("checkpoint", 8000),
      ],
    },
  ],
};

describe("T3Import", () => {
  it("writes a prompt, one tool round with its results, and the answer", () => {
    const imported = importT3Thread(thread);

    assert.deepStrictEqual(
      imported.entries.map((entry) => entry.kind),
      [
        "pi.user",
        "pi.assistant",
        "pi.tool-result",
        "pi.tool-result",
        "pi.tool-result",
        "pi.assistant",
      ]
    );
    assert.deepStrictEqual(imported.skipped, { checkpoint: 1 });

    const round = imported.entries[1]?.model[0];
    const answer = imported.entries[5]?.model[0];

    assert.strictEqual(round?.role, "assistant");
    assert.strictEqual(answer?.role, "assistant");

    if (round?.role !== "assistant" || answer?.role !== "assistant") {
      return;
    }

    assert.deepStrictEqual(
      round.content.map((part) =>
        part.type === "toolCall" ? part.name : part.type
      ),
      ["thinking", "text", "bash", "read", "write"]
    );
    assert.strictEqual(round.stopReason, "toolUse");
    assert.strictEqual(answer.stopReason, "stop");
    // The answer ends when t3code's run completed, so "Worked for" reads the same.
    assert.strictEqual(answer.timestamp + (answer.durationMs ?? 0), 60_000);
  });

  it("gives every entry a shape the protocol accepts", () => {
    const decode = Schema.decodeUnknownSync(Entry);

    for (const [index, entry] of importT3Thread(thread).entries.entries()) {
      const decoded = decode({ id: index + 1, conversationId: 1, ...entry });

      assert.strictEqual(decoded.kind, entry.kind);
    }
  });

  it.effect("round-trips the export through its JSON", () =>
    Effect.gen(function* () {
      const parsed = yield* parseT3ThreadExport(formatT3ThreadExport(thread));

      assert.deepStrictEqual(importT3Thread(parsed), importT3Thread(thread));
    })
  );
});
