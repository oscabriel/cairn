// Council: two to four read-only advisors answer one question without seeing each other, a judge
// sorts their claims into agreements and disputes, and each advisor is resumed to answer only the
// claims another advisor disputed. Five nodes with two advisors and two passes.
//
// Cairn's built-in `council` recipe (recipes/index.ts lists it and launches it by name). Ported in
// intent from pi-subagents' council mode (github.com/nicobailon/pi-subagents,
// skills/council-mode/SKILL.md and references/pass-contracts.md at 1a80e24) as
// docs/phase-2/notes/workflows.md ("The council recipe") records its rules; no text was taken.
// Changed: the passes are one workflow script over Cairn's prelude, the claim matrix is a judge node
// (a script has no model of its own), and each advisor's later pass resumes its previous node. An
// advisor that cannot be resumed answers in a fresh node given its own report, labelled
// "fresh-context fallback, not true cross-exam"; a fallback node is not in the plan's count, so on
// a launch it asks the user before it starts. A stopped or refused node is never retried.
//
// MIT License. Copyright (c) 2026 Nico Bailon
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
export const meta = {
  name: "council",
  description: "Independent advisor reports, a claim matrix, then one cross-examination pass",
  whenToUse: "A decision with real trade-offs, where independent second opinions are worth five nodes",
  phases: [
    { title: "Reports", detail: "Each advisor answers alone" },
    { title: "Matrix", detail: "A judge sorts agreements from disputed claims" },
    { title: "Cross-examination", detail: "Each advisor answers the claims another disputed" },
  ],
};

const REPORT = {
  title: "advisor-report",
  type: "object",
  required: ["recommendation", "evidence", "assumptions", "risks", "confidence", "challengeClaims", "ownerDecisions", "changeMyMind"],
  properties: {
    recommendation: { type: "string" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "sources"],
        properties: { claim: { type: "string" }, sources: { type: "array", items: { type: "string" } } },
      },
    },
    assumptions: {
      type: "array",
      items: {
        type: "object",
        required: ["assumption", "status"],
        properties: { assumption: { type: "string" }, status: { enum: ["checked", "unchecked", "refuted"] } },
      },
    },
    risks: { type: "array", items: { type: "string" } },
    confidence: {
      type: "object",
      required: ["level", "reason"],
      properties: { level: { enum: ["low", "medium", "high"] }, reason: { type: "string" } },
    },
    challengeClaims: { type: "array", maxItems: 3, items: { type: "string" } },
    ownerDecisions: { type: "array", items: { type: "string" } },
    changeMyMind: { type: "string" },
  },
};

const MATRIX = {
  title: "claim-matrix",
  type: "object",
  required: ["agreements", "disputed", "evidenceCanSettle"],
  properties: {
    agreements: { type: "array", items: { type: "string" } },
    disputed: {
      type: "array",
      items: {
        type: "object",
        required: ["claimId", "claim", "madeBy", "challenge"],
        properties: {
          claimId: { type: "string" },
          claim: { type: "string" },
          madeBy: { type: "integer", minimum: 1 },
          challenge: { type: "string" },
        },
      },
    },
    evidenceCanSettle: { type: "boolean" },
  },
};

const RESPONSES = {
  title: "cross-examination",
  type: "object",
  required: ["responses", "recommendationChanged", "outOfScopeFindings"],
  properties: {
    responses: {
      type: "array",
      items: {
        type: "object",
        required: ["claimId", "disposition", "reason", "sources"],
        properties: {
          claimId: { type: "string" },
          disposition: { enum: ["accept", "reject", "refine", "owner-decision"] },
          reason: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
        },
      },
    },
    recommendationChanged: { type: "boolean" },
    outOfScopeFindings: { type: "array", items: { type: "string" } },
  },
};

const advisors = args.advisors;
if (!Array.isArray(advisors) || advisors.length < 2 || advisors.length > 4) {
  throw new Error("council needs args.advisors: two to four roles, for example [\"@worker\", \"@scout\"]");
}
if (typeof args.question !== "string" || args.question.trim() === "") {
  throw new Error("council needs args.question: the decision the advisors answer");
}
const judge = args.judge || "@judge";
const maxPasses = args.maxPasses === 3 ? 3 : 2;
const RELAY_PER_ADVISOR = 5;
const FALLBACK = "fresh-context fallback, not true cross-exam";

const brief =
  "Question: " + args.question +
  "\nScope: " + (args.scope || "as the question states") +
  "\nNot in scope: " + (args.nonGoals || "nothing stated") +
  "\nEvidence to start from: " + (args.evidence || "none given");

const reportPrompt = (n) =>
  brief +
  "\n\nYou are advisor " + n + " of " + advisors.length + ". Work alone and read only; do not spawn helpers." +
  " Answer in under 600 words: a recommendation, evidence with sources, assumptions and whether you checked them," +
  " risks, your confidence, at most three claims you would challenge in another answer, decisions only the owner can make," +
  " and what would change your mind.";

