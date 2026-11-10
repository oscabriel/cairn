// A subagent's shell row (ADR 0028). The child's conversation is created inside pi-durable's commit,
// but its `ThreadShell` row lives in `cairn.sqlite`, another store, so the row is a repair, not part
// of that commit: one fiber answers each `ThreadEnsured` that names a parent with `ThreadCreate`, and
// a boot repair does the same for every child conversation without a row. The command id is the
// child's thread id, so a repeat (the fiber after a crash, then the boot repair) lands once; a row
// that exists already is left as it is. The row takes its project from the parent's row, its
// branch and worktree from the child's own worktree when it has one (else the parent's row's), a
// fallback title (the brief's description, else its workflow node's label), its model from the dispatch record (a workflow node, which
// has no registry item, from its node in the parent's `cairn.workflows`, which gives its thinking
// level too), its mode from the child's link, and a `lineage` naming the parent and the root. The
// sidebar hides a row with a lineage (`isSubagentThread`), the projector sets its parent's tally
// from the registry, and the shell refuses to settle, snooze, pin or archive it, or to settle its
// parent while it works.
//
// A child is named as a launched thread is (`ThreadTitles`): the same fiber answers a child's first
// user `MessageCommitted` (its brief, or its node's prompt with the node's label as context) by
// asking the title model off the event loop and committing one `ThreadRename` under a command id
// derived from the child's thread id (`titleChild`). A receipt for it, or a title that is no longer
// the fallback, asks nothing, so a child is named at most once and a user's rename wins; a kill
// mid-generation commits nothing and the fallback stays. A second boot repair names the rows made
// before children were titled, still titled `CHILD_TITLE`, from their first user message.

