// The transcript adapter, judged on real pi transcripts: pi-durable over opencode-go models, recorded
// by judges/fixtures/transcripts/record.ts (markdown, every coding tool, a failing tool, a stop
// during a tool, a thought, and three streamed runs kept frame by frame).
import { ConversationId, EntryId } from "@cairn/protocol/Ids";
import {
  ConversationView,
  ProjectedImage,
  ThreadStreamItem,
} from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { Option, Result, Schema } from "effect";

import coding from "../../../judges/fixtures/transcripts/coding.json" with { type: "json" };
import interruptedFrames from "../../../judges/fixtures/transcripts/interrupted.frames.json" with { type: "json" };
import interrupted from "../../../judges/fixtures/transcripts/interrupted.json" with { type: "json" };
import streamingToolsFrames from "../../../judges/fixtures/transcripts/streaming-tools.frames.json" with { type: "json" };
import streamingFrames from "../../../judges/fixtures/transcripts/streaming.frames.json" with { type: "json" };
import thinking from "../../../judges/fixtures/transcripts/thinking.json" with { type: "json" };
import { applyThreadStreamItem } from "./ThreadView.ts";
import type { ThreadViewState } from "./ThreadView.ts";
import { entriesFromPi, turnElapsedMs } from "./TimelineEntries.ts";
import type { Timeline, TimelineEntry, WorkEntry } from "./TimelineEntries.ts";

type Json = Schema.Json;

const [, EntryImageRef] = ProjectedImage.fields.ref.members;

const decodeView = Schema.decodeUnknownSync(ConversationView);

const decodeFrames = Schema.decodeUnknownSync(Schema.Array(ThreadStreamItem));

const messages = (timeline: Timeline) =>
  timeline.entries.flatMap((entry) =>
    entry.kind === "message" ? [entry.message] : []
  );

const work = (timeline: Timeline): ReadonlyArray<WorkEntry> =>
  timeline.entries.flatMap((entry) =>
    entry.kind === "work" ? [entry.entry] : []
  );

const toolsOf = (timeline: Timeline, turnId: string) =>
  work(timeline).filter(
    (entry) => entry.kind === "tool" && entry.turnId === turnId
  );

/** Replays recorded frames as the client does, reading the timeline after every item. */
const replay = (
  frames: ReadonlyArray<ThreadStreamItem>
): ReadonlyArray<{
  readonly timeline: Timeline;
  readonly state: ThreadViewState;
}> => {
  let state = Option.none<ThreadViewState>();
  const out: Array<{ timeline: Timeline; state: ThreadViewState }> = [];

  for (const item of frames) {
    const next = applyThreadStreamItem(state, item);

    assert.isTrue(Result.isSuccess(next));

    if (Result.isSuccess(next)) {
      state = Option.some(next.success);
      out.push({
        timeline: entriesFromPi(next.success.view),
        state: next.success,
      });
    }
  }

  return out;
};

