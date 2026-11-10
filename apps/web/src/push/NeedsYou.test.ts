// "Needs you" is counted one way (C-4): the review's five cases of rows give the same number on the
// favicon, the app icon and the push (the server counts with the same client-logic rule), and the
// rail lights its project exactly when that number counts the project's thread.

import { NO_PAGE, needsYouCount } from "@cairn/client-logic/Badge";
import {
  asking,
  EARLIER,
  NOW,
  rowId,
  shellRow,
} from "@cairn/client-logic/ShellRowTestKit";
import { ApprovalId, ProjectId } from "@cairn/protocol/Ids";
import type {
  ProjectShell,
  ShellSnapshot,
  ThreadShell,
} from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import { AppRoute } from "../Route.ts";
import { projectMarkOf, requestsOf } from "../shell/Derived.ts";
import { initial as initialShell } from "../shell/Model.ts";
import { syncVisits } from "../shell/Visits.ts";
import { pushContextOf } from "./Context.ts";

const PROJECT = ProjectId.make("prj_1");

const SCRATCH = ProjectId.make("prj_scratch");

const none = Option.none();

const PROJECT_THREAD = rowId(1);

const project: ProjectShell = {
  id: PROJECT,
  title: "cairn",
  kind: "folder",
  workspaceRoot: "/home/owner/cairn",
  repository: Option.none(),
  defaultModel: Option.none(),
  projectThreadId: Option.some(PROJECT_THREAD),
  createdAt: EARLIER,
  updatedAt: EARLIER,
};

const child = (n: number, overrides: Partial<ThreadShell>): ThreadShell =>
  shellRow(n, {
    lineage: Option.some({
      parentThreadId: PROJECT_THREAD,
      relationshipToParent: "subagent",
      rootThreadId: PROJECT_THREAD,
    }),
    ...overrides,
  });

const approval = (id: string): Partial<ThreadShell> => ({
  ...asking(id),
  pendingRuntimeRequest: Option.some({
    id: ApprovalId.make(id),
    kind: "tool-call",
    createdAt: NOW,
    origin: Option.none(),
  }),
});

/** A run that ended before the user's last look. */
const seen: Partial<ThreadShell> = {
  latestRunCompletedAt: Option.some(EARLIER),
  lastVisitedAt: Option.some(NOW),
};

const shellOf = (threads: ReadonlyArray<ThreadShell>): ShellSnapshot => ({
  snapshotSequence: 1,
  projects: [project],
  threads: [...threads],
});

/** The review's five cases of rows (C-4), each with the number every producer must give. */
const REVIEW_CASES: ReadonlyArray<{
  readonly name: string;
  readonly shell: ShellSnapshot;
  readonly needsYou: number;
}> = [
  {
    name: "one escalated question: the parent's mirror and the child's record",
    shell: shellOf([
      shellRow(1, asking("q-1-mirror")),
      child(2, { ...asking("q-1"), waitingFor: "parent" }),
    ]),
    needsYou: 1,
  },
  {
    name: "two children of one project thread, each holding an approval",
    shell: shellOf([
      shellRow(1),
      child(2, approval("a-1")),
      child(3, approval("a-2")),
    ]),
    needsYou: 1,
  },
  {
    // pi 1.5.1 parks nothing (ADR 0046); a spent plan window is the held row that replaced it.
    name: "a project thread held by a spent plan window, already seen",
    shell: shellOf([
      shellRow(1, {
        ...seen,
        activity: "failed",
        lastErrorClass: Option.some("usage_limit"),
      }),
    ]),
    needsYou: 0,
  },
  {
    name: "a project thread whose last run failed, already seen",
    shell: shellOf([
      shellRow(1, {
        ...seen,
        activity: "failed",
        lastError: Option.some("The provider answered 500."),
        lastErrorClass: Option.some("provider_error"),
      }),
    ]),
    needsYou: 0,
  },
  {
    name: "an unlisted top-level thread with an unseen result",
    shell: shellOf([
      shellRow(1),
      shellRow(9, {
        latestRunCompletedAt: Option.some(NOW),
        lastVisitedAt: Option.some(EARLIER),
      }),
    ]),
    needsYou: 0,
  },
];

