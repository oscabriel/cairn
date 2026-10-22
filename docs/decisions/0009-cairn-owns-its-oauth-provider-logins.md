---
status: accepted
---

# Cairn owns its OAuth provider logins

Cairn reads `~/.pi/agent` with pi's own loaders and never writes to it. That works for API keys (`opencode-go`), but an OAuth provider such as `openai-codex` rotates its refresh token: a read-only Cairn refreshing in memory would invalidate the pi CLI's stored token, and two holders of one grant break each other. So Cairn keeps its own credential store for OAuth providers, seeded by its own login (device code from any device), and reads only API keys from `~/.pi/agent`.

The only Codex model available is `openai-codex/gpt-6-luna` (legacy login, no ChatGPT plan).

Confirmed on 2026-10-21 by reading pi-ai 1.3.0. `refreshStoredOAuthCredential` (`dist/auth/resolve.js`) refreshes under the credential store's lock and persists the result before releasing it. Codex's refresh (`dist/auth/oauth/openai-codex.js`) requires a new `refresh_token` in the response and stores it, so every refresh rotates the token. A Cairn that only reads `~/.pi/agent` could not persist the rotation and would strand whichever copy refreshed second.
