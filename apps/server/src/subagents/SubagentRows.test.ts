// A subagent's shell row (SubagentRows.ts) over a migrated in-memory shell store: made once with its
// lineage, the parent's project and cwd, the brief's title and the dispatched model; a repeat, as
// the fiber and the boot repair both answer the same child, leaves the one row, also when both
// commit at once (the command id's receipt); a child whose parent has no row gets none. The fiber
// ends quietly when its scope closes and with a warning when the event stream ends under it.
// Without pi-durable (the scripted harness) the fiber reads the child through the seam's documents
// and makes the same row; a workflow node's child, which has no registry item, takes its node's
// model from the parent's `cairn.workflows`, not the parent's. The fiber and the boot repair over a
// real brain are in `brain/SubagentsPiDurable.test.ts`.

import { ConversationId, ThreadId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  References,
  Scope,
  Stream,
} from "effect";

import { Brain } from "../brain/Brain.ts";
import { HarnessSeam, ThreadEnsured } from "../brain/HarnessSeam.ts";
import type { HarnessEvent } from "../brain/HarnessSeam.ts";
import { EventSink } from "../shell/EventSink.ts";
import {
  createProject,
  createThread,
  ShellTestLayer,
  testThreadId,
} from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { ensureChildRow, SubagentRows } from "./SubagentRows.ts";
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

const unsupported = (operation: string) =>
  Effect.die(`the fake ${operation} is not used here`);

/** A harness whose only part in use is `events`. */
const harnessWith = (events: Stream.Stream<HarnessEvent>) =>
  HarnessSeam.of({
    ensureThread: () => unsupported("ensureThread"),
    configure: () => unsupported("configure"),
    submit: () => unsupported("submit"),
    stop: () => unsupported("stop"),
    withdraw: () => unsupported("withdraw"),
    respond: () => unsupported("respond"),
    write: () => unsupported("write"),
    compact: () => unsupported("compact"),
    watch: () => Stream.die("the fake watch is not used here"),
    whenEnsured: () => unsupported("whenEnsured"),
    document: () => unsupported("document"),
    history: () => unsupported("history"),
    entry: () => unsupported("entry"),
    entryImage: () => unsupported("entryImage"),
    events,
    inspect: Effect.succeed([]),
    retry: () => unsupported("retry"),
    capabilities: { durable: true, live: true },
  });

/** A brain that is there, so the fiber starts; nothing reaches its session here. */
const presentBrain = Brain.of({
  session: unsupported("session"),
  sessions: Stream.never,
  subscribeCommits: () => Effect.void,
  resume: Effect.void,
  now: () => 0,
});

/**
 * Builds the SubagentRows fiber over `events` in a scope of its own, lets it run, then closes the
 * scope with `exit`; the `event` annotation of each warning it logged.
 */
const warningsWhen = (
  events: Stream.Stream<HarnessEvent>,
  exit: Exit.Exit<unknown>
) =>
  Effect.gen(function* () {
    const warned: Array<string> = [];

    const capture = Logger.make((options) => {
      if (options.logLevel === "Warn") {
        warned.push(
          String(options.fiber.getRef(References.CurrentLogAnnotations).event)
        );
      }
    });

    const scope = yield* Scope.make();

    yield* Layer.buildWithScope(SubagentRows, scope).pipe(
      Effect.provideService(HarnessSeam, harnessWith(events)),
      Effect.provideService(Brain, presentBrain),
      Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))
    );
    yield* Effect.yieldNow;
    yield* Scope.close(scope, exit);

    return warned;
  });

describe("the subagent row fiber's end", () => {
  it.effect(
    "is quiet when the brain's scope closes, and a warning when the event stream ends under it",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          [
            yield* warningsWhen(Stream.never, Exit.void),
            yield* warningsWhen(Stream.empty, Exit.void),
          ],
          [[], ["subagent_rows_ended"]]
        );
      }).pipe(Effect.provide(ShellTestLayer))
  );
});

/** The documents a scripted child and its parent project, as `HarnessSeam.document` reads them. */
const scriptedDocuments =
  (parent: ThreadId) => (threadId: ThreadId, kind: string) => {
    if (threadId === CHILD && kind === "cairn.child") {
      return Effect.succeedSome({
        key: "call-7",
        parentThreadId: parent,
        parentConversationId: 1,
        rootThreadId: parent,
        depth: 1,
        briefApprovalId: "call-7",
        resultSchema: null,
        attempts: 0,
        report: null,
        permissionMode: "auto-accept-edits",
      });
    }

    if (threadId === parent && kind === "cairn.subagents") {
      return Effect.succeedSome({
        items: {
          "call-7": {
            threadId: CHILD,
            description: "Count the files",
            dispatch: {
              spec: null,
              resolved: { model: { provider: "scripted", modelId: "echo" } },
              previewed: null,
              dispatchedAt: 5,
            },
            worktree: null,
          },
        },
      });
    }

    return Effect.succeedNone;
  };

