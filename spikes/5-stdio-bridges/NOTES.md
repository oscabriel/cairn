# Spike 5: stdio MCP behind bridges

Result: **pass.** `convex` and `playwright` answer through Executor from bridges on the Beelink, and no event the judge tried leaves an orphaned process. Getting there needed three changes outside the spike: two Executor settings (one of them instance-wide), a ufw rule, and a design change for playwright, whose state otherwise dies with each call.

The glossary calls this the **stdio relay**; the spike's own names (`cairn-bridges`, `bridges/`) predate that and use "bridge", which the glossary keeps for the Claude provider.

Run on 2026-10-21 on the Beelink: Executor 2.0.0-beta.25 (apps framework `0.0.1-beta.95`), supergateway 4.2.0, @playwright/mcp 0.0.83 attached to chromium 1243 (153.0.8010.12), convex 1.47.0, `@modelcontextprotocol/sdk` 1.32.1, Node 26.11.1.

## Shape

- **One systemd user unit, `cairn-bridges`** (`bridges/cairn-bridges.service`, linked into `~/.config/systemd/user`). Its main process, `bridges/run.sh`, starts a headless Chrome with CDP on `127.0.0.1:3775` and one supergateway, and exits when either stops, so systemd restarts the pair.
- **One gateway, one port.** supergateway serves every server from `bridges/gateway.json` on `172.17.0.1:3776` (the docker bridge, not every interface), at `/<server>/mcp`, in stateful Streamable HTTP mode with a 10 minute session timeout. Each MCP session gets its own child process.
- **An API key** (`~/.config/cairn/bridges.key`, mode 600) guards the gateway, because Jellyfin shares the docker bridge. A request without it gets 401.
- **One Executor app, `cairn-bridges`** (`executor-app/`), mounts both servers with `mcpRouter` under `convex.*` and `playwright.*`. Its one app-scoped account holds the key; `connect.ts` connects it over the HTTP API, so the key is never a tool argument and no trace records it. Tools whose server marks them `destructiveHint` ask for approval (the quick-add rule).
- **convex runs unscoped.** `convex mcp start` without `--project-dir` serves every project: each call names its `projectDir`. One bridge covers all projects, so ADR 0014's one bridge per project isn't needed for convex.

## What Executor needed

- `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true`. Apps reach only public addresses otherwise (`NetworkRefused (private_address)`), and there is no per-app or per-host allowance: the switch is instance-wide. Every app, catalog copies included, can now reach loopback and LAN addresses from the container.
- `EXECUTOR_URL_ALLOW_HTTP_ORIGINS=["http://host.docker.internal:3776"]`. Plain-HTTP MCP URLs are refused unless loopback or listed.
- A ufw rule: `allow in on docker0 to 172.17.0.1 port 3776 proto tcp`. The host's input policy is DROP, so the container's requests timed out (`mcp_timeout`) without it. Now stage 8 of `ops/wizards/phase-0.sh`.
- **Quick add can't take a keyed server.** `POST /apps/import` refuses a server that answers 401 with a bearer challenge and no OAuth metadata (`agent_setup_required`). The app is written by hand instead, which is better anyway: one app, one account.

## Playwright's state

Executor opens and closes an MCP connection for every discovery and every call ("Session-local workflows do not survive separate tool calls", `integrations.md`). Through a plain stdio bridge, each call therefore got a new playwright child and a new browser: `browser_navigate` then `browser_snapshot` read `about:blank`. Playwright's own HTTP server doesn't help either: `--isolated` gives every client a new context, and without it the browser closes when the last client leaves.

The fix is a long-lived headless Chrome that every playwright child attaches to over CDP (`--cdp-endpoint http://127.0.0.1:3775`). Pages then outlive the call: navigate, then a snapshot in a new Executor call reads `https://example.com/`. The cost is that every caller shares one browser, so two threads using playwright at once see each other's tabs. Pages are lost when the unit restarts.

## Numbers

