// The `next` shell's logic, over the shell fixture: the rail's projects and marks, the selected
// project and its project thread's running list with each row's status from the one thread-state
// function, the header's word for the open thread, and the update's navigation, refresh and scratch
// flows (what it asks the root for, and the turns and commands it mints). The rail follows the
// hero's project (U-21), the "Previous" fold reads and opens earlier project threads read only
// (ADR 0048), and the menus rename and remove (U-10).

import {
  asking,
  NOW,
  rowId,
  shellRow,
} from "@cairn/client-logic/ShellRowTestKit";
import { RequestId } from "@cairn/protocol/Ids";
import { SendInput } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Predicate } from "effect";

import { OutboxItem } from "../../connection/Outbox.ts";
import { AppRoute } from "../../Route.ts";
import {
  managedThreadsFor,
  projectLetterOf,
  projectMarkOf,
  railProjectsOf,
  requestsOf,
  rowStatusOf,
  selectedProjectOf,
  threadRoleOf,
} from "./Derived.ts";
import { Message, OutMessage } from "./Message.ts";
import { ManageAction, MenuTarget } from "./Model.ts";
import type { Model } from "./Model.ts";
import {
  CAIRN,
  DEV,
  MANAGED,
  MYR,
  onProjectThread,
  PROJECT_THREAD,
  SCRATCH_THREAD,
  SHELL,
  shellModelOn,
} from "./ShellFixtures.ts";
import { inform, update, USAGE_PATH } from "./Update.ts";
import {
  headerContentOf,
  isEarlierThreadOpen,
  railBubblesOf,
  sidebarContentOf,
} from "./View.ts";

const projectOf = (id: string) => {
  const found = SHELL.projects.find((project) => project.id === id);

  if (found === undefined) {
    throw new Error(`no fixture project ${id}`);
  }

  return found;
};

const threadOf = (id: string) => {
  const found = SHELL.threads.find((thread) => thread.id === id);

  if (found === undefined) {
    throw new Error(`no fixture thread ${id}`);
  }

  return found;
};

/** Each managed row's status word, the first part of its quiet line. */
const words = (rows: ReadonlyArray<{ readonly meta: string }>) =>
  rows.map(({ meta }) => meta.split(" · ")[0]);

/** Runs the Command a step asked for, which needs no service, to its Message. */
const runOnly = (
  commands: ReadonlyArray<{ readonly effect: unknown }> | undefined
) => {
  const [command] = commands ?? [];

  if (command === undefined) {
    throw new Error("no command");
  }

  // SAFETY: the shell's minting Commands need no service; a missing one fails the test.
  // Verified by: this file's refresh and scratch cases.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Effect.runSync(command.effect as Effect.Effect<Message>);
};

