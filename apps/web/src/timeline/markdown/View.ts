// Ported from cairn-v1 at 1a5cd4a, apps/web/src/markdown/view.ts. Kept: the element for each node,
// links that open in a new tab, images shown only as links (remote images never load), a code
// block's label (title from its fence, else its language) and copy button, plain text until its
// grammar loads and then the same text colored, text too long to format shown raw. Changed: the
// node shapes of Cairn's parse (Ast.ts), GitHub alerts, the `.chat-markdown` classes of t3code's
// styles, the copy button routed through the transcript's Message, a fence still growing in the
// streaming message shown plain until it closes or commits, as t3code does, and a block too long
// to tokenize in one frame tokenized by its Mount a slice at a time.

import { Match, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Check, Copy, Image } from "lucide";

import { icon } from "../../composer/Icon.ts";
import { LoadHighlighting } from "../Command.ts";
import { Message } from "../Message.ts";
import type { AlertKind, Alignment, Block, Inline } from "./Ast.ts";
import { languageOf, readyTokensOf, SLICE_CHARS } from "./Highlight.ts";
import type { TokenLines } from "./Highlight.ts";
import { markdownFor } from "./Markdown.ts";

type H = HtmlBuilder<Message>;

type Content = ReadonlyArray<Html | string>;

/** What a message's markdown needs besides its text. */
export interface MarkdownContext {
  readonly h: H;
  readonly rowId: string;
  readonly highlightedLanguages: ReadonlyArray<string>;
  readonly copiedRowId: Option.Option<string>;
}

/** The markdown context and whether the message is the one still streaming. */
interface BlockContext extends MarkdownContext {
  readonly streaming: boolean;
}

const LINK_CLASS =
  "text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground";

const inlineView = (h: H, inline: Inline): Html | string => {
  const children = (content: ReadonlyArray<Inline>): Content =>
    content.map((child) => inlineView(h, child));

  return Match.value(inline).pipe(
    Match.discriminatorsExhaustive("kind")({
      text: ({ value }) => value,
      code: ({ value }) => h.code([], [value]),
      break: () => h.br([]),
      emphasis: ({ content }) => h.em([], children(content)),
      strong: ({ content }) => h.strong([], children(content)),
      strike: ({ content }) => h.del([], children(content)),
      link: ({ content, title, url }) =>
        h.a(
          [
            h.Href(url),
            h.Target("_blank"),
            h.Rel("noopener noreferrer"),
            h.Class(LINK_CLASS),
            ...Option.match(title, {
              onNone: () => [],
              onSome: (text) => [h.Title(text)],
            }),
          ],
          children(content)
        ),
      image: ({ alt }) =>
        h.span(
          [
            h.DataAttribute("slot", "blocked-image"),
            h.Class("inline-flex items-baseline gap-1 text-muted-foreground"),
          ],
          [
            icon(h, Image, "image", "size-3.5 shrink-0 self-center"),
            alt === "" ? "Image" : `Image: ${alt}`,
          ]
        ),
    })
  );
};

const inlines = (h: H, content: ReadonlyArray<Inline>): Content =>
  content.map((inline) => inlineView(h, inline));

const ALIGN_CLASS: Readonly<Record<Alignment, string>> = {
  none: "",
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

const FENCE_TITLE =
  /(?:^|\s)(?:title|file|filename)=(?:"(?<double>[^"]+)"|'(?<single>[^']+)'|(?<bare>\S+))/u;

const titleOf = (meta: Option.Option<string>): Option.Option<string> =>
  Option.flatMap(meta, (text) => {
    const groups = FENCE_TITLE.exec(text)?.groups;

    return Option.fromUndefinedOr(
      groups?.double ?? groups?.single ?? groups?.bare
    );
  });

