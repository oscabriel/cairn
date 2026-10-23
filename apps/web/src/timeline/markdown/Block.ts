// Block markdown: headings, paragraphs, fenced and indented code, lists with task items, block
// quotes with GitHub alerts, tables and rules. New code (see Inline.ts for why the parse is not
// remark's). Two rules are ports of intent: a blockquote opening with `[!NOTE]`, `[!TIP]`,
// `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` is an alert (github.com/pingdotgg/t3code,
// packages/shared/src/markdownGithubAlerts.ts at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92), and text
// over-indented inside a list item stays text instead of turning into code
// (packages/shared/src/markdownListIndentation.ts at the same commit). An unclosed fence runs to the
// end, so a streaming code block renders as code while it grows.
import { Option } from "effect";

import type {
  AlertKind,
  Alignment,
  Block,
  ListItem,
  PlacedBlock,
} from "./Ast.ts";
import { parseInline } from "./Inline.ts";

const FENCE = /^(?<indent> {0,3})(?<fence>`{3,}|~{3,})(?<info>.*)$/u;

const HEADING =
  /^ {0,3}(?<marks>#{1,6})(?:[ \t]+(?<text>.*?))?(?:[ \t]+#+)?[ \t]*$/u;

const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u;

const QUOTE = /^ {0,3}> ?/u;

const LIST_ITEM =
  /^(?<indent> {0,3})(?<marker>[-*+]|\d{1,9}[.)])(?<gap>[ \t]+|$)/u;

const TASK = /^\[(?<mark>[ xX])\][ \t]+/u;

const TABLE_DELIMITER =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u;

const ALERT = /^\[!(?<kind>NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/iu;

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

const ALERT_KINDS: ReadonlyArray<AlertKind> = [
  "note",
  "tip",
  "important",
  "warning",
  "caution",
];

/** Parses nested lines (a quote's or a list item's); `parseBlockList` passes itself. */
type ParseBlocks = (
  lines: ReadonlyArray<string>,
  options: Options
) => ReadonlyArray<PlacedBlock>;

const isBlank = (line: string | undefined): boolean =>
  line === undefined || line.trim() === "";

const indentOf = (line: string): number => {
  let width = 0;

  for (const char of line) {
    if (char === " ") {
      width += 1;
    } else if (char === "\t") {
      width += 4 - (width % 4);
    } else {
      break;
    }
  }

  return width;
};

/** Removes up to `width` columns of leading whitespace. */
const dedent = (line: string, width: number): string => {
  let removed = 0;
  let index = 0;

  while (index < line.length && removed < width) {
    const char = line[index];

    if (char === " ") {
      removed += 1;
    } else if (char === "\t") {
      removed += 4 - (removed % 4);
    } else {
      break;
    }

    index += 1;
  }

  return line.slice(index);
};

interface Options {
  /** Indented code blocks are off inside list items, where over-indented text stays text. */
  readonly indentedCode: boolean;
}

interface Parsed {
  readonly block: Block;
  readonly next: number;
}

const splitRow = (line: string): ReadonlyArray<string> => {
  const trimmed = line
    .trim()
    .replace(/^\|/u, "")
    .replace(/(?<!\\)\|$/u, "");

  const cells: Array<string> = [];
  let current = "";
  let inCode = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? "";

    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "`") {
      inCode = !inCode;
      current += char;
    } else if (char === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current.trim());

  return cells;
};

const alignmentOf = (cell: string): Alignment => {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");

  if (left && right) {
    return "center";
  }

  if (left) {
    return "left";
  }

  return right ? "right" : "none";
};

const fenceAt = (
  lines: ReadonlyArray<string>,
  at: number
): Option.Option<Parsed> => {
  const open = FENCE.exec(lines[at] ?? "");
  const groups = open?.groups;

  if (groups === undefined) {
    return Option.none();
  }

  const fence = groups.fence ?? "```";
  const info = (groups.info ?? "").trim();

  if (fence.startsWith("`") && info.includes("`")) {
    return Option.none();
  }

  const indent = (groups.indent ?? "").length;

  const closer = new RegExp(
    `^ {0,3}${fence.startsWith("`") ? "`" : "~"}{${fence.length},}[ \\t]*$`,
    "u"
  );

  const body: Array<string> = [];
  let index = at + 1;

  while (index < lines.length && !closer.test(lines[index] ?? "")) {
    body.push(dedent(lines[index] ?? "", indent));
    index += 1;
  }

  const [language = "", ...meta] = info.split(/\s+/u);

  return Option.some({
    block: {
      kind: "code",
      language: language === "" ? Option.none() : Option.some(language),
      meta: meta.length === 0 ? Option.none() : Option.some(meta.join(" ")),
      value: body.join("\n"),
    },
    next: Math.min(lines.length, index + 1),
  });
};

