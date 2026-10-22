import type {
  TimelineMessage,
  WorkEntry,
} from "@cairn/client-logic/TimelineEntries";
import { formatDuration } from "@cairn/client-logic/TimelineFolds";
import type { TimelineRow } from "@cairn/client-logic/TimelineRows";
import { shouldCollapseUserMessage } from "@cairn/client-logic/TimelineRows";
import {
  liveThoughtLine,
  liveWorkEntryLabel,
  workEntryDisplayLabel,
  workEntryIndicatesToolFailure,
} from "@cairn/client-logic/ToolSummary";
// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/MessagesTimeline.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92 (classes and structure of the rows Cairn keeps). Kept:
// the user bubble (right-aligned, 80% wide, collapsed past 8 lines or 600 characters with "Show
// more", attachment chips above the text, the hover timestamp and copy below), the assistant's
// markdown with its metadata (time, duration, copy) on the terminal answer, the working header
// ("Working for <timer>"), the live activity row with its shine and thought line, the thinking row,
// grouped tool calls behind a summary toggle, single calls inline, turn folds ("Worked for",
// "You stopped after") with their timestamp, the compaction divider, and an error row with Retry.
// Changed: Foldkit views over client-logic's rows; a call's output opens in a native <details>;
// the timer is a Mount that writes its own text once a second, so it never re-renders the list.
// Removed: subagents, plans, worktree setup, MCP apps, citations, diffs and the minimap.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import type { EntryId } from "@cairn/protocol/Ids";
import {
  Clock,
  Duration,
  Effect,
  Match,
  Option,
  Schedule,
  Schema,
} from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Mount from "foldkit/mount";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Eye,
  FilePen,
  Globe,
  Paperclip,
  RotateCcw,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide";

import { icon } from "../composer/Icon.ts";
import type { IconNode } from "../composer/Icon.ts";
import { markdownView } from "./markdown/View.ts";
import { Message } from "./Message.ts";
import type { HistoryState } from "./Model.ts";
import type { ListItem } from "./Rows.ts";
import { formatClock, formatFull } from "./Time.ts";

type H = HtmlBuilder<Message>;

/** What a row's view reads besides the row. Every field is compared by the row's keyed lazy. */
export interface RowContext {
  readonly threadId: string;
  readonly workspaceRoot: Option.Option<string>;
  readonly highlightedLanguages: ReadonlyArray<string>;
  readonly copiedRowId: Option.Option<string>;
  readonly expanded: boolean;
  /** For an error row: the prompt Retry sends again. */
  readonly retryPrompt: Option.Option<TimelineMessage>;
  /** For the history control. */
  readonly history: HistoryState;
  readonly historyCursor: Option.Option<EntryId>;
}

/** Writes "<duration>" into its element once a second, from `startedAt`. */
export const WorkingTimer = Mount.define("WorkingTimer", {
  args: { startedAt: Schema.Finite },
  messages: [Message.MountedTimer],
  execute: ({ element, startedAt }) =>
    Effect.gen(function* () {
      const write = Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sync(() => {
          element.textContent = formatDuration(Math.max(0, now - startedAt));
        })
      );

      yield* Effect.forkScoped(
        Effect.repeat(write, Schedule.spaced(Duration.seconds(1)))
      );

      return Message.MountedTimer();
    }),
});

const frame = (
  h: H,
  kind: string,
  className: string,
  children: ReadonlyArray<Html>
): Html =>
  h.div(
    [
      h.DataAttribute("timeline-row-kind", kind),
      h.Class("messages-timeline-row-frame px-4 sm:px-6"),
    ],
    [h.div([h.Class(`chat-content-lane ${className}`)], children)]
  );

const timestamp = (h: H, at: number, className = ""): Html =>
  h.span(
    [
      h.Title(formatFull(at)),
      h.Class(
        `pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100 ${className}`
      ),
    ],
    [formatClock(at)]
  );

