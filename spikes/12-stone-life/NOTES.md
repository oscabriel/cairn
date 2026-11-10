# Spike 12: a stone's life

Result: **three gate clauses pass, one is undetermined, one was not run** (table below). Run on 2026-11-04 from the Beelink on the throwaway stack `CairnS12`, deployed and destroyed the same day. No snapshots, so nothing is left on Cloudflare. Merges `arms.md` spikes A and E and `results.md` spike A. `results.md` spike C was not run.

`life.ts` drives it. The object makes each cut itself: `git bundle create --all`, `sha256sum`, then `R2.put` with that checksum through a `FixedLengthStream`. The Beelink then fetches the object through the Worker and checks its hash and length. All on `standard-2` with the 2026-10-22 stone image.

Measured on Alchemy beta.83 and Effect 4.0.5. On 2026-11-09 the stack moved to the catalog's Alchemy beta.85, `@alchemy.run/cloudflare` and Effect 4.1.2, typechecked only, never planned or deployed on them.

## The gate, clause by clause

The gate is in `docs/phase-3/plan.md`, wave 0. An earlier version of these notes said "passed, with one gate missed by 78 ms"; that read the worst of 20 cuts as their p95 and left out the clause that was not run.

| Clause | Measured | Verdict |
| --- | --- | --- |
| The container still runs after an abort with no request, at the chosen alarm interval | 8 runs, one per cell: running and on the same boot after 1 to 10 minutes of silence, with and without a 60 s alarm | Pass as worded. It does not choose the alarm's interval: no silence crossed the 15 minute inactivity timeout, so the rows with and without an alarm are identical |
| A cut at 1 MB home with p95 at most 2 s | 20 cuts: p50 1,619, worst 2,078 (the first cut after start). p95 by nearest rank 1,975, by interpolation 1,980 | Undetermined. Under the line by the usual definitions, but 20 samples cannot separate 1,975 from 2,000, and R2's put alone has a p50 of 1,050, so the clause will sit on the line at any real bundle size |
| 100 MB within 60 s | 3 cuts, worst 26,675 | Pass, on 3 samples |
| No partial object after an eviction; a wrong checksum stores nothing | 8 of 8 evictions stored nothing; 2 of 2 wrong checksums stored nothing | Pass. Both are judged by `stored: null`: the wrong checksum's answer is Cloudflare's HTML 500, the same answer an eviction gets, not a clean refusal |
| A check run adds at most 10 s per pick | Not run | Not run. Spike 11's numbers suggest it by arithmetic, which is not a measurement. Recommended, for the user to decide: move the clause to RES-4's judge and out of this spike's gate |

Measured: the first four clauses, as stated. Not measured: the alarm interval past the inactivity timeout (the soak, `arms.md` F), a check run's overhead, and reattaching after a brain kill (left to RES-4's judge).

## An eviction with no request after it (`arms.md` A)

`ctx.abort()`, then silence until the check, which is the first request. A detached process wrote a heartbeat every 5 s. The inactivity timeout was 15 minutes in every case.

| Silence | Alarm every 60 s | Running | Same boot | Heartbeat age | Alarms fired |
| --- | --- | --- | --- | --- | --- |
| 1 minute | Yes | Yes | Yes | 1 s | 1 |
| 2 minutes | Yes | Yes | Yes | 1 s | 1 |
| 5 minutes | Yes | Yes | Yes | 1 s | 5 |
| 10 minutes | Yes | Yes | Yes | 0 s | 10 |
| 1 minute | No | Yes | Yes | 1 s | 0 |
| 2 minutes | No | Yes | Yes | 1 s | 0 |
| 5 minutes | No | Yes | Yes | 1 s | 0 |
| 10 minutes | No | Yes | Yes | 1 s | 0 |

**Decision:** a 60 s alarm, kept for the watchdog and the safety cut. The clause passes as worded, but this table cannot choose an interval: the alarm keeps firing with no request, and it is not what keeps the container alive for these 10 minutes. It is still wanted for the watchdog and the safety cut. Silence past the inactivity timeout is unmeasured: that is the soak (`arms.md` F).

## One cut through R2 (`arms.md` E, `results.md` A)

Cut to fetched and checked at home, in ms. The 1 MiB p95 is by nearest rank; the 100 MiB one is the worst of 3.

| Size | n | Bundle p50 | Put p50 | Fetch p50 | Total p50 | Total p95 | Gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 MiB | 20 | 67 | 1,050 | 365 | 1,619 | 1,975 (worst 2,078) | p95 at most 2 s: undetermined, see above |
| 100 MiB | 3 | 4,906 | 13,333 | 6,622 | 25,312 | 26,675 (worst of 3) | At most 60 s: pass |
| 1 GiB | 1 | 13,309 | 106,625 | 58,862 | 179,170 | | Completes: pass |

Every fetched object matched its hash and length. The test repositories are random bytes, so the bundling is at its least compressible.

**Decision:** one path, as ruled in `docs/phase-3/plan.md` section 2. R2's put costs about a second even at 1 MiB, so a run's changed-files card arrives about 2 s after the run ends. The plan already accepts a late card rather than a second path. The 512 MiB bundle cap stands: it would take about 90 s.

## What can go wrong

| Case | Runs | Result |
| --- | --- | --- |
| Eviction during a 100 MiB cut, at 1 to 14 s | 8 | Nothing stored, 8 of 8. A later cut on the same stone succeeds and matches. Bundling takes about 5 s and the put about 13 s, so at least 5 of these landed during the put |
| Wrong checksum | 2 | Nothing stored. The cut's caller saw Cloudflare's HTML 500, as for an eviction, so the outcome is judged by the stored object, not by the answer |
| Safety cut from the alarm, with no brain connected and no request | 1 | Stored at 64 s and checked present by a route that does not wake the object |

The caller of an interrupted cut sees Cloudflare's HTML 500 rather than a clean error. The brain's client must treat any failure as "ask again by key", which the receipts in `results.md` already do.

## Not run

`results.md` spike C, check-run overhead: restoring, applying `base..tip` and resetting between picks. This is a gate clause, and it is unmeasured. Spike 11's numbers (start about 1.4 s, fetch and switch about 1.1 s) suggest it is well under 10 s by arithmetic, but spike 11's cold starts also show a single start can take two minutes, so the arithmetic holds only for a warm stone. Surviving a kill by reattaching is left to the judge in package RES-4.

## Cost

By arithmetic, under $0.05 of compute at list, likely inside included usage. R2 under a cent. The stack and its results bucket were destroyed (`runs/destroy.log`, git-ignored: 8 of 8 deletes succeeded). The spike's local `.env` and `.alchemy/` state folder are still on disk in the main checkout, both git-ignored; they were not opened for these notes, and the user decides whether to delete them.
