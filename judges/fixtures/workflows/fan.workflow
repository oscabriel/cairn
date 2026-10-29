// The kill matrix's workflow: three nodes at once (one typed), then one more. Each node's child
// works `ms` before it answers, so a kill lands mid fan-out.
export const meta = {
  name: "kill-matrix",
  description: "Three nodes at once, then one",
  phases: [{ title: "Fan" }, { title: "After" }],
};

const LABEL = {
  type: "object",
  properties: { label: { type: "string" } },
  required: ["label"],
};

phase("Fan");
const [a, b, c] = await parallel([
  () => agent("node:a ms=1500", { label: "a" }),
  () => agent("node:b ms=2500 typed", { label: "b", schema: LABEL }),
  () => agent("node:c ms=1500", { label: "c" }),
]);
phase("After");
const d = await agent("node:d ms=300", { label: "d" });
return { a, b, c, d };
