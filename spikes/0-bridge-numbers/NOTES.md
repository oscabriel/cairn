# Spike 0: what a headless `claude` child costs

Result: **about 232 MB per parked child, linear in N, and no orphans even when only the parent is killed.** Memory is not what caps concurrency on the Beelink: six children use 1.4 GB of 27 GiB. The cap is set by plan-window usage and by politeness to the subscription, so start the semaphore at 4 as research 05 suggests, and raise it only with usage-window data.

Run on 2026-10-20 on the Beelink: Agent SDK 0.3.305 with its bundled `claude` 2.1.305 (the same version as the installed CLI), Node 26.11.1. Each child runs with the bridge's isolation: `tools: []`, `settingSources: []`, `settings: { disableAllHooks: true }`, `strictMcpConfig`, `persistSession: false`, `ANTHROPIC_*` stripped, nonessential traffic off. The prompt stream stays open after the turn, the way the bridge parks a query across pi turns.

This measures the child directly through the SDK, not through pi-durable plus the bridge. The bridge adds an in-process MCP server and pi-durable's commit path on top. Time to first token through the full bridge gets measured again once the bridge is ported in phase 1.

## Numbers

| Measure | Result |
| --- | --- |
| Processes per child | 1 (`claude`; no helper processes) |
| RSS per child, parked after one turn | median 231 to 232 MB, max 237 MB, flat from N = 1 to 6 |
| RSS total, generating | 257 MB at N = 1, 1,544 MB at N = 6 (about 258 MB per child) |
| RSS total, parked | 236 MB at N = 1, 1,391 MB at N = 6 |
| Spawn to `system:init` | 198 to 261 ms (rises slightly with N) |
| Time to first token, N = 1, tiny prompt | Haiku 5.5: 0.94 / 1.29 / 1.31 s. Sonnet 5.5: 1.44 to 2.60 s over four runs. Opus 5.5: 1.26 / 1.45 / 1.78 s |
| Time to first token at N = 6, Sonnet | median 1.51 s (no slowdown from concurrency) |
| `claude` children alive after the prompt stream closes | 0 within 2 s, every run |
| After `kill -9` of the parent only (3 parked) | 0 of 3 alive at 1 s |
| After `kill -9` of the process group (3 parked) | 0 of 3 alive at 1 s |

Time to first token is mostly API latency: the API duration for a 6-token answer was about 1.1 s. The first turn of each fresh child wrote about 585 tokens to the 1-hour cache.

## Is a bridged MCP tool deferred behind tool search?

No, not with `tools: []`. A single in-process MCP tool (`mcp__pi__codemode`) showed up in `system:init` and was called directly on the first turn, both with and without `alwaysLoad`. The SDK documents that MCP tools are deferred "when tool search is enabled", and with no built-in tools there is no tool-search tool. The port should still set `alwaysLoad: true` on its SDK MCP server, so a future default can't put pi's tools behind a search turn. This answers research 05 Q8.

## Decisions

- **Child cap: start at 4,** gated on plan-window utilization rather than memory. At about 260 MB per child, even 12 would fit in 3.1 GB.
- **No orphan reaper is needed** for parked children: a child exits when its stdin closes, so it follows the brain down even when only the brain is killed. Keep a boot-time check in phase 1 anyway (a cheap outside judge): count `claude` processes whose parent is gone.
- **Set `alwaysLoad: true`** on the bridge's MCP server.
- Pin `@anthropic-ai/claude-agent-sdk` at `0.3.305`; it bundles `claude` 2.1.305.

## Files

- `children.ts`: N concurrent children, timed, with RSS sampled from `/proc` every 100 ms.
- `sweep.sh`: the RSS sweep and the per-model time-to-first-token runs. Output in `runs/sweep.jsonl`.
- `kill.sh parent|group`: the orphan test.
- `deferral.ts`: the tool-search check.
