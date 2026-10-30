// The `next` changed-files card under a turn (plan look track L7): classic's card
// (`diff/Card.ts`, a port of t3code's `ChangedFilesCard`) in the Stone look: a sunken box with a
// hairline, the count of changed files and their summed lines in the header with "Open diff",
// and the files as a tree, each a row that opens the diff at it. The line counts are grey, the
// faint ink, with "+" and "−" saying which is which: the look keeps colour for status icons only.

import {
  buildTurnDiffTree,
  summarizeTurnDiffStats,
} from "@cairn/client-logic/DiffTree";
import type { DiffStat, DiffTreeNode } from "@cairn/client-logic/DiffTree";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { File, FileDiff, FolderOpen } from "lucide";

import { icon } from "../../composer/Icon.ts";
import type { ChangedFilesCardInput } from "../../diff/Card.ts";
import { classNames } from "../../ui/ClassNames.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_RING,
  FOCUS_RING_INSET,
  HIT_HEIGHT,
  HIT_TARGET,
  TYPE,
  WEIGHT_MEDIUM,
} from "../ui/Classes.ts";

/** True when a stat has something to show. */
const hasNonZeroStat = (stat: DiffStat): boolean =>
  stat.additions > 0 || stat.deletions > 0;

/** `1234` as `1.2k`, as classic's card (and t3code) shows large counts. */
const formatCompactCount = (value: number): string => {
  const scaled = (divisor: number, suffix: string) => {
    const amount = value / divisor;

    return `${amount < 10 ? amount.toFixed(1).replace(/\.0$/u, "") : String(Math.round(amount))}${suffix}`;
  };

  if (value < 1000) {
    return String(value);
  }

  return value < 1_000_000 ? scaled(1000, "k") : scaled(1_000_000, "m");
};

/** `+3 −1` in the faint ink, with one label for screen readers. */
export const diffStatLabel = <Message>(
  h: HtmlBuilder<Message>,
  stat: DiffStat,
  className = ""
): Html =>
  h.span(
    [
      h.Role("group"),
      h.AriaLabel(
        `${String(stat.additions)} additions, ${String(stat.deletions)} deletions`
      ),
      h.Class(
        classNames(
          "inline-flex shrink-0 items-center gap-(--space-1-5) font-(family-name:--font-code) text-ink-3 tabular-nums",
          TYPE.small,
          className
        )
      ),
    ],
    [
      h.span([h.AriaHidden(true)], [`+${formatCompactCount(stat.additions)}`]),
      h.span([h.AriaHidden(true)], [`−${formatCompactCount(stat.deletions)}`]),
    ]
  );

interface FlatRow {
  readonly node: DiffTreeNode;
  readonly depth: number;
}

const flatten = (
  nodes: ReadonlyArray<DiffTreeNode>,
  depth: number
): ReadonlyArray<FlatRow> =>
  nodes.flatMap((node) =>
    node.kind === "directory"
      ? [{ node, depth }, ...flatten(node.children, depth + 1)]
      : [{ node, depth }]
  );

const ROW_CLASS = classNames(
  "flex min-h-7 w-full min-w-0 items-center gap-(--space-2) rounded-(--radius-small) pe-(--space-2) text-left",
  TYPE.small
);

const statCell = <Message>(h: HtmlBuilder<Message>, stat: DiffStat): Html =>
  hasNonZeroStat(stat) ? diffStatLabel(h, stat, "ms-auto") : h.empty;

