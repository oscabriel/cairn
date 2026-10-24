import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  isContextOverflow,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import {
  abortKind,
  BRIDGE_FAILED_TEXT,
  CAPACITY_TEXT,
  CHILD_ENDED_TEXT,
  childEnv,
  claudeFailureText,
  EMPTY_PROMPT_TEXT,
  INIT_REFUSED_TEXT,
  ONE_SHOT_UNAVAILABLE_TEXT,
  PAID_CREDITS_TEXT,
  planQuotaExceededText,
  PROMPT_REFUSED_TEXT,
  QUIET_ENV,
  refuseBuiltinTools,
  refuseInit,
  STREAM_STALLED_TEXT,
  THIRD_PARTY_APP_HINT,
  unsendableFindings,
  withThirdPartyAppHint,
} from "./ClaudeGuards.ts";
import { emptyUsage } from "./ClaudeTokens.ts";

const failed = (errorMessage: string): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "claude-bridge",
  provider: "claude-bridge",
  model: "claude-haiku-5-5",
  usage: emptyUsage(),
  stopReason: "error",
  errorMessage,
  timestamp: 0,
});

describe("child env", () => {
  it("strips credentials, Cairn's settings and the quiet flag, and adds the child's own", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/test",
        ANTHROPIC_API_KEY: "must-not-pass",
        ANTHROPIC_BASE_URL: "must-not-pass",
        ANTHROPIC_ANYTHING: "must-not-pass",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-pass",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CAIRN_PORT: "3774",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "parent-session",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_FORK_SUBAGENT: "1",
        [QUIET_ENV]: "1",
        UNSET: undefined,
      },
      false
    );

    expect(env).toStrictEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
      DISABLE_AUTO_COMPACT: "1",
      CLAUDE_CODE_FORK_SUBAGENT: "0",
    });
  });

  it("adds the quiet flag for turn children only", () => {
    expect(childEnv({}, true)[QUIET_ENV]).toBe("1");
    expect(childEnv({}, false)[QUIET_ENV]).toBeUndefined();
  });
});

describe("child refusals", () => {
  it("refuses Claude Code tools of its own", () => {
    const base = {
      cwd: "/w",
      env: {},
      model: "claude-haiku-5-5[1m]",
      append: Option.none(),
      effort: Option.none(),
      thinking: "adaptive",
      session: { kind: "new", sessionId: Option.none() },
      tools: [],
      persistSession: true,
      maxTurns: Option.none(),
      executable: Option.none(),
    } as const;

    expect(
      Option.isNone(refuseBuiltinTools({ ...base, builtinTools: [] }))
    ).toBeTruthy();
    expect(
      refuseBuiltinTools({ ...base, builtinTools: ["Bash"] })
    ).toStrictEqual(Option.some({ kind: "tools", tools: ["Bash"] }));
  });

  it("refuses an init that is not a subscription child with only the bridge's tools", () => {
    const ok = {
      apiKeySource: "none",
      tools: ["mcp__custom-tools__mark"],
      mcpServers: ["custom-tools"],
    };

    expect(Option.isNone(refuseInit(ok, "custom-tools"))).toBeTruthy();
    expect(
      refuseInit({ ...ok, apiKeySource: "ANTHROPIC_API_KEY" }, "custom-tools")
    ).toStrictEqual(
      Option.some({ kind: "apiKeySource", source: "ANTHROPIC_API_KEY" })
    );
    expect(
      refuseInit({ ...ok, tools: [...ok.tools, "Bash"] }, "custom-tools")
    ).toStrictEqual(Option.some({ kind: "tools", tools: ["Bash"] }));
    expect(
      refuseInit(
        { ...ok, mcpServers: ["custom-tools", "claude.ai Gmail"] },
        "custom-tools"
      )
    ).toStrictEqual(
      Option.some({ kind: "mcpServers", names: ["claude.ai Gmail"] })
    );
  });
});

describe("abort reasons", () => {
  it("tells pi-durable's ended invocation from a real abort and from shutdown", () => {
    const ended = new AbortController();
    const real = new AbortController();
    const timeout = new AbortController();

    ended.abort(new Error("Task 3 invocation has ended"));
    real.abort();
    timeout.abort(new DOMException("t", "TimeoutError"));

    expect([
      abortKind(ended.signal, false),
      abortKind(ended.signal, true),
      abortKind(real.signal, false),
      abortKind(real.signal, true),
      abortKind(timeout.signal, false),
    ]).toStrictEqual(["ended", "ended", "abort", "closing", "ended"]);
  });
});

describe("prompt safety", () => {
  it("refuses pi's preamble at a line start, both doc paths, and the routing line", () => {
    const counts = [
      "You are Cairn's coding agent.",
      "You are an expert coding assistant operating inside pi, a harness.",
      "intro\n  You are an expert coding assistant operating inside pi",
      'Describing "You are an expert coding assistant operating inside pi" mid-line.',
      "see docs/custom-provider.md",
      "see docs/custom-provider.md and docs/packages.md",
      "For pi packages, read the docs.",
    ].map((text) => unsendableFindings(text).length);

    expect(counts).toStrictEqual([0, 1, 1, 0, 0, 1, 1]);
  });
});

describe("error texts (J12)", () => {
  const retryable = [CHILD_ENDED_TEXT, STREAM_STALLED_TEXT, CAPACITY_TEXT];

  const final = [
    BRIDGE_FAILED_TEXT,
    INIT_REFUSED_TEXT,
    PROMPT_REFUSED_TEXT,
    EMPTY_PROMPT_TEXT,
    ONE_SHOT_UNAVAILABLE_TEXT,
    PAID_CREDITS_TEXT,
    planQuotaExceededText(Option.none()),
    ...[
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
      "overage",
      "new_window",
    ].map((type) => planQuotaExceededText(Option.some(type))),
    withThirdPartyAppHint(
      "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits."
    ).replace("API Error: 400 ", ""),
  ];

  it("makes pi retry a dead or stalled child and a full bridge", () => {
    expect(
      retryable.map((text) => isRetryableAssistantError(failed(text)))
    ).toStrictEqual(retryable.map(() => true));
  });

  it("never makes pi retry a spent plan window, a refusal or a missing path", () => {
    expect(
      final.map((text) => isRetryableAssistantError(failed(text)))
    ).toStrictEqual(final.map(() => false));
  });

  it("never reads as a context overflow, while Claude Code's own one does", () => {
    const texts = [...retryable, ...final];

    expect(texts.map((text) => isContextOverflow(failed(text)))).toStrictEqual(
      texts.map(() => false)
    );
    expect(
      isContextOverflow(
        failed("prompt is too long: 1000500 tokens > 1000000 maximum")
      )
    ).toBeTruthy();
  });

  it("wins over a rate-limit phrase in the same text", () => {
    expect(
      isRetryableAssistantError(
        failed(
          `${planQuotaExceededText(Option.some("five_hour"))} (rate limit, 429)`
        )
      )
    ).toBeFalsy();
  });

  it("explains Anthropic's third-party rejection once, and passes other failures through", () => {
    const rejection =
      "API Error: 400 Third-party apps now draw from your extra usage.";

    expect(withThirdPartyAppHint(rejection)).toBe(
      `${rejection}\n\n${THIRD_PARTY_APP_HINT}`
    );
    expect(withThirdPartyAppHint(withThirdPartyAppHint(rejection))).toBe(
      withThirdPartyAppHint(rejection)
    );
    expect(claudeFailureText(Option.some("Overloaded"))).toBe("Overloaded");
    expect(claudeFailureText(Option.none())).toContain("without a message");
  });
});
