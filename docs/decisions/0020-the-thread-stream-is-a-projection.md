---
status: proposed
gate: ThreadWire convergence tests and the wire budget judge
---

# The thread stream is a projection of pi-durable's view

The thread stream sends pi-durable's own conversation view, a snapshot then chord ops, rather than a vocabulary of Cairn events, and the brain projects it on the way out (`ThreadWire`): only the documents a client may see (`pi.agent`, `pi.live`, `pi.inbox`, `pi.usage`, `cairn.approvals`), never `pi.provider` or `pi.system`, Claude stamps stripped, base64 image data replaced by a reference the client fetches, and strings over 32 KiB cut with t3code's marker and `truncated: true` (`thread.entry` returns an entry in full up to 256 KiB). One pasted screenshot is 1.3 to 2.7 MB in an unprojected snapshot, which the projection removes. A window of the last 10 user turns, with `entriesOffset` and server-side rewriting of op indices, is built only if the wire budget judge fails on the projection alone, because rewriting ops is where convergence bugs live; a fresh in-stream snapshot is always legal, so the rewrite can give up safely.

Gate: the `ThreadWire` convergence tests (random op streams through the projection and the client's applier equal the projected view after every frame) and `judges/wire-budget.ts`.
