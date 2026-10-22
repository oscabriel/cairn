import { ApprovalId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import { presentThreadShell } from "./PresentThreadShell.ts";

const time = (iso: string) => DateTime.makeUnsafe(iso);

const base = ThreadShell.make({
  id: ThreadId.make("0199f0c2-6a4e-7d4c-9a6b-2b9a1f3c4d01"),
  projectId: ProjectId.make("prj_1"),
  title: "A thread",
  provider: "opencode-go",
  modelId: "small",
  thinkingLevel: "off",
  runtimeMode: "full-access",
  branch: Option.none(),
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
  latestUserMessageAt: Option.none(),
  createdAt: time("2026-10-22T08:00:00Z"),
  updatedAt: time("2026-10-22T08:00:00Z"),
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

const request = (kind: "executor-call" | "user-input") => ({
  ...base,
  pendingRuntimeRequest: Option.some({
    id: ApprovalId.make("apr_1"),
    kind,
    createdAt: base.createdAt,
  }),
});

describe(presentThreadShell, () => {
  it("reports a new thread as quiet", () => {
    const presented = presentThreadShell(base);

    assert.isFalse(presented.isWorking);
    assert.isFalse(presented.hasUnseenCompletion);
    assert.isTrue(Option.isNone(presented.latestRun));
    assert.strictEqual(presented.source, base);
  });

  it("counts working time from the run's start, falling back to when it was requested", () => {
    const requested = {
      ...base,
      activity: "running" as const,
      latestRunRequestedAt: Option.some(time("2026-10-22T09:00:00Z")),
    };

    assert.deepStrictEqual(
      presentThreadShell(requested).workingStartedAt,
      requested.latestRunRequestedAt
    );

    const started = {
      ...requested,
      latestRunStartedAt: Option.some(time("2026-10-22T09:00:02Z")),
    };

    assert.isTrue(presentThreadShell(started).isWorking);
    assert.deepStrictEqual(
      presentThreadShell(started).workingStartedAt,
      started.latestRunStartedAt
    );
    assert.isTrue(
      Option.isNone(
        presentThreadShell({ ...started, activity: "idle" }).workingStartedAt
      )
    );
  });

  it("marks a completion unseen until the user visits after it", () => {
    const completed = {
      ...base,
      latestRunCompletedAt: Option.some(time("2026-10-22T10:00:00Z")),
    };

    assert.isTrue(presentThreadShell(completed).hasUnseenCompletion);
    assert.isTrue(
      presentThreadShell({
        ...completed,
        lastVisitedAt: Option.some(time("2026-10-22T09:59:59Z")),
      }).hasUnseenCompletion
    );
    assert.isFalse(
      presentThreadShell({
        ...completed,
        lastVisitedAt: Option.some(time("2026-10-22T10:00:00Z")),
      }).hasUnseenCompletion
    );
  });

  it("tells an approval from a question", () => {
    assert.isTrue(
      presentThreadShell(request("executor-call")).hasPendingApproval
    );
    assert.isFalse(
      presentThreadShell(request("executor-call")).hasPendingUserInput
    );
    assert.isTrue(
      presentThreadShell(request("user-input")).hasPendingUserInput
    );
    assert.isFalse(
      presentThreadShell(request("user-input")).hasPendingApproval
    );
  });
});
