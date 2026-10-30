// Subagent rows in the transcript, in the Stone look (plan 6C; surfaces note S4): each child a
// parent spawned as one line (its status mark, its title, its state word, how long it ran), the
// children one step spawned folded behind one line ("3 subagents", "1 working · 2 done") that dims
// once none of them works, and at the top of a child's transcript the way back to its parent
// ("Subagent of <parent>"). A started child's row is a link to its thread; the way back is a link
// to the parent's. States come from client-logic's `SubagentRuntime.ts`, which reads a started
// child's own shell row through the one thread-state function.
//
// Drawn by the `next` transcript's row frame (`next/timeline/RowView.ts`) through the views this module
// registers when the `next` chunk loads (`timeline/Subagents.ts`), so the entry does not carry
// them. Every row is one line at 390 px and at least `--hit-target` tall on a coarse pointer; a
// row's preview line shows from `sm` up.
//
// It writes its class strings itself, in the `next/ui` primitives' vocabulary (`Classes.ts`,
// `Tone.ts`, `Disclosure.ts`). They are built by `timeline.css` (look track L7), with the `next`
// transcript's rows, into the `next` chunk; styles.css leaves this folder out of the entry's scan.

import type {
  SubagentRow,
  SubagentRowContext,
} from "@cairn/client-logic/SubagentRuntime";
import {
  subagentGroupSummary,
  subagentGroupTiming,
  subagentRowContextOf,
  subagentRowOf,
  summarizeSubagentStates,
} from "@cairn/client-logic/SubagentRuntime";
import { formatDuration } from "@cairn/client-logic/Time";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  Bot,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  CornerUpLeft,
  Info,
  LoaderCircle,
  TriangleAlert,
} from "lucide";

import { icon } from "../../composer/Icon.ts";
import type { IconNode } from "../../composer/Icon.ts";
import { threadRouter } from "../../Route.ts";
import type { Message } from "../../timeline/Message.ts";
import type {
  ParentLinkItem,
  SubagentShells,
  SubagentsItem,
} from "../../timeline/Subagents.ts";
import { registerSubagentRowViews } from "../../timeline/Subagents.ts";
import { classNames } from "../../ui/ClassNames.ts";
import type { StatusMark } from "../ui/Glyph.ts";
import { markOfTone } from "../ui/Glyph.ts";
import type { Tone } from "../ui/Tone.ts";
import { toneOfThreadTone } from "../ui/Tone.ts";
import { placeSubagentItems, subagentItemKeys } from "./SubagentItems.ts";

import "./timeline.css";

type H = HtmlBuilder<Message>;

/** `Classes.ts`'s type steps and medium weight, written here (see the header). */
const SMALL = "text-(length:--text-small) leading-(--text-small-leading)";

const UI = "text-(length:--text-ui) leading-(--text-ui-leading)";

const WEIGHT_MEDIUM = "font-(--weight-medium)";

/** `Tone.ts`'s inks, written here. */
const TONE_TEXT: Readonly<Record<Tone, string>> = {
  neutral: "text-ink-2",
  accent: "text-accent-text",
  working: "text-tone-working",
  waiting: "text-tone-waiting",
  failed: "text-tone-failed",
  done: "text-tone-done",
};

/** A row: one line, a touch target on a coarse pointer, an inset focus ring. */
const ROW =
  "group/subagent flex min-h-10 w-full min-w-0 items-center gap-(--space-2) rounded-(--radius-small) px-(--space-2) py-(--space-1) text-start pointer-coarse:min-h-(--hit-target) outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-stroke-focus";

const STATUS_ICON: Readonly<
  Record<StatusMark, { readonly node: IconNode; readonly name: string }>
> = {
  busy: { node: LoaderCircle, name: "loader-circle" },
  needs: { node: CircleDot, name: "circle-dot" },
  done: { node: CircleCheck, name: "circle-check" },
  failed: { node: CircleX, name: "circle-x" },
  todo: { node: CircleDashed, name: "circle-dashed" },
  idle: { node: Circle, name: "circle" },
  info: { node: Info, name: "info" },
  warning: { node: TriangleAlert, name: "triangle-alert" },
};

/** A 16 px glyph, hidden from assistive technology like `Glyph.ts`'s. */
const glyph = (h: H, node: IconNode, name: string): Html =>
  icon(h, node, name, "size-4 shrink-0");

