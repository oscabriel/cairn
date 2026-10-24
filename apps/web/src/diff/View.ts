// The diff panel: a sheet over the right of the thread page with the turn's (or the whole
// thread's) changes as a unified diff, its files listed as a tree beside it on wide screens and
// above it on narrow ones. The patch comes from the brain's checkpoint refs and is parsed here
// (client-logic's `parsePatch`, ported from cairn-v1's apps/web/src/patch.ts at 1a5cd4a); each
// file's lines are colored by the transcript's lazy shiki grammars once they load.
// Layout follows t3code's DiffPanel (github.com/pingdotgg/t3code,
// apps/web/src/components/DiffPanel.tsx at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92) in spirit only:
// a header with the scope and whitespace switches and a close button; no split view (D31). A patch
// is parsed once, outside the Model; each file is a keyed lazy view that redraws only when its own
// lines, tokens or selection change; a file's shown lines are tokenized together into the
// transcript's token cache by the file's Mount, a slice at a time, never by a render; and the panel
// shows at most `MAX_TOTAL_LINES` lines across its files.
import { buildTurnDiffTree, parsePatch } from "@cairn/client-logic/DiffTree";
import type {
  DiffTreeNode,
  PatchFile,
  PatchHunk,
  PatchLine,
} from "@cairn/client-logic/DiffTree";
import { Option } from "effect";
import { Submodel } from "foldkit";
import { createKeyedLazy, createLazy } from "foldkit/html";
import type { Html, HtmlBuilder } from "foldkit/html";
import { X } from "lucide";

import { icon } from "../composer/Icon.ts";
import { cachedTokensOf, languageOf } from "../timeline/markdown/Highlight.ts";
import type { TokenLines } from "../timeline/markdown/Highlight.ts";
import { button, buttonDefaults } from "../ui/Button.ts";
import { diffStatLabel, hasNonZeroStat } from "./Card.ts";
import { fileElementId, LoadDiffHighlighting } from "./Command.ts";
import { Message } from "./Message.ts";
import { DiffLoad } from "./Model.ts";
import type { DiffScope, Model } from "./Model.ts";

type H = HtmlBuilder<Message>;

/** The most lines one file renders; the rest is summarized, so a huge file cannot stall the page. */
export const MAX_RENDERED_LINES = 2000;

/**
 * The most lines the panel renders across its files, two files at their limit; files past it show
 * their header and a count, so a patch of many files cannot stall the page either.
 */
export const MAX_TOTAL_LINES = 4000;

const BASENAMES: ReadonlyMap<string, string> = new Map([
  ["dockerfile", "dockerfile"],
  ["makefile", "bash"],
]);

/** The grammar for a path, from its extension or its name. */
export const languageOfPath = (path: string): Option.Option<string> => {
  const base = (path.split("/").at(-1) ?? path).toLowerCase();
  const named = BASENAMES.get(base);

  if (named !== undefined) {
    return languageOf(named);
  }

  const dot = base.lastIndexOf(".");

  return dot <= 0 ? Option.none() : languageOf(base.slice(dot + 1));
};

const SIGN: Readonly<Record<PatchLine["kind"], string>> = {
  added: "+",
  removed: "-",
  context: " ",
  note: "\\",
};

const LINE_CLASS: Readonly<Record<PatchLine["kind"], string>> = {
  added: "bg-diff-addition/10",
  removed: "bg-diff-deletion/10",
  context: "",
  note: "text-muted-foreground italic",
};

const numberCell = (h: H, value: Option.Option<number>): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.Class(
        "w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/70 tabular-nums"
      ),
    ],
    [Option.match(value, { onNone: () => "", onSome: String })]
  );

const tokenContent = (
  h: H,
  line: PatchLine,
  tokens: Option.Option<TokenLines>,
  index: number
): ReadonlyArray<Html | string> =>
  Option.match(
    Option.flatMap(tokens, (lines) => Option.fromNullishOr(lines[index])),
    {
      onNone: () => [line.text === "" ? " " : line.text],
      onSome: (pieces) =>
        pieces.map((token) =>
          Option.isNone(token.light) && Option.isNone(token.dark)
            ? token.content
            : h.span(
                [
                  h.Class("text-(--shiki-light) dark:text-(--shiki-dark)"),
                  h.Style({
                    ...Option.match(token.light, {
                      onNone: () => ({}),
                      onSome: (color) => ({ "--shiki-light": color }),
                    }),
                    ...Option.match(token.dark, {
                      onNone: () => ({}),
                      onSome: (color) => ({ "--shiki-dark": color }),
                    }),
                  }),
                ],
                [token.content]
              )
        ),
    }
  );

