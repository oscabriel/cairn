---
status: proposed
gate: a conformance scenario in which a subagent's question is answered by its parent without reaching the user, and another the parent cannot settle is answered by the user in the parent thread
---

# The user is the top, and a child asks its parent

Ultimate (HazAT/ultimate) puts a standing agent, @ultimate, between the user and every branch: it decides what reaches the user, and nothing else may message them. Cairn has no such tier. The user is the top. A subagent's or stone's question goes to its parent first, and only what the parent cannot settle reaches the user, shown in the parent thread where it is answered like any approval.

The routing is code, not prompt rules. Ultimate's version holds only because its prompts tell agents not to message the user directly. Cairn's durable approvals and the derived inbox already decide what the user sees, and a standing agent would be one more model making that choice.

Decided by the user on 2026-10-27.
