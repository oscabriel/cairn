// The `next` transcript's rows (plan look track L7, surfaces note S12), in the Stone look round 1
// drew: the user's words in a raised bubble with its time, the model's answer as plain prose, the
// work as quiet lines in the faint ink with their glyphs, and a settled turn folded behind one line
// that says how long it worked and what it did ("Worked for 3m 41s · 4 edits · 9 reads · 2
// commands"). Colour is left to status: a failed call's glyph and words take the failed tone, and
// nothing else has a hue. The rows are classic's (`timeline/RowView.ts`, a port of t3code's
// `MessagesTimeline.tsx` and `WorkLog.tsx`): the same items, Messages and hooks
// (`data-timeline-row-kind`, `data-message-role`, the test ids), so the list, the judges and the
// update read them unchanged.
//
// Every control in a row (a fold, a tool group, a call with output, copy, Retry) is at least
// `--hit-target` tall on a coarse pointer and shows the `--stroke-focus` ring on keyboard focus
// only. A row is drawn twice, in the list and in its off-screen measuring box (ADR 0041), so it
// keeps no state of its own.

import { formatDuration } from "@cairn/client-logic/Time";
import type {
  TimelineMessage,
  WorkEntry,
} from "@cairn/client-logic/TimelineEntries";
import type { TimelineRow } from "@cairn/client-logic/TimelineRows";
import { shouldCollapseUserMessage } from "@cairn/client-logic/TimelineRows";
import {
  liveThoughtLine,
  liveWorkEntryLabel,
  workEntryDisplayLabel,
  workEntryIndicatesToolFailure,
} from "@cairn/client-logic/ToolSummary";
import type { ToolGroupSummaryKind } from "@cairn/client-logic/ToolSummary";
import { Match, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  Brain,
  Check,
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

import { icon } from "../../composer/Icon.ts";
import type { IconNode } from "../../composer/Icon.ts";
import { markdownView } from "../../timeline/markdown/View.ts";
import { Message } from "../../timeline/Message.ts";
import type { HistoryState } from "../../timeline/Model.ts";
import type {
  ChangedFilesRow,
  ListItem,
  MessageItem,
} from "../../timeline/Rows.ts";
import type { RowContext } from "../../timeline/RowView.ts";
import { WorkingTimer } from "../../timeline/RowView.ts";
import { subagentRowViews } from "../../timeline/Subagents.ts";
import { formatClock, formatFull } from "../../timeline/Time.ts";
import { classNames } from "../../ui/ClassNames.ts";
import { changedFilesCard } from "../diff/Card.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_RING,
  FOCUS_RING_INSET,
  HIT_HEIGHT,
  HIT_TARGET,
  TYPE,
  WEIGHT_MEDIUM,
} from "../ui/Classes.ts";
import { statusGlyph } from "../ui/Glyph.ts";

import "./timeline.css";

/**
 * The row frame: the full-width frame inset like the chat canvas, the centred lane (classic's
 * `chat-content-lane`, so the chat width setting holds), and the row element with its hooks.
 */
const FRAME_CLASS =
  "messages-timeline-row-frame px-[calc(var(--space-3)-var(--chat-timeline-gutter,0px))] sm:px-[calc(var(--space-12)-var(--chat-timeline-gutter,0px))]";