const copyButton = (h: H, rowId: string, text: string, copied: boolean): Html =>
  h.button(
    [
      h.Type("button"),
      h.AriaLabel(copied ? "Copied" : "Copy message"),
      h.DataAttribute("testid", "message-copy"),
      h.OnClick(Message.ClickedCopy({ rowId, text })),
      h.Class(
        "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      ),
    ],
    [
      copied
        ? icon(h, Check, "check", "size-3.5")
        : icon(h, Copy, "copy", "size-3.5"),
    ]
  );

const chevron = (h: H, expanded: boolean): Html =>
  expanded
    ? icon(h, ChevronDown, "chevron-down", "size-3.5")
    : icon(h, ChevronRight, "chevron-right", "size-3.5");

const chip = (h: H, glyph: IconNode, name: string, label: string): Html =>
  h.span(
    [
      h.DataAttribute("testid", "user-message-chip"),
      h.Class(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2 py-1 text-xs"
      ),
    ],
    [
      icon(h, glyph, name, "size-3.5 shrink-0 text-muted-foreground"),
      h.span([h.Class("min-w-0 truncate")], [label]),
    ]
  );

const userChips = (h: H, message: TimelineMessage): ReadonlyArray<Html> => [
  ...message.attachments.map((attachment) =>
    chip(h, Paperclip, "paperclip", attachment.name)
  ),
  ...message.attachmentNames.map((name) =>
    chip(h, Paperclip, "paperclip", name)
  ),
  ...message.images.map((image) =>
    chip(h, Paperclip, "paperclip", `Image (${image.mimeType})`)
  ),
  ...message.skills.map((skill) => chip(h, Sparkles, "sparkles", skill)),
];

const userMessageView = (
  h: H,
  rowId: string,
  message: TimelineMessage,
  context: RowContext
): Html => {
  const collapsible = shouldCollapseUserMessage(message.text);
  const collapsed = collapsible && !context.expanded;
  const chips = userChips(h, message);

  return frame(h, "user", "pb-4", [
    h.div(
      [h.Class("group flex flex-col items-end gap-1")],
      [
        h.div(
          [
            h.DataAttribute("testid", "user-message"),
            h.Class(
              "relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground"
            ),
          ],
          [
            chips.length === 0
              ? h.empty
              : h.div([h.Class("mb-2 flex flex-wrap gap-1.5")], chips),
            h.div(
              [
                h.Class(
                  `whitespace-pre-wrap wrap-break-word text-sm leading-relaxed ${collapsed ? "max-h-[11rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : ""}`
                ),
              ],
              [message.text]
            ),
            collapsible
              ? h.button(
                  [
                    h.Type("button"),
                    h.AriaExpanded(!collapsed),
                    h.OnClick(Message.ToggledUserMessage({ rowId })),
                    h.Class(
                      "mt-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                    ),
                  ],
                  [collapsed ? "Show more" : "Show less"]
                )
              : h.empty,
          ]
        ),
        h.div(
          [
            h.Class(
              "flex w-full max-w-[80%] items-center justify-end gap-2 pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100"
            ),
          ],
          [
            h.span(
              [
                h.Title(formatFull(message.createdAt)),
                h.Class("text-muted-foreground"),
              ],
              [formatClock(message.createdAt)]
            ),
            copyButton(
              h,
              rowId,
              message.text,
              Option.contains(context.copiedRowId, rowId)
            ),
          ]
        ),
      ]
    ),
  ]);
};

const metaView = (
  h: H,
  rowId: string,
  message: TimelineMessage,
  durationStart: number,
  copy: boolean,
  context: RowContext
): Html =>
  h.div(
    [
      h.DataAttribute("testid", "assistant-meta"),
      h.Class(
        "group/timeline-row mt-1 flex items-center gap-2 text-xs text-muted-foreground tabular-nums"
      ),
    ],
    [
      h.span(
        [h.Title(formatFull(message.updatedAt))],
        [formatClock(message.updatedAt)]
      ),
      message.updatedAt > durationStart
        ? h.span([], [formatDuration(message.updatedAt - durationStart)])
        : h.empty,
      copy
        ? copyButton(
            h,
            rowId,
            message.text,
            Option.contains(context.copiedRowId, rowId)
          )
        : h.empty,
    ]
  );

const assistantMessageView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "message" }>,
  context: RowContext
): Html =>
  frame(h, "assistant", "pb-4", [
    markdownView(
      {
        h,
        rowId: row.id,
        highlightedLanguages: context.highlightedLanguages,
        copiedRowId: context.copiedRowId,
      },
      row.message.text,
      row.message.streaming
    ),
    row.showAssistantMeta
      ? metaView(
          h,
          row.id,
          row.message,
          row.durationStart,
          row.showAssistantCopyButton && !row.assistantCopyStreaming,
          context
        )
      : h.empty,
  ]);

