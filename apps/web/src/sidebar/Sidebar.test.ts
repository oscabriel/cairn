// Tests for the sidebar's state, which the app still runs for its clock, key bindings and visits
// (its views were deleted at the cutover, plan 7A). Each test starts from a shell the root has told
// the sidebar about, with the clock already read.

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import {
  BARE_ROW_FIELDS,
  ProjectShell,
  ShellSnapshot,
  ThreadShell,
} from "@cairn/protocol/Shell";
import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";

import { Message } from "./Message.ts";
import { initial } from "./Model.ts";
import type { ConnectionTag, Model } from "./Model.ts";
import { update } from "./Update.ts";

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
  projectThreadId: Option.none(),
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
    ...BARE_ROW_FIELDS,
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
    scratchThreadId: Option.none(),
    connection: "Live",
  },
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

  const opened = (connection: ConnectionTag): Model => {
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
