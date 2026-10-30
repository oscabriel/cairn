// The `next` shell's update. The rail picks a project and opens its project thread, or a new draft
// in that project when it has none; a row opens its thread; the foot opens the usage and settings pages; the phone's sheet closes on any navigation.
// A refresh asks first, then launches the new project thread with `replaces` and opens it. The
// scratch overlay shows and hides on Cmd+J or Ctrl+J without losing its thread; its first message
// launches the scratch thread, later ones are sends, and Clear deletes it. The work panel shows and
// hides from the header, keeps its state across threads but starts each thread's child groups at
// their first page, and stops one child at a time; a child shows Stopping until its row is at rest.

import { LINEAGE_PAGE } from "@cairn/client-logic/ThreadLineage";
import { threadStatus } from "@cairn/client-logic/ThreadState";
import type { ProjectId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Array, Equal, Option, Predicate, Record } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { settingsRouter, threadRouter } from "../../Route.ts";
import {
  FocusField,
  LoadScratch,
  PrepareProjectDraft,
  PrepareRefresh,
  PrepareScratchClear,
  PrepareScratchTurn,
  SaveScratch,
  StopChild,
  StopWorkflow,
} from "./Command.ts";
import type { Services } from "./Command.ts";
import {
  openThreadOf,
  projectThreadFor,
  railProjectsOf,
  scratchRowOf,
  threadRoleOf,
  threadsOf,
} from "./Derived.ts";
import { Message, OutMessage } from "./Message.ts";
import { FIRST_CHILD_ROWS, stopKeyOf } from "./Model.ts";
import type { Model, ShellContext, WorkState } from "./Model.ts";
import { REFRESH_TEXT_ID } from "./Refresh.ts";
import { SCRATCH_EDITOR_ID } from "./Scratch.ts";

/** The usage page's path. */
export const USAGE_PATH = "/usage";

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  Services
>;

type InformReturn = Update.Return<Model, Message, Services>;

const routedThreadId = (context: ShellContext): Option.Option<string> =>
  Predicate.isTagged(context.route, "Thread")
    ? Option.some(context.route.threadId)
    : Option.none();

/** True while a child's row still has a run or a request: a Stop asked of it has not shown yet. */
const isStillLive = (context: ShellContext, threadId: string): boolean =>
  Option.exists(context.shell, (shell) =>
    shell.threads.some((thread) => {
      if (thread.id !== threadId) {
        return false;
      }

      const status = threadStatus(thread, Option.none());

      return status !== "ready" && status !== "failed";
    })
  );

/** The work panel after the context changed: Stopping clears once its child rests. */
const informWork = (
  work: WorkState,
  context: ShellContext,
  moved: boolean
): WorkState => {
  const stopping = work.stopping.filter((threadId) =>
    isStillLive(context, threadId)
  );

  if (!moved && stopping.length === work.stopping.length) {
    return work;
  }

  return modifyFields(work, {
    stopping: () => stopping,
    shownActive: (shown) => (moved ? FIRST_CHILD_ROWS : shown),
    shownPrevious: (shown) => (moved ? FIRST_CHILD_ROWS : shown),
    isPreviousOpen: (open) => (moved ? false : open),
  });
};

/** The context told, the rail following the route; it asks for no Command. */
const informContext = (model: Model, context: ShellContext): InformReturn => {
  const moved = !Equal.equals(
    routedThreadId(model.context),
    routedThreadId(context)
  );

  const work = informWork(model.work, context, moved);

  const next = modifyFields(model, {
    context: () => context,
    work: () => work,
  });

  if (!moved && model.context.route._tag === context.route._tag) {
    return { model: next };
  }

  const followed = Option.flatMap(openThreadOf(next), (thread) =>
    Array.findFirst(
      railProjectsOf(next),
      (project) => project.id === thread.projectId
    )
  );

  return {
    model: modifyFields(next, {
      isSheetOpen: () => false,
      selectedProjectId: (selected) =>
        moved
          ? Option.orElse(
              Option.map(followed, (project) => project.id),
              () => selected
            )
          : selected,
    }),
  };
};

/**
 * Takes what the root knows. When the route opens another thread, the rail follows it to its
 * project, and the phone's sheet closes. The first time, it reads which scratch thread this device
 * held.
 */
