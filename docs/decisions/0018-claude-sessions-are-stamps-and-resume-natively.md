---
status: proposed
gate: J3 and J4
---

# Claude session ids are stamps, and resume is SDK-native

The bridge records which Claude Code session answered as a stamp on the final assistant message's `diagnostics` (`cairn.claude`), committed in the same commit as the reply, so there is no crash window and the stamp follows entries into forks; the thread stream's projection strips it. The first session's id is pi's provider session id, so a kill during the very first reply still finds its transcript. A later turn resumes with the Agent SDK's own `resume` and `resumeSessionAt` (with `forkSession` after a real abort or a child error). Cairn never writes, edits or rebuilds a Claude Code transcript. When the history diverged (a pi compaction, a provider switch mid-thread, a changed cwd or model, a missing transcript), the bridge opens a fresh Claude session whose first prompt is pi's current context, the compaction summary and the kept tail with images carried, and stamps it as the new session. That costs one cache write per divergence, about what the compaction costs anyway.

Gate: J3 across Haiku, Sonnet and Opus (same or forked session id, cache read at least 10 times the write, the tool runs once), and J4 including its compaction and provider-switch cases.
