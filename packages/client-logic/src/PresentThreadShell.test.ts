import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { BARE_ROW_FIELDS, ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import { hasUnseenCompletion } from "./PresentThreadShell.ts";

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
  ...BARE_ROW_FIELDS,
});

describe(hasUnseenCompletion, () => {
  it("marks a completion unseen until the user visits after it", () => {
    const completed = {
      ...base,
      latestRunCompletedAt: Option.some(time("2026-10-22T10:00:00Z")),
    };

    assert.isTrue(hasUnseenCompletion(completed));
    assert.isTrue(
      hasUnseenCompletion({
        ...completed,
        lastVisitedAt: Option.some(time("2026-10-22T09:59:59Z")),
      })
    );
    assert.isFalse(
      hasUnseenCompletion({
        ...completed,
        lastVisitedAt: Option.some(time("2026-10-22T10:00:00Z")),
      })
    );
  });
});