/** A hunk as shown: its lines within the budget, and where its code lines start in the file's code. */
interface ShownHunk {
  readonly hunk: PatchHunk;
  readonly lines: ReadonlyArray<PatchLine>;
  readonly codeStart: number;
}

/** A file as the panel shows it, derived once per patch. */
interface ShownFile {
  readonly file: PatchFile;
  readonly language: Option.Option<string>;
  readonly hunks: ReadonlyArray<ShownHunk>;
  /** The shown lines that are code (not `\ No newline` notes), one string tokenized together. */
  readonly code: string;
  /** Lines in the file's hunks, shown or not. */
  readonly total: number;
  readonly shown: number;
}

const showFile = (file: PatchFile, budget: number): ShownFile => {
  const hunks: Array<ShownHunk> = [];
  const code: Array<string> = [];
  let left = budget;

  for (const hunk of file.hunks) {
    const lines = hunk.lines.slice(0, Math.max(0, left));

    hunks.push({ hunk, lines, codeStart: code.length });
    code.push(
      ...lines.flatMap((line) => (line.kind === "note" ? [] : [line.text]))
    );
    left -= hunk.lines.length;
  }

  const total = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);

  return {
    file,
    language: languageOfPath(file.path),
    hunks,
    code: code.join("\n"),
    total,
    shown: Math.min(total, Math.max(0, budget)),
  };
};

/** A patch parsed for the panel: its files as shown within the budgets, and their tree. */
interface ParsedPatch {
  readonly patch: string;
  /** Bumped for every new patch: file elements are keyed by it, so their Mounts run again. */
  readonly generation: number;
  readonly files: ReadonlyArray<ShownFile>;
  readonly tree: ReadonlyArray<DiffTreeNode>;
}

/** The last patch parsed; the view parses once per patch, not once per render. */
const parsed = new Map<"last", ParsedPatch>();

const parsedPatch = (patch: string): ParsedPatch => {
  const last = parsed.get("last");

  if (last?.patch === patch) {
    return last;
  }

  const files = parsePatch(patch);
  let left = MAX_TOTAL_LINES;

  const shown = files.map((file) => {
    const view = showFile(file, Math.min(MAX_RENDERED_LINES, left));

    left -= view.shown;

    return view;
  });

  const next = {
    patch,
    generation: (last?.generation ?? 0) + 1,
    files: shown,
    tree: buildTurnDiffTree(
      files.map((file) => ({ path: file.path, ...file.stat }))
    ),
  };

  parsed.set("last", next);

  return next;
};

const hunkView = (
  h: H,
  shown: ShownHunk,
  tokens: Option.Option<TokenLines>
): Html => {
  let codeIndex = shown.codeStart - 1;

  return h.div(
    [h.DataAttribute("slot", "diff-hunk")],
    [
      h.div(
        [
          h.Class(
            "bg-muted/40 px-3 py-1 font-mono text-muted-foreground text-xs"
          ),
        ],
        [shown.hunk.header]
      ),
      ...shown.lines.map((line) => {
        codeIndex += line.kind === "note" ? 0 : 1;

        return h.div(
          [
            h.DataAttribute("kind", line.kind),
            h.Class(`flex min-w-fit ${LINE_CLASS[line.kind]}`),
          ],
          [
            numberCell(h, line.oldNumber),
            numberCell(h, line.newNumber),
            h.span(
              [
                h.AriaHidden(true),
                h.Class("w-4 shrink-0 select-none text-muted-foreground"),
              ],
              [SIGN[line.kind]]
            ),
            h.span(
              [h.Class("whitespace-pre pr-3")],
              [
                ...(line.kind === "added"
                  ? [h.span([h.Class("sr-only")], ["Added: "])]
                  : []),
                ...(line.kind === "removed"
                  ? [h.span([h.Class("sr-only")], ["Removed: "])]
                  : []),
                ...(line.kind === "note"
                  ? [line.text]
                  : tokenContent(h, line, tokens, codeIndex)),
              ]
            ),
          ]
        );
      }),
    ]
  );
};

const STATUS_LABEL: Readonly<Record<PatchFile["status"], string>> = {
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  modified: "Modified",
};

/** Stands for no tokens yet as a lazy argument, which compares by reference. */
const NO_TOKENS: TokenLines = [];

