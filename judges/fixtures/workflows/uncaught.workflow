// The node stop matrix's uncaught case: the script reads b's answer without checking for null, so
// stopping b fails the script; after a kill nothing reruns.
export const meta = {
  name: "stop-uncaught",
  description: "Two nodes at once, read without a null check",
  phases: [{ title: "Fan" }],
};

phase("Fan");
const [a, b] = await parallel([
  () => agent("node:a ms=1500", { label: "a" }),
  () => agent("node:b ms=4000", { label: "b" }),
]);
const after = await agent("node:d ms=300", { label: "d" });
return { a, b: b.length, after };