describe("the rail and the project's list", () => {
  it("shows every folder project and hides the scratch project", () => {
    assert.deepStrictEqual(
      railProjectsOf(onProjectThread).map((project) => project.title),
      ["cairn", "oscargabriel-dev", "myr"]
    );
    assert.strictEqual(projectLetterOf(projectOf(MYR)), "M");
  });

  it("selects the picked project, else the open thread's, else the first", () => {
    const onHero = shellModelOn(AppRoute.Hero());

    assert.strictEqual(
      Option.map(selectedProjectOf(onHero), (project) => project.id).pipe(
        Option.getOrThrow
      ),
      CAIRN
    );
    assert.strictEqual(
      Option.getOrThrow(
        selectedProjectOf({
          ...onProjectThread,
          selectedProjectId: Option.some(MYR),
        })
      ).id,
      MYR
    );
  });

  it("lists the threads the project thread manages, newest first, each with its status", () => {
    const requests = requestsOf(onProjectThread);

    const rows = managedThreadsFor(
      onProjectThread,
      threadOf(PROJECT_THREAD)
    ).map((thread) => {
      const row = rowStatusOf(thread, requests, onProjectThread.context.nowMs);

      return `${row.status.tone}/${row.status.mark}/${row.status.word}`;
    });

    assert.deepStrictEqual(rows, [
      "waiting/needs/Approval",
      "working/busy/Working",
      "failed/failed/Failed",
      "waiting/warning/Limited",
      "done/done/Done",
      "neutral/idle/Idle",
    ]);
  });

  it("marks a bubble that needs the user, and the project thread asks for its child", () => {
    const requests = requestsOf(onProjectThread);

    assert.strictEqual(
      projectMarkOf(onProjectThread, projectOf(CAIRN), requests),
      "needs"
    );
    assert.strictEqual(
      projectMarkOf(onProjectThread, projectOf(DEV), requests),
      "none"
    );
    assert.strictEqual(
      rowStatusOf(threadOf(PROJECT_THREAD), requests, 0).status.word,
      "Approval"
    );
  });

  it("lists asking and live rows first, folds the resting ones behind a count, and says each row's word (U-9)", () => {
    const content = sidebarContentOf(onProjectThread);

    assert.deepStrictEqual(
      {
        live: words(content.managed.live.visibleRows),
        resting: words(content.managed.resting.visibleRows),
        restingCount: content.managed.restingCount,
        isRestingOpen: content.managed.isRestingOpen,
      },
      {
        live: ["Approval", "Working", "Limited"],
        resting: ["Failed", "Done", "Idle"],
        restingCount: 3,
        isRestingOpen: false,
      }
    );

    // A child that asks is lifted above newer live ones.
    const older = shellModelOn(AppRoute.Thread({ threadId: PROJECT_THREAD }));
    const shell = Option.getOrThrow(older.context.shell);

    const lifted = {
      ...older,
      context: {
        ...older.context,
        shell: Option.some({
          ...shell,
          threads: shell.threads.map((thread) =>
            thread.id === rowId(5) ? { ...thread, ...asking("q-5") } : thread
          ),
        }),
      },
    };

    assert.deepStrictEqual(
      sidebarContentOf(lifted).managed.live.visibleRows.map(
        ({ thread }) => thread.id
      ),
      [rowId(2), rowId(5), rowId(3)]
    );

    // Bounded: each group shows six rows, then twelve more per Show more.
    const many = {
      ...older,
      context: {
        ...older.context,
        shell: Option.some({
          ...shell,
          threads: [
            ...shell.threads,
            ...Array.from({ length: 30 }, (_, index) =>
              shellRow(200 + index, {
                projectId: CAIRN,
                lineage: Option.some({
                  parentThreadId: PROJECT_THREAD,
                  relationshipToParent: "subagent" as const,
                  rootThreadId: PROJECT_THREAD,
                }),
                latestRunCompletedAt: Option.some(NOW),
                lastVisitedAt: Option.some(NOW),
              })
            ),
          ],
        }),
      },
    };

    const folded = sidebarContentOf(many).managed;

    assert.deepStrictEqual(
      [
        folded.restingCount,
        folded.resting.visibleRows.length,
        folded.resting.hiddenCount,
      ],
      [33, 6, 27]
    );

    const more = update(
      update(many, Message.ClickedRestingThreads()).model,
      Message.ClickedMoreManaged({ group: "resting" })
    ).model;

    const grown = sidebarContentOf(more).managed;

    assert.isTrue(grown.isRestingOpen);
    assert.strictEqual(grown.resting.visibleRows.length, 18);
  });

  it("draws the project thread's row as open and counts its managed threads", () => {
    const content = sidebarContentOf(onProjectThread);

    assert.isTrue(Option.getOrThrow(content.projectThread).isOpen);
    assert.strictEqual(content.managed.count, MANAGED.length);
    assert.deepStrictEqual(
      railBubblesOf(onProjectThread).map((bubble) => bubble.mark),
      ["needs", "none", "none"]
    );
    assert.deepStrictEqual(
      railBubblesOf(onProjectThread).map((bubble) => [
        bubble.project.title,
        bubble.isSelected,
        bubble.faviconUrl,
      ]),
      [
        ["cairn", true, "/api/projects/prj_cairn/favicon"],
        ["oscargabriel-dev", false, "/api/projects/prj_dev/favicon"],
        ["myr", false, "/api/projects/prj_myr/favicon"],
      ]
    );
  });

  it("says what the open thread is to its project", () => {
    const managed = shellModelOn(
      AppRoute.Thread({ threadId: MANAGED[1]?.id ?? PROJECT_THREAD })
    );

    assert.strictEqual(
      threadRoleOf(onProjectThread, threadOf(PROJECT_THREAD)),
      "project-thread"
    );
    assert.strictEqual(
      threadRoleOf(managed, threadOf(MANAGED[1]?.id ?? "")),
      "managed"
    );
    assert.strictEqual(
      threadRoleOf(managed, threadOf(SCRATCH_THREAD)),
      "scratch"
    );

    const header = headerContentOf(onProjectThread);

    assert.strictEqual(header.title, "cairn");
    assert.isTrue(header.canRefresh);
    assert.deepStrictEqual(header.role, Option.some("project thread"));

    const managedHeader = headerContentOf(managed);

    assert.isFalse(managedHeader.canRefresh);
    assert.deepStrictEqual(
      managedHeader.role,
      Option.some("managed by cairn's project thread")
    );
  });
});

