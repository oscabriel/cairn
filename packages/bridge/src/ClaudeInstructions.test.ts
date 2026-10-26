// Ported from cairn-v1, apps/server/test/system-reminder.test.ts at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0 (Cairn's own code). The rebuild cases are gone with the
// rebuild; the delivery cases live in `ClaudeConversation.test.ts`.

import type {
  AssistantMessage,
  Message,
  SystemMessage,
  Tool,
} from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import {
  heldOf,
  instructionState,
  lineDiff,
  priorTexts,
  reminderFor,
} from "./ClaudeInstructions.ts";
import { emptyUsage } from "./ClaudeTokens.ts";

const markTool: Tool = {
  name: "mark",
  description: "Mark.",
  parameters: Type.Object({}),
};

const pingTool: Tool = {
  name: "ping",
  description: "Ping.",
  parameters: Type.Object({}),
};

const sys = (fields: Partial<SystemMessage>): Message => ({
  role: "system",
  content: "",
  timestamp: 1,
  ...fields,
});

const system = sys({
  content: "You are in a test.",
  sections: { cairn: "<cairn>test</cairn>", skills: "<skills>a</skills>" },
  toolsAdded: [markTool],
});

const user = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: 2,
});

const assistant = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "claude-bridge",
  provider: "claude-bridge",
  model: "claude-sonnet-5-5",
  usage: emptyUsage(),
  stopReason: "stop",
  timestamp: 3,
});

const skillsChanged = sys({ sections: { skills: "<skills>a, b</skills>" } });

const none = priorTexts([]);

const heldAt = (messages: ReadonlyArray<Message>) =>
  heldOf(instructionState(messages));

const reminder = (...args: Parameters<typeof reminderFor>): string =>
  Option.getOrElse(reminderFor(...args), () => "");

describe("the system reminder", () => {
  it("is nothing when a compaction baseline restates the same values, in any order, with the tools again", () => {
    const held = heldAt([system, user("a"), assistant("b")]);

    const baseline = sys({
      sections: { skills: "<skills>a</skills>", cairn: "<cairn>test</cairn>" },
      toolsAdded: [markTool],
      timestamp: 9,
    });

    const removeAll = sys({
      sections: { cairn: null, skills: null },
      timestamp: 9,
    });

    expect(
      Option.isNone(
        reminderFor(
          held,
          instructionState([
            system,
            user("a"),
            assistant("b"),
            baseline,
            user("c"),
          ]),
          none
        )
      )
    ).toBeTruthy();
    expect(
      Option.isNone(
        reminderFor(
          held,
          instructionState([
            system,
            user("a"),
            assistant("b"),
            removeAll,
            baseline,
          ]),
          none
        )
      )
    ).toBeTruthy();
    // A tool change is Claude Code's to announce, not a reminder's.
    expect(
      Option.isNone(
        reminderFor(
          held,
          instructionState([
            system,
            sys({ toolsAdded: [pingTool], toolsRemoved: [{ name: "mark" }] }),
          ]),
          none
        )
      )
    ).toBeTruthy();
  });

  it("carries each changed or added section in full, and the names of removed ones", () => {
    const held = heldAt([system]);

    const text = reminder(
      held,
      instructionState([
        system,
        skillsChanged,
        sys({
          sections: { cairn: null, extensions: "<extensions>x</extensions>" },
        }),
      ]),
      none
    );

    expect([
      text.startsWith("<system-reminder>\n"),
      text.endsWith("\n</system-reminder>"),
      text.includes('Section "skills" now reads:\n<skills>a, b</skills>'),
      text.includes(
        'New section "extensions" now reads:\n<extensions>x</extensions>'
      ),
      text.includes('Removed sections: "cairn".'),
      text.includes("<cairn>test</cairn>"),
      text.includes("base instructions"),
    ]).toStrictEqual([true, true, true, true, true, false, false]);

    const base = reminder(
      held,
      instructionState([system, sys({ content: "Also be brief." })]),
      none
    );

    expect(base).toContain(
      "The base instructions now read:\nYou are in a test.\n\nAlso be brief."
    );
  });

  it("digests the effective state, so restatements and tools change nothing", () => {
    const restated = sys({
      content: "You are in a test.",
      sections: { skills: "<skills>a</skills>", cairn: "<cairn>test</cairn>" },
      timestamp: 9,
    });

    expect(heldAt([restated, user("x")]).digest).toBe(
      heldAt([system, user("x")]).digest
    );
    expect(heldAt([system, user("x"), skillsChanged]).digest).not.toBe(
      heldAt([system, user("x")]).digest
    );
  });
});

