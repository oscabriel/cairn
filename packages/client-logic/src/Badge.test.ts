import { ProjectId, RunId } from "@cairn/protocol/Ids";
import type { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { needsYou, needsYouCount, NO_PAGE, rootsNeedingYou } from "./Badge.ts";
import type { NeedsYouPage, NeedsYouShell } from "./Badge.ts";
import {
  asking,
  EARLIER,
  NOW,
  rowId as id,
  shellRow as row,
} from "./ShellRowTestKit.ts";

const childOf = (parent: number, root: number = parent) => ({
  lineage: Option.some({
    parentThreadId: id(parent),
    relationshipToParent: "subagent" as const,
    rootThreadId: id(root),
  }),
});

const unseen: Partial<ThreadShell> = {
  latestRunCompletedAt: Option.some(NOW),
  lastVisitedAt: Option.some(EARLIER),
};

const seen: Partial<ThreadShell> = {
  latestRunCompletedAt: Option.some(EARLIER),
  lastVisitedAt: Option.some(NOW),
};

/** A folder project whose project thread is thread `n`, and its rows' project. */
const projectOf = (
  n: number,
  kind: ProjectShell["kind"] = "folder"
): Pick<ProjectShell, "id" | "kind" | "projectThreadId"> => ({
  id: ProjectId.make(`prj_${String(n)}`),
  kind,
  projectThreadId: kind === "folder" ? Option.some(id(n)) : Option.none(),
});

/** Thread `n` in the project of project thread `project`. */
const inProject = (project: number, n: number, overrides = {}) =>
  row(n, { projectId: ProjectId.make(`prj_${String(project)}`), ...overrides });

const shellOf = (
  projects: ReadonlyArray<number>,
  threads: ReadonlyArray<ThreadShell>
): NeedsYouShell => ({
  projects: projects.map((n) => projectOf(n)),
  threads,
});

/** A page showing thread `n`. */
const watching = (n: number): NeedsYouPage => ({
  ...NO_PAGE,
  openThreadId: Option.some(id(n)),
});

/** A page holding scratch thread `n`. */
const holding = (n: number): NeedsYouPage => ({
  ...NO_PAGE,
  scratchThreadId: Option.some(id(n)),
});

describe(needsYou, () => {
  it("is a request waiting, or an unseen result on a thread the user talks to", () => {
    assert.isTrue(needsYou(row(1, asking("q-1"))));
    assert.isTrue(needsYou(row(1, unseen)));
    assert.isTrue(needsYou(row(2, { ...asking("q-2"), ...childOf(1) })));
    assert.isFalse(needsYou(row(2, { ...unseen, ...childOf(1) })));
    assert.isFalse(needsYou(row(1, seen)));
    assert.isFalse(
      needsYou(row(1, { ...unseen, activeRunId: Option.some(RunId.make(1)) }))
    );
  });

  it("is false for a seen failure or a seen spent plan window", () => {
    assert.isFalse(
      needsYou(
        row(1, {
          ...seen,
          activity: "failed",
          lastErrorClass: Option.some("provider_error"),
        })
      )
    );
    assert.isFalse(
      needsYou(
        row(1, {
          ...seen,
          activity: "failed",
          lastErrorClass: Option.some("usage_limit"),
        })
      )
    );
  });
});

describe(needsYouCount, () => {
  it("counts a project thread with a request waiting, once with its unseen result", () => {
    assert.strictEqual(
      needsYouCount(
        shellOf([1, 2], [inProject(1, 1, asking("q-1")), inProject(2, 2)]),
        NO_PAGE
      ),
      1
    );
    assert.strictEqual(
      needsYouCount(
        shellOf(
          [1],
          [
            inProject(1, 1, {
              ...unseen,
              ...asking("q-1"),
              activeRunId: Option.none(),
            }),
          ]
        ),
        NO_PAGE
      ),
      1
    );
  });

  it("folds an escalated question, a parent-routed one and a grandchild's into the root", () => {
    assert.strictEqual(
      needsYouCount(
        shellOf(
          [1],
          [
            inProject(1, 1, asking("q-1-mirror")),
            inProject(1, 2, { ...asking("q-1"), ...childOf(1) }),
            inProject(1, 3, { ...asking("q-2"), ...childOf(1) }),
            inProject(1, 4, { ...asking("tool-1"), ...childOf(3, 1) }),
          ]
        ),
        NO_PAGE
      ),
      1
    );
  });

  it("counts two project threads twice and skips an archived row", () => {
    assert.strictEqual(
      needsYouCount(
        shellOf(
          [1, 5],
          [
            inProject(1, 1, asking("q-1")),
            inProject(5, 5),
            inProject(5, 2, { ...asking("q-2"), ...childOf(5) }),
            inProject(5, 3, {
              ...asking("q-3"),
              ...childOf(5),
              archivedAt: Option.some(NOW),
            }),
          ]
        ),
        NO_PAGE
      ),
      2
    );
  });

  it("never counts a root no list shows: an old top-level thread, or a scratch thread not held", () => {
    const shell: NeedsYouShell = {
      projects: [projectOf(1), projectOf(90, "scratch")],
      threads: [
        inProject(1, 1),
        inProject(1, 9, unseen),
        inProject(1, 10, { ...asking("q-10"), ...childOf(9) }),
        inProject(90, 90, unseen),
      ],
    };

    assert.strictEqual(needsYouCount(shell, NO_PAGE), 0);
    assert.strictEqual(needsYouCount(shell, holding(90)), 1);
    assert.deepStrictEqual([...rootsNeedingYou(shell, holding(90))], [id(90)]);
  });

  it("counts a scratch thread's subagent's request on the scratch thread", () => {
    const shell: NeedsYouShell = {
      projects: [projectOf(90, "scratch")],
      threads: [
        inProject(90, 90),
        inProject(90, 91, { ...asking("q-91"), ...childOf(90) }),
      ],
    };

    assert.strictEqual(needsYouCount(shell, holding(90)), 1);
  });

  it("leaves out the open thread's own unseen result, never its request or another thread's", () => {
    const finished = shellOf(
      [1, 5],
      [inProject(1, 1, unseen), inProject(5, 5, unseen)]
    );

    assert.strictEqual(needsYouCount(finished, NO_PAGE), 2);
    assert.strictEqual(needsYouCount(finished, watching(1)), 1);
    assert.deepStrictEqual(
      [...rootsNeedingYou(finished, watching(1))],
      [id(5)]
    );

    const asked = shellOf(
      [1],
      [inProject(1, 1, { ...unseen, ...asking("q-1") })]
    );

    assert.strictEqual(needsYouCount(asked, watching(1)), 1);

    // Watching a child leaves its root's own result counted, and its own request too.
    const tree = shellOf(
      [1],
      [
        inProject(1, 1, unseen),
        inProject(1, 2, { ...asking("q-2"), ...childOf(1) }),
      ]
    );

    assert.strictEqual(needsYouCount(tree, watching(2)), 1);
    assert.strictEqual(
      needsYouCount(
        shellOf(
          [1],
          [
            inProject(1, 1),
            inProject(1, 2, { ...asking("q-2"), ...childOf(1) }),
          ]
        ),
        watching(2)
      ),
      1
    );
  });
});
