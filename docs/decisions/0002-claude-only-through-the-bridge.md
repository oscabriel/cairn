# Claude only through the bridge

Every Claude model runs through the bridge: an Agent SDK `query()` against the unmodified `claude` binary with `tools: []`, with pi's tools served back over an in-process MCP server so every tool call executes, durably, in pi-durable. pi-ai's built-in Anthropic OAuth impersonates Claude Code, so Cairn refuses it. A metered Anthropic API key is an ordinary provider; the `anthropic` entry in the user's `auth.json` is one and Cairn does not use it.

## Consequences

- From v1 spike 1: one abort signal per conversation, native resume of Claude Code's own transcript (138x cache read over write, against 0.07x for a rebuild), and Claude Code's `session_id` stored in pi-durable.
- System-prompt changes reach a resumed session only as `<system-reminder>` messages.
- Children run with `settingSources: []`, hooks disabled and `ANTHROPIC_*` stripped; Cairn never reads the subscription's OAuth token.
