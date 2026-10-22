// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/ChangedFilesTree.tsx
// (`ChangedFilesCard`, `ChangedFilesTree`) and apps/web/src/components/chat/DiffStatLabel.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the card's classes, its header ("N changed
// files" and the summed stat, an "Open diff" button that opens the first file), and the tree rows
// with their padding per depth, folder and file icons and per-row stats; a compact count above a
// thousand. Changed: a Foldkit view generic over its parent's Message, folders always shown open
// (no per-card folder state, so the transcript row stays a pure function of its entry), plain
// lucide file icons instead of Pierre's, and a "N more files" line when the brain listed only the
// first 500. Removed: the context menu on files, the tooltip, and virtualization at 250 rows.
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
import {
  buildTurnDiffTree,
  summarizeTurnDiffStats,
} from "@cairn/client-logic/DiffTree";
import type {
  DiffStat,
  DiffTreeNode,
  TurnDiffFile,
} from "@cairn/client-logic/DiffTree";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { File, FileDiff, FolderOpen } from "lucide";

import { icon } from "../composer/Icon.ts";
import { button, buttonDefaults } from "../ui/Button.ts";

/** What the card shows and the Message it sends to open the diff. */
export interface ChangedFilesCardInput<Message> {
  readonly turn: number;
  readonly files: ReadonlyArray<TurnDiffFile>;
  /** Files the brain counted but did not list. */
  readonly moreFiles: number;
  /** The Message that opens the turn's diff, at a file when one is given. */
  readonly onOpen: (path: Option.Option<string>) => Message;
}

const ROW_CLASS =
  "group flex h-7 w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

/** True when a stat has something to show. */
export const hasNonZeroStat = (stat: DiffStat): boolean =>
  stat.additions > 0 || stat.deletions > 0;

/** `1234` as `1.2k`, as t3code shows large counts. */
export const formatCompactCount = (value: number): string => {
  const scaled = (divisor: number, suffix: string) => {
    const amount = value / divisor;

    return `${amount < 10 ? amount.toFixed(1).replace(/\.0$/u, "") : String(Math.round(amount))}${suffix}`;
  };

  if (value < 1000) {
    return String(value);
  }

  return value < 1_000_000 ? scaled(1000, "k") : scaled(1_000_000, "m");
};

/** `+3 -1`, green and red, with one label for screen readers. */
export const diffStatLabel = <Message>(
  h: HtmlBuilder<Message>,
  stat: DiffStat,
  layout: "aligned" | "inline",
  className = ""
): Html =>
  h.span(
    [
      h.Role("group"),
      h.AriaLabel(
        `${String(stat.additions)} additions, ${String(stat.deletions)} deletions`
      ),
      h.Class(
        `${layout === "inline" ? "inline-flex items-center gap-1 tabular-nums align-middle" : "inline-grid grid-cols-[4ch_4ch] gap-2 text-right tabular-nums align-middle"} ${className}`
      ),
    ],
    [
      h.span(
        [h.AriaHidden(true), h.Class("font-mono text-diff-addition")],
        [`+${formatCompactCount(stat.additions)}`]
      ),
      h.span(
        [h.AriaHidden(true), h.Class("font-mono text-diff-deletion")],
        [`-${formatCompactCount(stat.deletions)}`]
      ),
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
  nodes.flatMap((node) => [
    { node, depth },
    ...(node.kind === "directory" ? flatten(node.children, depth + 1) : []),
  ]);

const statCell = <Message>(h: HtmlBuilder<Message>, stat: DiffStat): Html =>
  hasNonZeroStat(stat)
    ? h.span(
        [h.Class("ml-auto shrink-0 font-mono text-3xs tabular-nums")],
        [diffStatLabel(h, stat, "aligned")]
      )
    : h.empty;

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
        h.Class(`${ROW_CLASS} cursor-default`),
        h.Style(padding),
      ],
      [
        icon(
          h,
          FolderOpen,
          "folder-open",
          "size-3.5 shrink-0 text-muted-foreground/75"
        ),
        h.span(
          [
            h.Class(
              "truncate font-mono text-2xs text-muted-foreground/90 group-hover:text-foreground/90"
            ),
          ],
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
      h.Class(ROW_CLASS),
      h.Style(padding),
      h.AriaLabel(`Open the diff of ${path}`),
      h.OnClick(onOpen(Option.some(path))),
    ],
    [
      hasDirectories || row.depth > 0
        ? h.span([h.AriaHidden(true), h.Class("size-3.5 shrink-0")])
        : h.empty,
      icon(h, File, "file", "size-3.5 shrink-0 text-muted-foreground/70"),
      h.span(
        [
          h.Class(
            "flex min-w-0 truncate font-mono text-xs text-foreground/85 group-hover:text-foreground"
          ),
        ],
        [row.node.name]
      ),
      statCell(h, row.node.stat),
    ]
  );
};

/**
 * The changed-files card under a turn: its files as a tree with stats, and "Open diff". Nothing
 * when the turn changed no files.
 */
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
        "@container/changed-files mt-4 rounded-lg bg-secondary dark:bg-input/20"
      ),
    ],
    [
      h.div(
        [
          h.DataAttribute("changed-files-header", ""),
          h.Class(
            "sticky top-2 z-10 flex items-center justify-between gap-2 rounded-t-lg bg-secondary px-3 py-2 dark:bg-background dark:bg-linear-to-b dark:from-input/20 dark:to-input/20"
          ),
        ],
        [
          h.div(
            [
              h.Class(
                "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-foreground"
              ),
            ],
            [
              h.span(
                [],
                [`${String(count)} changed file${count === 1 ? "" : "s"}`]
              ),
              hasNonZeroStat(total)
                ? diffStatLabel(h, total, "inline", "text-xs leading-4")
                : h.empty,
            ]
          ),
          h.div(
            [h.Class("flex shrink-0 items-center gap-1")],
            [
              button(
                h,
                {
                  ...buttonDefaults<Message>(),
                  variant: "ghost-muted",
                  size: "xs",
                  ariaLabel: Option.some("Open diff"),
                  onClick: Option.some(
                    input.onOpen(
                      Option.map(
                        Option.fromNullishOr(input.files[0]),
                        (file) => file.path
                      )
                    )
                  ),
                },
                [
                  icon(h, FileDiff, "file-diff", "size-3"),
                  h.span(
                    [h.Class("hidden @[24rem]/changed-files:inline")],
                    ["Open diff"]
                  ),
                ]
              ),
            ]
          ),
        ]
      ),
      h.div(
        [h.Class("p-2")],
        [
          ...rows.map((row) => treeRow(h, row, hasDirectories, input.onOpen)),
          input.moreFiles > 0
            ? h.p(
                [h.Class("px-2 py-1.5 text-muted-foreground text-xs")],
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
