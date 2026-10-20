# Effect's conventions are the coding standard

Where Effect documents a convention (`node_modules/effect/AGENTS.md` and its ai-docs), Cairn follows it, even against the user's earlier source (cf-workflow-pool) or ultracite's defaults: barrel imports from `"effect"`, `Context.Service` with `static readonly layer`, PascalCase module files, `Effect.fn("Name.method")`. Other standards fill only the gaps Effect leaves, and are restated in Cairn's own words in `docs/coding-standards.md` because cf-workflow-pool has no license.

Code taken from t3code or any other repo is a port of functionality and intent, not of lines: it is rewritten to these standards and Cairn's architecture, and keeps a header naming the source repo, path and commit (plus the MIT notice where applicable). So ported files get no lint carve-out.
