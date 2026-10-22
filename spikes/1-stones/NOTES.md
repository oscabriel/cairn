# Spike 1: stones brained at home, arms on Cloudflare

Result: **passed.**
- **Conformance.** pi-durable's env conformance suite passes 29 of 29 against a deployed container, driven from the Beelink.
- **Latency.** Exec round trip from the Beelink: p50 37 ms, p95 49 ms (gate: p50 at most 150 ms).
- **Eviction.** Evicting the Durable Object mid-turn never reran an unsafe tool, and the turn finished on the same container (3 runs of 3 cases).
- **No local Docker.** GitHub Actions built the image and pushed it to Cloudflare's registry; the stack deployed it by digest.

Run on 2026-10-21 from the Beelink. Alchemy 2.0.0-beta.83 (default profile), `@cloudflare/sandbox` 1.0.2 (image `cloudflare/sandbox:1.0.2` for its shim), pi-env, pi-durable, chord and pi-ai 1.3.0, Node 26.11.1. Compatibility date 2026-10-01 with `nodejs_compat`. Containers on `standard-1`, which reported 1 CPU, 4.2 GB and kernel `6.18.54-cloudflare-microvm`. The Beelink reaches Cloudflare at the Portland edge (`colo=PDX`).

## Shape

v1's Phase 6 had already built this path (cairn-v1 `apps/cloud-sandbox`). The spike ports it, cut down, under v2's rules.

- **Brain.** `brain.ts` runs a pi-durable conversation whose `HarnessOptions.env` returns pi-env's `RemoteExecutionEnv`. The tool is pi-durable's own `bash` (`replay: "unsafe"`, the default), driven by a scripted model.
- **The link.** pi-env's `Connection` spawns `relay/pipe.ts` where a home sandbox would spawn `docker exec`. The relay dials `wss://cairn-s1-stones.oscargabriel.workers.dev/pipe/<id>` with the Access service token and a shared secret, both read from a 0600 file, never from an argument.
- **Worker.** It checks Access's JWT and the secret again, then hands the socket to the stone's `Workspace` Durable Object. The object runs pi-env's static daemon with `ctx.container.exec`, and pumps its stdin and stdout through the socket (`src/pump.ts`, `src/frame.ts`).
- **No new class.** "ContainerExecutionEnv" in ADR 0010 turns out to be `RemoteExecutionEnv` plus this relay, because pi-env's `Connection` takes any command as its transport.
- **Image.** The container runs `images/stone`: Node 24 bookworm-slim, git, the Sandbox SDK's shim, and pi-env's daemon (sha256 checked).
  - `.github/workflows/stone-image.yml` asks Cloudflare's API for registry push credentials with the `cairn-ci` token, then builds and pushes. It took 40 s.
  - Alchemy deploys a `registry.cloudflare.com/...@sha256:` reference "pre-pushed", with no pull or push. Preparing the image took 39 s on the first deploy. `docker images` on the Beelink has no stone image.
