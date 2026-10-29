// The node stop matrix's mark-kill case: b ignores its abort for 5 s, so a kill lands between the
// abort mark and the node seeing it.
export const meta = {
  name: "stop-deaf",
  description: "Three nodes at once, b slow to stop, then one",
  phases: [{ title: "Fan" }, { title: "After" }],
};

phase("Fan");
const [a, b, c] = await parallel([
  () => agent("node:a ms=1500", { label: "a" }),
  () => agent("node:b ms=8000 deaf=5000", { label: "b" }),
  () => agent("node:c ms=1500", { label: "c" }),
]);
phase("After");
const d = await agent("node:d ms=300", { label: "d" });
return { a, b, c, d };
