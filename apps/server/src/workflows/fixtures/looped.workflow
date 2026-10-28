// A looped workflow for the dry-run judge: each round hunts for bugs the earlier rounds missed and
// verifies what it found, until a round comes back empty. How many rounds run depends on what the
// nodes answer, so a dry run cannot count them: it must stop at its cap and say "at least".
export const meta = {
  name: "hunt-until-dry",
  description: "Hunt for bugs round after round until a round finds nothing new",
  phases: [{ title: "Hunt" }, { title: "Verify" }],
};

const FINDINGS = {
  title: "findings",
  type: "object",
  required: ["bugs"],
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "file"],
        properties: { title: { type: "string" }, file: { type: "string" } },
      },
    },
  },
};

const found = [];
let round = 0;

for (;;) {
  round += 1;
  phase("Hunt");
  const batch = await agent(
    "Find bugs in " + args.scope + " that are not already in this list: " + JSON.stringify(found.map((bug) => bug.title)),
    { role: "@scout", label: "Hunt round " + round, schema: FINDINGS, readonly: true }
  );
  if (batch === null || batch.bugs.length === 0) break;
  phase("Verify");
  const verified = await pipeline(batch.bugs, (bug) => verify(bug, { role: "@verifier", claim: bug.title }));
  found.push(...batch.bugs.filter((bug, i) => verified[i] && verified[i].verdict === "verified"));
  log("Round " + round + ": " + batch.bugs.length + " found, " + found.length + " verified so far");
}

return found;
