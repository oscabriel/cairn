---
status: accepted
gate: a conformance scenario in which a subagent's question is answered by its parent without reaching the user, and another the parent cannot settle is answered by the user in the parent thread
---

# The user is the top, and a child asks its parent

Ultimate (HazAT/ultimate) puts a standing agent, @ultimate, between the user and every branch: it decides what reaches the user, and nothing else may message them. Cairn has no such tier. The user is the top. A subagent's or stone's question goes to its parent first, and only what the parent cannot settle reaches the user, shown in the parent thread where it is answered like any approval.

The routing is code, not prompt rules. Ultimate's version holds only because its prompts tell agents not to message the user directly. Cairn's durable approvals and the derived inbox already decide what the user sees, and a standing agent would be one more model making that choice.

Decided by the user on 2026-10-27.

Amended on 2026-10-27 with the routing rules (`docs/phase-2/notes/briefs.md` and `subagents.md`). Only questions route to the parent; an approval is always the user's, shown as a card in the parent thread, and the parent's reply tool refuses an approval id. A child's question is a record in the child's own approvals. The parent's model answers it or escalates it; it escalates by itself when the parent's run ends, fails or parks, or 15 minutes after the parent's model first saw it. Escalation writes the child's record and a mirror in the parent's approvals in one commit, so an answer from either thread resolves it exactly once.

Accepted at the wave 4 integration (2026-10-29). Gate evidence: both gate scenarios (a question the parent answers without reaching the user; one the parent cannot settle, answered by the user in the parent thread) and the question rows pass on pi-durable and scripted in the conformance suite, inside the green `pnpm check` on `main`. As built (4B), `answer_child` and `escalate` are actions of `subagent_reply`; only `escalate` carries a reason, since the answer text is what the child reads.