const fileView = (
  h: H,
  shown: ShownFile,
  generation: number,
  selected: boolean,
  tokens: TokenLines
): Html => {
  const { file } = shown;

  return h.section(
    [
      // A Mount runs only when its element is created: a new patch gives new file elements.
      h.Key(`${String(generation)}:${file.path}`),
      h.Id(fileElementId(file.path)),
      h.DataAttribute("diff-file", file.path),
      h.AriaLabel(file.path),
      h.Class(
        `overflow-hidden rounded-lg border ${selected ? "border-ring" : "border-border"}`
      ),
      ...Option.match(shown.language, {
        onNone: () => [],
        onSome: (name) => [
          h.OnMount(
            LoadDiffHighlighting({
              language: name,
              code: shown.code === "" ? Option.none() : Option.some(shown.code),
            })
          ),
        ],
      }),
    ],
    [
      h.header(
        [
          h.Class(
            "flex items-center gap-2 border-b bg-secondary px-3 py-1.5 text-xs"
          ),
        ],
        [
          h.span(
            [h.Class("min-w-0 truncate font-mono text-foreground")],
            [
              Option.match(file.oldPath, {
                onNone: () => file.path,
                onSome: (old) => `${old} → ${file.path}`,
              }),
            ]
          ),
          h.span(
            [h.Class("text-muted-foreground")],
            [STATUS_LABEL[file.status]]
          ),
          hasNonZeroStat(file.stat)
            ? h.span(
                [h.Class("ml-auto shrink-0")],
                [diffStatLabel(h, file.stat, "inline")]
              )
            : h.empty,
        ]
      ),
      h.div(
        [h.Class("overflow-x-auto bg-card py-1 font-mono text-xs leading-5")],
        file.binary
          ? [h.p([h.Class("px-3 py-2 text-muted-foreground")], ["Binary file"])]
          : [
              ...shown.hunks.map((hunk) =>
                hunkView(
                  h,
                  hunk,
                  tokens === NO_TOKENS ? Option.none() : Option.some(tokens)
                )
              ),
              shown.total > shown.shown
                ? h.p(
                    [h.Class("px-3 py-2 text-muted-foreground")],
                    [
                      `${String(shown.total - shown.shown)} more lines not shown`,
                    ]
                  )
                : h.empty,
            ]
      ),
    ]
  );
};

const fileLazy = createKeyedLazy();

const treeLazy = createLazy();

const treeRows = (
  h: H,
  nodes: ReadonlyArray<DiffTreeNode>,
  depth: number,
  selected: Option.Option<string>
): ReadonlyArray<Html> =>
  nodes.flatMap((node) => {
    const padding = { paddingLeft: `${String(8 + depth * 14)}px` };

    if (node.kind === "directory") {
      return [
        h.div(
          [
            h.Class(
              "truncate py-1 pr-2 font-mono text-2xs text-muted-foreground/90"
            ),
            h.Style(padding),
          ],
          [node.name]
        ),
        ...treeRows(h, node.children, depth + 1, selected),
      ];
    }

    const isSelected = Option.contains(selected, node.path);

    return [
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("diff-tree-file", node.path),
          h.AriaCurrent(isSelected ? "true" : "false"),
          h.Class(
            `flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left font-mono text-xs hover:bg-accent/60 ${isSelected ? "bg-accent text-foreground" : "text-foreground/85"}`
          ),
          h.Style(padding),
          h.OnClick(Message.ClickedFile({ path: node.path })),
        ],
        [
          h.span([h.Class("min-w-0 truncate")], [node.name]),
          hasNonZeroStat(node.stat)
            ? h.span(
                [h.Class("ml-auto shrink-0 text-3xs")],
                [diffStatLabel(h, node.stat, "inline")]
              )
            : h.empty,
        ]
      ),
    ];
  });

const treeView = (
  h: H,
  tree: ReadonlyArray<DiffTreeNode>,
  selected: Option.Option<string>
): Html => h.div([], treeRows(h, tree, 0, selected));

/** A file's tokens so far, the same array while they do not change; `NO_TOKENS` before any. */
const tokensOf = (
  shown: ShownFile,
  highlighted: ReadonlyArray<string>
): TokenLines =>
  Option.getOrElse(
    Option.flatMap(
      Option.filter(shown.language, (name) => highlighted.includes(name)),
      (name) => cachedTokensOf(shown.code, name)
    ),
    () => NO_TOKENS
  );

