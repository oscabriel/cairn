// The envelope cases (plan 5A, ADR 0032): four nodes the plan shows, then a fifth whose role the
// data picks. The dry run's placeholder answers send it to `@worker`, so the launch shows one role
// and five nodes; the live answers send it to `@scout`, which the envelope never granted, so it
// raises its own brief card.
export const meta = {
  name: "envelope",
  description: "Four nodes inside the launch's envelope and one outside it",
  phases: [{ title: "Fan" }],
};

phase("Fan");
const found = await parallel(
  ["a", "b", "c", "d"].map((item) => () => agent(`node:${item} ms=300`, { label: item }))
);
const live = !String(found[0]).startsWith("(dry run");
const e = await agent("node:e ms=300", { label: "e", role: live ? "@scout" : "@worker" });
return { found, e };