import { CommandId, EntryId, ThreadId } from "@cairn/protocol/Ids";
import { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import { ThreadRename } from "@cairn/protocol/ShellCommands";
import {
  CHILD_DOCUMENT,
  ChildDocument,
  ChildWorktree,
  DispatchRecord,
  SubagentRecord,
  SUBAGENTS_DOCUMENT,
} from "@cairn/protocol/Subagents";
import type { ThreadLineage } from "@cairn/protocol/Subagents";
import { NodeRecord, WORKFLOWS_DOCUMENT } from "@cairn/protocol/Workflows";
import type { ConversationId, Cursor } from "@earendil-works/pi-durable";
import {
  Cause,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
  Struct,
} from "effect";

import { Brain } from "../brain/Brain.ts";
import type { BrainSession } from "../brain/Brain.ts";
import { ThreadMeta } from "../brain/CairnDocs.ts";
import { durable } from "../brain/Durable.ts";
import type { DurableCallError } from "../brain/Durable.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { ChildDoc, isLinked, SubagentsDoc } from "../brain/SubagentDocs.ts";
import { WorkflowsDoc } from "../brain/WorkflowsDoc.ts";
import { PI_DEFAULT_THINKING } from "../models/PiModelSource.ts";
import { CommandReceipts } from "../shell/CommandReceipts.ts";
import { EventSink } from "../shell/EventSink.ts";
import { ThreadCreate } from "../shell/ShellCommands.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { derivedCommandId } from "../threads/ThreadLaunch.ts";
import { placeholderTitle, ThreadTitles } from "../threads/ThreadTitles.ts";
import { conversationOf } from "./Delivery.ts";

/** How many conversations the boot repair reads per page. */
const SCAN_PAGE = 200;

/** What a child's row is made from, read from pi-durable. */
export interface ChildRowSource {
  readonly threadId: ThreadId;
  readonly lineage: ThreadLineage;
  /** Shown until the generated title arrives (`fallbackTitle`). */
  readonly title: string;
  /** A workflow node's label, which its generated title is asked with. */
  readonly label: Option.Option<string>;
  /** The dispatched model; none when the record names none, and the parent's is used. */
  readonly model: Option.Option<ModelRef>;
  /** A workflow node's own level; none takes the parent's (a dispatched subagent's row). */
  readonly thinkingLevel: Option.Option<ThinkingLevel>;
  readonly runtimeMode: RuntimeMode;
  /** The child's own worktree (a writer's); none for a shared child, on its parent's. */
  readonly worktree: Option.Option<ChildWorktree>;
}

/** The title of a child row with nothing better to show, and of the rows made before titles. */
export const CHILD_TITLE = "Subagent";

const nonEmpty = (value: string | undefined): Option.Option<string> =>
  value !== undefined && value.trim().length > 0
    ? Option.some(value)
    : Option.none();

/**
 * The part of a registry item's `dispatch` record a row reads: the protocol's `DispatchRecord`'s
 * resolved model, and only that, so a resolved spec no `ModelSpec` may name (an OpenRouter `~`
 * alias a parent ran on, recorded unchecked) still gives the row its model.
 */
const DispatchedModel = DispatchRecord.mapFields(
  Struct.pick(["resolved"])
).mapFields(
  Struct.evolve({
    resolved: (resolved) => resolved.mapFields(Struct.pick(["model"])),
  })
);

const decodeDispatched = Schema.decodeUnknownOption(DispatchedModel);

const decodeWorktree = Schema.decodeUnknownOption(ChildWorktree);

/** The model a decoded dispatch names, when it is a real one. */
const realModel = (dispatched: typeof DispatchedModel.Type) =>
  Option.some(dispatched.resolved.model).pipe(
    Option.filter((model) => model.provider !== "unknown")
  );

/** The dispatched model, when the record names a real one. */
const dispatchedModel = (dispatch: Schema.Json | undefined) =>
  Option.flatMap(decodeDispatched(dispatch), realModel);

/**
 * The part of a parent's `cairn.workflows` a row reads: each node's child, model, level, effort
 * and label, as the protocol's `NodeRecord` has them.
 */
const NodeLedger = Schema.Struct({
  items: Schema.Record(
    Schema.String,
    Schema.Struct({
      nodes: Schema.Record(
        Schema.String,
        NodeRecord.mapFields(
          Struct.pick([
            "childThreadId",
            "provider",
            "modelId",
            "effort",
            "thinkingLevel",
            "label",
          ])
        )
      ),
    })
  ),
});

type NodeLedger = typeof NodeLedger.Type;

const decodeLedger = Schema.decodeUnknownOption(NodeLedger);

const decodeModel = Schema.decodeUnknownOption(ModelRef);

const isThinkingLevel = Schema.is(ThinkingLevel);

/** The node in `ledger` whose child is `threadId`. */
const nodeOf = (ledger: Option.Option<NodeLedger>, threadId: ThreadId) =>
  Option.flatMap(ledger, ({ items }) =>
    Option.fromUndefinedOr(
      Object.values(items)
        .flatMap((row) => Object.values(row.nodes))
        .find((node) => node.childThreadId === threadId)
    )
  );

/** What a workflow node's child runs on: its model and thinking level. */
export interface NodeRun {
  readonly model: ModelRef;
  readonly thinkingLevel: ThinkingLevel;
}

/**
 * What a workflow node's child runs on: its node's resolved model and the level its row recorded,
 * from the parent's `cairn.workflows` (`ledger`); a row written before the level was recorded falls
 * back to its effort, and one with neither runs at the model's default level, pi's
 * (`PI_DEFAULT_THINKING`), as a new thread does. None when no node names `threadId` as its child.
 */
export const workflowNodeRun = (
  ledger: Option.Option<NodeLedger>,
  threadId: ThreadId
): Option.Option<NodeRun> =>
  Option.flatMap(nodeOf(ledger, threadId), (node) =>
    decodeModel({ provider: node.provider, modelId: node.modelId }).pipe(
      Option.filter((model) => model.provider !== "unknown"),
      Option.map((model): NodeRun => ({
        model,
        thinkingLevel:
          [node.thinkingLevel, node.effort].find(isThinkingLevel) ??
          PI_DEFAULT_THINKING,
      }))
    )
  );

/** A workflow node's label, the context its child's title is generated with. */
const nodeLabel = (ledger: Option.Option<NodeLedger>, threadId: ThreadId) =>
  Option.flatMap(nodeOf(ledger, threadId), (node) => nonEmpty(node.label));

/**
 * The title a child's row shows until its generated title arrives, and keeps when none does: the
 * brief's description, else its workflow node's label, cut as a thread's placeholder is; else
 * `CHILD_TITLE`.
 */
const fallbackTitle = (
  description: Option.Option<string>,
  label: Option.Option<string>
) =>
  Option.match(
    Option.orElse(description, () => label),
    {
      onNone: () => CHILD_TITLE,
      onSome: placeholderTitle,
    }
  );

/** The row's model and level: the dispatch record's model, else its workflow node's run. */
const modelAndLevel = (
  dispatched: Option.Option<ModelRef>,
  node: () => Option.Option<NodeRun>
): Pick<ChildRowSource, "model" | "thinkingLevel"> =>
  Option.match(dispatched, {
    onSome: (model) => ({
      model: Option.some(model),
      thinkingLevel: Option.none(),
    }),
    onNone: () => {
      const run = node();

      return {
        model: Option.map(run, ({ model }) => model),
        thinkingLevel: Option.map(run, ({ thinkingLevel }) => thinkingLevel),
      };
    },
  });

/** A child conversation's row source; none for a conversation that is not a subagent. */
export const childRowSource = (
  session: BrainSession,
  conversationId: ConversationId
): Effect.Effect<Option.Option<ChildRowSource>, DurableCallError> =>
  durable("subagents.row-source", async (context) => {
    const link = await session.harness.snapshot(
      ChildDoc,
      conversationId,
      context
    );

    if (!isLinked(link)) {
      return Option.none();
    }

    const meta = await session.harness.snapshot(
      ThreadMeta,
      conversationId,
      context
    );

    const registry = await session.harness.snapshot(
      SubagentsDoc,
      conversationOf(link.parentConversationId),
      context
    );

    const item = registry?.items[link.key];

    const ledger = await session.harness.snapshot(
      WorkflowsDoc,
      conversationOf(link.parentConversationId),
      context
    );

    return Option.map(nonEmpty(meta?.threadId), (threadId) => {
      const nodes = decodeLedger(ledger);
      const label = nodeLabel(nodes, ThreadId.make(threadId));

      return {
        threadId: ThreadId.make(threadId),
        lineage: {
          parentThreadId: ThreadId.make(link.parentThreadId),
          relationshipToParent: "subagent" as const,
          rootThreadId: ThreadId.make(link.rootThreadId),
        },
        title: fallbackTitle(nonEmpty(item?.description), label),
        label,
        ...modelAndLevel(dispatchedModel(item?.dispatch), () =>
          workflowNodeRun(nodes, ThreadId.make(threadId))
        ),
        runtimeMode: link.permissionMode,
        worktree: decodeWorktree(item?.worktree ?? null),
      };
    });
  });

/** What a seam-read row source reads of a child's `cairn.child`: the protocol's `ChildDocument`. */
const decodeLink = Schema.decodeUnknownOption(
  ChildDocument.mapFields(
    Struct.pick(["key", "parentThreadId", "rootThreadId", "permissionMode"])
  )
);

/** What a seam-read row source reads of the parent's registry item; of its dispatch, the model. */
const decodeItem = Schema.decodeUnknownOption(
  SubagentRecord.mapFields(
    Struct.pick(["description", "dispatch", "worktree"])
  ).mapFields(Struct.evolve({ dispatch: () => DispatchedModel }))
);

const decodeItems = Schema.decodeUnknownOption(
  Schema.Struct({ items: Schema.Record(Schema.String, Schema.Json) })
);

/**
 * A child's row source read through the seam (`HarnessSeam.document`), as the stream projects its
 * `cairn.child` and its parent's `cairn.subagents`: the scripted harness's, which has no pi-durable
 * session to read. None for a thread that is not a subagent.
 */
export const seamRowSource = Effect.fn("SubagentRows.seamRowSource")(function* (
  threadId: ThreadId
) {
  const harness = yield* HarnessSeam;

  const link = Option.flatMap(
    yield* harness.document(threadId, CHILD_DOCUMENT),
    decodeLink
  );

  if (Option.isNone(link)) {
    return Option.none<ChildRowSource>();
  }

  const { key, parentThreadId, rootThreadId, permissionMode } = link.value;

  const item = Option.flatMap(
    Option.flatMap(
      yield* harness.document(parentThreadId, SUBAGENTS_DOCUMENT),
      decodeItems
    ),
    ({ items }) =>
      Option.flatMap(Option.fromUndefinedOr(items[key]), decodeItem)
  );

  const ledger = Option.flatMap(
    yield* harness.document(parentThreadId, WORKFLOWS_DOCUMENT),
    decodeLedger
  );

  const label = nodeLabel(ledger, threadId);

  return Option.some<ChildRowSource>({
    threadId,
    lineage: {
      parentThreadId,
      relationshipToParent: "subagent",
      rootThreadId,
    },
    title: fallbackTitle(
      Option.flatMap(item, ({ description }) => nonEmpty(description)),
      label
    ),
    label,
    ...modelAndLevel(
      Option.flatMap(item, ({ dispatch }) => realModel(dispatch)),
      () => workflowNodeRun(ledger, threadId)
    ),
    runtimeMode: permissionMode,
    worktree: Option.flatMap(item, ({ worktree }) =>
      Option.fromNullOr(worktree)
    ),
  });
});

/**
 * Makes a child's row once. Nothing for a child that has a row, or whose parent has none (a parent
 * deleted from the shell keeps its children out of it too).
 */
export const ensureChildRow = Effect.fn("SubagentRows.ensureChildRow")(
  function* (source: ChildRowSource) {
    const rows = yield* ThreadRows;
    const sink = yield* EventSink;

    if (Option.isSome(yield* rows.get(source.threadId))) {
      return false;
    }

    const parent = yield* rows.get(source.lineage.parentThreadId);

    if (Option.isNone(parent)) {
      return false;
    }

    const { shell } = parent.value;

    yield* sink.commitCommand(
      ThreadCreate.make({
        // Derived from the thread, so a repeat lands on the stored receipt.
        commandId: CommandId.make(source.threadId),
        threadId: source.threadId,
        projectId: shell.projectId,
        title: source.title,
        provider: Option.match(source.model, {
          onNone: () => shell.provider,
          onSome: (model) => model.provider,
        }),
        modelId: Option.match(source.model, {
          onNone: () => shell.modelId,
          onSome: (model) => model.modelId,
        }),
        thinkingLevel: Option.getOrElse(
          source.thinkingLevel,
          () => shell.thinkingLevel
        ),
        runtimeMode: source.runtimeMode,
        branch: Option.match(source.worktree, {
          onNone: () => shell.branch,
          onSome: (worktree) => Option.some(worktree.branch),
        }),
        worktreePath: Option.match(source.worktree, {
          onNone: () => shell.worktreePath,
          onSome: (worktree) => Option.some(worktree.path),
        }),
        lineage: Option.some(source.lineage),
      })
    );

    return true;
  }
);

/**
 * Logs a row or a title that could not be made (the boot repair tries a row again at the next
 * boot): none then.
 */
const logged = <A, E extends { readonly message: string }, R>(
  threadId: string,
  effect: Effect.Effect<A, E, R>,
  what: "row" | "title" = "row"
) =>
  effect.pipe(
    Effect.tapError((failure) =>
      Effect.logWarning(`subagent ${what} not made`).pipe(
        Effect.annotateLogs({
          event: `subagent_${what}_failed`,
          threadId,
          error: failure.message,
        })
      )
    ),
    Effect.option
  );

/** The rename a child's generated title commits under: one per child, so a repeat lands once. */
const titleCommandId = (threadId: ThreadId) =>
  derivedCommandId(CommandId.make(threadId), "title");

/**
 * Names a child from what it was asked to do (`message`, its first input), as a launch names a
 * thread from its first message (`ThreadTitles`), with its workflow node's label as context. At
 * most once per child: nothing once its title rename has a receipt, or when the row's title is
 * neither its fallback nor `CHILD_TITLE` (a user's rename wins). No model title leaves the
 * fallback; a row still titled `CHILD_TITLE` (one made before titles) takes the fallback then,
 * under the same rename, so it is not asked again. A kill mid-generation commits nothing, and the
 * row keeps the title it had. True when it renamed the row.
 */
export const titleChild = Effect.fn("SubagentRows.titleChild")(function* (
  threadId: ThreadId,
  message: string
) {
  const rows = yield* ThreadRows;
  const receipts = yield* CommandReceipts;
  const sink = yield* EventSink;
  const titles = yield* ThreadTitles;
  const commandId = titleCommandId(threadId);

  const row = yield* rows.get(threadId);

  if (
    Option.isNone(row) ||
    Option.isNone(row.value.shell.lineage) ||
    Option.isSome(yield* receipts.find(commandId))
  ) {
    return false;
  }

  const before = row.value.shell.title;

  const source = yield* seamRowSource(threadId).pipe(
    Effect.catchTag("HarnessError", () => Effect.succeedNone)
  );

  const fallback = Option.match(source, {
    onNone: () => CHILD_TITLE,
    onSome: ({ title }) => title,
  });

  if (before !== fallback && before !== CHILD_TITLE) {
    return false;
  }

  const label = Option.flatMap(source, (found) => found.label);

  const asked = Option.match(label, {
    onNone: () => message,
    onSome: (found) =>
      message.trim() === "" ? found : `Workflow node: ${found}\n\n${message}`,
  });

  const title = Option.getOrElse(
    yield* titles.generate(threadId, asked),
    () => fallback
  );

  const current = yield* rows.get(threadId);

  if (
    title === before ||
    Option.isNone(current) ||
    current.value.shell.title !== before
  ) {
    return false;
  }

  yield* sink.commitCommand(ThreadRename.make({ commandId, threadId, title }));

  return true;
});

/** A projected user entry's text: its text parts. */
const decodeUserMessage = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([
      Schema.String,
      Schema.Array(
        Schema.Struct({
          type: Schema.String,
          text: Schema.optionalKey(Schema.String),
        })
      ),
    ]),
  })
);

