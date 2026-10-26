// The composer's Commands: device storage (drafts, settings), the brain's queries (models, skills,
// file search, branches, the scratch project), the thread controls that are not turn input (stop,
// withdraw, configure), and the two that turn a draft into a turn: each mints the ids the brain
// dedupes on, so a resend after a reconnect lands once. Turn input itself goes through the root's
// outbox, never straight to the socket.
import { AttachmentRef } from "@cairn/protocol/Attachments";
import { ProjectId, SubmissionId, ThreadId } from "@cairn/protocol/Ids";
import type { ThreadLaunchInput } from "@cairn/protocol/Launch";
import { ThreadLaunchInput as ThreadLaunchInputSchema } from "@cairn/protocol/Launch";
import { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import { RuntimeMode } from "@cairn/protocol/Policy";
import { SendInput, TurnInput, WhenBusy } from "@cairn/protocol/Thread";
import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import { focus } from "foldkit/dom";
import { replaceUrl } from "foldkit/navigation";

import { CairnConnection, withBoundary } from "../connection/Connection.ts";
import { failureMessageOrTag } from "../connection/Failure.ts";
import { OutboxItem } from "../connection/Outbox.ts";
import { workspaceStrategy, EnvMode } from "../hero/ContextStrip.ts";
import { draftRouter, threadRouter } from "../Route.ts";
import {
  loadDrafts,
  loadSettings,
  saveDrafts,
  saveSettings,
} from "./Drafts.ts";
import {
  draftIdAsThreadId,
  mintCommandId,
  mintRequestId,
  mintThreadId,
} from "./Ids.ts";
import { Message } from "./Message.ts";
import { ComposerSettings, defaultSettings, Draft } from "./Model.ts";

const failed = (failure: { readonly _tag: string }) =>
  Message.FailedRequest({ message: failureMessageOrTag(failure) });

/**
 * Puts the keyboard in an opened picker's search field (T30), so typing filters, Enter picks and
 * Escape closes. On iOS a focus outside the tap does not raise the keyboard; the field still takes
 * a hardware keyboard's keys.
 */
export const FocusPopoverSearch = Command.define("FocusPopoverSearch", {
  messages: [Message.CompletedEditorCommand],
  execute: focus('[data-testid="composer-popover-search"]').pipe(
    Effect.ignore,
    Effect.as(Message.CompletedEditorCommand())
  ),
});

/** Reads whether this device is a Mac, for the platform's modifier key. */
export const DetectPlatform = Command.define("DetectPlatform", {
  messages: [Message.DetectedPlatform],
  execute: Effect.sync(() =>
    Message.DetectedPlatform({
      isMac: /mac|iphone|ipad/iu.test(
        navigator.platform || navigator.userAgent
      ),
    })
  ),
});

/** Reads the drafts saved on this device. */
export const LoadDrafts = Command.define("LoadDrafts", {
  messages: [Message.LoadedDrafts],
  execute: Effect.map(loadDrafts, (drafts) => Message.LoadedDrafts({ drafts })),
});

/** Writes every draft. */
export const SaveDrafts = Command.define("SaveDrafts", {
  args: { version: Schema.Int, drafts: Schema.Record(Schema.String, Draft) },
  messages: [Message.CompletedSaveDrafts],
  execute: ({ drafts, version }) =>
    Effect.map(saveDrafts(drafts), (saved) =>
      Message.CompletedSaveDrafts({ version, saved })
    ),
});

/** Reads the composer's settings on this device. */
export const LoadSettings = Command.define("LoadSettings", {
  messages: [Message.LoadedSettings],
  execute: Effect.map(loadSettings(defaultSettings), (settings) =>
    Message.LoadedSettings({ settings })
  ),
});

/** Writes the composer's settings. */
export const SaveSettings = Command.define("SaveSettings", {
  args: { settings: ComposerSettings },
  messages: [Message.CompletedSaveSettings],
  execute: ({ settings }) =>
    Effect.map(saveSettings(settings), (saved) =>
      Message.CompletedSaveSettings({ saved })
    ),
});

/** Mints the id of the home hero's draft, which becomes its thread's id (run by a Subscription). */
export const mintHomeDraft = Effect.map(mintThreadId, (draftId) =>
  Message.MintedHomeDraft({ draftId })
);

/**
 * Replaces `/` with the hero draft's own URL, `/new/<draftId>`, as t3code's index route does, so
 * a reload of the page restores the draft instead of minting a fresh one. The query and hash carry
 * over, so a switch such as `?busy=` outlives the move.
 */
export const MoveHeroToDraftUrl = Command.define("MoveHeroToDraftUrl", {
  args: { draftId: Schema.String },
  messages: [Message.MovedHeroToDraftUrl],
  execute: ({ draftId }) =>
    Effect.sync(
      () => `${globalThis.location.search}${globalThis.location.hash}`
    ).pipe(
      Effect.flatMap((suffix) =>
        replaceUrl(`${draftRouter({ draftId })}${suffix}`)
      ),
      Effect.as(Message.MovedHeroToDraftUrl())
    ),
});

const onClient = <A, E>(
  use: (
    client: Effect.Success<typeof CairnConnection.get>
  ) => Effect.Effect<A, E>
) => withBoundary(Effect.flatMap(CairnConnection.get, use));

/** Loads the models the picker offers and the server's defaults (run by a Subscription). */
export const fetchModels = (epoch: number) =>
  onClient((client) => client["models.list"]()).pipe(
    Effect.match({
      onSuccess: (catalog) => Message.SucceededModels({ epoch, catalog }),
      onFailure: (failure) =>
        Message.FailedLoad({
          what: "models",
          projectId: Option.none(),
          message: failureMessageOrTag(failure),
        }),
    })
  );

/** Loads the skills `$` and `/` complete for a project (run by a Subscription). */
export const fetchSkills = (projectId: ProjectId) =>
  onClient((client) => client["skills.list"]({ projectId })).pipe(
    Effect.match({
      onSuccess: (list) => Message.SucceededSkills({ projectId, list }),
      onFailure: (failure) =>
        Message.FailedLoad({
          what: "skills",
          projectId: Option.some(projectId),
          message: failureMessageOrTag(failure),
        }),
    })
  );

/** How many matches the `@` menu asks for. */
export const PATH_SEARCH_LIMIT = 80;

/** Searches a project's files and folders for the `@` menu. */
export const SearchEntries = Command.define("SearchEntries", {
  args: { projectId: ProjectId, query: Schema.String },
  messages: [Message.SucceededPathSearch, Message.FailedPathSearch],
  execute: ({ projectId, query }) =>
    onClient((client) =>
      client["projects.searchEntries"]({
        projectId,
        query,
        limit: PATH_SEARCH_LIMIT,
      })
    ).pipe(
      Effect.match({
        onSuccess: (result) =>
          Message.SucceededPathSearch({ projectId, query, result }),
        onFailure: (failure) =>
          Message.FailedPathSearch({
            projectId,
            query,
            message: failureMessageOrTag(failure),
          }),
      })
    ),
});

/** Loads the branches a new worktree can start from (run by a Subscription). */
export const fetchBranches = (projectId: ProjectId) =>
  onClient((client) => client["git.branches"]({ projectId })).pipe(
    Effect.match({
      onSuccess: (result) => Message.SucceededBranches({ projectId, result }),
      onFailure: (failure) =>
        Message.FailedLoad({
          what: "branches",
          projectId: Option.some(projectId),
          message: failureMessageOrTag(failure),
        }),
    })
  );

/** Makes (or finds) the scratch project behind "start without a project". */
export const EnsureScratch = Command.define("EnsureScratch", {
  messages: [Message.SucceededScratch, Message.FailedRequest],
  execute: onClient((client) => client["projects.ensureScratch"]()).pipe(
    Effect.match({
      onSuccess: (project) => Message.SucceededScratch({ project }),
      onFailure: failed,
    })
  ),
});

/** Stops the thread's run; with `clearQueue`, its queued inputs go too. */
export const StopThread = Command.define("StopThread", {
  args: { threadId: ThreadId, clearQueue: Schema.Boolean },
  messages: [Message.CompletedRequest, Message.FailedRequest],
  execute: (input) =>
    onClient((client) => client["thread.stop"](input)).pipe(
      Effect.match({
        onSuccess: () => Message.CompletedRequest(),
        onFailure: failed,
      })
    ),
});

/** Takes back one queued input. */
export const WithdrawQueued = Command.define("WithdrawQueued", {
  args: { threadId: ThreadId, submissionId: SubmissionId },
  messages: [Message.CompletedRequest, Message.FailedRequest],
  execute: (input) =>
    onClient((client) => client["thread.withdraw"](input)).pipe(
      Effect.match({
        onSuccess: () => Message.CompletedRequest(),
        onFailure: failed,
      })
    ),
});

/** Changes an open thread's model or thinking level. */
export const ConfigureThread = Command.define("ConfigureThread", {
  args: {
    threadId: ThreadId,
    model: Schema.Option(ModelRef),
    thinkingLevel: Schema.Option(ThinkingLevel),
  },
  messages: [Message.CompletedRequest, Message.FailedRequest],
  execute: (input) =>
    onClient((client) => client["thread.configure"](input)).pipe(
      Effect.match({
        onSuccess: () => Message.CompletedRequest(),
        onFailure: failed,
      })
    ),
});

const TurnContent = Schema.Struct({
  text: Schema.String,
  attachments: TurnInput.fields.attachments,
  skillRefs: TurnInput.fields.skillRefs,
});

/** Mints a request id and hands back the `thread.send` for the outbox. */
export const PrepareSend = Command.define("PrepareSend", {
  args: {
    threadId: ThreadId,
    whenBusy: WhenBusy,
    content: TurnContent,
    attachments: Schema.Array(AttachmentRef),
  },
  messages: [Message.PreparedTurn],
  execute: ({ attachments, content, threadId, whenBusy }) =>
    Effect.map(mintRequestId, (requestId) =>
      Message.PreparedTurn({
        item: OutboxItem.Send({
          input: SendInput.make({
            threadId,
            input: { requestId, ...content },
            whenBusy,
          }),
        }),
        navigateTo: Option.none(),
        attachments,
      })
    ),
});

/**
 * Mints the launch's ids and hands back the `thread.launch` for the outbox. A draft without a
 * project launches in the scratch project, made here first. A draft id that is a UUIDv7 becomes the
 * thread's id, so the draft's URL turns into the thread's.
 */
export const PrepareLaunch = Command.define("PrepareLaunch", {
  args: {
    draftId: Schema.Option(Schema.String),
    projectId: Schema.Option(ProjectId),
    model: ModelRef,
    thinkingLevel: ThinkingLevel,
    runtimeMode: RuntimeMode,
    envMode: EnvMode,
    baseBranch: Schema.Option(Schema.String),
    currentBranch: Schema.Option(Schema.String),
    content: TurnContent,
    stay: Schema.Boolean,
    /** The draft as it was sent and its attachments, handed back when the launch cannot start. */
    draftKey: Schema.String,
    draft: Draft,
    attachments: Schema.Array(AttachmentRef),
  },
  messages: [Message.PreparedTurn, Message.FailedPrepareTurn],
  execute: (plan) =>
    Effect.gen(function* () {
      const projectId = yield* Option.match(plan.projectId, {
        onNone: () =>
          onClient((client) => client["projects.ensureScratch"]()).pipe(
            Effect.map((project) => project.id)
          ),
        onSome: Effect.succeed,
      });

      const threadId = yield* Option.match(
        Option.flatMap(plan.draftId, draftIdAsThreadId),
        {
          onNone: () => mintThreadId,
          onSome: Effect.succeed,
        }
      );

      const commandId = yield* mintCommandId;
      const requestId = yield* mintRequestId;

      const input: ThreadLaunchInput = ThreadLaunchInputSchema.make({
        commandId,
        threadId,
        projectId,
        title: Option.none(),
        model: plan.model,
        thinkingLevel: plan.thinkingLevel,
        runtimeMode: plan.runtimeMode,
        workspace: workspaceStrategy(
          plan.envMode,
          plan.baseBranch,
          plan.currentBranch
        ),
        initialMessage: { requestId, ...plan.content },
      });

      return Message.PreparedTurn({
        item: OutboxItem.Launch({ input }),
        navigateTo: plan.stay
          ? Option.none()
          : Option.some(threadRouter({ threadId })),
        attachments: plan.attachments,
      });
    }).pipe(
      Effect.match({
        onSuccess: (prepared) => prepared,
        onFailure: (failure) =>
          Message.FailedPrepareTurn({
            draftKey: plan.draftKey,
            draft: plan.draft,
            attachments: plan.attachments,
            message: `The thread did not start: ${failureMessageOrTag(failure)} Your message is back in the composer.`,
          }),
      })
    ),
});
