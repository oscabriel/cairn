import { ProjectId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import {
  defaultProjectOf,
  managedThreadsOf,
  newThreadOpens,
  projectThreadOf,
  projectThreadToOpen,
} from "./ProjectThread.ts";
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

/** A project of `kind`, updated at `updatedAt`, with its project thread when marked. */
const shellProject = (
  id: string,
  kind: "folder" | "scratch",
  updatedAt: DateTime.Utc,
  mark: Option.Option<number>
) => ({
  id: ProjectId.make(id),
  kind,
  updatedAt,
  projectThreadId: Option.map(mark, rowId),
});

describe(defaultProjectOf, () => {
  it("is the most recently updated folder project, never the scratch project", () => {
    const older = shellProject("prj_old", "folder", EARLIER, Option.none());
    const newer = shellProject("prj_new", "folder", NOW, Option.none());

    const scratch = shellProject(
      "prj_scratch",
      "scratch",
      DateTime.add(NOW, { hours: 1 }),
      Option.none()
    );

    assert.deepStrictEqual(
      defaultProjectOf([older, scratch, newer]),
      Option.some(newer)
    );
    assert.isTrue(Option.isNone(defaultProjectOf([scratch])));
  });
});

describe(projectThreadToOpen, () => {
  it("is a folder project's marked thread, and none in the scratch project or before the first launch", () => {
    assert.deepStrictEqual(
      projectThreadToOpen(shellProject("prj_1", "folder", NOW, Option.some(4))),
      Option.some(rowId(4))
    );
    assert.isTrue(
      Option.isNone(
        projectThreadToOpen(shellProject("prj_1", "folder", NOW, Option.none()))
      )
    );
    assert.isTrue(
      Option.isNone(
        projectThreadToOpen(
          shellProject("prj_s", "scratch", NOW, Option.some(4))
        )
      )
    );
  });
});

describe(newThreadOpens, () => {
  const cairn = shellProject("prj_cairn", "folder", EARLIER, Option.some(1));
  const myr = shellProject("prj_myr", "folder", NOW, Option.some(2));
  const fresh = shellProject("prj_fresh", "folder", EARLIER, Option.none());
  const scratch = shellProject("prj_scratch", "scratch", NOW, Option.none());

  it("opens the project thread of the open thread's project, not the default's", () => {
    assert.deepStrictEqual(
      newThreadOpens([cairn, myr], Option.some(cairn.id)),
      Option.some(rowId(1))
    );
  });

  it("falls back to the hero's default project off a folder project's thread", () => {
    assert.deepStrictEqual(
      newThreadOpens([cairn, myr, scratch], Option.some(scratch.id)),
      Option.some(rowId(2))
    );
    assert.deepStrictEqual(
      newThreadOpens([cairn, myr], Option.none()),
      Option.some(rowId(2))
    );
  });

  it("opens a draft in a project with no project thread yet", () => {
    assert.isTrue(
      Option.isNone(newThreadOpens([fresh], Option.some(fresh.id)))
    );
    assert.isTrue(Option.isNone(newThreadOpens([], Option.none())));
  });
});
