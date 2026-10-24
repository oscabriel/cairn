// Ported from cairn-v1, apps/server/src/claude/{query-options.ts, prompt-safety.ts, abort.ts} at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0, plus w-winter/dot314,
// extensions/pi-claude-bridge/src/third-party-rejection.ts at c157f4e6f9fda15b2d6698a12820e7118d19fbd7,
// and the CC_CHILD_ENV idea from elidickinson/pi-claude-bridge, src/index.ts (lines 48-64) at
// 874fa7c2678456336f23b64e784e2057e608d83e. Behaviour kept; rewritten as Cairn's pure guards: the
// child's options are a Cairn value checked here, env stripping adds CAIRN_* and every ANTHROPIC_*
// name, and every error text the bridge produces is defined here so its retry class is judged once.
//
// MIT License
//
// Copyright (c) 2026 Eli Dickinson
// Copyright (c) 2026 Warren Winter
// Copyright (c) 2026 Nico Bailon
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
import { Option } from "effect";

import type { ToolDeclaration } from "./ClaudeMcp.ts";

/** Claude Code's effort levels, which the bridge maps pi's thinking levels onto. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** How a child's Claude Code session starts: new (optionally under a chosen id) or resumed. */
export type ChildSession =
  | { readonly kind: "new"; readonly sessionId: Option.Option<string> }
  | {
      readonly kind: "resume";
      readonly sessionId: string;
      /** Resume at this chain uuid, dropping what follows it. */
      readonly at: Option.Option<string>;
      /** Write the resumed session to a new file, leaving the old one as it is. */
      readonly fork: boolean;
    };

/** Everything a Claude Code child is started with, as Cairn values. `ClaudeSdk` maps it onto the Agent SDK. */
export interface ChildOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** The model id sent to Claude Code, `[1m]` included. */
  readonly model: string;
  /** Claude Code's own tools. Always empty: `bypassPermissions` is safe only because Claude Code has none. */
  readonly builtinTools: ReadonlyArray<string>;
  /** The `claude_code` preset's append, sent only to a new session (a resumed one keeps its own). */
  readonly append: Option.Option<string>;
  readonly effort: Option.Option<Effort>;
  /** Thinking off maps to `{type: "disabled"}`; otherwise Claude Code's adaptive default. */
  readonly thinking: "adaptive" | "disabled";
  readonly session: ChildSession;
  /** pi's tools, served to Claude Code over one in-process MCP server. */
  readonly tools: ReadonlyArray<ToolDeclaration>;
  /** False only for one-shot children whose transcript nobody resumes. */
  readonly persistSession: boolean;
  readonly maxTurns: Option.Option<number>;
  /** The `claude` binary; none means the SDK's bundled one. */
  readonly executable: Option.Option<string>;
}

/**
 * Applied to every child. ENABLE_CLAUDEAI_MCP_SERVERS keeps the account's claude.ai MCP servers out
 * of a thread, DISABLE_AUTO_COMPACT leaves compaction to pi-durable, CLAUDE_CODE_FORK_SUBAGENT keeps
 * fork subagents off even though a child has no Agent tool.
 */
export const CHILD_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
  CLAUDE_CODE_FORK_SUBAGENT: "0",
} as const;

/** Set on turn children only, never in `process.env`: with it the usage probe gets no windows. */
export const QUIET_ENV = "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC";

/**
 * Variables a child must not inherit. `ANTHROPIC_*` and `CLAUDE_CODE_OAUTH_TOKEN`/`_USE_*` would move
 * it off the subscription login; `CLAUDECODE` and the other `CLAUDE_CODE_*` are a parent Claude Code
 * session's (a bridge started from an agent shell, such as a judge), which would hand the child that
 * session's id and messaging socket and add its reminders to the prompt. Removing them is not reading
 * them: Cairn never looks at their values. `CHILD_ENV` and `QUIET_ENV` are set after the strip.
 */
const STRIPPED_ENV: ReadonlySet<string> = new Set(["CLAUDECODE"]);

const strippedPrefixes: ReadonlyArray<string> = [
  "ANTHROPIC_",
  "CAIRN_",
  "CLAUDE_CODE_",
];

const isStripped = (key: string): boolean =>
  STRIPPED_ENV.has(key) ||
  strippedPrefixes.some((prefix) => key.startsWith(prefix));

/** An environment a child starts from, such as `process.env`. */
export type SourceEnv = Readonly<Record<string, string | undefined>>;

/**
 * A child's environment: `source` without Cairn's settings or any credential override, plus
 * `CHILD_ENV`. `quiet` adds `QUIET_ENV` for turn children; without it the variable is removed even
 * when the brain's own environment has it.
 */
