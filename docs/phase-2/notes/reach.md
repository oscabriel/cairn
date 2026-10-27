# Phase 2 notes: reach (artifacts, portals and the pi tools host)

Scope: the two kickoff phase 2 items "Artifacts and Beelink portals through porch" and "A tools-only host for the user's existing pi TUI extensions (`pi-web-access`, `pi-fff`)", and the phase 2 gate line "an agent publishes an artifact and opens a dev-server portal, and both load on the phone". Written 2026-10-27. Everything about porch is read from `~/Developer/projects/porchlight` at `5334351` (one uncommitted change: a file-mode flip on `cli.ts`). The live Caddy, `~/.pi/agent` and the pi packages were read in place and never written. Probes are under `/tmp/reach-probe/` and described in "Probes" so they can be rerun.

## Summary

1. **The kickoff's premise about porch is stale.** Decision 6 says to "finish porch's admin-API reload path so no step needs sudo". That path (commit `900eacc`, Caddy's admin API on a unix socket) was deleted by porch's own "inversion" of 2026-10-02: porch now writes a snippet the user's Caddyfile imports and runs a configured reload command, and its `AGENTS.md` forbids calling the admin API to change anything. Nothing needs finishing there.
2. **No step needs sudo, because the user is in the `docker` group.** `sudo -n true` asks for a password, but `docker exec caddy caddy validate --config /etc/caddy/Caddyfile` answers "Valid configuration" in 0.10 s, and `ops/cairn/caddy-route.sh` already reloads the live Caddy that way. porch's `init` even guesses this exact command. Reload is `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`.
3. **Nothing of porch is installed on the Beelink.** No `porch` or `caddy` on PATH, no `~/.config/porchlight`, no `import` line in the live Caddyfile (which is the Docker one at `~/caddy/conf/Caddyfile`, Caddy 2.11.2), contrary to the design record's "cut over 2026-10-02". The Docker container never retired.
4. **Cairn calls the porch CLI; it does not import porch.** porch is Bun-only (`Bun.file`, `Bun.spawn`, `Bun.serve`, `Bun.CryptoHasher`), has no library entry (`bin` only, `cli.ts` runs a top-level `await run()`), and costs 29 ms a call as a script or 25 ms as an 81.6 MB `bun build --compile` binary. The brain wraps `porch --json` in a typed `PorchClient`. This answers research 08's open question.
5. **Four porch changes are needed first, all small and in the porchlight repo:** a `porch lease` command (the core's `lease` has no CLI entry except the foreground `porch run`), a refusal to overwrite files porch did not publish (measured data loss, below), a `guard` setting that puts the owner check in front of every handle it renders, and `Cache-Control: no-cache` on the artifacts porch (the live `plans` handle sends it; porch's does not). A fifth, `porch unpublish`, is needed for revoking.
6. **A Caddy reload cuts every open WebSocket.** Measured on Caddy 2.11.6: an upgraded connection closed in the same millisecond as `caddy reload`; with `stream_close_delay 30s` it stayed up. Every portal open or close reloads Caddy, so each would drop Cairn's own `/ws`, t3code's and Home Assistant's. A wizard step adds `stream_close_delay` to the live reverse proxies. Artifact republish needs no reload.
7. **Artifacts and portals must not be open to the whole tailnet.** porch renders plain handles with no identity check, and the tailnet is shared with friends and family. `/_cairn/auth` is host-independent (`Identity.ts:234`), so Caddy's `forward_auth` already works on any host. porch's `guard` setting imports an owner-only snippet into each handle. Open question 2 asks whether `plans.gneiss.run` as a whole becomes owner-only.
8. **Two ways to destroy things on first contact, both measured.** `porch import caddy` against the live Caddyfile crashes on the `{dev_port}` placeholder, and on a smaller file it silently renders Cairn's route as a bare `reverse_proxy 127.0.0.1:3774`, dropping `forward_auth` (a bypass of ADR 0008). And `porch publish` into a tree it does not own overwrites a hand-written file of the same path. Cairn never runs `import`, and publish gets the refusal above.
9. **A portal's dev server runs in its own transient systemd user unit**, not under the brain. `systemd-run --user --unit cairn-portal-<id>` gives its own cgroup (`app.slice/…`, separate from `cairn.service`), so a brain restart or `kill -9` leaves the page answering, and a boot repair reconciles units, porches and rows. `porch run` is the wrong tool: it is a foreground wrapper in the caller's cgroup, which `KillMode=mixed` would kill with the brain.
10. **Portals have four states and a TTL**: `opening`, `open`, `stopped` (process gone, porch kept, so the dark page shows how to start it), `removed`. A portal ends by explicit close, a 12 h time-to-live (also `RuntimeMaxSec` on the unit), thread archive or delete, or its unit dying. Settling a thread closes nothing.
11. **The tools-only host is feasible and cheap, with one hard design constraint.** pi-coding-agent's own `discoverAndLoadExtensions` loads both packages in 58 ms with no errors. `pi-web-access` registers 5 tools (`web_search`, `source_check`, `fetch_content`, `get_search_content`, `web_enable`) and `pi-fff` registers 2 (`ffgrep`, `fffind`). An adapted `ffgrep` ran inside a real pi-durable Harness on SQLite and its result survived a close and reopen.
12. **`pi-fff` searches the cwd of its last `session_start`, not the call's.** Measured: a call with another cwd searched the first repo and answered "0 exact matches", and with `session_start` re-fired per call two concurrent threads still got "No matches found" for one of them. The host therefore runs one extension instance per cwd (a small pool), and `pi-web-access` one per brain.
13. **The host must bind the runtime and fire `session_start`.** Unbound, `pi-fff` fails with "FFF picker factory is not initialized" and `pi-web-access` throws from `getAllTools`. Both are fixed by the stubs listed in "Design". Writes that would leave `~/.pi/agent` (pi-fff's frecency databases) are redirected by its own flags and `PI_WEB_ACCESS_CACHE_ROOT`; `judges/pi-readonly.sh` stays green.
14. **Two decisions are hard to reverse and are proposed as ADRs below**: the transient-unit portal lifetime, and the allowlisted, cwd-scoped tools-only host. The CLI-not-library call and the docker-exec reload are one-layer or one-line changes and need none.

## Facts with evidence

### Pins

| Source | Pin | Notes |
| --- | --- | --- |
| porchlight | `5334351` "porch run, porch publish, and the bundled skill" | MIT, Bun 1.4.2 here, `packages/cli` + `packages/vite` (an empty stub). Inversion commits `6e31378`, `c1d1a29`, `32258f7`. `900eacc` (admin socket) predates the inversion. The npm name `porchlight` is someone else's package (0.5.2); do not install it. |
| porch design record | `~/Documents/sync-vault/projects/minilab/decisions/2026-10-porchlight-design.md`, "Decisions (2026-10-02, the inversion)" | Supersedes its "Mechanism" and "Files" sections. |
| Live Caddy | container `caddy`, image `caddy-caddy`, v2.11.2, host network, up 7 days | `~/caddy/{docker-compose.yml,conf/Caddyfile}`; admin API on `127.0.0.1:2019`. |
| pi packages | `pi-web-access` 0.45.0 (MIT), `@ff-labs/pi-fff` 0.11.0 (MIT) | Under `~/.pi/agent/npm/node_modules`, listed in `settings.json` `packages`. |
| pi runtime | `@earendil-works/pi-coding-agent` and `pi-durable` 1.4.0; spec at `/tmp/pi-src` tag `v1.4.0` | `docs/spec.md` §7 (extensions, tools) and §12 (footguns) read. |
| t3code | `fe27e8e3` | `apps/server/src/htmlRender/HtmlRender.ts` (25 MiB page cap), `apps/web/src/browser/openFileInPreview.ts`. |

### porch today

- **Commands** (`packages/cli/src/cli.ts`): `init`, `run`, `add`, `serve`, `publish`, `rm`, `ls`/`status`, `url`, `docs`, `apply`, `rollback`, `import caddy`, `doctor`, `skill install`. `--json` prints JSON on stdout and `{"error":{"code","message"}}` on a refusal with exit 1.
- **Registry** (`~/.local/state/porchlight/porches.json`, `schema.ts`): four kinds, `dev` (`port`, `project`, `start`, `split`), `service` (`upstream`, `redirect`), `static` (`root`, `noCache`), `artifacts`. Every change runs under a `mkdir` lock with dead-holder breaking (`lock.ts`), renders the snippet, writes it, runs the reload command, and only then saves the registry; a refused reload puts the old snippet back (`proxy.ts` `applySnippet`). History keeps 20 prior registries for `rollback`.
- **Snippet** (`caddyfile.ts`): three files in `proxy.dir`. `porches.caddy` holds `@<name> host <name>.<domain>` plus `handle @<name> { … }`; `errors.caddy` holds one `handle_errors 502 504` dark page driven by a `map` on the host; `fallback.caddy` is a catch-all `handle`. The artifacts handle is `file_server browse` with `try_files {path} {path}.html` and a `hide` list, no cache header.
- **Port lease** (`ports.ts`, `porchlight.ts:114`): the first port in `ports.range` (default `[3001, 3999]`, `init.ts:281`) that no porch holds and `Bun.serve` can bind. A dev porch keeps its lease until `rm`. Only `porch run` calls `lease`.
- **Publish** (`publish.ts`): copies a file or a folder with an `index.html` to `<artifacts>/<project>/<basename>`, keyed `project/basename` in `published.json` with a sha256. Same source and hash gives `changed:false` and the same URL. A different source at a recorded key is refused unless `--replace`. `rm -rf` of the target runs on every change (`publish.ts:125`).
- **Names**: `RESERVED_NAMES = www, app, admin, api, plans` (`porchlight.ts:45`). The `CONTEXT.md` "worktree porch" (`<worktree>--<project>`) has no code behind it, only the schema allows `--`.

### The live Caddy and the host

- **Caddyfile** (`~/caddy/conf/Caddyfile`, 6,386 bytes, edited 2026-10-22; ten timestamped backups beside it): one `*.gneiss.run` block with hand-written `@name host` + `handle` pairs, Cairn's `@cairn host code.gneiss.run` with `forward_auth 127.0.0.1:3774` (`uri /_cairn/auth`, `header_up X-Cairn-Peer {remote_host}`), a hand-written `@plans` file server over `~/Developer/agent-artifacts` (with `Cache-Control "no-cache"`), `@depot`, a `map {host} {dev_port}` table of 30 dev hosts on ports 3001 to 3032 with `@dev vars_regexp {dev_port}`, and a final `handle { respond "Service not found" 404 }`. It has no `import`, no `handle_errors`, no `stream_close_delay`.
- **Compose**: `./conf:/etc/caddy:ro`, `agent-artifacts` and `teach-depot` mounted read-only at their own host paths, `network_mode: host`, `CLOUDFLARE_API_TOKEN` from `.env`. `~/Developer/agent-artifacts` already has the `<project>/<file>` layout (`cairn/`, `exhibit/`, `myr/`, …; 259 MB, not a git repo), which is the URL scheme `plans.<domain>/<project>/<file>`. A snippet directory outside `./conf` is invisible inside the container until mounted at the same path, which is the user's own idiom.
- **Reload without sudo**: see summary 2. `ss` shows Caddy on `:80`, `:443` and `127.0.0.1:2019`.
- **The brain's PATH** (`~/.config/cairn/brain.env`, written by `ops/cairn/install.sh`) includes `~/.bun/bin` and `~/.local/bin`. `cairn.service` is `KillMode=mixed` (`ops/cairn/cairn.service:28`), so processes left in its cgroup are killed when the main process goes.

### What happens with the live file (probes)

| Probe | Result |
| --- | --- |
| `caddy validate` of the live file with porch's snippets imported | "matcher is defined more than once: `@cairn`" (the hand-written Cairn route), then "`@plans`" after renaming. Porch's matcher is `@<porch name>`, so a hand-written matcher and a porch of the same name collide. With the hand-written `@plans` removed and the porch renamed, "Valid configuration". |
| Dark page for a host that is not in the registry (a hand-written service whose upstream is down) | HTTP 502 with the dark page reading " is dark" and empty strings, because `errors.caddy` applies site-wide with `default "" "" ""`. |
| `porch import caddy --from <live file, tls stripped> --dry-run` | "Would import 26 porches" (including `code`, `exec`, `t3`, `plans`), skipping two. The real run crashes with `Invalid URL "http://localhost:{dev_port}"`. |
| Import of the Cairn block alone | Registered as a service porch and rendered as `reverse_proxy 127.0.0.1:3774` only: `forward_auth`, `header_up` and the `lb_try_*` retries are gone. |
| `porch publish index.html --project mine` over a hand-written `mine/index.html` | The hand-written file is replaced; porch never saw it, so no collision check fired. A directory publish keys on the directory name and did not touch it. |
| Six parallel `porch publish` of distinct files | All six landed, no corruption (state-dir lock). |
| Open WebSocket across `caddy reload` (Caddy 2.11.6, throwaway on 38997 to 38999) | Default: closed at 2,019 ms, the reload at 2,018 ms, 9 ticks before and none after. With `stream_close_delay 30s`: stayed up, 39 ticks. |
| `systemd-run --user --unit … --collect --setenv PORT=3999 -- sh -c …` | Active, sees the env, `ControlGroup=…/app.slice/<unit>.service` (the brain is `…/app.slice/cairn.service`), `systemctl --user stop` ends it. No sudo. |

### Cairn today

- **Extension seam.** `ExtensionOrder` (`apps/server/src/brain/Extensions.ts:12`): coding tools 100, cairn 200, skills 300, context 400, codemode 500, executor 600, bridgeCwd 700, judge 900. `ExtensionSet.ts:16` lists the production sources and installs them once at boot, because a change appends `pi.system` entries and misses the prompt cache once (spec §12 "Moving default selections"). The model's tool list is fixed (coding tools plus `codemode`); Executor's proxies are `callers: ["tools"]` (`ExecutorExtension.ts` header).
- **PiConfig** already runs pi's `DefaultPackageManager.resolve()` read-only and fenced (`models/PiConfig.ts:453-545`) but keeps only `paths.skills`. Its result also carries `extensions` with `enabled` flags and `metadata.packageRoot`, so the user's `+`/`-` filters in `settings.json` are already applied.
- **Guard and CSP.** `/_cairn/auth` is self-guarded and host-independent (`Guard.ts:23,75`; `Identity.ts:234` refuses only requests that came through the main proxy). The page's CSP has `frame-src 'none'` (`Static.ts:62`), so an inline artifact viewer needs a deliberate CSP change.
- **Boot and close hooks.** `BootRepairs.ts:48` and `ShutdownHooks.ts:11` are the seams for a portal reconcile and a close hook.
- **Process starts.** pi-durable's `NodeExecutionEnv` spawns `detached` and kills the group only on abort, timeout or `cleanup()` (`env/node.js:744,1170`), so a dev server an agent backgrounds with `bash` lives in the brain's cgroup and dies with the brain.

### The pi extensions

- **`pi-web-access` 0.45.0**: manifest `pi.extensions: ["./dist"]`, a 28k-line bundle. Tools: `web_search`, `source_check`, `fetch_content`, `get_search_content` (all `exposure: "direct"`) and `web_enable` (a loader for deferred tools, useless when the tool set is fixed). Handlers: `session_start`, `session_tree`, `session_shutdown`, `before_agent_start`, `agent_settled`, `tool_call`. It also registers four slash commands, two shortcuts, `ctx.ui.setWidget/select/notify` calls, a local "curator" HTTP server, `pi.appendEntry("web-search-results")` to persist results, and model calls through `ctx.modelRegistry` (query rewrite, `prompt`/`extract` modes of `fetch_content`, summaries). The user's `~/.pi/web-search.json` has `workflow: "none"` and an Exa key (never printed). A fetch cache lives under `~/.pi/web-search-cache` unless `PI_WEB_ACCESS_CACHE_ROOT` is set, and an Exa monthly counter in `~/.pi/exa-usage.json`. Declarations cost about 3.7k characters of parameters and 450 of descriptions for the four direct tools.
- **`@ff-labs/pi-fff` 0.11.0**: manifest `pi.extensions: ["./src/index.ts"]`, native `@ff-labs/fff-node` plus a `.so`. It has its own mode flag: `tools-and-ui` (default), `tools-only` and `override`. Outside `override` the tools are `ffgrep` and `fffind` (names differ from pi's built-in `grep` and `find`); `multi_grep` is behind `PI_FFF_MULTIGREP=1`. It registers three commands, seven flags, an autocomplete provider and a home-directory scan warning. Its frecency and history databases default to `~/.pi/agent/fff/{frecency,history}`, which exist today and would be written by a host that did not redirect them.
- **pi's loader.** `discoverAndLoadExtensions(paths, cwd, agentDir, eventBus)` is the public entry; it also scans `<cwd>/.pi/extensions` and `<agentDir>/extensions`, which is project-local code execution, so a host passes two empty Cairn-owned directories. It returns `Extension` objects (tools as `RegisteredTool{definition,sourceInfo}`, handlers, commands, flags, shortcuts, renderers) and a `runtime` whose action methods throw until bound. `ExtensionRunner` could drive all of it but needs a pi `SessionManager` and `ModelRegistry`, which a durable host does not have.
- **pi-durable's contract** (spec §7.3): `ToolRegistration` is a pi-ai `Tool` plus `replay` (`safe` or `unsafe`, default `unsafe`), `callers`, `executionMode`, `structuredOutputSchema`, `outputLimits`, and `execute(args, api, context)` where `context.abortSignal` is the signal and `api.output()` streams partial text. pi's `ToolExposure` (`direct`, `model-only`, `codemode`, `deferred`, `hidden`) maps onto `callers`.

## Design for Cairn

### 1. porch changes (in the porchlight repo, test first against its throwaway Caddy)

1. `porch lease <name> [--project <dir>] [--start <cmd>] [--port <n>] --json` exposes `lease()` and applies. Returns `{ name, port, url, created }`. Idempotent: an existing dev porch keeps its lease.
2. `porch publish` refuses a target that exists on disk but is not in `published.json` (code `exists`), unless `--replace`. `porch unpublish <project>/<name> --json` removes the copy and its record.
3. `proxy.guard` in the machine config: the name of a Caddyfile snippet (`owner_only`) rendered as `import owner_only` first in every handle porch writes. The snippet itself lives in the user's Caddyfile (`(owner_only) { forward_auth 127.0.0.1:3774 { uri /_cairn/auth; header_up X-Cairn-Peer {remote_host}; lb_try_duration 3s; lb_try_interval 250ms } }`), so porch still stores no secrets and no Cairn knowledge. Phase 3 reuses the same hook as a per-porch `imports` list for the stone link.
4. The artifacts porch sends `Cache-Control: no-cache`, as the live `@plans` handle does, so a republish shows on the phone without a hard refresh.
5. File upstream issues for the two import faults (`{dev_port}` crash in dry-run versus real run, and dropped `forward_auth`), not fixed for Cairn.

### 2. Machine setup (one wizard, `ops/wizards/phase-2-reach.sh`, user-run)

Backed up first (`cp ~/caddy/conf/Caddyfile{,.bak-before-porch-$(date …)}`), then:

1. Install the binary: `bun build --compile` from porchlight into `~/.local/bin/porch` (81.6 MB; or a `bun` shim script).
2. `porch init --domain gneiss.run --artifacts ~/Developer/agent-artifacts --caddyfile ~/caddy/conf/Caddyfile --reload 'docker exec caddy caddy reload --config /etc/caddy/Caddyfile'`, then set `ports.range` to `[3100, 3699]` (clear of the hand-written table 3001 to 3032, the brain's 3774 to 3777 and Executor's 4400).
3. In `~/caddy/docker-compose.yml`, bind-mount `~/.config/porchlight/caddy` read-only at the same path, then `docker compose up -d` (a one-second recreate; the first thing it drops is every WebSocket, once).
4. In the Caddyfile, inside `*.gneiss.run`: define `(owner_only)`, delete the hand-written `@plans` block (its job moves to porch's artifacts porch), add `import` lines for `porches.caddy` and `errors.caddy` above the final `handle`, and leave `fallback.caddy` out (the file has its own catch-all). Add `stream_close_delay 5m` to the reverse proxies that carry WebSockets (`@cairn`, `@t3`, `@ha`, `@exec`, `@jellyfin`, `@immich`). Run `docker exec caddy caddy validate`, `caddy fmt` check, then reload.
5. `porch ls --json`, publish a probe page and read it back.

The wizard never runs `porch import`. Hand-written handles stay where they are; the only porch names in play are the ones Cairn creates.

### 3. Modules (`apps/server/src/reach/`, protocol in `packages/protocol/src/Reach.ts`)

- `PorchClient.ts`: `Context.Service` over the `porch` binary, `ChildProcess` with `--json`, one `Schema` per receipt (`PublishReceipt`, `LeaseReceipt`, `PorchRow`), `PorchError` mapped from the JSON `error.code` (`exists`, `reserved`, `no-port`, `proxy-refused`, `busy`). A fake layer for tests.
- `Artifacts.ts`: the `artifact_publish`, `artifact_list`, `artifact_revoke` tools and the `artifacts` table.
- `Portals.ts`: the `portal_open`, `portal_close`, `portal_list` tools, the `portals` table, the unit control (`systemd-run`, `systemctl --user`), and the TTL sweep.
- `ReachRepair.ts`: the boot repair `portal-reconcile` (listed in `BootRepairs.ts`). `ReachExtension.ts`: one Cairn extension, order key `reach: 750`.
- RPCs: `reach.list` (`{ artifacts, portals }` for a thread or all), `artifact.revoke`, `portal.close`, `portal.start`. Tool results carry `details` shown by the transcript; no shell-stream field is added now (the sidebar count is a design pass question).

### 4. Artifacts

- **Tool** `artifact_publish { path, name?, project? }`. `path` is a file or a folder with `index.html`, resolved and refused unless it is inside the thread's cwd or its scratch folder (the model reads `.env` files with `read` today, but publishing copies them to a URL); folders holding `.env*`, `.git` or `node_modules` are refused with the offending path named; a 25 MiB cap (t3code's `MAX_PAGE_BYTES`). `project` defaults to the Cairn project's slug (`scratch` for a scratch project).
- **URL**: `https://plans.<domain>/<project>/<name>` (a folder ends with `/`). `name` defaults to the basename. The agent's file is staged once at `~/.local/share/cairn/artifacts/<thread>/<name>` so porch sees a stable "same source" and republishing the same name from the same thread updates in place; the same name from another thread is refused with porch's `exists` message and the agent picks another.
- **Idempotent republish**: `replay: "safe"`. A rerun after a crash publishes again; porch compares hashes, so the answer is `changed:false` and the same URL. Publish needs no Caddy reload (the artifacts porch exists after the first call, which does reload once).
- **Record** (`cairn.sqlite` `artifacts`): `id`, `thread_id`, `project_slug`, `name`, `kind` (`file|folder`), `url`, `hash`, `bytes`, `published_at`, `updated_at`, `revoked_at`. The porch registry is the source of truth for what is served; the table is the thread's index into it.
- **In the thread**: the tool result's `details` is `{ kind: "artifact", url, name, changed, bytes }`. The row reads "Published report.html" or "Updated report.html" with the URL as a link that opens a new tab (works on the phone with no CSP change). An inline viewer is a look-wave choice: it needs `frame-src https://plans.<domain>` in the CSP and a sandboxed iframe, and t3code's `HtmlRenderDialog` is the behaviour to port.
- **Privacy**: tailnet only by construction, plus the `guard` import (ADR 0008). Artifact pages are agent-written HTML on a different origin from Cairn: the Guard's exact-Origin rule and the blanket 403 on `/api` mean a page's script cannot drive Cairn.

### 5. Portals

- **Tool** `portal_open { command, cwd?, name?, readyPath?, readyTimeoutSec?, ttlHours? }`, returning `{ url, port, name, state }`. `portal_close { name }` stops the process and removes the porch; `portal_list` lists the thread's.
- **Name**: `<branch-slug>--<project-slug>` (at most 63 characters, one DNS label, so the wildcard certificate covers it). The `--` form cannot equal a hand-written matcher such as `@cairn` or `@plans`. A thread in the main checkout uses `main--<project>`.
- **Open sequence** (every step idempotent, so the tool is `replay: "safe"`):
  1. Commit the `portals` row `opening` (id, thread, name, command, cwd, ttl, `unit = cairn-portal-<id>`).
  2. `porch lease <name> --project <cwd> --start <command>` (registers the dev porch, applies, one reload; the dark page serves from now on).
  3. `systemd-run --user --unit cairn-portal-<id> --collect --working-directory <cwd> -p RuntimeMaxSec=<ttl> -p MemoryHigh=2G --setenv PORT,HOST=127.0.0.1,PORCH_HOST,PORCH_URL,__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS,PATH=… -- /bin/sh -c <command>`, with the env from `Arms.shellEnv()` (no `CAIRN_*`). An existing unit of that name means step 3 already happened.
  4. Probe `127.0.0.1:<port>` until it answers (up to `readyTimeoutSec`, default 60). On timeout the tool returns an error with the last 40 journal lines and leaves the portal `opening` for the agent to retry or close.
  5. Row `open`.
- **States and closers**: `open` ends by `portal_close` or the user's Close (unit stopped, `porch rm`, row `removed`), by TTL (default 12 h; `RuntimeMaxSec` enforces it even with the brain down, the sweep notices and sets `stopped`), by thread archive or delete (stop and remove), and by the unit dying on its own (`stopped`). `stopped` keeps the porch and the row's command, so `https://…` shows porch's dark page ("Start it with `<command>` in `<dir>`") and Cairn's Start button re-runs the same open. Settling a thread closes nothing: the TTL is the sweeper, and an auto-settled thread is by then quiet.
- **Limits**: six open portals per brain; a seventh `portal_open` returns an error naming the oldest.
- **Brain restart**: units survive `kill -9` and SIGTERM, so the page keeps answering. Boot repair `portal-reconcile` (after the Harness opens, before ready): for each row `opening` or `open`, check `systemctl --user is-active cairn-portal-<id>`; a missing unit becomes `stopped`; a unit with no row is stopped; a dev porch with no row is removed with `porch rm`; a row `opening` with a lease and no unit older than two minutes becomes `stopped`. The open sequence's `kill -9` matrix:

  | Killed after | State left | What the rerun or repair does |
  | --- | --- | --- |
  | step 1 | row `opening`, no porch, no unit | rerun repeats 2 to 5; repair ends it `stopped` if the thread never retries |
  | step 2 | porch leased, no unit | rerun finds the lease (`created:false`), starts the unit |
  | step 3 | unit running, porch lit | rerun finds the unit, probes, marks `open` |
  | step 5 | row `open` | rerun returns the same URL |

- **Privacy and blast radius**: the unit runs as the user, unconfined, like `bash` (ADR 0013's note). The process is reachable only through Caddy (it binds `127.0.0.1`), behind the `guard`.
- **Stone portals (phase 3) fit without redesign.** The row gains `arms: "host" | "stone"` and `stone_id`. A stone portal is a `service` porch named `<port>-<stone>-pv` (one label, covered by the wildcard) whose upstream is the stones Worker's preview route; the Access service token is added by a Caddyfile snippet (`stone_link`, reading env placeholders like `acme_dns` does) that porch imports through the per-porch `imports` list. The open sequence loses steps 3 and 4 (the stone's daemon owns the process) and keeps lease-by-name, lifetime and the dark page.

### 6. The tools-only pi host (`apps/server/src/pi-host/`)

"Tools-only" means: execute the extension's factory so its `registerTool` calls produce tool definitions, deliver the two lifecycle events that initialise them (`session_start` once per instance, `session_shutdown` at close), and drop everything else. It is not pi-fff's `tools-only` mode, though it forces that mode.

- **Modules.** `PiHost.ts` (the service: resolve, load, adapt, instance pool, close hook), `PiToolAdapter.ts` (pure: `ToolDefinition` to `ToolRegistration`), `PiHostRuntime.ts` (the bound runtime and the per-call `ExtensionContext`), `PiHostPolicy.ts` (the allowlist and per-tool table). `PiConfig` gains `extensions: ReadonlyArray<ResolvedResource>`. Order key `piTools: 800` in `Extensions.ts`; `ExtensionSet.production` gets `PiHost.useSync(host => host.extension)`.
- **Allowlist.** Only `pi-web-access` (0.45.x) and `@ff-labs/pi-fff` (0.11.x), by package name and version range, from the packages pi resolved and enabled in `settings.json`. Loading runs the package's code inside the brain, so unknown packages never load; a package outside its range loads nothing and logs `event: pi_host_skipped`. Not loaded and why: `pi-claude-bridge` (Cairn's bridge is native, ADR 0017), `pi-herdr-btw` and `pi-unslop` (UI), `pi-skill-stacks` (skills, already resolved by `SkillCatalog`), and the user's local extensions (`auto-worktree`, `herdr-agent-state`, …).
- **Loader.** `discoverAndLoadExtensions([entry], cwd, agentDir)` with `cwd` and `agentDir` both an empty Cairn-owned directory (`~/.local/share/cairn/pi-host/empty`), so neither project-local nor global discovery runs. A load error fails that package only, with `event: pi_host_failed` and boot goes on, like a boot repair; the tool set then differs from the last boot, which costs one prompt-cache miss per conversation and is logged.
- **Runtime stubs** (probe-verified need): `getActiveTools` and `getAllTools` return the registered names and infos; `setActiveTools` is a no-op (moving default selections); `getSettings` returns `{}`; `getCommands` returns `[]`; `appendEntry` counts and drops (raw appends to a busy conversation are a spec §12 footgun); `sendMessage`, `sendUserMessage`, `setSessionName`, `setLabel`, `setModel` and `setThinkingLevel` throw `HostUnsupported("<api>")`; `registerProvider`, `registerMcpServer` and `registerVirtualModel` fail the package's load (ADR 0002, ADR 0003).
- **Context per call.** `ui` is a no-op object (`confirm` false, `select`/`input` undefined, `notify` to the events log, `theme` inert), `mode: "print"`, `hasUI: false`, `cwd` from `api.agent(context)` (the conversation's cwd), `signal: context.abortSignal`, `sessionManager` with `getEntries: () => []` and `getSessionId: () => conversationId`, `modelRegistry`, `model` and `scopedModels` empty in v1. That disables, with the extension's own error text, `fetch_content`'s `prompt` and `mode:"extract"`, query rewrite, and the `summary-review` and `auto-summary` workflows. A later step can hand them a `ModelRuntime` facade. `onUpdate` partials become `api.output(text)`; `details` is JSON-cloned (it must be a `JsonValue`).
- **Mapping table**, enforced in `PiToolAdapter.ts` and tested:

  | Extension field | pi-durable field |
  | --- | --- |
  | `name`, `description`, `parameters`, `prepareArguments` | same (the typebox schema works as is: probe) |
  | `exposure` `direct` / `model-only` / `codemode` / `deferred` / `hidden` | `callers` `["model","tools"]` / `["model"]` / `["tools"]` / `["tools"]` / tool dropped |
  | `executionMode` | `executionMode` |
  | `outputSchema` | `structuredOutputSchema` |
  | `promptSnippet`, `promptGuidelines` | one static section `pi-tools` rendered at boot from the surviving tools |
  | `renderCall`, `renderResult`, `renderShell`, `annotations`, `namespace`, `prepareLoadout` | dropped |
  | replay | from `PiHostPolicy`, never from the extension: `safe` for `web_search`, `source_check`, `fetch_content`, `get_search_content`, `ffgrep`, `fffind` (read-only or idempotent caches); any other tool `unsafe` |

  `web_enable` is dropped (it only calls `setActiveTools`). `fetch_content` may clone a GitHub repo into a cache: idempotent, so `safe`.

- **Instances and scope.** `pi-web-access` gets one instance per brain (its results map is keyed by response id). `pi-fff` gets one instance **per cwd**, built lazily under a per-cwd semaphore, `session_start` fired with that cwd, the call routed to that instance's tool by `api.agent(context).cwd`, an LRU of four, `session_shutdown` on eviction and at close. This is forced by the probe in summary 12. Config the host sets for every instance: flags `fff-mode=tools-only`, `fff-frecency-db` and `fff-history-db` under `~/.local/share/cairn/pi-host/fff/`, `fff-enable-home-scan=false`, `fff-enable-root-scan=false`; env `PI_WEB_ACCESS_CACHE_ROOT=~/.local/share/cairn/pi-host/web-cache`, and `PI_CODING_AGENT_DIR` left unset (set, `pi-web-access` would write its cache into the agent dir).
- **Durability.** An adapted tool is an ordinary pi-durable tool task. `kill -9` mid-call: a `safe` tool reruns on resume and its result commits once; an `unsafe` one comes back `interrupted`. Instances are in memory, so a restart rebuilds them on the next call (79 ms to index this repo's 1,009 files). `pi-web-access`'s in-memory results are gone after a restart; `get_search_content` then answers its own "No stored results for responseId" error (measured text), and the fetch cache on disk keeps one hour of fetched pages. Persisting results through `appendEntry` into a Cairn document is possible later and not needed to start.
- **How it relates to code mode.** The model sees the six tools directly (the user's TUI does too). Only `ffgrep` and `fffind` overlap Cairn's own `grep` and `find`; both stay (names differ, as in the TUI today). Open question 4 asks whether FFF should instead replace them.

## Judges

| Piece | Outside judge | Done when |
| --- | --- | --- |
| porch changes | porchlight's own tests against its throwaway Caddy (`test/support/caddy.ts`, high loopback ports only): lease idempotence, publish refusal of an unmanaged target (fails against the unpatched code), `unpublish`, `guard` render, `no-cache` header | all green in porchlight, plus one red-first test each for the measured faults |
| `PorchClient` | `PorchClient.test.ts` with a fake layer (error mapping, receipt schemas); `judges/porch-contract.ts` runs the real binary against a throwaway Caddy | receipts decode; `proxy-refused` surfaces the proxy's text |
| Artifact tools | `Artifacts.test.ts` plus `judges/reach.ts` (below) | publish twice gives `changed:false`; an edit gives the same URL with `changed:true`; the same name from another thread is refused; a folder with `.env` is refused |
| Portal tools and repair | `Portals.test.ts` with a fake `systemctl` and fake porch; `judges/reach-restart.sh` against a judge brain | the kill matrix above ends with no leaked unit, lease or row |
| Guard | a throwaway Caddy with `forward_auth` to a fake `/_cairn/auth` that answers 403 for one peer | the portal and artifact hosts answer 403 to that peer and 200 to the owner; an unguarded control answers 200 to both |
| Reload and WebSockets | the probe in `/tmp/reach-probe/reload/ws-probe.mjs`, kept as `judges/caddy-reload.ts` | with `stream_close_delay` set, an open upgraded connection survives a porch reload; without it the judge's control fails (it proves the judge can fail) |
| The gate: both load on the phone | **behaviour script** `judges/reach.ts --live` | below |
| Tools-only adapter | `PiToolAdapter.test.ts` over a fixture extension (a tool of each exposure, a tool that calls `ui.confirm`, one that calls `pi.sendMessage`) | mapping table holds; unsupported calls fail loudly with the API named |
| cwd isolation | `PiHost.test.ts` with a fixture extension that, like pi-fff, remembers the last `session_start` cwd | two threads in two cwds calling concurrently each see their own cwd; a host that shares one instance fails (the mutation control) |
| Durable run of a tools-only tool | `judges/pi-host.ts`: real packages, a real Harness, a faux model; then `kill -9` mid-call of a fixture `safe` tool that counts runs in a file | the committed result is read back after reopen; the `safe` tool ran twice and committed once, an `unsafe` fixture ran once and came back `interrupted` |
| The user's pi stays theirs | `judges/pi-readonly.sh`, extended to load the host | agent dir record identical; the only writes outside it are `~/.pi/exa-usage.json` (named in the judge) |

**`judges/reach.ts --live` (the phone check).** Against the deployed brain on a cheap real model: one thread is asked to write `report.html` containing a fresh nonce `A`, publish it, start `python3 -m http.server $PORT` serving a page that contains nonce `B`, and open a portal. The script then (1) reads both URLs from the tool results, (2) fetches each from the Beelink with `curl --resolve` and checks status, nonce, and `Cache-Control: no-cache` on the artifact, (3) prints both URLs to the thread and to the wizard, and (4) asks the user to open them on the phone and type the nonces they see. It passes when both nonces match what was typed. The phone's load is proved by what the phone displays, not by any Cairn-side clock, in the style of `judges/phone-report.ts`. A fifth step republishes with a new nonce and asks for the new value after a plain reload.

**`judges/reach-restart.sh`** (judge brain on ephemeral ports, a throwaway Caddy, a stub `porch` config in a temp dir): open a portal, `kill -9` the brain, check the page still answers during the restart and that `reach.list` shows it `open` after; `systemctl --user stop` the brain (SIGTERM) and repeat; close from the RPC and check the unit is inactive and the name falls to the fallback or dark page; kill at each step of the matrix with `CAIRN_JUDGE_FAULT=portal:after-<step>` (judge brains only, as `judge-main.ts` already gates its tools).

## Proposed ADRs

1. **Portals run as transient systemd user units.** A portal's dev server is started with `systemd-run --user --unit cairn-portal-<id>` so it lives in its own cgroup, outside the brain's `KillMode=mixed`; Cairn owns it through a row in `cairn.sqlite` and reconciles at boot. The alternative, running it under the brain or through `porch run`, ties every dev server to every brain restart and orphans it on `kill -9`. The unit is unconfined like `bash`. Gate: `judges/reach-restart.sh` (page answers through a brain `kill -9`; the kill matrix leaves no unit, lease or row).
2. **The tools-only pi host is an allowlist, one instance per cwd.** The brain loads only named, version-pinned pi packages (`pi-web-access`, `@ff-labs/pi-fff`) through pi's loader from two empty directories, delivers `session_start` and `session_shutdown` only, refuses providers and MCP servers, and runs stateful cwd-bound extensions as one instance per cwd. It never runs the rest of `settings.json`'s packages, because loading is arbitrary code in the brain. Gate: `judges/pi-host.ts` plus the cwd-isolation test with its mutation control. (Gated: stays `proposed` until both pass.)

Not an ADR: calling the porch CLI instead of importing it, and the docker-exec reload. They are reversible by changing one layer and one config line.

## Open questions for the user

1. **Reload path.** Keep the Docker Caddy and reload with `docker exec caddy …` (recommended: it is what `caddy-route.sh` does, it needs no sudo, and the one-time cost is a compose edit), or do porch's planned cutover to a native Caddy under a user-owned unit (needs sudo once for the unit and ends `~/caddy`)? Docker is already allowed for Caddy; ADR 0005 limits it for everything else.
2. **Who may open `plans.gneiss.run`?** Recommended: owner-only (the `guard`), which also closes today's hole where any tailnet device can browse every agent page, with the cost that anyone you shared a plan link with can no longer open it. The alternative is a second artifacts host that is guarded while `plans` stays open, which porch's single artifacts porch does not support yet.
3. **Where do artifacts land?** Recommended: `~/Developer/agent-artifacts/<project>/<file>`, the tree you already use, which keeps your URLs and needs no new mount; the cost is that agent pages sit beside your hand-written ones (porch will refuse to overwrite anything it did not publish). The alternative is a separate root such as `~/.local/share/cairn/artifacts`, which needs its own mount and gives every old plan a different host.
4. **FFF next to Cairn's `grep` and `find`, or instead?** Recommended: next to them for now (`ffgrep`, `fffind`, as in your TUI), then decide after the daily-driver week from the Events log which the model reaches for. `override` mode would replace Cairn's ripgrep and fd tools and make results frecency-ranked per cwd.
5. **Portal time-to-live.** Recommended 12 h, six open at once. Longer suits an overnight demo; shorter suits a small RAM budget (16 threads, 27 GiB, `MemoryHigh=2G` per portal).
6. **`~/.pi/exa-usage.json`.** `pi-web-access` writes its monthly Exa counter there (outside the agent dir). Recommended: let the host share it with the TUI so the count stays true, and name it in `judges/pi-readonly.sh`. The alternative is a private copy, which would double-count your quota.

## Risks

- **A reload per portal open and close.** Cairn's own socket and every other service reconnect unless `stream_close_delay` is in place; the wizard sets it and `judges/caddy-reload.ts` checks it. Opens are rate-limited to one reload a second.
- **Hand-written Caddy edits by the wizard.** A mistake there takes every `gneiss.run` name down. Mitigated by the backup, `validate` before reload, `caddy fmt` cleanliness (as `caddy-route.sh` does), and porch's all-or-nothing apply for everything after.
- **Docker group is root-equivalent**, and the brain's tools already run unconfined as the user. Adding `docker exec` to Cairn's own code widens nothing a thread's `bash` cannot already do, but the new tools should only ever call the fixed reload command.
- **`porch` is pre-alpha and its author is also the user.** Five changes land in porchlight, and two import faults are filed there. Cairn pins a built binary by commit and checks `porch --version` and a `doctor` at boot (`event: porch_unavailable` disables the two tool families rather than the brain).
- **Dark page on unregistered hosts.** `errors.caddy` renders an empty name for a hand-written service that is down. Either accept a slightly odd 502 page or move those hosts into the registry by hand with `porch add` (not `import`).
- **pi-fff memory and CPU.** A native index per cwd, four at most; home and root scans disabled. Measure under `MemoryHigh=1.5G` with four large repos before the gate.
- **`pi-web-access` is large and reaches out**: 28k lines, reads Chrome cookies for its Gemini path when the user's config allows it, opens a local curator server in UI workflows. The host passes `hasUI: false`, which keeps the curator from opening (its run state resolves on `ctx.hasUI !== false`, read in `index.ts`), the user's own config already says `workflow: "none"`, and the allowlist pins the version; upgrades are read before the pin moves.
- **Caddy version.** The reload-versus-WebSocket measurement ran on Caddy 2.11.6 (porch's cached binary); the live container is 2.11.2 and could not be reloaded to test. The wizard repeats the probe's check by hand after the first reload, and `judges/caddy-reload.ts` takes the Caddy binary as an argument.
- **Version drift.** A pi bump can change the loader's exported names (`discoverAndLoadExtensions` is the only public entry today). The adapter test loads the real packages, so `pnpm check` fails on a break where the packages are present.
- **Agents publish secrets.** The path confinement and `.env*` refusal reduce it; they do not stop a model from pasting a secret into HTML.

## Work packages

Sized like phase 1's blocks. Order: A and B in parallel, then C and D, then E; F is independent of A to E and can start with them.

- **R1 porch changes** (porchlight repo, own worktree). Scope: the five items in "porch changes", each red-first in porchlight's throwaway-Caddy tests. Depends on: nothing. Judge: porchlight's tests; `porch lease`, `publish` refusal, `unpublish`, `guard` and `no-cache` demonstrated on the throwaway Caddy.
- **R2 wizard and machine setup.** Scope: `ops/wizards/phase-2-reach.sh` (backup, binary, `init`, compose mount, Caddyfile edits, `stream_close_delay`, validate, reload, probe publish), and `judges/caddy-reload.ts`. Depends on: R1. Judge: the wizard run by the user, `porch doctor` clean, the reload judge's control fails and its real run passes.
- **R3 `PorchClient` and the reach schemas.** Scope: `packages/protocol/src/Reach.ts`, `apps/server/src/reach/PorchClient.ts`, the `artifacts` and `portals` migrations, glossary additions (porch, lease, dark porch). Depends on: R1 (for the real-binary contract judge; the fake layer needs nothing). Judge: unit tests; `judges/porch-contract.ts`.
- **R4 artifact tools and rows.** Scope: `Artifacts.ts`, `ReachExtension.ts` (artifact half), `reach.list` and `artifact.revoke` RPCs, the transcript row. Depends on: R3. Judge: `Artifacts.test.ts`; the artifact half of `judges/reach.ts`.
- **R5 portal tools, units and repair.** Scope: `Portals.ts`, `ReachRepair.ts`, `portal.close` and `portal.start` RPCs, the close hook, the fault hooks for judge brains. Depends on: R3. Judge: `Portals.test.ts`; `judges/reach-restart.sh`.
- **R6 reach judge and phone gate.** Scope: `judges/reach.ts --live`, the phone nonce read-back in the phase wizard, the guard judge. Depends on: R2, R4, R5. Judge: the user reads both nonces on the phone.
- **R7 tools-only host.** Scope: `pi-host/` (four modules), the `PiConfig` extension of `extensions`, `ExtensionOrder.piTools`, the `pi-tools` section, the fixture extension. Depends on: nothing from R1 to R6. Judge: `PiToolAdapter.test.ts`, `PiHost.test.ts` with its mutation control.
- **R8 durable and read-only judges for the host.** Scope: `judges/pi-host.ts`, the `pi-readonly.sh` extension, a live search turn in the wizard (one `web_search` and one `ffgrep` from the phone, a few cents). Depends on: R7. Judge: the durable kill test and `pi-readonly.sh` pass; the user sees both tools answer in a thread.

Portal and artifact management screens (list, revoke, close, start, the dark-porch deep link) belong to the look wave and are drawn once; R4 and R5 expose the RPCs they need.

## Probes

All under `/tmp/reach-probe/`, none touching a live port, `~/.pi/agent`, `cairn.service` or the live Caddy (read-only `docker exec caddy caddy validate` aside). Rerun with `WT=<this worktree>` and `bun`, `node`, and porchlight's cached `.cache/caddy-2.11.6/caddy`.

- `config/`, `state*/`, `proj*/`: porch run with `XDG_CONFIG_HOME` and `XDG_STATE_HOME` pointed at `/tmp` and `ports.range` `[3040, 3099]`: publish twice and edited, `run` lease, the unmanaged-overwrite case, six parallel publishes, `import caddy` of the live file with TLS stripped (`Caddyfile.plain`, `Caddyfile.code`).
- `Caddyfile.{plain,import,import2,import3}` validated with the cached Caddy: the `@cairn` and `@plans` collisions and the passing variant. `Caddyfile.dark` on `:38999` for the dark page of an unregistered host.
- `reload/ws-probe.mjs <default|delay>`: backend with a `101` upgrade ticking every 200 ms, Caddy on 38999 with admin on 38998, reload at 2 s.
- `host/probe.mjs` (load both packages), `host/run-fff.mjs` (ffgrep with a hand-built context, flags to `/tmp`), `host/run-web.mjs` (pi-web-access session start, tool costs, `get_search_content` with an unknown id), `host/race-fff.mjs` and `race2-fff.mjs` (the single-cwd behaviour), `host/durable.mjs` (the adapter in a real Harness over SQLite with the faux provider, then reopen).
- Not run: a live `web_search` (it spends the user's Exa quota), a `kill -9` of the brain with a portal, `docker compose` changes, and any write to the live Caddyfile.
