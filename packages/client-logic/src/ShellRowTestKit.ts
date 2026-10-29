// Shell rows for tests: a whole top-level row and the fields a waiting request sets, so a test names
// only what it cares about.

import { ApprovalId, ProjectId, RunId, ThreadId } from "@cairn/protocol/Ids";
import { BARE_ROW_FIELDS } from "@cairn/protocol/Shell";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { DateTime, Option } from "effect";

/** The tests' present. */
export const NOW = DateTime.makeUnsafe("2026-10-29T12:00:00.000Z");

/** An hour before `NOW`. */
export const EARLIER = DateTime.makeUnsafe("2026-10-29T11:00:00.000Z");

/** Thread `n`'s id. */
export const rowId = (n: number) =>
  ThreadId.make(
    `01890a5d-ac96-774b-bcce-b302099a${String(n).padStart(4, "0")}`
  );

/** A top-level row, idle, seen, asking nothing; `overrides` change the rest. */
export const shellRow = (
  n: number,
  overrides: Partial<ThreadShell> = {}
): ThreadShell => ({
  id: rowId(n),
  projectId: ProjectId.make("prj_1"),
  title: `Thread ${String(n)}`,
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
  createdAt: EARLIER,
  updatedAt: EARLIER,
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
  ...overrides,
});

/** The row fields of one request waiting on a thread, as the projector sets them. */
export const asking = (approvalId: string): Partial<ThreadShell> => ({
  activity: "waiting",
  activeRunId: Option.some(RunId.make(1)),
  pendingRuntimeRequest: Option.some({
    id: ApprovalId.make(approvalId),
    kind: "user-input",
    createdAt: NOW,
    origin: Option.none(),
  }),
  pendingCount: 1,
});