describe("entriesFromPi on recorded transcripts", () => {
  const timeline = entriesFromPi(decodeView(coding));

  it("makes one turn per user message and hides the system entry", () => {
    assert.deepStrictEqual(
      timeline.turns.map((turn) => turn.id),
      ["turn:11", "turn:16", "turn:32", "turn:40", "turn:50"]
    );
    assert.isFalse(timeline.isWorking);
    assert.isTrue(
      timeline.turns.every(
        (turn) => turn.status === "completed" || turn.status === "failed"
      )
    );
    assert.isFalse(timeline.entries.some((entry) => entry.id.includes("14")));
  });

  it("keys messages by turn and position and keeps the answer's markdown", () => {
    const [prompt, answer] = messages(timeline);

    assert.strictEqual(prompt?.id, "user:11");
    assert.strictEqual(prompt?.role, "user");
    assert.strictEqual(answer?.id, "msg:turn:11:0");
    assert.isTrue(answer?.text.startsWith("## What a README Is For"));
    assert.isFalse(answer?.streaming);
    assert.deepStrictEqual(answer?.entryId, Option.some(EntryId.make(15)));
  });

  it("reads every coding tool in call order with its action, files and output", () => {
    const tools = toolsOf(timeline, "turn:16");

    assert.deepStrictEqual(
      tools.map((tool) => [
        Option.getOrNull(tool.toolName),
        tool.action,
        tool.status,
      ]),
      [
        ["read", "read", "completed"],
        ["edit", "edit", "completed"],
        ["write", "edit", "completed"],
        ["bash", "command", "completed"],
      ]
    );
    assert.deepStrictEqual(tools[0]?.readPaths, ["notes.txt"]);
    assert.deepStrictEqual(tools[1]?.changedFiles, ["notes.txt"]);
    assert.deepStrictEqual(tools[2]?.changedFiles, ["summary.txt"]);
    assert.deepStrictEqual(
      tools[3]?.command,
      Option.some("ls && wc -l notes.txt")
    );
    assert.deepStrictEqual(
      tools[3]?.output,
      Option.some("notes.txt\nREADME.md\n2 notes.txt\n")
    );
    assert.isTrue(tools.every((tool) => tool.id.startsWith("tool:toolu_")));
  });

  it("marks a failing command failed and drops the harness block from its output", () => {
    const [failing] = toolsOf(timeline, "turn:32");

    assert.strictEqual(failing?.status, "failed");
    assert.deepStrictEqual(
      failing?.output,
      Option.some("cat: does-not-exist.txt: No such file or directory\n")
    );
  });

  it("reads grep and find as code searches with their patterns", () => {
    const tools = toolsOf(timeline, "turn:40");

    assert.deepStrictEqual(
      tools.map((tool) => [tool.action, Option.getOrNull(tool.detail)]),
      [
        ["code-search", "cairn"],
        ["code-search", "\\.txt$"],
      ]
    );
  });

  it("shows a cairn.user turn's text with its attachments as chips, not as text", () => {
    const user = messages(timeline).find((message) => message.id === "user:50");

    assert.strictEqual(
      user?.text,
      "Here is a file I attached. Just reply with: got it."
    );
    assert.deepStrictEqual(
      user?.attachments.map((attachment) => attachment.name),
      ["release-notes.pdf"]
    );
    assert.deepStrictEqual(user?.attachmentNames, []);
  });

  it("measures a turn from its prompt to the end of its last answer", () => {
    const [first] = timeline.turns;
    const answer = coding.entries.find((entry) => entry.id === 15)?.model?.[0];
    const prompt = coding.entries.find((entry) => entry.id === 11)?.model?.[0];

    assert.isDefined(answer);
    assert.isDefined(prompt);

    if (
      first !== undefined &&
      answer !== undefined &&
      prompt !== undefined &&
      "durationMs" in answer
    ) {
      assert.deepStrictEqual(
        turnElapsedMs(first),
        Option.some(answer.timestamp + answer.durationMs - prompt.timestamp)
      );
    }
  });
});

