// Scene tests for the sidebar: the view and update together, driven the way the user drives them.
// Each test starts from a shell the root has told the sidebar about, with the clock already read.
import {
  allMenuIds,
  buildThreadActionMenuItems,
} from "@cairn/client-logic/ThreadMenu";
import { CommandId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import {
  ProjectShell,
  ShellSnapshot,
  ThreadShell,
} from "@cairn/protocol/Shell";
import { DateTime, Option } from "effect";
import * as Scene from "foldkit/scene";
import { describe, expect, it } from "vitest";

import { IssueCommands, NavigateTo, SaveShelves } from "./Command.ts";
import { PlaceMenu } from "./ContextMenu.ts";
import { threadMenuOf } from "./Derived.ts";
import { Intent, toShellCommand } from "./Intent.ts";
import { Message, OutMessage } from "./Message.ts";
import { initial } from "./Model.ts";
import type { Model } from "./Model.ts";
import { ListMotion } from "./Motion.ts";
import { ScrollFade } from "./ScrollFade.ts";
import { update } from "./Update.ts";
import { view } from "./View.ts";

const time = (iso: string) => DateTime.makeUnsafe(iso);

const NOW_MS = Date.parse("2026-10-22T12:00:00.000Z");

const projectId = ProjectId.make("prj_cairn");

const project = ProjectShell.make({
  id: projectId,
  title: "cairn",
  kind: "folder",
  workspaceRoot: "/home/owner/Developer/projects/cairn",
  repository: Option.none(),
  defaultModel: Option.none(),
  createdAt: time("2026-10-01T00:00:00Z"),
  updatedAt: time("2026-10-01T00:00:00Z"),
});

const threadId = (suffix: number) =>
  ThreadId.make(
    `01890a5d-ac96-774b-bcce-b302099a${String(suffix).padStart(4, "0")}`
  );

const thread = (
  suffix: number,
  title: string,
  createdAt: string
): ThreadShell =>
  ThreadShell.make({
    id: threadId(suffix),
    projectId,
    title,
    provider: "claude-bridge",
    modelId: "claude-haiku-5-5",
    thinkingLevel: "medium",
    runtimeMode: "full-access",
    branch: Option.some("main"),
    worktreePath: Option.none(),
    activity: "idle",
    activeRunId: Option.none(),
    latestRunRequestedAt: Option.none(),
    latestRunStartedAt: Option.none(),
    latestRunCompletedAt: Option.none(),
    queueLength: 0,
    lastError: Option.none(),
    lastErrorClass: Option.none(),
    usageLimitResetAt: Option.none(),
    waitingFor: "none",
    pendingRuntimeRequest: Option.none(),
    latestVisibleMessage: Option.none(),
    latestUserMessageAt: Option.some(time(createdAt)),
    createdAt: time(createdAt),
    updatedAt: time(createdAt),
    archivedAt: Option.none(),
    settledOverride: Option.none(),
    settledAt: Option.none(),
    unsettledAt: Option.none(),
    snoozedUntil: Option.none(),
    snoozedAt: Option.none(),
    pinnedAt: Option.none(),
    pinOrderKey: Option.none(),
    activeOrderKey: Option.none(),
    autoSettleDisabledAt: Option.none(),
    lastVisitedAt: Option.none(),
    parkedTaskIds: [],
  });

const bridges = thread(1, "Executor MCP Stdio Bridges", "2026-10-22T11:00:00Z");

const research = thread(
  2,
  "SSH Multiplayer Product Research",
  "2026-10-22T09:00:00Z"
);

const kickoff = thread(3, "Cairn v2 KICKOFF.md review", "2026-10-21T09:00:00Z");

/** A sidebar the root has told about one project and three threads, with `openThread` open. */
const sidebarWith = (openThread: Option.Option<ThreadShell>): Model => ({
  ...initial,
  nowMs: NOW_MS,
  context: {
    shell: Option.some(
      ShellSnapshot.make({
        snapshotSequence: 7,
        projects: [project],
        threads: [bridges, research, kickoff],
      })
    ),
    openThreadId: Option.map(openThread, (open) => open.id),
    openDraftId: Option.none(),
    connection: "Live",
    drafts: [],
  },
});

const row = (target: ThreadShell) =>
  Scene.selector(`[data-thread-item="${target.id}"]`);

const commandId = CommandId.make("01890a5d-ac96-774b-bcce-b302099a9999");

const issued = (...intents: ReadonlyArray<Intent>) =>
  intents.map((intent) => toShellCommand(intent, commandId));

const config = { update, view };

describe("the sidebar", () => {
  it("lists active threads as cards and settled ones behind the shelf", () => {
    Scene.scene(
      config,
      Scene.given(sidebarWith(Option.none())),
      Scene.Mount.resolve(ListMotion, Message.CompletedMotion()),
      Scene.Mount.resolve(ScrollFade, Message.CompletedScrollFade()),
      Scene.expectAll(Scene.all.testId("sidebar-row-card")).toHaveCount(3),
      Scene.expect(Scene.testId("sidebar-settled-shelf-toggle")).toHaveText(
        "Settled (0)"
      ),
      Scene.expect(Scene.within(row(bridges), Scene.text("cairn"))).toExist(),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });

  it("settles a row, advances to the next thread, and undo restores it", () => {
    Scene.scene(
      config,
      Scene.given(sidebarWith(Option.some(bridges))),
      Scene.Mount.resolve(ListMotion, Message.CompletedMotion()),
      Scene.Mount.resolve(ScrollFade, Message.CompletedScrollFade()),
      Scene.click(
        Scene.within(
          row(bridges),
          Scene.role("button", { name: "Settle thread" })
        )
      ),
      Scene.Command.resolve(
        IssueCommands,
        Message.IssuedCommands({
          commands: issued(Intent.Settle({ threadId: bridges.id })),
        })
      ),
      Scene.expectOutMessage(
        OutMessage.RequestedDispatch({
          commands: issued(Intent.Settle({ threadId: bridges.id })),
        })
      ),
      Scene.Command.resolve(
        NavigateTo({ url: `/t/${research.id}` }),
        Message.CompletedNavigate()
      ),
      Scene.expect(row(bridges)).toBeAbsent(),
      Scene.expect(Scene.testId("sidebar-settled-shelf-toggle")).toHaveText(
        "Settled (1)"
      ),
      Scene.expect(Scene.testId("sidebar-undo-notice")).toContainText(
        "Settled 1 thread"
      ),
      Scene.click(
        Scene.within(Scene.testId("sidebar-undo-notice"), Scene.role("button"))
      ),
      Scene.Command.resolve(
        IssueCommands,
        Message.IssuedCommands({
          commands: issued(Intent.Unsettle({ threadId: bridges.id })),
        })
      ),
      Scene.expect(Scene.testId("sidebar-undo-notice")).toBeAbsent(),
      Scene.expect(
        Scene.within(row(bridges), Scene.testId("sidebar-row-card"))
      ).toExist(),
      Scene.expect(Scene.testId("sidebar-settled-shelf-toggle")).toHaveText(
        "Settled (0)"
      ),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });

  it("snoozes a row from its context menu, which moves it to the snoozed shelf", () => {
    Scene.scene(
      config,
      Scene.given(sidebarWith(Option.none())),
      Scene.Mount.resolve(ListMotion, Message.CompletedMotion()),
      Scene.Mount.resolve(ScrollFade, Message.CompletedScrollFade()),
      Scene.contextMenu(
        Scene.within(row(research), Scene.testId("sidebar-row-card"))
      ),
      Scene.Mount.resolve(PlaceMenu, Message.CompletedPlaceMenu()),
      Scene.click(Scene.selector('[data-menu-id="snooze"]')),
      Scene.Mount.resolve(PlaceMenu, Message.CompletedPlaceMenu()),
      Scene.click(Scene.selector('[data-menu-id="snooze:tomorrow"]')),
      Scene.Mount.expectEnded(PlaceMenu, PlaceMenu),
      Scene.Command.resolve(
        IssueCommands,
        Message.IssuedCommands({
          commands: issued(
            Intent.Snooze({
              threadId: research.id,
              until: time("2026-10-23T09:00:00Z"),
            })
          ),
        })
      ),
      Scene.expect(row(research)).toBeAbsent(),
      Scene.expect(Scene.testId("sidebar-snoozed-shelf-toggle")).toHaveText(
        "Snoozed (1)"
      ),
      Scene.click(Scene.testId("sidebar-snoozed-shelf-toggle")),
      Scene.Command.resolve(SaveShelves, Message.CompletedSaveShelves()),
      Scene.expect(
        Scene.within(row(research), Scene.testId("sidebar-row-slim"))
      ).toExist(),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });

  it("filters the list by title as the user searches, and opens a result", () => {
    Scene.scene(
      config,
      Scene.given(sidebarWith(Option.none())),
      Scene.Mount.resolve(ListMotion, Message.CompletedMotion()),
      Scene.Mount.resolve(ScrollFade, Message.CompletedScrollFade()),
      Scene.type(Scene.label("Search threads"), "bridges"),
      Scene.Mount.expectEnded(ListMotion),
      Scene.expectAll(Scene.all.role("option")).toHaveCount(1),
      Scene.expect(
        Scene.role("option", { name: "Executor MCP Stdio Bridges, cairn" })
      ).toExist(),
      Scene.keydown(Scene.label("Search threads"), "Enter"),
      Scene.expectHandled(),
      Scene.Command.resolve(
        NavigateTo({ url: `/t/${bridges.id}` }),
        Message.CompletedNavigate()
      ),
      Scene.Mount.resolve(ListMotion, Message.CompletedMotion()),
      Scene.expectAll(Scene.all.testId("sidebar-row-card")).toHaveCount(3),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });

  it("offers exactly the trimmed thread menu", () => {
    const model = sidebarWith(Option.none());

    Scene.scene(
      config,
      Scene.given(model),
      Scene.Mount.resolve(ListMotion, Message.CompletedMotion()),
      Scene.Mount.resolve(ScrollFade, Message.CompletedScrollFade()),
      Scene.contextMenu(
        Scene.within(row(kickoff), Scene.testId("sidebar-row-card"))
      ),
      Scene.Mount.resolve(PlaceMenu, Message.CompletedPlaceMenu()),
      Scene.tap(({ html }) => {
        const shown = Scene.findAll(html, "[data-menu-id]").map((button) =>
          Scene.attr(button, "data-menu-id")
        );

        const expected = threadMenuOf(model, kickoff).map((item) => item.id);

        expect(shown.map((id) => Option.getOrNull(id))).toStrictEqual(expected);
        expect(expected).toStrictEqual([
          "pin",
          "settle",
          "snooze",
          "rename",
          "mark-unread",
          "filter-by-project",
          "auto-settle",
          "copy",
          "archive",
          "delete",
        ]);
        expect(
          allMenuIds(
            buildThreadActionMenuItems({
              hasBranch: true,
              projectFilter: Option.none(),
              isPinned: false,
              isSettled: false,
              autoSettleEnabled: true,
              isSnoozed: false,
              canSnoozeNow: true,
              isRunning: false,
              snoozePresets: [],
            })
          )
        ).not.toContain("project-settings");
      })
    );
  });
});

/** How many IssueCommands the sidebar asks for over `ticks` clock ticks four seconds apart. */
const visitsOver = (start: Model, after: number, ticks: number) => {
  let current = start;
  let issuedCount = 0;

  for (let tick = after + 1; tick <= after + ticks; tick += 1) {
    const { model, commands } = update(
      current,
      Message.Ticked({ nowMs: NOW_MS + tick * 4000 })
    );

    current = model;
    issuedCount += (commands ?? []).filter(
      (command) => command.name === "IssueCommands"
    ).length;
  }

  return { model: current, issuedCount };
};

describe("visits to the open thread", () => {
  const completed = ThreadShell.make({
    ...bridges,
    latestRunCompletedAt: Option.some(time("2026-10-22T11:30:00Z")),
    lastVisitedAt: Option.some(time("2026-10-22T11:00:00Z")),
  });

  const opened = (connection: string): Model => {
    const base = sidebarWith(Option.some(completed));

    return {
      ...base,
      // The open thread was visited before, so only a completion after that visit asks for one.
      visits: Option.some({
        threadId: completed.id,
        sentAtMs: NOW_MS - 60_000,
      }),
      context: {
        ...base.context,
        shell: Option.some(
          ShellSnapshot.make({
            snapshotSequence: 7,
            projects: [project],
            threads: [completed, research, kickoff],
          })
        ),
        connection,
      },
    };
  };

  it("are not queued while the connection is down, and one is sent once it is live", () => {
    const offline = visitsOver(opened("Backoff"), 0, 3);

    const live = visitsOver(
      {
        ...offline.model,
        context: { ...offline.model.context, connection: "Live" },
      },
      3,
      3
    );

    expect([offline.issuedCount, live.issuedCount]).toStrictEqual([0, 1]);
  });
});
