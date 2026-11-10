// The shell's clock, visits and favicon badge (ADR 0050, from the classic sidebar's state): the
// first update reads the clock (T29) and the platform, a visit for the open thread goes to the
// outbox only while the shell is live and never while one still waits to show, and the favicon
// follows the needs-you count, the scratch thread this page holds included.

import { NOW, shellRow } from "@cairn/client-logic/ShellRowTestKit";
import { CommandId } from "@cairn/protocol/Ids";
import { ThreadVisit } from "@cairn/protocol/ShellCommands";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import { TestClock } from "effect/testing";

import { AppRoute } from "../../Route.ts";
import { ReadClock } from "./Command.ts";
import { Message, OutMessage } from "./Message.ts";
import { initial } from "./Model.ts";
import type { Model } from "./Model.ts";
import {
  PROJECT_THREAD,
  SCRATCH,
  SHELL,
  shellModelOn,
} from "./ShellFixtures.ts";
import { inform, update } from "./Update.ts";

const NOW_MS = DateTime.toEpochMillis(NOW);

describe("the shell's clock", () => {
  it("is read, with the platform, on the shell's first update", () => {
    const names = (inform(initial, initial.context).commands ?? []).map(
      (command) => command.name
    );

    expect(names).toContain("ReadClock");
    expect(names).toContain("DetectPlatform");
  });

  it.effect("starts at now, not in 1970", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_760_000_000_000);

      const ticked = yield* ReadClock().effect;

      expect(update(initial, ticked).model.nowMs).toBe(1_760_000_000_000);
    })
  );
});

/** The project thread, open, its run finished after the user's last visit. */
const completedOpen = (isLive: boolean): Model => {
  const base = shellModelOn(AppRoute.Thread({ threadId: PROJECT_THREAD }));

  return {
    ...base,
    // The thread was visited before, so only a completion after that visit asks for one.
    visits: Option.some({
      threadId: PROJECT_THREAD,
      sentAtMs: NOW_MS - 60_000,
    }),
    context: {
      ...base.context,
      isLive,
      shell: Option.some({
        ...SHELL,
        threads: SHELL.threads.map((thread) =>
          thread.id === PROJECT_THREAD
            ? {
                ...thread,
                activity: "idle" as const,
                latestRunCompletedAt: Option.some(
                  DateTime.subtract(NOW, { minutes: 1 })
                ),
                lastVisitedAt: Option.some(
                  DateTime.subtract(NOW, { minutes: 30 })
                ),
              }
            : thread
        ),
      }),
    },
  };
};

/** How many visits the shell mints over `ticks` clock ticks four seconds apart, after `after`. */
const visitsOver = (start: Model, after: number, ticks: number) => {
  let current = start;
  let minted = 0;

  for (let tick = after + 1; tick <= after + ticks; tick += 1) {
    const { model, commands } = update(
      current,
      Message.Ticked({ nowMs: NOW_MS + tick * 4000 })
    );

    current = model;
    minted += (commands ?? []).filter(
      (command) => command.name === "MintVisit"
    ).length;
  }

  return { model: current, minted };
};

describe("visits to the open thread", () => {
  it("are not sent while the shell is not live, and one is sent once it is", () => {
    const offline = visitsOver(completedOpen(false), 0, 3);

    const live = visitsOver(
      {
        ...offline.model,
        context: { ...offline.model.context, isLive: true },
      },
      3,
      3
    );

    expect([offline.minted, live.minted]).toStrictEqual([0, 1]);
  });

  it("go to the outbox through the root", () => {
    const command = ThreadVisit.make({
      commandId: CommandId.make("01890a5d-ac96-774b-bcce-b30209900001"),
      threadId: PROJECT_THREAD,
      at: NOW,
    });

    expect(
      update(completedOpen(true), Message.MintedVisit({ command })).outMessage
    ).toStrictEqual(OutMessage.RequestedDispatch({ command }));
  });
});

describe("the favicon badge", () => {
  it("counts the scratch thread this page holds once it needs the user", () => {
    const scratch = shellRow(91, {
      projectId: SCRATCH,
      latestRunCompletedAt: Option.some(NOW),
      lastVisitedAt: Option.none(),
    });

    const model = shellModelOn(AppRoute.Settings());

    const withRow: Model = {
      ...model,
      context: {
        ...model.context,
        shell: Option.some({ ...SHELL, threads: [...SHELL.threads, scratch] }),
      },
    };

    const loaded = update(
      withRow,
      Message.LoadedScratch({ threadId: Option.some(scratch.id) })
    );

    expect(loaded.model.badgeCount).toBe(withRow.badgeCount + 1);
    expect(
      (loaded.commands ?? []).filter((command) => command.name === "SetBadge")
    ).toHaveLength(1);
  });
});
