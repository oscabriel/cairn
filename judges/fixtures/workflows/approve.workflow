// The kill matrix's approval case: the script asks the user before its one node, and the brain is
// killed while the question waits.
export const meta = {
  name: "kill-approve",
  description: "Ask, then run one node",
  phases: [{ title: "Ask" }],
};

phase("Ask");
const ok = await approve({ summary: "Run the node?" });
if (ok === null || !ok.accepted) return "not approved";
const a = await agent("node:a ms=500", { label: "a" });
return { ok, a };
