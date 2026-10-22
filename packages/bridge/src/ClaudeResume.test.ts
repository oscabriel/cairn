import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import type { IdleChild, ResumeInput } from "./ClaudeResume.ts";
import { decideResume } from "./ClaudeResume.ts";
import { historyDigest, stampMessage } from "./ClaudeStamp.ts";
import { emptyUsage } from "./ClaudeTokens.ts";
import type { ConversationMessage } from "./ClaudeTranscript.ts";

const CWD = "/work/project";

const MODEL = "claude-sonnet-5-5[1m]";

const SESSION = "11111111-2222-4333-8444-555555555555";

const user = (text: string): ConversationMessage => ({
  role: "user",
  content: text,
  timestamp: 2,
});

const reply = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "claude-bridge",
  provider: "claude-bridge",
  model: "claude-sonnet-5-5",
  usage: emptyUsage(),
  stopReason: "stop",
  timestamp: 3,
});

/** `text` as the bridge would deliver it after `prior`, stamped. */
const stamped = (
  prior: ReadonlyArray<ConversationMessage>,
  text: string,
  overrides: {
    readonly piSessionId?: string;
    readonly cwd?: string;
    readonly cliModel?: string;
  } = {}
): AssistantMessage => {
  const message = reply(text);

  stampMessage(
    message,
    {
      ccSessionId: SESSION,
      ccUuid: `uuid-${text}`,
      piSessionId: overrides.piSessionId ?? "conv-1",
      historyDigest: historyDigest([...prior, message]),
      held: { digest: "s2:x", base: "b", sections: {} },
      cliModel: overrides.cliModel ?? MODEL,
      cwd: overrides.cwd ?? CWD,
    },
    0
  );

  return message;
};

const input = (
  messages: ReadonlyArray<ConversationMessage>,
  change: Partial<ResumeInput> = {}
): ResumeInput => ({
  piSessionId: "conv-1",
  messages,
  cwd: CWD,
  cliModel: MODEL,
  effort: Option.none(),
  thinking: "disabled",
  memory: { heldOwnsResults: false, idle: Option.none(), uncertain: new Set() },
  ...change,
});

const history = (() => {
  const first = [user("hi")];

  return [...first, stamped(first, "hello"), user("again")];
})();

const memory = (child: IdleChild) => ({
  heldOwnsResults: false,
  idle: Option.some(child),
  uncertain: new Set<string>(),
});

describe("the resume decision table", () => {
  it("delivers to the held query that owns the results", () => {
    expect(
      decideResume(
        input(history, {
          memory: {
            heldOwnsResults: true,
            idle: Option.none(),
            uncertain: new Set(),
          },
        })
      )
    ).toStrictEqual({ kind: "deliver" });
  });

  it("opens a first turn under pi's session id, with nothing to seed", () => {
    expect(decideResume(input([user("hi")]))).toStrictEqual({
      kind: "fresh",
      reason: "first-turn",
      seed: false,
      preferredId: Option.some("conv-1"),
    });
  });

  it("seeds a fresh session when the history has replies but no stamp", () => {
    expect(
      decideResume(input([user("hi"), reply("hello"), user("again")]))
    ).toMatchObject({
      kind: "fresh",
      reason: "no-stamp",
      seed: true,
    });
  });

  it("resumes the stamped session when nothing diverged, and forks it when its last child may still write", () => {
    expect(decideResume(input(history))).toMatchObject({
      kind: "resume",
      fork: false,
      found: { index: 1 },
    });
    expect(
      decideResume(
        input(history, {
          memory: {
            heldOwnsResults: false,
            idle: Option.none(),
            uncertain: new Set([SESSION]),
          },
        })
      )
    ).toMatchObject({ kind: "resume", fork: true });
  });

  it("reuses an idle child of the same session, model, effort and thinking", () => {
    const idle: IdleChild = {
      ccSessionId: SESSION,
      cwd: CWD,
      cliModel: MODEL,
      effort: Option.none(),
      thinking: "disabled",
    };

    expect(
      decideResume(input(history, { memory: memory(idle) }))
    ).toStrictEqual({ kind: "reuse", ccSessionId: SESSION });
    expect(
      decideResume(
        input(history, { memory: memory({ ...idle, thinking: "adaptive" }) })
      )
    ).toMatchObject({ kind: "resume" });
    expect(
      decideResume(
        input(history, { memory: memory(idle), effort: Option.some("high") })
      )
    ).toMatchObject({ kind: "resume" });
    expect(
      decideResume(
        input(history, { memory: memory({ ...idle, ccSessionId: "other" }) })
      )
    ).toMatchObject({ kind: "resume" });
  });

  it("forks the session of another pi conversation's stamp", () => {
    expect(
      decideResume(input(history, { piSessionId: "conv-fork" }))
    ).toMatchObject({ kind: "fork-stamped" });
  });

  it("opens a seeded fresh session when the history diverged, another provider answered, or the cwd or model moved", () => {
    const edited = [
      user("hi, edited"),
      history[1] ?? reply("x"),
      user("again"),
    ];

    expect(decideResume(input(edited))).toMatchObject({
      kind: "fresh",
      reason: "history-diverged",
      seed: true,
    });
    expect(
      decideResume(
        input([...history, reply("from another provider"), user("more")])
      )
    ).toMatchObject({
      kind: "fresh",
      reason: "other-provider",
    });
    expect(decideResume(input(history, { cwd: "/elsewhere" }))).toMatchObject({
      kind: "fresh",
      reason: "cwd-changed",
    });
    expect(
      decideResume(input(history, { cliModel: "claude-opus-5-5[1m]" }))
    ).toMatchObject({
      kind: "fresh",
      reason: "model-changed",
    });
  });
});
