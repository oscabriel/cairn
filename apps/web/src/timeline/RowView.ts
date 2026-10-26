// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/MessagesTimeline.tsx and
// WorkLog.tsx at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92 (classes and structure of the rows Cairn
// keeps). Kept: t3code's row frame (the full-width frame, the centred `chat-content-lane`, and the
// row element carrying `data-timeline-row-kind`, `data-message-role` and the bottom padding per
// kind), the user bubble (right-aligned, 80% wide, collapsed past 8 lines or 600 characters with
// "Show more", attachment chips above the text, time and copy below on hover), the assistant's
// markdown with the turn's changed-files card inside it and its copy and time on the terminal
// answer, the work log (`WorkLogBlock`, `WorkLogLine`, the icon well, the hover timestamp), the
// grouped tool calls behind a summary toggle, the live activity row with its shine, the working
// header, turn folds ("Worked for", "You stopped after"), the compaction divider and the history
// divider. Changed: Foldkit views over client-logic's rows; a call's output opens in a native
// <details>; the timer is a Mount that writes its own text once a second, so it never re-renders
// the list; a failed turn is a work-log line with Retry. Removed: subagents, plans, worktree setup,
// MCP apps, citations, forks, prompt links and the minimap.
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
import type { ToolGroupSummaryKind } from "@cairn/client-logic/ToolSummary";
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
  Minimize2,
  Paperclip,
  RotateCcw,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide";

import { icon } from "../composer/Icon.ts";
import type { IconNode } from "../composer/Icon.ts";
import { changedFilesCard } from "../diff/Card.ts";
import { buttonClass } from "../ui/Button.ts";
import { markdownView } from "./markdown/View.ts";
import { Message } from "./Message.ts";
import type { HistoryState } from "./Model.ts";
import type { ChangedFilesRow, ListItem, MessageItem } from "./Rows.ts";
import { formatClock, formatFull } from "./Time.ts";

type H = HtmlBuilder<Message>;

