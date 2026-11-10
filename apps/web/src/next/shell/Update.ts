// The `next` shell's update. The rail picks a project and opens its project thread, or a new draft
// in that project when it has none; a row opens its thread; the foot opens the usage and settings pages; the phone's sheet closes on any navigation.
// A refresh asks first, then launches the new project thread with `replaces` and opens it. The
// scratch overlay shows and hides on Cmd+J or Ctrl+J without losing its thread; its first message
// launches the scratch thread, later ones are sends, and Clear deletes it. The work panel shows and
// hides from the header, keeps its state across threads but starts each thread's child groups at
// their first page, and stops one child at a time; a child shows Stopping until its row is at rest.
// The goal panel shows and hides from the header's goal chip (one side panel at a time: opening it
// closes the work panel, and the other way round), and sends one mark per criterion at a time.
// The rail's + bubble opens the add-project picker: a folder already a project selects it, any
// other is made a project and selected once the shell shows it. A project the draft hero's picker
// chooses is selected on the rail, and a thread a draft launched is followed once its row arrives.
// The "Previous" fold reads the selected project's earlier project threads whenever the project
// or its project thread changes, and opens one read only (ADR 0048). The project and thread menus
// open rename and remove dialogs whose commands go straight to the brain; removing the project
// the open thread is in goes back to the hero.

import { LINEAGE_PAGE } from "@cairn/client-logic/ThreadLineage";
import { threadStatus } from "@cairn/client-logic/ThreadState";
import { ThreadId } from "@cairn/protocol/Ids";
import type { ProjectId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Array, Equal, Option, Predicate, Record, Schema } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { heroRouter, settingsRouter, threadRouter } from "../../Route.ts";
import { ADD_PROJECT_ID } from "./AddProject.ts";
import {
  BrowseFolders,
  CreateProject,
  DispatchManage,
  FetchPreviousThreads,
  FocusField,
  LoadScratch,
  LookUpEarlierThread,
  PrepareProjectDraft,
  PrepareRefresh,
  PrepareScratchClear,
  PrepareScratchTurn,
  MarkCriterion,
  SaveScratch,
  SelectAddedProject,
  StopChild,
  StopWorkflow,
} from "./Command.ts";
import type { Services } from "./Command.ts";
import {
  folderOf,
  openEarlierThreadOf,
  openThreadOf,
  previousKeyOf,
  projectAtFolder,
  projectThreadFor,
  railProjectsOf,
  scratchRowOf,
  threadRoleOf,
  threadsOf,
} from "./Derived.ts";
import { MANAGE_TEXT_ID } from "./Manage.ts";
import { Message, OutMessage } from "./Message.ts";
import {
  FIRST_CHILD_ROWS,
  FolderListing,
  initialManagedList,
  initialPrevious,
  ManageAction,
  MenuTarget,
  stopKeyOf,
} from "./Model.ts";
import type {
  AddProjectState,
  GoalPanelState,
  ManagedListState,
  ManageState,
  Model,
  PreviousState,
  ShellContext,
  WorkState,
} from "./Model.ts";
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

const isThreadId = Schema.is(ThreadId);

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
    armedStop: (armed) => (moved ? Option.none() : armed),
  });
};

/** The rail's project of the open thread, when the shell holds the thread. */
const followedOf = (model: Model): Option.Option<ProjectId> =>
  Option.flatMap(openThreadOf(model), (thread) =>
    Option.map(
      Array.findFirst(
        railProjectsOf(model),
        (project) => project.id === thread.projectId
      ),
      (project) => project.id
    )
  );

/**
 * The context told, the rail following the route. A thread a draft just launched opens before the
 * shell holds it, so the rail follows it when its row arrives, not only when the route moves.
 */
