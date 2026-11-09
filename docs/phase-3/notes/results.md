# Phase 3 notes: results, integration and ship

Scope: how a stone's work gets home and into a branch. The typed result, the bundle, the result's home on the Beelink, the `integrate` node, the one resolver attempt, the conflict card's record, ship, the Fan-out judge. The stone as a thread, the link and idle timers belong to `arms.md`; disk preparation, seeding, secrets and egress to `bases.md`; drawing cards, the `stone` verb and the launch envelope to `surfaces.md`. This note says what it needs from each. Evidence is at `a160935` on `main`. Nothing was deployed and nothing but this file was written to the repo; the probes ran on the Beelink in `/tmp/results-probe` on git 2.56.0.

## Summary

- **Wrap the result, do not extend it.** The model's typed value stays what it is, a claim. A new brain-owned `work` receipt sits beside it (branch, base, tip, commits, dirty paths, bundle, flags), read from git and never from the model. Today's `report` tool takes `commit` from the model (`apps/server/src/subagents/SubagentTools.ts:894`, `:933`), which is not good enough to integrate from.
- **R2 earns its place through one thing.** Under ADR 0010 a stone's run cannot end while the brain is down, because the loop is on the brain. What the brain's absence can do is let the container die. Only a cut made by the `Workspace` object, with no brain, covers that, and only R2 gives it somewhere to go. That is the honest argument; in the normal flow R2 is an extra hop.
- **A per-project bare repo, never the project's repo.** Untrusted objects stay out of the user's object store, and no project config or hook is in reach. v1's `Mirror.ts` is the recipe. The word "mirror" is taken in `GLOSSARY.md` (a question's record in a parent), so this note says **result repo**.
- **`git fsck` catches less than it seems to.** Fetching a bundle with fsck on refused every `.git` and `.gitmodules` trick I tried. It accepted a 940-byte bundle describing 10^9 paths, ignored every `maxInputSize` setting on a 200 MiB blob, and accepted gitlinks and absolute symlinks. The validator needs its own byte, path and blob caps.
- **No integration worktree.** The picks are pure plumbing in the result repo: `git merge-tree --write-tree --merge-base=<src>^` then `commit-tree` with a frozen date, then a compare-and-swap `update-ref`. This deviates from research 06's "dedicated integration worktree". It is cherry-pick's semantics with no checkout and no hooks, and the same inputs give the same sha, so the hard case (a `kill -9` between pick and record) needs no recovery logic. A faux kill matrix held 10 of 10; the broken control made 11 commits from 10 sources.
- **A hook in a worktree runs what the stone wrote.** I installed lefthook in a throwaway repo, committed a stone-edited `lefthook.yml` in a worktree, and `git push` ran the stone's command at home. Cairn's own `.git/hooks/pre-push` is lefthook. So ship pushes from the result repo with hooks off, and the 7 minute `pnpm check` hook never runs during ship; `checks.full` replaces it.
- **Project checks run in a stone's kind of arms, not on the Beelink.** A "check run": throwaway arms from the prepared base, no model, no thread. The picks stay at home because git treats them as data. Ten picks with a 30 second check cost about one cent. The open cost is Cairn's own `pnpm check` in a container, unmeasured (spike B).
- **Stones' commits may have no trailer.** The stone image installs Debian bookworm's git 2.39 (`images/stone/Dockerfile:19-21`), and the `Cairn-Thread` hook needs 2.54 (`apps/server/src/brain/CommitTrailer.ts:41`). The brain therefore stamps `Cairn-Thread` and `Cairn-Stone-Commit` itself at each pick, which also defeats a forged trailer.
- **Cross-contamination is five mechanical checks**, none a model's opinion: provenance, territory, patch equivalence, nonces across 90 ordered stone pairs, distinct arms.
- **Unmeasured:** everything on Cloudflare in this area, real models, Ultimate's actual source (no clone exists), and check-run timing.

## Facts with evidence

### Pins and prior art

| Source | Pin | Notes |
| --- | --- | --- |
| Cairn | `a160935` on `main` | Ground truth. No results, integrate or ship code exists (`grep` over `apps/server/src` and `packages/protocol/src` finds only reserved words: `Policy.ts:300-301`, `Spend.ts:65-66`). |
| git | 2.56.0 on the Beelink | `git-lfs` is not installed. |
| pi-durable | `v1.4.0`, spec read with `git show v1.4.0:packages/durable/docs/spec.md` | Not in `node_modules`; sections 5.2 and 12 read. |
| Sandbox SDK | clone `f9e972a1`, package 1.0.0 | Cairn's image pins 1.0.2 (`images/stone/Dockerfile:7`). Research 02 says 1.0.2 fixes a `readFile` hang, which I did not read. |
| workerd | clone `79c79c87c`, 2026-02-07 | Old; used only for R2's stream rule, which the current docs repeat. |
| Alchemy | `2.0.0-beta.83`, installed | `src/Cloudflare/R2/Bucket.ts:66-99`, `:223`. |
| cairn-v1 | `1a5cd4a` | `apps/server/src/sandbox/{Ship,Mirror,Bundles}.ts`. |
| Ultimate | **Clone absent.** `~/Developer/clones/github.com/HazAT/` holds only `pi-interactive-subagents`, and `/tmp/ult` is gone. | Known only through the report in `~/Developer/agent-artifacts/cairn/v2/outside-lessons/index.html` (read at `8b263386` by an earlier agent). `workspaces/lander.ts` was not read for this note. |

### What the code offers today

