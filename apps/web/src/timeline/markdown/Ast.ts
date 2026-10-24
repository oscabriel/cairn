// Ported from cairn-v1 at 1a5cd4a, apps/web/src/markdown/ast.ts, itself adapted from
// github.com/foldkit/foldkit, packages/markdown/src/ast/ast.ts at
// 76fa0d1ee2a5f9d06333e83a1ee381eab0ed37d5. Changed: nodes are tagged by `kind` (plain data the
// views switch on, never stored in a Model), a blockquote carries its GitHub alert kind, and a
// block keeps the source line it started on, which the incremental parse reuses blocks by.
//
// MIT License. Copyright (c) 2025 Devin Jameson.
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
import type { Option } from "effect";

/** Inline content: text and the spans around it. */
export type Inline =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "code"; readonly value: string }
  | { readonly kind: "break" }
  | { readonly kind: "emphasis"; readonly content: ReadonlyArray<Inline> }
  | { readonly kind: "strong"; readonly content: ReadonlyArray<Inline> }
  | { readonly kind: "strike"; readonly content: ReadonlyArray<Inline> }
  | {
      readonly kind: "link";
      readonly url: string;
      readonly title: Option.Option<string>;
      readonly content: ReadonlyArray<Inline>;
    }
  | { readonly kind: "image"; readonly url: string; readonly alt: string };

/** How a table column aligns its cells. */
export type Alignment = "none" | "left" | "center" | "right";

/** The kinds of GitHub alert a blockquote can open with (`> [!NOTE]`). */
export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

/** One item of a list; `checked` is a task item's box. */
export interface ListItem {
  readonly checked: Option.Option<boolean>;
  readonly blocks: ReadonlyArray<Block>;
}

/** Block content. */
export type Block =
  | {
      readonly kind: "heading";
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly content: ReadonlyArray<Inline>;
    }
  | { readonly kind: "paragraph"; readonly content: ReadonlyArray<Inline> }
  | {
      readonly kind: "code";
      readonly language: Option.Option<string>;
      readonly meta: Option.Option<string>;
      readonly value: string;
      /** A fence with no closing line yet, so it runs to the end of the text and may still grow. */
      readonly open: boolean;
    }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly start: Option.Option<number>;
      /** No blank line between or inside its items: paragraphs render without `<p>`. */
      readonly tight: boolean;
      readonly items: ReadonlyArray<ListItem>;
    }
  | {
      readonly kind: "quote";
      readonly alert: Option.Option<AlertKind>;
      readonly blocks: ReadonlyArray<Block>;
    }
  | { readonly kind: "rule" }
  | {
      readonly kind: "table";
      readonly alignments: ReadonlyArray<Alignment>;
      readonly header: ReadonlyArray<ReadonlyArray<Inline>>;
      readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Inline>>>;
    };

/** A top-level block and the source line it starts on. */
export interface PlacedBlock {
  readonly block: Block;
  readonly startLine: number;
}

/** A parsed message. */
export interface MarkdownDocument {
  readonly blocks: ReadonlyArray<PlacedBlock>;
}
