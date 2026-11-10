// A subagent's shell row (SubagentRows.ts) over a migrated in-memory shell store: made once with its
// lineage, the parent's project and cwd, the brief's title and the dispatched model; a repeat, as
// the fiber and the boot repair both answer the same child, leaves the one row, also when both
// commit at once (the command id's receipt); a child whose parent has no row gets none. The fiber
// ends quietly when its scope closes and with a warning when the event stream ends under it.
// Without pi-durable (the scripted harness) the fiber reads the child through the seam's documents
// and makes the same row; a workflow node's child, which has no registry item, takes its node's
// model from the parent's `cairn.workflows`, not the parent's. A child's first input names it
// through a scripted title model (a brief child from its brief, a workflow node from its prompt
// with its label as context, the label showing until then and kept when the model fails), and the
// title repair renames a row still titled "Subagent" once, not twice. The fiber and the boot
// repair over a real brain are in `brain/SubagentsPiDurable.test.ts`.

import { ConversationId, EntryId, ThreadId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Ref,
  References,
  Scope,
  Stream,
} from "effect";

import { Brain } from "../brain/Brain.ts";
import {
  HarnessSeam,
  MessageCommitted,
  ThreadEnsured,
} from "../brain/HarnessSeam.ts";
import type { HarnessEvent } from "../brain/HarnessSeam.ts";
import { EventSink } from "../shell/EventSink.ts";
import {
  createProject,
  createThread,
  ShellTestLayer,
  testThreadId,
} from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { TitleModelScripted, TitleScript } from "../threads/ThreadsTestKit.ts";
import { ThreadTitles } from "../threads/ThreadTitles.ts";
import { TitleModel } from "../threads/TitleModel.ts";
import {
  CHILD_TITLE,
  ensureChildRow,
  retitleSubagentRows,
  SubagentRows,
} from "./SubagentRows.ts";
import type { ChildRowSource } from "./SubagentRows.ts";

/** The shell store and child titles over no title model. */
const RowsTestLayer = Layer.mergeAll(
  ShellTestLayer,
  ThreadTitles.layerNoDeps.pipe(Layer.provide(TitleModel.layerNone))
);

const CHILD = ThreadId.make("01a185ff-18ee-7000-8000-000000000018");

const sourceOf = (parent: ThreadId): ChildRowSource => ({
  threadId: CHILD,
  lineage: {
    parentThreadId: parent,
    relationshipToParent: "subagent",
    rootThreadId: parent,
  },
  title: "Count the files",
  label: Option.none(),
  model: Option.some({ provider: "faux", modelId: "small" }),
  thinkingLevel: Option.none(),
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
    }).pipe(Effect.provide(RowsTestLayer))
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
    }).pipe(Effect.provide(RowsTestLayer))
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
    }).pipe(Effect.provide(RowsTestLayer))
  );

  it.effect("is not made for a parent with no row", () =>
    Effect.gen(function* () {
      const rows = yield* ThreadRows;

      assert.isFalse(yield* ensureChildRow(sourceOf(testThreadId(9))));
      assert.isTrue(Option.isNone(yield* rows.get(CHILD)));
    }).pipe(Effect.provide(RowsTestLayer))
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
      }).pipe(Effect.provide(RowsTestLayer))
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
      }).pipe(Effect.provide(RowsTestLayer))
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
              resolved: {
                spec: "scripted/echo",
                model: { provider: "scripted", modelId: "echo" },
                thinkingLevel: null,
                priced: false,
              },
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
  (
    parent: ThreadId,
    effort: string | null,
    thinkingLevel: string | null = null,
    label = "scout-1"
  ) =>
  (threadId: ThreadId, kind: string) => {
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
                effort,
                thinkingLevel,
                label,
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
      }).pipe(Effect.provide(RowsTestLayer))
  );

  it.effect(
    "takes a workflow node's own model and level from its node, not the parent's",
    () =>
      Effect.gen(function* () {
        const sink = yield* EventSink;
        const project = createProject(1);
        const parent = testThreadId(1);

        yield* sink.commitCommand(project.command);
        yield* sink.commitCommand(createThread(project.projectId, 1));

        const shell = yield* rowThroughSeam(
          parent,
          workflowDocuments(parent, "high")
        );

        assert.strictEqual(shell.provider, "claude-bridge");
        assert.strictEqual(shell.modelId, "claude-sonnet-5-5");
        // The parent's row runs at `off`.
        assert.strictEqual(shell.thinkingLevel, "high");
      }).pipe(Effect.provide(RowsTestLayer))
  );

  it.effect(
    "gives a workflow node with no effort the model's default level, not the parent's",
    () =>
      Effect.gen(function* () {
        const sink = yield* EventSink;
        const project = createProject(1);
        const parent = testThreadId(1);

        yield* sink.commitCommand(project.command);
        yield* sink.commitCommand(createThread(project.projectId, 1));

        const shell = yield* rowThroughSeam(
          parent,
          workflowDocuments(parent, null)
        );

        assert.strictEqual(shell.thinkingLevel, "medium");
      }).pipe(Effect.provide(RowsTestLayer))
  );

  it.effect("gives a workflow node the level its row recorded it runs at", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink;
      const project = createProject(1);
      const parent = testThreadId(1);

      yield* sink.commitCommand(project.command);
      yield* sink.commitCommand(createThread(project.projectId, 1));

      // No effort, a spec at `low`: the node runs at `low`, not the model's default.
      const shell = yield* rowThroughSeam(
        parent,
        workflowDocuments(parent, null, "low")
      );

      assert.strictEqual(shell.thinkingLevel, "low");
    }).pipe(Effect.provide(RowsTestLayer))
  );
});

