// The kill-in-nudge case: b ends without submit_result, is nudged, and pauses 3 s before it
// answers the nudge, so a kill lands while its child is still answering.
export const meta = {
  name: "kill-in-nudge",
  description: "Three nodes at once (b nudged), then one",
  phases: [{ title: "Fan" }, { title: "After" }],
};

const LABEL = {
  type: "object",
  properties: { label: { type: "string" } },
  required: ["label"],
};

phase("Fan");
const [a, b, c] = await parallel([
  () => agent("node:a ms=300", { label: "a" }),
  () => agent("node:b ms=300 lazy nudgems=3000", { label: "b", schema: LABEL }),
  () => agent("node:c ms=300", { label: "c" }),
]);
phase("After");
const d = await agent("node:d ms=300", { label: "d" });
return { a, b, c, d };
