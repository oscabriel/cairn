// Inline markdown: code spans, emphasis, strong, strikethrough, links, images, autolinks, hard
// breaks and backslash escapes, as GitHub renders a model's reply. New code: the plan's pipeline
// (D30) is v1's remark parse, but remark and unified are not in Cairn's catalog, so the parse is
// written here. It is total: anything it does not recognise stays text. Unsafe link targets (any
// scheme but http, https and mailto) render as their text.
import { Option } from "effect";

import type { Inline } from "./Ast.ts";

const ESCAPABLE = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");

const SAFE_URL = /^(?:https?:\/\/|mailto:)/iu;

const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<?!.,:;*_~'")\]]/iu;

const LINK_TARGET =
  /^\(\s*(?<url><[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+"(?<title>[^"]*)")?\s*\)/u;

const isWhitespace = (char: string | undefined): boolean =>
  char === undefined || /\s/u.test(char);

const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** Accepts `url` when it is safe to put in an `href`. */
export const safeUrl = (url: string): Option.Option<string> => {
  const trimmed = url.trim();

  if (trimmed.toLowerCase().startsWith("www.")) {
    return Option.some(`https://${trimmed}`);
  }

  return SAFE_URL.test(trimmed) ? Option.some(trimmed) : Option.none();
};

/** Collects inline nodes, merging adjacent text. */
class Builder {
  readonly nodes: Array<Inline> = [];

  text(value: string): void {
    if (value === "") {
      return;
    }

    const last = this.nodes.at(-1);

    if (last?.kind === "text") {
      this.nodes[this.nodes.length - 1] = {
        kind: "text",
        value: last.value + value,
      };
    } else {
      this.nodes.push({ kind: "text", value });
    }
  }

  push(node: Inline): void {
    this.nodes.push(node);
  }
}

const runLength = (text: string, at: number, char: string): number => {
  let end = at;

  while (text[end] === char) {
    end += 1;
  }

  return end - at;
};

/** A code span opening at `at`: its value and the index after it. */
const codeSpan = (
  text: string,
  at: number
): Option.Option<{ readonly value: string; readonly end: number }> => {
  const length = runLength(text, at, "`");
  let search = at + length;

  while (search < text.length) {
    const close = text.indexOf("`", search);

    if (close === -1) {
      return Option.none();
    }

    const closeLength = runLength(text, close, "`");

    if (closeLength === length) {
      const raw = text.slice(at + length, close).replaceAll("\n", " ");

      const value =
        raw.length > 2 &&
        raw.startsWith(" ") &&
        raw.endsWith(" ") &&
        raw.trim() !== ""
          ? raw.slice(1, -1)
          : raw;

      return Option.some({ value, end: close + closeLength });
    }

    search = close + closeLength;
  }

  return Option.none();
};

/**
 * Every bracket pair in `text`, by the index of its `[`: one pass with a stack, skipping escapes
 * and code spans. Scanning to the end from each `[` instead was quadratic on unmatched brackets
 * (20,000 took 602 ms, paid again on every delta of the last block; T51).
 */
const bracketPairs = (text: string): ReadonlyMap<number, number> => {
  const pairs = new Map<number, number>();
  const open: Array<number> = [];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "\\") {
      index += 1;
    } else if (char === "`") {
      const span = codeSpan(text, index);

      index = Option.match(span, {
        onNone: () => index + runLength(text, index, "`") - 1,
        onSome: ({ end }) => end - 1,
      });
    } else if (char === "[") {
      open.push(index);
    } else if (char === "]") {
      const opener = open.pop();

      if (opener !== undefined) {
        pairs.set(opener, index);
      }
    }
  }

  return pairs;
};

interface LinkMatch {
  readonly label: string;
  readonly url: string;
  readonly title: Option.Option<string>;
  readonly end: number;
}

