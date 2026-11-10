# One Alchemy stack for every Cloudflare resource

Amended on 2026-11-09 (at the end): the pin and imports below are out of date, and a second stack holds CI's credentials (ADR 0051).

Every Cloudflare resource is declared with Alchemy 2 (`alchemy@2.0.0-beta.83`, `alchemy/Cloudflare` imports, the `default` profile) in one root stack, `alchemy.run.ts`; Wrangler is never used, and the user's Alchemy OAuth profile is the only Cloudflare credential. v1 ran three stacks and paid for it in three state roots and three credential files. Telemetry goes from Effect's Otlp layer to Axiom, with datasets and ingest tokens provisioned in the same stack.

## Consequences

- Alchemy's docs on `main` import `@alchemy.run/cloudflare`, which isn't published yet (npm has a 0.0.0 placeholder). Moving to it is a one-line import change per file when it ships.
- A permanent `ops` stack (backups, observability, `RemovalPolicy.retain()`) may split out later.

## Amendment: what holds today (2026-11-09)

The decision above stands for everything Cairn runs on Cloudflare. Three facts in it no longer hold:

- **Pin and imports.** Alchemy is at the `pnpm-workspace.yaml` catalog's pin, and providers come from their own packages, `@alchemy.run/cloudflare` and `@alchemy.run/github`, with the stack API from `alchemy` (coding standard S50, commit `800c6aa`). The first consequence above is done.
- **A second stack, on purpose.** `stacks/github.ts` (stack `CairnGitHub`) mints the CI token and writes the repository's Actions secrets. It deploys under the `admin` profile, not `default`, because the user's OAuth profile cannot mint tokens. ADR 0051 records it. So "one root stack" reads "one root stack for everything Cairn runs on, plus the CI credentials stack", and "the only Cloudflare credential" reads "the only credential the root stack deploys with". Both stacks keep their state in the account's one Cloudflare state store.
- **Telemetry is not built.** The root stack declares no resource yet, no Axiom dataset or ingest token is provisioned, and the brain exports OTLP only when the standard `OTEL_EXPORTER_OTLP_*` variables are set. The sentence about Axiom is the plan, not the state.
