// The thread page: the thread's title, the stream's status, then the transcript (apps/web/src/
// timeline), which scrolls itself.
import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import * as Timeline from "../../timeline/View.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { ThreadStatus } from "./Model.ts";

/** What the root passes the page: the thread's title and working directory, from the shell. */
export interface ViewInputs {
  readonly title: Option.Option<string>;
  readonly workspaceRoot: Option.Option<string>;
}

const statusLine = (model: Model, h: HtmlBuilder<Message>): Html =>
  ThreadStatus.match(model.status, {
    Loading: () =>
      h.p(
        [
          h.DataAttribute("testid", "thread-status"),
          h.Class("text-muted-foreground text-sm"),
        ],
        ["Loading the thread..."]
      ),
    Ready: () => h.empty,
    Missing: () =>
      h.p(
        [
          h.DataAttribute("testid", "thread-status"),
          h.Class("text-muted-foreground text-sm"),
        ],
        ["This thread does not exist."]
      ),
    Failed: ({ message }) =>
      h.p(
        [
          h.DataAttribute("testid", "thread-status"),
          h.Class("text-destructive-foreground text-sm"),
        ],
        [message]
      ),
  });

/** The thread page. */
export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, { title, workspaceRoot }, h) =>
    h.section(
      [
        h.DataAttribute("testid", "thread-page"),
        h.Class("flex min-h-0 flex-1 flex-col"),
      ],
      [
        h.header(
          [h.Class("mx-auto w-full max-w-3xl px-6 pt-4")],
          [
            h.h1(
              [h.Class("truncate font-medium text-sm")],
              [Option.getOrElse(title, () => "Thread")]
            ),
            statusLine(model, h),
          ]
        ),
        h.submodel({
          slotId: "timeline",
          model: model.timeline,
          view: Timeline.view,
          viewInputs: { state: model.view, workspaceRoot },
          toParentMessage: (message) => Message.GotTimelineMessage({ message }),
        }),
      ]
    )
);