// A skills-like section: one skill per five lines, about 12 KB.
const skillBlock = (
  n: number,
  description = `Skill number ${n}, for the tests.`
) =>
  `  <skill>\n    <name>skill-${n}</name>\n    <description>${description}</description>\n    <location>/skills/skill-${n}/SKILL.md</location>\n  </skill>`;

const skills = (blocks: ReadonlyArray<string>) =>
  `<available_skills>\n${blocks.join("\n")}\n</available_skills>`;

describe("a long changed section", () => {
  const blocks = Array.from({ length: 80 }, (_, n) => skillBlock(n + 10));
  const long = skills(blocks);

  const longSystem = sys({
    content: "You are in a test.",
    sections: { cairn: "<cairn>test</cairn>", skills: long },
  });

  const edited = skills(
    blocks.map((block, i) =>
      i === 40 ? skillBlock(50, "Now does something else.") : block
    )
  );

  const added = skills([
    ...blocks.slice(0, 20),
    skillBlock(29.5),
    ...blocks.slice(20),
  ]);

  it("prints a unified diff with context and line numbers", () => {
    expect(
      lineDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nc\nD\ne\nf\ng")
    ).toStrictEqual(Option.some("@@ -2,5 +2,5 @@\n b\n c\n-d\n+D\n e\n f"));
    expect(lineDiff("a\nb", "a\nb\nc")).toStrictEqual(
      Option.some("@@ -1,2 +1,3 @@\n a\n b\n+c")
    );
    expect(Option.isNone(lineDiff("x", "x"))).toBeTruthy();

    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);

    const twice = Option.getOrElse(
      lineDiff(
        lines.join("\n"),
        lines
          .map((line, i) => (i === 2 || i === 15 ? `${line}!` : line))
          .join("\n")
      ),
      () => ""
    );

    expect(
      twice.split("\n").filter((line) => line.startsWith("@@"))
    ).toStrictEqual(["@@ -1,5 +1,5 @@", "@@ -14,5 +14,5 @@"]);
  });

  it("goes as a capped line diff when the session's text is at hand", () => {
    expect(long.length).toBeGreaterThan(4096);

    const held = heldAt([longSystem]);

    const raw = [
      longSystem,
      user("a"),
      assistant("b"),
      sys({ sections: { skills: edited } }),
    ];

    const text = reminder(held, instructionState(raw), priorTexts(raw));

    expect([
      text.includes('Section "skills" changed. Apply this unified line diff'),
      text.includes(
        "-    <description>Skill number 50, for the tests.</description>"
      ),
      text.includes("+    <description>Now does something else.</description>"),
      text.includes("     <name>skill-50</name>"),
    ]).toStrictEqual([true, true, true, true]);
    expect(text.length).toBeLessThan(1000);

    const more = [longSystem, sys({ sections: { skills: added } })];
    const addition = reminder(held, instructionState(more), priorTexts(more));

    expect(addition).toContain("+    <name>skill-29.5</name>");
    expect(
      addition.split("\n").filter((line) => line.startsWith("-"))
    ).toStrictEqual([]);
  });

  it("goes in full when the earlier text is not at hand, the section is short, or the diff is too long", () => {
    const held = heldAt([longSystem]);
    const now = [longSystem, sys({ sections: { skills: edited } })];

    const full = reminder(
      held,
      instructionState(now),
      priorTexts([sys({ sections: { skills: edited } })])
    );

    expect(full).toContain(`Section "skills" now reads:\n${edited}`);
    expect(reminder(held, instructionState(now), none)).toBe(full);

    const short = [system, skillsChanged];

    expect(
      reminder(heldAt([system]), instructionState(short), priorTexts(short))
    ).toContain('Section "skills" now reads:\n<skills>a, b</skills>');

    const rewritten = skills(
      blocks.map((_, i) => skillBlock(i + 10, `Rewritten ${i}.`))
    );

    const big = [longSystem, sys({ sections: { skills: rewritten } })];

    expect(reminder(held, instructionState(big), priorTexts(big))).toContain(
      `Section "skills" now reads:\n${rewritten}`
    );
  });
});