const USER_KINDS: ReadonlySet<string> = new Set(["pi.user", "cairn.user"]);

/** How many entries the title repair reads per history page. */
const HISTORY_PAGE = 200;

/** The text of a child's first user message, read back through its history; "" when none. */
const firstUserMessage = Effect.fn("SubagentRows.firstUserMessage")(function* (
  threadId: ThreadId
) {
  const harness = yield* HarnessSeam;
  let before = EntryId.make(Number.MAX_SAFE_INTEGER);
  let first = "";

  for (;;) {
    const page = yield* harness.history(threadId, {
      before,
      limit: HISTORY_PAGE,
    });

    const text = page.entries
      .filter((entry) => USER_KINDS.has(entry.kind))
      .flatMap((entry) => Option.toArray(decodeUserMessage(entry.model?.[0])))
      .map(({ content }) =>
        Predicate.isString(content)
          ? content
          : content
              .flatMap((part) =>
                part.type === "text" && part.text !== undefined
                  ? [part.text]
                  : []
              )
              .join("\n\n")
      )
      .find((found) => found.trim() !== "");

    first = text ?? first;

    const [oldest] = page.entries;

    if (!page.hasMore || oldest === undefined) {
      return first;
    }

    before = oldest.id;
  }
});

/** How many rows the title repair names at once. */
const RETITLE_CONCURRENCY = 4;

