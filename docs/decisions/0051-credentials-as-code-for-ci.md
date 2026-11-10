---
status: proposed
gate: the user runs `ops/wizards/phase-3.sh 2`: the stack deploys under the `admin` profile, Cloudflare lists `cairn-ci` with Workers Containers Write alone, and a manual run of the `stone image` workflow still logs in to the registry and pushes
---

# Credentials as code for CI

Amends ADR 0006 ("one root stack", "the only Cloudflare credential").

## What it is

`stacks/github.ts` is a second Alchemy stack, `CairnGitHub`, added in phase 0 (`0a878b0`). It mints one account-owned Cloudflare API token, `cairn-ci`, and writes it with the account id to `oscabriel/cairn` as the Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token value goes from Cloudflare into Alchemy's state and on to GitHub; it never appears on a screen or in the repository. The only reader is `.github/workflows/stone-image.yml`, which asks Cloudflare for short-lived registry credentials (`POST .../containers/registries/registry.cloudflare.com/credentials`) and pushes the stone image, so the Beelink never runs Docker for it (ADR 0005). The stack holds nothing the brain or a stone uses.

## Why a second stack

Creating an account-owned token needs the account's API Tokens Write permission, which the user's Alchemy OAuth profile (`default`, the root stack's credential) cannot carry. If the token lived in `alchemy.run.ts`, every deploy of the root stack would need that stronger credential. Kept apart, the root stack deploys under OAuth as ADR 0006 says, and the CI stack deploys rarely, by hand, through a wizard. Its state is a separate stack in the same Cloudflare state store, so this is not v1's three state roots: one store, two stack names.

## Which profile

The `admin` Alchemy profile, created by `ops/wizards/phase-0.sh` stage 6 (and again by `ops/wizards/phase-3.sh` stage 2 when it is missing) with the Cloudflare Global API Key and the GitHub CLI. The phase 0 wizard deletes the profile after the deploy; the handoff of 2026-11-09 says a stored Global API Key is still in `~/.alchemy` under that profile. Whether to keep it is the user's decision. A narrower credential for the profile is possible (Alchemy accepts an API token, and an account-scoped token with Account API Tokens Write, plus what the state store needs, can mint `cairn-ci`), but it is untested.

## The token's scope

Workers Containers Write on the account, nothing else: what the registry credentials call needs. Until 2026-11-09 the token also carried Workers Scripts Write, Secrets Store Write and Account Settings Write "for Alchemy's state store", which only a CI job that runs Alchemy would use, and none does. With those, a leaked secret could replace any Worker on the account, including phase 3's stones Worker and the state store's own Worker. If CI ever deploys with Alchemy, that job gets a second token of its own, minted then, and this ADR is amended.

What remains: a leaked `cairn-ci` can push images to the account's registry and write its container applications. Stones run an image by the digest committed in the repository (ADR 0005), so a pushed image reaches a stone only through a committed digest. The workflow pins its actions by commit, reads `contents` only, and runs on pushes to `main` and by hand.

## Consequences

- The policy change applies only when the user deploys the stack (`ops/wizards/phase-3.sh` stage 2). Until then the live token keeps its old rights.
- The deploy is a beta.85 run against the shared state store; every stack and spike in the repository is on the catalog's Alchemy, so the store's move to v8 is expected (`docs/phase-3/plan.md`, wave rules).
- Coding standard S51 names this stack as the one exception to "the only Stack".
