---
status: accepted
gate: J3 and J4
---

# Claude session ids are stamps, and resume is SDK-native

The bridge records which Claude Code session answered as a stamp on the final assistant message's `diagnostics` (`cairn.claude`), committed in the same commit as the reply, so there is no crash window and the stamp follows entries into forks; the thread stream's projection strips it. The first session's id is pi's provider session id, so a kill during the very first reply still finds its transcript. A later turn resumes with the Agent SDK's own `resume` and `resumeSessionAt` (with `forkSession` after a real abort or a child error). Cairn never writes, edits or rebuilds a Claude Code transcript. When the history diverged (a pi compaction, a provider switch mid-thread, a changed cwd or model, a missing transcript), the bridge opens a fresh Claude session whose first prompt is pi's current context, the compaction summary and the kept tail with images carried, and stamps it as the new session. That costs one cache write per divergence, about what the compaction costs anyway.

Gate: J3 across Haiku, Sonnet and Opus (same or forked session id, cache read at least 10 times the write, the tool runs once), and J4 including its compaction and provider-switch cases.

Gate evidence so far: J3 passed on 2026-10-22 for Haiku, Sonnet and Opus (`spikes/6-bridge-resume/NOTES.md`). J4's stamp round trip passes in `packages/bridge/src/ClaudeHarness.test.ts`. J4's divergence cases passed live on Haiku at the wave 3 integration (2026-10-22, `judges/claude-live.ts`): a forced compaction opened a fresh session that used the fact from before it (cache read 1,941, write 967), a provider switch answered with both turns' facts, and a deleted transcript fell back to a fresh session without error. The native resume keeps the cache only without `resumeSessionAt` when the cut is the transcript's last entry (fixed in `ClaudeConversation.ts` at integration): a clean restart then read 29,933 cached tokens and wrote 375. Accepted. A kill during a held tool call still rewrites the prefix on resume (ADR 0017's open J2 case).