/**
 * The boot repair for rows made before children were titled: every child row still titled
 * `CHILD_TITLE` is named from its first user message (`titleChild`), at most once each.
 */
export const retitleSubagentRows = Effect.gen(function* () {
  const rows = yield* ThreadRows;

  const untitled = (yield* rows.listLive).filter(
    (row) => Option.isSome(row.shell.lineage) && row.shell.title === CHILD_TITLE
  );

  const renamed = yield* Effect.forEach(
    untitled,
    (row) =>
      logged(
        row.shell.id,
        Effect.gen(function* () {
          const message = yield* firstUserMessage(row.shell.id).pipe(
            Effect.catchTag("HarnessError", () => Effect.succeed(""))
          );

          return yield* titleChild(row.shell.id, message);
        }),
        "title"
      ),
    { concurrency: RETITLE_CONCURRENCY }
  );

  const count = renamed.filter((done) => Option.contains(done, true)).length;

  yield* Effect.logInfo(`retitled ${count} subagent rows`).pipe(
    Effect.annotateLogs({ event: "boot_subagent_titles", renamed: count })
  );
});

/**
 * The boot repair: a row for every child conversation that has none. Nothing without pi-durable
 * (the scripted brain's children never outlive a process).
 */
export const repairSubagentRows = Effect.gen(function* () {
  const found = yield* Effect.serviceOption(Brain);

  if (Option.isNone(found)) {
    return;
  }

  const session = yield* found.value.session;
  let after: Option.Option<Cursor> = Option.none();
  let made = 0;

  do {
    const cursor = Option.getOrUndefined(after);

    const page = yield* durable(
      "conversations.scan",
      async (context) =>
        await session.storage.scanConversations({}, SCAN_PAGE, cursor, context)
    );

    for (const conversation of page.items) {
      const source = yield* childRowSource(session, conversation.id);

      for (const child of Option.toArray(source)) {
        const createdNow = yield* logged(child.threadId, ensureChildRow(child));

        if (Option.getOrElse(createdNow, () => false)) {
          made += 1;
        }
      }
    }

    after = Option.fromUndefinedOr(page.next);
  } while (Option.isSome(after));

  yield* Effect.logInfo(`made ${made} subagent rows`).pipe(
    Effect.annotateLogs({ event: "boot_subagent_rows", made })
  );
});

