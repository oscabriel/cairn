// A loop-free workflow for the dry-run judge: read each file, verify each reading, then one summary.
// Its node count is fixed by its arguments, so the dry run must count exactly what a run dispatches:
// two nodes per file and one more.
export const meta = {
  name: "review-modules",
  description: "Read each module, verify the findings, then summarise",
  phases: [{ title: "Read" }, { title: "Summarise" }],
};

const FINDINGS = {
  title: "findings",
  type: "object",
  properties: { issues: { type: "array", items: { type: "string" } } },
};

phase("Read");
const reads = await pipeline(
  args.files,
  (file) => agent("Read " + file + " and list its issues", { role: "@scout", label: "Read " + file, schema: FINDINGS, readonly: true }),
  (found, file) => verify(found, { claim: "the issues in " + file + " are real" })
);

phase("Summarise");
const summary = await agent("Summarise these reviews:\n" + JSON.stringify(reads), { label: "Summary" });

return { reads, summary };
