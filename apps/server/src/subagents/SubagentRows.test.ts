// A subagent's shell row (SubagentRows.ts) over a migrated in-memory shell store: made once with its
// lineage, the parent's project and cwd, the brief's title and the dispatched model; a repeat, as
// the fiber and the boot repair both answer the same child, leaves the one row, also when both
// commit at once (the command id's receipt); a child whose parent has no row gets none. The fiber
// and the boot repair over a real brain are in `brain/SubagentsPiDurable.test.ts`.

import { ThreadId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { EventSink } from "../shell/EventSink.ts";
import {
  createProject,
  createThread,
  ShellTestLayer,
  testThreadId,
} from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { ensureChildRow } from "./SubagentRows.ts";
import type { ChildRowSource } from "./SubagentRows.ts";

const CHILD = ThreadId.make("01a185ff-18ee-7000-8000-000000000018");

const sourceOf = (parent: ThreadId): ChildRowSource => ({
  threadId: CHILD,
  lineage: {
    parentThreadId: parent,
    relationshipToParent: "subagent",
    rootThreadId: parent,
  },
  title: "Count the files",
  model: Option.some({ provider: "faux", modelId: "small" }),
  runtimeMode: "approval-required",
  worktree: Option.none(),
});

describe("a subagent's shell row", () => {
  it.effect("is made once, with its lineage, from its parent's row", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink;
      const rows = yield* ThreadRows;
      const project = createProject(1);

      yield* sink.commitCommand(project.command);
      yield* sink.commitCommand(createThread(project.projectId, 1));

      const ensure = ensureChildRow;
      const parent = testThreadId(1);

      assert.isTrue(yield* ensure(sourceOf(parent)));
      assert.isFalse(yield* ensure(sourceOf(parent)));

      const row = yield* rows.get(CHILD);

      assert.isTrue(Option.isSome(row));

      const { shell } = Option.getOrThrow(row);

      assert.deepStrictEqual(
        shell.lineage,
        Option.some(sourceOf(parent).lineage)
      );
      assert.strictEqual(shell.projectId, project.projectId);
      assert.strictEqual(shell.title, "Count the files");
      assert.strictEqual(shell.provider, "faux");
      assert.strictEqual(shell.modelId, "small");
      assert.strictEqual(shell.runtimeMode, "approval-required");
      assert.lengthOf(
        (yield* rows.listLive).filter((found) => found.shell.id === CHILD),
        1
      );
    }).pipe(Effect.provide(ShellTestLayer))
  );

  it.effect("takes the parent's model when the dispatch names none", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink;
      const rows = yield* ThreadRows;
      const project = createProject(1);

      yield* sink.commitCommand(project.command);
      yield* sink.commitCommand(createThread(project.projectId, 1));

      yield* ensureChildRow({
        ...sourceOf(testThreadId(1)),
        model: Option.none(),
      });

      const { shell } = Option.getOrThrow(yield* rows.get(CHILD));

      assert.strictEqual(shell.provider, "opencode-go");
      assert.strictEqual(shell.modelId, "small");
    }).pipe(Effect.provide(ShellTestLayer))
  );

  it.effect("takes a writing child's own worktree and branch", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink;
      const rows = yield* ThreadRows;
      const project = createProject(1);

      yield* sink.commitCommand(project.command);
      yield* sink.commitCommand(createThread(project.projectId, 1));

      yield* ensureChildRow({
        ...sourceOf(testThreadId(1)),
        worktree: Option.some({
          path: "/data/worktrees/repo/sub-0a1b2c3d",
          branch: "cairn/sub-0a1b2c3d",
          baseSha: "0123456789abcdef0123456789abcdef01234567",
        }),
      });

      const { shell } = Option.getOrThrow(yield* rows.get(CHILD));

      assert.deepStrictEqual(shell.branch, Option.some("cairn/sub-0a1b2c3d"));
      assert.deepStrictEqual(
        shell.worktreePath,
        Option.some("/data/worktrees/repo/sub-0a1b2c3d")
      );
    }).pipe(Effect.provide(ShellTestLayer))
  );

  it.effect("is not made for a parent with no row", () =>
    Effect.gen(function* () {
      const rows = yield* ThreadRows;

      assert.isFalse(yield* ensureChildRow(sourceOf(testThreadId(9))));
      assert.isTrue(Option.isNone(yield* rows.get(CHILD)));
    }).pipe(Effect.provide(ShellTestLayer))
  );

  it.effect(
    "lands once when the fiber and the boot repair make it at the same time",
    () =>
      Effect.gen(function* () {
        const sink = yield* EventSink;
        const rows = yield* ThreadRows;
        const project = createProject(1);

        yield* sink.commitCommand(project.command);
        yield* sink.commitCommand(createThread(project.projectId, 1));

        // Both read no row before either commits; the second commit lands on the receipt of the
        // first, since the command id is the child's thread id.
        const made = yield* Effect.all(
          [
            ensureChildRow(sourceOf(testThreadId(1))),
            ensureChildRow(sourceOf(testThreadId(1))),
          ],
          { concurrency: "unbounded" }
        );

        assert.isTrue(made.includes(true));
        assert.lengthOf(
          (yield* rows.listLive).filter((found) => found.shell.id === CHILD),
          1
        );
      }).pipe(Effect.provide(ShellTestLayer))
  );
});