describe("the shell's update", () => {
  it("opens a project's project thread from the rail, and a draft in that project for one without", () => {
    const toCairn = update(
      onProjectThread,
      Message.ClickedProject({ projectId: CAIRN })
    );

    assert.deepStrictEqual(
      toCairn.outMessage,
      OutMessage.RequestedNavigate({ url: `/t/${PROJECT_THREAD}` })
    );

    const toMyr = update(
      onProjectThread,
      Message.ClickedProject({ projectId: MYR })
    );

    // Myr has no project thread: a draft of its own opens with myr as its project, so the first
    // message launches there and never archives the thread of the project the user came from.
    assert.isUndefined(toMyr.outMessage);
    assert.deepStrictEqual(toMyr.model.selectedProjectId, Option.some(MYR));

    const minted = runOnly(toMyr.commands);

    assert.isTrue(Predicate.isTagged(minted, "PreparedProjectDraft"));

    if (Predicate.isTagged(minted, "PreparedProjectDraft")) {
      assert.strictEqual(minted.projectId, MYR);
      assert.deepStrictEqual(
        update(toMyr.model, minted).outMessage,
        OutMessage.RequestedProjectDraft({
          projectId: MYR,
          draftId: minted.draftId,
        })
      );
    }

    const started = update(
      onProjectThread,
      Message.ClickedStartProjectThread({ projectId: MYR })
    );

    const startedDraft = runOnly(started.commands);

    assert.deepStrictEqual(started.model.selectedProjectId, Option.some(MYR));
    assert.isTrue(
      Predicate.isTagged(startedDraft, "PreparedProjectDraft") &&
        startedDraft.projectId === MYR
    );
    assert.deepStrictEqual(
      update(onProjectThread, Message.ClickedUsage()).outMessage,
      OutMessage.RequestedNavigate({ url: USAGE_PATH })
    );
  });

  it("follows the route to another thread's project and closes the phone's sheet", () => {
    const picked: Model = {
      ...shellModelOn(AppRoute.Hero()),
      selectedProjectId: Option.some(MYR),
      isSheetOpen: true,
    };

    const followed = inform(picked, {
      ...picked.context,
      route: AppRoute.Thread({ threadId: PROJECT_THREAD }),
    }).model;

    assert.deepStrictEqual(followed.selectedProjectId, Option.some(CAIRN));
    assert.isFalse(followed.isSheetOpen);
  });

  it("asks before a refresh, then launches the new project thread replacing this one and opens it", () => {
    const managed = shellModelOn(
      AppRoute.Thread({ threadId: MANAGED[0]?.id ?? PROJECT_THREAD })
    );

    assert.isTrue(
      Option.isNone(update(managed, Message.ClickedRefresh()).model.refresh)
    );

    const asked = update(onProjectThread, Message.ClickedRefresh()).model;

    assert.isTrue(Option.isSome(asked.refresh));
    assert.deepStrictEqual(
      update(asked, Message.ClickedConfirmRefresh()).commands ?? [],
      []
    );

    const typed = update(
      asked,
      Message.ChangedRefreshText({ value: "Start on L7." })
    ).model;

    const confirmed = update(typed, Message.ClickedConfirmRefresh());
    const prepared = runOnly(confirmed.commands);

    assert.isTrue(Predicate.isTagged(prepared, "PreparedRefresh"));

    if (!Predicate.isTagged(prepared, "PreparedRefresh")) {
      return;
    }

    assert.isTrue(Predicate.isTagged(prepared.item, "Launch"));

    if (Predicate.isTagged(prepared.item, "Launch")) {
      assert.strictEqual(prepared.item.input.replaces, PROJECT_THREAD);
      assert.strictEqual(prepared.item.input.projectId, CAIRN);
      assert.strictEqual(
        prepared.item.input.initialMessage.text,
        "Start on L7."
      );
    }

    const done = update(confirmed.model, prepared);

    assert.isTrue(Option.isNone(done.model.refresh));
    assert.deepStrictEqual(done.outMessage?._tag, "RequestedOutbox");

    if (done.outMessage?._tag === "RequestedOutbox") {
      assert.deepStrictEqual(
        done.outMessage.navigateTo,
        Option.some(`/t/${prepared.threadId}`)
      );
    }
  });

  it("shows and hides the scratch thread on its shortcut, and Escape closes the confirm first", () => {
    const shown = update(
      onProjectThread,
      Message.PressedScratchShortcut()
    ).model;

    assert.isTrue(shown.scratch.isOpen);
    // The overlay takes the keyboard from the composer behind it, and so does the refresh confirm.
    assert.deepStrictEqual(
      update(onProjectThread, Message.PressedScratchShortcut()).commands?.map(
        (command) => [command.name, command.args]
      ),
      [["FocusField", { selector: "#scratch-editor" }]]
    );
    assert.deepStrictEqual(
      update(onProjectThread, Message.ClickedRefresh()).commands?.map(
        (command) => [command.name, command.args]
      ),
      [["FocusField", { selector: "#refresh-text" }]]
    );
    assert.deepStrictEqual(
      update(shown, Message.PressedScratchShortcut()).commands ?? [],
      []
    );
    assert.isFalse(
      update(shown, Message.PressedScratchShortcut()).model.scratch.isOpen
    );

    const both = update(shown, Message.ClickedRefresh()).model;
    const escaped = update(both, Message.PressedEscape()).model;

    assert.isTrue(Option.isNone(escaped.refresh));
    assert.isTrue(escaped.scratch.isOpen);
    assert.isFalse(
      update(escaped, Message.PressedEscape()).model.scratch.isOpen
    );
  });

  it("launches the scratch thread with its first message, sends after, and clears it", () => {
    const open = update(onProjectThread, Message.ClickedScratchButton()).model;

    const typed = update(
      open,
      Message.ChangedScratchDraft({ value: "  " })
    ).model;

    assert.deepStrictEqual(
      update(typed, Message.PressedScratchEnter()).commands ?? [],
      []
    );

    const unready = update(
      update(open, Message.ChangedScratchDraft({ value: "What is fsync?" }))
        .model,
      Message.ClickedSendScratch()
    ).model;

    assert.isTrue(
      Option.isSome(unready.failure),
      "no defaults yet, no thread yet"
    );

    const ready: Model = {
      ...open,
      context: {
        ...open.context,
        defaults: Option.some({
          model: { provider: "opencode-go", modelId: "small" },
          thinkingLevel: "medium",
        }),
      },
      scratch: { ...open.scratch, draft: "What is fsync?" },
    };

    const sent = update(ready, Message.PressedScratchEnter());

    assert.deepStrictEqual(
      (sent.commands ?? []).map((command) => command.name),
      ["PrepareScratchTurn"]
    );

    const launched = update(
      sent.model,
      Message.PreparedScratchTurn({
        item: OutboxItem.Send({
          input: SendInput.make({
            threadId: SCRATCH_THREAD,
            input: {
              requestId: RequestId.make("req-1"),
              text: "What is fsync?",
              attachments: [],
              skillRefs: [],
            },
            whenBusy: "followUp",
          }),
        }),
        threadId: SCRATCH_THREAD,
      })
    );

    assert.deepStrictEqual(
      launched.model.scratch.threadId,
      Option.some(SCRATCH_THREAD)
    );
    assert.strictEqual(launched.model.scratch.draft, "");
    assert.deepStrictEqual(
      (launched.commands ?? []).map((command) => command.name),
      ["SaveScratch"]
    );
    assert.strictEqual(launched.outMessage?._tag, "RequestedOutbox");

    const followUp = update(
      {
        ...launched.model,
        scratch: { ...launched.model.scratch, draft: "And rename?" },
      },
      Message.ClickedSendScratch()
    );

    const nextTurn = runOnly(followUp.commands);

    assert.isTrue(
      Predicate.isTagged(nextTurn, "PreparedScratchTurn") &&
        Predicate.isTagged(nextTurn.item, "Send")
    );

    const clearing = update(launched.model, Message.ClickedClearScratch());
    const clear = runOnly(clearing.commands);

    assert.isTrue(Predicate.isTagged(clear, "PreparedScratchClear"));

    if (Predicate.isTagged(clear, "PreparedScratchClear")) {
      assert.isTrue(
        Predicate.isTagged(clear.item, "Dispatch") &&
          Predicate.isTagged(clear.item.command, "ThreadClear") &&
          clear.item.command.threadId === SCRATCH_THREAD
      );

      const cleared = update(clearing.model, clear);

      assert.isTrue(Option.isNone(cleared.model.scratch.threadId));
      assert.strictEqual(cleared.outMessage?._tag, "RequestedOutbox");
    }
  });
});

