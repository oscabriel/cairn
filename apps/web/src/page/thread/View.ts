// The thread page: the stream's status, then the transcript (apps/web/src/timeline), which scrolls
// itself. The page header (ui/ChatHeader.ts) is drawn by the root view above the hold banner.
import type { Entry } from "@cairn/protocol/Thread";
import { Option, Predicate } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { isOpen } from "../../diff/Model.ts";
import { toggleView as diffToggleView } from "../../diff/Toggle.ts";
import * as Timeline from "../../timeline/View.ts";
import { diffPanelPlaceholder, loadedDiffView } from "./DiffPanel.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { ThreadStatus } from "./Model.ts";

/** A launch that failed: why, from the shell row, and the draft its first message went back to. */
export interface LaunchFailure {
  readonly message: string;
  readonly retryUrl: Option.Option<string>;
}

/** What the root passes the page: the thread's working directory and a failed launch, from the shell. */
export interface ViewInputs {
  readonly workspaceRoot: Option.Option<string>;
  readonly launchFailure: Option.Option<LaunchFailure>;
}

/** Why the launch failed, in place of "does not exist", with a link to its first message. */
const launchFailureLine = (
  failure: LaunchFailure,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [
      h.DataAttribute("testid", "thread-status"),
      h.Role("status"),
      h.Class(
        "mx-auto flex w-full max-w-3xl flex-col gap-1 px-6 pt-4 text-destructive-foreground text-sm"
      ),
    ],
    [
      h.p([], [`This thread did not start. ${failure.message}`]),
      Option.match(failure.retryUrl, {
        onNone: () => h.empty,
        onSome: (url) =>
          h.a(
            [
              h.DataAttribute("testid", "thread-launch-retry"),
              h.Href(url),
              h.Class("text-foreground underline underline-offset-4"),
            ],
            ["Your first message is in a new draft. Edit it and send again."]
          ),
      }),
    ]
  );

const statusOf = (model: Model, h: HtmlBuilder<Message>): Html =>
  ThreadStatus.match(model.status, {
    Loading: () =>
      h.p(
        [
          h.DataAttribute("testid", "thread-status"),
          h.Class(
            "mx-auto w-full max-w-3xl px-6 pt-4 text-muted-foreground text-sm"
          ),
        ],
        ["Loading the thread..."]
      ),
    Ready: () => h.empty,
    Missing: () =>
      h.p(
        [
          h.DataAttribute("testid", "thread-status"),
          h.Class(
            "mx-auto w-full max-w-3xl px-6 pt-4 text-muted-foreground text-sm"
          ),
        ],
        ["This thread does not exist."]
      ),
    Failed: ({ message }) =>
      h.p(
        [
          h.DataAttribute("testid", "thread-status"),
          h.Class(
            "mx-auto w-full max-w-3xl px-6 pt-4 text-destructive-foreground text-sm"
          ),
        ],
        [message]
      ),
  });

/** The line above the transcript: a failed launch's reason, else the stream's status. */
export const statusLine = (
  model: Model,
  launchFailure: Option.Option<LaunchFailure>,
  h: HtmlBuilder<Message>
): Html =>
  Option.isSome(launchFailure) && !Predicate.isTagged(model.status, "Ready")
    ? launchFailureLine(launchFailure.value, h)
    : statusOf(model, h);

/** The diff panel while it is open: its view once the chunk has loaded, a placeholder before. */
const diffPanel = (model: Model, h: HtmlBuilder<Message>): Html =>
  isOpen(model.diff)
    ? Option.match(loadedDiffView(), {
        onNone: () => diffPanelPlaceholder(h, model.diffPanel === "failed"),
        onSome: (view) =>
          h.submodel({
            slotId: "diff",
            model: model.diff,
            view,
            toParentMessage: (message) => Message.GotDiffMessage({ message }),
          }),
      })
    : h.empty;

/** The thread page. */
export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, { launchFailure, workspaceRoot }, h) =>
    h.section(
      [
        h.DataAttribute("testid", "thread-page"),
        h.Class("flex min-h-0 flex-1 flex-col"),
      ],
      [
        statusLine(model, launchFailure, h),
        h.submodel({
          slotId: "timeline",
          model: model.timeline,
          view: Timeline.view,
          viewInputs: { state: model.view, workspaceRoot },
          toParentMessage: (message) => Message.GotTimelineMessage({ message }),
        }),
        diffPanel(model, h),
      ]
    )
);

const NO_ENTRIES: ReadonlyArray<Entry> = [];

/** The thread page's controls in the root's chat header: the diff panel toggle. */
export const headerControls = Submodel.defineView<Model, Message>((model, h) =>
  h.submodel({
    slotId: "diff-toggle",
    model: model.diff,
    view: diffToggleView,
    viewInputs: {
      threadId: model.threadId,
      older: Option.match(model.view, {
        onNone: () => NO_ENTRIES,
        onSome: (state) => state.older,
      }),
      entries: Option.match(model.view, {
        onNone: () => NO_ENTRIES,
        onSome: (state) => state.view.entries,
      }),
    },
    toParentMessage: (message) => Message.GotDiffMessage({ message }),
  })
);
