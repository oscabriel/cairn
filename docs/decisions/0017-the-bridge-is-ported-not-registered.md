---
status: proposed
gate: spikes/6-bridge-direct numbers, then J2
---

# The bridge is ported, not registered

Cairn serves the Claude subscription through `@cairn/bridge`, a native pi-ai provider (`claude-bridge`) ported from pi-claude-bridge 0.9.3 (`874fa7c2`), dot314 and Cairn v1, behind one Effect service, rather than registering upstream's pi extension through a stand-in API. Run once, timeboxed, on pi-durable 1.4.0 (`spikes/6-bridge-direct/NOTES.md`), upstream `main` (`1ae18a2`) loads and answers but kills its own held query at the first tool call (pi-durable aborts the first generation's signal when it parks), rebuilds the Claude Code transcript cold after a restart (cache read 2,397 against a write of 22,527), runs the user's `~/.claude` hooks in thread children (`settingSources` left at the default), sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` for the whole process, keeps one module-wide query context, and starts children without a cap. The port keeps upstream's tool-result state machine, MCP schema flattening and stream mapping, and changes the rest: one abort signal per conversation, stamps and SDK-native resume (ADR 0018), isolation by construction, a semaphore of generation permits, and per-conversation state in an `RcMap`.

Consequences: children run in the thread's real folder (realpath), so Claude Code files their transcripts under `~/.claude/projects/<escaped folder>/`. Cairn's sessions appear in the user's interactive `claude --resume` list for that folder, and the user's own `claude` sweeps them by its `cleanupPeriodDays` (the bridge's children set a large value for their own sweeps). Moving `CLAUDE_CONFIG_DIR` would isolate them, but it moves the credentials too, so it needs a second `claude` login; that is an open question for the wizard, not Phase 1. A swept transcript only costs a fresh session seeded with pi's context. Cairn owns about 6,000 formatted lines of ported code (license headers included) and must re-read upstream's changelog for fixes worth porting.

Gate: the spike's numbers (recorded), then J2 (`judges/claude-kill.sh`: `kill -9` while streaming, while a tool call is held and during the answer, with one marker line, no orphans and a warm cache after the restart).