const ACTION_ICONS: Readonly<
  Record<WorkEntry["action"], readonly [IconNode, string]>
> = {
  read: [Eye, "eye"],
  edit: [FilePen, "file-pen"],
  command: [SquareTerminal, "square-terminal"],
  "code-search": [Search, "search"],
  search: [Globe, "globe"],
  other: [Wrench, "wrench"],
};

const entryIcon = (h: H, entry: WorkEntry): Html => {
  if (entry.kind === "reasoning") {
    return icon(h, Brain, "brain", "size-3.5 shrink-0");
  }

  if (workEntryIndicatesToolFailure(entry)) {
    return icon(
      h,
      CircleAlert,
      "circle-alert",
      "size-3.5 shrink-0 text-destructive-foreground"
    );
  }

  const [glyph, name] = ACTION_ICONS[entry.action];

  return icon(h, glyph, name, "size-3.5 shrink-0");
};

const workLine = (
  h: H,
  entry: WorkEntry,
  label: string,
  className = ""
): Html =>
  h.span(
    [h.Class(`flex min-w-0 items-center gap-2 ${className}`)],
    [entryIcon(h, entry), h.span([h.Class("min-w-0 truncate")], [label])]
  );

const workEntryDetails = (
  h: H,
  entry: WorkEntry,
  context: RowContext
): Html => {
  const label = workEntryDisplayLabel(entry, context.workspaceRoot);
  const failed = workEntryIndicatesToolFailure(entry);

  const body = Option.orElse(entry.output, () =>
    entry.kind === "reasoning" ? entry.detail : Option.none()
  );

  return Option.match(body, {
    onNone: () =>
      h.li(
        [h.Class("py-0.5")],
        [workLine(h, entry, label, failed ? "text-destructive-foreground" : "")]
      ),
    onSome: (text) =>
      h.li(
        [h.Class("py-0.5")],
        [
          h.details(
            [h.Class("group/details")],
            [
              h.summary(
                [
                  h.Class(
                    "cursor-pointer list-none [&::-webkit-details-marker]:hidden"
                  ),
                ],
                [
                  workLine(
                    h,
                    entry,
                    label,
                    failed ? "text-destructive-foreground" : ""
                  ),
                ]
              ),
              h.pre(
                [
                  h.Class(
                    "mt-1 max-h-60 overflow-auto rounded-md border border-border/60 bg-background/60 p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
                  ),
                ],
                [text]
              ),
            ]
          ),
        ]
      ),
  });
};

const workRowView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "work" }>,
  context: RowContext
): Html => {
  if (row.isExpandedToolGroup) {
    return frame(h, "work-details", "pb-1", [
      h.ul(
        [
          h.DataAttribute("testid", "work-group-details"),
          h.Class(
            "ms-1 border-s border-border/60 ps-3 text-sm text-muted-foreground"
          ),
        ],
        row.groupedEntries.map((entry) => workEntryDetails(h, entry, context))
      ),
    ]);
  }

  const [entry] = row.groupedEntries;

  return frame(h, "work", "pb-1", [
    h.div(
      [
        h.Class(
          "group/timeline-row relative flex min-h-6 items-center gap-2 text-sm text-muted-foreground"
        ),
      ],
      [
        entry === undefined
          ? h.empty
          : h.ul(
              [h.Class("min-w-0 flex-1")],
              [workEntryDetails(h, { ...entry }, context)]
            ),
        timestamp(h, row.createdAt, "ms-auto"),
      ]
    ),
  ]);
};