const followRoute = (model: Model, context: ShellContext): Model => {
  const moved = !Equal.equals(
    routedThreadId(model.context),
    routedThreadId(context)
  );

  const work = informWork(model.work, context, moved);

  const next = modifyFields(model, {
    context: () => context,
    work: () => work,
  });

  const followed = followedOf(next);
  const arrived = Option.isNone(followedOf(model)) && Option.isSome(followed);
  const turned = moved || model.context.route._tag !== context.route._tag;

  if (!turned && !arrived) {
    return next;
  }

  return modifyFields(next, {
    isSheetOpen: (open) => (turned ? false : open),
    menu: (menu) => (turned ? Option.none() : menu),
    selectedProjectId: (selected) =>
      moved || arrived ? Option.orElse(followed, () => selected) : selected,
  });
};

/** The fold reading its first page again for `projectId` under `key`, keeping `isOpen`. */
const readPrevious = (
  model: Model,
  key: string,
  projectId: ProjectId,
  isOpen: boolean
): InformReturn => {
  const { previous } = model;
  const request = previous.request + 1;
  const sameProject = Option.contains(previous.projectId, projectId);

  return {
    model: modifyFields(model, {
      previous: () =>
        modifyFields(previous, {
          key: () => Option.some(key),
          projectId: () => Option.some(projectId),
          isOpen: () => sameProject && isOpen,
          rows: (rows) => (sameProject ? rows : Option.none()),
          isLoading: () => true,
          request: () => request,
          failure: () => Option.none(),
        }),
    }),
    commands: [
      FetchPreviousThreads({ request, projectId, after: Option.none() }),
    ],
  };
};

/**
 * Reads the selected project's earlier project threads when the project or its project thread
 * changed since the fold last read them (a refresh moves the mark), or when the connection came
 * back with nothing read yet or after a read that failed. Rows read for the same project stay
 * shown while the new page loads.
 */
const syncPrevious = (model: Model, before: ShellContext): InformReturn =>
  Option.match(previousKeyOf(model), {
    onNone: () => ({ model }),
    onSome: ({ key, projectId }) => {
      const { previous } = model;
      const changed = !Option.contains(previous.key, key);

      const reconnected =
        !before.hasClient &&
        (Option.isNone(previous.rows) || Option.isSome(previous.failure)) &&
        !previous.isLoading;

      if (!model.context.hasClient || (!changed && !reconnected)) {
        return { model };
      }

      return readPrevious(model, key, projectId, previous.isOpen);
    },
  });

/** Once the shell shows the folder just added, the rail selects its project as a click would. */
const findAwaitedProject = (model: Model): InformReturn =>
  Option.match(
    Option.flatMap(model.awaitedFolder, (folder) =>
      projectAtFolder(model, folder)
    ),
    {
      onNone: () => ({ model }),
      onSome: (project) => ({
        model: modifyFields(model, { awaitedFolder: () => Option.none() }),
        commands: [SelectAddedProject({ projectId: project.id })],
      }),
    }
  );

/** Whether the shell `context` holds `threadId`'s row. */
const holdsRow = (context: ShellContext, threadId: string): boolean =>
  Option.exists(context.shell, (shell) =>
    shell.threads.some((thread) => thread.id === threadId)
  );

/**
 * Forgets the scratch thread once its row leaves the shell (cleared from another tab or device), so
 * the next turn launches a new one rather than going to a deleted thread. A thread whose row has not
 * shown yet is kept: its launch may still be on its way.
 */
const forgetClearedScratch = (
  before: ShellContext,
  result: InformReturn
): InformReturn => {
  const { model } = result;

  return Option.match(
    Option.filter(
      model.scratch.threadId,
      (threadId) =>
        holdsRow(before, threadId) &&
        Option.isSome(model.context.shell) &&
        !holdsRow(model.context, threadId)
    ),
    {
      onNone: () => result,
      onSome: () => ({
        model: modifyFields(model, {
          scratch: (scratch) =>
            modifyFields(scratch, { threadId: () => Option.none() }),
        }),
        commands: Array.append(
          result.commands ?? [],
          SaveScratch({ threadId: Option.none() })
        ),
      }),
    }
  );
};

