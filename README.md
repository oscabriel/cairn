# Cairn

One person's agent harness control plane, in the spirit of t3code and built on pi-durable: a brain at home, arms in the cloud. Hand work to agents from any device, walk away, and come back to results an outside judge has already checked.

## Where it stands

Phases 0 to 2 are done: the brain runs on the Beelink as a user unit, the web app is served at `code.gneiss.run` behind the owner check, and threads, subagents, workflows and approvals are durable on pi-durable. Phase 3 (stones on Cloudflare) is planned in `docs/phase-3/plan.md` and waits on two decisions it names: spike 11's cold start and the coordinator question.

## Where to read

- `AGENTS.md`: how the repository works, the rules every change follows, and where the kickoff was amended.
- `GLOSSARY.md`: Cairn's words.
- `docs/decisions/`: why it is shaped this way, one ADR per decision.
- `docs/coding-standards.md`: the standard.
- `docs/phase-<n>/`: each phase's plan, area notes and integration notes.
- `spikes/<n>-<name>/NOTES.md`: measured numbers against each spike's gate.

## Running it

Node 26.11 or later and pnpm (the version in `package.json`).

```sh
pnpm install
pnpm check   # the gate: format, lint, typecheck and test; one line when it passes
pnpm dev     # a dev brain and the web client on ephemeral loopback ports, never the deployed 3774
```

Steps only the user can do (logins, consent, Caddy edits) are wizard scripts under `ops/wizards/`, one per phase.
