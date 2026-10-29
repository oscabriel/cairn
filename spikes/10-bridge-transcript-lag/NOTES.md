# Spike 10: does a bridge stamp name an entry Claude Code has written?

Result: **no, not for the first 100 ms or so. Decision: the bridge holds a reply's `done` back from pi until the entry its stamp names is in the transcript (`ClaudeDoneGate.ts`), and the durability judge gains a window aimed at the gap (`bridge-tool-ran`).** The 2026-10-28 nightly's `bridge-answer` failure (run 3 of 3, `cacheKept` false) was this Cairn bug, not cache eviction on Anthropic's side.

Run on 2026-10-28 on the Beelink, `/usr/bin/node` v26.11.1, Agent SDK 0.3.305 (bundled Claude Code 2.1.305), `claude-haiku-5-5` on the subscription.

## The failure

The nightly's failed run read 19,680 tokens from the cache and wrote 22,375 on the first reply after the restart. Every passing bridge run reads about 41,850: 19,680 is the tools and system prompt, the prefix every session shares, so the conversation itself was rewritten. The run's unit log (`journalctl --user -u cairn-judge-durability-2395960-9`) names the cause: after the restart the bridge logged `claude fresh session` with `reason: transcript-missing`. The stamp pi had committed named a Claude Code entry that was not in the session's transcript, so the resume could not cut there and the bridge rebuilt the session cold, with the history in the prompt.

## Why the entry was missing

Claude Code writes its transcript on a timer, after it has emitted the event and called the tool. pi commits a reply's stamp when `done` arrives and then runs the reply's tools. With a fast tool (`echo`), the tool result is committed, and the judge's `kill -9` can land, before Claude Code's next flush. The kill takes the `claude` child with it, so the entry is never written.

`lag.ts` asks for one call of an in-process MCP tool and watches the transcript for the `assistant` event's uuid:

| trial | on disk at the event | on disk in the tool handler | handler, ms after event | entry written, ms after event |
| ----- | -------------------- | --------------------------- | ----------------------- | ----------------------------- |
| 1     | no                   | no                          | 7                       | 111                           |
| 2     | no                   | no                          | 6                       | 111                           |
| 3     | no                   | no                          | 7                       | 110                           |
| 4     | no                   | no                          | 6                       | 109                           |
| 5     | no                   | no                          | 7                       | 120                           |

`cost.ts` times one "is it written yet" read (`getSessionMessages`, what `ClaudeSdk.entries` calls) on the largest transcript on the machine, 32 MB and 1,251 entries: 200 ms cold, then 109 and 105 ms. A typical bridge session's transcript is well under 1 MB and reads in a few milliseconds.

## The judge

`judges/durability.ts --window bridge-tool-ran` aims the kill a few milliseconds after `bash` ran (it reads everything the kill is judged against first, then polls the marker file every 2 ms). With the gate disabled (`DONE_WAIT_ATTEMPTS = 0`), 2026-10-28:

- `bridge-tool-ran`: 5 of 5 runs that reached the cache check failed it, each with `transcript-missing` and about 20,018 read, 22,396 written.
- `bridge-answer`: 1 of 6 failed the same way (the nightly saw 1 of 3).

With the gate: `bridge-tool-ran` 4 of 4 and `bridge-answer` 4 of 4 pass, about 42,200 read and 280 written, no cold rebuild and no `claude_stamp_not_written` warning; the full `--bridge` set passes 5 of 5.

`cacheKept` stays strict (`cacheRead > 0` and `cacheRead >= 10 * cacheWrite`): every miss measured had a cause in Cairn. A run now also reports `coldRebuilds`, `stampsNotWritten` and `resumeDrops`, and a miss with none of them is noted as the case to look at provider-side eviction for.

## Cost of the fix

Every reply's `done` waits for its entry: one read at once, one 100 ms later, then every 20 ms for about a second, after which it goes on with a `claude_stamp_not_written` warning. That puts about 110 ms on each bridge reply, plus a few reads of the transcript, under the conversation's lock.

```
cd spikes/10-bridge-transcript-lag && pnpm install --ignore-workspace
node lag.ts claude-haiku-5-5 5
node cost.ts <session id> <cwd>
```
