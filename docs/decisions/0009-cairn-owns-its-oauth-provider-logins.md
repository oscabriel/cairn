---
status: proposed
---

# Cairn owns its OAuth provider logins

Cairn reads `~/.pi/agent` with pi's own loaders and never writes to it. That works for API keys (`opencode-go`), but an OAuth provider such as `openai-codex` rotates its refresh token: a read-only Cairn refreshing in memory would invalidate the pi CLI's stored token, and two holders of one grant break each other. So Cairn keeps its own credential store for OAuth providers, seeded by its own login (device code from any device), and reads only API keys from `~/.pi/agent`. To be confirmed in phase 0 by checking pi-ai's refresh behaviour.

The only Codex model available is `openai-codex/gpt-6-luna` (legacy login, no ChatGPT plan).