describe("a stop during a tool", () => {
  const timeline = entriesFromPi(decodeView(interrupted));
  const turnId = `turn:${interrupted.entries[0]?.id ?? 0}`;

  it("reads the turn as interrupted and the aborted call as stopped", () => {
    assert.deepStrictEqual(
      timeline.turns.map((turn) => turn.status),
      ["interrupted", "completed"]
    );

    const [stopped] = toolsOf(timeline, turnId);

    assert.strictEqual(stopped?.status, "stopped");
    assert.deepStrictEqual(
      stopped?.command,
      Option.some("sleep 20 && echo finished")
    );
  });

  it("ends the interrupted turn at its aborted result", () => {
    const [turn] = timeline.turns;

    const result = interrupted.entries.find(
      (entry) => entry.kind === "pi.tool-result"
    )?.model?.[0];

    assert.isDefined(result);

    if (turn !== undefined && result !== undefined) {
      assert.deepStrictEqual(turn.endedAt, Option.some(result.timestamp));
    }
  });

  it("shows the call running while the run works, then stopped", () => {
    const steps = replay(decodeFrames(interruptedFrames));

    const running = steps.find((step) =>
      work(step.timeline).some(
        (entry) => entry.kind === "tool" && entry.status === "inProgress"
      )
    );

    assert.isDefined(running);
    assert.isTrue(running?.timeline.isWorking);
    assert.deepStrictEqual(running?.timeline.activeTurnId, Option.some(turnId));

    const last = steps.at(-1)?.timeline;
    const tool = last === undefined ? undefined : toolsOf(last, turnId)[0];

    assert.strictEqual(tool?.status, "stopped");
    assert.strictEqual(
      running === undefined
        ? undefined
        : toolsOf(running.timeline, turnId)[0]?.id,
      tool?.id
    );
  });
});

describe("a thought before the answer", () => {
  it("reads a thought as reasoning work before the answer", () => {
    const timeline = entriesFromPi(decodeView(thinking));

    const kinds = timeline.entries.map((entry) =>
      entry.kind === "work" ? entry.entry.kind : entry.kind
    );

    assert.deepStrictEqual(kinds, ["message", "reasoning", "message"]);

    const [thought] = work(timeline);

    assert.isTrue(
      Option.exists(thought?.detail ?? Option.none(), (text) => text.length > 0)
    );
    assert.strictEqual(thought?.status, "completed");
  });
});

describe("streaming", () => {
  it("keeps the streaming answer's key when it settles, and its text only grows", () => {
    const steps = replay(decodeFrames(streamingFrames));

    const answers = steps.flatMap((step) =>
      messages(step.timeline).filter((message) => message.role === "assistant")
    );

    const live = answers.filter((message) => message.streaming);
    const settled = answers.filter((message) => !message.streaming);

    assert.isAbove(live.length, 5);
    assert.isAbove(settled.length, 0);
    const [first] = answers;

    assert.isTrue(answers.every((message) => message.id === first?.id));
    assert.match(first?.id ?? "", /^msg:turn:\d+:0$/u);

    for (const [index, message] of live.entries()) {
      const previous = live[index - 1];

      if (previous !== undefined) {
        assert.isTrue(message.text.startsWith(previous.text));
      }
    }

    assert.isTrue(settled[0]?.text.startsWith(live.at(-1)?.text ?? "\u0000"));
    assert.isTrue(steps.some((step) => step.timeline.isWorking));
    assert.isFalse(steps.at(-1)?.timeline.isWorking);
  });

  it("keeps a tool call's key from its first token to its result", () => {
    const steps = replay(decodeFrames(streamingToolsFrames));
    const statuses = new Map<string, Array<string>>();

    for (const step of steps) {
      for (const entry of work(step.timeline)) {
        if (entry.kind === "tool") {
          const seen = statuses.get(entry.id) ?? [];

          if (seen.at(-1) !== entry.status) {
            seen.push(entry.status);
          }

          statuses.set(entry.id, seen);
        }
      }
    }

    assert.strictEqual(statuses.size, 2);

    for (const seen of statuses.values()) {
      assert.deepStrictEqual(seen, ["inProgress", "completed"]);
    }

    const last = steps.at(-1)?.timeline;
    const keys = last?.entries.map((entry: TimelineEntry) => entry.id);
    const prompt = last?.turns[0]?.userEntryId.pipe(Option.getOrNull);

    assert.deepStrictEqual(keys?.slice(0, 2), [
      `user:${prompt}`,
      `msg:turn:${prompt}:0`,
    ]);
  });
});