const headingAt = (
  lines: ReadonlyArray<string>,
  at: number
): Option.Option<Parsed> => {
  const groups = HEADING.exec(lines[at] ?? "")?.groups;

  if (groups === undefined) {
    return Option.none();
  }

  const level = HEADING_LEVELS[(groups.marks ?? "#").length - 1] ?? 6;

  return Option.some({
    block: { kind: "heading", level, content: parseInline(groups.text ?? "") },
    next: at + 1,
  });
};

const tableAt = (
  lines: ReadonlyArray<string>,
  at: number
): Option.Option<Parsed> => {
  const headerLine = lines[at] ?? "";
  const delimiter = lines[at + 1] ?? "";

  if (!headerLine.includes("|") || !TABLE_DELIMITER.test(delimiter)) {
    return Option.none();
  }

  const header = splitRow(headerLine);
  const alignments = splitRow(delimiter).map(alignmentOf);

  if (header.length !== alignments.length) {
    return Option.none();
  }

  const rows: Array<
    ReadonlyArray<ReadonlyArray<ReturnType<typeof parseInline>[number]>>
  > = [];

  let index = at + 2;

  while (
    index < lines.length &&
    !isBlank(lines[index]) &&
    (lines[index] ?? "").includes("|")
  ) {
    const cells = splitRow(lines[index] ?? "");

    rows.push(header.map((_, column) => parseInline(cells[column] ?? "")));
    index += 1;
  }

  return Option.some({
    block: {
      kind: "table",
      alignments,
      header: header.map((cell) => parseInline(cell)),
      rows,
    },
    next: index,
  });
};

/** True when `line` starts a block that ends a paragraph. */
const interruptsParagraph = (line: string): boolean => {
  if (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line)
  ) {
    return true;
  }

  const item = LIST_ITEM.exec(line)?.groups;

  if (
    item === undefined ||
    isBlank(line.slice((item.indent ?? "").length + (item.marker ?? "").length))
  ) {
    return false;
  }

  const marker = item.marker ?? "";

  return !/^\d/u.test(marker) || marker.startsWith("1");
};

const paragraphAt = (lines: ReadonlyArray<string>, at: number): Parsed => {
  const body: Array<string> = [lines[at]?.trimStart() ?? ""];
  let index = at + 1;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (
      isBlank(line) ||
      interruptsParagraph(line) ||
      (TABLE_DELIMITER.test(lines[index + 1] ?? "x") && line.includes("|"))
    ) {
      break;
    }

    body.push(line.trimStart());
    index += 1;
  }

  return {
    block: {
      kind: "paragraph",
      content: parseInline(body.join("\n").trimEnd()),
    },
    next: index,
  };
};

const quoteAt = (
  lines: ReadonlyArray<string>,
  at: number,
  parse: ParseBlocks
): Option.Option<Parsed> => {
  if (!QUOTE.test(lines[at] ?? "")) {
    return Option.none();
  }

  const body: Array<string> = [];
  let index = at;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (QUOTE.test(line)) {
      body.push(line.replace(QUOTE, ""));
    } else if (
      !isBlank(line) &&
      !isBlank(body.at(-1)) &&
      !interruptsParagraph(line)
    ) {
      body.push(line);
    } else {
      break;
    }

    index += 1;
  }

  const alert = ALERT.exec(body[0]?.trim() ?? "")?.groups?.kind;
  const inner = alert === undefined ? body : body.slice(1);

  return Option.some({
    block: {
      kind: "quote",
      alert: Option.flatMap(Option.fromUndefinedOr(alert), (kind) =>
        Option.fromUndefinedOr(
          ALERT_KINDS.find((known) => known === kind.toLowerCase())
        )
      ),
      blocks: parse(inner, { indentedCode: true }).map(
        (placed) => placed.block
      ),
    },
    next: index,
  });
};

interface ItemStart {
  readonly indent: number;
  readonly marker: string;
  readonly contentIndent: number;
  readonly first: string;
}

const itemStart = (line: string): Option.Option<ItemStart> => {
  const groups = LIST_ITEM.exec(line)?.groups;

  if (groups === undefined) {
    return Option.none();
  }

  const indent = (groups.indent ?? "").length;
  const marker = groups.marker ?? "-";
  const gap = (groups.gap ?? "").length;
  const rest = line.slice(indent + marker.length + gap);
  const spacing = gap === 0 || gap > 4 ? 1 : gap;

  return Option.some({
    indent,
    marker,
    contentIndent: indent + marker.length + spacing,
    first: gap > 4 ? `${" ".repeat(gap - 1)}${rest}` : rest,
  });
};

const sameListKind = (a: string, b: string): boolean => {
  const ordered = /^\d/u;

  if (ordered.test(a) && ordered.test(b)) {
    return a.at(-1) === b.at(-1);
  }

  return a === b;
};

interface ParsedItem {
  readonly item: ListItem;
  readonly next: number;
  /** A blank line between two of the item's blocks, which makes its list loose. */
  readonly blankInside: boolean;
}

