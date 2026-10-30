// The node stop matrix's stop-then-budget case: b is stopped after its child spoke, then the
// script reads the budget. The stopped node's spend must still count.
export const meta = {
  name: "stop-budget",
  description: "Two nodes at once, one stopped, then a budget reading",
  phases: [{ title: "Fan" }],
};

phase("Fan");
const [a, b] = await parallel([
  () => agent("node:a ms=300", { label: "a" }),
  () => agent("node:b ms=4000", { label: "b" }),
]);
const spent = await budget.spent();
return { a, b, spent };