const ready = (model: Model, draft: string): Model => ({
  ...model,
  context: {
    ...model.context,
    defaults: Option.some({
      model: { provider: "opencode-go", modelId: "small" },
      thinkingLevel: "medium",
    }),
  },
  scratch: { ...model.scratch, isOpen: true, draft },
});

const withoutScratchRow = {
  ...SHELL,
  snapshotSequence: 2,
  threads: SHELL.threads.filter((thread) => thread.id !== SCRATCH_THREAD),
};

const listing = (path: string) => ({
  path,
  parent: Option.none<string>(),
  entries: [],
});

describe("the shell's stale answers and overlays", () => {
  it("forgets a scratch thread whose row left the shell, so the next turn launches a new one", () => {
    const holding: Model = ready(
      {
        ...onProjectThread,
        started: true,
        scratch: {
          ...onProjectThread.scratch,
          threadId: Option.some(SCRATCH_THREAD),
        },
      },
      "Is it still there?"
    );

    // Another tab pressed Clear: the brain deleted the thread and its row left the shell.
    const cleared = inform(holding, {
      ...holding.context,
      shell: Option.some(withoutScratchRow),
    });

    const sent = update(cleared.model, Message.PressedScratchEnter());

    assert.deepStrictEqual(
      (sent.commands ?? []).map((command) => [
        command.name,
        command.args?.threadId,
      ]),
      [["PrepareScratchTurn", Option.none()]],
      "the turn went to the cleared thread"
    );
    // The fold's first read of the project's earlier project threads goes out beside it.
    assert.deepStrictEqual(
      (cleared.commands ?? [])
        .filter((command) => command.name !== "FetchPreviousThreads")
        .map((command) => [command.name, command.args]),
      [["SaveScratch", { threadId: Option.none() }]]
    );

    // A thread launched here whose row has not shown yet (its launch is on its way) is kept.
    const launched = rowId(91);

    const launching = inform(
      {
        ...cleared.model,
        scratch: { ...cleared.model.scratch, threadId: Option.some(launched) },
      },
      { ...cleared.model.context, shell: Option.some(SHELL) }
    );

    assert.deepStrictEqual(
      launching.model.scratch.threadId,
      Option.some(launched)
    );
    assert.lengthOf(launching.commands ?? [], 0);
  });

  it("keeps what was typed in the scratch field while a turn was being prepared", () => {
    const typed = ready(
      { ...onProjectThread, started: true },
      "What is fsync?"
    );

    const sent = update(typed, Message.PressedScratchEnter());

    const more = update(
      sent.model,
      Message.ChangedScratchDraft({ value: "What is fsync? and fdatasync?" })
    ).model;

    const prepared = update(
      more,
      Message.PreparedScratchTurn({
        item: OutboxItem.Send({
          input: SendInput.make({
            threadId: SCRATCH_THREAD,
            input: {
              requestId: RequestId.make("req-2"),
              text: "What is fsync?",
              attachments: [],
              skillRefs: [],
            },
            whenBusy: "followUp",
          }),
        }),
        threadId: SCRATCH_THREAD,
      })
    ).model;

    assert.strictEqual(
      prepared.scratch.draft,
      "and fdatasync?",
      "the words typed after the send were wiped"
    );
  });

  it("drops a listing asked by a picker the user closed, after it reopens", () => {
    let model: Model = { ...onProjectThread, started: true };

    const requests: Array<number> = [];

    for (const message of [
      Message.ClickedAddProject(),
      Message.ClickedBrowseFolder({ path: "/home/u/big" }),
      Message.PressedEscape(),
      Message.ClickedAddProject(),
      Message.ClickedBrowseFolder({ path: "/home/u/small" }),
    ]) {
      const next = update(model, message);

      ({ model } = next);

      for (const command of next.commands ?? []) {
        const request = command.args?.request;

        if (command.name === "BrowseFolders" && Predicate.isNumber(request)) {
          requests.push(request);
        }
      }
    }

    const [, big = 0, , small = 0] = requests;

    for (const message of [
      Message.ReceivedFolders({
        request: small,
        result: listing("/home/u/small"),
      }),
      Message.ReceivedFolders({ request: big, result: listing("/home/u/big") }),
    ]) {
      ({ model } = update(model, message));
    }

    assert.deepStrictEqual(
      Option.map(model.addProject, (state) =>
        Predicate.isTagged(state.listing, "Loaded")
          ? state.listing.result.path
          : state.listing._tag
      ),
      Option.some("/home/u/small"),
      "the closed picker's listing replaced the open one's"
    );
  });

  it("applies an add's answer only to the picker that is adding that folder", () => {
    let model: Model = { ...onProjectThread, started: true };

    for (const message of [
      Message.ClickedAddProject(),
      Message.ChangedAddProjectFolder({ value: "/home/u/x" }),
      Message.SubmittedAddProject(),
      Message.PressedEscape(),
      Message.ClickedAddProject(),
      Message.ChangedAddProjectFolder({ value: "/home/u/y" }),
    ]) {
      ({ model } = update(model, message));
    }

    const refused = update(
      model,
      Message.FailedAddProject({
        folder: "/home/u/x",
        message: "That folder is already a project.",
      })
    ).model;

    assert.deepStrictEqual(
      Option.map(refused.addProject, (state) => state.failure),
      Option.some(Option.none()),
      "X's refusal was written into Y's picker"
    );

    const added = update(model, Message.AddedProject({ folder: "/home/u/x" }));

    assert.isTrue(
      Option.isSome(added.model.addProject),
      "X's answer closed Y's picker"
    );
    assert.isTrue(Option.isNone(added.model.awaitedFolder));
  });

  it("says on the refresh confirm that its project thread is gone, keeping the first message", () => {
    let typed: Model = { ...onProjectThread, started: true };

    for (const message of [
      Message.ClickedRefresh(),
      Message.ChangedRefreshText({ value: "Start on L7." }),
    ]) {
      ({ model: typed } = update(typed, message));
    }

    // Another device archived the project thread: its row left the shell.
    const gone = inform(typed, {
      ...typed.context,
      shell: Option.some({
        ...SHELL,
        snapshotSequence: 2,
        threads: SHELL.threads.filter((thread) => thread.id !== PROJECT_THREAD),
      }),
    }).model;

    const confirmed = update(gone, Message.ClickedConfirmRefresh()).model;

    assert.deepStrictEqual(
      Option.map(confirmed.refresh, (confirm) => [
        confirm.text,
        confirm.failure,
      ]),
      Option.some([
        "Start on L7.",
        Option.some(
          "That project thread is gone; open the project again to refresh it."
        ),
      ]),
      "the confirm closed with nothing on screen"
    );
    assert.isTrue(
      Option.isNone(confirmed.failure),
      "the scratch overlay holds the refresh's failure"
    );
  });
});