/**
 * Asks the brain about the routed thread when the live shell does not hold it and neither the fold
 * nor an earlier answer says it is an earlier project thread: a page reloaded or linked on one, from
 * any project. Asked once per thread, and again when the connection comes back. A launch the shell
 * has not shown yet is asked about too; the brain answers that it is not one.
 */
const syncEarlier = (model: Model, before: ShellContext): InformReturn => {
  const { context, previous } = model;

  const unknown = Option.filter(
    Option.filter(routedThreadId(context), isThreadId),
    (threadId) =>
      context.hasClient &&
      Option.isSome(context.shell) &&
      !holdsRow(context, threadId) &&
      Option.isNone(openEarlierThreadOf(model)) &&
      (!Option.contains(previous.askedAbout, threadId) || !before.hasClient)
  );

  return Option.match(unknown, {
    onNone: () => ({ model }),
    onSome: (threadId) => ({
      model: modifyFields(model, {
        previous: (fold) =>
          modifyFields(fold, { askedAbout: () => Option.some(threadId) }),
      }),
      commands: [LookUpEarlierThread({ threadId })],
    }),
  });
};

/**
 * The context told: the rail follows the route, finds a folder just added, lets go of a scratch
 * thread cleared elsewhere, reads the "Previous" fold and asks about a routed thread it cannot place.
 */
const informContext = (model: Model, context: ShellContext): InformReturn => {
  const told = forgetClearedScratch(
    model.context,
    findAwaitedProject(followRoute(model, context))
  );

  const read = syncPrevious(told.model, model.context);
  const asked = syncEarlier(read.model, model.context);

  return {
    model: asked.model,
    commands: Array.appendAll(
      Array.appendAll(told.commands ?? [], read.commands ?? []),
      asked.commands ?? []
    ),
  };
};

/**
 * Takes what the root knows. When the route opens another thread, the rail follows it to its
 * project, and the phone's sheet closes. The first time, it reads which scratch thread this device
 * held.
 */
