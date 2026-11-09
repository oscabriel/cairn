# Spike 12: a stone's life

Result: **passed, with one gate missed by 78 ms.** Run on 2026-11-04 from the Beelink on the throwaway stack `CairnS12`, deployed and destroyed the same day. No snapshots, so nothing is left behind. Merges `arms.md` spikes A and E and `results.md` spike A. `results.md` spike C was not run.

`life.ts` drives it. The object makes each cut itself: `git bundle create --all`, `sha256sum`, then `R2.put` with that checksum through a `FixedLengthStream`. The Beelink then fetches the object through the Worker and checks its hash and length. All on `standard-2` with the 2026-10-22 stone image.

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

**Decision:** gate passed at a 60 s alarm. The alarm keeps firing with no request, and it is not what keeps the container alive for these 10 minutes. It is still wanted for the watchdog and the safety cut. Silence past the inactivity timeout is unmeasured: that is the soak (`arms.md` F).

## One cut through R2 (`arms.md` E, `results.md` A)

Cut to fetched and checked at home, in ms.

| Size | n | Bundle p50 | Put p50 | Fetch p50 | Total p50 | Total p95 | Gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 MiB | 20 | 67 | 1,050 | 365 | 1,619 | 2,078 | p95 at most 2 s: **missed by 78 ms** |
| 100 MiB | 3 | 4,906 | 13,333 | 6,622 | 25,312 | 26,675 | At most 60 s: pass |
| 1 GiB | 1 | 13,309 | 106,625 | 58,862 | 179,170 | | Completes: pass |

Every fetched object matched its hash and length. The test repositories are random bytes, so the bundling is at its least compressible.

**Decision:** one path, as ruled in `docs/phase-3/plan.md` section 2. R2's put costs about a second even at 1 MiB, so a run's changed-files card arrives about 2 s after the run ends. The plan already accepts a late card rather than a second path. The 512 MiB bundle cap stands: it would take about 90 s.

## What can go wrong

| Case | Runs | Result |
| --- | --- | --- |
| Eviction during a 100 MiB cut, at 1 to 14 s | 8 | Nothing stored, 8 of 8. A later cut on the same stone succeeds and matches. Bundling takes about 5 s and the put about 13 s, so at least 5 of these landed during the put |
| Wrong checksum | 2 | Refused, nothing stored |
| Safety cut from the alarm, with no brain connected and no request | 1 | Stored at 64 s and checked present by a route that does not wake the object |

The caller of an interrupted cut sees Cloudflare's HTML 500 rather than a clean error. The brain's client must treat any failure as "ask again by key", which the receipts in `results.md` already do.

## Not run

`results.md` spike C, check-run overhead: restoring, applying `base..tip` and resetting between picks. Spike 11's numbers (start about 1.4 s, fetch and switch about 1.1 s) put it well under its 10 s gate by arithmetic. Surviving a kill by reattaching is left to the judge in package RES-4.

## Cost

By arithmetic, under $0.05 of compute at list, likely inside included usage. R2 under a cent. Nothing remains: stack destroyed, bucket empty, credentials file removed.
