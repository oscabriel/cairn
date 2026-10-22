# Spike 6 (direct): pi-claude-bridge registered as is, on pi-durable 1.4.0

Result: **ported, not registered** (ADR 0017). Upstream `main` loads and answers, but under pi-durable it kills its own held query at the first tool call, rebuilds Claude Code's transcript cold after a restart, runs the user's `~/.claude` hooks inside thread children, changes `process.env` for the whole process, and has no limit on children.

Run on 2026-10-22 on the Beelink, timeboxed to two hours: pi-claude-bridge at upstream `main` `1ae18a2151c2bac2aa5df7ec691b2ecb7938f0bb` (package 0.9.3 plus five commits), loaded unmodified through a stand-in for pi-coding-agent's extension API (`standin.ts`, from v1 spike 1); pi-ai, pi-coding-agent, pi-tui and pi-durable 1.4.0; Agent SDK 0.3.305 with its bundled `claude` 2.1.305; `claude-haiku-5-5` (sent as `[1m]`); Node 26.11. `fetch-upstream.sh` downloads the bridge into `runs/upstream` (ignored by git), so no upstream code is committed. The stand-in sets `PI_CODING_AGENT_DIR` to the run directory, because upstream writes its notice flags into `claude-bridge.json` under pi's agent dir and `~/.pi/agent` must stay untouched. The SDK's `query` is observed through upstream's own `__test.setQuery`, which records each child's options, hook events and how many run at once; it adds only `includeHookEvents`.

## Numbers

| Measure | How | Result |
| --- | --- | --- |
| First turn after `kill -9` while the tool call is held, 22K-token prefix (`PAD_LINES=800`) | `PAD_LINES=800 ./kill.sh held-pad held` | cache read 2,397 / write 22,527 (0.11x): upstream rebuilt the session cold with `cc-session-io`. v1 measured 0.07x on 0.9.3 |
| Same, Cairn's port (`judges/claude-reminder.ts` turn 3, and `spikes/6-bridge-resume`) | SDK-native resume at the stamp | read 2,697 / write 243 (11x) on the bridge's own prompt; 73x to 85x with a 12K prefix |
| Tool runs after the held kill | `marks.log` | 1. pi-durable records the call as interrupted (`replay: "unsafe"`), and the model reports it instead of retrying |
| `claude` processes left in the killed process group after 1 s | `pgrep -g` | 0 |
| `process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | before and after loading the extension | unset, then `1` for the whole process (it empties the usage probe's windows) |
| `settingSources` of every child | recorded options | the SDK default, so user settings load |
| Hooks from `~/.claude/settings.json` that fired | `hook_started` events | `SessionStart` (the user's herdr hook), once per child: 4 times in the two-thread run |
| Held query across the first tool call | `CLAUDE_BRIDGE_DEBUG` log, two-thread run | killed both times: "consumeQuery: wasAborted=true ... abort detected, marked sharedSession needsRebuild + forceRotate". pi-durable aborts the first generation's signal with `Task N invocation has ended` when it parks on the tool; upstream `main`'s fix (`38980d1`, `1ae18a2`) binds only later runs' signals. Each thread then rebuilt its session for the answer |
| Children for two concurrent threads | `./kill.sh pair pair` | 4 started (2 per thread, because of the rebuild above), 2 at once; no cap. The second thread's first query was handled as a "reentrant subagent" of the first (module-global query context) |
| Extension API the bridge touched | stand-in | `registerProvider` and `on` for `session_start`, `session_before_compact`, `session_before_tree`, `before_agent_start`, `agent_start`, `turn_start`, `session_shutdown`, `session_compact`, `session_tree`, as in v1 |

A third run, `answer` (kill 0.4 s after the tool returned), could not be timed: Haiku finished the whole turn before the kill. v1 measured that window on 0.9.3; Cairn's port is judged on it by J2 (`judges/claude-kill.sh`, wave 3).

## Decision

Port, as `packages/bridge` (plan D3, ADR 0017). Of the twelve Phase 1 requirements in `docs/phase-1/notes/bridge.md` section 3.1, direct registration fails seven, and this run reproduced each that can be run: the first-signal abort, the cold rebuild, `settingSources` and hooks, the process-wide env var, module-global state with reentrant routing, and no semaphore. The other two (no stored session id, no `alwaysLoad` on its hand-rolled MCP server) are read from the source. A wrapper that rewrites the SDK options through `__test.setQuery` would fix the env and settings but not the abort, the rebuild, the global state or the cap.

## Running it

```sh
pnpm install --ignore-workspace
./fetch-upstream.sh
PAD_LINES=800 ./kill.sh held-pad held   # kill -9 while the tool is held, then resume
./kill.sh pair pair                     # two threads at once
```

Logs land in `runs/<name>/` (ignored by git); `CLAUDE_BRIDGE_DEBUG_PATH` puts upstream's own debug log there too. Claude Code transcripts land under `~/.claude/projects/` for each run's workspace folder.