const toggleView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "work-toggle" }>
): Html =>
  frame(h, "work-toggle", "pb-1", [
    h.div(
      [h.Class("group/timeline-row relative flex min-h-6 items-center gap-1")],
      [
        h.button(
          [
            h.Type("button"),
            h.AriaExpanded(row.expanded),
            h.DataAttribute("testid", "work-toggle"),
            h.OnClick(Message.ToggledWorkGroup({ groupId: row.groupId })),
            h.Class(
              `flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 ${row.hasFailure ? "text-destructive-foreground" : "text-muted-foreground"}`
            ),
          ],
          [h.span([], [row.summary]), chevron(h, row.expanded)]
        ),
        timestamp(h, row.createdAt, "ms-auto"),
      ]
    ),
  ]);

const SHINE = "live-tool-shine [--visible-animation-state:running]";

const liveView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "work-live" }>,
  context: RowContext
): Html =>
  frame(h, "work-live", "pb-1", [
    h.button(
      [
        h.Type("button"),
        h.AriaExpanded(row.expanded),
        h.DataAttribute("testid", "work-live"),
        h.OnClick(Message.ToggledWorkGroup({ groupId: row.groupId })),
        h.Class(
          "group/live-work flex min-h-6 w-full max-w-full cursor-pointer flex-col items-start rounded-md text-left text-sm leading-relaxed text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        ),
      ],
      [
        workLine(
          h,
          row.entry,
          liveWorkEntryLabel(row.entry, context.workspaceRoot, row.active),
          row.active ? SHINE : ""
        ),
        Option.match(row.thought, {
          onNone: () => h.empty,
          onSome: (thought) =>
            h.span(
              [
                h.Class(
                  "ms-5.5 min-w-0 truncate text-xs text-muted-foreground/80"
                ),
              ],
              [liveThoughtLine(Option.getOrElse(thought.detail, () => ""))]
            ),
        }),
      ]
    ),
  ]);

const thinkingView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "thinking" }>
): Html =>
  frame(h, "thinking", "pb-1", [
    Option.match(row.groupId, {
      onNone: () =>
        h.div(
          [
            h.DataAttribute("testid", "thinking"),
            h.Class(
              "flex min-h-6 items-center gap-2 text-sm text-muted-foreground"
            ),
          ],
          [
            icon(h, Brain, "brain", "size-3.5 shrink-0"),
            h.span([h.Class(SHINE)], ["Thinking"]),
          ]
        ),
      onSome: (groupId) =>
        h.button(
          [
            h.Type("button"),
            h.AriaExpanded(row.expanded),
            h.DataAttribute("testid", "thinking"),
            h.OnClick(Message.ToggledWorkGroup({ groupId })),
            h.Class(
              "flex min-h-6 items-center gap-2 text-sm text-muted-foreground"
            ),
          ],
          [
            icon(h, Brain, "brain", "size-3.5 shrink-0"),
            h.span([h.Class(SHINE)], ["Thinking"]),
            chevron(h, row.expanded),
          ]
        ),
    }),
  ]);

const workingView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "working" }>
): Html =>
  frame(h, "working", "pb-2", [
    h.div(
      [
        h.DataAttribute("testid", "working"),
        h.Class("border-b border-border/60 pb-2 pt-1"),
      ],
      [
        h.div(
          [
            h.Class(
              "flex h-6 min-w-0 items-baseline gap-1 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums"
            ),
          ],
          Option.match(row.createdAt, {
            onNone: () => [h.span([], ["Working..."])],
            onSome: (startedAt) => [
              h.span([], ["Working for"]),
              h.span(
                [h.OnMount(WorkingTimer({ startedAt }))],
                [formatDuration(0)]
              ),
            ],
          })
        ),
      ]
    ),
  ]);

