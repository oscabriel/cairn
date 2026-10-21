# Executor operations notes

Executor 2.0.0-beta.25 (`ghcr.io/usefulsoftwareco/executor-selfhost@sha256:5cb26b28…`, revision 92f85f4), installed 2026-10-21 by `install.sh` and the phase 0 wizard. Organization "Cairn", slug `executor`.

## Fixes applied by hand

Installed apps are copies: reinstalling one from the catalog or regenerating it loses these.

- **Built-in Executor app repointed at `https://exec.gneiss.run`.** Owner setup ran over loopback (so nobody on the tailnet could race it), and Executor generated its built-in app then from `http://localhost:4400/openapi.json`. That address was baked into `index.ts`, `openapi.json` and `provider.ts`, and apps may reach only public addresses, so every call failed with `NetworkRefused (private_address)`. Fixed with commit `aaab95f` (every `http://localhost:4400` replaced) through `POST /apps/{app}/commits` and `/deploy`. The provider's OAuth `discover` URL changed with it, so the setup-time account no longer fit and was reconnected in the dashboard.
- **GitHub app health check sends `User-Agent: Executor`.** `@executor.sh/github`'s `health` fetches `https://api.github.com/user` without a User-Agent, and GitHub refuses such requests with 403, so the account shows "check failed" although its tools work (their OpenAPI path sends one). Same bug v1 hit on beta.23. Fixed with commit `7d1ee5e`. Not reported upstream yet.

## Gotcha: commits replace the whole tree

`POST /apps/{app}/commits` takes the complete file list. Sending only the changed file deletes the rest (it reports them under `removed`). Always send every file from `GET /apps/{app}/workspace`.

## Fresh install

A fresh install should finish owner setup and then expect the built-in app fix above, or set up with `BETTER_AUTH_URL=https://exec.gneiss.run` from the start behind a Caddy route that only the owner's device can reach.