/** What a row's view reads besides the row. Every field is compared by the row's keyed lazy. */
export interface RowContext {
  readonly threadId: string;
  readonly workspaceRoot: Option.Option<string>;
  readonly highlightedLanguages: ReadonlyArray<string>;
  /** Changes when a long code block's tokens are ready, so the row redraws with them. */
  readonly highlightedCode: number;
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

/**
 * The row frame, carrying the chat canvas's lane inset itself: t3code pads its scroller
 * (`[data-chat-canvas] .messages-timeline-scroll`), but the virtual list writes `padding: 0` on
 * its own scroller, so each frame takes the same inset inside the scroller's gutters.
 */
const FRAME_CLASS =
  "messages-timeline-row-frame px-[calc(0.75rem-var(--chat-timeline-gutter,0px))] sm:px-[calc(3rem-var(--chat-timeline-gutter,0px))]";

/**
 * One transcript row in t3code's frame: the full-width frame, the centred chat lane, and the row
 * element carrying the row kind (and a message's role) with the row's bottom padding.
 */
const frame = (
  h: H,
  kind: string,
  className: string,
  children: ReadonlyArray<Html>,
  role: Option.Option<"user" | "assistant"> = Option.none()
): Html =>
  h.div(
    [h.Class(FRAME_CLASS)],
    [
      h.div(
        [
          h.DataAttribute("timeline-root", "true"),
          h.Class("@container/chat-lane chat-content-lane overflow-x-clip"),
        ],
        [
          h.div(
            [
              h.DataAttribute("timeline-row-kind", kind),
              ...Option.match(role, {
                onNone: () => [],
                onSome: (value) => [h.DataAttribute("message-role", value)],
              }),
              h.Class(className),
            ],
            children
          ),
        ]
      ),
    ]
  );

const TIMESTAMP_CLASS =
  "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100";

const timestamp = (
  h: H,
  at: number,
  className = "",
  alwaysVisible = false
): Html =>
  h.span(
    [
      h.Title(formatFull(at)),
      h.Class(
        `${TIMESTAMP_CLASS} ${alwaysVisible ? "pointer-events-auto static opacity-100" : ""} ${className}`
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
      h.Class(buttonClass("ghost-muted", "xs")),
    ],
    [
      copied
        ? icon(h, Check, "check", "size-3")
        : icon(h, Copy, "copy", "size-3"),
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

/** A screen-reader heading naming who wrote a message, as t3code's `MessageAuthorHeading`. */
const author = (h: H, name: string): Html =>
  h.h3([h.Class("sr-only select-none")], [name]);

const userMessageView = (
  h: H,
  rowId: string,
  message: TimelineMessage,
  context: RowContext
): Html => {
  const collapsible = shouldCollapseUserMessage(message.text);
  const collapsed = collapsible && !context.expanded;
  const chips = userChips(h, message);

  return frame(
    h,
    "message",
    "pb-4",
    [
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
              author(h, "You"),
              chips.length === 0
                ? h.empty
                : h.div([h.Class("mb-2 flex flex-wrap gap-1.5")], chips),
              h.div(
                [
                  h.DataAttribute("user-message-body", "true"),
                  h.DataAttribute(
                    "user-message-collapsed",
                    collapsed ? "true" : "false"
                  ),
                  h.Class("relative"),
                ],
                [
                  h.div(
                    [
                      h.Class(
                        `chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word] whitespace-pre-wrap text-sm leading-relaxed text-foreground ${collapsed ? "max-h-[11rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : ""}`
                      ),
                    ],
                    [message.text]
                  ),
                ]
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
                "flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100"
              ),
            ],
            [
              h.div(
                [h.Class("flex shrink-0 items-center gap-2")],
                [
                  h.p(
                    [
                      h.Title(formatFull(message.createdAt)),
                      h.Class("text-muted-foreground text-xs tabular-nums"),
                    ],
                    [formatClock(message.createdAt)]
                  ),
                  h.div(
                    [h.Class("flex items-center gap-0.5")],
                    [
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
            ]
          ),
        ]
      ),
    ],
    Option.some("user")
  );
};

/** The copy button and time under an answer: on hover inside it, always on its own meta row. */
const metaView = (
  h: H,
  rowId: string,
  message: TimelineMessage,
  copy: boolean,
  context: RowContext,
  placement: "inline" | "row"
): Html =>
  h.div(
    [
      h.DataAttribute("testid", "assistant-meta"),
      h.Class(
        `flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200 ${placement === "row" ? "mt-0.5 opacity-100" : "mt-1.5 opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100"}`
      ),
    ],
    [
      copy
        ? copyButton(
            h,
            rowId,
            message.text,
            Option.contains(context.copiedRowId, rowId)
          )
        : h.empty,
      message.streaming
        ? h.empty
        : h.p(
            [
              h.Title(formatFull(message.updatedAt)),
              h.Class("text-muted-foreground text-xs tabular-nums"),
            ],
            [formatClock(message.updatedAt)]
          ),
    ]
  );

const filesCard = (h: H, files: ChangedFilesRow): Html =>
  changedFilesCard(h, {
    turn: files.turn,
    files: files.files,
    moreFiles: files.moreFiles,
    onOpen: (path) => Message.ClickedOpenDiff({ turn: files.turn, path }),
  });

const assistantMessageView = (
  h: H,
  row: MessageItem,
  context: RowContext
): Html =>
  frame(
    h,
    "message",
    row.showAssistantMeta || Option.isSome(row.changedFiles)
      ? "pb-4 group/assistant"
      : "pb-2 group/assistant",
    [
      h.div(
        [h.Class("relative min-w-0 px-1 py-0.5")],
        [
          author(h, "Assistant"),
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
          Option.match(row.changedFiles, {
            onNone: () => h.empty,
            onSome: (files) => filesCard(h, files),
          }),
          row.showAssistantMeta
            ? metaView(
                h,
                row.id,
                row.message,
                row.showAssistantCopyButton && !row.assistantCopyStreaming,
                context,
                "inline"
              )
            : h.empty,
        ]
      ),
    ],
    Option.some("assistant")
  );

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

const SUMMARY_ICONS: Readonly<
  Record<ToolGroupSummaryKind, readonly [IconNode, string]>
> = {
  ...ACTION_ICONS,
  reasoning: [Brain, "brain"],
  "dynamic-tool": [Wrench, "wrench"],
  mixed: [Wrench, "wrench"],
};

/** A work-log icon as t3code's muted `ToolActivityIconView` draws it. */
const TOOL_ICON_CLASS =
  "block size-4 shrink-0 stroke-2 opacity-70 light:brightness-60";

const entryGlyph = (entry: WorkEntry): readonly [IconNode, string] => {
  if (entry.kind === "reasoning") {
    return [Brain, "brain"];
  }

  if (workEntryIndicatesToolFailure(entry)) {
    return [CircleAlert, "circle-alert"];
  }

  return ACTION_ICONS[entry.action];
};

const toolIcon = (
  h: H,
  [glyph, name]: readonly [IconNode, string],
  tone: string
): Html =>
  h.span(
    [h.Class(`flex size-4 items-center justify-center ${tone}`)],
    [icon(h, glyph, name, TOOL_ICON_CLASS)]
  );

/** t3code's `WorkLogLine`: the icon well, the one-line label and what trails it. */
const workLogLine = (
  h: H,
  glyph: Html,
  label: Html,
  trailing: ReadonlyArray<Html>,
  wrapLabel = false
): Html =>
  h.div(
    [
      h.Class(
        `flex min-h-6 min-w-0 gap-1.5 text-sm leading-relaxed select-none [&_*]:select-none ${wrapLabel ? "items-start" : "items-center"}`
      ),
    ],
    [
      h.div(
        [h.Class("flex min-w-0 flex-1 items-baseline gap-1.5")],
        [
          h.span(
            [h.Class("relative w-6 shrink-0 leading-0")],
            [
              h.span(
                [
                  h.Class(
                    "inline-block size-6 overflow-hidden align-[calc(0.5cap_-_0.75rem)]"
                  ),
                ],
                [
                  h.span(
                    [h.Class("flex size-full items-center justify-center")],
                    [glyph]
                  ),
                ]
              ),
            ]
          ),
          h.div(
            [
              h.Class(
                `min-w-0 flex-1 text-secondary-label ${wrapLabel ? "" : "truncate [&_*]:whitespace-nowrap"}`
              ),
            ],
            [label]
          ),
        ]
      ),
      ...trailing,
    ]
  );

const INTERACTIVE_CLASS =
  "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

/** t3code's work-log row box: tighter inside an opened group. */
const workRowClass = (grouped: boolean, interactive: boolean): string =>
  `group/timeline-row relative w-full min-w-0 rounded-md px-0.5 text-left transition-colors ${grouped ? "py-0" : "py-0.5"} ${interactive ? INTERACTIVE_CLASS : ""}`;

type WorkLogLayout = "standalone" | "group-header" | "group-content";

const WORK_LOG_PADDING: Readonly<Record<WorkLogLayout, string>> = {
  standalone: "pb-2",
  "group-header": "pb-0",
  "group-content": "pb-1",
};

/** t3code's `WorkLogBlock`: each part of a work log owns its trailing space. */
const workLogBlock = (
  h: H,
  layout: WorkLogLayout,
  continues: boolean,
  children: ReadonlyArray<Html>
): Html =>
  h.div([h.Class(continues ? "pb-0" : WORK_LOG_PADDING[layout])], children);

const entryLabel = (h: H, label: string, failed: boolean): Html =>
  h.div(
    [h.Class("min-w-0 flex-1 overflow-hidden")],
    [
      h.p(
        [
          h.Class(
            "flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed"
          ),
        ],
        [
          h.span(
            [
              h.Class(
                `min-w-0 flex-1 truncate ${failed ? "font-medium text-destructive" : "text-secondary-label"}`
              ),
            ],
            [label]
          ),
        ]
      ),
    ]
  );

const disclosureChevron = (h: H, visible: boolean): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.Class(
        `flex size-4 shrink-0 items-center justify-center ${visible ? "" : "invisible"}`
      ),
    ],
    [
      icon(
        h,
        ChevronRight,
        "chevron-right",
        "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200 group-open/details:rotate-90"
      ),
    ]
  );

/**
 * One work entry, as t3code's `WorkEntryLogRow`: a call with output opens it in place (a native
 * `<details>`, so the row needs no state), one without is a plain line.
 */
const workEntryRow = (
  h: H,
  entry: WorkEntry,
  context: RowContext,
  grouped: boolean
): Html => {
  const label = workEntryDisplayLabel(entry, context.workspaceRoot);
  const failed = workEntryIndicatesToolFailure(entry);

  const glyph = toolIcon(
    h,
    entryGlyph(entry),
    failed ? "text-destructive" : "text-icon-muted"
  );

  const body = Option.orElse(entry.output, () =>
    entry.kind === "reasoning" ? entry.detail : Option.none()
  );

  const line = (expandable: boolean) =>
    workLogLine(h, glyph, entryLabel(h, label, failed), [
      timestamp(h, entry.createdAt),
      disclosureChevron(h, expandable),
    ]);

  return Option.match(body, {
    onNone: () => h.div([h.Class(workRowClass(grouped, false))], [line(false)]),
    onSome: (text) =>
      h.details(
        [h.Class(`group/details ${workRowClass(grouped, true)}`)],
        [
          h.summary(
            [
              h.AriaLabel(failed ? `${label}, tool call failed` : label),
              h.Class(
                "list-none focus-visible:outline-none [&::-webkit-details-marker]:hidden"
              ),
            ],
            [line(true)]
          ),
          h.div(
            [
              h.Class(
                "ms-7 flex max-h-96 cursor-auto flex-col gap-3 overflow-auto px-0.5 py-1 select-text"
              ),
            ],
            [
              h.pre(
                [
                  h.Class(
                    "font-mono text-xs text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]"
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
    return frame(h, "work", "", [
      workLogBlock(h, "group-content", row.continuesWorkLog, [
        h.div(
          [h.Class("flex min-w-0 flex-col")],
          [
            h.div(
              [
                h.Role("region"),
                h.AriaLabel("Tool calls"),
                h.DataAttribute("testid", "work-group-details"),
                h.Class(
                  "scrollbar-gutter-stable max-h-[min(18rem,50dvh)] scroll-py-6 overflow-x-hidden overflow-y-auto rounded-md"
                ),
              ],
              row.groupedEntries.map((entry) =>
                workEntryRow(h, entry, context, true)
              )
            ),
          ]
        ),
      ]),
    ]);
  }

  return frame(h, "work", "", [
    workLogBlock(h, "standalone", row.continuesWorkLog, [
      h.section(
        [h.AriaLabel("Activity")],
        row.groupedEntries.map((entry) =>
          workEntryRow(h, entry, context, false)
        )
      ),
    ]),
  ]);
};

const toggleView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "work-toggle" }>
): Html =>
  frame(h, "work-toggle", "", [
    workLogBlock(
      h,
      row.expanded ? "group-header" : "standalone",
      row.continuesWorkLog,
      [
        h.button(
          [
            h.Type("button"),
            h.AriaExpanded(row.expanded),
            h.AriaLabel(
              row.hasFailure ? `${row.summary}, tool call failed` : row.summary
            ),
            h.DataAttribute("testid", "work-toggle"),
            h.OnClick(Message.ToggledWorkGroup({ groupId: row.groupId })),
            h.Class(workRowClass(false, true)),
          ],
          [
            workLogLine(
              h,
              toolIcon(
                h,
                SUMMARY_ICONS[row.summaryKind],
                row.hasFailure ? "text-destructive" : "text-icon-muted"
              ),
              h.span([h.Class("block truncate")], [row.summary]),
              [timestamp(h, row.createdAt)]
            ),
          ]
        ),
      ]
    ),
  ]);

const SHINE = "live-tool-shine [--visible-animation-state:running]";

/** t3code's `LiveActivityRow`: one work-log line sized to its text, with the shine while active. */
const liveActivity = (
  h: H,
  glyph: readonly [IconNode, string],
  label: string,
  shine: boolean,
  failed: boolean
): Html =>
  h.div(
    [
      h.Class(
        "relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed"
      ),
    ],
    [
      h.div(
        [h.Class(workRowClass(false, false))],
        [
          workLogLine(
            h,
            toolIcon(h, glyph, failed ? "text-destructive" : "text-icon-muted"),
            h.span(
              [h.Class(`block truncate ${shine && !failed ? SHINE : ""}`)],
              [label]
            ),
            []
          ),
        ]
      ),
    ]
  );

const liveView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "work-live" }>,
  context: RowContext
): Html => {
  const thought = Option.match(row.thought, {
    onNone: () => "",
    onSome: (entry) =>
      row.expanded
        ? ""
        : liveThoughtLine(Option.getOrElse(entry.detail, () => "")),
  });

  return frame(h, "work-live", "", [
    workLogBlock(
      h,
      row.expanded ? "group-header" : "standalone",
      row.continuesWorkLog,
      [
        h.button(
          [
            h.Type("button"),
            h.AriaExpanded(row.expanded),
            h.DataAttribute("testid", "work-live"),
            h.OnClick(Message.ToggledWorkGroup({ groupId: row.groupId })),
            h.Class(
              `group/live-work flex w-full max-w-full cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 ${thought === "" ? "min-h-6 items-center" : "flex-col items-start"}`
            ),
          ],
          [
            thought === ""
              ? h.empty
              : h.div(
                  [h.Class(workRowClass(false, false))],
                  [
                    workLogLine(
                      h,
                      toolIcon(h, [Brain, "brain"], "text-icon-muted"),
                      h.span([h.Class("line-clamp-4")], [thought]),
                      [],
                      true
                    ),
                  ]
                ),
            liveActivity(
              h,
              entryGlyph(row.entry),
              liveWorkEntryLabel(row.entry, context.workspaceRoot, row.active),
              row.active,
              workEntryIndicatesToolFailure(row.entry)
            ),
          ]
        ),
      ]
    ),
  ]);
};

const thinkingView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "thinking" }>
): Html => {
  const activity = liveActivity(h, [Brain, "brain"], "Thinking", true, false);

  return frame(h, "thinking", "", [
    workLogBlock(
      h,
      row.expanded ? "group-header" : "standalone",
      row.continuesWorkLog,
      [
        Option.match(row.groupId, {
          onNone: () =>
            h.div([h.DataAttribute("testid", "thinking")], [activity]),
          onSome: (groupId) =>
            h.button(
              [
                h.Type("button"),
                h.AriaExpanded(row.expanded),
                h.DataAttribute("testid", "thinking"),
                h.OnClick(Message.ToggledWorkGroup({ groupId })),
                h.Class(
                  "group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                ),
              ],
              [activity]
            ),
        }),
      ]
    ),
  ]);
};

const workingView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "working" }>
): Html =>
  frame(h, "working", "pb-1.5", [
    h.div(
      [
        h.DataAttribute("testid", "working"),
        h.Class("border-b border-border/60 pb-2 pt-1"),
      ],
      [
        h.div(
          [
            h.Class(
              "flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums"
            ),
          ],
          [
            h.span(
              [h.Class("relative shrink-0 overflow-hidden whitespace-nowrap")],
              Option.match(row.createdAt, {
                onNone: () => ["Working..."],
                onSome: (startedAt) => [
                  "Working for ",
                  h.span(
                    [h.OnMount(WorkingTimer({ startedAt }))],
                    [formatDuration(0)]
                  ),
                ],
              })
            ),
          ]
        ),
      ]
    ),
  ]);

const foldView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "turn-fold" }>
): Html =>
  frame(h, "turn-fold", "pb-1.5", [
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
            h.DataAttribute("scroll-anchor-ignore", "true"),
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
  frame(h, "context-compaction", "pb-4", [
    h.div(
      [
        h.Role("separator"),
        h.AriaLabel(row.label),
        h.Class(
          "mx-auto flex w-full max-w-(--chat-content-max-width) items-center gap-3 py-1 text-muted-foreground text-xs"
        ),
      ],
      [
        h.span([h.Class("h-px flex-1 bg-border/70")], []),
        h.span(
          [h.Class("relative shrink-0 overflow-hidden")],
          [
            h.span(
              [h.Class("flex items-center gap-1.5")],
              [icon(h, Minimize2, "minimize-2", "size-3"), row.label]
            ),
          ]
        ),
        h.span([h.Class("h-px flex-1 bg-border/70")], []),
      ]
    ),
  ]);

/** A failed turn, drawn as t3code draws a failed item: a work-log line, then Retry. */
const errorView = (
  h: H,
  row: Extract<TimelineRow, { readonly kind: "error" }>,
  context: RowContext
): Html =>
  frame(h, "work", "", [
    workLogBlock(h, "standalone", row.continuesWorkLog, [
      h.section(
        [h.AriaLabel("Activity")],
        [
          h.div(
            [
              h.DataAttribute("testid", "error-row"),
              h.Role("alert"),
              h.Class(workRowClass(false, false)),
            ],
            [
              workLogLine(
                h,
                toolIcon(h, [CircleAlert, "circle-alert"], "text-destructive"),
                h.span(
                  [
                    h.Class(
                      "whitespace-pre-wrap wrap-break-word text-sm font-medium text-destructive"
                    ),
                  ],
                  [Option.getOrElse(row.entry.detail, () => "The turn failed.")]
                ),
                [timestamp(h, row.createdAt, "", true)],
                true
              ),
              Option.match(
                row.retryable ? context.retryPrompt : Option.none(),
                {
                  onNone: () => h.empty,
                  onSome: (prompt) =>
                    h.div(
                      [h.Class("ms-7 pb-1")],
                      [
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
                            h.Class(buttonClass("outline", "xs")),
                          ],
                          [
                            icon(h, RotateCcw, "rotate-ccw", "size-3.5"),
                            "Retry",
                          ]
                        ),
                      ]
                    ),
                }
              ),
            ]
          ),
        ]
      ),
    ]),
  ]);

const HISTORY_LABEL: Readonly<Record<HistoryState, string>> = {
  idle: "Load earlier turns",
  loading: "Loading earlier turns...",
  failed: "Could not load earlier turns. Try again",
};

/** t3code's `TimelineHistoryControl`: a divider with the label in its middle. */
const historyView = (h: H, context: RowContext): Html =>
  h.div(
    [h.Class(FRAME_CLASS)],
    [
      h.div(
        [h.Class("chat-content-lane flex flex-col gap-1.5 pb-2")],
        [
          h.button(
            [
              h.Type("button"),
              h.DataAttribute("testid", "load-earlier"),
              h.AriaLabel(HISTORY_LABEL[context.history]),
              h.Disabled(
                context.history === "loading" ||
                  Option.isNone(context.historyCursor)
              ),
              ...Option.match(context.historyCursor, {
                onNone: () => [],
                onSome: (before) => [
                  h.OnClick(
                    Message.ClickedLoadEarlier({
                      threadId: context.threadId,
                      before,
                    })
                  ),
                ],
              }),
              h.Class(
                "flex w-full cursor-pointer items-center gap-3 py-1.5 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60"
              ),
            ],
            [
              h.span(
                [h.AriaHidden(true), h.Class("h-px flex-1 bg-border/70")],
                []
              ),
              h.span([h.Class("shrink-0")], [HISTORY_LABEL[context.history]]),
              h.span(
                [h.AriaHidden(true), h.Class("h-px flex-1 bg-border/70")],
                []
              ),
            ]
          ),
        ]
      ),
    ]
  );

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
        frame(h, "assistant-meta", "pb-4 group/assistant", [
          h.div(
            [h.Class("px-1")],
            [
              metaView(
                h,
                row.id,
                row.message,
                row.showAssistantCopyButton && !row.assistantCopyStreaming,
                context,
                "row"
              ),
            ]
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
      "changed-files": (row) =>
        frame(h, "changed-files", "pb-4", [filesCard(h, row)]),
    })
  );