/** The shell store and child titles over a scripted title model a test answers. */
const titledLayer = (held: boolean) =>
  Layer.mergeAll(
    ShellTestLayer,
    ThreadTitles.layerNoDeps.pipe(
      Layer.provideMerge(TitleModelScripted({ held }))
    )
  );

const BRIEF_TEXT =
  "Count every TypeScript file under apps/server/src and report the total.";

const NODE_PROMPT =
  "Read the council question and argue for the cheapest path, with one risk.";

/** `CHILD`'s row title once `check` holds of it, or after a second without. */
const titleWhen = (check: (title: string) => boolean) =>
  Effect.gen(function* () {
    const rows = yield* ThreadRows;
    let title = "";

    for (let tries = 0; tries < 100; tries += 1) {
      title = Option.match(yield* rows.get(CHILD), {
        onNone: () => "",
        onSome: (row) => row.shell.title,
      });

      if (check(title)) {
        return title;
      }

      yield* Effect.sleep("10 millis");
    }

    return title;
  });

/** Runs the fiber over `CHILD`'s creation and first input, then `body`, then closes it. */
const withChildStarted = <A, E, R>(
  parent: ThreadId,
  documents: HarnessSeam["Service"]["document"],
  firstInput: string,
  body: Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();

    yield* Layer.buildWithScope(SubagentRows, scope).pipe(
      Effect.provideService(HarnessSeam, {
        ...harnessWith(
          Stream.make(
            ThreadEnsured.make({
              threadId: CHILD,
              conversationId: ConversationId.make(2),
              parent: Option.some(parent),
            }),
            MessageCommitted.make({
              threadId: CHILD,
              entryId: EntryId.make(1),
              role: "user",
              text: firstInput,
              at: DateTime.makeUnsafe(0),
            })
          )
        ),
        document: documents,
      })
    );

    const result = yield* body;

    yield* Scope.close(scope, Exit.void);

    return result;
  });

/** Commits the test project and the parent's row; the parent's thread id. */
const withParent = Effect.gen(function* () {
  const sink = yield* EventSink;
  const project = createProject(1);

  yield* sink.commitCommand(project.command);
  yield* sink.commitCommand(createThread(project.projectId, 1));

  return testThreadId(1);
});

/** The title model's JSON answer naming `title`. */
const answer = (title: string) =>
  Option.some(JSON.stringify({ title, needsRefinement: false }));

