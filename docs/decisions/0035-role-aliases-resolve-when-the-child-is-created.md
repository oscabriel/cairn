---
status: proposed
gate: J-roles from `docs/phase-2/notes/models.md`, including the changed-table scenario, and the brief card blocking Go on an unbound role
---

# Role aliases resolve when the child is created

Briefs, workflow scripts and recipes name roles (`@worker`, `@scout`, `@judge`, `@verifier`, and any the user adds), never models. The commit that dispatches a child writes the concrete model into the child's `pi.agent` and the dispatch record, and the child keeps it for life: changing the role table later never rewrites finished or running work. Fallbacks are tried at dispatch only. The table lives in server settings, global, with a per-launch override on a workflow's approval; per-project bindings can come later.

Defaults, on the user's confirmation: `@worker` Opus 5.5 at medium, `@scout` Sonnet 5.5 at high, `@judge` `opencode-go/gpt-6-luna`, `@verifier` `opencode-go/gpt-6-luna` (Codex `gpt-6-luna` until 2026-10-29, when the user said there is no Codex subscription; a table seeded before then keeps its Codex primary with the OpenCode Go model as its fallback, since a seeded table never moves). The brief card shows each role's resolved model and blocks Go on an unbound role; it warns when `@judge` or `@verifier` shares `@worker`'s model family.

Decided by the user on 2026-10-27, from the phase 2 area notes.