/** The favicon's number, as the shell's update sets it for this shell. */
const faviconOf = (
  shell: ShellSnapshot,
  openThreadId: Option.Option<ThreadShell["id"]> = none
): number =>
  syncVisits({
    ...initialShell,
    context: {
      ...initialShell.context,
      shell: Option.some(shell),
      route: Option.match(openThreadId, {
        onNone: () => AppRoute.Hero(),
        onSome: (threadId) => AppRoute.Thread({ threadId }),
      }),
      isLive: true,
    },
    nowMs: DateTime.toEpochMillis(NOW),
  }).model.badgeCount;

describe("needs you", () => {
  it.each(REVIEW_CASES)(
    "counts $name as $needsYou on every producer",
    ({ shell, needsYou }) => {
      const favicon = faviconOf(shell);

      const appIcon = pushContextOf({
        epoch: 1,
        hasClient: true,
        hello: Option.none(),
        shell: Option.some(shell),
        openThreadId: Option.none(),
        scratchThreadId: Option.none(),
      }).badge;

      // The brain's notifier counts the live projects and rows with no scratch thread.
      const push = needsYouCount(shell, NO_PAGE);

      const shellModel = {
        ...initialShell,
        context: { ...initialShell.context, shell: Option.some(shell) },
        nowMs: DateTime.toEpochMillis(NOW),
      };

      const rail = projectMarkOf(shellModel, project, requestsOf(shellModel));

      assert.deepStrictEqual(
        { favicon, appIcon, push, railLit: rail === "needs" },
        {
          favicon: needsYou,
          appIcon: needsYou,
          push: needsYou,
          railLit: needsYou > 0,
        }
      );
    }
  );

  it("counts the scratch thread the page holds, which the brain cannot see", () => {
    const shell: ShellSnapshot = {
      snapshotSequence: 1,
      projects: [
        project,
        { ...project, id: SCRATCH, kind: "scratch", projectThreadId: none },
      ],
      threads: [
        shellRow(1),
        shellRow(90, { projectId: SCRATCH, ...asking("q-90") }),
      ],
    };

    const scratch = Option.some(rowId(90));

    assert.deepStrictEqual(
      {
        page: needsYouCount(shell, { ...NO_PAGE, scratchThreadId: scratch }),
        appIcon: pushContextOf({
          epoch: 1,
          hasClient: true,
          hello: Option.none(),
          shell: Option.some(shell),
          openThreadId: Option.none(),
          scratchThreadId: scratch,
        }).badge,
        push: needsYouCount(shell, NO_PAGE),
      },
      { page: 1, appIcon: 1, push: 0 }
    );
  });

  it("leaves out the result the user is watching on the page's producers, never a request", () => {
    // The project thread is open and its run has just finished: the user sees it as it lands,
    // before the visit round-trips, so the favicon, the app icon and the rail stay quiet. A request
    // on it still counts. The brain sees no page, so its number counts the result.
    const open = Option.some(PROJECT_THREAD);

    const unseen: Partial<ThreadShell> = {
      latestRunCompletedAt: Option.some(NOW),
      lastVisitedAt: Option.some(EARLIER),
    };

    const producers = (shell: ShellSnapshot) => {
      const shellModel = {
        ...initialShell,
        context: {
          ...initialShell.context,
          route: AppRoute.Thread({ threadId: PROJECT_THREAD }),
          shell: Option.some(shell),
        },
        nowMs: DateTime.toEpochMillis(NOW),
      };

      return {
        favicon: faviconOf(shell, open),
        appIcon: pushContextOf({
          epoch: 1,
          hasClient: true,
          hello: Option.none(),
          shell: Option.some(shell),
          openThreadId: open,
          scratchThreadId: none,
        }).badge,
        rail: projectMarkOf(shellModel, project, requestsOf(shellModel)),
      };
    };

    assert.deepStrictEqual(producers(shellOf([shellRow(1, unseen)])), {
      favicon: 0,
      appIcon: 0,
      rail: "none",
    });
    assert.deepStrictEqual(
      producers(shellOf([shellRow(1, { ...unseen, ...approval("a-1") })])),
      { favicon: 1, appIcon: 1, rail: "needs" }
    );
  });
});
