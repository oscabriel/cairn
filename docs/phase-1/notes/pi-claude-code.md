# Prior art: earendil-works/pi-claude-code

Read on 2026-10-22 at `70abb65` (`@earendil-works/pi-claude-code` 0.1.0, MIT, built against pi 0.87). It is Earendil's own pi provider for the Claude subscription through the `claude` binary, so it solves the bridge's problem. The bridge was ported from elidickinson/pi-claude-bridge (ADR 0017), not from this package; this note records what it does differently, what Cairn should take from it, and whether any of it earns a spike.

## How it works

- **Raw CLI, not the Agent SDK.** Each worker is `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --max-turns 1 --tools "" --setting-sources "" --strict-mcp-config --no-session-persistence`, with the system prompt in a file and `CLAUDE_CODE_EXTRA_BODY` in a temporary `--settings` file.
- **Inert tools, one request per pi turn.** pi's tools are listed by a stdio MCP server (`inert-mcp.mjs`) whose `tools/call` always answers "Denied: ... only Pi executes tools". With `--max-turns 1`, a tool call ends the worker's turn; pi runs the tool.
- **Replay instead of resume.** Claude Code's hidden history now holds the "Denied" result, so a worker that returned a tool call is never reused: the next pi turn starts a fresh `claude` and replays pi's whole conversation. Warm reuse covers only exact linear continuations, at most two workers, five minutes each.
- **A local relay on the wire.** Every worker gets `ANTHROPIC_BASE_URL` pointing at a loopback route the extension owns (`turn-relay.ts`). It forwards one Messages request per pi turn and rejects Claude Code's recovery attempts, captures the upstream stream before Claude Code parses it (signed thinking, tool arguments, native stop reason), restores the layout of Claude Code's opening reminders on replay, drops moving reminders, moves cache breakpoints, and injects mid-conversation tool additions with their beta header. Claude Code's login headers pass through this route on every request.
- **Child environment.** Refuses to start when an API key, base URL, Bedrock, Vertex or Foundry override is set, then sets `CLAUDE_CODE_MAX_RETRIES=0`, `CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off`, `DISABLE_COMPACT=1`, `DISABLE_AUTO_COMPACT=1`, `ENABLE_TOOL_SEARCH=false`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`.
- **Usage-credit guard** (`billing.ts`). Every `rate_limit_event` with `isUsingOverage: true` fails the turn with a non-retryable "Claude Code billing" error unless `PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS` is set; rejections that ask for usage credits (out of extra usage, third-party classification) are rewritten into the same error. The latest rate-limit status rides on the assistant message as a `claude-code.rate-limit` diagnostic.
- **Login check.** The provider's `check()` runs `claude auth status`; models stay hidden until Claude Code is logged in.

## Against the bridge

| | Bridge | pi-claude-code |
| --- | --- | --- |
| Tool calls | Held query; the result returns into the same query over an in-process MCP server | One request per pi turn; tools inert |
| Continuity | Stamps and SDK-native `resume` (ADR 0018) | Full replay from pi's history every time |
| After `kill -9` | Measured warm (J2: 42K read against about 300 written) | Nothing to resume; replay, cache kept only if the relay's rewrite holds the prefix (not measured) |
| Credentials | `ANTHROPIC_*` stripped; Cairn never touches the token (ADR 0002) | Login headers pass through the extension's relay |
| Request bytes | Claude Code's own | Rewritten on the wire |
| Packaging | Native pi-ai provider behind an Effect service | pi extension (`registerProvider`), pi 0.87 |

## What Cairn should take

1. **The usage-credit guard. Port it; no spike.** `ClaudeEvents.ts` already decodes `isUsingOverage` and `overageInUse`, but nothing acts on them, so a thread that spills into paid usage credits keeps going silently. The rule: a `rate_limit_event` with `isUsingOverage: true` ends the turn with a non-retryable error (the text must match pi-ai's non-retryable pattern, as `PLAN_QUOTA_PREFIX` does), unless a server setting allows usage credits. The judge is a unit test over a recorded event, plus the existing usage display showing the state.
2. **Two child environment variables.** `CLAUDE_CODE_MAX_RETRIES=0` leaves retries to pi-durable, which already classifies and backs off; with Claude Code's own retries left on, the two layers stack (not measured). `CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off` keeps a moving reminder out of the prompt. Both need a J2 rerun, since either could move the cache prefix.
3. **Strip inherited Claude Code session variables.** Found on the way, not in the package: `childEnv` passes `CLAUDECODE` and every `CLAUDE_CODE_*` variable through, so a bridge started from an agent shell (every judge run from Claude Code, spike 8) hands the child the parent session's `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION` and messaging socket, and the child adds a `session_context` attachment (the account email) and a `total_tokens` reminder to its prompt. The deployed user unit does not have these variables. pi-claude-code has the same gap (it spreads `process.env`).
4. **The reminder layout knowledge.** The relay's notes match what spike 7 found from the other side: Claude Code's opening reminders and agent line move, and a moved byte early in the prompt costs the whole cache. Worth reading before any change to how a resumed child is launched.

## What not to take

- **The stateless architecture.** Nothing held across a tool call would remove the held query, stamps, `resumeAppend` and the J2 parked case. But it pays a cold `claude` start and a full replay on every tool round, its cache depends on rewriting Claude Code's requests in flight, and it routes the login headers through Cairn. That is the step toward impersonation ADR 0002 refuses, and the cache it trades for is one the bridge already keeps.
- **The relay itself,** for the same reason.

## Spike or not

No spike. The one thing worth measuring, whether a replayed stateless worker keeps the cache after `kill -9`, would only matter if Cairn were willing to adopt the relay, and ADR 0002 rules that out. The usage-credit guard and the environment changes are small enough to land with their own judges (a unit test; J2 for the environment). Revisit if Anthropic changes how Agent SDK usage is billed: both designs run on `claude -p`, so a change would hit both the same way, and the package's README is where Earendil will say so first.