/**
 * The fiber that makes each child's row as its creating commit lands: it answers every
 * `ThreadEnsured` naming a parent, for as long as the scope lives; without pi-durable (the scripted
 * harness) it reads each child through the seam (`seamRowSource`). Leaves
 * `HarnessSeam`, `ThreadRows` and `EventSink` to the composition root.
 */
export const SubagentRows = Layer.effectDiscard(
  Effect.gen(function* () {
    const harness = yield* HarnessSeam;
    const brain = yield* Effect.serviceOption(Brain);

    const context = yield* Effect.context<
      ThreadRows | EventSink | HarnessSeam | CommandReceipts | ThreadTitles
    >();

    const naming = yield* FiberMap.make<ThreadId>();
    // Children this process has asked a title for, so a later input does not ask again.
    const asked = new Set<ThreadId>();

    const sourceOf = (event: {
      readonly threadId: ThreadId;
      readonly conversationId: number;
    }) =>
      Option.match(brain, {
        // The scripted harness has no pi-durable session: its child reads through the seam.
        onNone: () => seamRowSource(event.threadId),
        onSome: (found) =>
          Effect.flatMap(found.session, (session) =>
            childRowSource(session, conversationOf(event.conversationId))
          ),
      });

    const onEnsured = (event: {
      readonly threadId: ThreadId;
      readonly conversationId: number;
    }) =>
      logged(
        event.threadId,
        Effect.gen(function* () {
          const source = yield* sourceOf(event);

          for (const child of Option.toArray(source)) {
            yield* ensureChildRow(child);
          }
        })
      ).pipe(Effect.provideContext(context));

    // A child's first input names it, off the event loop: the title model takes seconds.
    const onUserMessage = (event: {
      readonly threadId: ThreadId;
      readonly text: string;
    }) =>
      Effect.gen(function* () {
        if (asked.has(event.threadId)) {
          return;
        }

        const row = yield* ThreadRows.use((rows) => rows.get(event.threadId));

        if (Option.isNone(row) || Option.isNone(row.value.shell.lineage)) {
          return;
        }

        asked.add(event.threadId);

        yield* FiberMap.run(
          naming,
          event.threadId,
          logged(
            event.threadId,
            titleChild(event.threadId, event.text),
            "title"
          ).pipe(Effect.provideContext(context))
        );
      }).pipe(
        (effect) => logged(event.threadId, effect, "title"),
        Effect.provideContext(context)
      );

    yield* Stream.runForEach(harness.events, (event) => {
      if (
        Predicate.isTagged(event, "ThreadEnsured") &&
        Option.isSome(event.parent)
      ) {
        return onEnsured(event);
      }

      return Predicate.isTagged(event, "MessageCommitted") &&
        event.role === "user"
        ? onUserMessage(event)
        : Effect.void;
    }).pipe(
      // The brain's shutdown interrupts the fiber with its scope: that end is expected, and only
      // an end the scope did not ask for (the event stream failed or completed) is a warning.
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.logDebug("subagent row fiber stopped with the brain").pipe(
              Effect.annotateLogs({ event: "subagent_rows_stopped" })
            )
          : Effect.logWarning("subagent row fiber ended").pipe(
              Effect.annotateLogs({
                event: "subagent_rows_ended",
                exit: exit._tag,
              })
            )
      ),
      Effect.forkScoped({ startImmediately: true })
    );
  })
);
