// The `next` shell's Commands: minting a project's first draft, a refresh's launch, a scratch
// thread's turns and its clear, focusing the field an overlay opens with, and saving which scratch
// thread this device holds, stopping a child, a workflow or one of its nodes from the work panel,
// and the user's mark on a goal's criterion from the goal panel. Each answers with one Message. A
// refresh is `thread.launch` with `replaces` (5H): the new project thread, the old one's archive
// and the moved mark land in one shell commit. The scratch thread's first message launches it in
// the scratch project (made here first, as the composer's projectless launch does); later ones are
// sends. The add-project picker lists folders on the Beelink (`projects.browse`) and adds one with
// `shell.dispatch` (`ProjectCreate`), so a refused folder answers in the picker itself.

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { RootWorkspace, ThreadLaunchInput } from "@cairn/protocol/Launch";
import { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import { RuntimeMode } from "@cairn/protocol/Policy";
import { ProjectCreate, ThreadClear } from "@cairn/protocol/ShellCommands";
import { SendInput } from "@cairn/protocol/Thread";
import { Effect, Option, Predicate, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Command } from "foldkit";
import { focus } from "foldkit/dom";

import {
  mintCommandId,
  mintRequestId,
  mintThreadId,
} from "../../composer/Ids.ts";
import { CairnConnection, withBoundary } from "../../connection/Connection.ts";
import {
  callFailureText,
  failureMessage,
  failureMessageOrTag,
} from "../../connection/Failure.ts";
import { OutboxItem } from "../../connection/Outbox.ts";
import { Message } from "./Message.ts";

export type { Services } from "../../Command.ts";

/** The localStorage key the scratch thread's id is saved under. */
export const SCRATCH_STORAGE_KEY = "cairn:next:scratch-thread:v1";

/** A turn's words, with no attachments or skills. */
const turnOf = (
  requestId: Effect.Success<typeof mintRequestId>,
  text: string
) => ({
  requestId,
  text,
  attachments: [],
  skillRefs: [],
});

/**
 * Mints the draft a project's first thread is written in. The root gives it the project, so the
 * launch goes there and not to the draft hero's fallback (the most recently updated project, whose
 * project thread a top-level launch would archive).
 */
export const PrepareProjectDraft = Command.define("PrepareProjectDraft", {
  args: { projectId: ProjectId },
  messages: [Message.PreparedProjectDraft],
  execute: ({ projectId }) =>
    Effect.map(mintThreadId, (draftId) =>
      Message.PreparedProjectDraft({ projectId, draftId })
    ),
});

/** Lists the folders in `path` (the home folder when none) for the add-project picker. */
export const BrowseFolders = Command.define("BrowseFolders", {
  args: { request: Schema.Int, path: Schema.Option(Schema.String) },
  messages: [Message.ReceivedFolders, Message.FailedFolders],
  execute: ({ path, request }) =>
    withBoundary(
      Effect.flatMap(CairnConnection.get, (client) =>
        client["projects.browse"]({ path })
      )
    ).pipe(
      Effect.match({
        onSuccess: (result) => Message.ReceivedFolders({ request, result }),
        onFailure: (failure) =>
          Message.FailedFolders({
            request,
            message: failureMessage(
              failure,
              "The folder could not be listed. Try again."
            ),
          }),
      })
    ),
});

/** Makes `folder` a project; the brain checks the folder and refuses one already a project. */
export const CreateProject = Command.define("CreateProject", {
  args: { folder: Schema.String },
  messages: [Message.AddedProject, Message.FailedAddProject],
  execute: ({ folder }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;
        const commandId = yield* mintCommandId;

        return yield* client["shell.dispatch"](
          ProjectCreate.make({
            commandId,
            workspaceRoot: folder,
            title: Option.none(),
          })
        );
      })
    ).pipe(
      Effect.match({
        onSuccess: () => Message.AddedProject({ folder }),
        onFailure: (failure) =>
          Message.FailedAddProject({
            message: failureMessage(
              failure,
              "The project could not be added. Try again."
            ),
          }),
      })
    ),
});

/** Hands the added folder's project back as a Message, so the rail selects it as a click would. */
export const SelectAddedProject = Command.define("SelectAddedProject", {
  args: { projectId: ProjectId },
  messages: [Message.FoundAddedProject],
  execute: ({ projectId }) =>
    Effect.succeed(Message.FoundAddedProject({ projectId })),
});