export const inform = (model: Model, context: ShellContext): InformReturn => {
  const told = informContext(model, context);

  return model.started
    ? told
    : {
        model: modifyFields(told.model, { started: () => true }),
        commands: [LoadScratch()],
      };
};

const navigate = (model: Model, url: string): UpdateReturn => ({
  model: modifyFields(model, { isSheetOpen: () => false }),
  outMessage: OutMessage.RequestedNavigate({ url }),
});

/** The open thread, when it is its project's project thread: what a refresh replaces. */
const refreshableOf = (model: Model): Option.Option<ThreadShell> =>
  Option.filter(
    openThreadOf(model),
    (thread) => threadRoleOf(model, thread) === "project-thread"
  );

const confirmRefresh = (model: Model): UpdateReturn =>
  Option.match(
    Option.filter(
      model.refresh,
      (confirm) => !confirm.isSending && confirm.text.trim() !== ""
    ),
    {
      onNone: () => ({ model }),
      onSome: (confirm) =>
        Option.match(
          Array.findFirst(
            threadsOf(model),
            (thread) => thread.id === confirm.replaces
          ),
          {
            onNone: () => ({
              model: modifyFields(model, {
                refresh: () => Option.none(),
                failure: () =>
                  Option.some(
                    "That project thread is gone; open the project again to refresh it."
                  ),
              }),
            }),
            onSome: (replaced) => ({
              model: modifyFields(model, {
                refresh: () => Option.some({ ...confirm, isSending: true }),
              }),
              commands: [
                PrepareRefresh({
                  projectId: confirm.projectId,
                  replaces: confirm.replaces,
                  model: {
                    provider: replaced.provider,
                    modelId: replaced.modelId,
                  },
                  thinkingLevel: replaced.thinkingLevel,
                  runtimeMode: replaced.runtimeMode,
                  text: confirm.text.trim(),
                }),
              ],
            }),
          }
        ),
    }
  );

const sendScratch = (model: Model): UpdateReturn => {
  const text = model.scratch.draft.trim();

  if (text === "" || model.scratch.isBusy) {
    return { model };
  }

  // A later turn keeps the thread's own model; the first takes the server's defaults.
  const choice = Option.orElse(
    Option.map(scratchRowOf(model), (row) => ({
      model: { provider: row.provider, modelId: row.modelId },
      thinkingLevel: row.thinkingLevel,
    })),
    () => model.context.defaults
  );

  return Option.match(choice, {
    onNone: () => ({
      model: modifyFields(model, {
        failure: () =>
          Option.some("Cairn is still connecting. Send again in a moment."),
      }),
    }),
    onSome: (picked) => ({
      model: modifyFields(model, {
        scratch: (scratch) => modifyFields(scratch, { isBusy: () => true }),
        failure: () => Option.none(),
      }),
      commands: [
        PrepareScratchTurn({
          threadId: model.scratch.threadId,
          model: picked.model,
          thinkingLevel: picked.thinkingLevel,
          text,
        }),
      ],
    }),
  });
};

/** Shows or hides the scratch overlay; shown, its field takes focus from whatever held it. */
const setScratchOpen = (model: Model, isOpen: boolean): UpdateReturn => ({
  model: modifyFields(model, {
    scratch: (scratch) => modifyFields(scratch, { isOpen: () => isOpen }),
    isSheetOpen: (open) => (isOpen ? false : open),
  }),
  commands: isOpen ? [FocusField({ selector: `#${SCRATCH_EDITOR_ID}` })] : [],
});

/** Opens the project's first draft: a new one is minted, then the root gives it the project. */
const startProjectThread = (
  model: Model,
  projectId: ProjectId
): UpdateReturn => ({
  model: modifyFields(model, {
    selectedProjectId: () => Option.some(projectId),
    isSheetOpen: () => false,
  }),
  commands: [PrepareProjectDraft({ projectId })],
});

/** The work panel with `change` applied. */
const setWork = (
  model: Model,
  change: (work: WorkState) => WorkState
): UpdateReturn => ({
  model: modifyFields(model, { work: change }),
});