describe("entries the recorder cannot provoke", () => {
  const conversationId = ConversationId.make(1);

  const view = (
    entries: ReadonlyArray<Json>,
    live: Json = {}
  ): ConversationView =>
    decodeView({
      conversation: { id: conversationId },
      entries,
      docs: { "pi.live": live },
    });

  const user = (id: number, content: Json, timestamp = 1000) => ({
    id,
    conversationId,
    kind: "pi.user",
    model: [{ role: "user", content, timestamp }],
  });

  it("reads a failed answer as an error entry and a failed turn", () => {
    const timeline = entriesFromPi(
      view([
        user(1, "hi"),
        {
          id: 2,
          conversationId,
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "Claude plan quota exceeded",
              timestamp: 1100,
              durationMs: 50,
            },
          ],
        },
      ])
    );

    assert.strictEqual(timeline.turns[0]?.status, "failed");
    assert.deepStrictEqual(
      timeline.turns[0]?.error,
      Option.some("Claude plan quota exceeded")
    );

    const [error] = work(timeline);

    assert.strictEqual(error?.kind, "error");
    assert.strictEqual(error?.id, "error:msg:turn:1:0");
  });

  it("reads skill blocks as chips and keeps the text after them", () => {
    const timeline = entriesFromPi(
      view([
        user(1, [
          {
            type: "text",
            text: '<skill name="review" location="/skills/review/SKILL.md">\nReferences are relative to /skills/review.\n\nBody\n</skill>\n\nplease look',
          },
          {
            type: "image",
            mimeType: "image/png",
            bytes: 12,
            ref: Schema.encodeSync(ProjectedImage.fields.ref)(
              EntryImageRef.make({ entryId: EntryId.make(1), index: 0 })
            ),
          },
        ]),
      ])
    );

    const [message] = messages(timeline);

    assert.deepStrictEqual(message?.skills, ["review"]);
    assert.strictEqual(message?.text, "please look");
    assert.strictEqual(message?.images.length, 1);
  });

  it("puts older pages first and shows the live partial as a streaming answer", () => {
    const older = view([user(1, "first")]).entries;

    const timeline = entriesFromPi(
      view([user(3, "second", 2000)], {
        run: { taskId: 9, inputs: [] },
        generation: {
          attempt: 1,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Considering" },
              { type: "text", text: "Work" },
            ],
            stopReason: "pending",
            timestamp: 2100,
          },
        },
      }),
      older
    );

    assert.deepStrictEqual(
      timeline.entries.map((entry) => entry.id),
      ["user:1", "user:3", "think:msg:turn:3:0:0", "msg:turn:3:0"]
    );
    assert.isTrue(timeline.isWorking);
    assert.deepStrictEqual(timeline.activeTurnStartedAt, Option.some(2000));
    assert.strictEqual(work(timeline)[0]?.status, "inProgress");
    assert.isTrue(messages(timeline).at(-1)?.streaming);
  });

  it("reads Executor calls inside a script as an integration", () => {
    const timeline = entriesFromPi(
      view([
        user(1, "status?"),
        {
          id: 2,
          conversationId,
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "c1",
                  name: "codemode",
                  arguments: {
                    code: "await tools.executor_call({path: 'tools.convex.status'})",
                  },
                },
              ],
              stopReason: "toolUse",
              timestamp: 1100,
            },
          ],
        },
        {
          id: 3,
          conversationId,
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: "c1",
              toolName: "codemode",
              content: [{ type: "text", text: "ok" }],
              isError: false,
              timestamp: 1200,
              nestedCalls: {
                complete: true,
                calls: [
                  {
                    id: "n1",
                    name: "executor_call",
                    arguments: { path: "tools.convex.status" },
                    status: "ok",
                  },
                ],
              },
            },
          ],
        },
      ])
    );

    const [script] = work(timeline);

    assert.deepStrictEqual(
      script?.source,
      Option.some({ key: "executor:convex", name: "convex" })
    );
    assert.strictEqual(script?.nestedCalls.length, 1);
  });
});
