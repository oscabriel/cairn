import { ApprovalId } from "@cairn/protocol/Ids";
import { BARE_ROW_FIELDS } from "@cairn/protocol/Shell";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { ThreadSnooze, ThreadUnsettle } from "@cairn/protocol/ShellCommands";
import { assert, describe, expect, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Layer, Option } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";

import {
  DEFAULT_SERVER_SETTINGS,
  SettingsStore,
} from "../models/SettingsStore.ts";
import { EventSink } from "./EventSink.ts";
import {
  isSnoozed,
  resolveAutoSettlementAt,
  Settlement,
  threadHasQueuedTurnStart,
} from "./Settlement.ts";
import {
  createProject,
  createThread,
  ShellTestLayer,
  testCommandId,
  testThreadId,
} from "./ShellTestKit.ts";
import { ThreadRows } from "./ThreadRows.ts";
import type { ThreadRow } from "./ThreadRows.ts";

const DAY = 24 * 60 * 60 * 1000;

const at = (ms: number) => DateTime.makeUnsafe(ms);

const NOW = 100 * DAY;

const baseShell: ThreadShell = {
  id: testThreadId(1),
  projectId: createProject(1).projectId,
  title: "Thread",
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
  createdAt: at(NOW - 10 * DAY),
  updatedAt: at(NOW - 10 * DAY),
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
};

const row = (
  shell: Partial<ThreadShell> = {},
  wokeAt = Option.none<DateTime.Utc>()
): ThreadRow => ({
  shell: { ...baseShell, ...shell },
  deletedAt: Option.none(),
  lastSnoozeWakeAt: wokeAt,
});

const settleAt = (thread: ThreadRow, autoSettleDays = 3) =>
  resolveAutoSettlementAt({ row: thread, nowMs: NOW, autoSettleDays });

describe(resolveAutoSettlementAt, () => {
  it("settles a thread quiet for longer than the window, at its last activity", () => {
    const completed = at(NOW - 4 * DAY);

    const result = settleAt(
      row({ latestRunCompletedAt: Option.some(completed) })
    );

    assert.deepStrictEqual(result, Option.some(completed));
  });

  it("keeps a thread active inside the window", () => {
    assert.isTrue(
      Option.isNone(
        settleAt(row({ latestRunCompletedAt: Option.some(at(NOW - 2 * DAY)) }))
      )
    );
  });

  it("counts from creation when nothing ever ran", () => {
    assert.deepStrictEqual(settleAt(row()), Option.some(baseShell.createdAt));
  });

  it("is off when the window is 0 days", () => {
    assert.isTrue(Option.isNone(settleAt(row(), 0)));
  });

  it("never settles a pinned, manually set, auto-settle-off, busy, queued or waiting thread", () => {
    const blocked: ReadonlyArray<Partial<ThreadShell>> = [
      { pinnedAt: Option.some(at(NOW - 5 * DAY)) },
      { settledOverride: Option.some("active") },
      { autoSettleDisabledAt: Option.some(at(NOW - 5 * DAY)) },
      { activity: "running" },
      { activity: "waiting" },
      { queueLength: 1 },
      {
        pendingRuntimeRequest: Option.some({
          id: ApprovalId.make("apr_1"),
          kind: "tool-call",
          createdAt: at(NOW - 5 * DAY),
          origin: Option.none(),
        }),
      },
      { archivedAt: Option.some(at(NOW - 5 * DAY)) },
    ];

    for (const shell of blocked) {
      assert.isTrue(Option.isNone(settleAt(row(shell))), JSON.stringify(shell));
    }
  });

  it("never settles a subagent's row, nor a parent whose child works or asks; settled children do not hold it", () => {
    const parent = testThreadId(1);

    const blocked: ReadonlyArray<Partial<ThreadShell>> = [
      {
        lineage: Option.some({
          parentThreadId: parent,
          relationshipToParent: "subagent",
          rootThreadId: parent,
        }),
      },
      { subagents: { working: 1, asking: 0, settled: 2, failed: 0 } },
      { subagents: { working: 0, asking: 1, settled: 0, failed: 0 } },
    ];

    for (const shell of blocked) {
      assert.isTrue(Option.isNone(settleAt(row(shell))), JSON.stringify(shell));
    }

    assert.isTrue(
      Option.isSome(
        settleAt(
          row({ subagents: { working: 0, asking: 0, settled: 2, failed: 1 } })
        )
      )
    );
  });

  it("counts a snooze's end as activity", () => {
    const woke = at(NOW - 1 * DAY);

    assert.isTrue(Option.isNone(settleAt(row({}, Option.some(woke)))));

    const expired = row({
      snoozedUntil: Option.some(at(NOW - 1 * DAY)),
      snoozedAt: Option.some(at(NOW - 9 * DAY)),
    });

    assert.isTrue(Option.isNone(settleAt(expired)));
  });
});

describe(isSnoozed, () => {
  const snoozed = {
    snoozedUntil: Option.some(at(NOW + DAY)),
    snoozedAt: Option.some(at(NOW - DAY)),
  };

  it("holds until the wake time", () => {
    assert.isTrue(isSnoozed(row(snoozed).shell, NOW));
    assert.isFalse(isSnoozed(row(snoozed).shell, NOW + DAY));
  });

  it("wakes early on a run that failed after the snooze began, or on a pending request", () => {
    assert.isFalse(
      isSnoozed(
        row({
          ...snoozed,
          activity: "failed",
          latestRunCompletedAt: Option.some(at(NOW - 1000)),
        }).shell,
        NOW
      )
    );
    assert.isTrue(
      isSnoozed(
        row({
          ...snoozed,
          activity: "failed",
          latestRunCompletedAt: Option.some(at(NOW - 2 * DAY)),
        }).shell,
        NOW
      )
    );
  });
});