const foldView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "turn-fold" }>
): Html =>
  frame(h, "turn-fold", "pb-2", [
    h.div(
      [
        h.Class(
          "group/timeline-row relative flex items-center gap-1 border-b border-border/60 pb-2 pe-0.5 pt-1"
        ),
      ],
      [
        h.button(
          [
            h.Type("button"),
            h.AriaExpanded(row.expanded),
            h.DataAttribute("testid", "turn-fold"),
            h.OnClick(Message.ToggledTurnFold({ turnId: row.turnId })),
            h.Class(
              "flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            ),
          ],
          [h.span([], [row.label]), chevron(h, row.expanded)]
        ),
        timestamp(h, row.createdAt, "ms-auto"),
      ]
    ),
  ]);

const compactionView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "context-compaction" }>
): Html =>
  frame(h, "context-compaction", "pb-2", [
    h.div(
      [
        h.Class(
          "mx-auto flex w-full items-center gap-3 py-1 text-muted-foreground text-xs"
        ),
      ],
      [
        h.span([h.Class("h-px flex-1 bg-border/70")], []),
        h.span([], [row.label]),
        h.span([h.Class("h-px flex-1 bg-border/70")], []),
      ]
    ),
  ]);

const errorView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "error" }>,
  context: RowContext
): Html =>
  frame(h, "error", "pb-3", [
    h.div(
      [
        h.DataAttribute("testid", "error-row"),
        h.Role("alert"),
        h.Class(
          "flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground"
        ),
      ],
      [
        icon(h, CircleAlert, "circle-alert", "mt-0.5 size-4 shrink-0"),
        h.p(
          [h.Class("min-w-0 flex-1 whitespace-pre-wrap wrap-break-word")],
          [Option.getOrElse(row.entry.detail, () => "The turn failed.")]
        ),
        Option.match(row.retryable ? context.retryPrompt : Option.none(), {
          onNone: () => h.empty,
          onSome: (prompt) =>
            h.button(
              [
                h.Type("button"),
                h.DataAttribute("testid", "retry"),
                h.OnClick(
                  Message.ClickedRetry({
                    threadId: context.threadId,
                    text: prompt.text,
                    attachments: prompt.attachments.map(
                      (attachment) => attachment.id
                    ),
                    skillRefs: prompt.skills,
                  })
                ),
                h.Class(
                  "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium hover:bg-destructive/10"
                ),
              ],
              [icon(h, RotateCcw, "rotate-ccw", "size-3.5"), "Retry"]
            ),
        }),
      ]
    ),
  ]);

const HISTORY_LABEL: Readonly<Record<HistoryState, string>> = {
  idle: "Load earlier turns",
  loading: "Loading earlier turns...",
  failed: "Could not load earlier turns. Try again",
};

const historyView = (h: H, context: RowContext): Html =>
  frame(h, "history", "flex justify-center pb-3 pt-1", [
    h.button(
      [
        h.Type("button"),
        h.DataAttribute("testid", "load-earlier"),
        h.Disabled(
          context.history === "loading" || Option.isNone(context.historyCursor)
        ),
        ...Option.match(context.historyCursor, {
          onNone: () => [],
          onSome: (before) => [
            h.OnClick(
              Message.ClickedLoadEarlier({ threadId: context.threadId, before })
            ),
          ],
        }),
        h.Class(
          "rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
        ),
      ],
      [HISTORY_LABEL[context.history]]
    ),
  ]);

/** One item of the transcript. */
export const rowView = (h: H, item: ListItem, context: RowContext): Html =>
  Match.value(item).pipe(
    Match.discriminatorsExhaustive("kind")({
      history: () => historyView(h, context),
      message: (row) =>
        row.message.role === "user"
          ? userMessageView(h, row.id, row.message, context)
          : assistantMessageView(h, row, context),
      "assistant-meta": (row) =>
        frame(h, "assistant-meta", "pb-4", [
          metaView(
            h,
            row.id,
            row.message,
            row.message.createdAt,
            row.showAssistantCopyButton && !row.assistantCopyStreaming,
            context
          ),
        ]),
      work: (row) => workRowView(h, row, context),
      "work-toggle": (row) => toggleView(h, row),
      "work-live": (row) => liveView(h, row, context),
      thinking: (row) => thinkingView(h, row),
      working: (row) => workingView(h, row),
      "turn-fold": (row) => foldView(h, row),
      "context-compaction": (row) => compactionView(h, row),
      error: (row) => errorView(h, row, context),
    })
  );
