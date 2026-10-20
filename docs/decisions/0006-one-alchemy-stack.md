# One Alchemy stack for every Cloudflare resource

Every Cloudflare resource is declared with Alchemy 2 (`alchemy@2.0.0-beta.83`, `alchemy/Cloudflare` imports, the `default` profile) in one root stack, `alchemy.run.ts`; Wrangler is never used, and the user's Alchemy OAuth profile is the only Cloudflare credential. v1 ran three stacks and paid for it in three state roots and three credential files. Telemetry goes from Effect's Otlp layer to Axiom, with datasets and ingest tokens provisioned in the same stack.

## Consequences

- Alchemy's docs on `main` import `@alchemy.run/cloudflare`, which isn't published yet (npm has a 0.0.0 placeholder). Moving to it is a one-line import change per file when it ships.
- A permanent `ops` stack (backups, observability, `RemovalPolicy.retain()`) may split out later.
