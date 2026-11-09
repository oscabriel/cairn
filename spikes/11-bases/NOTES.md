# Spike 11: bases

Status: in progress, part A only. Started 2026-11-04 on the user's word, with one snapshot, on the throwaway stack `CairnS11` (`./deploy.sh destroy` removes it). The gate is in `docs/phase-3/notes/bases.md`, "Measured spikes": launch to first tool call p95 under 5 s on Cairn's tree, warm, 24 h unused and ten at once.

## Shape

Spike 1's Worker, `Workspace` object and relay, plus options on start and one guarded snapshot. The object records a snapshot's id before answering and refuses a second capture, because a snapshot can be neither deleted nor listed.

`restore.ts` times one trial: launch command, control `start`, first exec over the relay, write the delta bundle, `git fetch` and `git switch -c`, then a first tool call. That is the clock. After it, three first commands are timed, and the tree is checked (at least 100,000 files, HEAD on the delta's tip), so a fast restore of an empty disk cannot pass.

The tree is Cairn at `a160935~20`, with the last 20 commits as a 411 KB delta. Node 24 from the image, pnpm through corepack, `pnpm install --frozen-lockfile --ignore-scripts`. `@cloudflare/sandbox` 1.0.2 and the stone image built on 2026-10-22.

## Numbers so far

The base: 114 s to build on `standard-2`, including a 98.6 s install. 121,545 files after install, 2.4 GiB of tree and a 2.3 GiB store (hard links, so `df` showed 1.4 GB used). **The snapshot is 1.03 GiB, and capture took 38.8 s.** The notes assumed about 3 GB.

Launch to first tool call, in ms. 109 restores, 107 succeeded, every success with all 121,557 files and HEAD on the delta's tip.

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

All sequential on `standard-2`, 64 trials: p50 3,152, p95 4,739, 3 over 5 s.

Where the time goes, 40 in sequence, p50: first answer from the container 948 ms (bare image: 227 ms), shim check 41 ms, daemon hello 540 ms, delta write about 140 ms, `git fetch` and `git switch` 1,086 ms. So a restore costs about 0.7 s over a bare image, and the git step is the largest part in Cairn's hands.

**The stalls are all in the first answer from the container,** which is on Cloudflare's side: 56,089 ms of the 58,974 ms trial. Hello and the git steps do not move.

First commands after restore, p50: `git status` 82 ms, importing `effect` 1,071 ms, `find` over the whole tree 2,006 ms. No sign of a disk that faults in slowly: `find` over 121,557 files stays near 2 s, and it was similar on the first restore.

## What this says so far

- Warm, one at a time and ten at once, passes.
- Cold and at once fails: a burst after 34 idle minutes had 6 of 10 stones over 5 s, one of them at 59 s. Starting ten stones on a quiet project is exactly the Fan-out target's first minute.
- One stone after 1 h passes, on 3 trials. Too few to say a lone cold start is safe, since the worst stall was 1 in about 20.
- Likely cause: a host without the snapshot, as with the image's first starts, and Cloudflare's post says its scheduler favours hosts already holding one. Inferred, not proved.
- Nothing Cairn controls causes the stall, so the options are a hedge (start a second stone when the first has not answered in about 3 s, and stop the loser), relaxing the target for a burst, or a warm pool at about $27.70 a month. A hedge is untested. A bare start is a cold path too (8.3 s on a new image), so a stone cannot fall back to one without losing the tree.
- 2 of 40 burst trials failed with an `ExecutionError` whose detail the harness discarded at the time. The two later bursts kept the detail and had no failure, so the cause is still unknown. The real path must treat a failed first exec as retryable.

## Found

- **The official Node 26 binary needs `libatomic.so.1`, which the stone image lacks.** `node --version` fails with it. Cairn requires Node 26 or later, so the real image (package B1) must add `libatomic1`.
- A check using `pgrep -f setup.sh` matches its own command line, and so reported the failed setup as running for 25 minutes. The builder (package B4) must read an exit file, as this harness now does.
- `control(id, "stop")` can fail after a failed trial and leave its container running, here until `sweep` stopped it. The real path needs a reconcile, which `arms.md` already asks for.

## Still to run

Part A: 24 h unused. A transient user timer, `cairn-s11-cold`, runs ten at once then 5 in sequence on 2026-11-05 at 19:16 PST, about 27 h after the last restore (the relay install's `daemon-reload` restarted its 24 h countdown), into `runs/part-a5.log`. Parts B to F follow only if part A passes, or on the user's word.

## Cost so far

Compute, by arithmetic: about 140 stones for seconds each, one 25-minute idle builder (a bug), one 2-minute build. Well under $0.10 at list, before included usage. One snapshot of 1.03 GiB, stored 30 days from its last restore, at a price Cloudflare has not published: $0.015 at R2's rate, about $0.19 at running disk's rate, per month.