const listItemAt = (
  lines: ReadonlyArray<string>,
  at: number,
  start: ItemStart,
  parse: ParseBlocks
): ParsedItem => {
  const body: Array<string> = [start.first];
  let index = at + 1;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (isBlank(line)) {
      body.push("");
    } else if (indentOf(line) >= start.contentIndent) {
      body.push(dedent(line, start.contentIndent));
    } else if (
      !isBlank(body.at(-1)) &&
      Option.isNone(itemStart(line)) &&
      !interruptsParagraph(line)
    ) {
      body.push(line.trimStart());
    } else {
      break;
    }

    index += 1;
  }

  while (body.length > 1 && isBlank(body.at(-1))) {
    body.pop();
    index -= 1;
  }

  const task = TASK.exec(body[0] ?? "");

  const checked = Option.map(
    Option.fromNullishOr(task?.groups?.mark),
    (mark) => mark !== " "
  );

  if (task !== null) {
    body[0] = (body[0] ?? "").slice(task[0].length);
  }

  return {
    item: {
      checked,
      blocks: parse(body, { indentedCode: false }).map(
        (placed) => placed.block
      ),
    },
    next: index,
    blankInside: body.some((line) => isBlank(line)),
  };
};

const listAt = (
  lines: ReadonlyArray<string>,
  at: number,
  parse: ParseBlocks
): Option.Option<Parsed> =>
  Option.map(itemStart(lines[at] ?? ""), (first) => {
    const items: Array<ListItem> = [];
    let index = at;
    let current = Option.some(first);
    let tight = true;

    while (Option.isSome(current)) {
      const parsed = listItemAt(lines, index, current.value, parse);

      items.push(parsed.item);
      index = parsed.next;
      tight &&= !parsed.blankInside;

      let lookahead = index;

      while (isBlank(lines[lookahead]) && lookahead < lines.length) {
        lookahead += 1;
      }

      const next = Option.filter(
        itemStart(lines[lookahead] ?? ""),
        (candidate) =>
          candidate.indent < first.contentIndent &&
          sameListKind(candidate.marker, first.marker)
      );

      if (Option.isSome(next)) {
        tight &&= lookahead === index;
        index = lookahead;
      }

      current = next;
    }

    const ordered = /^\d/u.test(first.marker);

    return {
      block: {
        kind: "list",
        ordered,
        start: ordered
          ? Option.some(Math.trunc(Number(first.marker.slice(0, -1))))
          : Option.none(),
        tight,
        items,
      },
      next: index,
    };
  });

const indentedCodeAt = (lines: ReadonlyArray<string>, at: number): Parsed => {
  const body: Array<string> = [];
  let index = at;

  while (
    index < lines.length &&
    (isBlank(lines[index]) || indentOf(lines[index] ?? "") >= 4)
  ) {
    body.push(dedent(lines[index] ?? "", 4));
    index += 1;
  }

  while (body.length > 0 && isBlank(body.at(-1))) {
    body.pop();
  }

  return {
    block: {
      kind: "code",
      language: Option.none(),
      meta: Option.none(),
      value: body.join("\n"),
    },
    next: index,
  };
};

/** Tried in order; the first that matches parses the block, else it is a paragraph. */
const BLOCK_PARSERS: ReadonlyArray<
  (
    lines: ReadonlyArray<string>,
    at: number,
    parse: ParseBlocks
  ) => Option.Option<Parsed>
> = [fenceAt, headingAt, quoteAt, listAt, tableAt];

const blockAt = (
  lines: ReadonlyArray<string>,
  at: number,
  options: Options,
  parseNested: ParseBlocks
): Parsed => {
  const line = lines[at] ?? "";

  if (options.indentedCode && indentOf(line) >= 4) {
    return indentedCodeAt(lines, at);
  }

  if (RULE.test(line)) {
    return { block: { kind: "rule" }, next: at + 1 };
  }

  for (const parse of BLOCK_PARSERS) {
    const parsed = parse(lines, at, parseNested);

    if (Option.isSome(parsed)) {
      return parsed.value;
    }
  }

  return paragraphAt(lines, at);
};

/** Parses lines into blocks, each with the line it started on. */
const TOP_LEVEL: Options = { indentedCode: true };

export const parseBlockList = (
  lines: ReadonlyArray<string>,
  options: Options = TOP_LEVEL,
  offset = 0
): ReadonlyArray<PlacedBlock> => {
  const blocks: Array<PlacedBlock> = [];
  let index = 0;

  while (index < lines.length) {
    if (isBlank(lines[index])) {
      index += 1;
      continue;
    }

    const parsed = blockAt(lines, index, options, parseBlockList);

    blocks.push({ block: parsed.block, startLine: offset + index });
    index = Math.max(index + 1, parsed.next);
  }

  return blocks;
};