- **The prelude** gives `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, `args`, `verify`, `approve` (`apps/server/src/workflows/Prelude.ts:48-56`). `PRELUDE_VERSION` is 3 and a test pins its hash (`:35`); `RUNNABLE_PRELUDE_VERSIONS` keeps old replays running (`:42`). `pipeline` stages get `(value, item, index)` (`:333`). ADR 0012 promises `stone` and `integrate` as durable nested tools.
- **A node outcome** is `{status, value, reason, nodeId}` (`Prelude.ts:186`); `agent()` resolves with `value` or `null`. The script never sees usage, by spec section 12.
- **The ledger row** has `arms` (`host` or `stone`, `packages/protocol/src/Policy.ts:301`), `stage` (`reserved` to `verified`, `packages/protocol/src/Workflows.ts:93`), `result` (`:174`, inline up to 16 KiB, `apps/server/src/workflows/WorkflowNodes.ts:67`) and `receipt` (`Workflows.ts:115`). Settle is one commit with its event (`WorkflowNodes.ts:618-701`).
- **The one nudge** exists: `typedResult` asks once under a derived request id, so a rerun finds the first submission (`WorkflowNodes.ts:395-454`). A commit nudge can be the same shape.
- **`verify`** is a fresh model child with the result as JSON (`apps/server/src/workflows/WorkflowTools.ts:785`, `:2191-2251`), with a verdict schema (`:235`). There is no way to run a project's checks from a script. The closest thing is a goal's `command` judge, argv with no shell, through the thread's own arms, keeping exit code, output tail and `HEAD` (`apps/server/src/verdicts/JudgeRun.ts:8-10`, tail 4,000 at `:65`). The `verification` judge "waits for phase 4" (`:14-15`).
- **`approve`** writes a `user-input` record with options, waits, and reads `answers[0].picks[0]` (`WorkflowTools.ts:746-775`, `:2297-2325`). Its TTL is 24 hours (`apps/server/src/brain/Permissions.ts:157`). `ApprovalPayload` is a closed union (`Policy.ts:498`), and `RuntimeRequestKind` too (`:78`).
- **The dry run** stubs node tools and fails on any `tools.*` the prelude does not send (`apps/server/src/workflows/WorkflowPlan.ts:640-644`), so a new verb must be stubbed there. `CallSite` requires a model `spec` (`Policy.ts:338-348`), which a check run does not have. `WorkflowSpent` has no compute field (`Workflows.ts:188`) while `Spend` reserves one (`Spend.ts:66`).
- **Git.** `Git.run` keeps the user's `HOME` and global config on purpose, and says its source's stricter settings "suit a hostile mirror and not the user's checkouts" (`apps/server/src/git/Git.ts:5-9`, options at `:24`, env at `:100`). So the result repo needs a second runner.
- **Refs.** `refs/cairn/checkpoints` already lives in the project's repo, never under `refs/heads` so `push --all` skips it (`apps/server/src/git/Checkpoints.ts:52`).
- **Child worktrees.** Release never deletes uncommitted or unmerged work (`apps/server/src/workspaces/ChildWorkspaces.ts:12-15`, `:456-505`). Branches are `cairn/sub-<8 hex>` (`:159-163`). The retention rule below copies this stance.
- **Trailers.** `bash` adds the hook on git 2.54 or later, asked once at boot of the Beelink's git (`apps/server/src/brain/CodingTools.ts:14-17`, `CommitTrailer.ts:41`, `:71`). The check reads the brain's git, not the image's. Debian bookworm's package is `1:2.39.5-0+deb12u3` (packages.debian.org). So on a stone the env is set and git ignores it: no failure, no trailer. I did not run the image.
- **Events.** The catalog is a versioned list (`apps/server/src/brain/Events.ts:101-111`); reactors are listed in `ReactorSet.ts`.
- **Project row.** `repository` is the `owner/name` when known (`packages/protocol/src/Shell.ts:64`). No per-project ship or checks setting exists. Recipes already live at `.cairn/workflows` (`apps/server/src/workflows/recipes/Recipes.ts:27`).

### The machine, by presence only

- `gh` 2.102.0 is logged in as `oscabriel` through the keyring, and that still works from a transient user unit (`systemd-run --user`), which is how `cairn.service` runs.
- `~/.ssh/id_ed25519` exists, mode 0600, opens with no passphrase, and authenticates to GitHub from a user unit with no agent. `ssh-add -l` reaches no agent.
- `origin` is `git@github.com:oscabriel/cairn.git`; `main` is not protected (`gh api`: "Branch not protected"); global `commit.gpgsign` is false.
- `.git/hooks` holds lefthook's `pre-commit`, `prepare-commit-msg` and `pre-push`; `lefthook.yml:14-17` runs `pnpm check` at pre-push.
- 16 threads, 27 GiB. `bwrap` is installed and works unprivileged (below). No `sudo`.

### Prior art worth keeping

- **v1 Ship.** `carryBranch` cuts a bundle in the arms with hooks off and copies it out as data (`Ship.ts:119-206`). The header is checked twice, the scratch file is 0600, and the fetched tip is compared with what the arms said (`:181-200`). A fetch from a path was rejected because it "runs upload-pack in that repository and honours its config" (`Mirror.ts:2-3`). The host git gets an empty environment, no global config and fsck on (`Mirror.ts:64-85`). A run a restart cut off is marked interrupted and never resumed, relying on content addressing (`Ship.ts:11-13`). v1 pushed through Executor and GitHub's Git Data API, object by object; the kickoff's home-held credentials make `git push` simpler.
- **Ultimate's lander**, from the report only. A serial durable queue; check limits of 2 minutes without output and 10 minutes total, killing the process group; a failure reruns once and a pass on rerun is `flaky`; at most 3 attempts when the target moves; push never forced; a `landed {sha, base, commits, paths, flaky}` record committed with the fast-forward, "so a crash pushes exactly that sha"; a model runs only on failure, with one fix. Cairn takes all of that. What differs: the lander merges and runs checks in a checkout at home, because Ultimate has no untrusted arms.
- **The user's `/wt-merge`** refuses a dirty main and a detached HEAD and aborts on conflict (`~/Developer/projects/pi-auto-worktree/extension/auto-worktree.ts:137-163`). Those refusals protect a merge into the checkout, which ship never does; see question 5.
- **Amp's Ship** (research 06 section 2.1.x): commit, rebase on `origin/main`, full suite, push, retry on a race. Pushes go through as the user, so branch protection applies.

### R2 and the object, from source and docs

- `put` with a stream needs a known length: `Provided readable stream must have a known length` (`workerd/src/workerd/api/r2-rpc.c++:179`). `Files.readFile` returns `new Response(stream)` with no length (`sandbox-sdk/packages/sandbox/src/files/read-file.ts:44`). So the object calls `Files.stat`, then pipes through a `FixedLengthStream(size)`, as the SDK's own gateway does for parts (`directory-backup/gateway.ts:65`).
- `put` takes one checksum, such as `sha256` (Workers API reference). The docs do not say what a mismatch does; spike A measures it. `onlyIf` is available, and `head()` returns metadata or null.
- Limits: 5 GiB single part; one write per second to one key, 429 above it (r2/platform/limits).
- Prices, page updated 2026-10-30: $0.015 per GB-month, $4.50 per million Class A, $0.36 per million Class B, egress free, free tier 10 GB-month, 1M A, 10M B (r2/pricing).
- Lifecycle rules take a prefix, and "objects will typically be removed within 24 hours" of expiry (r2/buckets/object-lifecycles). Alchemy's `lifecycleRules` takes `deleteObjectsTransition` with `maxAge` in seconds (`Bucket.ts:91-99`, `:415-422`).
- Containers survive object eviction, and an eviction kills the foreground command (`spikes/1-stones/NOTES.md`, "Eviction"). Link reads measured 14 MB/s on 10 MB (same file, "Numbers"). Research 02 gives `setInactivityTimeout` at most 6 hours and a fresh disk on each start (`research/02-cloudflare-stones.md:290-292`).
- Cloudflare Artifacts (research 02 row 12): "Versioned storage that speaks Git", needs Workers Paid; the overview page states no status or price. Not needed, and the settled design does not use it. Row 5, direct push from a container, stays rejected: no credential enters a stone.

### Probes

Throwaway, in `/tmp/results-probe`: `p1.sh`, `p3.sh`, `p5.sh`, `p5b.sh`, `p6.sh`, `integrate-sim.mjs`, `integrate-judge.sh`. Every git ran with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`. Mirror-side runs used v1's `SAFE` set: `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `transfer.fsckObjects=true`, `fetch.fsckObjects=true`, `protocol.allow=never`, with `protocol.file.allow=always` for that one fetch. None ran against a real container.