| Measure | Result |
| --- | --- |
| Direct to bridge: connect (spawns the child) | 222 to 255 ms |
| Direct: playwright `browser_navigate` / convex `status` | 487 ms / 833 ms |
| Through Executor: convex `status` tool time (3 runs) | 951 to 977 ms (1.16 to 1.20 s wall from a fresh client) |
| Through Executor: playwright navigate to `approval-required` | 243 ms |
| Through Executor: navigate after accept / snapshot | 568 ms / 307 ms |
| Executor sessions per 3 convex calls | about 8, every one closed; the cgroup was back to the gateway alone |
| App create / deploy | 50 ms / 548 ms |
| `kill -9` of the main process, to healthy | 2.5 s, 0 orphans |
| `kill -9` of supergateway itself, to healthy | 2.3 s, 0 orphans |
| `kill -9` of a session's child | 1.0 s, 0 orphans |
| `systemctl --user restart cairn-bridges` / stop then start | 1.05 s / 1.06 s, 0 orphans |
| `systemctl --user restart executor`: bridge healthy / Executor healthy / first call answered | 1.6 s / 1.6 s / 2.35 s, 0 orphans |
| Unit memory, idle with Chrome | 359 MiB (gateway 129 MiB RSS) |
| One open session's child, PSS | convex 106 MiB, playwright 93 MiB |
| Abandoned session's child, still alive 630 s later (10 minute timeout) | 0 of 1 |

The judge is `judges/bridge-orphans.sh` (kept code). Each case runs `warm.sh`, which leaves two direct sessions abandoned open and makes one call through Executor, then fails the case if any descendant of the main process has left the cgroup, records every PID in the cgroup plus any that left, applies the event, and counts recorded PIDs alive outside the cgroup. Last run:

```
kill9-main         before 18 procs, healthy after   2611 ms, after 15 procs, orphans 0
kill9-child        before 18 procs, healthy after   1017 ms, after 18 procs, orphans 0
restart-unit       before 20 procs, healthy after   1051 ms, after 15 procs, orphans 0
stop-start-unit    before 18 procs, healthy after   1056 ms, after 15 procs, orphans 0
restart-peer       before 18 procs, healthy after   1333 ms, after 18 procs, orphans 0
```

### Chrome leaves the cgroup unless stopped

The first judge passed while Chrome's main process sat outside the unit: Chrome asks systemd over the session bus for a scope of its own (`app-org.chromium.Chromium-<pid>.scope`), so the unit's stop no longer reaches it, and the judge only recorded PIDs inside the cgroup. Starting Chrome with `DBUS_SESSION_BUS_ADDRESS` unset keeps it in place (checked against plain, no bus, no bus and no runtime dir, and `disabled:`; all but plain stay put). The judge now checks for escapes, and with the old launch restored it caught Chrome on every case and counted it as an orphan once.

"Cairn restart" has no case: the bridges are not Cairn's children, so a Cairn restart doesn't touch them. A client killed mid-session (what `hold.ts` simulates) leaves its child inside the cgroup until the session timeout, which is a bounded leak, not an orphan.

## Decisions

- **systemd owns the bridges, not Cairn's process, and nothing in them may talk to the session bus.** supergateway starts each child detached in its own process group, so a `kill -9` of the gateway alone would orphan them. A unit's cgroup ends them all, whatever the process groups. Cairn manages the unit (writes `gateway.json`, restarts it); it doesn't parent the processes.
- **One gateway on one port for every stdio server.** Cairn has three ports, so one per server doesn't scale. The cost: changing the server list restarts every bridge.
- **Stateful servers get a long-lived backend outside the per-session child**, as playwright does with its CDP browser. A stdio server whose state lives in its own process can't keep it across Executor calls.
- **The user accepted** instance-wide private fetch (ADR 0014 accepted) and one shared browser for every thread, on 2026-10-21.
- **Approvals follow the quick-add rule for now.** Playwright marks even `browser_tabs` destructive, so every navigation or click asks. S4 decides whether Cairn's own approval stands in for Executor's; the user wants a way past asking on every navigation.

## Noticed

- Two declined approvals and one left pending from the first navigate attempt (it expires after 10 minutes).
- `~/.claude.json`'s playwright server now points at chromium 1243. Its `--cdp-endpoint http://127.0.0.1:9222` still has nothing listening; Cairn's Chrome is on 3775.
- playwright writes snapshots to `--output-dir`, now `~/.local/state/cairn/playwright`; by default it wrote `.playwright-mcp/` into the working directory.

## Files

- `bridges/`: the unit, `run.sh` and `gateway.json`.
- `executor-app/`: the Executor app. `deploy.ts` creates or redeploys it with every file; `connect.ts` connects its account.
- `mcp.ts`: Executor's MCP with the setup token. `api.ts`: its HTTP API. `bridge.ts`: a bridge directly. `hold.ts`: abandon a session. `warm.sh`: the judge's warm-up.
