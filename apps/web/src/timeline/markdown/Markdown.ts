// Ported from cairn-v1 at 1a5cd4a, apps/web/src/markdown/incremental.ts and parse.ts, themselves from
// github.com/pingdotgg/t3code, apps/web/src/markdown-incremental.ts (unchanged at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92). Kept: a growing message re-parses only from the start of
// its last block, because the blocks before it can no longer change; text too long to format stays
// plain. Changed: the parse is Cairn's own (Block.ts) instead of a unified processor, and the
// previous parse is remembered per row key, so a streaming answer's next frame reuses it whether or
// not the row was re-rendered in between.
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
import { Option } from "effect";

import type { MarkdownDocument } from "./Ast.ts";
import { parseBlockList } from "./Block.ts";

/** Longer text renders raw: formatting it would stall a frame. */
export const MAX_FORMATTED_LENGTH = 200_000;

interface Parse {
  readonly source: string;
  readonly document: MarkdownDocument;
}

const CACHE_LIMIT = 400;

const previous = new Map<string, Parse>();

const remember = (key: string, parse: Parse): void => {
  previous.delete(key);
  previous.set(key, parse);

  if (previous.size > CACHE_LIMIT) {
    const oldest = previous.keys().next();

    if (oldest.done !== true) {
      previous.delete(oldest.value);
    }
  }
};

/** Parses `source` from scratch. */
export const parseDocument = (source: string): MarkdownDocument => ({
  blocks: parseBlockList(source.split(/\r?\n/u)),
});

/** Re-parses only from the last block of `before` when `source` extends `before.source`. */
const extend = (before: Parse, source: string): MarkdownDocument => {
  const last = before.document.blocks.at(-1);

  if (last === undefined) {
    return parseDocument(source);
  }

  const lines = source.split(/\r?\n/u);
  const kept = before.document.blocks.slice(0, -1);

  return {
    blocks: [
      ...kept,
      ...parseBlockList(lines.slice(last.startLine), undefined, last.startLine),
    ],
  };
};

/**
 * The document of the row `key` whose text is now `source`; none when the text is too long to
 * format. A source that extends the row's previous one re-parses only its tail.
 */
export const markdownFor = (
  key: string,
  source: string
): Option.Option<MarkdownDocument> => {
  if (source.length > MAX_FORMATTED_LENGTH) {
    return Option.none();
  }

  const before = previous.get(key);

  if (before?.source === source) {
    return Option.some(before.document);
  }

  const document =
    before !== undefined && source.startsWith(before.source)
      ? extend(before, source)
      : parseDocument(source);

  remember(key, { source, document });

  return Option.some(document);
};