describe("the hero and the rail agree on the project (U-21)", () => {
  it("selects the draft's project on the hero, over a project picked earlier on the rail", () => {
    const onHero: Model = {
      ...shellModelOn(AppRoute.Hero()),
      selectedProjectId: Option.some(CAIRN),
    };

    const told = inform(onHero, {
      ...onHero.context,
      draftProjectId: Option.some(MYR),
    }).model;

    assert.strictEqual(Option.getOrThrow(selectedProjectOf(told)).id, MYR);
    assert.deepStrictEqual(
      railBubblesOf(told)
        .filter((bubble) => bubble.isSelected)
        .map((bubble) => bubble.project.id),
      [MYR]
    );
    assert.strictEqual(headerContentOf(told).title, "myr");

    // Off the hero the draft's project no longer leads.
    const onThread = inform(told, {
      ...told.context,
      route: AppRoute.Thread({ threadId: PROJECT_THREAD }),
      draftProjectId: Option.none(),
    }).model;

    assert.strictEqual(
      Option.getOrThrow(selectedProjectOf(onThread)).id,
      CAIRN
    );
  });

  it("falls back to the hero's default project, the most recently updated one", () => {
    const recent = shellModelOn(AppRoute.Settings());

    const dev = {
      ...recent,
      context: {
        ...recent.context,
        shell: Option.some({
          ...SHELL,
          projects: SHELL.projects.map((project) =>
            project.id === DEV ? { ...project, updatedAt: NOW } : project
          ),
        }),
      },
    };

    assert.strictEqual(Option.getOrThrow(selectedProjectOf(dev)).id, DEV);
  });
});