/** A `[label](url "title")` starting at the `[` at `at`. */
const linkAt = (
  text: string,
  at: number,
  brackets: ReadonlyMap<number, number>
): Option.Option<LinkMatch> => {
  const close = brackets.get(at);

  if (close === undefined) {
    return Option.none();
  }

  const target = LINK_TARGET.exec(text.slice(close + 1));

  if (target?.groups === undefined) {
    return Option.none();
  }

  const url = (target.groups.url ?? "").replace(
    /^<(?<inner>.*)>$/u,
    "$<inner>"
  );

  return Option.some({
    label: text.slice(at + 1, close),
    url,
    title: Option.fromUndefinedOr(target.groups.title),
    end: close + 1 + target[0].length,
  });
};

const canOpen = (
  text: string,
  at: number,
  length: number,
  char: string
): boolean => {
  const after = text[at + length];
  const before = text[at - 1];

  if (isWhitespace(after)) {
    return false;
  }

  return char !== "_" || !isWordChar(before);
};

const canClose = (
  text: string,
  at: number,
  length: number,
  char: string
): boolean => {
  const before = text[at - 1];
  const after = text[at + length];

  if (isWhitespace(before)) {
    return false;
  }

  return char !== "_" || !isWordChar(after);
};

interface DelimiterMatch {
  readonly close: number;
  readonly closeLength: number;
}

/** The run of `char` that closes an opener of `minimum` or more, skipping code spans. */
const closingRun = (
  text: string,
  from: number,
  char: string,
  minimum: number
): Option.Option<DelimiterMatch> => {
  let index = from;

  while (index < text.length) {
    const current = text[index];

    if (current === "\\") {
      index += 2;
      continue;
    }

    if (current === "`") {
      const span = codeSpan(text, index);

      index = Option.isSome(span)
        ? span.value.end
        : index + runLength(text, index, "`");
      continue;
    }

    if (current !== char) {
      index += 1;
      continue;
    }

    const length = runLength(text, index, char);

    if (length >= minimum && canClose(text, index, length, char)) {
      return Option.some({ close: index, closeLength: length });
    }

    index += length;
  }

  return Option.none();
};

interface Step {
  readonly end: number;
}

/** Parses nested inline text; `parseInline` passes itself, so the steps can recurse. */
type Parse = (text: string) => ReadonlyArray<Inline>;

/** Where a step reads: the text, the position of its special character, and the output. */
interface Cursor {
  readonly text: string;
  readonly at: number;
  readonly out: Builder;
  readonly parse: Parse;
  /** The text's bracket pairs, computed on first use (`bracketPairs`). */
  readonly brackets: () => ReadonlyMap<number, number>;
}

const emphasisAt = ({ at, out, parse, text }: Cursor): Option.Option<Step> => {
  const char = text[at] ?? "";
  const length = runLength(text, at, char);
  const strike = char === "~";

  if ((strike && length !== 2) || !canOpen(text, at, length, char)) {
    return Option.none();
  }

  return Option.map(
    closingRun(text, at + length, char, strike ? 2 : 1),
    ({ close, closeLength }) => {
      const used = strike ? 2 : Math.min(length, closeLength, 2);
      const inner = `${char.repeat(length - used)}${text.slice(at + length, close)}${char.repeat(closeLength - used)}`;
      const content = parse(inner);

      if (strike) {
        out.push({ kind: "strike", content });
      } else {
        out.push(
          used === 2
            ? { kind: "strong", content }
            : { kind: "emphasis", content }
        );
      }

      return { end: close + closeLength };
    }
  );
};

const linkOrTextAt = (cursor: Cursor, image: boolean): Option.Option<Step> => {
  const { at, brackets, out, parse, text } = cursor;

  return Option.map(linkAt(text, image ? at + 1 : at, brackets()), (link) => {
    if (image) {
      out.push({ kind: "image", url: link.url, alt: link.label });

      return { end: link.end };
    }

    Option.match(safeUrl(link.url), {
      onNone: () => {
        for (const node of parse(link.label)) {
          if (node.kind === "text") {
            out.text(node.value);
          } else {
            out.push(node);
          }
        }
      },
      onSome: (url) => {
        out.push({
          kind: "link",
          url,
          title: link.title,
          content: parse(link.label),
        });
      },
    });

    return { end: link.end };
  });
};

