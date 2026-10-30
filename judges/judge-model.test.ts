// The judge brain's scripted model (`fixtures/JudgeModel.ts`): a script line on a later line of a
// message runs, and a tool step's `$subagent` stands for the newest subagent the context says
// started, so the subagent kill judge's parent can answer its child's question by script.

import type { Message } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";

import { answerTo } from "./fixtures/JudgeModel.ts";

const CHILD = "0190f0c0-0000-7000-8000-0000000000c2";

const OLDER = "0190f0c0-0000-7000-8000-0000000000c1";

const user = (content: string): Message => ({
  role: "user",
  content,
  timestamp: 0,
});

const toolCallOf = (messages: ReadonlyArray<Message>) => {
  const reply = answerTo(messages);

  return reply.content.flatMap((part) =>
    part.type === "toolCall" ? [{ name: part.name, args: part.arguments }] : []
  );
};

describe("the judge model", () => {
  it("fills $subagent with the newest subagent that started", () => {
    const calls = toolCallOf([
      user(
        `The user approved the brief "Older"; subagent thread ${OLDER} started.`
      ),
      user(
        `The user approved the brief "Count"; subagent thread ${CHILD} started.`
      ),
      user(
        'Subagent "Count" asks: Which colour?\njudge: tool subagent_reply {"subagent":"$subagent","answer":"blue"}\nAnswer with subagent_reply, or escalate it to the user.'
      ),
    ]);

    assert.deepStrictEqual(calls, [
      {
        name: "subagent_reply",
        args: { subagent: CHILD, answer: "blue" },
      },
    ]);
  });

  it("leaves $subagent as it is when no subagent started", () => {
    const calls = toolCallOf([
      user('judge: tool subagent_reply {"subagent":"$subagent"}'),
    ]);

    assert.deepStrictEqual(calls, [
      { name: "subagent_reply", args: { subagent: "$subagent" } },
    ]);
  });
});