/** `source` with its first lines colored by `lines`; lines past them, still being tokenized, stay plain. */
const tokenSpans = (h: H, lines: TokenLines, source: string): Content => {
  const rest = source.split("\n").slice(lines.length);

  return [
    ...lines.flatMap((line, index) => [
      ...line.map((token) =>
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
      ...(index < lines.length - 1 || rest.length > 0 ? ["\n"] : []),
    ]),
    ...(rest.length > 0 ? [rest.join("\n")] : []),
  ];
};

const copyButton = (context: BlockContext, key: string, text: string): Html => {
  const { h } = context;
  const copied = Option.contains(context.copiedRowId, key);

  return h.button(
    [
      h.Type("button"),
      h.AriaLabel(copied ? "Copied" : "Copy code"),
      h.DataAttribute("testid", "code-copy"),
      h.OnClick(Message.ClickedCopy({ rowId: key, text })),
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
};

const codeBlockView = (
  context: BlockContext,
  block: Extract<Block, { readonly kind: "code" }>,
  path: string
): Html => {
  const { h } = context;
  const language = Option.flatMap(block.language, languageOf);

  // A fence still growing would be tokenized again, and cached, on every frame.
  const settled = !(context.streaming && block.open);

  const loaded = Option.exists(language, (name) =>
    context.highlightedLanguages.includes(name)
  );

  const tokens =
    settled && loaded
      ? Option.flatMap(language, (name) => readyTokensOf(block.value, name))
      : Option.none();

  const sliced = settled && block.value.length > SLICE_CHARS;

  const label = Option.getOrElse(
    Option.orElse(titleOf(block.meta), () => block.language),
    () => "text"
  );

  return h.div(
    [
      // A Mount runs only when its element is created, so a fence whose language streams in after
      // its backticks, or a long one that just closed, needs a new element: the key changes then.
      h.Key(
        `code:${path}:${Option.getOrElse(language, () => "")}:${sliced ? "sliced" : ""}`
      ),
      h.DataAttribute("slot", "code-block"),
      h.Class(
        "chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-lg border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      ),
      // Kept after the grammar loads: removing it would end the Mount. A block that mounts later
      // finds the grammar loaded and its Message changes nothing.
      ...Option.match(language, {
        onNone: () => [],
        onSome: (name) => [
          h.OnMount(
            LoadHighlighting({
              language: name,
              code: sliced ? Option.some(block.value) : Option.none(),
            })
          ),
        ],
      }),
    ],
    [
      h.div(
        [
          h.Class(
            "chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pl-3 select-none"
          ),
        ],
        [
          h.span(
            [
              h.Class(
                "truncate font-mono text-[0.6875rem] text-muted-foreground"
              ),
            ],
            [label]
          ),
          // Keyed by the block's path: a position alone repeats across list items (T33).
          copyButton(context, `${context.rowId}:code:${path}`, block.value),
        ]
      ),
      h.pre(
        [
          h.Class(
            "px-3 pt-1 pb-2.5 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
          ),
        ],
        [
          h.code(
            [
              h.DataAttribute(
                "highlighted",
                Option.match(tokens, {
                  onNone: () => "false",
                  onSome: (lines) =>
                    lines.length < block.value.split("\n").length
                      ? "partly"
                      : "true",
                })
              ),
            ],
            Option.match(tokens, {
              onNone: () => [block.value],
              onSome: (lines) => tokenSpans(h, lines, block.value),
            })
          ),
        ]
      ),
    ]
  );
};

const ALERTS: Readonly<
  Record<AlertKind, { readonly label: string; readonly className: string }>
> = {
  note: {
    label: "Note",
    className: "border-blue-500/70 [&>[data-slot=alert-title]]:text-blue-500",
  },
  tip: {
    label: "Tip",
    className:
      "border-emerald-500/70 [&>[data-slot=alert-title]]:text-emerald-500",
  },
  important: {
    label: "Important",
    className:
      "border-violet-500/70 [&>[data-slot=alert-title]]:text-violet-500",
  },
  warning: {
    label: "Warning",
    className: "border-amber-500/70 [&>[data-slot=alert-title]]:text-amber-500",
  },
  caution: {
    label: "Caution",
    className: "border-red-500/70 [&>[data-slot=alert-title]]:text-red-500",
  },
};

const quoteView = (
  context: BlockContext,
  block: Extract<Block, { readonly kind: "quote" }>,
  children: Content
): Html => {
  const { h } = context;

  return Option.match(block.alert, {
    onNone: () => h.blockquote([], children),
    onSome: (kind) =>
      h.div(
        [
          h.DataAttribute("alert", kind),
          h.Class(
            `my-[0.65rem] border-l-2 py-0.5 pl-3 ${ALERTS[kind].className}`
          ),
        ],
        [
          h.p(
            [h.DataAttribute("slot", "alert-title"), h.Class("font-medium")],
            [ALERTS[kind].label]
          ),
          ...children,
        ]
      ),
  });
};

const headingView = (
  h: H,
  level: 1 | 2 | 3 | 4 | 5 | 6,
  content: Content
): Html =>
  Match.value(level).pipe(
    Match.when(1, () => h.h1([], content)),
    Match.when(2, () => h.h2([], content)),
    Match.when(3, () => h.h3([], content)),
    Match.when(4, () => h.h4([], content)),
    Match.when(5, () => h.h5([], content)),
    Match.when(6, () => h.h6([], content)),
    Match.exhaustive
  );

const tableView = (
  context: BlockContext,
  block: Extract<Block, { readonly kind: "table" }>
): Html => {
  const { h } = context;

  const align = (column: number) =>
    h.Class(ALIGN_CLASS[block.alignments[column] ?? "none"]);

  return h.div(
    [h.Class("chat-markdown-table-container overflow-x-auto")],
    [
      h.table(
        [],
        [
          h.thead(
            [],
            [
              h.tr(
                [],
                block.header.map((cell, column) =>
                  h.th([align(column)], inlines(h, cell))
                )
              ),
            ]
          ),
          h.tbody(
            [],
            block.rows.map((row) =>
              h.tr(
                [],
                row.map((cell, column) =>
                  h.td([align(column)], inlines(h, cell))
                )
              )
            )
          ),
        ]
      ),
    ]
  );
};

/** Renders nested blocks; `blockView` passes itself. */
type RenderBlocks = (blocks: ReadonlyArray<Block>, path: string) => Content;

const listView = (
  context: BlockContext,
  block: Extract<Block, { readonly kind: "list" }>,
  path: string,
  render: RenderBlocks
): Html => {
  const { h } = context;

  const items = block.items.map((item, index) => {
    const children = block.tight
      ? item.blocks.flatMap((child, at) =>
          child.kind === "paragraph"
            ? inlines(h, child.content)
            : render([child], `${path}.${index}.${at}`)
        )
      : render(item.blocks, `${path}.${index}`);

    return Option.match(item.checked, {
      onNone: () => h.li([], children),
      onSome: (checked) =>
        h.li(
          [h.DataAttribute("task", "")],
          [
            h.input([
              h.Type("checkbox"),
              h.Checked(checked),
              h.Disabled(true),
              h.AriaLabel(checked ? "Done" : "Not done"),
              h.Class("mr-1.5 align-middle"),
            ]),
            ...children,
          ]
        ),
    });
  });

  return block.ordered
    ? h.ol(
        Option.match(block.start, {
          onNone: () => [],
          onSome: (start) => [h.Start(start)],
        }),
        items
      )
    : h.ul([], items);
};

const blockView = (context: BlockContext, block: Block, path: string): Html => {
  const { h } = context;

  const render: RenderBlocks = (blocks, at) =>
    blocks.map((child, position) =>
      blockView(context, child, `${at}.${position}`)
    );

  return Match.value(block).pipe(
    Match.discriminatorsExhaustive("kind")({
      heading: ({ content, level }) =>
        headingView(h, level, inlines(h, content)),
      paragraph: ({ content }) => h.p([], inlines(h, content)),
      code: (code) => codeBlockView(context, code, path),
      list: (list) => listView(context, list, path, render),
      quote: (quote) => quoteView(context, quote, render(quote.blocks, path)),
      rule: () => h.hr([]),
      table: (table) => tableView(context, table),
    })
  );
};

/**
 * A message's markdown. `streaming` marks the one growing message, which re-parses only its tail
 * and leaves a fence that has not closed plain. Text too long to format shows raw.
 */
export const markdownView = (
  context: MarkdownContext,
  source: string,
  streaming: boolean
): Html => {
  const { h } = context;
  const blockContext: BlockContext = { ...context, streaming };

  return Option.match(markdownFor(context.rowId, source), {
    onNone: () =>
      h.div(
        [h.DataAttribute("slot", "raw-text"), h.Class("flex flex-col gap-1")],
        [
          h.p(
            [h.Class("text-muted-foreground text-xs")],
            ["Shown as plain text: this message is too long to format."]
          ),
          h.pre(
            [h.Class("font-mono text-xs break-words whitespace-pre-wrap")],
            [source]
          ),
        ]
      ),
    onSome: (document) =>
      h.div(
        [
          h.Class(
            "chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word] text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost))]"
          ),
          ...(streaming ? [h.DataAttribute("streaming", "")] : []),
        ],
        document.blocks.map((placed, index) =>
          blockView(blockContext, placed.block, String(index))
        )
      ),
  });
};