const autolinkAt = ({ at, out, text }: Cursor): Option.Option<Step> => {
  if (text[at] === "<") {
    const close = text.indexOf(">", at);
    const inner = close === -1 ? "" : text.slice(at + 1, close);

    return Option.map(
      Option.filter(safeUrl(inner), () => !/\s/u.test(inner)),
      (url) => {
        out.push({
          kind: "link",
          url,
          title: Option.none(),
          content: [{ kind: "text", value: inner }],
        });

        return { end: close + 1 };
      }
    );
  }

  if (isWordChar(text[at - 1])) {
    return Option.none();
  }

  return Option.flatMap(
    Option.fromNullishOr(BARE_URL.exec(text.slice(at))),
    ([found]) =>
      Option.map(safeUrl(found), (url) => {
        out.push({
          kind: "link",
          url,
          title: Option.none(),
          content: [{ kind: "text", value: found }],
        });

        return { end: at + found.length };
      })
  );
};

const trimTrailing = (node: Inline | undefined): Inline =>
  node?.kind === "text"
    ? { kind: "text", value: node.value.trimEnd() }
    : (node ?? { kind: "text", value: "" });

const breakAt = ({ at, out, text }: Cursor): Option.Option<Step> => {
  const next = text[at + 1] ?? "";

  if (text[at] === "\\" && next === "\n") {
    out.push({ kind: "break" });

    return Option.some({ end: at + 2 });
  }

  if (text[at] === "\\" && ESCAPABLE.has(next)) {
    out.text(next);

    return Option.some({ end: at + 2 });
  }

  if (text[at] !== "\n") {
    return Option.none();
  }

  if (text.slice(Math.max(0, at - 2), at) === "  ") {
    out.nodes[out.nodes.length - 1] = trimTrailing(out.nodes.at(-1));
    out.push({ kind: "break" });
  } else {
    out.text("\n");
  }

  return Option.some({ end: at + 1 });
};

const codeAt = ({ at, out, text }: Cursor): Option.Option<Step> =>
  Option.map(codeSpan(text, at), ({ end, value }) => {
    out.push({ kind: "code", value });

    return { end };
  });

/** The step for each character that may start inline syntax. */
const STEPS: ReadonlyMap<string, (cursor: Cursor) => Option.Option<Step>> =
  new Map([
    ["`", codeAt],
    ["*", emphasisAt],
    ["_", emphasisAt],
    ["~", emphasisAt],
    ["[", (cursor: Cursor) => linkOrTextAt(cursor, false)],
    [
      "!",
      (cursor: Cursor) =>
        cursor.text[cursor.at + 1] === "["
          ? linkOrTextAt(cursor, true)
          : Option.none(),
    ],
    ["<", autolinkAt],
    ["h", autolinkAt],
    ["w", autolinkAt],
    ["\\", breakAt],
    ["\n", breakAt],
  ]);

/** Parses a paragraph's text (lines joined by `\n`) into inline nodes. */
export const parseInline = (text: string): ReadonlyArray<Inline> => {
  const out = new Builder();
  let at = 0;
  let plainFrom = 0;
  let pairs: ReadonlyMap<number, number> | undefined;

  const brackets = () => {
    pairs ??= bracketPairs(text);

    return pairs;
  };

  while (at < text.length) {
    const step = STEPS.get(text[at] ?? "");

    if (step === undefined) {
      at += 1;
      continue;
    }

    out.text(text.slice(plainFrom, at));
    plainFrom = at;

    const taken = step({ text, at, out, parse: parseInline, brackets });

    if (Option.isNone(taken)) {
      at += 1;
      continue;
    }

    at = taken.value.end;
    plainFrom = at;
  }

  out.text(text.slice(plainFrom));

  return out.nodes;
};
