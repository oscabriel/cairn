// The `next` shell's logic, over the shell fixture: the rail's projects and marks, the selected
// project and its project thread's running list with each row's status from the one thread-state
// function, the header's word for the open thread, and the update's navigation, refresh and scratch
// flows (what it asks the root for, and the turns and commands it mints).

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
import { headerContentOf, railBubblesOf, sidebarContentOf } from "./View.ts";

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
      "waiting/warning/Parked",
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

  it("draws the project thread's row as open and counts its managed threads", () => {
    const content = sidebarContentOf(onProjectThread);

    assert.isTrue(Option.getOrThrow(content.projectThread).isOpen);
    assert.strictEqual(content.managed.length, MANAGED.length);
    assert.strictEqual(content.managed[0]?.meta, "subagent · asks you");
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