describe("a subagent's title", () => {
  it.live("is generated for a brief child from its first input", () =>
    Effect.gen(function* () {
      const script = yield* TitleScript;
      const parent = yield* withParent;

      yield* Ref.set(script.title, answer("TypeScript file count"));

      const title = yield* withChildStarted(
        parent,
        scriptedDocuments(parent),
        BRIEF_TEXT,
        titleWhen((found) => found === "TypeScript file count")
      );

      assert.strictEqual(title, "TypeScript file count");

      const prompts = yield* Ref.get(script.prompts);

      assert.lengthOf(prompts, 1);
      assert.include(prompts[0], BRIEF_TEXT);
    }).pipe(Effect.provide(titledLayer(false)))
  );

  it.live(
    "is generated for a workflow node from its prompt and label, which shows until then",
    () =>
      Effect.gen(function* () {
        const script = yield* TitleScript;
        const parent = yield* withParent;

        yield* Ref.set(script.title, answer("Cheapest path argument"));

        const [placeholder, title] = yield* withChildStarted(
          parent,
          workflowDocuments(parent, null, null, "Advisor 1 report"),
          NODE_PROMPT,
          Effect.gen(function* () {
            // The model is held: the row shows the node's label until it answers.
            const shown = yield* titleWhen((found) => found !== "");

            yield* script.gate.open;

            const named = yield* titleWhen(
              (found) => found === "Cheapest path argument"
            );

            return [shown, named] as const;
          })
        );

        assert.strictEqual(placeholder, "Advisor 1 report");
        assert.strictEqual(title, "Cheapest path argument");

        const prompts = yield* Ref.get(script.prompts);

        assert.lengthOf(prompts, 1);
        assert.include(prompts[0], "Workflow node: Advisor 1 report");
        assert.include(prompts[0], NODE_PROMPT);
      }).pipe(Effect.provide(titledLayer(true)))
  );

  it.live("keeps a workflow node's label when the title model fails", () =>
    Effect.gen(function* () {
      const script = yield* TitleScript;
      const parent = yield* withParent;

      // No answer: the request fails, as an unset or unreachable title model does.
      const title = yield* withChildStarted(
        parent,
        workflowDocuments(parent, null, null, "Advisor 1 report"),
        NODE_PROMPT,
        Effect.gen(function* () {
          for (
            let tries = 0;
            (yield* Ref.get(script.prompts)).length === 0 && tries < 100;
            tries += 1
          ) {
            yield* Effect.sleep("10 millis");
          }

          yield* Effect.sleep("20 millis");

          return yield* titleWhen((found) => found !== "");
        })
      );

      assert.lengthOf(yield* Ref.get(script.prompts), 1);
      assert.strictEqual(title, "Advisor 1 report");
    }).pipe(Effect.provide(titledLayer(false)))
  );
});

describe("the subagent title repair", () => {
  it.live("retitles a child row still titled Subagent once, not twice", () =>
    Effect.gen(function* () {
      const script = yield* TitleScript;
      const rows = yield* ThreadRows;
      const parent = yield* withParent;

      // A row made before children were titled.
      yield* ensureChildRow({ ...sourceOf(parent), title: CHILD_TITLE });
      yield* Ref.set(script.title, answer("Cheapest path argument"));

      const seam = HarnessSeam.of({
        ...harnessWith(Stream.never),
        document: workflowDocuments(parent, null, null, "Advisor 1 report"),
        history: () =>
          Effect.succeed({
            entries: [
              {
                id: EntryId.make(1),
                conversationId: ConversationId.make(2),
                kind: "pi.user",
                model: [{ role: "user", content: NODE_PROMPT, timestamp: 0 }],
              },
            ],
            hasMore: false,
          }),
      });

      const titleOf = Effect.map(
        rows.get(CHILD),
        (row) => Option.getOrThrow(row).shell.title
      );

      yield* retitleSubagentRows.pipe(Effect.provideService(HarnessSeam, seam));

      const first = yield* titleOf;

      yield* Ref.set(script.title, answer("A second title"));
      yield* retitleSubagentRows.pipe(Effect.provideService(HarnessSeam, seam));

      assert.strictEqual(first, "Cheapest path argument");
      assert.strictEqual(yield* titleOf, "Cheapest path argument");

      const prompts = yield* Ref.get(script.prompts);

      assert.lengthOf(prompts, 1);
      assert.include(prompts[0], NODE_PROMPT);
    }).pipe(Effect.provide(titledLayer(false)))
  );
});