phase("Reports");
const pass1 = await parallel(
  advisors.map((role, i) => () =>
    agent.full(reportPrompt(i + 1), {
      role,
      label: "Advisor " + (i + 1) + " report",
      schema: REPORT,
      readonly: true,
      key: "advisor-" + (i + 1),
    })
  )
);
const reports = pass1.map((outcome) => (outcome && outcome.status === "ok" ? outcome.value : null));
const roster = advisors.map((role, i) => ({ advisor: i + 1, role, report: reports[i] !== null, crossExam: [] }));

if (reports.filter(Boolean).length < 2) {
  log("Fewer than two advisors reported; the council stops after its first pass.");
  return { pass1: reports, matrix: null, pass2: [], pass3: null, ownerDecisions: [], roster };
}

phase("Matrix");
const matrix = await agent(
  brief +
    "\n\nThese are independent advisor reports, numbered. List the claims they agree on, and the claims one advisor makes" +
    " that another's evidence disputes, at most " + RELAY_PER_ADVISOR + " per advisor, each with the advisor who made it" +
    " and the strongest challenge to it. Say whether more evidence could still settle a dispute.\n\n" +
    JSON.stringify(reports.map((report, i) => ({ advisor: i + 1, report }))),
  { role: judge, label: "Claim matrix", schema: MATRIX, readonly: true, key: "matrix" }
);

if (matrix === null) {
  log("The claim matrix did not come back; the council returns its first pass only.");
  return { pass1: reports, matrix: null, pass2: [], pass3: null, ownerDecisions: [], roster };
}

const packetFor = (n) =>
  matrix.disputed
    .filter((entry) => entry.madeBy === n)
    .slice(0, RELAY_PER_ADVISOR)
    .map((entry) => ({ claimId: entry.claimId, claim: entry.claim, challenge: "Another advisor: " + entry.challenge }));

// The node each advisor's next pass resumes: its report, then its latest cross-examination.
const latest = pass1.map((outcome) => (outcome && outcome.status === "ok" ? outcome.nodeId : null));

const examine = (pass) =>
  parallel(
    advisors.map((role, i) => async () => {
      const from = latest[i];
      if (from === null) return null;
      const ask =
        "Pass " + pass + ". Answer each challenged claim: accept, reject, refine or owner-decision, with a reason and sources." +
        " Say whether your recommendation changed, and list anything you found outside the scope.\n\n" +
        JSON.stringify(packetFor(i + 1));
      const resumed = await agent.full(ask, {
        role,
        label: "Advisor " + (i + 1) + " pass " + pass,
        schema: RESPONSES,
        readonly: true,
        resume: from,
        key: "advisor-" + (i + 1) + "-pass-" + pass,
      });
      if (resumed.status === "ok") {
        latest[i] = resumed.nodeId;
        roster[i].crossExam.push("resumed");
        return { advisor: i + 1, fallback: null, answer: resumed.value };
      }
      // A stop or a refusal (budget, grant) is the user's or the launch's word: no second node.
      if (resumed.status !== "failed") {
        latest[i] = null;
        roster[i].crossExam.push(resumed.status);
        return { advisor: i + 1, fallback: null, answer: null };
      }
      log("Advisor " + (i + 1) + " could not be resumed for pass " + pass + " (" + resumed.reason + "); asking a fresh node.");
      const fresh = await agent.full(
        brief + "\n\nYour earlier report:\n" + JSON.stringify(reports[i]) + "\n\n" + ask,
        {
          role,
          label: "Advisor " + (i + 1) + " pass " + pass + " (fresh)",
          schema: RESPONSES,
          readonly: true,
          key: "advisor-" + (i + 1) + "-pass-" + pass + "-fresh",
        }
      );
      latest[i] = fresh.status === "ok" ? fresh.nodeId : null;
      roster[i].crossExam.push(fresh.status === "ok" ? "fresh" : fresh.status);
      return { advisor: i + 1, fallback: FALLBACK, answer: fresh.status === "ok" ? fresh.value : null };
    })
  );

phase("Cross-examination");
const pass2 = await examine(2);
const pass3 = maxPasses === 3 && matrix.evidenceCanSettle ? await examine(3) : null;

const ownerDecisions = reports
  .filter(Boolean)
  .flatMap((report) => report.ownerDecisions)
  .concat(
    pass2
      .concat(pass3 || [])
      .filter((entry) => entry && entry.answer)
      .flatMap((entry) => entry.answer.responses)
      .filter((response) => response.disposition === "owner-decision")
      .map((response) => response.claimId)
  );

return { pass1: reports, matrix, pass2, pass3, ownerDecisions, roster };
