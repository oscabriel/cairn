// The skeleton's thread page: the thread's title, then every projected entry as plain text. The
// transcript (rows, folds, markdown) replaces the body; the data path stays.
import { threadEntries } from "@cairn/client-logic/ThreadView";
import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { entryLines } from "./EntryText.ts";
import type { EntryLine } from "./EntryText.ts";
import type { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { ThreadStatus } from "./Model.ts";

/** What the root passes the page: the thread's title from the shell, when it has the row. */
export interface ViewInputs {
  readonly title: Option.Option<string>;
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

const lineView = (line: EntryLine, h: HtmlBuilder<Message>): Html =>
  h.p(
    [
      h.DataAttribute("role", line.role),
      h.Class("whitespace-pre-wrap wrap-break-word text-sm"),
    ],
    [
      h.span(
        [h.Class("font-medium text-muted-foreground")],
        [`${line.role}: `]
      ),
      line.text,
    ]
  );

const entriesView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.view, {
    onNone: () => h.empty,
    onSome: (state) =>
      h.ol(
        [
          h.DataAttribute("testid", "thread-entries"),
          h.Class("flex flex-col gap-3"),
        ],
        threadEntries(state).map((entry) =>
          h.li(
            [
              h.Key(String(entry.id)),
              h.DataAttribute("entry-id", String(entry.id)),
              h.DataAttribute("kind", entry.kind),
              h.Class("flex flex-col gap-1"),
            ],
            entryLines(entry).map((line) => lineView(line, h))
          )
        )
      ),
  });

/** The thread page. */
export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, { title }, h) =>
    h.section(
      [
        h.DataAttribute("testid", "thread-page"),
        h.Class("mx-auto flex w-full max-w-3xl flex-col gap-4 p-6"),
      ],
      [
        h.h1(
          [h.Class("font-medium text-lg")],
          [Option.getOrElse(title, () => "Thread")]
        ),
        statusLine(model, h),
        entriesView(model, h),
      ]
    )
);
