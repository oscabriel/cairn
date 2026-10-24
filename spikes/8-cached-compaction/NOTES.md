# Spike 8: compaction on a Claude thread reads the prompt cache the thread built

Result: **pass, with three conditions for the real thing.** A `beforeCompact` hook that asks for the summary as the next turn of a fork of the thread's own Claude Code session reads nearly the whole prefix from the cache (39x to 42x at idle, 30x mid-turn, on Haiku, Sonnet and Opus), and its summary keeps every fact that pi-durable's summarizer loses to the 2,000-character tool result cut (3 of 3 against 0 of 3). It needs no bridge change: a summary request under a throwaway pi session id takes the bridge's existing `fork-stamped` path. The conditions: wait for the stamped entry to reach the transcript before forking (mid-turn, it is not there yet), tell the summarizer that the thread's own reply instructions do not bind the summary, and delete the fork's transcript afterwards.

Run on 2026-10-22 on the Beelink: Agent SDK 0.3.305 with its bundled `claude` 2.1.305, pi 1.4.0, Node 26.11, the subscription login, `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`.

The idea is nicobailon/pi-cached-compaction (`64eb3fa`, MIT), whose Claude path asks pi-claude-bridge to fork the live session with an `x-claude-bridge-fork` header. The summary instruction in `compaction.ts` is a port of intent of its `summaryInstruction`.

## What the spike does

`compaction.ts` builds one thread per trial on the real bridge, with a bare pi-durable Harness on a scratch store (the way `judges/claude-live.ts` does), Cairn's `bridge-cwd` extension and one tool, `read_log`, that returns a 20 KB log. Three turns each read one log (tests, build, config) and reply with one word; each log holds one fact past its first 2,000 characters (a failing test's expected and actual balance, the line of a deprecation warning, `retention_days`), with random values per trial, and no reply restates them. A fourth turn says the user's favourite bird, which `keepRecentTokens: 10` keeps verbatim. Then a manual compaction, and a last turn asks for the four facts with tools forbidden.

- `baseline`: pi-durable's own compaction, which the bridge runs as a one-shot in a fresh child over the flattened history.
- `cached`: a `beforeCompact` hook. It keeps the last request's messages (`beforeRequest`) and terminal reply (`afterResponse`) per conversation, checks that the compacted range is a prefix of them (conversation messages only: the request hoists system messages to the front), quotes the first kept message, and calls the bridge with `[...request, reply, instruction]` under a fresh session id. The bridge sees a stamp from another pi session and forks the Claude Code session at the stamp, then resumes the copy with the instruction as the user turn. The hook then ends the fork's child (`abortConversation`) and returns the summary.
- `midturn`: the same hook, with the compaction started while the third read is still running (2 s into a 4 s tool call), as a background compaction would.

A nonce at the start of the first message makes each trial's flattened history unique, so the baseline one-shot cannot read an earlier trial's cache (it did, before the nonce: section "Measuring the baseline").

## Numbers

Summary request: cache read / write in tokens, from the bridge's usage. Facts: of the three past the cut. Bird: whether the kept turn's fact leaked into the summary (it should not) and whether the answer has it (it should). Sessions: what the bridge opened for the compaction.

| Model | Variant | Trials | Context before | Summary read / write | Ratio | Time (s) | Facts in summary | Facts in answer | Kept turn in summary |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Haiku | baseline | 3 | 26.1K | 2,040 / 4,310 to 4,322 | 0.5x | 3.5 to 3.8 | 0 | 0 | 0 of 3 |
| Haiku | cached | 3 | 26.1K to 26.3K | 29,899 to 30,176 / 719 | 42x | 5.3 to 6.6 | 3 | 3 | 0 of 3 |
| Haiku | midturn | 3 | 26.1K to 26.2K | 26,131 to 26,215 / 846 | 31x | 4.2 to 5.8 | 2 of 2 | 3 | 0 of 3 |
| Sonnet | baseline | 1 | 25.2K | 1,260 / 4,313 | 0.3x | 4.6 | 0 | 0 | 0 of 1 |
| Sonnet | cached | 2 | 25.2K | 29,014 to 29,015 / 743 to 744 | 39x | 6.8 to 9.8 | 3 | 3 | 2 of 2, named as kept |
| Sonnet | midturn | 2 | 25.2K | 25,211 / 846 | 30x | 4.4 to 8.5 | 2 of 2 | 3 | 0 of 2 |
| Opus | baseline | 1 | 25.2K | 0 / 5,574 | 0x | 5.6 | 0 | 0 | 0 of 1 |
| Opus | cached | 1 | 25.2K | 29,016 / 743 | 39x | 7.3 | 3 | 3 | 0 of 1 |
| Opus | midturn | 1 | 25.2K | 25,212 / 846 | 30x | 5.0 | 2 of 2 | 3 | 0 of 1 |