/** An earlier project thread of cairn's. */
const earlier = shellRow(40, {
  projectId: CAIRN,
  title: "Last week's project thread",
  archivedAt: Option.some(NOW),
});

/** The project thread's page once the shell is told it, with the fold's first read asked. */
const withFoldAsked = () => {
  const told = inform(onProjectThread, onProjectThread.context);

  return {
    model: told.model,
    fetch: (told.commands ?? []).find(
      (command) => command.name === "FetchPreviousThreads"
    ),
  };
};

describe("the Previous fold (ADR 0048)", () => {
  it("reads the selected project's earlier project threads, and again once a refresh moves the mark", () => {
    const { fetch, model } = withFoldAsked();

    assert.deepStrictEqual(fetch?.args, {
      request: 1,
      projectId: CAIRN,
      after: Option.none(),
    });
    assert.isTrue(model.previous.isLoading);

    // Told the same again, nothing more is read.
    assert.isUndefined(
      (inform(model, model.context).commands ?? []).find(
        (command) => command.name === "FetchPreviousThreads"
      )
    );

    // A refresh moves the mark: the fold reads again.
    const refreshed = inform(model, {
      ...model.context,
      shell: Option.some({
        ...SHELL,
        projects: SHELL.projects.map((project) =>
          project.id === CAIRN
            ? { ...project, projectThreadId: Option.some(rowId(41)) }
            : project
        ),
      }),
    });

    assert.deepStrictEqual(
      (refreshed.commands ?? []).find(
        (command) => command.name === "FetchPreviousThreads"
      )?.args,
      { request: 2, projectId: CAIRN, after: Option.none() }
    );
  });

  it("shows nothing while the project has none, and Previous (n) once it has", () => {
    const { model } = withFoldAsked();

    const none = update(
      model,
      Message.ReceivedPreviousThreads({
        request: 1,
        page: { threads: [], next: Option.none() },
        more: false,
      })
    ).model;

    assert.isTrue(Option.isNone(sidebarContentOf(none).previous));

    const some = update(
      model,
      Message.ReceivedPreviousThreads({
        request: 1,
        page: { threads: [earlier], next: Option.none() },
        more: false,
      })
    ).model;

    const shown = Option.getOrThrow(sidebarContentOf(some).previous);

    assert.deepStrictEqual(
      shown.rows.map((row) => row.thread.id),
      [earlier.id]
    );
    assert.isFalse(shown.isOpen);
    assert.isTrue(
      Option.getOrThrow(
        sidebarContentOf(update(some, Message.ClickedPreviousThreads()).model)
          .previous
      ).isOpen
    );

    // An answer to a read asked before the last one is dropped.
    assert.strictEqual(
      update(
        some,
        Message.ReceivedPreviousThreads({
          request: 0,
          page: { threads: [], next: Option.none() },
          more: false,
        })
      ).model,
      some
    );
  });

  it("opens an earlier project thread read only, named in the header, with the way to the project thread", () => {
    const { model } = withFoldAsked();

    const read = update(
      model,
      Message.ReceivedPreviousThreads({
        request: 1,
        page: { threads: [earlier], next: Option.none() },
        more: false,
      })
    ).model;

    const clicked = update(
      read,
      Message.ClickedPreviousThread({ thread: earlier })
    );

    assert.deepStrictEqual(
      clicked.outMessage,
      OutMessage.RequestedNavigate({ url: `/t/${earlier.id}` })
    );

    const opened = inform(clicked.model, {
      ...clicked.model.context,
      route: AppRoute.Thread({ threadId: earlier.id }),
    }).model;

    assert.isTrue(isEarlierThreadOpen(opened));

    const header = headerContentOf(opened);

    assert.strictEqual(header.title, earlier.title);
    assert.deepStrictEqual(header.role, Option.some("earlier project thread"));
    assert.isFalse(header.canRefresh);
    assert.isTrue(Option.isNone(header.menu));
    // The project it belonged to stays selected, and its row reads as the open page.
    assert.strictEqual(Option.getOrThrow(selectedProjectOf(opened)).id, CAIRN);
    assert.isTrue(
      Option.getOrThrow(sidebarContentOf(opened).previous).rows[0]?.isOpen ===
        true
    );

    assert.deepStrictEqual(
      update(opened, Message.ClickedOpenProjectThread({ projectId: CAIRN }))
        .outMessage,
      OutMessage.RequestedNavigate({ url: `/t/${PROJECT_THREAD}` })
    );

    // A live thread is never read only.
    assert.isFalse(isEarlierThreadOpen(onProjectThread));
  });

  it("keeps an earlier project thread read only when Back or a later click reaches it, not only the last fold click", () => {
    const { model } = withFoldAsked();

    const other = shellRow(43, {
      projectId: CAIRN,
      archivedAt: Option.some(NOW),
    });

    const read = update(
      model,
      Message.ReceivedPreviousThreads({
        request: 1,
        page: { threads: [earlier, other], next: Option.none() },
        more: false,
      })
    ).model;

    // Opened `other` from the fold, then Back to `earlier` (the route moves; no click).
    const clicked = update(
      read,
      Message.ClickedPreviousThread({ thread: other })
    ).model;

    const back = inform(clicked, {
      ...clicked.context,
      route: AppRoute.Thread({ threadId: earlier.id }),
    }).model;

    assert.isTrue(isEarlierThreadOpen(back));
    assert.strictEqual(headerContentOf(back).title, earlier.title);
    assert.deepStrictEqual(
      Option.getOrThrow(sidebarContentOf(back).previous).rows.map(
        (row) => [row.thread.id, row.isOpen] as const
      ),
      [
        [earlier.id, true],
        [other.id, false],
      ]
    );

    // A refresh that replaced the project thread, then Back to it: the fold holds it, no click.
    const backFromRefresh = inform(read, {
      ...read.context,
      route: AppRoute.Thread({ threadId: other.id }),
    }).model;

    assert.isTrue(isEarlierThreadOpen(backFromRefresh));
  });

  it("asks the brain about a thread a reload or a link opened that neither the shell nor the fold holds", () => {
    // An earlier project thread of myr's, while the fold reads cairn's (the hero's default).
    const myrs = shellRow(44, {
      projectId: MYR,
      title: "myr's last project thread",
      archivedAt: Option.some(NOW),
    });

    const reloaded = shellModelOn(AppRoute.Thread({ threadId: myrs.id }));
    const told = inform(reloaded, reloaded.context);

    const asked = (told.commands ?? []).find(
      (command) => command.name === "LookUpEarlierThread"
    );

    assert.deepStrictEqual(asked?.args, { threadId: myrs.id });
    assert.isFalse(isEarlierThreadOpen(told.model));

    // Told again before the answer, it is not asked twice.
    assert.isUndefined(
      (inform(told.model, told.model.context).commands ?? []).find(
        (command) => command.name === "LookUpEarlierThread"
      )
    );

    const answered = update(
      told.model,
      Message.LookedUpEarlierThread({
        threadId: myrs.id,
        thread: Option.some(myrs),
      })
    ).model;

    assert.isTrue(isEarlierThreadOpen(answered));
    assert.strictEqual(headerContentOf(answered).title, myrs.title);
    assert.strictEqual(Option.getOrThrow(selectedProjectOf(answered)).id, MYR);

    // A thread the brain says is not an earlier one (a launch the shell has not shown yet) keeps
    // its composer.
    const launching = update(
      told.model,
      Message.LookedUpEarlierThread({
        threadId: myrs.id,
        thread: Option.none(),
      })
    ).model;

    assert.isFalse(isEarlierThreadOpen(launching));

    // A thread the shell holds is never asked about.
    assert.isUndefined(
      (inform(onProjectThread, onProjectThread.context).commands ?? []).find(
        (command) => command.name === "LookUpEarlierThread"
      )
    );
  });

  it("reads the fold again when it is opened after a failed read", () => {
    const { model } = withFoldAsked();

    const failed = update(
      model,
      Message.FailedPreviousThreads({
        request: 1,
        message: "Cairn is reconnecting. Open it again once it is back.",
      })
    ).model;

    const reopened = update(failed, Message.ClickedPreviousThreads());

    assert.deepStrictEqual(
      (reopened.commands ?? []).find(
        (command) => command.name === "FetchPreviousThreads"
      )?.args,
      { request: 2, projectId: CAIRN, after: Option.none() }
    );
    assert.isTrue(reopened.model.previous.isOpen);
    assert.isTrue(Option.isNone(reopened.model.previous.failure));

    // Opening it with nothing wrong reads nothing.
    assert.isUndefined(
      update(model, Message.ClickedPreviousThreads()).commands?.[0]
    );
  });

  it("reads the next page after the rows shown and adds it below them", () => {
    const { model } = withFoldAsked();
    const cursor = { archivedAt: NOW, threadId: earlier.id };

    const older = shellRow(42, {
      projectId: CAIRN,
      archivedAt: Option.some(NOW),
    });

    const first = update(
      model,
      Message.ReceivedPreviousThreads({
        request: 1,
        page: { threads: [earlier], next: Option.some(cursor) },
        more: false,
      })
    ).model;

    assert.isTrue(Option.getOrThrow(sidebarContentOf(first).previous).hasMore);

    const more = update(first, Message.ClickedMorePreviousThreads());

    assert.deepStrictEqual(more.commands?.[0]?.args, {
      request: 2,
      projectId: CAIRN,
      after: Option.some(cursor),
    });

    const both = update(
      more.model,
      Message.ReceivedPreviousThreads({
        request: 2,
        page: { threads: [older], next: Option.none() },
        more: true,
      })
    ).model;

    assert.deepStrictEqual(
      Option.getOrThrow(sidebarContentOf(both).previous).rows.map(
        (row) => row.thread.id
      ),
      [earlier.id, older.id]
    );
  });
});

