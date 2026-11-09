# Phase 3 notes: bases

Scope: how a stone's disk is prepared and how fast it starts. That covers the base itself (snapshot, `DirectoryBackup` or setup), the Stone start target, getting code and secrets into the box, egress, the key and lifecycle of a base, a project with no `.agents/setup`, what the stone image holds, and the judges. The stone as a thread, the link, tool routing, idle and sleep belong to `arms.md`; the bundle home, integration and ship to `results.md`; UI, the workflow verb and spend to `surfaces.md`. This note says what it needs from each. The project-thread coordinator is being rethought separately and is not assumed here.

Nothing in this file was written to source, and no Cloudflare resource was touched. All numbers from Cloudflare are v1's or spike 1's. New numbers come from local probes on the Beelink under cgroup limits, described under "Probes", and they are estimates of a container, not measurements of one.

## Summary

- **Snapshots are the only thing that can meet the target, and they carry two real risks.** A `DirectoryBackup` of Cairn's installed tree is 525 MiB compressed, and extracting it took 12.6 s at half a Beelink core and 5.0 s at four, before download or verification. v1 measured 3.5 s on Cloudflare for only 23 MB. A snapshot also keeps what setup installed outside the repo, which Amp's `.agents/setup` contract promises and one directory cannot. The risks: nobody has measured a real snapshot restore, and storage has no published price and no delete call.
- **Nothing changed in Cloudflare's snapshot terms in the last two weeks.** On 2026-11-04 the pricing page (updated 2026-10-05) still has no snapshot line, the container API has no delete or list, and snapshots and the `durable_object` policy are still public beta. `@cloudflare/sandbox` is at 1.0.3 (2026-10-22), a one-line `readDirectory` fix. The `default` scheduling policy is now deprecated, which does not touch Cairn.
- **No delete makes stored bytes a function of how often bases are built.** Every snapshot lives 30 days from its last restore, whatever Cairn does. So a base must not be rebuilt per commit. Cairn's lockfile moved 9 times in 15 days. At 3 GB a base and 20 builds a month, that is 60 GB-months. The idle target's $1 of room breaks at about $0.017 per GB-month for that case, near R2's own $0.015.
- **A base is reused across commits.** The key's lockfile hash, setup hash and image digest decide reuse; the base commit decides how much to fetch. Fetching 20 commits costs a 411 KB bundle and well under a second.
- **Taken literally, "credentials never leave the Beelink" allows only the git bundle over the link.** Cloudflare's own private-clone guide keeps the token in a Worker secret, which is on Cloudflare. A deploy key needs port 22, which `enableInternet: false` shuts, and a snapshot would keep it. The bundle also serves the 10 of the user's 39 local repos that have no remote, and it needs no new GitHub credential.
- **Project secrets are the honest exception.** A value a process must read has to be in the container. This note proposes names in project settings, values on the Beelink, delivery only through process environments, a scan before capture, and redaction at the brain. A private registry token never needs this; it needs a home gate, which no project needs today (no project has an `.npmrc`).
- **Egress should follow what the stone holds.** Keep `enableInternet: false` always. With no project secret the handler passes everything and logs hosts; once any secret is forwarded, the same handler enforces an allowlist. Research's "only 80 and 443 leave" holds only under `enableInternet: false`: the live docs say other ports go straight out when it is true.
- **Records live in `cairn.sqlite`; the brain builds.** A `Quarry` Durable Object belonged to the rejected Durable-Object-brained design. A unique index gives single flight for ten stones, and a boot repair re-attaches to a build a crash cut off.
- **None of the user's 39 repos has `.agents/setup`,** so the no-setup path is the common path, and a refusal would mean no stone runs anywhere. Recommended: a built-in default chosen by lockfile (20 of the 39 use Bun), reported as a notice. The agent that writes and proves a setup goes to phase 4.
- **Cairn's own repo can run in a stone, with a slightly larger image.** In a cgroup shaped like `standard-4` with an empty `HOME`, `pnpm install` took 10.6 s and `pnpm check` 456 s, passing 2,668 tests. It wants Node 26 (3 tests fail on 24), plus `rg`, `fd` and `sqlite3`. A test run with only the image's tools shows nothing else is missing: no systemd, Caddy, porch, Tailscale or browser. All of this was on the Beelink's CPU; a real stone is still to be measured.

## Facts with evidence

### Pins

