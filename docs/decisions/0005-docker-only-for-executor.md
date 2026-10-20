# Docker only for Executor

Executor may run in Docker; nothing else in Cairn does by default. Threads run directly on the host in the project checkout or a git worktree, so agents keep the user's skills, clone shelf and config (v1's Docker sandboxes set `HOME=/tmp` and agents re-cloned repos). Stones run entirely on Cloudflare from one generic base image built off the Beelink, pushed to `registry.cloudflare.com` and referenced by digest, so Alchemy never needs local Docker. Anything that still seems to need local Docker goes to the user with the reason and alternatives first.