/** The rename or remove a step sent to the brain, if any. */
const dispatched = (result: {
  readonly commands?: ReadonlyArray<{
    readonly name: string;
    readonly args?: unknown;
  }>;
}) =>
  (result.commands ?? []).find((command) => command.name === "DispatchManage")
    ?.args;

describe("the project and thread menus (U-10)", () => {
  it("renames the project from its menu, with the name it has to start from", () => {
    const opened = update(
      onProjectThread,
      Message.ClickedMenu({ target: MenuTarget.Project({ projectId: CAIRN }) })
    ).model;

    assert.isTrue(sidebarContentOf(opened).isProjectMenuOpen);

    const asked = update(
      opened,
      Message.ClickedManage({
        action: ManageAction.RenameProject({ projectId: CAIRN }),
      })
    ).model;

    assert.isTrue(Option.isNone(asked.menu));
    assert.strictEqual(Option.getOrThrow(asked.manage).text, "cairn");

    // An empty name is refused here.
    const emptied = update(
      update(asked, Message.ChangedManageText({ value: "  " })).model,
      Message.ClickedConfirmManage()
    );

    assert.isUndefined(dispatched(emptied));
    assert.isTrue(
      Option.isSome(Option.getOrThrow(emptied.model.manage).failure)
    );

    const typed = update(
      asked,
      Message.ChangedManageText({ value: " cairn v2 " })
    ).model;

    const sent = update(typed, Message.ClickedConfirmManage());

    assert.deepStrictEqual(dispatched(sent), {
      action: ManageAction.RenameProject({ projectId: CAIRN }),
      text: "cairn v2",
    });
    assert.isTrue(Option.getOrThrow(sent.model.manage).isSending);

    const done = update(
      sent.model,
      Message.CompletedManage({
        action: ManageAction.RenameProject({ projectId: CAIRN }),
      })
    );

    assert.isTrue(Option.isNone(done.model.manage));
    assert.isUndefined(done.outMessage);
  });

  it("removes a project after its confirm, and leaves its page for the hero", () => {
    const remove = ManageAction.RemoveProject({ projectId: CAIRN });

    const opened = update(
      onProjectThread,
      Message.ClickedManage({ action: remove })
    ).model;

    const sent = update(opened, Message.ClickedConfirmManage());

    assert.deepStrictEqual(dispatched(sent), { action: remove, text: "" });

    const refused = update(
      sent.model,
      Message.FailedManage({ message: "Cairn is reconnecting." })
    ).model;

    assert.deepStrictEqual(
      Option.map(refused.manage, (manage) => [
        manage.isSending,
        manage.failure,
      ]),
      Option.some([false, Option.some("Cairn is reconnecting.")])
    );

    const done = update(
      sent.model,
      Message.CompletedManage({ action: remove })
    );

    assert.isTrue(Option.isNone(done.model.manage));
    assert.deepStrictEqual(
      done.outMessage,
      OutMessage.RequestedNavigate({ url: "/" })
    );

    // Removing a project whose page is not open stays where it is.
    const other = update(
      onProjectThread,
      Message.CompletedManage({
        action: ManageAction.RemoveProject({ projectId: MYR }),
      })
    );

    assert.isUndefined(other.outMessage);
  });

  it("offers no thread menu on a project thread, whose header shows its project's name, not its own", () => {
    assert.isTrue(Option.isNone(headerContentOf(onProjectThread).menu));
  });

  it("renames the open thread from the header's menu, and Escape closes the dialog then the menu", () => {
    const managedId = rowId(3);
    const onManaged = shellModelOn(AppRoute.Thread({ threadId: managedId }));
    const header = headerContentOf(onManaged);

    assert.deepStrictEqual(
      Option.map(header.menu, (menu) => menu.threadId),
      Option.some(managedId)
    );

    const rename = ManageAction.RenameThread({ threadId: managedId });

    const renaming = update(
      onManaged,
      Message.ClickedManage({ action: rename })
    ).model;

    assert.strictEqual(
      Option.getOrThrow(renaming.manage).text,
      threadOf(managedId).title
    );
    assert.deepStrictEqual(
      dispatched(update(renaming, Message.ClickedConfirmManage())),
      { action: rename, text: threadOf(managedId).title }
    );
    assert.isTrue(
      Option.isNone(update(renaming, Message.PressedEscape()).model.manage)
    );

    const menu = update(
      onManaged,
      Message.ClickedMenu({
        target: MenuTarget.Thread({ threadId: managedId }),
      })
    ).model;

    assert.isTrue(Option.getOrThrow(headerContentOf(menu).menu).isOpen);
    assert.isTrue(
      Option.isNone(update(menu, Message.PressedEscape()).model.menu)
    );
    // A second click on its button closes it.
    assert.isTrue(
      Option.isNone(
        update(
          menu,
          Message.ClickedMenu({
            target: MenuTarget.Thread({ threadId: managedId }),
          })
        ).model.menu
      )
    );
  });
});
