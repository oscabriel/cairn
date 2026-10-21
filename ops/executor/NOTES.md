# Executor operations notes

Executor 2.0.0-beta.25 (`ghcr.io/usefulsoftwareco/executor-selfhost@sha256:5cb26b28…`, revision 92f85f4), installed 2026-10-21 by `install.sh` and the phase 0 wizard. Organization "Cairn", slug `executor`.

## Fixes applied by hand

Installed apps are copies: reinstalling one from the catalog or regenerating it loses these.

- **Built-in Executor app repointed at `https://exec.gneiss.run`.** Owner setup ran over loopback (so nobody on the tailnet could race it), and Executor generated its built-in app then from `http://localhost:4400/openapi.json`. That address was baked into `index.ts`, `openapi.json` and `provider.ts`, and apps may reach only public addresses, so every call failed with `NetworkRefused (private_address)`. Fixed with commit `aaab95f` (every `http://localhost:4400` replaced) through `POST /apps/{app}/commits` and `/deploy`. The provider's OAuth `discover` URL changed with it, so the setup-time account no longer fit and was reconnected in the dashboard.
- **GitHub app health check sends `User-Agent: Executor`.** `@executor.sh/github`'s `health` fetches `https://api.github.com/user` without a User-Agent, and GitHub refuses such requests with 403, so the account shows "check failed" although its tools work (their OpenAPI path sends one). Same bug v1 hit on beta.23. Fixed with commit `7d1ee5e`. Not reported upstream yet.

## Settings for the stdio relay

The unit sets two settings for spike 5's stdio relay (ADR 0014, `spikes/5-stdio-bridges/NOTES.md`):

- `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true` lets apps reach private, loopback and LAN addresses. It is instance-wide: there is no per-app or per-host allowance.
- `EXECUTOR_URL_ALLOW_HTTP_ORIGINS=["http://host.docker.internal:3776"]` lets an app's MCP URL use plain HTTP to the relay's origin.

The container reaches the host through ufw's rule `allow in on docker0 to 172.17.0.1 port 3776` (stage 8 of `ops/wizards/phase-0.sh`); without it requests time out.

## Gotcha: quick add refuses keyed MCP servers

`POST /apps/import` with `{source: {kind: "mcp", name, url}}` refuses a server that answers 401 with a bearer challenge and no OAuth metadata (`agent_setup_required`). Write the app by hand with `mcpRouter` and an API-key provider. An app's own account connects over the HTTP API without the browser: `POST /apps/{app}/accounts/app/{requirement}/connections` returns a `con_` id, then `POST /connections/{con}/submit` with `{method, label, fields}`. Send secrets this way, never as MCP tool arguments, which Executor's traces may record.

## Gotcha: commits replace the whole tree

`POST /apps/{app}/commits` takes the complete file list. Sending only the changed file deletes the rest (it reports them under `removed`). Always send every file from `GET /apps/{app}/workspace`.

## Fresh install

A fresh install should finish owner setup and then expect the built-in app fix above, or set up with `BETTER_AUTH_URL=https://exec.gneiss.run` from the start behind a Caddy route that only the owner's device can reach.
