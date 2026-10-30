// A subagent's shell row (ADR 0028). The child's conversation is created inside pi-durable's commit,
// but its `ThreadShell` row lives in `cairn.sqlite`, another store, so the row is a repair, not part
// of that commit: one fiber answers each `ThreadEnsured` that names a parent with `ThreadCreate`, and
// a boot repair does the same for every child conversation without a row. The command id is the
// child's thread id, so a repeat (the fiber after a crash, then the boot repair) lands once; a row
// that exists already is left as it is. The row takes its project from the parent's row, its
// branch and worktree from the child's own worktree when it has one (else the parent's row's), its
// title from the brief's description, its model from the dispatch record (a workflow node, which
// has no registry item, from its node in the parent's `cairn.workflows`), its mode from the
// child's link, and a `lineage` naming the parent and the root. The sidebar hides a row with a
// lineage (`isSubagentThread`), the projector sets its parent's tally from the registry, and the
// shell refuses to settle, snooze, pin or archive it, or to settle its parent while it works.

import { CommandId, ThreadId } from "@cairn/protocol/Ids";
import { ModelRef } from "@cairn/protocol/Models";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import { RuntimeMode as RuntimeModeSchema } from "@cairn/protocol/Policy";
import {
  CHILD_DOCUMENT,
  ChildWorktree,
  SUBAGENTS_DOCUMENT,
} from "@cairn/protocol/Subagents";
import type { ThreadLineage } from "@cairn/protocol/Subagents";
import { WORKFLOWS_DOCUMENT } from "@cairn/protocol/Workflows";
import type { ConversationId, Cursor } from "@earendil-works/pi-durable";
import {
  Cause,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";

import { Brain } from "../brain/Brain.ts";
import type { BrainSession } from "../brain/Brain.ts";
import { ThreadMeta } from "../brain/CairnDocs.ts";
import { durable } from "../brain/Durable.ts";
import type { DurableCallError } from "../brain/Durable.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { EventSink } from "../shell/EventSink.ts";
import { ThreadCreate } from "../shell/ShellCommands.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { WorkflowsDoc } from "../workflows/WorkflowDocs.ts";
import { conversationOf } from "./Delivery.ts";
import { ChildDoc, isLinked, SubagentsDoc } from "./SubagentDocs.ts";
import type { JsonRecord } from "./SubagentDocs.ts";

/** How many conversations the boot repair reads per page. */
const SCAN_PAGE = 200;

/** What a child's row is made from, read from pi-durable. */
export interface ChildRowSource {
  readonly threadId: ThreadId;
  readonly lineage: ThreadLineage;
  readonly title: string;
  /** The dispatched model; none when the record names none, and the parent's is used. */
  readonly model: Option.Option<ModelRef>;
  readonly runtimeMode: RuntimeMode;
  /** The child's own worktree (a writing role's); none for a shared child, on its parent's. */
  readonly worktree: Option.Option<ChildWorktree>;
}

const nonEmpty = (value: string | undefined): Option.Option<string> =>
  value !== undefined && value.trim().length > 0
    ? Option.some(value)
    : Option.none();

/** The part of a registry item's `dispatch` record a row reads. */
const decodeDispatched = Schema.decodeUnknownOption(
  Schema.Struct({ resolved: Schema.Struct({ model: ModelRef }) })
);

const decodeWorktree = Schema.decodeUnknownOption(ChildWorktree);

/** The dispatched model, when the record names a real one. */
const dispatchedModel = (dispatch: JsonRecord | undefined) =>
  decodeDispatched(dispatch).pipe(
    Option.map((found) => found.resolved.model),
    Option.filter((model) => model.provider !== "unknown")
  );

/** The part of a parent's `cairn.workflows` a row reads: each node's child and model. */
const NodeLedger = Schema.Struct({
  items: Schema.Record(
    Schema.String,
    Schema.Struct({
      nodes: Schema.Record(
        Schema.String,
        Schema.Struct({
          childThreadId: Schema.NullOr(Schema.String),
          provider: Schema.NullOr(Schema.String),
          modelId: Schema.NullOr(Schema.String),
        })
      ),
    })
  ),
});

type NodeLedger = typeof NodeLedger.Type;

const decodeLedger = Schema.decodeUnknownOption(NodeLedger);

const decodeModel = Schema.decodeUnknownOption(ModelRef);

/**
 * The model a workflow node's child runs on: its node's resolved role, from the parent's
 * `cairn.workflows` (`ledger`). None when no node names `threadId` as its child.
 */
export const workflowNodeModel = (
  ledger: Option.Option<NodeLedger>,
  threadId: ThreadId
): Option.Option<ModelRef> =>
  Option.flatMap(ledger, ({ items }) =>
    Option.flatMap(
      Option.fromUndefinedOr(
        Object.values(items)
          .flatMap((row) => Object.values(row.nodes))
          .find((node) => node.childThreadId === threadId)
      ),
      (node) =>
        decodeModel({ provider: node.provider, modelId: node.modelId }).pipe(
          Option.filter((model) => model.provider !== "unknown")
        )
    )
  );

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

    return Option.map(nonEmpty(meta?.threadId), (threadId) => ({
      threadId: ThreadId.make(threadId),
      lineage: {
        parentThreadId: ThreadId.make(link.parentThreadId),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make(link.rootThreadId),
      },
      title: Option.getOrElse(nonEmpty(item?.description), () => "Subagent"),
      model: Option.orElse(dispatchedModel(item?.dispatch), () =>
        workflowNodeModel(decodeLedger(ledger), ThreadId.make(threadId))
      ),
      runtimeMode: link.permissionMode,
      worktree: decodeWorktree(item?.worktree ?? null),
    }));
  });