/** A status mark: the busy spinner turns only when motion is allowed. */
const statusGlyph = (h: H, mark: StatusMark): Html =>
  h.span(
    [
      h.DataAttribute("glyph", mark),
      h.Class(
        classNames(
          "inline-flex shrink-0 items-center justify-center",
          mark === "busy" && "motion-safe:animate-spin"
        )
      ),
    ],
    [glyph(h, STATUS_ICON[mark].node, STATUS_ICON[mark].name)]
  );

const LINK_ROW = classNames(
  ROW,
  "cursor-pointer hover:bg-select-1 data-hover:bg-select-1"
);

/** How long a child ran, once it ended with a start and an end. */
const ranFor = (row: {
  readonly startedAt: Option.Option<number>;
  readonly completedAt: Option.Option<number>;
}): Option.Option<string> =>
  Option.map(Option.all([row.startedAt, row.completedAt]), ([start, end]) =>
    formatDuration(Math.max(0, end - start))
  );

const meta = (h: H, text: Option.Option<string>): Html =>
  Option.match(text, {
    onNone: () => h.empty,
    onSome: (value) =>
      h.span(
        [
          h.DataAttribute("slot", "subagent-meta"),
          h.Class(classNames("shrink-0 tabular-nums text-ink-3", SMALL)),
        ],
        [value]
      ),
  });

/** One child's line: its mark and title, its state word, how long it ran, and a link chevron. */
const memberRow = (h: H, row: SubagentRow): Html => {
  const tone: Tone = toneOfThreadTone(row.label.tone);

  const content = [
    h.span(
      [h.Class(classNames("inline-flex shrink-0", TONE_TEXT[tone]))],
      [statusGlyph(h, markOfTone(tone))]
    ),
    h.span(
      [h.Class("flex min-w-0 flex-1 flex-col")],
      [
        h.span(
          [
            h.DataAttribute("slot", "subagent-title"),
            h.Class(
              classNames("min-w-0 truncate text-ink-1", UI, WEIGHT_MEDIUM)
            ),
          ],
          [row.title]
        ),
        Option.match(row.detail, {
          onNone: () => h.empty,
          onSome: (detail) =>
            h.span(
              [
                h.DataAttribute("slot", "subagent-detail"),
                h.Class(
                  classNames("min-w-0 truncate text-ink-3 max-sm:hidden", SMALL)
                ),
              ],
              [detail]
            ),
        }),
      ]
    ),
    h.span(
      [
        h.DataAttribute("slot", "subagent-state"),
        h.Class(
          classNames(
            "shrink-0 whitespace-nowrap",
            SMALL,
            WEIGHT_MEDIUM,
            TONE_TEXT[tone]
          )
        ),
      ],
      [row.label.word]
    ),
    meta(h, ranFor(row)),
  ];

  const hooks = [
    h.DataAttribute("testid", "subagent-row"),
    h.DataAttribute("state", row.state),
    h.DataAttribute("tone", tone),
  ];

  return Option.match(row.childThreadId, {
    // No child yet (a brief waiting for Go) or never (a brief that ended): nothing to open.
    onNone: () => h.div([...hooks, h.Class(ROW)], content),
    onSome: (threadId) =>
      h.a(
        [
          ...hooks,
          h.DataAttribute("child-thread-id", threadId),
          h.Href(threadRouter({ threadId })),
          h.AriaLabel(`Open ${row.title}, ${row.label.word}`),
          h.Class(LINK_ROW),
        ],
        [
          ...content,
          h.span(
            [h.Class("inline-flex shrink-0 text-ink-3")],
            [glyph(h, ChevronRight, "chevron-right")]
          ),
        ]
      ),
  });
};

/** The rows of a group, from its links and the shell rows of its children. */
const rowsOf = (
  item: SubagentsItem,
  context: SubagentRowContext
): ReadonlyArray<SubagentRow> =>
  item.links.map((link) => subagentRowOf(link, context));

/** A group's tally tone: working while any member is live, else failed if one failed. */
const groupTone = (summary: {
  readonly active: boolean;
  readonly failed: boolean;
}): Tone => {
  if (summary.active) {
    return "working";
  }

  return summary.failed ? "failed" : "neutral";
};

