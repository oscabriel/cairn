# Spike 6 (resume): the Agent SDK's own resume, per model (J3)

Result: **pass for Haiku, Sonnet and Opus.** After a child is killed, `resume` plus `resumeSessionAt` continues the same Claude Code session (and `forkSession` continues a copy) with cache read 73 to 85 times the write, the tool never runs twice, and the answer uses the result. The bridge's resume rows (ADR 0018) rest on these numbers.

Run on 2026-10-22 on the Beelink: Agent SDK 0.3.305 with its bundled `claude` 2.1.305, Node 26.11, the subscription login, about 12K tokens of cached prefix (Claude Code's preset plus a 5K-token ledger in the append), one in-process MCP tool `mark` (`alwaysLoad`) that appends to a marker file on every call. Children run with the bridge's isolation: `tools: []`, `settingSources: []`, `strictMcpConfig`, hooks off, `ANTHROPIC_*` and `CAIRN_*` stripped. The bridge itself does not run here; `resume.ts` drives the SDK directly, three trials per variant per model, with `[1m]` model ids.

| Variant | Shape | Resume call |
| --- | --- | --- |
| E1 | Kill while the tool call is held: the transcript ends at the `tool_use` | `resume`, `resumeSessionAt` the assistant uuid holding the `tool_use`, the result as prompt text |
| E2 | Kill during the answer: Claude Code already holds its own `tool_result` | `resumeSessionAt` the uuid of that `tool_result` entry (from `getSessionMessages`), a continuation prompt |
| E3 | As E1 with `forkSession: true` | a new session file |
| E4 | As E1 with no result in the prompt ("Continue.") | control: does the model rerun the tool? |

## Numbers (cache read / write on the resumed query; n = 3 each)

| Model | E1 | E2 | E3 | E4 (control) |
| --- | --- | --- | --- | --- |
| `claude-haiku-5-5` | 11,935 / 152 (78x), same session, tool 1, answer used it: 3 of 3 | 11,935 / 142 (84x): 3 of 3 | 11,935 / 152 (78x), new session: 3 of 3 | 108x, tool 1 in 3 of 3; reports the missing result |
| `claude-sonnet-5-5` | 11,156 / 152 (73x): 3 of 3 | 11,157 / 142 (79x): 3 of 3 | 11,156 / 152 (73x): 3 of 3 | 2 of 3 report it; **1 of 3 reran the tool** (tool 2) |
| `claude-opus-5-5` | 11,158 / 152 (73x): 3 of 3 | 11,158 / 142 (79x): 3 of 3 | 11,158 / 152 (73x): 3 of 3 | 101x, tool 1 in 3 of 3 |

Resumed queries answered in 1.1 to 7.5 s. Raw lines are in `runs/<model>.ndjson` (ignored by git).

## What it decides

1. SDK-native resume holds on all three models with real tools: the bridge resumes, it never rebuilds (D5, ADR 0018). The coherent alternative, writing a real `tool_result` record into the transcript, is not needed: no E1 run reran the tool.
2. The prompt must carry the result. E4 is the control: with nothing in the prompt, Sonnet reran the tool once in three. The bridge never resumes in E4's shape: a held call's result goes as text (E1), or Claude Code already holds it and the cut lands after it (E2). `ClaudeConversation.test.ts` covers both rows on the scripted SDK, and `judges/claude-reminder.ts` covers a resume through the real bridge (11x on its smaller prefix).
3. `forkSession` costs nothing in cache (E3), so forking after a real abort or a child error, when the old child may still flush into its file, is cheap insurance.

## Running it

```sh
pnpm install --ignore-workspace
node resume.ts claude-haiku-5-5 3
node resume.ts claude-sonnet-5-5 3
node resume.ts claude-opus-5-5 3
```

Each trial makes a scratch folder under the system temp dir; its Claude Code transcripts land under `~/.claude/projects/`.
