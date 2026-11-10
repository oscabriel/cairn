// The folder import graph of `apps/server/src` (ADR 0053): what the server's modules load from one
// another (value imports), with each file at the root its own node. It is measured over every
// non-test file, test doubles included, but the doubles in `LEFT_OUT`, each listed by path with
// why its imports do not count: a double named elsewhere is in the graph like production code, so
// a new kit under `brain/` that imports a feature fails here. `brain/` imports no feature folder but
// the approval ledger, and the cycles that remain are exactly the ones listed here, each with why.
// The review of 2026-11-09 measured one cycle of 22 folders, `brain/` among them, over every
// non-test file. Measured so, less the `LEFT_OUT` doubles, it is the two cycles below; with those
// five doubles counted, `brain/` and the root's composition files rejoin one component of 23
// nodes, since the dev, judge and test brains assemble every feature (ADR 0053).

import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { FEATURES } from "./Features.ts";
import {
  cycles,
  folderEdges,
  isTestDouble,
  isTestDoubleUnder,
  SERVER_SOURCE,
  sourceFiles,
} from "./ImportGraphTestKit.ts";

/**
 * The test doubles whose imports the graph leaves out, by path, and why. None is loaded by the
 * deployed brain (`main.test.ts`); each imitates or assembles more than its own folder.
 */
const LEFT_OUT: ReadonlyMap<string, string> = new Map([
  [
    "brain/BrainTestKit.ts",
    "the brain tests' and judge brains' stack: the production extension set over every feature, with the features' test layers (subagents, reach, models, pi-host, Executor)",
  ],
  [
    "brain/ScriptedHarness.ts",
    "the dev and judge brains' harness imitates pi-durable's view of a thread, so it writes the features' documents and tools a scripted turn shows (approvals, a subagent's question and decision, goal documents, the result tool, model specs)",
  ],
  [
    "brain/conformance/Targets.ts",
    "the conformance suite runs the seam's contract over a harness with the subagents extension installed, over a child workspace",
  ],
  [
    "push/RequestTestKit.ts",
    "builds each kind of decision record the push card answers, a subagent's brief among them",
  ],
  [
    "workspaces/ChildWorkspacesTestKit.ts",
    "builds child workspaces over the threads test kit's repository and database",
  ],
]);

const files = sourceFiles(SERVER_SOURCE);

const allEdges = folderEdges(files);

const edges = allEdges.filter((edge) => !LEFT_OUT.has(edge.file));

/** The folders that register through a manifest. */
const features = new Set(FEATURES.map((feature) => feature.name));

/** The feature folders `brain/` imports on purpose, and why. */
const DELIBERATE: ReadonlyMap<string, string> = new Map([
  [
    "approvals",
    "the approval ledger is the seam's record-keeping: the harness answers a record and cancels the records a stopped run held (ADR 0024), the permission gate records an approval (ADR 0031), and the crash limit keeps a record's wait; the ledger in turn imports only brain/",
  ],
]);

/** The cycles left, each sorted, with why they remain. */
const REMAINING: ReadonlyArray<{
  readonly folders: ReadonlyArray<string>;
  readonly why: string;
}> = [
  {
    folders: ["approvals", "brain"],
    why: "the seam and the gate use the approval ledger (DELIBERATE), and the ledger is written over the brain's documents and pi-durable edge",
  },
  {
    folders: [
      "attachments",
      "executor",
      "git",
      "http",
      "load",
      "models",
      "projects",
      "push",
      "rpc",
      "shell",
      "skills",
      "threads",
      "usage",
    ],
    why: "the app's own folders around the shell: `http/Routes.ts` lists the feature routes (uploads, attachments, Executor's callback, the nightly push, favicons, boot data, the shell snapshot) that import `http/`'s problem and health helpers; the shell store reads the settings (`models/`) and projects; projects run git and git's checkpoints read the shell; a thread's launch reads the shell and its turn stages reach attachments and skills, and its title model meters spend (`usage/`); the boot data reads the session's hello (`rpc/`). Routes are not yet a manifest field, and the shell's settings and the title model's meter are direct reads; none of these folders is `brain/`",
  },
];

describe("the server's folder graph", () => {
  it("has no edge from brain/ to a feature folder but the deliberate ones", () => {
    const fromBrain = edges.filter(
      (edge) =>
        edge.from === "brain" &&
        features.has(edge.to) &&
        !DELIBERATE.has(edge.to)
    );

    assert.deepStrictEqual(
      fromBrain.map((edge) => `${edge.file} -> ${edge.target}`),
      []
    );

    for (const folder of DELIBERATE.keys()) {
      assert.isTrue(features.has(folder), `${folder} is a feature folder`);
    }
  });

  it("holds only the listed cycles", () => {
    const found = cycles(edges)
      .map((component) => component.join(" "))
      .toSorted();

    assert.deepStrictEqual(
      found,
      REMAINING.map(({ folders }) => folders.toSorted().join(" ")).toSorted()
    );
  });

  it("leaves out only listed test doubles, each of which imports another folder", () => {
    for (const file of LEFT_OUT.keys()) {
      const full = path.join(SERVER_SOURCE, file);

      assert.include(files, full, `${file} exists`);
      assert.isTrue(isTestDouble(full), `${file} is named like a test double`);
      assert.isTrue(
        allEdges.some((edge) => edge.file === file),
        `${file} imports another folder`
      );
    }
  });

  it("names a double by its path in the repository, not by where the checkout lives", () => {
    const checkout = path.join(path.sep, "home", "FakeUser", "Scripted-demo");
    const double = isTestDoubleUnder(checkout);

    assert.isFalse(
      double(path.join(checkout, "apps", "server", "src", "main.ts"))
    );
    assert.isTrue(
      double(
        path.join(checkout, "apps", "server", "src", "reach", "FakePorch.ts")
      )
    );
    assert.isTrue(
      double(path.join(checkout, "apps", "server", "src", "DevLayer.ts"))
    );
  });

  it("sees value imports, not type imports, and finds a cycle (control)", () => {
    assert.isTrue(
      edges.some(
        (edge) =>
          edge.file === "brain/PiDurableHarness.ts" &&
          edge.target === "approvals/ApprovalLedger.ts"
      )
    );
    // `brain/Feature.ts` imports the manifest's types from approvals/ and the root, and loads none.
    assert.isFalse(edges.some((edge) => edge.file === "brain/Feature.ts"));
    assert.deepStrictEqual(
      cycles([
        { from: "brain", to: "subagents", file: "a", target: "b" },
        { from: "subagents", to: "brain", file: "b", target: "a" },
      ]),
      [["brain", "subagents"]]
    );
  });
});
