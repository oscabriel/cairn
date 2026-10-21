#!/usr/bin/env bash
# Spike 5: leave work in the bridges for the judge. Two direct sessions are abandoned open (as by a
# killed client), and one convex call goes through Executor.
set -euo pipefail
cd "$(dirname "$0")"
node hold.ts playwright browser_tabs '{"action":"list"}'
node hold.ts convex status "{\"projectDir\":\"$HOME/Developer/projects/nouveau/packages/backend\"}"
node mcp.ts call "{\"calls\":{\"path\":\"tools[\\\"cairn-bridges\\\"].convex.status\",\"input\":{\"projectDir\":\"$HOME/Developer/projects/nouveau/packages/backend\"}}}" | grep -q '"ok":true'