- **No `instance_type`.** The plan showed none beside `schedulingPolicy: durable_object` (research 02's Q9 risk); the size goes to `start()`.

## Numbers

| Measure, from the Beelink | Result |
| --- | --- |
| Conformance suite (`registerEnvConformance`, `listFiles` on) | **29 of 29**, 11.6 s of tests, 13 s with vitest |
| `exec(["true"])`, 200 runs over the open link | **p50 36.8 ms**, p95 48.6 ms, max 182 ms |
| `exec("true")` through the shell, 200 runs | p50 39.2 ms, p95 54.7 ms |
| `fileInfo`, 200 runs | p50 33.1 ms, p95 43.1 ms |
| One HTTPS control call (status), 30 runs | p50 66 ms, p95 101 ms |
| 10 MB write / read | 666 ms / 737 ms (15 / 14 MB/s) |
| 4 KB write / read | p50 36 ms / 96 ms (`readTextFile` takes three round trips) |
| New stone, `start` to first exec (5 stones) | **1.0 to 1.2 s** (start 0.6 to 0.9 s, first exec and daemon hello 0.33 to 0.5 s) |
| The very first start after deploying the image | 10.7 s |

## Eviction (`judge.ts`, three runs)

Each run makes a new stone and runs three cases through `brain.ts`. "Evict" calls `ctx.abort()` in the `Workspace` object. That throws its instance away as a platform eviction does, and the judge sees a new instance afterwards.

| Case | What happened | Turn finished after the hit |
| --- | --- | --- |
| **inflight**: evicted while `bash` ran `mark; sleep 20; mark` | The tool returned `pi-env connection lost` as an error and was not rerun: one start mark, no end mark. The next `bash` reached the same container (same boot id, the mark file there). | 0.47 to 0.56 s |
| **between**: evicted while the turn was in a tool that doesn't use the stone | The next `bash` reconnected on its own and ran on the same container. | the 8 s pause's remainder |
| **brainkill**: `kill -9` of the brain while `bash` ran, then a restart | pi-durable reported `Tool bash was interrupted and may have partially run` and did not rerun it: one start mark. The resumed turn's next `bash` ran on the same container. | 1.5 to 1.7 s |

No relay process was left behind after any run.

**The foreground command dies with the instance.** The eviction ended the daemon's `exec`, and with it the `sleep 20`: no case got its end mark. A process the command had put in the background outlived the eviction: both `nohup ... &` and `setsid nohup ... &` wrote their file 25 s later. So a stone's long build or dev server must run in the background with its output to a file, polled by a tool that can reattach. That is S3's job pattern, and the Sandbox SDK's `TASK_SCRIPT` example does the same.

**The container outlives the object.** After every eviction the new instance found `ctx.container.running` and the same boot id. Research 02's open question 1 is answered: a Durable Object's container survives the object being evicted.

## Access

- No headers: 403 from Access.
- The service token without the shared secret, or with a wrong one: 401 from the Worker.
- The secret without the service token: 403.
- Version preview URLs are off, so no other hostname bypasses Access.

## `@cloudflare/computer` 0.6.0

0.6.0 (released 2026-10-20) replaced the 0.5.1 the plan named. It is a SQLite filesystem in a Durable Object (stable), with pluggable backends:

- **The worker shell can't be deployed.** It is just-bash in a Dynamic Worker, it needs the `experimental` compatibility flag, and Cloudflare refused the deploy ("experimental and cannot yet be used in Workers deployed to Cloudflare"). Its own description says it "cannot run npm, node, python, or binaries outside its built-in command set".
- **The JavaScript backend runs ES modules, not a shell.**
- **The container backend is experimental.** It needs the `computerd` image from ghcr.io and works through FUSE.

So computer has no deployable shell to be a stone's arms. Its stable filesystem, measured from the Beelink the same way (one HTTPS request per call, Worker then Durable Object):

| 4 KB files | computer | stone over the link |
| --- | --- | --- |
| write | p50 138 ms, p95 274 ms | p50 36 ms, p95 55 ms |
| read | p50 97 ms (20 ms of it inside the Worker) | p50 96 ms |
| grep across 100 files | p50 263 ms | p50 47 ms (`grep -rl` in the container) |

**Decision:** not the arms for stones brained at home. Computer fits an agent brained in its own Durable Object, which Cairn doesn't do (ADR 0010). Revisit if its container backend becomes stable and a stone ever wants durable files without a container.

## Decisions

- **Stones are brained at home.** ADR 0010 is accepted, and its fallback isn't needed.
- **Arms are pi-env's daemon behind the relay.** Cairn writes no ExecutionEnv of its own; the work is the relay, the Worker and the object.
- **Long work in a stone runs in the background.** An eviction (research 02 counts one or two a day from Cloudflare's own deploys) ends the foreground command and reports it to the model as lost, never reruns it.
- **The stone image is built only in Actions** and deployed by digest. Base storage (snapshot or `DirectoryBackup`) stays with Phase 3; S1 didn't need it.

## Noticed

- pi-durable 1.4.0 and pi-env 1.4.0 were published on 2026-10-21, during this spike. Cairn stays on 1.3.0 (decision 1.9) until Phase 1 decides; 1.4.0 may bring the durable sleep that S3 and S4 worked around.
- `readTextFile` costs about three link round trips (96 ms) where `writeFile` costs one (36 ms). A read tool that batches would help on the link; it doesn't matter at home.
- Cloudflare's bot rules answer Python's default `urllib` user agent with 403 before Access or the Worker sees it.
- The first start of a new image took 10.7 s; every later new stone took about 1 s.

## Files

- `alchemy.run.ts`, `deploy.sh`: the throwaway stack `CairnS1` (Worker `cairn-s1-stones`, the Access application, policy and service token). `./deploy.sh destroy` removes it.
- `src/`: the Worker (`worker.ts`), the `Workspace` object (`workspace.ts`), the relay's cloud side (`pump.ts`, `frame.ts`, `auth.ts`, `access-jwt.ts`, from v1), and the computer evaluation (`computer.ts`).
- `relay/pipe.ts`: the Beelink's end of the relay, from v1. `stone.ts`: the env and the control routes.
- `conformance.test.ts`, `bench.ts`, `coldstart.ts`, `computer-bench.ts`, `brain.ts`, `judge.ts`: the measurements.
- `runs/` (ignored): `stone-image.txt`, deploy logs, `conformance.log`, `bench.json`, `computer-bench.json`, and each judge run's `verdicts.json` and events.
- Kept: `images/stone/Dockerfile` and `.github/workflows/stone-image.yml`.

## Rerun on pi 1.4.0 (2026-10-22)

pi-durable, pi-env, chord and pi-ai 1.4.0, and a stone image rebuilt in Actions with pi-env 1.4.0's daemon (a new sha256, `46dde0e2...`, although its changelog is empty). The stack was deployed, measured and destroyed again.

| Measure | 1.3.0 | 1.4.0 |
| --- | --- | --- |
| Conformance | 29 of 29 | 29 of 29 |
| `exec(["true"])` p50 | 36.8 ms (via PDX) | 22.6 ms (via SEA) |
| Eviction judge | 3 cases pass, 3 runs | 3 cases pass; turn done 0.54 s after an eviction mid-command |

The edge changed between runs, so the latency difference is the route, not pi.
