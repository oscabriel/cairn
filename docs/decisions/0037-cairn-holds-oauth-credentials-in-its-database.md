---
status: proposed
gate: the user's real Codex login through the phase 2 wizard, and J-codex's rotation test
---

# Cairn holds OAuth credentials in its database, one holder at a time

ADR 0009 decided that Cairn owns the logins of OAuth providers. This records how: credentials live in an `oauth_credentials` table in `cairn.sqlite`, one brain holds a provider's lock at a time (extending the Executor grant's lock), a brain without the lock reports the provider unavailable, and the login is pi-ai's device-code flow, which the user can finish from the phone. Codex is the first provider, and the third provider of the typed-results target; if the login is unavailable, `opencode-go/gpt-6-luna` is the recorded fallback.

Codex plan windows are read from its undocumented usage endpoint (as MonoCode does), behind a schema decode that shows "unreadable" when the response changes.

Decided by the user on 2026-10-27, from the phase 2 area notes.