const frame = (
  h: HtmlBuilder<Message>,
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
          h.Class("chat-content-lane overflow-x-clip"),
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

/** A line's time, in the faint ink and tabular figures; its full date on hover. */
const time = (h: HtmlBuilder<Message>, at: number, className = ""): Html =>
  h.span(
    [
      h.Title(formatFull(at)),
      h.Class(
        classNames(
          "shrink-0 whitespace-nowrap text-ink-3 tabular-nums",
          TYPE.micro,
          className
        )
      ),
    ],
    [formatClock(at)]
  );

const ICON_BUTTON_CLASS = classNames(
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-(--radius-small) text-ink-3 hover:bg-select-1 hover:text-ink-1 [&_svg]:size-3.5",
  HIT_TARGET,
  FOCUS_RING,
  FEEDBACK_MOTION
);

const copyButton = (
  h: HtmlBuilder<Message>,
  rowId: string,
  text: string,
  copied: boolean
): Html =>
  h.button(
    [
      h.Type("button"),
      h.AriaLabel(copied ? "Copied" : "Copy message"),
      h.DataAttribute("testid", "message-copy"),
      h.OnClick(Message.ClickedCopy({ rowId, text })),
      h.Class(ICON_BUTTON_CLASS),
    ],
    [copied ? icon(h, Check, "check", "") : icon(h, Copy, "copy", "")]
  );

const chip = (
  h: HtmlBuilder<Message>,
  glyph: IconNode,
  name: string,
  label: string
): Html =>
  h.span(
    [
      h.DataAttribute("testid", "user-message-chip"),
      h.Class(
        classNames(
          "inline-flex max-w-full items-center gap-(--space-1-5) rounded-(--radius-small) border border-stroke-1 bg-surface-sunken px-(--space-2) py-(--space-0-5) text-ink-2",
          TYPE.small
        )
      ),
    ],
    [
      icon(h, glyph, name, "size-3.5 shrink-0 text-ink-3"),
      h.span([h.Class("min-w-0 truncate")], [label]),
    ]
  );

const userChips = (
  h: HtmlBuilder<Message>,
  message: TimelineMessage
): ReadonlyArray<Html> => [
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

/** A screen-reader heading naming who wrote a message. */
const author = (h: HtmlBuilder<Message>, name: string): Html =>
  h.h3([h.Class("sr-only select-none")], [name]);

const TEXT_BUTTON_CLASS = classNames(
  "inline-flex cursor-pointer items-center rounded-(--radius-small) text-ink-2 hover:text-ink-1",
  TYPE.small,
  WEIGHT_MEDIUM,
  HIT_HEIGHT,
  FOCUS_RING
);

const userMessageView = (
  h: HtmlBuilder<Message>,
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
    "pb-(--space-4)",
    [
      h.div(
        [h.Class("group flex flex-col items-end gap-(--space-1)")],
        [
          h.div(
            [
              h.DataAttribute("testid", "user-message"),
              h.Class(
                "relative max-w-[85%] rounded-(--radius-large) border border-stroke-1 bg-surface-raised px-(--space-3) py-(--space-2) text-ink-1 sm:max-w-[78%]"
              ),
            ],
            [
              author(h, "You"),
              chips.length === 0
                ? h.empty
                : h.div(
                    [
                      h.Class(
                        "mb-(--space-2) flex flex-wrap gap-(--space-1-5)"
                      ),
                    ],
                    chips
                  ),
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
                        classNames(
                          "chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word] whitespace-pre-wrap text-ink-1",
                          TYPE.body,
                          collapsed
                            ? "max-h-[11rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
                            : ""
                        )
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
                      h.Class(`mt-(--space-1) ${TEXT_BUTTON_CLASS}`),
                    ],
                    [collapsed ? "Show more" : "Show less"]
                  )
                : h.empty,
            ]
          ),
          h.div(
            [
              h.Class(
                "flex items-center justify-end gap-(--space-1) pe-(--space-1)"
              ),
            ],
            [
              time(h, message.createdAt),
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
    ],
    Option.some("user")
  );
};

/** The copy button and time under an answer. */
const metaView = (
  h: HtmlBuilder<Message>,
  rowId: string,
  message: TimelineMessage,
  copy: boolean,
  context: RowContext
): Html =>
  h.div(
    [
      h.DataAttribute("testid", "assistant-meta"),
      h.Class("mt-(--space-1) flex items-center gap-(--space-1)"),
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
      message.streaming ? h.empty : time(h, message.updatedAt),
    ]
  );

const filesCard = (h: HtmlBuilder<Message>, files: ChangedFilesRow): Html =>
  changedFilesCard(h, {
    turn: files.turn,
    files: files.files,
    moreFiles: files.moreFiles,
    onOpen: (path) => Message.ClickedOpenDiff({ turn: files.turn, path }),
  });

const assistantMessageView = (
  h: HtmlBuilder<Message>,
  row: MessageItem,
  context: RowContext
): Html =>
  frame(
    h,
    "message",
    row.showAssistantMeta || Option.isSome(row.changedFiles)
      ? "pb-(--space-4)"
      : "pb-(--space-2)",
    [
      h.div(
        [h.Class("relative min-w-0 text-ink-1")],
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
                context
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

const entryGlyph = (entry: WorkEntry): readonly [IconNode, string] => {
  if (entry.kind === "reasoning") {
    return [Brain, "brain"];
  }

  if (workEntryIndicatesToolFailure(entry)) {
    return [CircleAlert, "circle-alert"];
  }

  return ACTION_ICONS[entry.action];
};

/** A work line's glyph: the faint ink, or the failed tone for a call that failed. */
const glyph = (
  h: HtmlBuilder<Message>,
  [node, name]: readonly [IconNode, string],
  failed: boolean
): Html =>
  h.span(
    [
      h.Class(
        `flex size-4 shrink-0 items-center justify-center ${failed ? "text-tone-failed" : "text-ink-3"}`
      ),
    ],
    [icon(h, node, name, "size-3.5 shrink-0")]
  );

/** One work line: the glyph, the one-line label, and what trails it. */
const workLine = (
  h: HtmlBuilder<Message>,
  mark: Html,
  label: Html,
  trailing: ReadonlyArray<Html>,
  wrap = false
): Html =>
  h.span(
    [
      h.Class(
        classNames(
          "flex min-h-6 w-full min-w-0 gap-(--space-2) text-ink-2",
          TYPE.ui,
          wrap ? "items-start" : "items-center"
        )
      ),
    ],
    [
      mark,
      h.span(
        [
          h.Class(
            `min-w-0 flex-1 text-left ${wrap ? "[overflow-wrap:anywhere]" : "truncate"}`
          ),
        ],
        [label]
      ),
      ...trailing,
    ]
  );

/** A row that opens or folds something: a work line as a control, a finger tall on a phone. */
const INTERACTIVE_CLASS = classNames(
  "flex w-full min-w-0 cursor-pointer items-center rounded-(--radius-small) px-(--space-1) hover:bg-select-1 [&:hover_*]:text-ink-1",
  HIT_HEIGHT,
  FOCUS_RING_INSET,
  FEEDBACK_MOTION
);

const STILL_CLASS =
  "flex w-full min-w-0 items-center rounded-(--radius-small) px-(--space-1)";

type WorkLogLayout = "standalone" | "group-header" | "group-content";

const WORK_LOG_PADDING: Readonly<Record<WorkLogLayout, string>> = {
  standalone: "pb-(--space-2)",
  "group-header": "pb-0",
  "group-content": "pb-(--space-1)",
};

/** Each part of a work log owns its trailing space, so a log that continues runs on unbroken. */
const workLogBlock = (
  h: HtmlBuilder<Message>,
  layout: WorkLogLayout,
  continues: boolean,
  children: ReadonlyArray<Html>
): Html =>
  h.div([h.Class(continues ? "pb-0" : WORK_LOG_PADDING[layout])], children);

const entryLabel = (
  h: HtmlBuilder<Message>,
  label: string,
  failed: boolean
): Html => h.span([h.Class(failed ? "text-tone-failed" : "")], [label]);

const disclosureChevron = (h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.Class(
        "flex size-4 shrink-0 items-center justify-center text-ink-3 transition-transform duration-(--duration-feedback) group-open/details:rotate-90"
      ),
    ],
    [icon(h, ChevronRight, "chevron-right", "size-3")]
  );

/** A fold's or a group's chevron: right while folded, down while open. */
const chevron = (h: HtmlBuilder<Message>, expanded: boolean): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.Class(
        `flex size-4 shrink-0 items-center justify-center text-ink-3 transition-transform duration-(--duration-feedback) ${expanded ? "rotate-90" : ""}`
      ),
    ],
    [icon(h, ChevronRight, "chevron-right", "size-3")]
  );

/** One work entry: a call with output opens it in place (a native `<details>`), else a line. */
const workEntryRow = (
  h: HtmlBuilder<Message>,
  entry: WorkEntry,
  context: RowContext
): Html => {
  const label = workEntryDisplayLabel(entry, context.workspaceRoot);
  const failed = workEntryIndicatesToolFailure(entry);
  const mark = glyph(h, entryGlyph(entry), failed);

  const body = Option.orElse(entry.output, () =>
    entry.kind === "reasoning" ? entry.detail : Option.none()
  );

  return Option.match(body, {
    onNone: () =>
      h.div(
        [h.Class(STILL_CLASS)],
        [
          workLine(h, mark, entryLabel(h, label, failed), [
            time(h, entry.createdAt),
          ]),
        ]
      ),
    onSome: (text) =>
      h.details(
        [h.Class("group/details w-full min-w-0")],
        [
          h.summary(
            [
              h.AriaLabel(failed ? `${label}, tool call failed` : label),
              h.Class(
                `${INTERACTIVE_CLASS} list-none [&::-webkit-details-marker]:hidden`
              ),
            ],
            [
              workLine(h, mark, entryLabel(h, label, failed), [
                time(h, entry.createdAt),
                disclosureChevron(h),
              ]),
            ]
          ),
          h.div(
            [
              h.Class(
                "ms-(--space-6) mt-(--space-1) max-h-96 cursor-auto overflow-auto rounded-(--radius-small) border border-stroke-1 bg-surface-sunken px-(--space-2) py-(--space-1-5) select-text"
              ),
            ],
            [
              h.pre(
                [
                  h.Class(
                    classNames(
                      "font-(family-name:--font-code) whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]",
                      TYPE.small
                    )
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
  h: HtmlBuilder<Message>,
  row: Extract<TimelineRow, { readonly kind: "work" }>,
  context: RowContext
): Html => {
  if (row.isExpandedToolGroup) {
    return frame(h, "work", "", [
      workLogBlock(h, "group-content", row.continuesWorkLog, [
        h.div(
          [
            h.Role("region"),
            h.AriaLabel("Tool calls"),
            h.DataAttribute("testid", "work-group-details"),
            h.Class(
              "ms-(--space-2) flex max-h-[min(18rem,50dvh)] flex-col overflow-x-hidden overflow-y-auto border-l border-stroke-2 ps-(--space-2)"
            ),
          ],
          row.groupedEntries.map((entry) => workEntryRow(h, entry, context))
        ),
      ]),
    ]);
  }

  return frame(h, "work", "", [
    workLogBlock(h, "standalone", row.continuesWorkLog, [
      h.section(
        [h.AriaLabel("Activity"), h.Class("flex flex-col")],
        row.groupedEntries.map((entry) => workEntryRow(h, entry, context))
      ),
    ]),
  ]);
};

const toggleView = (
  h: HtmlBuilder<Message>,
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
            h.Class(INTERACTIVE_CLASS),
          ],
          [
            workLine(
              h,
              glyph(h, SUMMARY_ICONS[row.summaryKind], row.hasFailure),
              h.span([], [row.summary]),
              [time(h, row.createdAt), chevron(h, row.expanded)]
            ),
          ]
        ),
      ]
    ),
  ]);

const SHINE = "live-tool-shine [--visible-animation-state:running]";

/** The live activity: one work line sized to its words, with the shine while it works. */
const liveActivity = (
  h: HtmlBuilder<Message>,
  mark: readonly [IconNode, string],
  label: string,
  shine: boolean,
  failed: boolean
): Html =>
  h.span(
    [h.Class("flex w-fit max-w-full min-w-0")],
    [
      workLine(
        h,
        glyph(h, mark, failed),
        h.span([h.Class(shine && !failed ? SHINE : "")], [label]),
        []
      ),
    ]
  );

const liveView = (
  h: HtmlBuilder<Message>,
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
              `${INTERACTIVE_CLASS} ${thought === "" ? "" : "flex-col items-start gap-(--space-1) py-(--space-1)"}`
            ),
          ],
          [
            thought === ""
              ? h.empty
              : workLine(
                  h,
                  glyph(h, [Brain, "brain"], false),
                  h.span([h.Class("line-clamp-4")], [thought]),
                  [],
                  true
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
  h: HtmlBuilder<Message>,
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
            h.div(
              [h.DataAttribute("testid", "thinking"), h.Class(STILL_CLASS)],
              [activity]
            ),
          onSome: (groupId) =>
            h.button(
              [
                h.Type("button"),
                h.AriaExpanded(row.expanded),
                h.DataAttribute("testid", "thinking"),
                h.OnClick(Message.ToggledWorkGroup({ groupId })),
                h.Class(INTERACTIVE_CLASS),
              ],
              [activity]
            ),
        }),
      ]
    ),
  ]);
};

/** The working line: the working glyph and how long the turn has run, ticking each second. */
const workingView = (
  h: HtmlBuilder<Message>,
  row: Extract<TimelineRow, { readonly kind: "working" }>
): Html =>
  frame(h, "working", "pb-(--space-1-5)", [
    h.div(
      [
        h.DataAttribute("testid", "working"),
        h.Class(
          classNames(
            "flex h-6 min-w-0 items-center gap-(--space-1-5) px-(--space-1) text-ink-2 tabular-nums",
            TYPE.small
          )
        ),
      ],
      [
        h.span(
          [h.Class("flex size-4 shrink-0 text-tone-working")],
          [statusGlyph(h, "busy", "small")]
        ),
        h.span(
          [h.Class("whitespace-nowrap")],
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
  ]);

/**
 * A settled turn's fold line: the chevron, how long it worked, then what the hidden work was (its
 * tally), and the turn's time at the end. One line: on a phone the tally truncates from the right.
 */
const foldView = (
  h: HtmlBuilder<Message>,
  row: Extract<TimelineRow, { readonly kind: "turn-fold" }>
): Html =>
  frame(h, "turn-fold", "pb-(--space-2)", [
    h.div(
      [h.Class("flex min-w-0 items-center gap-(--space-2)")],
      [
        h.button(
          [
            h.Type("button"),
            h.AriaExpanded(row.expanded),
            h.DataAttribute("testid", "turn-fold"),
            h.DataAttribute("scroll-anchor-ignore", "true"),
            h.OnClick(Message.ToggledTurnFold({ turnId: row.turnId })),
            h.Class(
              classNames(
                INTERACTIVE_CLASS,
                "min-h-7 gap-(--space-1-5) text-ink-3",
                TYPE.small
              )
            ),
          ],
          [
            chevron(h, row.expanded),
            h.span(
              [h.Class("shrink-0 whitespace-nowrap tabular-nums")],
              [row.label]
            ),
            row.tally.length === 0
              ? h.empty
              : h.span(
                  [
                    h.DataAttribute("testid", "fold-tally"),
                    h.Class("min-w-0 flex-1 truncate text-left tabular-nums"),
                  ],
                  [
                    row.tally
                      .map((part) => ` · ${String(part.count)} ${part.word}`)
                      .join(""),
                  ]
                ),
            time(h, row.createdAt, "ms-auto ps-(--space-2)"),
          ]
        ),
      ]
    ),
  ]);

const compactionView = (
  h: HtmlBuilder<Message>,
  row: Extract<TimelineRow, { readonly kind: "context-compaction" }>
): Html =>
  frame(h, "context-compaction", "pb-(--space-4)", [
    h.div(
      [
        h.Role("separator"),
        h.AriaLabel(row.label),
        h.Class(
          classNames(
            "flex w-full items-center gap-(--space-3) py-(--space-1) text-ink-3",
            TYPE.small
          )
        ),
      ],
      [
        h.span([h.Class("h-px flex-1 bg-stroke-1")]),
        h.span(
          [h.Class("flex shrink-0 items-center gap-(--space-1-5)")],
          [icon(h, Minimize2, "minimize-2", "size-3"), row.label]
        ),
        h.span([h.Class("h-px flex-1 bg-stroke-1")]),
      ]
    ),
  ]);

const RETRY_CLASS = classNames(
  "inline-flex h-7 cursor-pointer items-center gap-(--space-1-5) rounded-(--radius-small) border border-stroke-2 bg-select-1 px-(--space-2) text-ink-1 hover:bg-select-2 [&_svg]:size-3.5",
  TYPE.small,
  WEIGHT_MEDIUM,
  HIT_TARGET,
  FOCUS_RING,
  FEEDBACK_MOTION
);

/** A failed turn: a work line in the failed tone, then Retry. */
const errorView = (
  h: HtmlBuilder<Message>,
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
              h.Class("flex flex-col gap-(--space-1)"),
            ],
            [
              h.div(
                [h.Class(STILL_CLASS)],
                [
                  workLine(
                    h,
                    glyph(h, [CircleAlert, "circle-alert"], true),
                    h.span(
                      [h.Class("whitespace-pre-wrap text-tone-failed")],
                      [
                        Option.getOrElse(
                          row.entry.detail,
                          () => "The turn failed."
                        ),
                      ]
                    ),
                    [time(h, row.createdAt)],
                    true
                  ),
                ]
              ),
              Option.match(
                row.retryable ? context.retryPrompt : Option.none(),
                {
                  onNone: () => h.empty,
                  onSome: (prompt) =>
                    h.div(
                      [h.Class("ms-(--space-6) pb-(--space-1)")],
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
                            h.Class(RETRY_CLASS),
                          ],
                          [icon(h, RotateCcw, "rotate-ccw", ""), "Retry"]
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

/** The history control: a hairline with its words in the middle. */
const historyView = (h: HtmlBuilder<Message>, context: RowContext): Html =>
  h.div(
    [h.Class(FRAME_CLASS)],
    [
      h.div(
        [h.Class("chat-content-lane flex flex-col pb-(--space-2)")],
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
                classNames(
                  "flex w-full cursor-pointer items-center gap-(--space-3) rounded-(--radius-small) py-(--space-1-5) text-ink-3 hover:text-ink-1 disabled:cursor-default disabled:opacity-60",
                  TYPE.small,
                  HIT_HEIGHT,
                  FOCUS_RING
                )
              ),
            ],
            [
              h.span([h.AriaHidden(true), h.Class("h-px flex-1 bg-stroke-1")]),
              h.span([h.Class("shrink-0")], [HISTORY_LABEL[context.history]]),
              h.span([h.AriaHidden(true), h.Class("h-px flex-1 bg-stroke-1")]),
            ]
          ),
        ]
      ),
    ]
  );

/** One item of the `next` transcript. */
export const rowView = (
  h: HtmlBuilder<Message>,
  item: ListItem,
  context: RowContext
): Html =>
  Match.value(item).pipe(
    Match.discriminatorsExhaustive("kind")({
      history: () => historyView(h, context),
      message: (row) =>
        row.message.role === "user"
          ? userMessageView(h, row.id, row.message, context)
          : assistantMessageView(h, row, context),
      "assistant-meta": (row) =>
        frame(h, "assistant-meta", "pb-(--space-4)", [
          metaView(
            h,
            row.id,
            row.message,
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
      "changed-files": (row) =>
        frame(h, "changed-files", "pb-(--space-4)", [filesCard(h, row)]),
      subagents: (row) =>
        frame(h, "subagents", "pb-(--space-2)", [
          Option.match(Option.all([subagentRowViews(), context.subagents]), {
            onNone: () => h.empty,
            onSome: ([views, shells]) =>
              views.group(
                h,
                row,
                shells,
                Message.ToggledWorkGroup({ groupId: row.id })
              ),
          }),
        ]),
      "parent-link": (row) =>
        frame(h, "parent-link", "pt-(--space-1) pb-(--space-2)", [
          Option.match(Option.all([subagentRowViews(), context.subagents]), {
            onNone: () => h.empty,
            onSome: ([views, shells]) => views.parentLink(h, row, shells),
          }),
        ]),
    })
  );