/** Moves focus to the field `selector` names once the render that draws it has landed. */
export const FocusField = Command.define("FocusField", {
  args: { selector: Schema.String },
  messages: [Message.CompletedFocus],
  execute: ({ selector }) =>
    focus(selector).pipe(Effect.ignore, Effect.as(Message.CompletedFocus())),
});

/** Mints the refresh's launch: a new project thread replacing `replaces`, on its model. */
export const PrepareRefresh = Command.define("PrepareRefresh", {
  args: {
    projectId: ProjectId,
    replaces: ThreadId,
    model: ModelRef,
    thinkingLevel: ThinkingLevel,
    runtimeMode: RuntimeMode,
    text: Schema.String,
  },
  messages: [Message.PreparedRefresh],
  execute: (plan) =>
    Effect.gen(function* () {
      const threadId = yield* mintThreadId;
      const commandId = yield* mintCommandId;
      const requestId = yield* mintRequestId;

      const input = ThreadLaunchInput.make({
        commandId,
        threadId,
        projectId: plan.projectId,
        title: Option.none(),
        model: plan.model,
        thinkingLevel: plan.thinkingLevel,
        runtimeMode: plan.runtimeMode,
        workspace: RootWorkspace.make({ branch: Option.none() }),
        initialMessage: turnOf(requestId, plan.text),
        replaces: plan.replaces,
      });

      return Message.PreparedRefresh({
        item: OutboxItem.Launch({ input }),
        threadId,
      });
    }),
});

/**
 * Mints a scratch turn: with no thread yet, the launch that makes it in the scratch project (made
 * first); with one, a send to it.
 */
export const PrepareScratchTurn = Command.define("PrepareScratchTurn", {
  args: {
    threadId: Schema.Option(ThreadId),
    model: ModelRef,
    thinkingLevel: ThinkingLevel,
    text: Schema.String,
  },
  messages: [Message.PreparedScratchTurn, Message.FailedPrepare],
  execute: (plan) =>
    Effect.gen(function* () {
      const requestId = yield* mintRequestId;

      if (Option.isSome(plan.threadId)) {
        return Message.PreparedScratchTurn({
          item: OutboxItem.Send({
            input: SendInput.make({
              threadId: plan.threadId.value,
              input: turnOf(requestId, plan.text),
              whenBusy: "followUp",
            }),
          }),
          threadId: plan.threadId.value,
        });
      }

      const project = yield* withBoundary(
        Effect.flatMap(CairnConnection.get, (client) =>
          client["projects.ensureScratch"]()
        )
      );

      const threadId = yield* mintThreadId;
      const commandId = yield* mintCommandId;

      const input = ThreadLaunchInput.make({
        commandId,
        threadId,
        projectId: project.id,
        title: Option.none(),
        model: plan.model,
        thinkingLevel: plan.thinkingLevel,
        runtimeMode: "full-access",
        workspace: RootWorkspace.make({ branch: Option.none() }),
        initialMessage: turnOf(requestId, plan.text),
      });

      return Message.PreparedScratchTurn({
        item: OutboxItem.Launch({ input }),
        threadId,
      });
    }).pipe(
      Effect.match({
        onSuccess: (prepared) => prepared,
        onFailure: (failure) =>
          Message.FailedPrepare({
            message: Predicate.isTagged(failure, "ResourceNotAvailable")
              ? "Cairn is reconnecting. Send again once it is back."
              : `The scratch thread did not start: ${failureMessageOrTag(failure)}`,
          }),
      })
    ),
});

/** Mints the clear of a scratch thread: its run and its subagents stop, and its folder goes. */
export const PrepareScratchClear = Command.define("PrepareScratchClear", {
  args: { threadId: ThreadId },
  messages: [Message.PreparedScratchClear],
  execute: ({ threadId }) =>
    Effect.map(mintCommandId, (commandId) =>
      Message.PreparedScratchClear({
        item: OutboxItem.Dispatch({
          command: ThreadClear.make({ commandId, threadId }),
        }),
      })
    ),
});

const ScratchJson = Schema.fromJsonString(Schema.NullOr(ThreadId));

const decodeScratch = Schema.decodeUnknownOption(ScratchJson);

const encodeScratch = Schema.encodeSync(ScratchJson);

/** Reads the scratch thread this device held; nothing saved, or unreadable, is none. */
export const LoadScratch = Command.define("LoadScratch", {
  messages: [Message.LoadedScratch],
  execute: Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const saved = yield* store.get(SCRATCH_STORAGE_KEY);

    return Message.LoadedScratch({
      threadId: Option.flatMap(
        Option.flatMap(Option.fromUndefinedOr(saved), decodeScratch),
        Option.fromNullOr
      ),
    });
  }).pipe(
    Effect.orElseSucceed(() =>
      Message.LoadedScratch({ threadId: Option.none() })
    )
  ),
});

