# Cairn

One person's agent harness control plane: a web app whose brain (pi-durable) runs on the Beelink and whose arms reach out to Cloudflare. The brief, requirements, targets and build order live in `~/Developer/agent-artifacts/cairn/v2/KICKOFF.md`; frozen research sits beside it in `research/`. Read the kickoff before starting a phase, and the research report for an area before designing in it.

## Words

`GLOSSARY.md` is the single source of truth for Cairn's vocabulary (thread, stone, arms, brain, workflow, portal...). Use its terms in code, UI and prose. When a new term settles or an old one shifts, update the glossary in the same change.

## The gate

`pnpm check` (format, type-aware lint, typecheck, test) is the outer gate, and warnings fail it. A step is done when its outside judge says so: a test, a conformance suite, a screenshot comparison, a `kill -9` script, or the user. Looking right is not done.

## Before using an API

- Read `node_modules/effect/AGENTS.md` before writing Effect code, then the installed source for the module you use. Effect 4 differs from what you remember.
- Read installed `node_modules` source for alchemy and the `@earendil-works/*` (pi) packages before using their APIs. For pi-durable, read `docs/spec.md` §12 ("API footguns") before writing harness code.
- Alchemy is pinned at `2.0.0-beta.83`: import `alchemy/Cloudflare`. The docs at main.alchemy.run describe the unpublished `@alchemy.run/cloudflare`; trust the installed source where they differ.

## Code

- `docs/coding-standards.md` is the standard. Effect's own conventions win every conflict (ADR 0004).
- Code drawn from another repo is a port of intent: rewrite it to our standards, and start the file with a header naming the source repo, path and commit, plus the MIT notice when the source is MIT. t3code is pinned at `fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92`, the commit of the `t3code-nightly-bin` build installed on the Beelink, which parity is judged against (ADR 0015). Its sparse clone lives at `~/Developer/clones/github.com/pingdotgg/t3code`; missing paths come from `git show fe27e8e3:<path>`.
- Versions that move together are pinned once, in the `pnpm-workspace.yaml` catalog: `effect` with every `@effect/*` package; oxlint, oxlint-tsgolint, `@oxlint/plugins`, TypeScript and `@effect/tsgo`; the `@earendil-works/*` packages; the Agent SDK with its bundled `claude`.
- Decisions that are hard to reverse get a short ADR in `docs/decisions/`. Gated decisions stay `status: proposed` until their gate passes.

## Spikes

Throwaway code goes under `spikes/<n>-<name>/`, each with a `NOTES.md` of measured numbers against its gate and the decision it made. Read v1's spike notes in `~/Developer/projects/cairn-v1/spikes/*/NOTES.md` before re-measuring anything. Judges that later phases reuse (the typing test, the screenshot harness, kill scripts) are kept code, not spikes.

## The user's machine

- `~/.pi/agent` and `~/Developer/clones` are read-only. Read the pi clone with `git show origin/main:<path>`, because its working tree is stale.
- Never print values from `auth.json`, `mcp-auth.json`, `~/.alchemy`, `~/.codex` or Executor's data volume. Check a credential's kind by its prefix only.
- Docker is for Executor only (ADR 0005). Caddy runs in Docker at `~/caddy`; back up `~/caddy/conf/Caddyfile` before editing it. There is no sudo.
- Thread stores live on the NVMe under `/home`, never the NAS.
- Loopback ports: t3code nightly holds 3773 (`t3.gneiss.run`) and Executor holds 4400. Cairn uses 3774 to 3776.
- Steps only the user can do (logins, browser consent) go into one `wizard` script per phase.

## Writing for the user

Plans and pages for the user go under `~/Developer/agent-artifacts/cairn/`, served at `https://plans.gneiss.run/cairn/`. Docs and pages use sentence-case headings and no em dashes.