| Source | Pin | Notes |
| --- | --- | --- |
| Cairn | `a160935` on `main` | Ground truth. No stone code yet; `apps/server/src/brain/Arms.ts:3` says stones arrive in phase 3. |
| `@cloudflare/sandbox` | npm `latest` 1.0.3, published 2026-10-22; spike 1 used 1.0.2 | Read at `~/Developer/clones/github.com/cloudflare/sandbox-sdk`, working tree at tag 1.0.0 (`f9e972a1`), `origin/main` at `b4c74c90`. 1.0.3's changelog is one fix, `Files.readDirectory()` keeping a leading U+FEFF ([changelog](https://raw.githubusercontent.com/cloudflare/sandbox-sdk/main/packages/sandbox/CHANGELOG.md)). `spikes/1-stones/node_modules` does not exist on disk. |
| `@cloudflare/workers-types` | 5.20261104.1 | `index.d.ts:3989-4005`, the `Container` interface. |
| wrangler | 4.157.0 | `wrangler-dist/cli.js`: `containers images delete` exists; no `containers snapshots` command. |
| cloudflare/agents | `fc7f59fb` (2026-10-20) | Its container harness uses snapshots as bases. |
| Cloudflare docs | Fetched 2026-11-04 | Each page's date is given where cited. |
| Amp docs | Fetched 2026-11-04 | [`orbs/customizing`](https://ampcode.com/docs/markdown/orbs/customizing) is dated 2026-11-03, [`orbs/handling-secrets`](https://ampcode.com/docs/markdown/orbs/handling-secrets) 2026-10-16. |

### Question 1: snapshot, `DirectoryBackup` or running setup again

|  | `snapshotContainer` | `DirectoryBackup` to R2 | Run setup again |
| --- | --- | --- | --- |
| Captures | The whole writable root filesystem; no memory, processes, mounts or `/run` ([API](https://developers.cloudflare.com/containers/api/durable-object-container/), 2026-09-30; [lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/), 2026-10-22) | One directory, with hard links, modes and numeric owners ([reference](https://developers.cloudflare.com/sandbox/reference/directory-backups/), 2026-10-22) | Nothing |
| Restore time | **Unpublished and unmeasured.** Cloudflare's post gives none, and says the scheduler favours hosts that already hold the image or snapshot ([blog](https://blog.cloudflare.com/faster-agent-sandboxes/), 2026-09-30) | v1 on Cloudflare: 23 MB restored into a new sandbox, 3.5 s all in, against 1.1 to 1.4 s for a cold start (`cairn-v1/README.md:256,261`). Cairn's tree: 525 MiB, at least 12.6 s on `standard-1`'s shape (probe) | Cairn: 10.6 s to 68 s on the Beelink's shapes (probe), plus clone and network |
| Size limit | 20 GB ([limits](https://developers.cloudflare.com/containers/platform/limits/), 2026-11-02), and the instance's disk | About 156 GiB compressed (16 MiB parts, 10,000 parts), and the instance's disk | The instance's disk |
| Retention | 30 days from creation or last restore; no custom TTL | Until deleted | Not stored |
| Deletion | **None.** "The Durable Object container API has no method to delete a snapshot" ([save automatically](https://developers.cloudflare.com/sandbox/files/save-a-sandbox-automatically/), 2026-10-22). No list either. Absent from workers-types 5.20261104.1, wrangler 4.157.0 and Cloudflare's OpenAPI schema (its `/containers` paths have no snapshot route) | `delete(record)`, with no running container (`directory-backup.ts:183-195`) | Not stored |
| Price | **Unpublished.** [Pricing](https://developers.cloudflare.com/containers/platform/pricing/) (2026-10-05) does not mention snapshots. The [containers changelog](https://developers.cloudflare.com/changelog/product/containers/) has no entry after 2026-09-30 | R2: $0.015 per GB-month, 10 GB free, Class A $4.50 and Class B $0.36 per million ([pricing](https://developers.cloudflare.com/r2/pricing/), 2026-10-30) | Compute only, under a cent per Cairn install |
| Tie to the image | Hard: "tied to the Container image version it was created from and is not portable" ([guide](https://developers.cloudflare.com/containers/guides/snapshots/), 2026-09-30) | None: restores into "a container that runs a newer image" | None |
| Status | Public beta; "the API and behavior may change" | Part of Sandbox SDK 1.0 | Not applicable |
| Restored `git status` | Should keep mtimes and the index, unverified | Keeps mtimes at tar's precision, unverified | Fresh |
| Keeps setup's system changes | **Yes** | No, only the one directory | Yes |

Conclusion: bases are snapshots, and a miss or expiry runs setup. `DirectoryBackup` is not a base, because 12.6 s is the floor for Cairn's tree, and that floor is on a Beelink core with warm caches. It is still the right tool for something small that must outlive the image, such as a stone's source tree without `node_modules` (34 MB in the probe).

Cloudflare's own harness does exactly this: `harness/container/managed-image.ts:1-14` runs setup steps, writes the daemon and snapshots, keyed by "the image, the steps, and the daemon build". `harness.ts:126-136` treats a snapshot unused for 29 days as gone, and skips one that failed two starts in a row, because "the platform does not say why a start failed". Both rules are worth porting.

Three smaller facts bind the design:

- Starting from a snapshot passes no `image`, and `inspect().image` is an empty string for it, so Cairn must carry the base's identity in a label. Labels allow 64 bytes a value, too short for a whole digest.
- An unrestorable stored id fails with `Snapshot "<id>" was not found`, and the docs do not fall back to the image ([guide](https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/), 2026-10-22).
- `start()` defaults to `lite`, so always pass `instance`.

Workers-types also declares `directorySnapshots` on the start options (`index.d.ts:4007-4021`, `:4046`), with no method to create one on `Container` and no docs. Ignore it, and look again when it is documented, since a directory snapshot might solve the sleep case below.

**The sleeping stone can use the same mechanism, with different economics.** A snapshot on sleep keeps uncommitted and ignored files through the same `start` path. But bases are few and long lived, while sleeps are many, undeletable, and expire after 30 days asleep (Amp promises "even if it sleeps for weeks"). Arms decides. One alternative it should weigh: on sleep, commit everything non-ignored to a temporary ref and bundle it home, then wake from the base plus that bundle. That needs no Cloudflare storage and survives both expiry and an image change, but loses ignored files such as a dev database. The spike measures how large a snapshot of a restored snapshot is, which decides this.

### Question 2: where the rest of the 5 seconds goes

What Cairn's tree is, measured on a fresh clone at `a160935` with an empty store and pnpm hard links, as a container would have it:

| Measure | Result |
| --- | --- |
| `node_modules` | 2.1 GiB apparent, 2.4 GiB on disk; the workspace holds 112,490 files, 1,586 symlinks, 7,497 directories; 572 packages |
| With pnpm's store on the same disk | 2.5 GiB (hard links count once); store alone 102,473 files |
| Largest packages | `@distilled.cloud/gcp` 337 MB, the Agent SDK's `claude` 284 MB, `@distilled.cloud/aws` 206 MB, `@effect/tsgo` 156 MB, alchemy 140 MB, `workerd` twice at about 135 MB |
| `tar` and `zstd -3` of the workspace | 525 MiB; 18.6 s to make at half a core |
| Git | Full bundle of `main` 29 MiB (522 commits, 1,546 tracked files), made in 0.75 s |

The start path, in order. "Measured" is spike 1 or the probe; "guess" is mine.

| Step | Estimate | Basis |
| --- | --- | --- |
| Brain: read the lockfile blob ids, find the row, make the delta bundle | 5 to 70 ms | Probe: `ls-tree` 1 ms; delta bundle 4 ms for 1 commit, 69 ms for 20 |
| Control call to the Worker and `Workspace` | 66 ms, p95 101 ms | S1 `NOTES.md:32` |
| Register the egress handler | 10 to 50 ms | Guess; one or two RPCs inside the object |
| **`start` from the snapshot to an answering container** | **Unknown** | A bare image took 0.6 to 0.9 s (S1 `NOTES.md:35`), and the first start of a new image 10.7 s (`:36`). A cold host pulling or lazily reading 2.5 GiB is the whole risk |
| First exec and daemon hello | 0.33 to 0.5 s | S1 `NOTES.md:35` |
| Trust the egress CA | 10 to 300 ms | Guess; appending to the bundle is fast, `update-ca-certificates` is not. The CA is ephemeral, so this repeats on every restore ([outbound](https://developers.cloudflare.com/containers/configuration/outbound-traffic/), 2026-10-29) |
| Write the delta over the link | 40 to 70 ms | 36 ms a round trip, 15 MB/s (S1 `NOTES.md:33-34`); delta 1.2 KB to 411 KB |
| `git fetch` from the bundle | 20 ms warm | Probe at half a core; cold disk unknown |
| `git switch -c` | 40 ms warm | Probe; touches only changed files |
| `.agents/resume` | 0 for a project without one; blocks at most 10 s | Amp waits 10 s, then lets it run on ([customizing](https://ampcode.com/docs/markdown/orbs/customizing)) |
| First tool call, scripted model | 40 to 100 ms | One exec, 37 ms (S1 `NOTES.md:29`), plus pi-durable's commits |

Everything known adds up to about 0.7 to 1.2 s, against S1's 1.0 to 1.2 s for a bare start. **So the target holds if the restore and its first reads stay under about 3.5 s,** and nothing else on this path can break it. The probe's warm numbers for first reads were small (`git status` 30 ms, importing `effect` 340 ms, walking `node_modules` 420 ms), but they say nothing about a disk that faults in from remote storage. If restores are lazy, the cost moves into the first tool calls, which the target's "first tool call" only partly catches, so the spike must also time the first real commands.

A resume that takes 10 s breaks the target on its own terms. The target is judged on a project with a trivial resume, and a project's own resume time is reported separately.

**What the spike has to measure,** each on `standard-1` with Cairn's real tree, from the Beelink:

1. `start` to first exec from a snapshot: first restore after capture, 20 sequential, ten at once, and after 1 h and 24 h unused, each with `handle.size` beside it.
2. The first commands after restore, in order: `git status`, `git fetch` of a 411 KB delta, `git switch -c`, `node -e "import('effect')"`, `pnpm install --offline --frozen-lockfile` (5.7 s warm in the probe, a project's choice and not on the path), and `find node_modules | wc -l`.
3. The same path with a `DirectoryBackup` of the same tree, once, as the control.
4. Restoring on a different instance size from the one that captured, and on a smaller disk.
5. Lean image against the image with Chromium, for the cold start.

### Question 3: code and secrets without a credential in the cloud

|  | Bundle over the link | Bundle through R2 | Clone through `interceptOutboundHttps`, token in the Worker | Clone through the intercept, token at home | Read-only deploy key |
| --- | --- | --- | --- | --- | --- |
| Literal reading | **Passes** | Passes for git; needs R2 credentials or a Worker route at home | **Fails:** the token is a Worker secret on Cloudflare, though never in the container ([guide](https://developers.cloudflare.com/sandbox/network/clone-a-private-repository/), 2026-10-22) | Passes | **Fails:** the key sits in the container, and a snapshot saves it ([security](https://developers.cloudflare.com/sandbox/concepts/security/), 2026-10-22) |
| New credential | None | An R2 token, or none with a Worker route | A GitHub token per account or repo | A GitHub token at home | One per repo, added by hand |
| Repo with no remote | Works | Works | **Fails** | **Fails** | **Fails** |
| Unpushed local commits | Included | Included | Missing | Missing | Missing |
| Reachable with `enableInternet: false` | Yes | Yes | Yes | Yes | **No:** port 22 is shut |
| Speed for Cairn (29 MiB) | About 2 s at 15 MB/s | About the same, one more hop | Depends on GitHub | Worse: through the link | Not applicable |
| Worst case seen (278 MiB `.git`) | About 19 s | Same; a single Worker request body is limited (100 MB on most plans from memory, unverified) | Depends on GitHub | About 19 s | Not applicable |
| Cost to build | `appendFile` in chunks over the existing link | A route or a token | One handler | A second link channel | Per-repo setup, which the user has rejected |

Local facts that decide it: the user's account has 8 private and 46 public repos (`gh repo list`, counts only). Of 39 repos under `~/Developer/projects`, 28 have `git@github.com` remotes, so the home credential is an SSH key that the HTTP intercept cannot use, and 10 have no remote at all. None uses submodules or LFS, and no pnpm, Bun or npm lockfile has a git dependency.

**Choice: a git bundle over the link.** The existing path carries 64 KiB frames (`spikes/1-stones/src/frame.ts:18-19`), and `RemoteExecutionEnv.appendFile` exists (`pi-env/dist/remote-env.d.ts:41`), so a chunked write needs no new protocol. v1 did this and measured 20 ms for 1 to 22 KB on Cloudflare (`cairn-v1/README.md:259`). R2 adds nothing here, because every stone after the first needs only a few kilobytes. Whether results use R2 is `results.md`'s call.

Details:

- Bundle the full history of the wanted commit's branch. Live Amp docs say Amp clones "the full Git history of the branch", with an opt-in shallow setting, which corrects research 06 line 38's "shallow single-branch clone". A depth 1 bundle from a shallow bare clone worked locally (4.5 MB against 29 MiB); use it above 200 MiB.
- `git bundle` takes a ref, so pin one first under `refs/cairn/bases/<id>`, like checkpoint refs.
- A bundle holds only commits, so a project's ignored `.env` files never travel.
- A stone has no `origin`. An agent that wants newer commits needs a brain tool (see "What I need from arms").
- Submodules and LFS are not bundled. No repo needs them today, and setup fails with that reason if one appears.

**What setup needs beyond the code.** There are two different kinds of secret.

|  | A token for a host (private registry, a private git dependency, an HTTP API) | A value a process must read (`DATABASE_URL` for a dev server) |
| --- | --- | --- |
| Literal rule | Can hold: a **home gate** intercept forwards chosen hosts over the link, and the brain adds the credential and makes the request from the Beelink | Cannot hold. The value must be in the container |
| What the container holds | Nothing, or a placeholder the home gate swaps | The real value, in process environments only |
| Today's need | None: no project has an `.npmrc`, and the user's `~/.npmrc` overrides no registry, though it holds one auth line (not read) | Likely: 10 project folders have a `.env` file (counted, not read) |
| Phase 3 | Not built. A 401 fails setup with its log, and the design is here for when a project needs it | Built |

**Project secrets**, after research 06 section 3.1 and Amp's [handling secrets](https://ampcode.com/docs/markdown/orbs/handling-secrets):

- **Supplying them, with no chat step.** The project's settings page has a list of names and write-only values, each with two ticks: setup, and stones. A button imports names from an `.env` file in the project's folder on the Beelink, and the user chooses which to save; only those values are read. Stored in `cairn.sqlite`, with the same trust as `oauth_credentials` (ADR 0037). For a missing key, a later request card kind asks for it in a private field: its answer goes only to the store, and the record keeps only the name (Amp's "private dialog"). The model only ever knows names.
- **Reaching setup and resume.** Passed per process, through `RemoteExecutionEnv`'s `shellEnv` (`remote-env.d.ts:12-13`) or `ShellExecOptions.env` (`pi-durable/dist/env/index.d.ts:239`), and through `exec`'s `env` in the object. Never `start({env})`, and never a file. `exec` inherits nothing from `start` except `PATH` anyway ([API](https://developers.cloudflare.com/containers/api/durable-object-container/)).
- **Setup gets only setup-ticked values, and the default is none.** Resume and tools get stones-ticked values, like Amp's step 5, which applies the environment after the snapshot.
- **Never baked in.** Setup can still write a value to a file. Before capture, when setup received secrets, the builder scans the writable tree for each value, passed on stdin and never in argv, and refuses to capture on a hit, naming the path but not the value. Amp only asks setup not to do this.
- **Redacted.** The brain wraps the env's `onOutput` and its read results, replacing known values, with a hold-back buffer as long as the longest value so a split value is caught. Values under 8 characters are refused, for Amp's reason. Base64 or otherwise encoded forms are not caught, and the note on the settings page says so.
- **Not logged.** The Worker logs no frames or env, and a test greps Workers Logs output in the judge.

Taken literally, this is an exception to "credentials never leave the Beelink", and the user should say so plainly in an ADR. The rule then reads: Cairn's and the user's own credentials (git, model logins, Executor, registry tokens) never leave. A project secret is a value the user has chosen to send to that project's stones, and it reaches Cloudflare's memory and the container.

### Question 4: egress

What the platform does ([outbound](https://developers.cloudflare.com/containers/configuration/outbound-traffic/), 2026-10-29; [API](https://developers.cloudflare.com/containers/api/durable-object-container/)):

- With `enableInternet: false`, only ports 80 and 443 exist, only what a handler allows leaves, and DNS answers come only from the intercept configuration. A `*` intercept makes every hostname resolve; a bare IP over HTTPS fails.
- **With `enableInternet: true`, other ports go straight out and bypass `deniedHosts`.** Research 02 line 511 states the 80 and 443 limit without that condition.
- Handlers run on the same machine, outside the container. One `interceptOutboundHttps("*", ...)` and `interceptAllOutboundHttp` take 4 of 128 entries; behaviour is chosen inside from props, and registering again with new props changes it on a live container without dropping connections.
- Intercepts last only until the container stops, so they are registered on every start.
- HTTPS interception re-signs with a CA that exists only at run time. Any tool with its own trust store needs telling: v1's `TRUST_ENV` (`egress.ts:33-40`) covers Node, curl, git, requests and cargo, and `exec` inherits nothing, so the daemon's env carries it. Chromium and anything pinned are untested.
- An outbound request body is limited to 100 MiB (limits page, 2026-11-02), which only matters for uploads.

What v1 did and found: `enableInternet: false` plus intercepts with a fixed 14-host list and no credential (`egress.ts:8-23`, `sandbox.ts:134-140`). On Cloudflare, `npm ci` of 138 packages worked through the intercept in 12.6 s including its backup, npm and GitHub answered, and `example.com` got the list's 403 (`README.md:252,260`). A scan of 436 files and every process environment found none of 33 secrets (`README.md:251`). That is all it found: v1 only ran a small npm project there, so nobody learned what a real project hits. The list misses `nodejs.org`, `bun.sh`, `release-assets.githubusercontent.com`, `api.github.com`, `static.rust-lang.org` and `ghcr.io`, among others. v1's retrospective counts its home network fence as ceremony (`research/09-v1-retrospective.md:14`). Amp's outbound is open by research 06 line 52; its current docs describe no allowlist.

| Policy | Stops | What breaks |
| --- | --- | --- |
| Open, through the logging handler | Nothing; shows every host afterwards | Tools that ignore the CA settings; raw TCP (Postgres on 5432, SSH remotes, anything not HTTP) under any policy with `enableInternet: false` |
| One fixed allowlist | Most exfiltration, including by a dependency or a prompt-injected agent | Installers (`curl \| sh` from `bun.sh`, `mise.run`, `astral.sh`), browser downloads (`cdn.playwright.dev`, `storage.googleapis.com`), any third-party API a dev server or test calls (Convex, Stripe, model APIs), external doc fetches from `bash`. Each failure is a 403 mid-run, and a stone working alone may stall on it |
| Per-project allowlist | The same, with fewer false stops | The same until the project's list is right, and it costs a step per project, which the user has rejected for Executor (kickoff line 70) |
| Handler restricted to read methods on the default list | Exfiltration through the allowed hosts themselves | Uploads to registries, `npm audit` POSTs unless listed |

Who is at risk decides it. With no project secret, a stone holds only source that the user chose to send, while a host thread with full access holds far more on the Beelink. A secret is what makes exfiltration matter.

**Recommendation: the policy follows what the stone holds.**

- `enableInternet: false` always, so there is one network path, ports 80 and 443 only, and everything through one handler.
- **No project secret forwarded (setup or work): open through the handler,** recording each host per stone or per base, so the user can see where it talked.
- **Any project secret forwarded: allowlist,** in setup and in work alike: a built-in list (registries and toolchains read-only by method) plus a per-project list that names the hosts. A denial is a 403 whose body names the host and the project setting, and the brain records it on the stone.
- Web reading through pi-web-access is a brain tool (ADR 0039), so if `arms.md` keeps it routed home, an allowlist does not cut off documentation.

The user may prefer an always-on allowlist; this is a user decision below.

### Question 5: key and lifecycle

**Where records live: `cairn.sqlite`.** A base is keyed from git data only the brain has, is used only by stones brained at home, and needs to be in the same commit as a launch's recorded phase. A snapshot handle "is a plain data object" that any Durable Object can restore, so the Worker holds no state. A `Quarry` object (research 02 line 433) adds a second truth and a reconcile, and its one advantage, building while the brain is down, buys nothing here. This follows `thread_launches` and `child_workspaces`: planned in `cairn.sqlite`, then done, then repaired at boot. Research 02 itself was written for stones brained in Durable Objects.

```sql
CREATE TABLE stone_bases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  reuse_key TEXT NOT NULL,        -- lockfile hash, setup hash, setup secret versions, image digest
  base_commit TEXT NOT NULL,      -- decides what a stone fetches
  image_digest TEXT NOT NULL,
  instance TEXT NOT NULL,
  state TEXT NOT NULL,            -- building, ready, failed, retired, expired
  snapshot_id TEXT,
  snapshot_bytes INTEGER,
  builder_name TEXT NOT NULL,     -- the Workspace object that runs the build
  parent_base_id TEXT,            -- the older base it was built from, if any
  generation INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER, deadline_at INTEGER,
  last_restored_at INTEGER, restore_failures INTEGER NOT NULL DEFAULT 0,
  setup_exit INTEGER, setup_ms INTEGER, setup_log_path TEXT,
  hosts_seen TEXT, survivors TEXT, error TEXT
);
CREATE UNIQUE INDEX stone_bases_one_build ON stone_bases (project_id, reuse_key) WHERE state = 'building';
```

**The key.** The settled key is base commit, lockfile hash and image digest. Read strictly, every commit would be a rebuild, which no-delete makes expensive. So:

- **Reuse key:** the blob ids at the wanted commit of a fixed list of files (`pnpm-lock.yaml`, `package-lock.json`, `bun.lock`, `bun.lockb`, `yarn.lock`, `Cargo.lock`, `uv.lock`, `poetry.lock`, `go.sum`, `.nvmrc`, `.node-version`, `.tool-versions`, `mise.toml`), plus `.agents/setup`'s blob id, the setup-ticked secrets' version counters, and the image digest. v1 keyed the same way (`apps/server/src/sandbox/Cloud.ts:163-165`). Adding setup's hash improves on Amp, where editing setup does not invalidate.
- **Base commit:** a column. A stone at any commit with the same reuse key starts from that base and fetches `^base commit wanted`. An empty result skips the fetch; an older wanted commit is already in the history.
- **Manual invalidate:** a setup that sources another file escapes the key, so "Rebuild base" retires the row (Amp's `snapshots delete`).

**Who builds on a miss: the brain, in a dedicated builder,** never a user's stone, so a stone never captures its own state as a base. `BaseBuilder` is a brain service driving a `Workspace` object named from the base id. It is not a pi-durable task, because no conversation owns a base and no tool call is at stake; `Parked` and replay rules do not apply.

**Ten stones at once.** Each launch's base phase calls `Bases.ensure(project, commit)`, which in one transaction finds a ready row or inserts a building row. The unique index makes one winner; `ON CONFLICT DO NOTHING` puts the other nine on the same row. Waiters wait on an in-process signal plus a slow poll, so a restart loses nothing; each stone's row reads `preparing`, with why. A failure reaches all ten at once. Builds run at most 2 at a time across Cairn, and more queue (Amp's "queue, never fail"). Restores need no such limit: the blog measures 100 at once with a p99 of 1.13 s for images, though not for snapshots, which is what the spike measures.

**The build, in order:**

1. Start the image, with the egress handler in setup mode.
2. Write the bundle in chunks, clone it into `/cairn/workspace`, check out the commit detached, remove the bundle, and record the set of running process ids.
3. Run setup as a background job with its log and exit code in files, as S1 requires (`NOTES.md:50`), with `CAIRN_STONE=1` (Amp sets `AMP_ORB=1`). Its env: the trust settings and setup-ticked secrets. Poll and send the log home. A base-level alarm or the poll keeps the object active, since "code that runs inside the instance does not count as activity" ([lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)).
4. **Timeout: 20 minutes,** as Amp. v1 used 30 (`Cloud.ts:246`). No capture on a failure or timeout, also as Amp.
5. **Kill setup's leftovers:** from `container.exec` in the object, not the daemon, send `TERM` and after 2 s `KILL` to every process not in the recorded set; read `ps` again; record survivors; `sync`. `kill -1` would be simpler, but every process has root's capabilities here ([security](https://developers.cloudflare.com/sandbox/concepts/security/)), and the platform's own processes in the VM are unknown, so the set is the safe form. Amp does this too. A snapshot holds no processes anyway; the point is files being written at capture, and pid files, because the restored instance reuses process ids ([lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)).
6. Scan for setup secrets, if any; remove the job's files.
7. `snapshotContainer({ name })`, commit `id` and `size`, and then `destroy()`. A crash between the first two leaks one undeletable, unlistable snapshot; accepted.

**Boot repair:** for each `building` row, ask its builder. Job still running: reattach. Job done with no snapshot recorded: resume at step 5. Container gone: restart the build. Past its deadline: fail. The order fits `BootRepairs.ts`'s step "resume interrupted launches", just before it.

**Reuse of older bases when building.** Amp's flow starts "from a base or older snapshot" and then updates. Cairn does too when an older ready base has the same image digest: restore it, fetch, run setup. pnpm finds its store on disk and relinks in a few seconds instead of downloading. Build from the image after 10 generations, so cruft does not accumulate. Needs the spike to confirm a snapshot of a restored snapshot is fine; the guide says only that changes after a restore need a new snapshot.

**TTL and invalidation.** No age limit of Cairn's own: Amp's 72 hours keep sources fresh, and the bundle does that here. A row is `expired` 29 days after its last restore (Cloudflare's own harness's number) and on any "not found" at start, which then builds once. Two failed starts in a row skip the base and build from the image, as the Agents SDK does. Each restore updates `last_restored_at`, which is the platform's TTL too.

**When the stone image digest changes.** It is in the reuse key, so every base misses at once. The rule:

- Nothing rebuilds eagerly, since idle cost matters and most projects have no stone waiting. The next stone in a project builds, from the image, not an older base, because a snapshot can't cross images.
- Old rows go `retired`, and their snapshots keep counting toward stored bytes until their 30 days pass, since nothing can delete them.
- Running stones are untouched ("a running instance keeps the image"). A sleeping stone's snapshot is arms' case: whether it restores after a new digest deploys, and after its old image leaves the registry, is unknown, so the spike tests both, and old images stay in the registry until then. The registry holds 50 GB across the account, and images are deleted by hand.
- The image holds pi-env's daemon, and the catalog moves pi as one (`pnpm-workspace.yaml`), so a pi bump moves the digest and rebuilds every base. pi-env is at 1.5.0 on npm against the catalog's 1.4.0. Worth knowing, not worth designing around: a rebuild costs under a cent and a few minutes once per project.

**Cost against the idle target.** Under $6 a month, with Workers Paid's $5 first, leaves **$1 for everything stored**.

| Stored | Assumption | Per month |
| --- | --- | --- |
| Compute for a Cairn base build | `standard-2`, 3 min | $0.0065 per build |
| A kept-warm `standard-1`, for comparison | Always on | $27.70, so no warm pool |
| `DirectoryBackup`, newest 3 per project (v1's rule, `Cloud.ts:176-180`) | 525 MiB each, R2 | $0 inside 10 GB |
| Snapshots, one project | 20 builds a month, 3 GB each (uncompressed tree), 60 GB-months | At R2's price $0.90; at running disk's rate, which is $0.18 per GB-month, $10.90; if free in beta, $0 |
| Same, 5 builds a month at 0.6 GB (if stored compressed) | 3 GB-months | $0.05 at R2's price; $0.54 at disk's rate |

Build rate from Cairn's own history: 9 lockfile commits and 2 image commits in the 15 days to 2026-11-03, only 2 of them in the last 9 days, and a build happens only when a stone starts after one. So bases fit the target at anything near R2's price, and may not at disk's. The controls:

- `handle.size` of every unexpired row is a meter on the usage page, because Cairn's rows are the only inventory there is.
- A cap on captures per project per day (3 by default). Past it, a stone restores the nearest older base and runs setup in place, uncaptured, which is slower but stores nothing.
- A Cloudflare statement of the price would settle this. It is a question only the user can ask from the account, and the dashboard's billable usage (changelog 2026-06-04) is the check after the spike.

### Question 6: no `.agents/setup`, and what the box holds

**Amp's behaviour:** "Both files are optional" (`customizing:16`). The snapshot then holds the repo and nothing more, and the agent installs what it needs. Amp also offers to have an agent write the scripts.

**The local fact:** `find` over `~/Developer/projects` finds no `.agents/setup` or `.agents/resume` in any of the 39 repos. So this path is the common one, and v1's retrospective already concluded "zero per-project setup steps" (line 51).

| Behaviour | Result |
| --- | --- |
| Refuse | No stone runs in any repo until someone writes a script. Rejected |
| Amp's bare clone | Works, and each of ten stones then runs its own install, in parallel, with the base doing no good. Stone start passes in name only |
| **Built-in default by lockfile** | The base holds dependencies with no step asked of the user |

**Choice: a default setup when the file is absent,** run in the builder like any setup, by what is at the repo root:

| Lockfile | Default |
| --- | --- |
| `bun.lock`, `bun.lockb` | `bun install --frozen-lockfile` |
| `pnpm-lock.yaml` | `corepack enable`, then `pnpm install --frozen-lockfile` |
| `package-lock.json` | `npm ci` |
| `yarn.lock` | `corepack enable`, then `yarn install --immutable` |
| `Cargo.lock` | `cargo fetch` |
| `uv.lock` | `uv sync --frozen` |
| None of them | Nothing: a bare clone |

The present file always wins, and behaves verbatim. A failed default still captures the clean clone, with a notice carrying its log, so the agent can sort it out; a failed real `.agents/setup` does not capture. The default never writes to the repo.

**Line against phase 4.** The kickoff puts "Set up verification" there and says to "prove the setup in a fresh stone" (lines 211-212). Research 06 line 178 says the environment flow "can share a run" with it.

- **Phase 3:** the default table, a real `.agents/setup` for Cairn itself and one Bun repo, the setup log on the base's record, and Rebuild base. An ordinary thread can already write `.agents/setup` and commit it, and the next stone tests it, because the key moves.
- **Phase 4:** the flow where an agent writes `.agents/setup` and `.cairn/verify/`, proves them in a fresh stone, plants defects. Browser journeys belong here too.

Phase 3 proves only that a stone can run a browser, because phase 4 depends on it and it shapes the image.

**Can Cairn run in a stone.** Measured on a fresh clone with an empty `HOME`, under cgroup limits shaped like the instance types, on the Beelink's faster and possibly better-cached hardware:

| Measure | `standard-1` (1/2 vCPU, 4 GiB) | `standard-2` (1, 6 GiB) | `standard-3` (2, 8 GiB) | `standard-4` (4, 12 GiB) |
| --- | --- | --- | --- | --- |
| `pnpm install`, empty store, full download | 68 s | 30.6 s | Not run | 10.6 s |
| Disk after install | 2.5 GiB of 8 GB | Fits | Fits | Fits |
| `pnpm test` (Node 26, 300 files: 2,668 pass, 4 skip) | 821 s; 2 fail, both a conformance mutation check's timeout | 725 s, all pass | 641 s, all pass | About 270 s (timed on Node 24, below) |
| `pnpm check` (format, lint, typecheck, test) | Not run | Not run | Not run | **456 s, ok,** against about 7 minutes unlimited |
| Peak memory including page cache (cgroup) | Not read | Not read | 2.3 GiB, tests | 5.0 GiB, check |
| List price per `pnpm check` at these times, doubled for a slower CPU | Not run | Not run | About $0.09 | About $0.10 |

The suite is mostly waiting, not computing: going from four cores to half of one only takes the tests from about 270 s to 821 s. Half a core is where timing starts to fail: the same two mutation checks in `Conformance.test.ts` time out there, though nothing fails at one core. So `standard-3` or `standard-4` suits `pnpm check`, and `standard-1` suits a stone that runs parts of it. The Beelink's cores are likely faster than a Cloudflare vCPU, so the margin is unknown until the spike.

Findings about the repo itself:

- **Node.** `package.json:47-48` declares Node 26.11 or newer; the image has 24. On Node 24.22.2 at four cores, pnpm only warns, and 3 of 2,672 fail: `ResultTool.test.ts`'s very deep schema overflows the stack, and the two `Conformance.test.ts` mutation checks hit their timeout. Those two also fail on Node 26 at half a core, so they may be speed rather than version; the stack overflow is the version. The brain itself runs on 26, so a stone that judges Cairn should too.
- **Tests assume few host tools.** With `HOME` empty, all pass, so nothing reads `~/.pi/agent` or a login. With `PATH` cut to about what the image holds (no systemd, Caddy, porch, Tailscale, Docker, Chromium or curl), 31 of 2,672 fail in 8 files, for four reasons only: `flock` (24 of them; Debian's `util-linux` has it, and my cut `PATH` did not), `rg` and `fd` (pi's coding tools and file search), and `sqlite3` (`ops/cairn/pi-bump-guard.sh`). So `pnpm check` needs `rg`, `fd` and `sqlite3` added.
- **Long work.** `pnpm check` must run as a background job, because an eviction ends the foreground command (S1 `NOTES.md:50`), and the object must be kept active. That is arms' job pattern.
- **No native build tools needed.** `onlyBuiltDependencies` is only `lefthook` and `workerd` (`pnpm-workspace.yaml:55-57`), both prebuilt. `prepare` runs `effect-tsgo patch` and `lefthook install`, both local.

**A browser-driven judge.** Cairn's judges drive `playwright`'s `chromium.launch()` (`judges/behaviour.ts:1539`), and `judges/typing.ts:21` says WebKit runs against the MacBook because it cannot start on this OS, so WebKit stays home. Chromium in a container is untested: it needs fonts, `/dev/shm` and a decision on `--no-sandbox`, and it will not trust the egress CA for external pages, though `localhost` is enough for a judge. Cloudflare Browser Run costs $0.09 an hour and cannot see the container's `localhost` without a portal, so the image route is simpler. The spike runs one judge.

**What the image needs,** beyond today's Node 24, git, `ca-certificates`, `procps`, the shim and pi-env's daemon (`images/stone/Dockerfile:18-27`), from what the 39 repos use: 20 Bun, 9 npm, 5 pnpm, 1 Rust, none Go or Python; 3 declare Node 26.

| Add | Why |
| --- | --- |
| `corepack` with pnpm and yarn enabled | Amp's own setup example calls `corepack enable`. Node 24 ships it; Node 25 and later do not (from memory), so the image installs it for 26. Corepack downloads a project's pinned version, so baking the current one saves a fetch |
| Bun | The majority of repos |
| Node 26 beside 24, chosen by `.nvmrc`, `engines` or `.node-version` through a small shim | Cairn and two others |
| `sudo`, without a password | Amp's contract lets setup `sudo apt-get`. It costs no security, since every process already has root's capabilities |
| `build-essential`, `python3`, `uv` | `node-gyp` and Python tools. `apt` in a setup would work too, but this is common enough to bake |
| `ripgrep`, `fd-find` (with an `fd` link, since Debian names it `fdfind`), `sqlite3`, `jq`, `zstd`, `unzip`, `tmux` | Cairn's coding tools call `rg` and `fd` by name, so **every stone needs these two** (`arms.md`, too). The rest are Cairn's tests, agents and Amp's list |
| Chromium with fonts | Phase 4's verifier needs it everywhere, and a per-project `apt` install adds minutes to every build. The spike can veto it on cold start |

**One generic image,** as ADR 0005 and the kickoff say. Anything rarer is setup's job, and a snapshot keeps it. A second image means a second digest, a second set of bases and a question at launch for nothing. Estimated size is about 1.2 GB with Chromium, unmeasured (about 300 MB without). It fits every instance's disk from `basic` up, and the registry's 50 GB.

Also change `HOME` from `/tmp` (`Dockerfile:30`) to `/home/node`, since a persistent home is conventional for tool caches and whether `/tmp` survives a snapshot is unverified. Every stone keeps `/cairn/workspace` as its path, as pnpm requires (v1 spike 8, `NOTES.md:45`).

**Default instance.** `standard-1` for a stone, as S1 ran. A project's setting can raise it for both its stones and its builder.

Cloudflare's own alternative is worth knowing: `cloudflare/debian-trixie` is a managed image distributed before requests arrive, and the Agents SDK adds its setup at run time and snapshots. It would avoid an image build, and maybe the cold first start. But Cairn's key and pins want a digest it controls, and the image route is settled. If the spike shows cold image starts dominate, bring this back to the user.

### What I need from the sibling notes

**From arms:**

- `Workspace` RPCs that accept `{ image } | { containerSnapshot }`, `instance`, labels, and the entrypoint; `snapshot(name)`, `exec` for the sweep, and the egress handler registered with props on every start.
- Its job pattern for setup, and which object keeps it alive.
- The launch phases: this note adds "base" and "seed" before the first message, each idempotent, in `thread_launches`.
- `Arms` extended so `shellEnv` carries trust settings and the stone's secrets, and output passes through redaction.
- A brain tool for newer commits, because a stone has no remote.
- The decision on sleep: snapshot, or bundle home on a base.

**From results:** the stone's `base_commit`, recorded here on its row; whether R2 is on the path at all; and confirmation that a bundle from a stone is opened at home without running its hooks.

**From surfaces:** the project settings section (secrets, egress list and seen hosts, Rebuild base, instance); the row's preparing reason with elapsed time; the setup log view; the notices named here; stored base bytes and unknown price on the usage page; and the secret request card, later.

### Probes

All on 2026-11-04 on the Beelink (16 threads, btrfs NVMe, warm page cache, Node 26.11.1), on fresh clones of `a160935` in a scratch folder removed afterwards, each command under `systemd-run --user --scope -p CPUQuota -p MemoryMax` shaped like an instance type: 50% and 4 GiB, 100% and 6 GiB, 200% and 8 GiB, 400% and 12 GiB. pnpm with an empty store and `--package-import-method=hardlink`, as a filesystem with no reflinks would have it. Neither Cloudflare nor the repo was touched.

| Probe | Result |
| --- | --- |
| Install at 50%, 100%, 400% | 68 s, 30.6 s, 10.6 s (network from home, not from Cloudflare) |
| `tar` and `zstd -3 -T1` of the workspace at 50% | 18.6 s, 550,206,288 bytes |
| Extract it at 50%, 100%, 200%, 400% | 12.6 s, 6.5 s, 7.7 s, 5.0 s. `zstd` and `tar` barely use a second core, and these runs had a test suite beside them |
| Source and `.git` without `node_modules`, `tar` and `zstd` | 34,130,595 bytes |
| Full bundle of `main`, then clone from it at 50% | 30,427,673 bytes, 0.75 s; clone 0.93 s, 49 MB on disk |
| Depth 1 bundle from a shallow bare clone | 4.5 MB, exit 0 |
| Delta bundle, 1 and 20 commits | 1,227 bytes in 4 ms; 411,119 bytes in 69 ms |
| At 50%: `git status`, `git fetch` of the delta, `git switch -c`, `git status` | 30 ms, 20 ms, 40 ms, 30 ms |
| At 50%: import `effect` in Node, walk `node_modules`, `pnpm install --offline --frozen-lockfile` | 340 ms, 420 ms, 5.65 s |
| `pnpm test` with the cut `PATH`, at 400% | 408 s; 31 failed, 2,633 passed, 8 skipped |

## Judges

Costs are worst case with no allowance left; Workers Paid's included usage likely covers them.

| # | Judge | Measures | Broken control | Cost |
| --- | --- | --- | --- | --- |
| 1 | **Stone start** (`judges/stone-start.ts`) | A scripted model's first `bash` on a new stone from a prepared base of Cairn, on a deployed dev stage. 20 sequential, and ten at once, with a 24 h unused case; p95 under 5 s; every phase timed from the events log. Clock from the launch command to the exec on the container | Same run on a base whose `.agents/resume` sleeps 6 s must fail. A second control restores a `DirectoryBackup` instead, and must also fail | About $0.05 |
| 2 | **One build for ten** (`judges/base-single-flight.ts`) | Ten launches on a miss, plus a `kill -9` of the brain mid setup: setup's marker file on the Beelink counts one run; ten stones name one snapshot id | Drop the unique index in a judge build: two or more runs, fails | About $0.03 |
| 3 | **Key table** (test in `pnpm check`) | Lockfile, setup, secret version and digest each miss; a new commit with those unchanged hits, with the right delta; expired and not-found rebuild once | A key function returning a constant fails every row | Free |
| 4 | **Leftovers** | A fixture setup leaves `nohup`, `setsid`, double-fork and a pid file. After restore, `ps` shows only the boot set; the base row records what was killed | Skip the sweep: judge finds a survivor recorded, and fails | About $0.01 |
| 5 | **No credential in the cloud** | v1's scan: every process env and every file changed since the image, pulled home and grepped for every value the brain holds. Plus the Worker's secrets by name, and `git config`: no token, no remote | Plant a fake value in the fixture's `.git/config`: fails | About $0.01 |
| 6 | **Project secret path** | A canary: reaches setup when ticked, is on no disk in a restored stone, is absent from the transcript and setup log, reaches `resume` | Setup writes it to a file: capture refused. Redaction off: canary in the transcript, fails | About $0.01 |
| 7 | **Egress matrix** | Each tool in the image (git, npm, pnpm, bun, pip, uv, cargo, curl, Node `fetch`, Chromium) against an allowed and a denied host under both modes; `nc` to 5432 fails; hosts recorded | A denied host that answers 200, or a handler that returns early, fails | About $0.02 |
| 8 | **Image bump** | Deploy a new digest to the dev stage: the next stone misses and builds from the image, old rows retire, a running stone keeps going | A key without the digest would try the old snapshot: the stone's label does not match, and it fails | One Actions build, about $0.02 |
| 9 | **Restore fidelity** | Hard links, symlinks, modes and mtimes; `git status` clean; `pnpm install --offline --frozen-lockfile` is a no-op; HTTPS works with the new CA | Touch a file before capture without committing: `git status` must show it | About $0.01 |
| 10 | **Stored bytes and idle** (with `surfaces.md`'s idle cost judge) | With no stones, no container runs and the meter equals the sum of unexpired `size`; the user checks the bill after a month | Leave a stone running: the instance list is not empty, fails | Free |
| 11 | **Cairn in a stone** | `.agents/setup` then `pnpm check` on `standard-4`: exit 0 and the test count, with time and cost | A branch with a failing test must exit non-zero | About $0.10 |
| 12 | **Browser in a stone** | `judges/dev-smoke.ts`, Chromium headless against a server in the stone; a non-blank screenshot | A wrong expected title fails | About $0.02 |
| 13 | **Default setup** | One repo per lockfile kind in the table: base ready, dependencies present. An unsupported one: bare clone and a notice | A corrupt lockfile: default fails, base holds the clean clone, notice | About $0.03 |

## Not verified

- **No snapshot has been made or restored by anyone in this project.** All restore numbers are unknown, and the plan depends on them. Spike 11 comes first.
- The probes ran on the Beelink's btrfs NVMe with warm page caches and a far faster CPU than a share of a Cloudflare host. They bound `DirectoryBackup` from below and say little about snapshots.
- Unverified platform behaviour: whether snapshots are stored whole or compressed; whether they restore on a different size; whether `/tmp` survives; whether a snapshot restores after its image digest is replaced or deleted; whether a host outside the builder's location is slower; whether Chromium runs; whether the CA path survives a restore. Each is in the spike.
- The Workers request body limit in the Question 3 table is from memory.
- Amp's behaviour is from its docs, not from running an orb. Research 06's "outbound is open" is carried over; the current docs I read neither confirm nor deny it.
- I read `@cloudflare/sandbox` at 1.0.0 source and 1.0.3's changelog, not 1.0.3's source. The docs' example still names shim tag 1.0.1, and tag 1.0.3 on Docker Hub was not checked.
- Lockfile rate comes from one busy fortnight of one repo. The image size is an estimate.
- The cut `PATH` test is an approximation: absolute paths and git's own exec path escape it, and its files were still on a full Arch system. It lists what is missing by name, and the spike's real image is the check.
- Counts of the user's repos cover `~/Developer/projects`, not any repo elsewhere, and `.env` and `.npmrc` were counted or checked for keys and hosts, with no values read or printed.

## Risks

- **Restores are slow when cold.** The target then fails for the case that matters, a first stone after a quiet day. Spike part A finds this first. There is no cheap fallback, because a warm pool is $27.70 a month and `DirectoryBackup` is slower, so this goes to the user with numbers.
- **Cloudflare prices snapshots high, or changes the beta API.** The meter shows the bytes, the capture cap limits them, and setup in place keeps stones working. No Cairn data lives only in a base, so bases are always disposable.
- **A setup writes a secret in a form the scan misses.** A base could carry an encoded value to every stone. No secret reaches setup by default, and the egress allowlist applies once one does.
- **Redaction misses a transformed value.** Accepted and stated in the settings page; the model and the transcript could then see it. It stays on the Beelink's own store, but a stone's process could send it to an allowed host.
- **The open mode lets a dependency send source away.** Accepted by decision 4 when the user agrees, and the seen-hosts record shows it afterwards. A private repo the user worries about can be given the allowlist.
- **Leaked snapshots.** A crash at capture leaves one undeletable and unlistable until it expires. Bounded by crash frequency.
- **Default setup guesses wrong.** Failure leaves a usable clone and a notice; the cost is one build and one stone's confusion.
- **A pi bump rebuilds every base.** Cheap, and it keeps old snapshots stored for 30 days. Grouping pi bumps limits it.
- **Egress through the handler breaks a tool quietly.** Judge 7 covers the image's tools, and a project's unusual tool shows up as a TLS error in setup's log. Stated in the setup failure notice.

## Recommended design

One choice per question.

1. **A base is a container snapshot.** A miss or expiry runs setup; `DirectoryBackup` carries no base. Gated by spike 11 (ADR status proposed).
2. **Stone start:** restore, register egress, hello, delta bundle, `git switch -c`, resume with a 10 s cap. Everything but the restore fits in about 1.2 s; the restore and its first reads get the other 3.8 s. No warm pool.
3. **Code comes as a git bundle over the link,** full branch history; depth 1 above 200 MiB. No GitHub credential on Cloudflare in any form. Project secrets: names and values in project settings, delivered per process, scanned before capture, redacted at the brain. Registry tokens wait for a home gate when a project needs one.
4. **Egress follows what the stone holds:** `enableInternet: false` always; open and logged with no secret; allowlist once any secret is forwarded.
5. **Records in `cairn.sqlite`, the brain builds, in a dedicated builder,** with a unique index for single flight, a 20 minute limit, a process sweep before capture, reuse across commits by lockfile, setup and digest, expiry 29 days after last restore, and lazy rebuilds when the digest moves.
6. **No `.agents/setup` gets a default by lockfile.** The agent that writes and proves one is phase 4. One generic image, with Bun, Node 24 and 26, corepack, sudo, build tools and Chromium.
7. **Judges** as listed, with Stone start and the single-flight run as the phase gate's pieces from this area.

## Proposed ADRs

1. **Bases are container snapshots, keyed for reuse across commits** (proposed, gate: spike 11). A base is a `snapshotContainer` handle in `cairn.sqlite`, reused by lockfile hash, setup hash and image digest, with the base commit deciding what a stone fetches.
2. **Code reaches a stone as a git bundle over the link** (to accept on the user's word). No git credential exists on Cloudflare, not in a container and not in a Worker secret.
3. **A project secret is the one value that leaves the Beelink, by the user's choice** (to accept on the user's word). Names and values live in `cairn.sqlite`, reach processes only by environment, are refused at capture if found on disk, and are redacted at the brain; every other credential stays home.
4. **A stone's egress follows what it holds** (proposed, gate: egress matrix). Every stone runs with `enableInternet: false` behind one handler, open and logged with no secret, and on an allowlist once any secret is forwarded.
5. **The brain builds bases, and no `Quarry` object exists** (to accept on the user's word, amending research 02 section 3.1). The builder is a brain service with a boot repair, and the Worker keeps no base state.
6. **One stone image holds the toolchains and a browser** (proposed, gate: spike 11's cold start comparison). Amends ADR 0005's "one generic base image" with its contents, and a missing `.agents/setup` gets a default by lockfile.

New glossary terms when these settle: **Base** (replacing "prepared base" in Stone), **Reuse key**, **Builder**, **Project secret**, **Seen hosts**, and, if built, **Home gate**.

## User decisions

1. **Build on snapshots, with an unpublished price, no delete and public beta status?** Recommend yes, because nothing else can meet Stone start for a real project, with the meter and capture cap as the control. If you can, ask Cloudflare for the price. Without snapshots, the target must be relaxed for large projects, and that would come back to you with the measured bottleneck.
2. **Is "keyed by base commit" allowed to mean reuse across commits?** Recommend yes: the commit decides the fetch, and the other parts decide reuse. Strict keying means a rebuild and an undeletable snapshot per commit.
3. **Does a project secret break "credentials never leave the Beelink"?** Recommend treating it as a named exception by your own choice, with none forwarded by default. The strict alternative is no project secrets until a home gate exists, so dev servers needing real keys can't run in stones.
4. **Egress?** Recommend following what the stone holds. Always-allowlist is safer and stalls runs on 403s, plus a step per project. Always-open is simplest and exposes forwarded secrets to any dependency.
5. **A project with no `.agents/setup`?** Recommend the default by lockfile. Amp's bare clone is purer and makes ten stones each install. A refusal stops all 39 repos today.
6. **A failed real `.agents/setup`?** Recommend holding stones in a workflow, and offering one interactive stone "Start anyway" on a bare clone. Amp always continues, which can burn ten stones' tokens on a broken environment.
7. **Chromium in the image?** Recommend yes unless the spike shows a cold start penalty over 1 s. Otherwise setup installs it per project.
8. **The home gate?** Recommend not building it in phase 3, since no project needs it. The cost is that a private registry fails setup with a clear 401 until then.
9. **Which projects prove the targets?** Recommend Cairn for Stone start, since it is the hard case, plus one small Bun repo. Whether the fan-out target runs on Cairn itself depends on the `pnpm check` time above and is shared with `results.md`.

## Measured spikes

`spikes/11-bases/`, on a throwaway stack like S1's, with `NOTES.md` under the usual rules. It reuses S1's Worker, object and relay, and needs a new image build in Actions.

| Part | Measures | Gate |
| --- | --- | --- |
| A. Restore | The five items under Question 2, plus `handle.size` against `du`, and a snapshot of a restored snapshot (size and generation) | Launch to first tool call p95 under 5 s on `standard-1` with Cairn's tree, warm, 24 h unused and ten at once. **Failing means showing the user the bottleneck before anything else** |
| B. Lifetimes | Restore after a new digest deploys, and after its old image is deleted; restore on another size; `/tmp`; a stale id's error; the CA after restore | Each answered. Sets the instance's place in the key, and arms' sleep decision |
| C. Capture | The process sweep against a fixture with `setsid`, double fork, and a root process; whether the exec path survives it | No survivor, and the container still answers |
| D. Egress | The matrix in judge 7 under both modes; large downloads through the handler | Every tool in the image works or has a stated fix, and denied hosts are denied |
| E. Cairn | `.agents/setup` and `pnpm check` on `standard-3` and `standard-4`, peak memory; `judges/dev-smoke.ts` with Chromium; lean against full image cold starts | `pnpm check` exits 0 on `standard-4` within 20 min, under $0.25 a run. A cold start penalty over 1 s vetoes Chromium in the image |
| F. Billing | The dashboard's billable usage 48 h after the snapshots exist | A number for snapshot storage, or a recorded "not billed" |

Estimated cost: under $1 of compute if the included usage is gone, likely nothing. Worst-case parts: 40 restores on `standard-1` at about a minute each, $0.05; 6 builds, $0.05; three `pnpm check` runs, $0.30; the rest, $0.05. **Snapshots can't be deleted:** keep to at most 10 at about 3 GB. Stored for their 30 days, that costs an unknown amount: $0.45 at R2's rate, $5.40 at running disk's rate. That risk is the one thing to approve before running it.

## Packages for the plan

| Package | What | Depends on | Judge |
| --- | --- | --- | --- |
| B0 Spike 11 | Parts A to F | S1's code; user's approval of decision 1's risk | Its gates |
| B1 Stone image | Dockerfile additions, Node selection, `HOME`, trust settings at entrypoint; digest published to the stack | B0's verdict on Chromium | Judges 7, 12 |
| B2 Records and key | `stone_bases` migration, pure `BaseKey.ts`, `Bases.ensure` with single flight | None | Judge 3 |
| B3 Worker side | `Workspace` start from snapshot, capture, sweep, egress handler with props, seen hosts | `arms.md`'s `Workspace` | Judges 4, 7, 9 |
| B4 Builder | `BaseBuilder.ts`: bundle, clone, job, timeout, sweep, scan, capture, older-base reuse, capture cap, boot repair | B2, B3, arms' job pattern | Judges 2, 4 |
| B5 Start path | The launch phases, delta, branch, resume with its cap, expiry and failure skip | B2, B3, B4, `arms.md`'s launch | Judges 1, 8 |
| B6 Project secrets | Store, settings RPCs, delivery by `shellEnv`, redaction wrapper, scan before capture | B4, `surfaces.md`'s settings | Judges 5, 6 |
| B7 Egress policy | Modes, built-in list, project list, denial notice | B3, B6 | Judge 7 |
| B8 Default setup and real setups | The lockfile table; `.agents/setup` for Cairn and a Bun repo | B4 | Judges 11, 13 |
| B9 Meters | Stored bytes and base events for the usage page | B2, `surfaces.md` | Judge 10 |
| B10 Gate run | Stone start on Cairn, ten at once, cold, on the dev stage, with the user | B1 to B8 | Judges 1, 2, 11 |
| B11 Home gate (only on demand) | Forwarding chosen hosts over the link, the home-side rule list, placeholder swap | B3 | Its own: a token that never appears in the container scan, and a host outside the rule list refused |

Suggested order: B0 first and alone, since it can change everything below. Then B2 and B1 in parallel, then B3, then B4 and B5, then B6 to B9 in parallel, and B10 last. B2 and the pure key can begin before B0 ends, as they do not depend on its answer.
