---
status: proposed
gate: harness conformance and the durability judge
---

# One pi-durable store for every thread

The brain keeps every thread in one pi-durable store, `brain.sqlite` on the NVMe under `~/.local/share/cairn/`, where each thread is an ownerless conversation and subagents later are owned conversations in the same store. Cairn's own tables (projects, the shell rows and events, receipts, attachments, push, the Executor grant) live apart in `cairn.sqlite`, because pi-durable serializes its writes on one connection with `BEGIN IMMEDIATE` and a pi bump should back up only its own file. One store was measured at 300 streaming conversations, 3,640 commits a second and 268 MiB; boot is one `open` plus one `inspect()` that sees every busy task, parked task and approval, and one `subscribeCommits` feeds the shell, where a store per thread needed a guessed reopen set and v1's per-thread registry. The costs are accepted: conversations cannot be deleted (archive and delete tombstone the shell row), and the store is one failure domain on one disk, covered by a backup before every version change and a daily rolling backup.

Gate: the harness conformance suite passes against pi-durable, and the durability judge's streaming, mid-tool and kill-six windows pass against this store.