Mid-turn, the config log's result arrives after the fork, so two facts are in reach of the summary; the third reaches the answer through the kept tail. One Haiku mid-turn answer said "unknown" for the bird, which the kept tail held; every other answer had it. Every cache write was at the one-hour tier (`cacheWrite1h` equal to `cacheWrite`). No read reply restated a fact, and no model called a tool after the compaction.

The baseline rows are the trials whose one-shot could not read an earlier trial's cache (section "Measuring the baseline"). The strict-prompt runs (finding 5):

| Model | Instruction | Summary read / write | Facts in summary | Facts in answer |
| --- | --- | --- | --- | --- |
| Sonnet | without the checkpoint paragraph | 29,042 / 649 | 0 | 0 |
| Sonnet | with it | 29,033 / 743 | 3 | 3 |
| Haiku | with it | 29,959 / 734 | 3 | 3 |
| Opus | with it | 29,053 / 744 | 3 | 3 |

## What it found

1. **The fork reads the cache.** At idle the summary request reads the thread's whole prefix and writes only the instruction and the tail. The fork resumes the copy without `resumeSessionAt` (the copy ends at the stamp), so the 22K rewrite measured for `resumeSessionAt` in `ClaudeConversation.resumePlan` does not apply.
2. **The summary sees whole tool results.** Every cached summary that ran on the plain prompt kept all three facts; no baseline summary kept any, and the baseline answers said "unknown" for all three.
3. **The boundary holds, with some repetition.** No summary reported the kept turn as done. Four of the eleven cached summaries mentioned it, each time as kept or as after the checkpoint ("came after this checkpoint and is not part of the summarized work"), which repeats a few words of context and loses nothing; no baseline summary did, since the one-shot never sees the kept turn. Quoting the first kept message, as pi-cached-compaction does, was enough to place the cut.
4. **Mid-turn, the stamped entry is not in the transcript yet.** A compaction started a few milliseconds after the tool call forked nothing: `forkSession` answered `Message <uuid> not found in session` (the stamp's `ccUuid` names the tool_use entry, which Claude Code had not written yet), and the bridge's `fork-stamped` branch fell back to a fresh seeded session without a log line (`ClaudeConversation.ts`, `openFor`). That summary was still correct, since the seed prompt carries whole tool results, but it wrote 24,360 tokens cold. Started 2 s into the call, the fork found the entry and read the cache. The real hook must wait for the entry (poll `sdk.entries` for the stamp's uuid, a few seconds at most) before it forks, and fall back to pi-durable's compaction if it never appears. The same race applies to a pi fork made while a turn is mid-tool.
5. **The summarizer inherits the thread's instructions.** The first Sonnet runs read the logs under "Do not quote, summarize or describe the log", and Sonnet applied that to the summary itself: "this summary deliberately holds no log details", three "unknown" answers. pi-durable's own summarizer has its own system prompt and never sees such an instruction as binding. One added paragraph in the instruction (the summary is a checkpoint, not a reply, and earlier instructions about how to answer do not limit what it records) fixed it: Sonnet on the same strict prompt kept all three facts (29,033 read, 743 written). Haiku and Opus on the strict prompt with the paragraph kept all three too.
6. **It takes longer than the one-shot:** 5 to 10 s against 3.5 to 5.6 s, for a larger prompt, a resume and summaries about twice as long (500 to 1,100 output tokens).

## Measuring the baseline

Every baseline trial after the first in a process read about 6,000 tokens from the cache and wrote 340: the flattened histories of two trials were the same up to the facts, which sit past the cut, so each one-shot read the one before it. A real thread's history is its own, so a real baseline writes all of it. A nonce at the start of the first message (it first missed the prompt through an operator-precedence slip, which the recorded one-shot prompt showed) fixed it: the baseline then reads only the fixed head every one-shot shares (Claude Code's prompt and pi-durable's summarizer prompt, about 2K) and writes the rest, 4,310 to 4,322 on Haiku over three trials. The table keeps only such trials.

## What it costs at real sizes

Prices below are Anthropic's API ratios (cache reads 0.1x, one-hour cache writes 2x); how the plan windows weigh cache reads and writes is not published, so these are the best proxy, not a quota measurement.

At this spike's size (about 26K of context, nine tenths of it tool output that the cut removes), the baseline sends little: about 6.4K, of which 4.3K is written at the one-hour tier. That is about 8.8K token-equivalents, against about 4.4K for the cached path (30K read, 720 written). Even here the cached path costs about half, and its summary is the one that kept the facts.

Real threads keep far more of their history through the cut. Measured over 108 of the user's own Claude Code sessions above 50K tokens (median 102K, sizes only, `~/.claude/projects`): pi-durable's summarizer would see a median 64% of the text (p10 33%, p90 78%); tool output is a median 62% of the text, and 41% of it survives the cut. Cairn's own store has no thread above 7K yet, so it cannot answer this. At the median, a baseline compaction of a context of C tokens writes about 0.64 C (1.3 C at the one-hour tier), while the cached path reads C (0.1 C). The cached path is cheaper whenever the flattened history is more than about a twentieth of the context, which is every real session in the sample, and by about thirteen times at the median.

## Bugs found on the way

1. **Parallel tool calls hang a thread.** The first version of the spike read all three logs in one turn. Haiku answered with three `tool_use` blocks in one message. Claude Code started running the first call as soon as its block finished, before the other two streamed; the bridge's `toolCallArrived()` forces the turn to end at that point (`ClaudeStream.#endToolUse(true)`), so pi got a turn with one call. The second block's `assistant` event then arrived while no provider call was open and was dropped (`#onAssistant` records only its id when `!this.open`); the third landed after the next `begin()` and was delivered. pi never saw `build`, so its result never came, and the held query waited with the stall watchdog quiet, because a held tool call is a legitimate wait (the tool timeout is four hours). Any model that calls tools in parallel can hit this. The spike reads one log per turn to stay clear of it. Fix in the bridge, with a judge: one turn, three parallel calls, all three results delivered.
2. **One-shot output tokens are under-reported.** `ClaudeSummary` takes usage from `assistant` events only, which carry the opening snapshot: baseline summaries of about 1,600 characters reported 1 to 6 output tokens. The `result` event's usage has the totals. pi-durable records this usage for every compaction, so `pi.usage` undercounts summary output.
3. **A failed fork is silent.** `openFor` turns a failed `sdk.fork` into a fresh session with no log line (finding 4 needed a recording wrapper to see the error).
4. **Children inherit an agent shell's Claude Code session variables.** `childEnv` passes `CLAUDECODE` and every `CLAUDE_CODE_*` variable through. Run from Claude Code, as every judge and this spike are, the children got the parent session's `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION` and messaging socket, and added a `session_context` attachment with the account email and a `total_tokens` reminder to their prompts (one Sonnet summary copied the email into its constraints). The deployed user unit does not have these variables; judges do. Same variant in both arms, so the comparison holds.

## What the real thing needs

- **Where it lives.** A brain extension with the three hooks, beside `bridge-cwd`, for bridge models only. The capture is in memory, so after a restart the first compaction before any request falls back to pi-durable's (a compaction the generation triggers always follows a request in the same process).
- **Through the bridge's `fork-stamped` path,** unchanged, plus the wait for the stamped entry (finding 4) and a log line when a fork fails.
- **The fork's transcript is deleted** after the summary. Cairn's children never let Claude Code sweep their transcripts (`CLEANUP_PERIOD_DAYS`), and each fork otherwise stays in the user's `claude --resume` list for the thread's folder.
- **The fork's child is ended** at once and holds a Claude slot only while it generates.
- **The instruction** as in `compaction.ts`, with the checkpoint paragraph (finding 5).
- **Fall back, never fail.** Any failed check (not a bridge model, no stamped reply, the range is not a prefix, nothing to quote, a fork that never finds its entry, a tool call, an empty or cut-off summary) returns nothing, and pi-durable's own compaction runs.
- **Spend.** pi-durable records usage only for its own summary request; a summary a hook supplies is placed without one (`place()` in `harness/compaction.js`), so the cached path's spend would be missing from `pi.usage`. The bridge's plan windows still see it. Needs either a pi-durable way for a hook to report usage, or a Cairn-side record.
- **Not measured here:** compacting before the plan cache expires (pi-cached-compaction compacts 20 s before, when idle and above 50K tokens). Children write at the one-hour tier (every write in the matrix), so the window is an hour. It is a separate decision with its own trade: the full context goes earlier.

## What it decides

ADR 0025 (proposed): compaction on a Claude thread forks the stamped session, gated on the real extension passing a judge built from this spike (the facts past the cut survive, the boundary holds, the cache ratio holds at idle and mid-turn, the fork's transcript and child are gone) and on J4's compaction case.

## Running it

```sh
node spikes/8-cached-compaction/compaction.ts claude-haiku-5-5 3 baseline,cached,midturn
S8_READ_PROMPT=strict node spikes/8-cached-compaction/compaction.ts claude-sonnet-5-5 1 cached
```

It runs from the repo root on the workspace's packages (no install of its own). Each trial makes a scratch folder under the system temp dir and removes it, with its transcripts under `~/.claude/projects/-tmp-cairn-s8-*`. `runs/` (ignored by git) keeps every trial with the summary and answer text; `runs/matrix.log` is the matrix above, `runs/baseline-nonce.log` and `runs/strict-override*.log` the later checks, and `runs/strict-prompt/` the first matrix, before the checkpoint paragraph and the nonce. Run it from a plain shell, or the children inherit the shell's Claude Code session (bug 4). A full matrix (three models, three variants, 18 trials) took about 45 minutes.
