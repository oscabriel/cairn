---
status: proposed
gate: a judge built from spikes/8-cached-compaction, then J4's compaction case
---

# Compaction on a Claude thread forks the stamped session

pi-durable's compaction flattens the old messages into text, cuts every tool result to 2,000 characters and sends them under its own summarizer prompt; on the bridge that is a one-shot in a fresh child, so the summary request reads nothing from the cache and the summarizer never sees the end of a long tool result. On a bridge model, Cairn instead supplies the summary from a `beforeCompact` hook: it asks for the summary as the next turn of a fork of the thread's own Claude Code session, through the bridge's `fork-stamped` path (a request under a throwaway pi session id, the thread's last request and reply, and one instruction that quotes the first kept message). The fork reads the thread's prefix from the cache, sees every tool result whole, and leaves the live session untouched. The idea is nicobailon/pi-cached-compaction; the measurements are in `spikes/8-cached-compaction/NOTES.md`.

Consequences:

- The extension waits for the stamped entry to reach the transcript before it forks (mid-turn it is not written yet), deletes the fork's transcript and ends its child afterwards, and falls back to pi-durable's own compaction on any failed check. A compaction never fails because of this path.
- The instruction tells the summarizer that the thread's reply instructions do not limit the summary: the summarizer is the conversation itself and otherwise obeys them.
- The fork reads the whole context at the cache price where the one-shot writes the cut text at the one-hour write price. Measured at 26K the fork cost about half; over the user's own sessions the cut keeps a median two thirds of the text, where the fork costs about a thirteenth (at API price ratios; the plan windows' weighting is not published).
- pi-durable records no usage for a summary a hook supplies, so the spend needs a record of its own.
- Compacting before the plan cache expires is a separate decision and is not part of this one.

Gate: a judge built from the spike (on the real extension: the facts past the cut survive, no summary reports the kept turn as done, cache read at least 10 times the write at idle and mid-turn, no fork transcript or child left), then J4's compaction case passing unchanged.