/** What a seam-read row source reads of a child's `cairn.child`. */
const decodeLink = Schema.decodeUnknownOption(
  Schema.Struct({
    key: Schema.String,
    parentThreadId: ThreadId,
    rootThreadId: ThreadId,
    permissionMode: RuntimeModeSchema,
  })
);

/** What a seam-read row source reads of the parent's registry item. */
const decodeItem = Schema.decodeUnknownOption(
  Schema.Struct({
    description: Schema.String,
    dispatch: Schema.Json,
    worktree: Schema.Json,
  })
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

  const ledger = yield* harness.document(parentThreadId, WORKFLOWS_DOCUMENT);

  return Option.some<ChildRowSource>({
    threadId,
    lineage: {
      parentThreadId,
      relationshipToParent: "subagent",
      rootThreadId,
    },
    title: Option.getOrElse(
      Option.flatMap(item, ({ description }) => nonEmpty(description)),
      () => "Subagent"
    ),
    model: Option.orElse(
      Option.flatMap(item, ({ dispatch }) =>
        decodeDispatched(dispatch).pipe(
          Option.map((found) => found.resolved.model),
          Option.filter((model) => model.provider !== "unknown")
        )
      ),
      () => workflowNodeModel(Option.flatMap(ledger, decodeLedger), threadId)
    ),
    runtimeMode: permissionMode,
    worktree: Option.flatMap(item, ({ worktree }) => decodeWorktree(worktree)),
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
        thinkingLevel: shell.thinkingLevel,
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

/** Logs a row that could not be made (the boot repair tries again at the next boot): none then. */
const logged = <A, E extends { readonly message: string }, R>(
  threadId: string,
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.tapError((failure) =>
      Effect.logWarning("subagent row not made").pipe(
        Effect.annotateLogs({
          event: "subagent_row_failed",
          threadId,
          error: failure.message,
        })
      )
    ),
    Effect.option
  );

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
      ThreadRows | EventSink | HarnessSeam
    >();

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

    yield* Stream.runForEach(harness.events, (event) =>
      Predicate.isTagged(event, "ThreadEnsured") && Option.isSome(event.parent)
        ? onEnsured(event)
        : Effect.void
    ).pipe(
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
