// The folder import graph of `apps/server/src` (ADR 0053): what the production modules load from
// one another (value imports; test doubles left out, since the deployed brain never loads them,
// `main.test.ts`), with each file at the root its own node. `brain/` imports no feature folder but
// the approval ledger, and the cycles that remain are exactly the ones listed here, each with why.
// The review of 2026-11-09 measured one cycle of 22 folders, `brain/` among them.

import { assert, describe, it } from "@effect/vitest";

import { FEATURES } from "./Features.ts";
import {
  cycles,
  folderEdges,
  SERVER_SOURCE,
  sourceFiles,
  TEST_DOUBLE,
} from "./ImportGraphTestKit.ts";

const production = sourceFiles(SERVER_SOURCE).filter(
  (file) => !TEST_DOUBLE.test(file)
);

const edges = folderEdges(production);

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
