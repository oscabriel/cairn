# Spike 11: bases

Status: **part A failed its gate** on the 24 h unused burst (2026-11-05), and waits for the user's decision below. Parts B to F have not run. Started 2026-11-04 on the user's word, with one snapshot, on the throwaway stack `CairnS11` (`./deploy.sh destroy` removes it). The gate is in `docs/phase-3/notes/bases.md`, "Measured spikes": launch to first tool call p95 under 5 s on Cairn's tree, warm, 24 h unused and ten at once.

Measured on Alchemy beta.83 and Effect 4.0.5. On 2026-11-09 the stack moved to the catalog's Alchemy beta.85, `@alchemy.run/cloudflare` and Effect 4.1.2, typechecked only, never planned or deployed on them. `CairnS11` may still be deployed, last written by beta.83: the next `./deploy.sh` (deploy, plan or destroy) is its first beta.85 run, and it upgrades the account's state store to v8 unless another beta.85 run already has.

## Shape

Spike 1's Worker, `Workspace` object and relay, plus options on start and one guarded snapshot. The object records a snapshot's id before answering and refuses a second capture, because a snapshot can be neither deleted nor listed.

`restore.ts` times one trial: launch command, control `start`, first exec over the relay, write the delta bundle, `git fetch` and `git switch -c`, then a first tool call. That is the clock. After it, three first commands are timed, and the tree is checked (at least 100,000 files, HEAD on the delta's tip), so a fast restore of an empty disk cannot pass.

The tree is Cairn at `a160935~20`, with the last 20 commits as a 411 KB delta. Node 24 from the image, pnpm through corepack, `pnpm install --frozen-lockfile --ignore-scripts`. `@cloudflare/sandbox` 1.0.2 and the stone image built on 2026-10-22.

## Numbers

The base: 114 s to build on `standard-2`, including a 98.6 s install. 121,545 files after install, 2.4 GiB of tree and a 2.3 GiB store (hard links, so `df` showed 1.4 GB used). **The snapshot is 1.03 GiB, and capture took 38.8 s.** The notes assumed about 3 GB.

Launch to first tool call, in ms. 124 restores, 122 succeeded, every success with all 121,557 files and HEAD on the delta's tip.

| Run | n | p50 | p95 | Worst | Notes |
| --- | --- | --- | --- | --- | --- |
| Bare image (control), first after deploy | 4 | 5,220 | 8,275 | 8,275 | 8.3 s, 5.2 s, then 1.1 s and 1.4 s: the image reaching hosts |
| Bare image (control), warm | 25 | 1,193 | 1,484 | 1,621 | Matches spike 1 |
| Snapshot, first restore after capture | 1 | 2,777 | | | |
| Snapshot, 20 in sequence, just after capture | 20 | 3,204 | 55,358 | 55,358 | Trial 2 at 55 s, trial 10 at 17 s |
| Snapshot, 10 at once, just after capture | 10 | 4,040 | 6,089 | 6,089 | 1 of 10 failed |
| Snapshot, 10 at once again | 10 | 5,167 | 10,128 | 10,128 | 1 of 10 failed |
| Snapshot, 5 in sequence, `standard-1`, first on that size | 5 | 3,680 | 62,962 | 62,962 | Trial 1 at 63 s. Restores across sizes |
| Snapshot, 40 in sequence, warm | 40 | 3,155 | 4,178 | 5,563 | |
| Snapshot, 3 in sequence, 1 h unused | 3 | 3,098 | | 3,950 | |
| Snapshot, 10 at once, 34 minutes unused | 10 | 6,591 | 58,974 | 58,974 | 6 over 5 s, one at 59 s |
| Snapshot, 10 at once, a minute later | 10 | 3,142 | 4,954 | 4,954 | All under 5 s |
| **Snapshot, 10 at once, about 27 h unused** | 10 | 5,437 | 126,766 | 126,766 | 10 of 10 succeeded; 5 over 5 s, 4 over a minute. The gate's case |
| Snapshot, 5 in sequence, right after that burst | 5 | 2,663 | 4,739 | 4,739 | All under 5 s |

All sequential on `standard-2` before the 27 h run, 64 trials: p50 3,152, p95 4,739, 3 over 5 s.

How to read the p50 and p95 columns: `restore.ts` takes `sorted[floor(p * n)]`, so its p95 is the worst trial whenever n is 20 or fewer, and its p50 of an even n is the upper of the two middle trials. Read those rows' p95 as "worst of n".

Where the time goes, 40 in sequence, p50: first answer from the container 948 ms (bare image: 227 ms), shim check 41 ms, daemon hello 540 ms, delta write about 140 ms, `git fetch` and `git switch` 1,086 ms. So a restore costs about 0.7 s over a bare image, and the git step is the largest part in Cairn's hands.

**The stalls are all in the first answer from the container,** which is on Cloudflare's side: 56,089 ms of the 58,974 ms trial. Hello and the git steps do not move.

First commands after restore, p50: `git status` 82 ms, importing `effect` 1,071 ms, `find` over the whole tree 2,006 ms. No sign of a disk that faults in slowly: `find` over 121,557 files stays near 2 s, and it was similar on the first restore.

### The 24 h unused run (part A's last case)

A transient user timer, `cairn-s11-cold`, ran ten at once on 2026-11-05 at 19:17 PST, about 27 h after the last restore (the relay install's `daemon-reload` had restarted its 24 h countdown), then five in sequence. The log is `runs/part-a5.log`, which git ignores; its rows are in `runs/trials.jsonl` under the labels `burst-2026-11-06T03:17:20.196Z` and `seq-2026-11-06T03:19:35.731Z`.

Ten at once, launch to first tool call, in ms: 3,417, 3,453, 3,520, 3,663, 4,985, 5,437, 64,192, 88,049, 88,487 and 126,766. The median is 5,211 (the harness's p50, the upper middle, is 5,437), so the burst fails on its median as well as its tail. Every trial restored all 121,557 files with HEAD on the delta's tip.

| Step, ten at once | p50 | Worst |
| --- | --- | --- |
| Control `start`, which holds the first answer from the container | 3,203 | 122,534 |
| Daemon hello | 649 | 1,025 |
| `git fetch` and `git switch` | 1,394 | 3,222 |
| Then `find` over the tree | 2,116 | 5,412 |

The four slow trials waited 60,150, 84,564, 84,865 and 121,149 ms for the container's first answer. Everything after that answer stayed within a few seconds, as in every earlier stall: the time is on Cloudflare's side, before Cairn's code runs. The worst stall is now 127 s, not the 59 s of the 34 minute burst.

Five in sequence right after: 2,382, 2,513, 2,663, 4,223 and 4,739 ms, first answer at most 1,212 ms. Once the burst had warmed the hosts, a lone start was back under 5 s.

## Verdict against the gate

| Case | Gate | Measured | Verdict |
| --- | --- | --- | --- |
| Warm, one at a time | p95 under 5 s | p95 4,178 of 40, worst 5,563 | Pass |
| Warm, ten at once | p95 under 5 s | Worst 4,954 a minute after a burst; 6,089 and 10,128 just after capture | Pass once warm; fails in the first bursts after a capture |
| 24 h unused, ten at once | p95 under 5 s | Median 5,211, worst 126,766, 4 of 10 over a minute | **Fail** |

Part A fails. By the plan's stop rule (`docs/phase-3/plan.md`, wave 0), nothing that assumes bases are settled moves until the user has seen this and decided.

## What this says

- Warm, one at a time and ten at once, passes once the hosts hold the snapshot; the first bursts after a capture did not.
- Cold and at once fails, and gets worse with the idle time: after 34 idle minutes 6 of 10 stones were over 5 s with the worst at 59 s; after about 27 h, 5 of 10 were over 5 s, 4 of them over a minute, the worst at 127 s. Starting ten stones on a quiet project is exactly the Fan-out target's first minute.
- One stone after 1 h passes, on 3 trials. Too few to say a lone cold start is safe, since the worst stall was 1 in about 20. No lone start after 24 h was measured: the five in sequence ran after the burst had warmed the hosts.
- Likely cause: a host without the snapshot, as with the image's first starts, and Cloudflare's post says its scheduler favours hosts already holding one. Inferred, not proved.
- A bare start is a cold path too (8.3 s on a new image), so a stone cannot fall back to one without losing the tree.
- 2 of 40 burst trials before the 27 h run failed with an `ExecutionError` whose detail the harness discarded at the time. The three later bursts kept the detail and had no failure, so the cause is still unknown. The real path must treat a failed first exec as retryable.

## The decision this needs (waiting for the user)

Nothing Cairn controls causes the stall, so the options are the three these notes already named, now with the 27 h numbers:

| Option | What it does | What it costs | What it leaves |
| --- | --- | --- | --- |
| A hedged second start | Start a second stone when the first has not answered in about 3 s, use whichever answers first, stop the loser | Nothing at idle. In a cold burst, up to one extra stone per slow start for a few seconds: 5 of 10 would have hedged on 2026-11-05 | Untested. It helps only if the second start lands on a host that answers, and the four stalls over a minute were all on Cloudflare's side of the first answer |
| A relaxed target for a burst | Keep Stone start at p95 under 5 s for a warm or lone start, and set a separate, looser number for ten at once after a quiet day | Nothing in money. The Fan-out target's first minute on a quiet project is then slow: a median over 5 s and a tail of about 2 minutes on this evidence | Relaxes a kickoff target, which only the user can do |
| A warm pool | Keep stones warm on a schedule so a burst never starts cold | About $27.70 a month by arithmetic on list prices | Breaks the Idle cost target of under $6 a month with no stones running |

**Recommendation, waiting for the user's word:** measure the hedge first. It is the only option that costs nothing at idle and keeps both targets, and measuring it leaves the other two open. The run is one more 24 h unused burst of ten with the hedge in `restore.ts` (a real-money run, under $0.10 of compute by the arithmetic below, announced with its estimate first, and the stack's first deploy on beta.85). If the hedged burst's p95 is still over 5 s, the choice is between a relaxed burst target and a warm pool, and a warm pool means giving up the Idle cost target. Until the user decides, `docs/phase-3/plan.md` treats bases as unsettled: wave 1 at home does not depend on this, and wave 2 waits for it.

## Found

- **The official Node 26 binary needs `libatomic.so.1`, which the stone image lacks.** `node --version` fails with it. Cairn requires Node 26 or later, so the real image (package B1) must add `libatomic1`.
- A check using `pgrep -f setup.sh` matches its own command line, and so reported the failed setup as running for 25 minutes. The builder (package B4) must read an exit file, as this harness now does.
- `control(id, "stop")` can fail after a failed trial and leave its container running, here until `sweep` stopped it. The real path needs a reconcile, which `arms.md` already asks for.

## Not run

Parts B to F (snapshot lifetimes and restore across sizes, Cairn's `pnpm check` in a container within 20 minutes and $0.25, Chromium's cold start penalty, the storage price) follow only if part A passes, or on the user's word. Whether `CairnS11` is still deployed was not checked for these notes; its snapshot cannot be deleted in any case.

## Cost so far

Compute, by arithmetic: about 155 stones for seconds each, one 25-minute idle builder (a bug), one 2-minute build. Well under $0.10 at list, before included usage. One snapshot of 1.03 GiB, stored 30 days from its last restore, at a price Cloudflare has not published: $0.015 at R2's rate, about $0.19 at running disk's rate, per month.