const scopeButton = (
  h: H,
  model: Model,
  scope: DiffScope,
  label: string
): Html =>
  h.button(
    [
      h.Type("button"),
      h.AriaPressed(model.scope === scope ? "true" : "false"),
      h.Class(
        `rounded-md px-2 py-1 text-xs ${model.scope === scope ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`
      ),
      h.OnClick(Message.ClickedScope({ scope })),
    ],
    [label]
  );

const body = (h: H, model: Model): Html =>
  DiffLoad.match(model.load, {
    Idle: () => h.empty,
    Loading: () =>
      h.p(
        [
          h.DataAttribute("testid", "diff-status"),
          h.Role("status"),
          h.Class("p-4 text-muted-foreground text-sm"),
        ],
        ["Loading the diff..."]
      ),
    Failed: ({ message }) =>
      h.div(
        [
          h.DataAttribute("testid", "diff-status"),
          h.Role("alert"),
          h.Class("flex flex-col items-start gap-2 p-4 text-sm"),
        ],
        [
          h.p([h.Class("text-destructive-foreground")], [message]),
          button(
            h,
            {
              ...buttonDefaults<Message>(),
              variant: "outline",
              size: "xs",
              onClick: Option.some(Message.ClickedRetry()),
            },
            ["Retry"]
          ),
        ]
      ),
    Loaded: ({ patch }) => {
      const { files, generation, tree } = parsedPatch(patch);

      if (files.length === 0) {
        return h.p(
          [
            h.DataAttribute("testid", "diff-status"),
            h.Class("p-4 text-muted-foreground text-sm"),
          ],
          [
            model.scope === "turn"
              ? "This turn changed no files."
              : "The thread changed no files.",
          ]
        );
      }

      return h.div(
        [h.Class("flex min-h-0 flex-1 flex-col md:flex-row")],
        [
          h.nav(
            [
              h.AriaLabel("Changed files"),
              h.Class(
                "max-h-48 shrink-0 overflow-y-auto border-b p-2 md:max-h-none md:w-64 md:border-r md:border-b-0"
              ),
            ],
            [treeLazy(treeView, [h, tree, model.selectedPath]) ?? h.empty]
          ),
          h.div(
            [
              h.DataAttribute("testid", "diff-files"),
              h.Class("flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3"),
            ],
            files.map(
              (shown) =>
                fileLazy(shown.file.path, fileView, [
                  h,
                  shown,
                  generation,
                  Option.contains(model.selectedPath, shown.file.path),
                  tokensOf(shown, model.highlightedLanguages),
                ]) ?? h.empty
            )
          ),
        ]
      );
    },
  });

const panel = (h: H, model: Model): Html =>
  Option.match(model.target, {
    onNone: () => h.empty,
    onSome: (target) =>
      h.aside(
        [
          h.DataAttribute("testid", "diff-panel"),
          h.AriaLabel(`Diff of turn ${String(target.turn)}`),
          h.Class(
            "fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l bg-background shadow-lg md:w-[min(64rem,62vw)]"
          ),
        ],
        [
          h.header(
            [h.Class("flex items-center gap-2 border-b px-3 py-2")],
            [
              h.h2(
                [h.Class("font-medium text-sm")],
                [
                  model.scope === "turn"
                    ? `Turn ${String(target.turn)}`
                    : `Turns 1 to ${String(target.turn)}`,
                ]
              ),
              h.div(
                [h.Class("flex items-center gap-1")],
                [
                  scopeButton(h, model, "turn", "This turn"),
                  scopeButton(h, model, "full", "All turns"),
                ]
              ),
              h.button(
                [
                  h.Type("button"),
                  h.AriaPressed(model.ignoreWhitespace ? "true" : "false"),
                  h.Class(
                    `ml-auto rounded-md px-2 py-1 text-xs ${model.ignoreWhitespace ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`
                  ),
                  h.OnClick(Message.ToggledWhitespace()),
                ],
                ["Ignore whitespace"]
              ),
              button(
                h,
                {
                  ...buttonDefaults<Message>(),
                  variant: "ghost-muted",
                  size: "icon-xs",
                  ariaLabel: Option.some("Close diff"),
                  onClick: Option.some(Message.ClickedClose()),
                },
                [icon(h, X, "x", "size-3.5")]
              ),
            ]
          ),
          body(h, model),
        ]
      ),
  });

/** The diff panel; nothing while it is closed. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  panel(h, model)
);