| Probe | Result |
| --- | --- |
| Empty range | `fatal: Refusing to create empty bundle`, rc 128. So "no commits" is a status found before cutting, not an error. |
| Prerequisites | A repo lacking the base: `bundle verify` and `fetch` both rc 1 ("lacks these prerequisite commits"). After `git fetch <project path> <base sha>` both pass. A non-tip sha fetched too. |
| Shallow stone | A depth 1 clone cut `base..stone`, and it verified and fetched at home. Bases may stay shallow. |
| Dirty snapshot | A copied index, `add -A`, `write-tree`, `commit-tree`, `update-ref refs/cairn/dirty`: `git status` unchanged, untracked files captured, both refs cut into one bundle (`base..stone/x base..refs/cairn/dirty`). |
| `.git`, `.GIT`, `git~1` in a tree | Refused by fsck (`hasDotgit`), rc 1, no ref. **Control:** with fsck off, the ref landed. |
| `.gitmodules` `--upload-pack` URL, `../../evil` name, symlink | Refused (`gitmodulesUrl`, `gitmodulesName`, `gitmodulesSymlink`). |
| Gitlink, absolute symlink to `~/.ssh/id_ed25519`, `.gitattributes` `filter=evil`, edited `lefthook.yml` | **Accepted.** They are legal trees. Harmless in a bare repo; harmful on a checkout or a push. |
| Extra refs (`refs/tags/v9`, `refs/heads/main2`) | Only the named refspec landed, so a bundle cannot write a ref. A missing named ref is rc 128. |
| Truncated bundle | rc 1, `early EOF`. A failed fsck left a `tmp_pack` file behind. |
| `git bundle create --filter=blob:none` | `unknown option` on 2.56. I did not hand-build a v3 bundle. |
| Tree bomb: 10 entries, 9 levels | **Bundle 940 bytes; fetch passes.** `merge-tree` onto the base returned a tree at once, so picks and a push would carry it. `ls-tree -r -l \| head -1001` took 9 ms. `diff-tree -r --name-only` printed nothing before a 10 s timeout, burning 10 s of CPU. |
| 200 MiB random blob | `rev-list --objects --disk-usage` 221 MB, bundle 209.8 MB. `transfer.`, `fetch.` and `receive.maxInputSize` at 1 MiB: fetch rc 0, ref set. **Not enforced on a bundle fetch.** |
| Pure pick | Same inputs twice gave one sha. A real conflict is rc 1 with stages and `CONFLICT (content)`. A forged `Cairn-Thread` was replaced by `interpret-trailers --if-exists replace`. |
| Hooks | Plumbing ran none of nine planted hooks. `git cherry-pick` in a worktree ran `prepare-commit-msg`, `post-commit`, `reference-transaction`. |
| `cherry-pick` as the pick | Repeats differ in sha (committer date). A second pick of the same commit fails rc 1 and leaves a cherry-pick in progress that needs `--abort`. |
| Merge commit in a stone's range | `merge-tree --merge-base=<base> <parent> <tip>` works as one squash pick; on an unchanged parent the tree equals the tip's. |
| Push from the bare repo | No hooks; repeating the same push is rc 0; a stale push is `rejected (fetch first)`, rc 1. |
| **lefthook in a worktree** | Installed lefthook in a throwaway repo, edited `lefthook.yml` on a worktree branch, committed with hooks off, ran `git push`: the log read `STONE-WROTE-THIS-RAN-AT-HOME`. With `-c core.hooksPath=/dev/null`: nothing ran. |
| Faux kill matrix (`integrate-judge.sh`) | Ten one-commit stones, a JSON row standing in for the ledger, self-`SIGKILL` at `before-ref`, `after-ref`, `after-record`, at picks 0, 4 and 9, plus one run with six kills. **10 of 10** ended on the clean run's exact sha with 10 commits. **Control** (pick onto the ref as found, time-of-day committer) ended with 11 commits, 10 distinct sources. |
| `bwrap` | `--ro-bind /usr /usr --tmpfs /home --unshare-all`: `/home` empty, uid 1000, no network, no privileges needed. |

## Design

### Question 1: the result, the cut and the transport

**Wrap.** `stone()` resolves with a new shape; nothing about `agent()` changes.

```ts
StoneOutcome = {
  value,            // the model's typed value, checked against the schema: a claim
  work: StoneWork,  // the brain's receipt, read from git
  nodeId, threadId,
}
StoneWork = {
  status: "committed" | "no_changes" | "uncommitted_only" | "off_branch" | "too_large" | "no_repository",
  branch,           // stone/<id> as named at launch
  base, tip,        // full shas
  commits: number,
  ref,              // refs/cairn/stones/<id>/<n>/tip in the result repo
  dirty: { paths: number, ref: string | null },
  stray: Array<{ name, ref }>,
  bundle: { key, sha256, bytes },
  claimedCommit: string | null,   // the model's, kept to show a mismatch
  flags: Array<"claim_mismatch" | "squashed" | "sensitive_paths" | ...>,
}
```

Where the requested fields live: `status` and `summary` are the model's own, in `value` and `resultSummary`. `commit` and `branch` are `work`, the brain's. `evidence` is `value` as a claim and a verify node's verdict as fact. `verdict` is a separate `verify` row, because a writer never carries its own verdict. `cost` is the node's `receipt` plus compute, never in the tool's result (spec section 12). Truth order follows research 06: git over envelope over transcript. `NodeRecord` gains `work` as an optional key, as `thinkingLevel` did (`Workflows.ts`), and `NodeStage` gains `collected` and `fetched`.

**When to cut.** At the end of every run that moved the tip or left a dirty tree, keyed by tip, so an unchanged tip cuts nothing. A workflow node's last run is the one its row records. A read-only node skips all of this. This also gives a plain stone its durability: its committed work is home after each run, not only when it ships.

**How committed work is guaranteed.** The node's task, once the run has ended and the typed result is valid, asks the `Workspace` object to inspect, with fixed argv and hooks off: `status --porcelain=v1 -z --untracked-files=all`, `symbolic-ref -q HEAD`, the tip of `stone/<id>`, and `for-each-ref refs/heads`.

| Found | What happens |
| --- | --- |
| Clean, on `stone/<id>`, ahead of base | Cut it. `committed`. |
| Clean, tip equals base | No bundle. `no_changes`. |
| Dirty | One commit nudge, same shape as `typedResult`'s (request id `<node request id>-commit`). If still dirty: the non-mutating snapshot (probe) goes on `refs/cairn/dirty`, travels in the bundle, lands on `.../dirty`, **and is never integrated**. Counted in `dirty.paths`. If that was all the work: `uncommitted_only`. |
| HEAD descends from `stone/<id>` on another branch, or detached | The brain fast-forwards `stone/<id>` with `update-ref` in the container and flags it. |
| Commits unreachable from `stone/<id>` | The nudge once; then `off_branch` or `committed`, with up to four stray tips carried on `.../stray/<n>`, never integrated. |
| Base not an ancestor (history rewritten) | Found at home by `merge-base --is-ancestor` (question 2): refused. |
| `.git` gone | `no_repository`, failed, says so. |
| `--disk-usage` over the cap | `too_large`, nothing cut, the container held for the user. |

I rejected auto-committing dirty files onto the branch: the model did not decide that work was done, and it would reach `integrate` unnoticed. The snapshot loses nothing and integrates nothing.

**The cut.** In the object, with `container.exec`: `git -c core.hooksPath=/dev/null -c core.fsmonitor=false bundle create --version=2 -q /tmp/cairn-result-<tip>.bundle <base>..refs/heads/stone/<id> [<base>..refs/cairn/dirty ...]`. Git in the container is under the model's control and may lie, which is fine: the output is data and home trusts none of it.

**Transport: R2 from the `Workspace` object.**

|  | R2 from the object (chosen) | Stream over the link (v1) |
| --- | --- | --- |
| Normal flow | Two hops: container to R2 to home | One hop through `openBinaryReader`; 14 MB/s measured at 10 MB |
| Brain down when the container's time runs out | The object's alarm cuts with no brain; the bytes wait in R2 | Lost |
| Container dies between cut and fetch | Bytes survive | Lost |
| Retry | A plain GET, ranges available | Recut, or restart from the container |
| Build cost | One bucket, one binding, one upload path, one authenticated route, one lifecycle rule | Almost none |
| Failure surface | `Files.readFile` at size, unmeasured | Link eviction during a long copy |

Streaming is simpler, and with a brain that only ever restarts in seconds it would do. The case it cannot cover is a long outage (a power cut, the user away), because the disk is fresh on each start. R2 stays, as settled.

The upload is `Files.stat`, `Files.readFile`, `FixedLengthStream(size)`, `RESULTS.put(key, readable, { sha256, customMetadata: { tip, base } })`, with `sha256` read by `sha256sum` in the container. The key is `results/<stone id>/<tip>.bundle`. Home downloads through a Worker route behind the same Access service token as the link (`GET /stones/<id>/results/<tip>`), so the Beelink holds no R2 credential; Alchemy's presigned URLs are the alternative and are not needed.

**R2 lifecycle and cost.** The brain deletes the object after its receipt commits. A prefix rule on `results/` removes anything left after 14 days, the longest outage worth surviving; a refused bundle stays there for that time as evidence. Ten stones at 5 MiB is about 50 MB for minutes: inside the free tier, $0 in practice, and it does not touch the idle-cost target unless orphans pass 10 GB, which `bases.md`'s R2 use shares. Past the free tier, $0.015 per GB-month.

**Idempotency and receipts** (`docs/phase-2/plan.md` section 1: a key and a receipt per crossing; a wait is a replay-safe tool; each task names its replay policy; each window joins a kill judge). The `stone` tool is `replay: "safe"`. It finds its row and resumes from `stage`.