export const childEnv = (source: SourceEnv, quiet: boolean) => {
  const kept = Object.entries(source).flatMap(([key, value]) =>
    value === undefined || isStripped(key) || key === QUIET_ENV
      ? []
      : [[key, value] as const]
  );

  const quietEntries = quiet ? [[QUIET_ENV, "1"] as const] : [];

  return Object.fromEntries([
    ...kept,
    ...Object.entries(CHILD_ENV),
    ...quietEntries,
  ]);
};

/**
 * Context files are pi-durable's job. `settingSources: []` already skips the user's and the
 * project's CLAUDE.md; these cover copies a managed policy could still load.
 */
export const CLAUDE_MD_EXCLUDES: ReadonlyArray<string> = [
  "**/CLAUDE.md",
  "**/AGENTS.md",
  "**/.claude/rules/**",
];

/**
 * Days before Claude Code sweeps a transcript. Large, so the bridge's own children never delete a
 * session a thread may resume; the user's interactive `claude` still sweeps with its own setting.
 */
export const CLEANUP_PERIOD_DAYS = 3650;

/** Per-call wall clock limit for a served tool: a held call can wait on a long tool or a human. */
export const TOOL_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** Why a child was refused before or at start. */
export type ChildRefusal =
  | { readonly kind: "tools"; readonly tools: ReadonlyArray<string> }
  | { readonly kind: "apiKeySource"; readonly source: string }
  | { readonly kind: "mcpServers"; readonly names: ReadonlyArray<string> };

/** `Option.some` of the refusal when `options` would give Claude Code tools of its own. */
export const refuseBuiltinTools = (
  options: ChildOptions
): Option.Option<ChildRefusal> =>
  options.builtinTools.length === 0
    ? Option.none()
    : Option.some({ kind: "tools", tools: options.builtinTools });

/** What a child's `system:init` message reports, as far as the guards read it. */
export interface InitReport {
  readonly apiKeySource: string;
  readonly tools: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<string>;
}

/**
 * `Option.some` of the refusal when a child's init shows it is not a subscription child: an API key
 * source other than `none`, a tool that is not one of ours, or an MCP server other than the bridge's.
 */
export const refuseInit = (
  init: InitReport,
  serverName: string
): Option.Option<ChildRefusal> => {
  if (init.apiKeySource !== "none") {
    return Option.some({ kind: "apiKeySource", source: init.apiKeySource });
  }

  const foreignServers = init.mcpServers.filter((name) => name !== serverName);

  if (foreignServers.length > 0) {
    return Option.some({ kind: "mcpServers", names: foreignServers });
  }

  const prefix = `mcp__${serverName}__`;
  const foreignTools = init.tools.filter((tool) => !tool.startsWith(prefix));

  return foreignTools.length > 0
    ? Option.some({ kind: "tools", tools: foreignTools })
    : Option.none();
};

/** What an aborted generation signal means for the conversation's held query. */
export type AbortKind = "ended" | "abort" | "closing";

/**
 * pi-durable aborts a generation's signal for three reasons: the invocation ended (routine, at every
 * tool boundary, `Error("Task N invocation has ended")`), an abort request, and shutdown. Only the
 * default `AbortError` of the last two is real; `closing` tells shutdown from a user abort.
 */
export const abortKind = (signal: AbortSignal, closing: boolean): AbortKind => {
  const reason: unknown = signal.reason;
  const real = reason instanceof DOMException && reason.name === "AbortError";

  if (!real) {
    return "ended";
  }

  return closing ? "closing" : "abort";
};

/** pi-coding-agent's preamble, the first section of every prompt it renders. */
export const PI_PREAMBLE =
  "You are an expert coding assistant operating inside pi";

/** Both doc paths from pi-coding-agent's documentation line; Anthropic rejects a prompt with both. */
export const THIRD_PARTY_DOC_PATHS: ReadonlyArray<string> = [
  "docs/custom-provider.md",
  "docs/packages.md",
];

/** pi's documentation routing line, which upstream isolated as the trigger of August's 400s. */
export const PI_PACKAGES_LINE = "pi packages";

const preambleAtLineStart = (text: string): boolean =>
  text.split("\n").some((line) => line.trimStart().startsWith(PI_PREAMBLE));

/**
 * The findings that make `text` unsendable as instructions to a subscription child: pi's preamble at
 * a line start, both documentation paths, or pi's documentation routing line. Empty when sendable.
 */
export const unsendableFindings = (text: string): ReadonlyArray<string> => {
  const findings: Array<string> = [];

  if (preambleAtLineStart(text)) {
    findings.push("pi's preamble at a line start");
  }

  if (THIRD_PARTY_DOC_PATHS.every((path) => text.includes(path))) {
    findings.push(`both ${THIRD_PARTY_DOC_PATHS.join(" and ")}`);
  }

  if (text.toLowerCase().includes(PI_PACKAGES_LINE)) {
    findings.push("pi's documentation routing line");
  }

  return findings;
};