const treeRow = <Message>(
  h: HtmlBuilder<Message>,
  row: FlatRow,
  hasDirectories: boolean,
  onOpen: ChangedFilesCardInput<Message>["onOpen"]
): Html => {
  const padding = { paddingLeft: `${String(8 + row.depth * 14)}px` };

  if (row.node.kind === "directory") {
    return h.div(
      [
        h.DataAttribute("changed-files-directory", row.node.path),
        h.Class(`${ROW_CLASS} text-ink-3`),
        h.Style(padding),
      ],
      [
        icon(h, FolderOpen, "folder-open", "size-3.5 shrink-0"),
        h.span(
          [h.Class("truncate font-(family-name:--font-code)")],
          [row.node.name]
        ),
        statCell(h, row.node.stat),
      ]
    );
  }

  const { path } = row.node;

  return h.button(
    [
      h.Type("button"),
      h.DataAttribute("changed-files-file", path),
      h.Class(
        classNames(
          ROW_CLASS,
          "cursor-pointer text-ink-2 hover:bg-select-1 hover:text-ink-1",
          HIT_HEIGHT,
          FOCUS_RING_INSET,
          FEEDBACK_MOTION
        )
      ),
      h.Style(padding),
      h.AriaLabel(`Open the diff of ${path}`),
      h.OnClick(onOpen(Option.some(path))),
    ],
    [
      hasDirectories || row.depth > 0
        ? h.span([h.AriaHidden(true), h.Class("size-3.5 shrink-0")])
        : h.empty,
      icon(h, File, "file", "size-3.5 shrink-0 text-ink-3"),
      h.span(
        [h.Class("min-w-0 truncate font-(family-name:--font-code)")],
        [row.node.name]
      ),
      statCell(h, row.node.stat),
    ]
  );
};

const OPEN_CLASS = classNames(
  "inline-flex h-7 cursor-pointer items-center gap-(--space-1-5) rounded-(--radius-small) px-(--space-2) text-ink-2 hover:bg-select-2 hover:text-ink-1 [&_svg]:size-3.5",
  TYPE.small,
  WEIGHT_MEDIUM,
  HIT_TARGET,
  FOCUS_RING,
  FEEDBACK_MOTION
);

/** The changed-files card under a turn; nothing when the turn changed no files. */
export const changedFilesCard = <Message>(
  h: HtmlBuilder<Message>,
  input: ChangedFilesCardInput<Message>
): Html => {
  if (input.files.length === 0 && input.moreFiles === 0) {
    return h.empty;
  }

  const count = input.files.length + input.moreFiles;
  const total = summarizeTurnDiffStats(input.files);
  const hasDirectories = input.files.some((file) => /[/\\]/u.test(file.path));
  const rows = flatten(buildTurnDiffTree(input.files), 0);

  return h.div(
    [
      h.DataAttribute("testid", "changed-files-card"),
      h.DataAttribute("changed-files-turn", String(input.turn)),
      h.DataAttribute("changed-files-state", "tree"),
      h.Class(
        "mt-(--space-3) rounded-(--radius-medium) border border-stroke-1 bg-surface-sunken"
      ),
    ],
    [
      h.div(
        [
          h.DataAttribute("changed-files-header", ""),
          h.Class(
            "flex items-center justify-between gap-(--space-2) border-b border-stroke-1 py-(--space-1) ps-(--space-3) pe-(--space-1)"
          ),
        ],
        [
          h.span(
            [
              h.Class(
                classNames(
                  "flex min-w-0 flex-wrap items-center gap-x-(--space-3) text-ink-1",
                  TYPE.small,
                  WEIGHT_MEDIUM
                )
              ),
            ],
            [
              `${String(count)} changed file${count === 1 ? "" : "s"}`,
              hasNonZeroStat(total) ? diffStatLabel(h, total) : h.empty,
            ]
          ),
          h.button(
            [
              h.Type("button"),
              h.AriaLabel("Open diff"),
              h.Class(OPEN_CLASS),
              h.OnClick(
                input.onOpen(
                  Option.map(
                    Option.fromNullishOr(input.files[0]),
                    (file) => file.path
                  )
                )
              ),
            ],
            [icon(h, FileDiff, "file-diff", ""), "Open diff"]
          ),
        ]
      ),
      h.div(
        [h.Class("flex flex-col p-(--space-1)")],
        [
          ...rows.map((row) => treeRow(h, row, hasDirectories, input.onOpen)),
          input.moreFiles > 0
            ? h.p(
                [
                  h.Class(
                    `px-(--space-2) py-(--space-1-5) text-ink-3 ${TYPE.small}`
                  ),
                ],
                [
                  `${String(input.moreFiles)} more file${input.moreFiles === 1 ? "" : "s"} in the diff`,
                ]
              )
            : h.empty,
        ]
      ),
    ]
  );
};
