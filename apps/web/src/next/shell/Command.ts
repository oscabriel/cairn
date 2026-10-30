// The `next` shell's Commands: minting a project's first draft, a refresh's launch, a scratch
// thread's turns and its clear, focusing the field an overlay opens with, and saving which scratch
// thread this device holds. Each answers with one Message. A refresh is
// `thread.launch` with `replaces` (5H): the new project thread, the old one's archive and the moved
// mark land in one shell commit. The scratch thread's first message launches it in the scratch
// project (made here first, as the composer's projectless launch does); later ones are sends.

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { RootWorkspace, ThreadLaunchInput } from "@cairn/protocol/Launch";
import { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import { RuntimeMode } from "@cairn/protocol/Policy";
import { ThreadClear } from "@cairn/protocol/ShellCommands";
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
import { failureMessageOrTag } from "../../connection/Failure.ts";
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