/** The shell's update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedProject: ({ projectId }) => {
      const picked = modifyFields(model, {
        selectedProjectId: () => Option.some(projectId),
      });

      const target = Option.flatMap(
        Array.findFirst(
          railProjectsOf(model),
          (project) => project.id === projectId
        ),
        (project) => projectThreadFor(model, project)
      );

      // A project with no project thread opens a draft of its own, never the hero's fallback.
      return Option.match(target, {
        onNone: () => startProjectThread(picked, projectId),
        onSome: (thread) =>
          navigate(picked, threadRouter({ threadId: thread.id })),
      });
    },
    ClickedThread: ({ threadId }) =>
      navigate(model, threadRouter({ threadId })),
    ClickedStartProjectThread: ({ projectId }) =>
      startProjectThread(model, projectId),
    PreparedProjectDraft: ({ projectId, draftId }) => ({
      model,
      outMessage: OutMessage.RequestedProjectDraft({ projectId, draftId }),
    }),
    ClickedUsage: () => navigate(model, USAGE_PATH),
    ClickedSettings: () => navigate(model, settingsRouter()),
    ClickedOpenSheet: () => ({
      model: modifyFields(model, { isSheetOpen: () => true }),
    }),
    ClickedCloseSheet: () => ({
      model: modifyFields(model, { isSheetOpen: () => false }),
    }),

    LoadedFavicon: ({ projectId }) => ({
      model: modifyFields(model, {
        favicons: (favicons) => Record.set(favicons, projectId, "loaded"),
      }),
    }),
    FailedFavicon: ({ projectId }) => ({
      model: modifyFields(model, {
        favicons: (favicons) => Record.set(favicons, projectId, "missing"),
      }),
    }),

    ClickedRefresh: () =>
      Option.match(refreshableOf(model), {
        onNone: () => ({ model }),
        onSome: (thread) => ({
          model: modifyFields(model, {
            refresh: () =>
              Option.some({
                projectId: thread.projectId,
                replaces: thread.id,
                text: "",
                isSending: false,
              }),
            failure: () => Option.none(),
          }),
          commands: [FocusField({ selector: `#${REFRESH_TEXT_ID}` })],
        }),
      }),
    ChangedRefreshText: ({ value }) => ({
      model: modifyFields(model, {
        refresh: (refresh) =>
          Option.map(refresh, (confirm) => ({ ...confirm, text: value })),
      }),
    }),
    ClickedConfirmRefresh: () => confirmRefresh(model),
    ClickedCancelRefresh: () => ({
      model: modifyFields(model, { refresh: () => Option.none() }),
    }),
    PreparedRefresh: ({ item, threadId }) => ({
      model: modifyFields(model, {
        refresh: () => Option.none(),
      }),
      outMessage: OutMessage.RequestedOutbox({
        item,
        navigateTo: Option.some(threadRouter({ threadId })),
      }),
    }),

    PressedScratchShortcut: () => setScratchOpen(model, !model.scratch.isOpen),
    PressedEscape: () => {
      if (Option.isSome(model.refresh)) {
        return {
          model: modifyFields(model, { refresh: () => Option.none() }),
        };
      }

      return model.scratch.isOpen ? setScratchOpen(model, false) : { model };
    },
    ClickedScratchButton: () => setScratchOpen(model, true),
    ClickedCloseScratch: () => setScratchOpen(model, false),
    ChangedScratchDraft: ({ value }) => ({
      model: modifyFields(model, {
        scratch: (scratch) => modifyFields(scratch, { draft: () => value }),
      }),
    }),
    PressedScratchEnter: () => sendScratch(model),
    ClickedSendScratch: () => sendScratch(model),
    PreparedScratchTurn: ({ item, threadId }) => {
      const isNew = !Option.contains(model.scratch.threadId, threadId);

      return {
        model: modifyFields(model, {
          scratch: (scratch) =>
            modifyFields(scratch, {
              threadId: () => Option.some(threadId),
              draft: () => "",
              isBusy: () => false,
            }),
        }),
        commands: isNew
          ? [SaveScratch({ threadId: Option.some(threadId) })]
          : [],
        outMessage: OutMessage.RequestedOutbox({
          item,
          navigateTo: Option.none(),
        }),
      };
    },
    ClickedClearScratch: () =>
      Option.match(model.scratch.threadId, {
        onNone: () => ({
          model: modifyFields(model, {
            scratch: (scratch) => modifyFields(scratch, { draft: () => "" }),
          }),
        }),
        onSome: (threadId) =>
          model.scratch.isBusy
            ? { model }
            : {
                model: modifyFields(model, {
                  scratch: (scratch) =>
                    modifyFields(scratch, { isBusy: () => true }),
                }),
                commands: [PrepareScratchClear({ threadId })],
              },
      }),
    PreparedScratchClear: ({ item }) => ({
      model: modifyFields(model, {
        scratch: (scratch) =>
          modifyFields(scratch, {
            threadId: () => Option.none(),
            draft: () => "",
            isBusy: () => false,
          }),
      }),
      commands: [SaveScratch({ threadId: Option.none() })],
      outMessage: OutMessage.RequestedOutbox({
        item,
        navigateTo: Option.none(),
      }),
    }),
    LoadedScratch: ({ threadId }) => ({
      model: modifyFields(model, {
        scratch: (scratch) =>
          Option.isSome(scratch.threadId)
            ? scratch
            : modifyFields(scratch, { threadId: () => threadId }),
      }),
    }),
    CompletedSaveScratch: () => ({ model }),
    FailedPrepare: ({ message: text }) => ({
      model: modifyFields(model, {
        failure: () => Option.some(text),
        scratch: (scratch) => modifyFields(scratch, { isBusy: () => false }),
        refresh: (refresh) =>
          Option.map(refresh, (confirm) => ({ ...confirm, isSending: false })),
      }),
    }),
    ClickedDismissFailure: () => ({
      model: modifyFields(model, { failure: () => Option.none() }),
    }),
    CompletedFocus: () => ({ model }),

    ClickedWork: () =>
      setWork(model, (work) => modifyFields(work, { isOpen: (open) => !open })),
    ClickedCloseWork: () =>
      setWork(model, (work) => modifyFields(work, { isOpen: () => false })),
    ClickedPreviousChildren: () =>
      setWork(model, (work) =>
        modifyFields(work, { isPreviousOpen: (open) => !open })
      ),
    ClickedMoreChildren: ({ group }) =>
      group === "active"
        ? setWork(model, (work) =>
            modifyFields(work, { shownActive: (shown) => shown + LINEAGE_PAGE })
          )
        : setWork(model, (work) =>
            modifyFields(work, {
              shownPrevious: (shown) => shown + LINEAGE_PAGE,
            })
          ),
    ClickedStopChild: ({ threadId }) =>
      model.work.stopping.includes(threadId)
        ? { model }
        : {
            model: modifyFields(model, {
              work: (work) =>
                modifyFields(work, {
                  stopping: (stopping) => [...stopping, threadId],
                  failure: () => Option.none(),
                }),
            }),
            commands: [StopChild({ threadId })],
          },
    // The stop's answer comes after the run's abort joined, so the row now says what is true: a
    // child the stop could not bring to rest (held, or one whose queued input started a run) shows
    // its own state again rather than Stopping for ever.
    StoppedChild: ({ threadId }) =>
      setWork(model, (work) =>
        modifyFields(work, {
          stopping: (stopping) => stopping.filter((id) => id !== threadId),
        })
      ),
    FailedStopChild: ({ threadId, message: text }) =>
      setWork(model, (work) =>
        modifyFields(work, {
          stopping: (stopping) => stopping.filter((id) => id !== threadId),
          failure: () => Option.some(text),
        })
      ),
    ClickedStopWorkflow: ({ threadId, workflowId, nodeId }) => {
      const key = stopKeyOf(workflowId, nodeId);

      return model.work.stoppingWork.includes(key)
        ? { model }
        : {
            model: modifyFields(model, {
              work: (work) =>
                modifyFields(work, {
                  stoppingWork: (stopping) => [...stopping, key],
                  failure: () => Option.none(),
                }),
            }),
            commands: [StopWorkflow({ key, threadId, workflowId, nodeId })],
          };
    },
    // The stop answers once it is marked, so the ledger the panel reads already says how it ended.
    StoppedWorkflow: ({ key }) =>
      setWork(model, (work) =>
        modifyFields(work, {
          stoppingWork: (stopping) => stopping.filter((found) => found !== key),
        })
      ),
    FailedStopWorkflow: ({ key, message: text }) =>
      setWork(model, (work) =>
        modifyFields(work, {
          stoppingWork: (stopping) => stopping.filter((found) => found !== key),
          failure: () => Option.some(text),
        })
      ),
    ClickedDismissWorkFailure: () =>
      setWork(model, (work) =>
        modifyFields(work, { failure: () => Option.none() })
      ),
  });
