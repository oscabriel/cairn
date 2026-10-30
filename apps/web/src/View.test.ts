// The app frame's lazy boundaries: a recorded stream replayed through the root update, rendering the
// root view after every item the way the runtime does, with Foldkit's lazy resolutions observed.
// The docked composer must reuse its cached view for every streamed item, and the thread page its
// own for every keystroke.

import { readFileSync } from "node:fs";
import path from "node:path";

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import {
  BARE_ROW_FIELDS,
  ProjectShell,
  ThreadShell,
} from "@cairn/protocol/Shell";
import { ThreadStreamItem } from "@cairn/protocol/Thread";
import { Context, DateTime, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

// Foldkit's own lazy test harness renders this way; neither is in its public entrypoints.
import {
  __clearRuntime,
  __htmlBuilder,
  __setRuntime,
} from "../node_modules/foldkit/dist/html/index.js";
import { observeLazyResolutions } from "../node_modules/foldkit/dist/html/lazy.js";
import type { LazyResolution } from "../node_modules/foldkit/dist/html/lazy.js";
import { Message as ComposerMessage } from "./composer/Message.ts";
import { Popover } from "./composer/Model.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import * as Thread from "./page/thread/index.ts";
import { AppRoute } from "./Route.ts";
import { emptySnapshot, liveModel } from "./TestFixtures.ts";
import { update } from "./Update.ts";
import { view } from "./View.ts";

const FRAMES = path.join(
  import.meta.dirname,
  "../../../judges/fixtures/transcripts/streaming-tools.frames.json"
);

const decodeFrames = Schema.decodeUnknownSync(
  Schema.Array(Schema.toCodecJson(ThreadStreamItem))
);

const frames = decodeFrames(JSON.parse(readFileSync(FRAMES, "utf-8")));

const threadId = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0001");

const projectId = ProjectId.make("prj_cairn");

const created = DateTime.makeUnsafe("2026-10-22T11:00:00Z");

const project = ProjectShell.make({
  id: projectId,
  title: "cairn",
  kind: "folder",
  workspaceRoot: "/home/owner/Developer/projects/cairn",
  repository: Option.none(),
  defaultModel: Option.none(),
  projectThreadId: Option.none(),
  createdAt: created,
  updatedAt: created,
});

const row = ThreadShell.make({
  id: threadId,
  projectId,
  title: "Run ls, then read the README",
  provider: "opencode-go",
  modelId: "claude-haiku-5-5",
  thinkingLevel: "medium",
  runtimeMode: "full-access",
  branch: Option.none(),
  worktreePath: Option.none(),
  activity: "running",
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
  latestUserMessageAt: Option.some(created),
  createdAt: created,
  updatedAt: created,
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

/** The thread's page, opened with the shell current and its stream subscribed. */
const opened = update(
  {
    ...liveModel(2),
    route: AppRoute.Thread({ threadId }),
    shell: Option.some({
      ...emptySnapshot,
      projects: [project],
      threads: [row],
    }),
  },
  Message.CompletedNavigateInternal()
).model;

const receive = (model: Model, item: ThreadStreamItem): Model =>
  update(
    model,
    Message.GotThreadMessage({
      message: Thread.Message.ReceivedThreadItem({
        epoch: model.connection.epoch,
        watch: model.thread.watch,
        item,
      }),
    })
  ).model;

const dispatch = () => {
  // The renders are inspected, not clicked.
};

/** Renders the root view once, as the runtime does, reporting each lazy lookup to `observe`. */
const render = (
  model: Model,
  observe: (resolution: LazyResolution) => void
): void => {
  observeLazyResolutions(observe, () => {
    __setRuntime(dispatch, Context.empty());

    try {
      view(model, __htmlBuilder());
    } finally {
      __clearRuntime();
    }
  });
};

const composer = (model: Model, message: ComposerMessage): Model =>
  update(model, Message.GotComposerMessage({ message })).model;

describe("the app frame", () => {
  it("does not draw the composer again for a streamed thread item", () => {
    const [snapshot, ...items] = frames;

    if (snapshot === undefined) {
      throw new Error("The recorded stream has no snapshot.");
    }

    let model = receive(opened, snapshot);

    // The first render fills the caches. On the thread page the unkeyed lazy views are the thread
    // page and the docked composer, in that order; the transcript's rows are keyed.
    const unkeyed: Array<object> = [];

    render(model, (resolution) => {
      if (resolution.key === undefined && !unkeyed.includes(resolution.slot)) {
        unkeyed.push(resolution.slot);
      }
    });

    const [pageSlot, composerSlot] = unkeyed;

    const calls = { page: 0, composer: 0 };

    for (const item of items) {
      const next = receive(model, item);

      expect(next).not.toBe(model);

      model = next;

      render(model, (resolution) => {
        if (resolution.missReason === undefined) {
          return;
        }

        if (resolution.slot === pageSlot) {
          calls.page += 1;
        } else if (resolution.slot === composerSlot) {
          calls.composer += 1;
        }
      });
    }

    // The thread page redraws for each of the 10 items, which proves the renders saw them.
    expect({
      seq: Option.map(model.thread.view, (state) => state.seq),
      slots: unkeyed.length,
      page: calls.page,
      composer: calls.composer,
    }).toStrictEqual({
      seq: Option.some(10),
      slots: 2,
      page: 10,
      composer: 0,
    });
  });

  it("does not draw the thread page again for a keystroke in the composer", () => {
    const [snapshot] = frames;

    if (snapshot === undefined) {
      throw new Error("The recorded stream has no snapshot.");
    }

    let model = receive(opened, snapshot);

    const unkeyed: Array<object> = [];

    render(model, (resolution) => {
      if (resolution.key === undefined && !unkeyed.includes(resolution.slot)) {
        unkeyed.push(resolution.slot);
      }
    });

    const pageSlot = unkeyed.at(0);
    const composerSlot = unkeyed.at(1);
    const calls = { page: 0, composer: 0 };

    for (const value of ["h", "he", "hel", "hell", "hello"]) {
      model = composer(model, ComposerMessage.ChangedDraft({ value }));

      render(model, (resolution) => {
        if (resolution.missReason === undefined) {
          return;
        }

        if (resolution.slot === pageSlot) {
          calls.page += 1;
        } else if (resolution.slot === composerSlot) {
          calls.composer += 1;
        }
      });
    }

    // The composer redraws for each key, which proves the renders saw them; the transcript does not.
    expect(calls).toStrictEqual({ page: 0, composer: 5 });
  });

  it("keeps the same Model, so nothing renders, while the pointer stays on a picker row", () => {
    const picker = composer(
      opened,
      ComposerMessage.OpenedPopover({
        popover: Popover.ModelPicker({ query: "", highlighted: Option.none() }),
      })
    );

    const highlighted = composer(
      picker,
      ComposerMessage.MovedPopoverHighlight({ id: "opencode-go/small" })
    );

    const moved = composer(
      highlighted,
      ComposerMessage.MovedPopoverHighlight({ id: "opencode-go/small" })
    );

    expect(moved).toBe(highlighted);
  });
});
