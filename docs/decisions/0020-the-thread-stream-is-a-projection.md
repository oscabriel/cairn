---
status: proposed
gate: ThreadWire convergence tests and the wire budget judge
---

# The thread stream is a projection of pi-durable's view

The thread stream sends pi-durable's own conversation view, a snapshot then chord ops, rather than a vocabulary of Cairn events, and the brain projects it on the way out (`ThreadWire`): only the documents a client may see (`pi.agent`, `pi.live`, `pi.inbox`, `pi.usage`, `cairn.approvals`), never `pi.provider` or `pi.system`, Claude stamps stripped, base64 image data replaced by a reference the client fetches, and strings over 32 KiB cut with t3code's marker and `truncated: true` (`thread.entry` returns an entry in full up to 256 KiB). One pasted screenshot is 1.3 to 2.7 MB in an unprojected snapshot, which the projection removes. A window of the last 10 user turns, with `entriesOffset` and server-side rewriting of op indices, is built only if the wire budget judge fails on the projection alone, because rewriting ops is where convergence bugs live; a fresh in-stream snapshot is always legal, so the rewrite can give up safely.

Gate: the `ThreadWire` convergence tests (random op streams through the projection and the client's applier equal the projected view after every frame) and `judges/wire-budget.ts`.

## The wire budget measurement (wave 4, 4C)

`judges/wire-budget.ts` grew one thread on the judge brain to 2,017 active entries (112 turns of real `bash`, `read`, `grep`, `find` and `ls` calls, with 10 pasted 1170x2532 screenshots and 10 images returned by `read`). On the projection alone the first snapshot was 1,133,675 bytes of JSON (77,180 deflated) against a budget of 200,000, so the judge failed and the window was built.

The window (`ThreadWindow.ts`) holds at most 10 user turns, 75 entries and 1 MiB, and starts at a turn's user message when the cut falls inside a turn whose message is in the newer half of the window. Op indices are not rewritten: each revision's window is diffed against the previous one, so ops count from the window's start by construction. The window is fixed for a subscription's life (appends grow it); when the entries before it change (a compaction, a reset, a shorter view), the brain sends a fresh in-stream snapshot with a new window.

With the window, the same thread's first snapshot was 41,319 bytes (4,163 deflated): 72 entries, `entriesOffset` 1,945, `hasMoreHistory` true. The first frame took 17 ms (p50) on loopback; modelled on the tailnet (4 round trips of 60 ms plus the deflated frame at 10 Mbps) it is 289 ms at p95, under the 1,000 ms budget. No frame carried base64, all 20 images returned their bytes by reference (pasted ones byte for byte), and `thread.history` paged the other 1,945 entries back in 4 pages.
