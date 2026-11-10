import {
  asking,
  EARLIER,
  NOW,
  rowId,
  shellRow,
} from "@cairn/client-logic/ShellRowTestKit";
import { ProjectId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { pushContextOf } from "./Context.ts";

/** One folder project per row, each row its project thread. */
const contextOf = (
  threads: Array<Parameters<typeof shellRow>[1]>,
  scratchThreadId: Option.Option<ThreadId> = Option.none()
) =>
  pushContextOf({
    epoch: 1,
    hasClient: true,
    hello: Option.none(),
    openThreadId: Option.none(),
    scratchThreadId,
    shell: Option.some({
      snapshotSequence: 1,
      projects: threads.map((_, index) => ({
        id: ProjectId.make(`prj_${String(index + 1)}`),
        title: `Project ${String(index + 1)}`,
        kind: "folder" as const,
        workspaceRoot: `/srv/${String(index + 1)}`,
        repository: Option.none(),
        defaultModel: Option.none(),
        projectThreadId: Option.some(rowId(index + 1)),
        createdAt: EARLIER,
        updatedAt: EARLIER,
      })),
      threads: threads.map((overrides, index) =>
        shellRow(index + 1, {
          projectId: ProjectId.make(`prj_${String(index + 1)}`),
          ...overrides,
        })
      ),
    }),
  });

describe("push context", () => {
  it("badges a waiting request the way the push does, beside an unseen result", () => {
    assert.strictEqual(contextOf([asking("q-1")]).badge, 1);
    assert.strictEqual(
      contextOf([
        asking("q-1"),
        {
          latestRunCompletedAt: Option.some(NOW),
          lastVisitedAt: Option.some(EARLIER),
        },
        {},
      ]).badge,
      2
    );
  });

  it("badges nothing before the shell arrives", () => {
    assert.strictEqual(
      pushContextOf({
        epoch: 1,
        hasClient: true,
        hello: Option.none(),
        openThreadId: Option.none(),
        scratchThreadId: Option.none(),
        shell: Option.none(),
      }).badge,
      0
    );
  });
});
