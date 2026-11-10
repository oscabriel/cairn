// The scratch overlay's thread comes from the turn, not from where the composer is now (U-16): a
// scratch launch whose ids arrive after the overlay closed is still the overlay's thread, and a
// draft's launch whose ids arrive while the overlay shows is not.

import { ThreadId } from "@cairn/protocol/Ids";
import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { Message as ComposerMessage } from "../composer/Message.ts";
import { Message } from "../Message.ts";
import type { Model } from "../Model.ts";
import { launchItem, liveModel } from "../TestFixtures.ts";
import { update } from "../Update.ts";
import { Message as ShellMessage } from "./Message.ts";

const launchedId = "01890a5d-ac96-774b-bcce-b302099a80aa";

/** The live page with the scratch overlay shown and no scratch thread yet. */
const shown = (): Model => {
  const live = liveModel(0);

  return update(
    {
      ...live,
      nextShell: {
        ...live.nextShell,
        scratch: { ...live.nextShell.scratch, isOpen: true },
      },
    },
    Message.GotNextShellMessage({ message: ShellMessage.SettledOverlay() })
  ).model;
};

const prepared = (model: Model, draftKey: string): Model =>
  update(
    model,
    Message.GotComposerMessage({
      message: ComposerMessage.PreparedTurn({
        draftKey,
        item: launchItem(launchedId),
        navigateTo: Option.none(),
        attachments: [],
      }),
    })
  ).model;

const scratchOf = (model: Model) => ({
  threadId: model.nextShell.scratch.threadId,
  fromScratch: Object.values(model.sentTurns).map((turn) => turn.fromScratch),
});

describe("the scratch overlay's launch", () => {
  it("is the overlay's thread when its ids arrive after the overlay closed", () => {
    const closed = update(
      shown(),
      Message.GotNextShellMessage({
        message: ShellMessage.ClickedCloseScratch(),
      })
    ).model;

    expect(scratchOf(prepared(closed, "scratch"))).toStrictEqual({
      threadId: Option.some(ThreadId.make(launchedId)),
      fromScratch: [true],
    });
  });

  it("is not a draft's launch whose ids arrive while the overlay shows", () => {
    expect(
      scratchOf(prepared(shown(), "draft:019a0000-0000-7000-8000-000000000b02"))
    ).toStrictEqual({ threadId: Option.none(), fromScratch: [false] });
  });
});
