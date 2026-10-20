---
status: proposed
gate: S5
---

# Stdio MCP servers run behind supervised bridges

Executor v2 can't start local processes, so each stdio MCP server (`convex`, `playwright`, the project-scoped `myr`) runs behind a stdio-to-Streamable-HTTP bridge such as supergateway that Cairn supervises on the Beelink, registered in Executor as a remote MCP app. A project-scoped server runs one bridge per project with the project as its working directory. A server that can't be carried this way gets an exception agreed with the user.

Gate S5: an agent in a thread calls `convex` and `playwright` through Executor, and a Cairn or Executor restart leaves no orphaned bridge process.