/** The group's one line: how many, how they stand, and whether any still works (else it dims). */
const groupView = (
  h: H,
  item: SubagentsItem,
  shells: SubagentShells,
  toggle: Message
): Html => {
  const rows = rowsOf(
    item,
    subagentRowContextOf(shells.children, shells.requests)
  );

  const [single] = rows;

  if (rows.length === 1 && single !== undefined) {
    return h.div(
      [
        h.DataAttribute("testid", "subagent-group"),
        h.DataAttribute("count", "1"),
      ],
      [memberRow(h, single)]
    );
  }

  const summary = subagentGroupSummary(rows);

  const tone = groupTone(summary);

  const tally = h.span(
    [h.Class("flex min-w-0 items-center gap-(--space-2)")],
    [
      h.span(
        [
          h.DataAttribute("slot", "subagent-tally"),
          h.Class(
            classNames(
              "min-w-0 truncate",
              SMALL,
              summary.active || summary.failed ? TONE_TEXT[tone] : "text-ink-3"
            )
          ),
        ],
        [summarizeSubagentStates(rows.map(({ state }) => state))]
      ),
      meta(h, ranFor(subagentGroupTiming(rows))),
    ]
  );

  // Nothing in it works and it is folded: the line steps back to the quiet ink.
  const dim = !summary.active && !item.expanded;

  return h.div(
    [
      h.DataAttribute("testid", "subagent-group"),
      h.DataAttribute("count", String(rows.length)),
      h.DataAttribute("active", summary.active ? "true" : "false"),
      h.Class(classNames("flex min-w-0 flex-col", dim && "text-ink-3")),
    ],
    [
      // The disclosure's header (`Disclosure.ts`): one line that keeps its height when it opens,
      // its chevron turning in place, the tally at its end.
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("testid", "subagent-group-toggle"),
          h.AriaExpanded(item.expanded),
          h.OnClick(toggle),
          h.Class(
            classNames(
              "flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-(--space-2) rounded-(--radius-small) px-(--space-2) py-(--space-1) text-start hover:bg-select-1 hover:text-ink-1 pointer-coarse:min-h-(--hit-target) outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-stroke-focus",
              UI,
              WEIGHT_MEDIUM,
              dim ? "text-ink-3" : "text-ink-1"
            )
          ),
        ],
        [
          h.span(
            [
              h.Class(
                classNames(
                  "inline-flex shrink-0 text-ink-3",
                  item.expanded && "rotate-90"
                )
              ),
            ],
            [glyph(h, ChevronRight, "chevron-right")]
          ),
          h.span(
            [h.Class("inline-flex shrink-0 text-ink-3")],
            [glyph(h, Bot, "bot")]
          ),
          h.span([h.Class("min-w-0 flex-1 truncate")], [summary.label]),
          h.span([h.Class("ms-auto shrink-0")], [tally]),
        ]
      ),
      item.expanded
        ? h.div(
            [h.Class("min-w-0 ps-(--space-8) pe-(--space-2)")],
            rows.map((row) => memberRow(h, row))
          )
        : h.empty,
    ]
  );
};

/** The way back: "Subagent of <parent>", one line, a link to the parent's thread. */
const parentLinkView = (
  h: H,
  item: ParentLinkItem,
  shells: SubagentShells
): Html => {
  const title = Option.getOrElse(shells.parentTitle, () => "its parent thread");

  return h.a(
    [
      h.DataAttribute("testid", "subagent-parent-link"),
      h.DataAttribute("parent-thread-id", item.parentThreadId),
      h.Href(threadRouter({ threadId: item.parentThreadId })),
      h.AriaLabel(`Back to ${title}`),
      h.Class(
        classNames(
          LINK_ROW,
          "min-h-9 border border-stroke-1 bg-select-1 text-ink-2 hover:text-ink-1"
        )
      ),
    ],
    [
      h.span(
        [h.Class("inline-flex shrink-0 text-ink-3")],
        [glyph(h, CornerUpLeft, "corner-up-left")]
      ),
      h.span(
        [h.Class(classNames("shrink-0 text-ink-3", SMALL))],
        ["Subagent of"]
      ),
      h.span(
        [
          h.DataAttribute("slot", "parent-title"),
          h.Class(
            classNames("min-w-0 flex-1 truncate text-ink-1", UI, WEIGHT_MEDIUM)
          ),
        ],
        [title]
      ),
    ]
  );
};

/** The views, for a scene test to draw without registering them. */
export const subagentRowViews = {
  group: groupView,
  parentLink: parentLinkView,
  items: placeSubagentItems,
  keys: subagentItemKeys,
};

registerSubagentRowViews(subagentRowViews);