| Step | Key and receipt | `kill -9` or eviction here |
| --- | --- | --- |
| Inspect | Read-only | Reruns |
| Nudge | Request id `-commit` | pi-durable answers with the first submission |
| Cut and put | Key is the tip; the object keeps `{tip, key, sha256, bytes}` in its SQLite | Evicted mid-put: nothing stored, retry recuts. Evicted after put: `head()` finds it and answers from its metadata |
| `collected` commit on the row | In one commit with the stage | Rerun asks the object again, same answer |
| Download | Temp file named by sha; byte cap; streaming sha256 | Boot sweeps scratch (v1's `sweepScratch`); rerun downloads again |
| Fetch to quarantine | Non-force refspec to a fixed ref | A repeated fetch is a no-op |
| Validate, promote, settle | One `update-ref`, then one commit: `work`, stage `fetched`, event `stone.result.fetched` | Before the commit: rerun validates again, promote is idempotent. After: rerun finds the row ended |
| R2 delete | A background task the settle commit created | Best effort, lifecycle is the backstop |

The `stone.result.fetched` event is what lets `arms.md` release the container, so a container never goes while its only copy is unfetched, except after a safety cut.

### Question 2: where results go on the brain

**Result repo:** `<dataDir>/results/<project id>.git`, `git init --bare --template=`, so it has no hook files (`Mirror.ts:90`). `dataDir` is on the NVMe under `/home` (`apps/server/src/Config.ts:103`). The base reaches it by `git fetch <project path> <base sha>` before a stone starts (the project is trusted, the probe shows a non-tip sha works). `bases.md` can cut seed bundles from the same repo, as v1 did.

Refs, all under `refs/cairn/`: `stones/<id>/<n>/tip`, `/dirty` and `/stray/<k>`, where `<n>` counts that stone's results; `quarantine/<id>/<n>`; `integrations/<id>/head`; `remote/<base branch>`. Non-force refspecs: one result is immutable.

Why not `refs/cairn/stones/<id>` in the project's repo: it brings untrusted packs into the object store the user's `git gc`, tools and hooks use, runs under project config (`Git.ts:5-9` keeps it on purpose), and makes bombs the user's problem. The one cost is a second copy of the base's objects, which is cheap on the NVMe. **Never touching the checkout** is then structural: no result operation has a path into it. A judge still hashes it (below).

**A second runner**, `results/ResultGit.ts`, ported from `Mirror.ts`: `execFile` argv, environment built from nothing but `PATH`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `HOME=/nonexistent`, `GIT_NO_REPLACE_OBJECTS=1`, the `SAFE` flags, values checked by regex (`Mirror.ts:16-31`, `:64-85`). Only the push adds what it needs (question 5). Writes per project are serial, as `ChildWorkspaces.ts:240`.

**Validating, in order. Each failure leaves the result repo's refs untouched and sets `refused` with the reason.**

1. **Before download:** `head()` size at or below the cap; the receipt's sha.
2. **Download** to a 0600 temp file with a hard byte limit and sha256. `maxInputSize` does not work on a bundle fetch (probe), so this is the only byte cap.
3. **Header:** the exact bytes `# v2 git bundle\n`. v1 also took v3; the cut always asks for v2, so v3 is refused and its capabilities are not in play.
4. **`bundle list-heads`:** exactly the expected ref names (fixed by the brain, never read from the bundle), and the tip equals the receipt's.
5. **Fetch** into `quarantine/<id>/<n>` with fsck, `--no-tags --no-write-fetch-head --no-recurse-submodules --no-auto-gc`.
6. **Ancestry:** `merge-base --is-ancestor <base> <tip>`; commit count at most 1,000 (`rev-list --count`, with a timeout).
7. **Tree caps, streamed:** `ls-tree -r -l <tip>` through a reader that stops at the limit: at most 200,000 paths, total blob bytes at most 2 GiB, no blob over 100 MiB (GitHub's own limit for a push, from memory, not checked today). The bomb takes 9 ms this way; never `diff-tree` first.
8. **Tree policy:** a gitlink not already at that path in the base is refused. A symlink that is absolute or climbs out of the tree is refused. Changes under `.cairn/`, `.github/workflows/`, `.gitattributes`, `.gitmodules`, `lefthook.yml`, `.husky/`, `.agents/` are allowed but flagged `sensitive_paths`, shown on the ship card.
9. **Promote** with `update-ref`, delete the quarantine ref.

**What the brain must never do with bundle contents:**

- Check out a stone's tree on the Beelink. That covers symlinks, `.gitattributes` filters and any tool that reads the tree.
- Run git on it with a project's config, or with hooks on.
- Run anything from it: no `pnpm`, `lefthook`, `.agents/*`, or `.cairn/verify` read from the stone's own tree. Config comes from the base or the remote tip.
- `git fetch` from a stone's `.git`, or take a ref name, path or message into a shell string. Argv only, with `--end-of-options`.
- `git submodule` anything; follow a `.gitmodules`.
- Trust a trailer, author, date or message as provenance. The brain stamps provenance at the pick.
- Hand commit messages or diffs to a model as instructions. A resolver gets them marked as untrusted data, and the UI escapes them.
- Force-push anything, ever.

**Retention.** Refs stay until the thread is deleted: a failed, unverified or skipped stone's result is the user's, the same rule as child worktrees (`ChildWorkspaces.ts:12`). Unreachable packs get a weekly `git gc --prune=30.days`, and a boot repair removes `tmp_pack_*` older than a day (probe). Disk use is shown, not capped, until someone sees it grow.

### Question 3: the integration node

**A new prelude verb**, promised in ADR 0012, as a nested `replay: "safe"`, `callers: ["tools"]` tool. `PRELUDE_VERSION` goes to 4; `NODE_TOOLS` and the dry run's stubs gain it; 3 stays runnable.

```js
const merged = await integrate(results.filter(Boolean), {
  branch: "cairn/fanout", // optional display name
  checks: "fast", // "fast" | "none"
  resolver: { model: args.model }, // optional; none means the launching thread's (ADR 0043)
  onConflict: "resolve", // "resolve" | "card"
});
// { status: "integrated" | "partial" | "stopped" | "empty", tip, base, ref, picked, resolved, skipped, checks }
```

It takes `StoneOutcome`s and refuses anything without `work.status: committed`. Home writer nodes are not accepted in phase 3. It returns `null`-free data; a failure is `status`.

**Where it runs.** Picks in the result repo on the brain, as plumbing. Checks in a check run. No worktree exists on the Beelink.

**Order:** the array the script passes, which `parallel` and `pipeline` give in item order, not completion order. A script can sort it. All stones must share one base, or the script names `base`. Within a stone: `rev-list --reverse --topo-order <base>..<tip>`.

**Cherry-pick, not merge or rebase.** The settled choice holds up against the trailers. Each picked commit keeps its message, gets `Cairn-Thread: <the stone's thread id>` replaced by the brain and `Cairn-Stone-Commit: <source sha>` added, so `git log --format='%(trailers:key=Cairn-Stone-Commit,valueonly)'` alone answers "which stone wrote this". A merge per stone gives the same conflicts but a non-linear trunk. A rebase is the same operation in porcelain, with a checkout and `post-rewrite`. **A merge commit inside a stone's range** makes that stone a single squashed pick, flagged.

```text
pick(parent, source, frozen) =
  tree   = merge-tree --write-tree --merge-base=<source>^ <parent> <source>     // rc 1 is a conflict
  if tree == parent's tree: record "empty", no commit
  sha    = commit-tree <tree> -p <parent> -F <stamped message>
           with author name and email from the project's identity, author date from <source>,
           committer the project's identity, committer date frozen in the row
  update-ref refs/cairn/integrations/<id>/head <sha> <parent>                   // compare and swap
```

**The record**, one `cairn.integrations` document on the launching thread (same lifetime as `cairn.workflows`, whitelisted in `ThreadWire`), with a node row of `arms: host` pointing at it:

```ts
IntegrationRecord = {
  id: "int-<tool task id>",
  workflowId,
  nodeId,
  projectId,
  state:
    "planned" |
    "picking" |
    "checking" |
    "resolving" |
    "waiting_user" |
    "integrated" |
    "partial" |
    "stopped" |
    "failed",
  base,
  ref,
  displayBranch,
  frozen: { name, email, date },
  checksFrom, // the commit the config was read from
  stones: Array<{
    threadId;
    label;
    resultRef;
    tip;
    commits: string[];
    mode: "commits" | "squash";
    state: "pending" | "picked" | "resolved" | "skipped";
    picks: Array<{ source; result }>;
    checks: { verdict; command; exitCode; tail; flaky; commit } | null;
    resolverNodeId;
    cardId;
  }>,
  tip,
};
```

**Fast checks** are what a project declares for "does this still build and pass its quick tests", per project, in the repo: `.cairn/verify/verify.json` `{ "checks": { "fast": [{ "name", "argv", "timeoutSec" }], "full": [...] } }`. This is research 06's shape for Phase 4 (section 3.3), minus the rest, so Phase 4 extends it. The file is read from the integration's **base**, never from a stone's tree, or a stone could rewrite its own gate; a stone's edit to it is flagged. `argv`, no shell, like the command judge. Limits are the lander's: 2 minutes with no output, a total timeout, the process group killed, one rerun, a pass on rerun is `flaky`. Checks run once per stone after its last commit, not per commit. No file means `checks: none`, which reads "unchecked" everywhere and never "passed".

**Is it safe to run a project's checks on the Beelink against a stone's code? No, and the marginal risk is worth a sentence.** `pnpm test` runs what the stone wrote, as the user, with `~/.pi/agent/auth.json`, `~/.ssh`, `~/.alchemy` and a docker group that is root-equivalent, with nobody having read the diff. ADR 0013 already admits home threads run unconfined, so this is not a new class of risk on a one-user machine. But home runs what a model chose in front of the user; this would run, automatically, code that came from a box whose whole point is that nothing it does reaches home, and it would turn "credentials never leave the Beelink" into words.

| Option | Safety | Speed and cost | Verdict |
| --- | --- | --- | --- |
| **Check run: throwaway arms from the prepared base** | Same as the stone | Seed plus check per pick. standard-1 about $0.074/h busy (`research 02`): ten picks at 40 s is 400 s, about $0.01. standard-4 about $0.40/h by research 02's rates, so a 30 minute full check is about $0.20. | **Chosen** |
| Worktree on the Beelink | None | Free, and the machine has 16 threads | Refused by default |
| `bwrap` on the Beelink | Hides `/home` and the network (probe), but needs deps installed at home first, whose lifecycle scripts are the same problem | Free | Second choice, if spike B fails |
| The writer's own stone | The model can have changed anything in it | Free | Not an outside judge |

One check run serves one `integrate`: reset to each tip with `git checkout --detach` and `git clean -fd`, keeping ignored dependencies. It is a thread-less use of the `Workspace` object, so it needs `arms.md`'s agreement, and the job pattern from spike 1 (background, status file, reattach by id) so a brain kill or eviction does not kill the check.

**Ledger and events.** Nested results vanish when the script ends (spec 7.3), so the record holds everything. Events are few: `integration.finished` and `ship.finished`, each in its row's commit, plus `stone.result.fetched`. Per-pick progress goes in the document, on the thread stream.

**A crash resumes exactly once.** Each step is one of three kinds: pure, compare-and-swap, or a commit.

| `kill -9` here | On rerun | Result |
| --- | --- | --- |
| Before `update-ref` | Recompute from the record's parent | Same sha, ref moves |
| **After `update-ref`, before the record: the hard case** | Recompute from the record's parent: same sha; the ref already equals it, so skip the update; record | No second commit. Measured 10 of 10; control 11 commits |
| After the record | Next pick | Nothing |
| A git upgrade between lives changes the merge result | The sha differs from the ref. If the ref's parent is the record's parent and its `Cairn-Stone-Commit` is this source, adopt the ref. Else `failed`, for a person | Never a silent double pick |
| During a check | Reattach by job id; if the arms are gone, run it again | **A check can run twice**; it changes nothing, and only the commit that records it counts |
| During the card's wait | The tool reruns, finds the record, waits (ADR 0013); boot retries pending tasks | One answer |

"Exactly once" here means refs and records. Stop works as elsewhere: poll between picks, the ref stays, the row ends `stopped` by the watcher (`WorkflowTools.ts:48-50`).

### Question 4: the resolver and the conflict card

**When:** a pick conflicts, or a pick is clean but its fast checks fail twice. One attempt per stone, kept in the record, not by convention. `onConflict: "card"` skips it.

**The agent:** one ordinary stone node under the same envelope, listed on the launch card as a call site of the `integrate` call with a maximum of one per stone. **Model:** the launching thread's model and level, per ADR 0043, unless the script names one. It writes code, so **its arms are a stone**, not home.

**Input, as a prompt built by the brain with everything marked as untrusted data:** the two stones' labels and briefs; the stone's patch being picked (`format-patch base..tip`, cut); what it collided with, `git log -p` of earlier stones on the same paths, cut; `merge-tree`'s conflict list; the check's command and tail if a check failed; and the rule "keep both changes' intent; touch only these paths". Its disk is the integration tip with the pick applied and conflict markers present, arranged by the brain.

**Its result is checked by code,** after coming home through the same collect and validator:

1. One new commit on top of the integration tip, no more.
2. Paths touched are within those both sides touched; outside that fails `resolver_scope`.
3. No conflict markers in changed files.
4. The fast checks pass in the check run.
5. If the script gave a per-stone `check`, **both stones' checks pass**, which is what catches a resolver dropping one side.

If all pass, the commit enters with `Cairn-Resolved-By: <thread>`, `state: resolved`, and the ship card counts it. A check from another model family happens only when the script or user asks (ADR 0043). Otherwise the card.

**The card's record**, a new `ApprovalPayload` variant and a new `integration` kind; `surfaces.md` draws it:

```ts
IntegrationConflictPayload = {
  type: "integration_conflict",
  integrationId,
  workflowId,
  nodeId,
  reason: "conflict" | "checks_failed" | "resolver_failed",
  position: { index, of, remaining },
  target: { displayBranch, tip, base },
  stone: { threadId, label, branch, tip, commits: Array<{ sha; subject }> },
  against: Array<{ threadId; label; commits: Array<{ sha; subject }> }>,
  paths: Array<{ path; status }>, // at most 50, then a count
  patches: { theirs, ours }, // each cut to 32 KiB, with the full text a reference
  conflictText, // merge-tree's messages, cut
  checks: { command, exitCode, tail } | null,
  resolver: { nodeId, threadId, modelId, outcome, reason, tail } | null,
  retained: { resultRef, integrationRef },
  options: ["skip", "retry", "stop"],
};
```

**From a phone,** three things and a link: **Skip this stone** and go on (its result stays). **Try again with a note,** the user's own word for a second attempt, never automatic, with the note added to the resolver's prompt. **Stop here,** keeping what is integrated, `partial`. Opening the stone's thread or the resolver's is a link, and either can be read and steered. Resolving by hand is a desk job: the card says which refs hold the work, and "use my commit" is left for later.

**Resuming.** The tool writes the record through `approvalLedger`, as `approve` does (`WorkflowTools.ts:2297-2311`), and waits as a replay-safe tool. The answer is one host commit with the pick in `answers[0].picks[0]` (`:2325`), `decidedBy` user. Decline reads as stop, with its reason. Expiry at 24 hours (`Permissions.ts:157`) reads as stop, and nothing is lost. The push is the existing approval push. In full access it still waits, as a brief does (ADR 0030): the mode gates tools, and this is not a tool call.

### Question 5: ship

**The setting** is per project, on Cairn's project row, not in the repo, so no stone can change it: `ship: { mode: "trunk" | "pr", base: string | null, remote: "origin" }`, default `pr`. `base` none means the checkout's current branch at ship time. A project with no remote cannot ship; its action is "Deliver as a local branch", which fetches into `refs/heads/cairn/integrated/<id>` in the project's repo, with hooks off and no checkout.

**Who may trigger it:** the user, with a button on the integration result or a stone; or a model, through a `ship` tool, which only raises the request. A script cannot: no prelude verb in phase 3, as research 06 has ship as "the thread's final step". **Approval:** a new `ship` kind with a frozen payload: mode, remote, base, commit list with stones and resolved marks, diffstat, verdicts, `sensitive_paths` flags, the checkout's state as a note. **Every ship waits for the user in every mode,** `accept_for_thread` refused, because a push is the first effect in this design that leaves the owner's machines and cannot be taken back.

**The source** is any commit in the result repo: an integration's tip, or a plain stone's latest result. So **a plain stone also ships**: the engine re-picks its commits like a one-stone integration.

**Trunk:**

1. `git ls-remote` for the base; fetch it to `refs/cairn/remote/<base>`.
2. Re-pick the source's commits onto the remote tip with the same pure pick (always, unless already based there; this also keeps a user's unpushed local commits from travelling, when a stone's base had them). A conflict goes down the same resolver and card path.
3. Run `checks.full` from **the remote tip's** `.cairn/verify/verify.json` in a fresh check run. None declared: the ship card says so before Go, and trunk needs an explicit tick.
4. Commit `pushing { sha }` to the ship row: the effect mark.
5. `git push <url> <sha>:refs/heads/<base>`. Never forced; there is no code path with `+` or `--force`.
6. Rejected: back to 1, at most 3 attempts (the lander's number), then a card.
7. Accepted: one commit, `shipped { sha, remote, ref }` and `ship.finished`. Then archive and release per `arms.md`.

**A kill between push and record:** the mark names the sha. Rerun: `ls-remote` and `merge-base --is-ancestor`; if the remote holds it, record `shipped`, otherwise push exactly that sha. Pushing twice is rc 0 (probe).

**PR:** the same up to step 3, except that `checks.full` is a per-project choice before opening (default on, because a green PR is what the outside judge is for). Push to `refs/heads/<branch>`, where the branch is `cairn/<workflow slug>` or `stone/<id>`, fast-forward only with a `-2` suffix otherwise. Then `gh pr list --repo <owner/name> --head <branch> --state open --json url` first, and `gh pr create --repo ... --head ... --base ... --title ... --body-file -` only if none, argv only. `gh` errors on a duplicate anyway; v1 did the same check. The body is a brain template; stone text is quoted. CI watching is out of scope.

**Credentials.** The Beelink has what it needs today: the SSH key and `gh`, both working from a user unit with no agent. The push's environment adds to `ResultGit`'s only the real `HOME` for `ssh` (`GIT_SSH_COMMAND="ssh -o BatchMode=yes"`), still with no global git config, and the remote URL comes from `git remote get-url --push` in the project's repo, which is trusted. Stones never get either. This is not an Executor call: ADR 0003 holds third-party credentials for agents' tools, and the kickoff settles home-held credentials for the push; a short ADR should say so.

**The pre-push hook** does not run, by construction: the result repo has no hooks, and `-c core.hooksPath=/dev/null` is set anyway. The lefthook probe shows it must not: it reads `lefthook.yml` from the tree being pushed. Cairn's 7 minute `pnpm check` becomes Cairn's `checks.full`, run in a check run. The user's own pushes from their checkout keep the hook.

**Refusals.** Refused: not a git project; no remote for `trunk` or `pr`; detached HEAD when `base` is unset, since the base cannot be named; red or missing required checks; an integration in `failed`; a branch the remote has that is not a fast-forward. **A dirty main is not refused** for a push from the result repo: nothing touches the checkout, and "the user is mid-edit on main while stones finish" is the product working. It is a note on the card, with unpushed local commits. `/wt-merge`'s literal refusals belong to something ship does not do, merging into the checkout, and apply if "Update my checkout" is ever built (`merge --ff-only`, dirty main and detached HEAD refused, abort on conflict).

**Home worktree threads and subagents stay as they are in phase 3.** They have a real branch in the project's repo, the `Cairn-Thread` trailer, and an unconfined `bash` with `gh` and the key; no untrusted boundary is crossed, so nothing needs carrying. The engine takes a commit, so later offering it to them is one `git fetch` into the result repo.

### Question 6: the Fan-out target

**"Zero cross-contamination" as a measurable check.** All of these, on the fixture, every one mechanical (`judges/fanout.ts`):

| Check | Measure | Fails when |
| --- | --- | --- |
| X1 Provenance | Each commit in `base..integrated` has exactly one `Cairn-Stone-Commit` and one `Cairn-Thread`, or is a resolver commit named `Cairn-Resolved-By`. The set of sources equals the union of each stone's `rev-list base..tip`, each exactly once, and those sets are pairwise disjoint | A commit is lost, doubled or foreign |
| X2 Territory | `diff-tree base tip_i` is within `T_i`, the paths stone `i`'s task owns | A stone wrote elsewhere |
| X3 Equivalence | For each non-conflicting stone, `git diff base..integrated -- T_i` equals `git diff base..tip_i -- T_i` byte for byte, and `git diff base..integrated -- <outside every T>` is empty | Integration changed or leaked a line |
| X4 Nonces | Each brief carries a random `N_i`, written into the stone's module and to `/tmp/nonce`. Before release, the judge greps every container's `/workspace` and `/tmp` for each `N_j`, and scans each transcript's entries. 90 ordered pairs, no foreign nonce. | A stone could see another's disk or conversation |
| X5 Distinct arms | Ten different `boot_id`s (spike 1 used it as container identity), each bundle's `list-heads` names only its own branch, each key under its own prefix | Shared arms or a crossed result |

A sixth guards the user's copy: **X6 Checkout untouched.** The project is seeded with dirty and untracked files on its checkout; `git status --porcelain=v2`, the index's hash, `HEAD` and `refs/heads` are the same before and after the whole run.

**Each stone's outside judge, with no Phase 4:** a project check in a fresh check run at the stone's committed tip, with no model:

```js
verify(result, { checks: task.check, label: `Check ${task.id}` });
```

`verify` gains `checks`: an `argv`, or `"fast"`. The row is a node with `arms: stone`, no model, its verdict shaped like `VERDICT_SCHEMA` and the glossary's Verdict (exit code, tail, commit). The prelude's "`unverified`, never `null`" holds. This is an outside judge by the glossary's definition: a test, run outside the arms that wrote the code, against the committed tip only. `CallSite` and the envelope need a no-model kind.

**The fixture**, `judges/fixtures/fanout/`, generated into a temp folder, with `git init` and a bare `origin` beside it: zero dependencies, `node --test` only (the image has Node 24), so the base prepares at once and the judge's time is the design's, not `pnpm`'s. `src/m01.mjs` to `src/m10.mjs` are stubs that throw, `test/m01.test.mjs` to `m10` fail on them, `src/registry.mjs` holds one marked list, and `.cairn/verify/verify.json` declares `fast: node --test test/smoke.test.mjs`, `full: node --test`.

**Ten tasks:** small pure functions, one each, sized for one or two commits: slugify, clamp, chunk, roman numerals, levenshtein, wrap text, parse duration, a priority queue, then two more in the planted pair. `T_i` is `src/mNN.mjs` plus `NOTES-mNN.md`.

**The planted conflict:** tasks 9 and 10 also each add their function to `src/registry.mjs` at the same line. Stone 10's pick conflicts with stone 9's. The resolver must keep both; a registry test (`test/registry.test.mjs`) needs both names, and it is per-stone `check` for both. X2 and X3 exempt only `src/registry.mjs` for those two, where the test decides.

**Pass:** ten stones `committed`, ten verdicts `verified`, one resolver attempt succeeded, X1 to X6 hold, `integrated` reached, trunk ship to the bare `origin` passes `node --test` on a clean clone from it, and the launch card and the ledger each show cost: tokens, list dollars and compute seconds before launch and after, with tokens within 2x of the estimate as `workflows.md` judge 8 has it. A resolver failure surfaces a card and fails the run's green, with one rerun allowed on a named stronger model, recorded. I would rather see that number than hide it.

**Broken controls.** On a faux model and local arms, so they are free and can run often; each must make the judge fail for its stated reason:

| Control | Plants | Must fail |
| --- | --- | --- |
| Crossed key | Stone 3's receipt points at stone 4's bundle | Validator's tip check; with that off, X1 and X2 |
| Shared arms | Stones 1 and 2 on one container id | X4, X5 |
| Theirs wins | The conflict "resolved" by `merge -X theirs` | X3 and the registry test |
| Double pick | The naive pick from the probes | X1 (11 commits) |
| Lazy judge | A check run that exits 0 on a planted wrong answer in stone 6 | The verdict must be `refuted` with the real check; with the plant, a final `node --test` on the clean clone fails |
| Leak | Stone 7 writes outside `T_7` | X2 |
| Dirty leak | Integration takes a dirty ref | X1 and X3 |

**Model and dollars.** The script names `opencode-go/gpt-6-luna`, catalog $0.10 per million in, $0.50 out, $0.01 cached (`apps/server/node_modules/@earendil-works/pi-ai/dist/providers/opencode-go.models.js`, read through its exports), so it is a plan, labelled list price per ADR 0036. **Estimates, not measurements:** a stone at 8 turns with about 15K fresh tokens, 100K cached and 2K out costs under 1 cent; ten plus a resolver, $0.05 to $0.30 list. Compute: ten stones at 5 minutes on standard-1 about $0.06; about 20 check runs at 30 s about $0.02; the monthly allowance (research 02 Q5) probably covers both. R2 $0. **One run: under $0.50; budget the launch at $1, and allow about $5 for development reruns.** One final run with a thread on the bridge shows Claude nodes as well; plan, not bill.

### Question 7: other judges

| Judge | What it measures | Broken control | Rough cost |
| --- | --- | --- | --- |
| `judges/results-kill.sh` (bundle-kill) | `kill -9` at each window in question 1's table, an object eviction mid-put, a container killed after the cut, the safety cut with the brain down. Each result lands once, sha equal to the cut, one row, no R2 object left, dirty work on its ref only | Writes the receipt before the put: a kill loses the result. Must fail by a lost result | Faux arms and local R2 stand-in $0; one deployed run, a few cents and about 10 minutes |
| `judges/integrate-kill.sh` | The probe made real: kills at `before-ref`, `after-ref`, `after-record`, during a check, in a card wait, before the resolver's dispatch, after its settle, at picks 0, 4 and 9, plus several in one run. Tip equals a clean run's sha; each source once; one row | The naive pick: 11 commits measured | $0, faux model and local arms; run by hand like `workflow-kill.sh` |
| `judges/malicious-bundle.ts` | Every row of the probe table as a fixture, plus a lying receipt, a v3 header, wrong prerequisites, a rewritten base, a forged trailer, 1,001 commits. Nothing lands; a marker file proves nothing ran; the project's repo gains no object | fsck off: `.git` lands (measured). Caps off: bomb and 200 MiB land. Worktree plus hooks on: the lefthook marker appears (measured). Each must fail | $0, home only |
| `judges/resolver.ts` | Scripted resolvers: good; drops a side; edits outside scope; leaves markers; dies. Only the first passes; the others raise one card. Then skip, retry with a note, and stop each behave, and a kill mid-attempt does not start a second. One real run on gpt-6-luna | Accept any resolver result: "drops a side" passes, which must fail the judge | $0 for faux; about 5 cents real |
| `judges/ship.ts` | Trunk to a local bare origin: race retried, third loss raises a card, kill between mark and push and between push and record, no force, no hook ran, checks use the remote's config, unpushed local commits do not travel. PR with a `gh` shim for the duplicate. One real PR | A push with `+`, and a ship whose re-pick is skipped: an unpushed commit appears on origin | $0 plus one real PR on a throwaway repo, user decision 12 |
| `judges/fanout.ts` | Question 6 | Question 6 | Under $0.50 a live run; controls $0 |
| The user | Launches the fan-out from the phone, answers a conflict card, ships |  |  |

## Needs from sibling notes

**`arms.md`:**

- A `collect` route and the safety cut on the `Workspace` object; a stone's run-end hook.
- Keep-awake until `stone.result.fetched`, and a safety cut before anything destroys or sleeps a container with an unfetched tip.
- Thread-less use of the object for a check run, with the job pattern: start, status, reattach by id, cancel.
- The stone's id, `stone/<id>` as its branch, and a base sha fixed at launch on its row.
- A way for the brain to run fixed git argv in a stone outside the model's tools.

**`bases.md`:**

- Stones branch from a commit the result repo has, fetched before the stone starts; seed bundles can come from it.
- A prepared base for check runs, keyed the same. What happens when a stone's tree changes the lockfile: a check run must then run setup, and its time counts.
- `git >= 2.54` in the image would give stones the trailer during their life. Not required, since the brain stamps at picks.
- A git identity inside the stone; it does not matter for what ships, since the pick stamps the project's.
- Check runs get no secrets and the same egress rule as a stone.

**`surfaces.md`:**

- `stone()` resolves with `StoneOutcome`, and `verify` takes `checks`.
- `CallSite` and the envelope gain no-model kinds for check runs and the resolver's bound; launch and final cost include compute (`WorkflowSpent` has none today).
- Draw the integration panel from `IntegrationRecord`, the conflict card from `IntegrationConflictPayload`, and the ship card from its payload.
- Steps: `collected` and `fetched` stages, and an integrate node.
- A Ship button and the project's `ship` setting.

## Proposed glossary changes (not made)

- **Result repo**: a project's bare git repository in Cairn's data folder, where stones' results land. Never "mirror", which is taken.
- **Check run**: one run of a project's declared checks against a commit, in throwaway arms from a prepared base, with no model and no thread.
- **Pick**: applying one stone commit onto an integration's tip.
- **Integration**, **Conflict card**, **Ship**, **Safety cut**.

## Risks

- **Check runs may be too slow for real projects,** with Cairn's own check the worst case (spike B). Then the design's strongest stance meets its largest cost, and the user chooses with a number.
- **`Files.readFile` at size.** Research 02 records a hang fixed in 1.0.2, and 1 GiB through a Durable Object is unmeasured (spike A).
- **Container death with no warning** (OOM, a host loss) mid-run loses what was committed since the last run's cut, and the safety cut does not run. Rare; I would not cut on every commit until it happens.
- **A trunk push of code no person read.** `checks.full` passing is the only gate after the user's Go. The card is the mitigation; the diffstat and `sensitive_paths` flags must not be folded away.
- **`merge-tree` differs from `cherry-pick` in corner cases.** I expect both to use the `ort` strategy, but I read no git source and tested only plain edits; only a judge shows it. Rename handling needs a fixture.
- **Rewriting author to the project's identity** loses the stone's stated author, deliberately; the trailers carry provenance.
- **A resolver on the launching thread's model can be expensive** (Opus on a large conflict), bounded by one attempt and the budget.
- **Prompt injection through a stone's own commit message** into a resolver or a card. Marked as data, escaped in the UI, and the resolver's own result gets the same scrutiny, but a model can still be fooled. Its checks are the actual protection.
- **Disk growth in result repos** is unbounded by design until someone deletes a thread.

## Not verified

- Nothing ran on Cloudflare: not the object's cut, R2's checksum mismatch behaviour, the Worker route's streaming, or lifecycle timing.
- Probes used plain git, a JSON file for the ledger and no pi-durable. The kill matrix shows the pick's purity, not the node's wiring.
- A bundle cut by the image's git 2.39 and fetched by 2.56 was not tested; the image's version is from Debian's package page.
- `workspaces/lander.ts` was not read: no clone. A port needs one (`git clone` at `8b263386`), and the MIT header.
- `gh pr create` was not run. `pnpm check`'s 7 minutes is the caller's figure. No real model did any of this. All dollar figures are arithmetic on list prices; v1's $0.074/h is research 02's.
- GitHub's 100 MiB limit is from memory.
- Sibling notes did not exist when this was written; the needs above are unconfirmed.

## Conclusions

### (a) Recommended design, one choice per question

1. **Result:** wrap: `{value, work, nodeId, threadId}`, `work` from git. **Cut:** at each run's end when the tip moved or the tree is dirty, by the `Workspace` object: one commit nudge, then dirty work on a separate never-integrated ref. **Transport:** R2 from the object, with a safety cut for a brain outage; 14 day lifecycle; deleted after the receipt. Keys by tip, receipts on the row and in the object.
2. **Home:** a per-project bare result repo, no hooks, empty environment. A nine-step validator with fsck and its own byte, path and blob caps. Refs kept until the thread is deleted.
3. **Integrate:** a new prelude verb. Pure pick with `merge-tree`, `commit-tree` with a frozen date and a compare-and-swap ref, in script order, no worktree. Fast checks from the base's `.cairn/verify/verify.json`, in a check run. One record, three events.
4. **Resolver:** one stone node on the launching thread's model, given both patches as untrusted data, judged by scope, markers, fast checks and both stones' checks. **Card:** skip, retry with a note, stop, as an approval that resumes the tool.
5. **Ship:** an approved push from the result repo, hooks off, never forced. Trunk re-picks, runs `checks.full` in a check run, marks, pushes, retries 3 times; PR adds `gh`. Set per project on the row, default PR. SSH key and `gh` at home. Plain stones ship; home threads stay as they are.
6. **Fan-out:** `judges/fanout.ts` with X1 to X6, ten zero-dependency tasks, one planted conflict, seven controls, gpt-6-luna, under $0.50 a run.
7. **Judges:** `results-kill`, `integrate-kill`, `malicious-bundle`, `resolver`, `ship`, each with a control.

### (b) Proposed ADRs

Status `proposed` until their gates pass. Numbers are the integrator's.

1. **Stone results land in a result repo.** A stone's work comes home as a validated git bundle through R2 into a per-project bare repository with no hooks and no inherited config, and no tree from it is ever checked out on the Beelink. Gate: `malicious-bundle` and `results-kill`.
2. **Integration picks are pure plumbing.** `integrate` applies each commit with `merge-tree` and `commit-tree` under a frozen date and a compare-and-swap ref, with no worktree, so a replay computes the same sha instead of recovering. Gate: `integrate-kill`.
3. **A stone's code never runs at home.** Project checks against a stone's commits run in a check run on Cloudflare, read their config from the base rather than the stone's tree, and a project opts out only by the user's explicit setting. Gate: `fanout` and spike B.
4. **Ship is a push the user approves.** Trunk or PR per project, set on Cairn's row, from the result repo with hooks off and never forced, waiting for the user in every permission mode, with the home SSH key and `gh`. Gate: `ship`.
5. **ADR 0012 amendment, not new:** `integrate` joins the prelude, `verify` takes `checks`, and picks replace the research's integration worktree.

### (c) User decisions

1. **Where do checks run?** A check run (recommended), a worktree at home, or `bwrap` at home. Recommend the check run, with `bwrap` only if spike B fails for a project you care about.
2. **No integration worktree.** This changes research 06's words. Recommend plumbing.
3. **Ship's default.** Recommend PR for a new project; Cairn itself can be set to trunk, since you push to an unprotected `main` today.
4. **Does every ship wait for you, even in full access?** Recommend yes for phase 3. The alternative lets a launch card pre-approve PRs only.
5. **Dirty main and detached HEAD.** Recommend: a dirty main is a note, not a refusal, since nothing touches the checkout; detached HEAD refuses only when no base is set. The alternative is `/wt-merge`'s literal refusals, which would block ships while you edit.
6. **Home worktree threads and subagents.** Recommend they stay as they are.
7. **Uncommitted work.** Recommend one nudge, then kept on a separate ref and never integrated. The alternative auto-commits.
8. **"Try again with a note" beyond the one attempt.** Recommend yes, by your word only.
9. **Commit identity.** Recommend your project identity on shipped commits, with `Cairn-Thread` and `Cairn-Stone-Commit` trailers for provenance.
10. **Retention.** Recommend result refs until the thread is deleted, 14 days in R2 for what never came home.
11. **Caps.** Recommend 512 MiB a bundle, 200,000 paths, 100 MiB a blob, 1,000 commits, with a per-project override later.
12. **A throwaway private GitHub repo** for one real PR in `judges/ship.ts`. Recommend yes; a wizard step.
13. **"Deliver as a local branch"** for projects with no remote. Recommend yes; "Update my checkout" with `/wt-merge`'s refusals stays later.
14. **The word.** Recommend "result repo", because `GLOSSARY.md` has "Mirror".

### (d) Spikes

| Spike | Measures | Gate |
| --- | --- | --- |
| A. Result round trip | 1 MiB, 100 MiB and 1 GiB from a container through the object to R2 to the Beelink. Eviction mid-put. A wrong `sha256`. A safety cut from an alarm with no brain | 100 MiB in at most 60 s; no partial object after an eviction; a wrong checksum stores nothing; 1 GiB completes or the cap comes down to what does |
| B. Cairn's check in a check run | `pnpm check` on `main` in a check run from a prepared base, on standard-4 | At most 30 minutes and $0.50, and green. Otherwise the user picks between trimming `checks.full` and `bwrap` at home, with this number |
| C. Check-run overhead | From a prepared base: start, apply `base..tip`, reset between picks, on the fixture | At most 10 s per pick beyond the check; a check survives a brain `kill -9` and an eviction by reattaching |

### (e) Packages

Each is done when `pnpm check` is green and its judge passes. `arms`, `bases` and `surfaces` mean those notes' schemas.

| Package | What | Depends on | Judge |
| --- | --- | --- | --- |
| RES-1 Result repo | `results/ResultGit.ts`, `ResultRepo.ts`, `ResultValidate.ts`, boot repair, weekly gc | None | `malicious-bundle` |
| RES-2 Collect and transport | Bucket and lifecycle in `alchemy.run.ts`, the object's inspect, cut, put and safety cut, the download route | arms; spike A | `results-kill`, deployed run |
| RES-3 Stone work receipt | `StoneWork`, stages, commit nudge, `stone.result.fetched`, the `stone` tool's collect path, R2 delete task | RES-1, RES-2, arms, surfaces | `results-kill` |
| RES-4 Check runs | `verify.json` decoder, `CheckRuns.ts`, `verify` with `checks`, limits, rerun, `flaky`, compute on the meter | arms, bases; spikes B, C | Unit on the decoder; a lazy-judge control; X4-style isolation |
| RES-5 Pick engine | Pure `pick`, stamping, squash, `cairn.integrations`, `ThreadWire` entry | RES-1 | Faux matrix from the probes; rename fixtures |
| RES-6 `integrate` verb | Prelude v4, dry-run stub, envelope kinds, check loop, events, stop | RES-3, RES-4, RES-5, surfaces | `integrate-kill` |
| RES-7 Resolver and card | Prompt builder, code checks, payload variant and `integration` kind, the answer path | RES-6, arms | `resolver` |
| RES-8 Ship | Engine, `ship` tool, `ship` kind, project setting, push sandwich, `gh`, local branch | RES-4, RES-5, RES-7 | `ship` |
| RES-9 The gate run | `judges/fanout.ts`, fixture, controls, the live run, the user's phone run | All, surfaces | `fanout`, then the user |

Suggested order: RES-1 and RES-5 first, at home and independent of Cloudflare. Spikes A and C alongside `arms.md`'s first stone. Then RES-2, RES-3, RES-4, RES-6; RES-7 and RES-8 in parallel; RES-9 last.
