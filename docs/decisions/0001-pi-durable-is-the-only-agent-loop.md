# pi-durable is the only agent loop

Every agent in Cairn (threads, stones, subagents, workflow nodes) runs on `@earendil-works/pi-durable`, pinned exactly, behind one harness seam modelled on t3code's `ProviderAdapterV2`. pi-durable owns every transcript and tool call; Cairn's own SQLite holds only what pi-durable doesn't (projects, thread shell and inbox state, attachments, workflows, stones, approvals), so no transcript content is written twice. "Multi-harness" means many providers, models and presets on pi-durable, never a second loop. pi-durable stays plain TypeScript behind one Effect service.

## Consequences

- pi-durable's next release migrates SQLite irreversibly: back up every store before a pi bump.
- A scripted test harness sits behind the same seam so one replay-transcript suite judges both.
