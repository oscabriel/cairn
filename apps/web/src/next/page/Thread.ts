// The `next` thread page (plan look track L7): the stream's status line, then the `next`
// transcript, then the diff panel while it is open, over classic's thread page Submodel
// (`page/thread/`, its Model, Messages and update unchanged). L6's layout draws the chat header
// and the hold banner above it and the composer lane below; its header controls (the diff toggle)
// come from `headerControls` here.

import type { Entry } from "@cairn/protocol/Thread";
import { Option, Predicate } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { isOpen } from "../../diff/Model.ts";
import {
  diffPanelPlaceholder,
  loadedDiffView,
} from "../../page/thread/DiffPanel.ts";
import type { LaunchFailure, ViewInputs } from "../../page/thread/Inputs.ts";
import { Message } from "../../page/thread/Message.ts";
import type { Model } from "../../page/thread/Model.ts";
import { ThreadStatus } from "../../page/thread/Model.ts";
import { classNames } from "../../ui/ClassNames.ts";
import { toggleView } from "../diff/Toggle.ts";
import { view as timelineView } from "../timeline/View.ts";
import { FOCUS_RING, TYPE } from "../ui/Classes.ts";

const STATUS_CLASS = classNames(
  "mx-auto w-full max-w-(--chat-content-max-width) px-(--space-6) pt-(--space-4)",
  TYPE.ui
);

/** Why the launch failed, in place of "does not exist", with a link to its first message. */
const launchFailureLine = (
  failure: LaunchFailure,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [
      h.DataAttribute("testid", "thread-status"),
      h.Role("status"),
      h.Class(`${STATUS_CLASS} flex flex-col gap-(--space-1) text-ink-1`),
    ],
    [
      h.p(
        [h.Class("flex items-start gap-(--space-1-5)")],
        [
          h.span([h.Class("text-tone-failed")], ["✕"]),
          `This thread did not start. ${failure.message}`,
        ]
      ),
      Option.match(failure.retryUrl, {
        onNone: () => h.empty,
        onSome: (url) =>
          h.a(
            [
              h.DataAttribute("testid", "thread-launch-retry"),
              h.Href(url),
              h.Class(
                `rounded-(--radius-small) text-accent-text underline underline-offset-4 ${FOCUS_RING}`
              ),
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
          h.Class(`${STATUS_CLASS} text-ink-2`),
        ],
        ["Loading the thread..."]
      ),
    Ready: () => h.empty,
    Missing: () =>
      h.p(
        [
          h.DataAttribute("testid", "thread-status"),
          h.Class(`${STATUS_CLASS} text-ink-2`),
        ],
        ["This thread does not exist."]
      ),
    Failed: ({ message }) =>
      h.p(
        [
          h.DataAttribute("testid", "thread-status"),
          h.Class(`${STATUS_CLASS} text-ink-1`),
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

/** The diff panel while it is open: its view once its chunk has loaded, a placeholder before. */
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

/** The `next` thread page. */
export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, { launchFailure, workspaceRoot, subagents }, h) =>
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
          view: timelineView,
          viewInputs: { state: model.view, workspaceRoot, subagents },
          toParentMessage: (message) => Message.GotTimelineMessage({ message }),
        }),
        diffPanel(model, h),
      ]
    )
);

const NO_ENTRIES: ReadonlyArray<Entry> = [];

/** The thread page's controls in the `next` chat header: the diff toggle. */
export const headerControls = Submodel.defineView<Model, Message>((model, h) =>
  h.submodel({
    slotId: "diff-toggle",
    model: model.diff,
    view: toggleView,
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