/** Saves the scratch thread this device holds, or that it holds none. */
export const SaveScratch = Command.define("SaveScratch", {
  args: { threadId: Schema.Option(ThreadId) },
  messages: [Message.CompletedSaveScratch],
  execute: ({ threadId }) =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;

      yield* store.set(
        SCRATCH_STORAGE_KEY,
        encodeScratch(Option.getOrNull(threadId))
      );

      return Message.CompletedSaveScratch();
    }).pipe(Effect.orElseSucceed(() => Message.CompletedSaveScratch())),
});

/**
 * Stops one child's run from the work panel (`thread.stop` on the child): its queued inputs stay,
 * and so do its own children. A call cut off by a dropped connection answers as a failure rather
 * than ending the page (`withBoundary`).
 */
export const StopChild = Command.define("StopChild", {
  args: { threadId: ThreadId },
  messages: [Message.StoppedChild, Message.FailedStopChild],
  execute: ({ threadId }) =>
    withBoundary(
      Effect.flatMap(CairnConnection.get, (client) =>
        client["thread.stop"]({
          threadId,
          clearQueue: false,
          subagents: Option.none(),
        })
      )
    ).pipe(
      Effect.match({
        onSuccess: () => Message.StoppedChild({ threadId }),
        onFailure: (failure) =>
          Message.FailedStopChild({
            threadId,
            message: callFailureText(failure, {
              reconnecting:
                "Cairn is reconnecting. Stop again once it is back.",
              cutOff:
                "The connection dropped before Cairn answered. Stop again once it is back.",
              fallback: "The stop did not reach Cairn.",
            }),
          }),
      })
    ),
});

/**
 * The work panel's Stop on a workflow (6F; ADR 0012 as amended): `workflow.stop` for the whole of
 * it, `workflow.stopNode` for one node, which the script then reads as `null`. Either answers once
 * the stop is marked; settled results stay. A call cut off by a dropped connection answers as a
 * failure rather than ending the page (`withBoundary`).
 */
export const StopWorkflow = Command.define("StopWorkflow", {
  args: {
    key: Schema.String,
    threadId: ThreadId,
    workflowId: Schema.String,
    nodeId: Schema.Option(Schema.String),
  },
  messages: [Message.StoppedWorkflow, Message.FailedStopWorkflow],
  execute: ({ key, threadId, workflowId, nodeId }) =>
    withBoundary(
      Effect.flatMap(CairnConnection.get, (client) =>
        Option.match(nodeId, {
          onNone: () => client["workflow.stop"]({ threadId, workflowId }),
          onSome: (node) =>
            client["workflow.stopNode"]({ threadId, workflowId, nodeId: node }),
        })
      )
    ).pipe(
      Effect.match({
        onSuccess: () => Message.StoppedWorkflow({ key }),
        onFailure: (failure) =>
          Message.FailedStopWorkflow({
            key,
            message: callFailureText(failure, {
              reconnecting:
                "Cairn is reconnecting. Stop again once it is back.",
              cutOff:
                "The connection dropped before Cairn answered. Stop again once it is back.",
              fallback: "The stop did not reach Cairn.",
            }),
          }),
      })
    ),
});

/**
 * The user's own verdict on one criterion a user judge decides (`goal.mark`, plan 6H): the verdict
 * writer records it, and the goal document the thread stream carries says where the criterion
 * stands. A call cut off by a dropped connection answers as a failure, as `StopChild`'s does.
 */
export const MarkCriterion = Command.define("MarkCriterion", {
  args: { threadId: ThreadId, criterionId: Schema.String, ok: Schema.Boolean },
  messages: [Message.MarkedCriterion, Message.FailedMarkCriterion],
  execute: ({ threadId, criterionId, ok }) =>
    withBoundary(
      Effect.flatMap(CairnConnection.get, (client) =>
        client["goal.mark"]({
          threadId,
          criterionId,
          ok,
          note: Option.none(),
        })
      )
    ).pipe(
      Effect.match({
        onSuccess: () => Message.MarkedCriterion({ criterionId }),
        onFailure: (failure) =>
          Message.FailedMarkCriterion({
            criterionId,
            message: callFailureText(failure, {
              reconnecting:
                "Cairn is reconnecting. Mark it again once it is back.",
              cutOff:
                "The connection dropped before Cairn answered. Mark it again once it is back.",
              fallback: "The mark did not reach Cairn.",
            }),
          }),
      })
    ),
});