/** A workflow node's child: its link, no registry item, and its node in the parent's ledger. */
const workflowDocuments =
  (parent: ThreadId) => (threadId: ThreadId, kind: string) => {
    if (threadId === CHILD && kind === "cairn.child") {
      return Effect.succeedSome({
        key: "scout-1",
        parentThreadId: parent,
        parentConversationId: 1,
        rootThreadId: parent,
        depth: 1,
        briefApprovalId: "brief-1",
        resultSchema: null,
        attempts: 0,
        report: null,
        permissionMode: "auto-accept-edits",
      });
    }

    if (threadId === parent && kind === "cairn.workflows") {
      return Effect.succeedSome({
        items: {
          "wf-1": {
            nodes: {
              "scout-1": {
                childThreadId: CHILD,
                provider: "claude-bridge",
                modelId: "claude-sonnet-5-5",
              },
            },
          },
        },
      });
    }

    return Effect.succeedNone;
  };

/** The row the fiber makes for `CHILD` over `documents`, waited for. */
const rowThroughSeam = (
  parent: ThreadId,
  documents: HarnessSeam["Service"]["document"]
) =>
  Effect.gen(function* () {
    const rows = yield* ThreadRows;
    const scope = yield* Scope.make();

    yield* Layer.buildWithScope(SubagentRows, scope).pipe(
      Effect.provideService(HarnessSeam, {
        ...harnessWith(
          Stream.make(
            ThreadEnsured.make({
              threadId: CHILD,
              conversationId: ConversationId.make(2),
              parent: Option.some(parent),
            })
          )
        ),
        document: documents,
      })
    );

    let row = yield* rows.get(CHILD);

    for (let tries = 0; Option.isNone(row) && tries < 50; tries += 1) {
      yield* Effect.sleep("10 millis");
      row = yield* rows.get(CHILD);
    }

    yield* Scope.close(scope, Exit.void);

    return Option.getOrThrow(row).shell;
  });

describe("a scripted subagent's shell row", () => {
  it.effect(
    "is made through the seam's documents when there is no pi-durable brain",
    () =>
      Effect.gen(function* () {
        const sink = yield* EventSink;
        const rows = yield* ThreadRows;
        const project = createProject(1);
        const parent = testThreadId(1);

        yield* sink.commitCommand(project.command);
        yield* sink.commitCommand(createThread(project.projectId, 1));

        const scope = yield* Scope.make();

        yield* Layer.buildWithScope(SubagentRows, scope).pipe(
          Effect.provideService(HarnessSeam, {
            ...harnessWith(
              Stream.make(
                ThreadEnsured.make({
                  threadId: CHILD,
                  conversationId: ConversationId.make(2),
                  parent: Option.some(parent),
                })
              )
            ),
            document: scriptedDocuments(parent),
          })
        );

        // The fiber runs on its own; wait for its one row.
        let row = yield* rows.get(CHILD);

        for (let tries = 0; Option.isNone(row) && tries < 50; tries += 1) {
          yield* Effect.sleep("10 millis");
          row = yield* rows.get(CHILD);
        }

        yield* Scope.close(scope, Exit.void);

        const { shell } = Option.getOrThrow(row);

        assert.deepStrictEqual(
          shell.lineage,
          Option.some({
            parentThreadId: parent,
            relationshipToParent: "subagent" as const,
            rootThreadId: parent,
          })
        );
        assert.strictEqual(shell.title, "Count the files");
        assert.strictEqual(shell.provider, "scripted");
        assert.strictEqual(shell.modelId, "echo");
        assert.strictEqual(shell.runtimeMode, "auto-accept-edits");
      }).pipe(Effect.provide(ShellTestLayer))
  );

  it.effect(
    "takes a workflow node's own model from its node, not the parent's",
    () =>
      Effect.gen(function* () {
        const sink = yield* EventSink;
        const project = createProject(1);
        const parent = testThreadId(1);

        yield* sink.commitCommand(project.command);
        yield* sink.commitCommand(createThread(project.projectId, 1));

        const shell = yield* rowThroughSeam(parent, workflowDocuments(parent));

        assert.strictEqual(shell.provider, "claude-bridge");
        assert.strictEqual(shell.modelId, "claude-sonnet-5-5");
      }).pipe(Effect.provide(ShellTestLayer))
  );
});