export const inform = (model: Model, context: ShellContext): InformReturn => {
  const told = informContext(model, context);
  const found = told.commands ?? [];

  return model.started
    ? told
    : {
        model: modifyFields(told.model, { started: () => true }),
        commands: [LoadScratch(), ...found],
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
            // Said on the confirm, the surface that asked, which keeps the typed message.
            onNone: () => ({
              model: modifyFields(model, {
                refresh: () =>
                  Option.some({
                    ...confirm,
                    failure: Option.some(
                      "That project thread is gone; open the project again to refresh it."
                    ),
                  }),
              }),
            }),
            onSome: (replaced) => ({
              model: modifyFields(model, {
                refresh: () =>
                  Option.some({
                    ...confirm,
                    isSending: true,
                    failure: Option.none(),
                  }),
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
        scratch: (scratch) =>
          modifyFields(scratch, {
            isBusy: () => true,
            sentDraft: () => Option.some(scratch.draft),
          }),
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

/**
 * The scratch field once its turn is minted: the words sent leave it, and whatever was typed after
 * them stays. A draft rewritten meanwhile is kept whole.
 */
const draftAfterSend = (
  draft: string,
  sentDraft: Option.Option<string>
): string =>
  Option.match(
    Option.filter(sentDraft, (sent) => draft.startsWith(sent)),
    {
      onNone: () => draft,
      onSome: (sent) => draft.slice(sent.length).trimStart(),
    }
  );

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

/** A row's Stop pressed once: it asks "Stop?" now, and any other row's question lets go (U-3). */
const armStop = (model: Model, key: string): UpdateReturn =>
  setWork(model, (work) =>
    modifyFields(work, { armedStop: () => Option.some(key) })
  );

/** The sidebar's managed list with `change` applied. */
const setManagedList = (
  model: Model,
  change: (list: ManagedListState) => ManagedListState
): UpdateReturn => ({
  model: modifyFields(model, { managedList: change }),
});

/** The goal panel with `change` applied. */
const setGoal = (
  model: Model,
  change: (goal: GoalPanelState) => GoalPanelState
): UpdateReturn => ({
  model: modifyFields(model, { goal: change }),
});

/** Selects the project and opens its project thread, or a draft of its own when it has none. */
const openProject = (model: Model, projectId: ProjectId): UpdateReturn => {
  const picked = modifyFields(model, {
    selectedProjectId: () => Option.some(projectId),
    awaitedFolder: () => Option.none(),
    // Another project's list starts at its first page, its resting fold closed.
    managedList: (list) =>
      Option.contains(model.selectedProjectId, projectId)
        ? list
        : initialManagedList,
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
    onSome: (thread) => navigate(picked, threadRouter({ threadId: thread.id })),
  });
};

/** The add-project picker with `change` applied, while it is open. */
const setAddProject = (
  model: Model,
  change: (state: AddProjectState) => AddProjectState
): UpdateReturn => ({
  model: modifyFields(model, {
    addProject: (open) => Option.map(open, change),
  }),
});

/** The picker listing `path` (the home folder when none); a listing still out is dropped. */
const browseFolders = (
  model: Model,
  state: AddProjectState,
  path: Option.Option<string>
): UpdateReturn => {
  const request = model.folderRequests + 1;

  return {
    model: modifyFields(model, {
      folderRequests: () => request,
      addProject: () =>
        Option.some({
          ...state,
          listing: FolderListing.Loading({ path }),
          request,
        }),
    }),
    commands: [BrowseFolders({ request, path })],
  };
};

/** True when `request` is the listing the open picker waits for. */
const isAwaitedListing = (model: Model, request: number): boolean =>
  Option.exists(model.addProject, (state) => state.request === request);

/** True when the open picker's create on its way is `folder`'s. */
const isAddingFolder = (model: Model, folder: string): boolean =>
  Option.exists(model.addProject, (state) =>
    Option.contains(state.adding, folder)
  );

/**
 * Adds the picker's folder: a folder that is already a project selects that project instead, and
 * any other goes to the brain, which checks it and makes the project.
 */
const submitAddProject = (model: Model): UpdateReturn =>
  Option.match(
    Option.filter(model.addProject, (state) => Option.isNone(state.adding)),
    {
      onNone: () => ({ model }),
      onSome: (state) => {
        const folder = folderOf(state.folder, state.home);

        if (folder === "") {
          return { model };
        }

        return Option.match(projectAtFolder(model, folder), {
          onSome: (project) =>
            openProject(
              modifyFields(model, { addProject: () => Option.none() }),
              project.id
            ),
          onNone: () => ({
            model: modifyFields(model, {
              addProject: () =>
                Option.some({
                  ...state,
                  adding: Option.some(folder),
                  failure: Option.none(),
                }),
            }),
            commands: [CreateProject({ folder })],
          }),
        });
      },
    }
  );

/**
 * Opens the add-project picker at the home folder: the rail's + bubble, or the hero's Add project
 * through the root. The picker takes focus, not its field, so a phone's keyboard stays down while
 * the user browses.
 */
export const openAddProject = (model: Model): InformReturn => {
  const request = model.folderRequests + 1;

  return {
    model: modifyFields(model, {
      folderRequests: () => request,
      isSheetOpen: () => false,
      refresh: () => Option.none(),
      addProject: () =>
        Option.some({
          folder: "",
          listing: FolderListing.Loading({ path: Option.none() }),
          request,
          home: Option.flatMap(model.addProject, (state) => state.home),
          adding: Option.none(),
          failure: Option.none(),
        }),
    }),
    commands: [
      BrowseFolders({ request, path: Option.none() }),
      FocusField({ selector: `#${ADD_PROJECT_ID}` }),
    ],
  };
};

/** The draft hero's picker chose `projectId`: the rail and the list follow it, with no navigation. */
export const followDraftProject =
  (projectId: ProjectId) =>
  (model: Model): InformReturn => ({
    model: modifyFields(model, {
      selectedProjectId: () => Option.some(projectId),
    }),
  });

/**
 * A scratch turn the brain refused, or a scratch launch that failed, back in the scratch field
 * ahead of nothing or after what is typed there now. A launch that did not start leaves no thread,
 * so the next turn launches a new one.
 */
export const restoreScratchTurn =
  (text: string, launched: boolean) =>
  (model: Model): InformReturn => ({
    model: modifyFields(model, {
      scratch: (scratch) =>
        modifyFields(scratch, {
          draft: (draft) =>
            draft.trim() === "" ? text : `${draft}\n\n${text}`,
          threadId: (threadId) => (launched ? Option.none() : threadId),
        }),
    }),
    commands: launched ? [SaveScratch({ threadId: Option.none() })] : [],
  });

/** Which menu `target` is, so a second click on its button closes it. */
const menuKeyOf = (target: MenuTarget): string =>
  MenuTarget.match(target, {
    Project: ({ projectId }) => `project:${projectId}`,
    Thread: ({ threadId }) => `thread:${threadId}`,
  });

/** The "Previous" fold with `change` applied. */
const setPrevious = (
  model: Model,
  change: (previous: PreviousState) => PreviousState
): UpdateReturn => ({
  model: modifyFields(model, { previous: change }),
});

/**
 * The fold's header: shows or hides the rows. Opening a fold whose last read failed reads it
 * again, as its failure line says.
 */
const openPrevious = (model: Model): UpdateReturn => {
  const { previous } = model;

  const retry =
    !previous.isOpen &&
    Option.isSome(previous.failure) &&
    !previous.isLoading &&
    model.context.hasClient;

  return Option.match(
    Option.filter(
      Option.all({ key: previous.key, projectId: previous.projectId }),
      () => retry
    ),
    {
      onNone: () =>
        setPrevious(model, (current) =>
          modifyFields(current, { isOpen: (open) => !open })
        ),
      onSome: ({ key, projectId }) => readPrevious(model, key, projectId, true),
    }
  );
};

/** Reads the fold's next page, after the rows it shows. */
const morePrevious = (model: Model): UpdateReturn => {
  const { previous } = model;

  const after = Option.flatMap(previous.rows, (rows) => rows.next);

  if (previous.isLoading || Option.isNone(after)) {
    return { model };
  }

  return Option.match(previous.projectId, {
    onNone: () => ({ model }),
    onSome: (projectId) => {
      const request = previous.request + 1;

      return {
        model: modifyFields(model, {
          previous: (current) =>
            modifyFields(current, {
              isLoading: () => true,
              request: () => request,
              failure: () => Option.none(),
            }),
        }),
        commands: [FetchPreviousThreads({ request, projectId, after })],
      };
    },
  });
};

/** The name a rename starts from: the project's or the thread's as the shell holds it. */
const currentNameOf = (model: Model, action: ManageAction): string =>
  ManageAction.match(action, {
    RenameProject: ({ projectId }) =>
      Option.getOrElse(
        Option.map(
          Array.findFirst(
            railProjectsOf(model),
            (project) => project.id === projectId
          ),
          (project) => project.title
        ),
        () => ""
      ),
    RemoveProject: () => "",
    RenameThread: ({ threadId }) =>
      Option.getOrElse(
        Option.map(
          Array.findFirst(threadsOf(model), (thread) => thread.id === threadId),
          (thread) => thread.title
        ),
        () => ""
      ),
  });

/** The open dialog with `change` applied. */
const setManage = (
  model: Model,
  change: (manage: ManageState) => ManageState
): UpdateReturn => ({
  model: modifyFields(model, {
    manage: (open) => Option.map(open, change),
  }),
});

/** Sends the open dialog's rename or remove; an empty name is refused here. */
const confirmManage = (model: Model): UpdateReturn =>
  Option.match(
    Option.filter(model.manage, (manage) => !manage.isSending),
    {
      onNone: () => ({ model }),
      onSome: (manage) => {
        const text = manage.text.trim();
        const isRemove = Predicate.isTagged(manage.action, "RemoveProject");

        if (!isRemove && text === "") {
          return setManage(model, (current) => ({
            ...current,
            failure: Option.some("A name cannot be empty."),
          }));
        }

        return {
          model: modifyFields(model, {
            manage: () =>
              Option.some({
                ...manage,
                isSending: true,
                failure: Option.none(),
              }),
          }),
          commands: [DispatchManage({ action: manage.action, text })],
        };
      },
    }
  );

/** Whether the route shows a page of `projectId`: one of its threads, live or earlier. */
const showsProject = (model: Model, projectId: ProjectId): boolean =>
  Option.exists(
    Option.orElse(openThreadOf(model), () => openEarlierThreadOf(model)),
    (thread) => thread.projectId === projectId
  );

/** The brain took the change; a removed project's page goes back to the hero. */
const completeManage = (model: Model, action: ManageAction): UpdateReturn => {
  const closed = modifyFields(model, { manage: () => Option.none() });

  return ManageAction.match(action, {
    RenameProject: () => ({ model: closed }),
    RenameThread: () => ({ model: closed }),
    RemoveProject: ({ projectId }) => {
      const left = modifyFields(closed, {
        selectedProjectId: (selected) =>
          Option.filter(selected, (id) => id !== projectId),
        previous: (previous) =>
          Option.contains(previous.projectId, projectId)
            ? initialPrevious
            : previous,
      });

      return showsProject(model, projectId)
        ? navigate(left, heroRouter())
        : { model: left };
    },
  });
};

const closeAddProject = (model: Model): UpdateReturn => ({
  model: modifyFields(model, { addProject: () => Option.none() }),
});

/** The shell's update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedProject: ({ projectId }) => openProject(model, projectId),

    ClickedAddProject: () => openAddProject(model),
    ChangedAddProjectFolder: ({ value }) =>
      setAddProject(model, (state) => ({
        ...state,
        folder: value,
        failure: Option.none(),
      })),
    ClickedBrowseFolder: ({ path }) =>
      Option.match(model.addProject, {
        onNone: () => ({ model }),
        onSome: (state) =>
          browseFolders(
            model,
            { ...state, folder: path, failure: Option.none() },
            Option.some(path)
          ),
      }),
    ReceivedFolders: ({ request, result }) =>
      isAwaitedListing(model, request)
        ? setAddProject(model, (state) => ({
            ...state,
            listing: FolderListing.Loaded({ result }),
            // The first listing, asked with no folder, is the home folder's.
            home: Option.orElse(state.home, () =>
              FolderListing.match(state.listing, {
                Loading: ({ path }) =>
                  Option.isNone(path)
                    ? Option.some(result.path)
                    : Option.none(),
                Loaded: () => Option.none(),
                Failed: () => Option.none(),
              })
            ),
          }))
        : { model },
    FailedFolders: ({ request, message: reason }) =>
      isAwaitedListing(model, request)
        ? setAddProject(model, (state) => ({
            ...state,
            listing: FolderListing.Failed({ message: reason }),
          }))
        : { model },
    SubmittedAddProject: () => submitAddProject(model),
    ClickedCancelAddProject: () => closeAddProject(model),
    // An add's answer reaches only the picker adding that folder: one the user closed (and maybe
    // reopened since) lets it go, and nothing opens.
    AddedProject: ({ folder }) => ({
      model: isAddingFolder(model, folder)
        ? modifyFields(model, {
            addProject: () => Option.none(),
            awaitedFolder: () => Option.some(folder),
          })
        : model,
    }),
    FailedAddProject: ({ folder, message: reason }) =>
      isAddingFolder(model, folder)
        ? setAddProject(model, (state) => ({
            ...state,
            adding: Option.none(),
            failure: Option.some(reason),
          }))
        : { model },
    FoundAddedProject: ({ projectId }) => openProject(model, projectId),

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
                failure: Option.none(),
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
      if (Option.isSome(model.manage)) {
        return { model: modifyFields(model, { manage: () => Option.none() }) };
      }

      if (Option.isSome(model.menu)) {
        return { model: modifyFields(model, { menu: () => Option.none() }) };
      }

      if (Option.isSome(model.addProject)) {
        return closeAddProject(model);
      }

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
              draft: (draft) => draftAfterSend(draft, scratch.sentDraft),
              isBusy: () => false,
              sentDraft: () => Option.none(),
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
        scratch: (scratch) =>
          modifyFields(scratch, {
            isBusy: () => false,
            sentDraft: () => Option.none(),
          }),
      }),
    }),
    ClickedDismissFailure: () => ({
      model: modifyFields(model, { failure: () => Option.none() }),
    }),
    CompletedFocus: () => ({ model }),

    ClickedWork: () => ({
      model: modifyFields(model, {
        work: (work) =>
          modifyFields(work, {
            isOpen: (open) => !open,
            armedStop: () => Option.none(),
          }),
        goal: (goal) =>
          model.work.isOpen
            ? goal
            : modifyFields(goal, { isOpen: () => false }),
      }),
    }),
    ClickedCloseWork: () =>
      setWork(model, (work) =>
        modifyFields(work, {
          isOpen: () => false,
          armedStop: () => Option.none(),
        })
      ),
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
    ClickedStopChild: ({ threadId }) => {
      if (model.work.stopping.includes(threadId)) {
        return { model };
      }

      // Nothing undoes a stop: the first press asks "Stop?" in place, the second stops (U-3).
      if (!Option.contains(model.work.armedStop, threadId)) {
        return armStop(model, threadId);
      }

      return {
        model: modifyFields(model, {
          work: (work) =>
            modifyFields(work, {
              armedStop: () => Option.none(),
              stopping: (stopping) => [...stopping, threadId],
              failure: () => Option.none(),
            }),
        }),
        commands: [StopChild({ threadId })],
      };
    },
    BlurredStop: () =>
      Option.isNone(model.work.armedStop)
        ? { model }
        : setWork(model, (work) =>
            modifyFields(work, { armedStop: () => Option.none() })
          ),
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

      if (model.work.stoppingWork.includes(key)) {
        return { model };
      }

      // A node's row Stop asks "Stop?" first, as a child's does; the worded "Stop workflow" does not.
      if (
        Option.isSome(nodeId) &&
        !Option.contains(model.work.armedStop, key)
      ) {
        return armStop(model, key);
      }

      return {
        model: modifyFields(model, {
          work: (work) =>
            modifyFields(work, {
              armedStop: () => Option.none(),
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

    ClickedRestingThreads: () =>
      setManagedList(model, (list) =>
        modifyFields(list, { isRestingOpen: (open) => !open })
      ),
    ClickedMoreManaged: ({ group }) =>
      setManagedList(model, (list) =>
        group === "live"
          ? modifyFields(list, { shownLive: (shown) => shown + LINEAGE_PAGE })
          : modifyFields(list, {
              shownResting: (shown) => shown + LINEAGE_PAGE,
            })
      ),

    ClickedPreviousThreads: () => openPrevious(model),
    ClickedMorePreviousThreads: () => morePrevious(model),
    ReceivedPreviousThreads: ({ more, page, request }) =>
      request === model.previous.request
        ? setPrevious(model, (previous) =>
            modifyFields(previous, {
              isLoading: () => false,
              failure: () => Option.none(),
              rows: (rows) =>
                Option.some({
                  threads: more
                    ? [
                        ...Option.match(rows, {
                          onNone: () => [],
                          onSome: (shown) => shown.threads,
                        }),
                        ...page.threads,
                      ]
                    : page.threads,
                  next: page.next,
                }),
            })
          )
        : { model },
    FailedPreviousThreads: ({ message: text, request }) =>
      request === model.previous.request
        ? setPrevious(model, (previous) =>
            modifyFields(previous, {
              isLoading: () => false,
              failure: () => Option.some(text),
            })
          )
        : { model },
    ClickedPreviousThread: ({ thread }) =>
      navigate(
        modifyFields(model, {
          previous: (previous) =>
            modifyFields(previous, { opened: () => Option.some(thread) }),
        }),
        threadRouter({ threadId: thread.id })
      ),
    // Its project becomes the selected one, so the fold reads that project's rows.
    LookedUpEarlierThread: ({ thread, threadId }) =>
      Option.isSome(thread) && thread.value.id === threadId
        ? syncPrevious(
            modifyFields(model, {
              previous: (previous) =>
                modifyFields(previous, { opened: () => thread }),
            }),
            model.context
          )
        : { model },
    ClickedOpenProjectThread: ({ projectId }) => openProject(model, projectId),

    ClickedMenu: ({ target }) => ({
      model: modifyFields(model, {
        menu: (open) =>
          Option.exists(
            open,
            (current) => menuKeyOf(current) === menuKeyOf(target)
          )
            ? Option.none()
            : Option.some(target),
      }),
    }),
    ClickedCloseMenu: () => ({
      model: modifyFields(model, { menu: () => Option.none() }),
    }),
    ClickedManage: ({ action }) => ({
      model: modifyFields(model, {
        menu: () => Option.none(),
        isSheetOpen: () => false,
        manage: () =>
          Option.some({
            action,
            text: currentNameOf(model, action),
            isSending: false,
            failure: Option.none(),
          }),
      }),
      commands: [
        FocusField({
          selector: Predicate.isTagged(action, "RemoveProject")
            ? `#${MANAGE_TEXT_ID}-cancel`
            : `#${MANAGE_TEXT_ID}`,
        }),
      ],
    }),
    ChangedManageText: ({ value }) =>
      setManage(model, (manage) => ({
        ...manage,
        text: value,
        failure: Option.none(),
      })),
    ClickedConfirmManage: () => confirmManage(model),
    ClickedCancelManage: () => ({
      model: modifyFields(model, { manage: () => Option.none() }),
    }),
    CompletedManage: ({ action }) => completeManage(model, action),
    FailedManage: ({ message: text }) =>
      setManage(model, (manage) => ({
        ...manage,
        isSending: false,
        failure: Option.some(text),
      })),

    ClickedGoal: () => ({
      model: modifyFields(model, {
        goal: (goal) => modifyFields(goal, { isOpen: (open) => !open }),
        work: (work) =>
          model.goal.isOpen
            ? work
            : modifyFields(work, { isOpen: () => false }),
      }),
    }),
    ClickedCloseGoal: () =>
      setGoal(model, (goal) => modifyFields(goal, { isOpen: () => false })),
    // One mark per criterion at a time; the goal document, not the answer, says where it stands.
    ClickedMarkCriterion: ({ threadId, criterionId, ok }) =>
      model.goal.marking.includes(criterionId)
        ? { model }
        : {
            model: modifyFields(model, {
              goal: (goal) =>
                modifyFields(goal, {
                  marking: (marking) => [...marking, criterionId],
                  failure: () => Option.none(),
                }),
            }),
            commands: [MarkCriterion({ threadId, criterionId, ok })],
          },
    MarkedCriterion: ({ criterionId }) =>
      setGoal(model, (goal) =>
        modifyFields(goal, {
          marking: (marking) => marking.filter((id) => id !== criterionId),
        })
      ),
    FailedMarkCriterion: ({ criterionId, message: text }) =>
      setGoal(model, (goal) =>
        modifyFields(goal, {
          marking: (marking) => marking.filter((id) => id !== criterionId),
          failure: () => Option.some(text),
        })
      ),
    ClickedDismissGoalFailure: () =>
      setGoal(model, (goal) =>
        modifyFields(goal, { failure: () => Option.none() })
      ),
  });
