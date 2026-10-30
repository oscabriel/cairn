import { ProjectId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import { managedThreadsOf, projectThreadOf } from "./ProjectThread.ts";
import { EARLIER, NOW, rowId, shellRow } from "./ShellRowTestKit.ts";

const project = (mark: Option.Option<number>) => ({
  id: ProjectId.make("prj_1"),
  projectThreadId: Option.map(mark, rowId),
});

const child = (
  n: number,
  parent: number,
  root: number,
  createdAt: DateTime.Utc
): ThreadShell =>
  shellRow(n, {
    createdAt,
    lineage: Option.some({
      parentThreadId: rowId(parent),
      relationshipToParent: "subagent",
      rootThreadId: rowId(root),
    }),
  });

describe(projectThreadOf, () => {
  it("finds the marked thread", () => {
    const rows = [shellRow(1), shellRow(2)];

    assert.deepStrictEqual(
      projectThreadOf(project(Option.some(2)), rows),
      Option.some(rows[1])
    );
  });

  it("reads a mark naming a row the client does not hold as none", () => {
    assert.isTrue(
      Option.isNone(projectThreadOf(project(Option.some(3)), [shellRow(1)]))
    );
    assert.isTrue(
      Option.isNone(projectThreadOf(project(Option.none()), [shellRow(1)]))
    );
  });

  it("ignores a row of another project or a subagent's row", () => {
    const other = shellRow(1, { projectId: ProjectId.make("prj_2") });

    assert.isTrue(
      Option.isNone(projectThreadOf(project(Option.some(1)), [other]))
    );
    assert.isTrue(
      Option.isNone(
        projectThreadOf(project(Option.some(2)), [child(2, 1, 1, NOW)])
      )
    );
  });
});

describe(managedThreadsOf, () => {
  it("lists every row rooted at the project thread, newest first", () => {
    const later = DateTime.add(NOW, { minutes: 1 });

    const rows = [
      shellRow(1),
      child(2, 1, 1, EARLIER),
      child(3, 2, 1, later),
      child(4, 1, 1, NOW),
      shellRow(5),
      child(6, 5, 5, NOW),
    ];

    assert.deepStrictEqual(
      managedThreadsOf(rowId(1), rows).map((row) => row.id),
      [rowId(3), rowId(4), rowId(2)]
    );
    assert.deepStrictEqual(managedThreadsOf(rowId(9), rows), []);
  });
});
