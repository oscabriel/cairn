# Spike 7: the held tool call after a kill keeps the prompt cache (J2 parked)

Result: **pass.** The parked case lost the cache because Claude Code named a different agent in the first line of the system prompt after the resume, not because it repaired the dangling tool_use. Resuming with an append whenever the stamped session had one keeps the line, and the first reply after the restart reads the whole prefix: 107x in this spike, 103x and 125x in J2.

Run on 2026-10-22 on the Beelink: Agent SDK 0.3.305 with its bundled `claude` 2.1.305, Node 26.11, the subscription login, `claude-haiku-5-5`.

## What Claude Code does

Read from the transcripts the judge left (`--keep`) and from the bundled binary's strings (`inspect.ts` prints a transcript's shape):

1. Before the first request Claude Code writes a `prompt_snapshot` attachment holding the rendered system prompt. Every later request and resume sends that record verbatim, whatever a later launch passes (the `systemPromptSnapshot` option's description says so).
2. The first line of the system prompt, the agent line, is not in that first record. Claude Code adds it (`cliPrefix`) to a second `prompt_snapshot` written after the first reply's tool results come back. Until then a resume picks the line again: `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.` when the launch has an append, `You are a Claude agent, built on Anthropic's Claude Agent SDK.` when it has none.
3. The bridge resumed without an append (the instructions live in the recorded prompt, and changes travel as one reminder). A `kill -9` while the first turn's tool call is held lands before the second snapshot, so the resumed request sent the other agent line and only the tool definitions (about 3.2K tokens, which come before the system prompt) were read from the cache.
4. The repair itself is harmless to the cache: on resume Claude Code appends a `tool_result` for the dangling id (`[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. ...]`) and a synthetic `No response requested.` assistant entry, both after the cached prefix. The tool never reran.

## Numbers (cache read / write on the first request after the resume)

`held.ts`: a first turn with an append and an 800-line ledger in the first user message; the `mark` tool appends to a marker file and never returns; the child gets SIGKILL a second after the call; the resume carries the interrupted result as prompt text, as the bridge does. Two trials per variant, `runs/claude-haiku-5-5.ndjson` (ignored by git).

| Variant | Resume | Read / write | Ratio | Agent line after resume | Tool runs |
| --- | --- | --- | --- | --- | --- |
| no-append | `resume`, no append (the bridge before 4J2) | 2,382 / 22,331 and 2,382 / 22,329 | 0.1x | changed | 1, 1 |
| append | `resume`, the same append | 24,493 / 228 and 24,491 / 228 | 107x | same | 1, 1 |
| at | `resume` with `resumeSessionAt` the tool_use entry, no append | 2,382 / 22,281 and 2,382 / 22,283 | 0.1x | changed | 1, 1 |

A first version of the spike left the read loop before the kill, which closes the query: Claude Code then recorded its own interrupted result and the second snapshot before dying, and every variant kept the cache (116x to 226x without an append). Only a kill that lands while the call is still held reproduces the parked case.

`judges/claude-kill.ts --case parked` (the judge brain, the real bridge, the `bash` tool, about 42K tokens of prefix):

| Bridge | First reply after the restart | Ratio |
| --- | --- | --- |
| before 4J2 (wave 3, and again here) | 3,235 / 39,171; 3,235 / 39,168 | 0.08x |
| after 4J2 | 42,073 / 409; 42,079 / 337 | 103x, 125x |

Every other check held in every run: the marker has one line, an interrupted result is committed, the children were gone in 57 to 76 ms, the snapshot reached the reconnected client in 5 ms, and no `claude` process was left outside the unit.

## What it decides

1. `ClaudeResume.resumeAppend`: a resume or a fork of a stamped session launches with an append exactly when the stamped instructions rendered one (the current instructions; Claude Code ignores the text while it holds its record). A session stamped with no instructions still resumes without one.
2. Not taken: delivering the interrupted result as a real `tool_result` block (the repair already writes one, and it does not touch the prefix), forking at the tool_use entry (`resumeSessionAt` drops the second snapshot when there is one, and the line still changes without an append, row `at`), and relaxing J2's cache criterion for the held case (not needed).
3. ADR 0017's held-case gap is closed; J2's other two cases are unchanged by this.

## Running it

```sh
pnpm install --ignore-workspace
node held.ts claude-haiku-5-5 2
node inspect.ts ~/.claude/projects/<escaped folder>/<session>.jsonl
```

Each trial makes a scratch folder under the system temp dir; its transcripts land under `~/.claude/projects/-tmp-cairn-s7-*` and can be removed afterwards.