/** True for Anthropic's third-party-app rejection, recognized by its own words. */
export const isThirdPartyAppRejection = (text: string): boolean =>
  /third-party apps/iu.test(text) && /extra usage/iu.test(text);

// Every text below is fixed, with no runtime values: pi-ai's `isRetryableAssistantError` and
// `isContextOverflow` read the whole error text, so a path, a number or a time could make pi retry
// or compact. `ClaudeGuards.test.ts` judges each against both classifiers.

/** Anthropic's third-party-app rejection, explained. Not retryable. */
export const THIRD_PARTY_APP_HINT =
  "Cairn: Anthropic treats this request's instructions as a third-party app. Check the thread's instruction sections for pi's documentation line or another harness's prompt text.";

/** `message` with the third-party hint added when it is Anthropic's third-party-app rejection. */
export const withThirdPartyAppHint = (message: string): string =>
  isThirdPartyAppRejection(message) && !message.includes(THIRD_PARTY_APP_HINT)
    ? `${message}\n\n${THIRD_PARTY_APP_HINT}`
    : message;

/** The prefix of a plan-window rejection; `quota exceeded` is non-retryable in pi-ai and wins. */
export const PLAN_QUOTA_PREFIX = "Claude plan quota exceeded";

const planWindowLabel = (type: string): Option.Option<string> => {
  switch (type) {
    case "five_hour": {
      return Option.some("five hour");
    }

    case "seven_day":
    case "seven_day_overage_included": {
      return Option.some("weekly");
    }

    case "seven_day_opus": {
      return Option.some("weekly Opus");
    }

    case "seven_day_sonnet": {
      return Option.some("weekly Sonnet");
    }

    case "overage": {
      return Option.some("extra usage");
    }

    default: {
      return Option.none();
    }
  }
};

/**
 * The error text of a turn Claude refused because a plan window is spent. Not retryable; the reset
 * time travels apart from the text (`ClaudeSignals`), because a time in it could read as a status.
 */
export const planQuotaExceededText = (
  rateLimitType: Option.Option<string>
): string => {
  const label = Option.flatMap(rateLimitType, planWindowLabel);

  return Option.match(label, {
    onNone: () =>
      `${PLAN_QUOTA_PREFIX}: a plan window is spent. Send again after it resets.`,
    onSome: (window) =>
      `${PLAN_QUOTA_PREFIX}: the ${window} window is spent. Send again after it resets.`,
  });
};

/**
 * A subscription turn that started drawing on paid usage credits. Not retryable (it carries the plan
 * quota prefix): paying for a turn is a purposeful choice of an `anthropic` provider model.
 */
export const PAID_CREDITS_TEXT = `${PLAN_QUOTA_PREFIX}: this turn started drawing on paid usage credits, which Claude subscription threads never use. Pick an anthropic provider model to pay for it, or send again after the plan window resets.`;

/** A child that died before its turn finished. Retryable: the resumed attempt is cheap. */
export const CHILD_ENDED_TEXT =
  "Claude Code child terminated before the turn finished.";

/** A child that produced nothing for too long. Retryable. */
export const STREAM_STALLED_TEXT =
  "Claude Code stream timed out with no output.";

/** Every live child is in use. Retryable. */
export const CAPACITY_TEXT =
  "Claude bridge is overloaded: every live Claude Code child is in use.";

/** A child that did not start on the subscription login. Not retryable. */
export const INIT_REFUSED_TEXT =
  "Claude bridge refused the child: it did not start on the subscription login with only Cairn's tools. Check the Claude Code login on the brain's host.";

/** Instructions carrying text Anthropic reads as a third-party app. Not retryable. */
export const PROMPT_REFUSED_TEXT =
  "Claude bridge refused the instructions: they carry pi's preamble or documentation lines, which Anthropic reads as a third-party app. Remove that text from the thread's sections.";

/** A call that reached the bridge without the instructions or tools it needs. Not retryable. */
export const EMPTY_PROMPT_TEXT =
  "Claude bridge received a turn with nothing to send.";

/** A one-shot request (`cacheRetention: "none"`) while no one-shot path is installed. Not retryable. */
export const ONE_SHOT_UNAVAILABLE_TEXT =
  "Claude bridge has no one-shot path for this request in this build.";

/** A call the bridge itself failed on before Claude Code answered (a defect). Not retryable. */
export const BRIDGE_FAILED_TEXT =
  "Claude bridge failed on this turn before Claude Code answered. The brain's log has the cause.";

/** Claude Code's own failure text, or a default when it gave none. */
export const claudeFailureText = (text: Option.Option<string>): string =>
  Option.match(
    Option.filter(text, (value) => value.trim().length > 0),
    {
      onNone: () => "Claude Code reported an error without a message.",
      onSome: withThirdPartyAppHint,
    }
  );