describe(threadHasQueuedTurnStart, () => {
  it("holds a fresh message no run has picked up, within two minutes", () => {
    const sent = { latestUserMessageAt: Option.some(at(NOW - 60_000)) };

    assert.isTrue(threadHasQueuedTurnStart(row(sent).shell, NOW));
    assert.isFalse(threadHasQueuedTurnStart(row(sent).shell, NOW + 120_000));
    assert.isFalse(
      threadHasQueuedTurnStart(
        row({ ...sent, latestRunStartedAt: Option.some(at(NOW - 30_000)) })
          .shell,
        NOW
      )
    );
  });
});

/** The server settings with `autoSettleDays` set; the rest at their defaults. */
const settingsWith = (autoSettleDays: number) =>
  Layer.succeed(
    SettingsStore,
    SettingsStore.of({
      get: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, autoSettleDays }),
      update: () => Effect.die("settlement never writes settings"),
    })
  );

const run = <A, E>(
  body: Effect.Effect<
    A,
    E,
    Layer.Success<typeof ShellTestLayer> | Settlement | Scope.Scope
  >,
  autoSettleDays = 3
) =>
  body.pipe(
    Effect.scoped,
    Effect.provide(
      Settlement.layerNoDeps.pipe(
        Layer.provide(settingsWith(autoSettleDays)),
        Layer.provideMerge(ShellTestLayer)
      )
    )
  );

/** Thread 1, created now, then `days` of quiet; whether the sweep settled it. */
const settledAfterQuiet = (days: number) =>
  Effect.gen(function* () {
    const sink = yield* EventSink;
    const threads = yield* ThreadRows;
    const { projectId, command } = createProject(1);

    yield* sink.commitCommand(command);
    yield* sink.commitCommand(createThread(projectId, 1));
    yield* TestClock.adjust(Duration.days(days));

    const quiet = yield* threads.get(testThreadId(1));

    return Option.exists(quiet, (found) =>
      Option.contains(found.shell.settledOverride, "settled")
    );
  });

describe("Settlement fibers", () => {
  it.effect(
    "reads the auto-settle setting: 0 never settles, 1 settles after a day",
    () =>
      Effect.gen(function* () {
        expect(yield* run(settledAfterQuiet(10), 0)).toBeFalsy();
        expect(yield* run(settledAfterQuiet(2), 1)).toBeTruthy();
      })
  );

  it.effect("settles a quiet thread on the sweep after the window passes", () =>
    run(
      Effect.gen(function* () {
        const sink = yield* EventSink;
        const threads = yield* ThreadRows;
        const { projectId, command } = createProject(1);

        yield* sink.commitCommand(command);
        yield* sink.commitCommand(createThread(projectId, 1));
        yield* TestClock.adjust(Duration.days(2));

        const early = yield* threads.get(testThreadId(1));

        assert.isTrue(
          Option.isSome(early) &&
            Option.isNone(early.value.shell.settledOverride)
        );

        yield* TestClock.adjust(
          Duration.days(1).pipe(Duration.sum(Duration.minutes(10)))
        );

        const late = yield* threads.get(testThreadId(1));

        assert.isTrue(Option.isSome(late));

        if (Option.isSome(late)) {
          assert.deepStrictEqual(
            late.value.shell.settledOverride,
            Option.some("settled")
          );
          assert.deepStrictEqual(
            late.value.shell.settledAt,
            Option.some(at(0))
          );
        }
      })
    )
  );

  it.effect("lets a manual unsettle win over the sweep", () =>
    run(
      Effect.gen(function* () {
        const sink = yield* EventSink;
        const threads = yield* ThreadRows;
        const { projectId, command } = createProject(1);

        yield* sink.commitCommand(command);
        yield* sink.commitCommand(createThread(projectId, 1));
        yield* sink.commitCommand(
          ThreadUnsettle.make({
            commandId: testCommandId(1),
            threadId: testThreadId(1),
          })
        );
        yield* TestClock.adjust(Duration.days(4));

        const thread = yield* threads.get(testThreadId(1));

        assert.isTrue(
          Option.isSome(thread) &&
            Option.contains(thread.value.shell.settledOverride, "active")
        );
      })
    )
  );

  it.effect("ends a snooze when its time comes", () =>
    run(
      Effect.gen(function* () {
        const sink = yield* EventSink;
        const threads = yield* ThreadRows;
        const { projectId, command } = createProject(1);

        yield* sink.commitCommand(command);
        yield* sink.commitCommand(createThread(projectId, 1));
        yield* TestClock.adjust(Duration.minutes(1));
        yield* sink.commitCommand(
          ThreadSnooze.make({
            commandId: testCommandId(1),
            threadId: testThreadId(1),
            until: at(Duration.toMillis(Duration.minutes(91))),
          })
        );
        yield* TestClock.adjust(Duration.minutes(89));

        const before = yield* threads.get(testThreadId(1));

        assert.isTrue(
          Option.isSome(before) &&
            Option.isSome(before.value.shell.snoozedUntil)
        );

        yield* TestClock.adjust(Duration.minutes(2));

        const after = yield* threads.get(testThreadId(1));

        assert.isTrue(Option.isSome(after));

        if (Option.isSome(after)) {
          assert.isTrue(Option.isNone(after.value.shell.snoozedUntil));
          assert.deepStrictEqual(
            after.value.lastSnoozeWakeAt,
            Option.some(at(Duration.toMillis(Duration.minutes(91))))
          );
        }
      })
    )
  );
});
