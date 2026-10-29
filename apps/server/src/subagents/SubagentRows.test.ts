// A subagent's shell row (SubagentRows.ts) over a migrated in-memory shell store: made once with its
// lineage, the parent's project and cwd, the brief's title and the dispatched model; a repeat, as
// the fiber and the boot repair both answer the same child, leaves the one row; a child whose
// parent has no row gets none.

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
});

describe("a subagent's shell row", () => {
  it.effect("is made once, with its lineage, from its parent's row", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink;
      const rows = yield* ThreadRows;
      const project = createProject(1);

      yield* sink.commitCommand(project.command);
      yield* sink.commitCommand(createThread(project.projectId, 1));

      const ensure = ensureChildRow(rows, sink);
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

      yield* ensureChildRow(
        rows,
        sink
      )({
        ...sourceOf(testThreadId(1)),
        model: Option.none(),
      });

      const { shell } = Option.getOrThrow(yield* rows.get(CHILD));

      assert.strictEqual(shell.provider, "opencode-go");
      assert.strictEqual(shell.modelId, "small");
    }).pipe(Effect.provide(ShellTestLayer))
  );

  it.effect("is not made for a parent with no row", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink;
      const rows = yield* ThreadRows;

      assert.isFalse(
        yield* ensureChildRow(rows, sink)(sourceOf(testThreadId(9)))
      );
      assert.isTrue(Option.isNone(yield* rows.get(CHILD)));
    }).pipe(Effect.provide(ShellTestLayer))
  );
});
