// The node stop matrix's workflow: three nodes at once, b the longest, then d. A stopped node is
// null to the script, which goes on.
export const meta = {
  name: "stop-matrix",
  description: "Three nodes at once, then one",
  phases: [{ title: "Fan" }, { title: "After" }],
};

phase("Fan");
const [a, b, c] = await parallel([
  () => agent("node:a ms=1500", { label: "a" }),
  () => agent("node:b ms=4000", { label: "b" }),
  () => agent("node:c ms=1500", { label: "c" }),
]);
phase("After");
const d = await agent("node:d ms=3000", { label: "d" });
return { a, b, c, d };
