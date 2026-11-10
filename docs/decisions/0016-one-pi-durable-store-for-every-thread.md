---
status: accepted
gate: harness conformance and the durability judge
---

# One pi-durable store for every thread

The brain keeps every thread in one pi-durable store, `brain.sqlite` on the NVMe under `~/.local/share/cairn/`, where each thread is an ownerless conversation and subagents later are owned conversations in the same store. Cairn's own tables (projects, the shell rows and events, receipts, attachments, push, the Executor grant) live apart in `cairn.sqlite`, because pi-durable serializes its writes on one connection with `BEGIN IMMEDIATE` and a pi bump should back up only its own file. One store was measured at 300 streaming conversations, 3,640 commits a second and 268 MiB; boot is one `open` plus one `inspect()` that sees every busy task, parked task and approval, and one `subscribeCommits` feeds the shell, where a store per thread needed a guessed reopen set and v1's per-thread registry. The costs are accepted: conversations cannot be deleted (archive and delete tombstone the shell row), and the store is one failure domain on one disk, covered by a backup before every version change and a daily rolling backup.

Gate: the harness conformance suite passes against pi-durable, and the durability judge's streaming, mid-tool and kill-six windows pass against this store.

Gate passed at the wave 3 integration (2026-10-22): the conformance suite passes against pi-durable in `pnpm check`, and `judges/durability.ts` passed the streaming, mid-tool and kill-six windows against this store (kill to first socket 1,132 to 1,347 ms, socket to converged 5 to 8 ms). Accepted.

Amended on 2026-11-09 (product review T-1, V-4, E-1, E-3): the daily rolling backup had run every 48 hours and restarted its timer at every boot, so a brain restarted daily made none, and `cairn.sqlite` had no rolling copy at all. Now both stores get one (`apps/server/src/db/RollingCopy.ts`): at boot and every hour after, the newest copy's time is read from its name under `<dataDir>/backups`, and a copy is made through SQLite's online backup when it is a day old or there is none, so restarts never delay it. Three copies of each store are kept. `CAIRN_BACKUP_MIRROR`, unset by default, names an existing folder off the NVMe (the brain never makes it) that each copy is also written to with the same retention; a failed write there is logged and never stops the brain. The live stores stay on the NVMe.
