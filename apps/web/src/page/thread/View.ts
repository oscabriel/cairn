// The thread page: the stream's status, then the transcript (apps/web/src/timeline), which scrolls
// itself. The page header (ui/ChatHeader.ts) is drawn by the root view above the hold banner.
import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { isOpen } from "../../diff/Model.ts";
import { toggleView as diffToggleView } from "../../diff/Toggle.ts";
import * as Timeline from "../../timeline/View.ts";
import { diffPanelPlaceholder, loadedDiffView } from "./DiffPanel.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { ThreadStatus } from "./Model.ts";

/** What the root passes the page: the thread's working directory, from the shell. */
export interface ViewInputs {
  readonly workspaceRoot: Option.Option<string>;
}

const statusLine = (model: Model, h: HtmlBuilder<Message>): Html =>
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
  (model, { workspaceRoot }, h) =>
    h.section(
      [
        h.DataAttribute("testid", "thread-page"),
        h.Class("flex min-h-0 flex-1 flex-col"),
      ],
      [
        statusLine(model, h),
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

/** The thread page's controls in the root's chat header: the diff panel toggle. */
export const headerControls = Submodel.defineView<Model, Message>((model, h) =>
  h.submodel({
    slotId: "diff-toggle",
    model: model.diff,
    view: diffToggleView,
    viewInputs: {
      threadId: model.threadId,
      entries: Option.match(model.view, {
        onNone: () => [],
        onSome: (state) => [...state.older, ...state.view.entries],
      }),
    },
    toParentMessage: (message) => Message.GotDiffMessage({ message }),
  })
);
