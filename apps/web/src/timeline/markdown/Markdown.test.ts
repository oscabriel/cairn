import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import type { Block, Inline } from "./Ast.ts";
import { parseInline } from "./Inline.ts";
import { markdownFor, parseDocument } from "./Markdown.ts";

const blocks = (source: string): ReadonlyArray<Block> =>
  parseDocument(source).blocks.map((placed) => placed.block);

const tightness = (source: string): ReadonlyArray<boolean> =>
  blocks(source).flatMap((block) =>
    block.kind === "list" ? [block.tight] : []
  );

const text = (value: string): Inline => ({ kind: "text", value });

const SAMPLE = [
  "## What a README is for",
  "",
  "A README is the **first** document someone reads, with `code` and a [link](https://example.com).",
  "",
  "- **Orientation:** what it does",
  "- [x] done item",
  "  continued line",
  "",
  "1. first",
  "2. second",
  "   - nested",
  "",
  "```bash",
  "npm install",
  "",
  "npm test",
  "```",
  "",
  "| Name | Size |",
  "| :--- | ---: |",
  "| a.ts | 12 |",
  "| b\\|c | 3 |",
  "",
  "> [!WARNING]",
  "> Mind the gap.",
  "",
  "---",
  "Done.",
].join("\n");

describe("inline markdown", () => {
  it("reads emphasis, strong, strikethrough and code", () => {
    assert.deepStrictEqual(parseInline("a *b* **c** ~~d~~ `e`"), [
      text("a "),
      { kind: "emphasis", content: [text("b")] },
      text(" "),
      { kind: "strong", content: [text("c")] },
      text(" "),
      { kind: "strike", content: [text("d")] },
      text(" "),
      { kind: "code", value: "e" },
    ]);
  });

  it("nests strong and emphasis in a triple run", () => {
    assert.deepStrictEqual(parseInline("***x***"), [
      { kind: "strong", content: [{ kind: "emphasis", content: [text("x")] }] },
    ]);
  });

  it("leaves intraword underscores and lone stars as text", () => {
    assert.deepStrictEqual(parseInline("snake_case_name and 2 * 3"), [
      text("snake_case_name and 2 * 3"),
    ]);
  });

  it("links safe targets, autolinks bare URLs and drops unsafe schemes", () => {
    assert.deepStrictEqual(
      parseInline("[a](javascript:alert(1)) see https://x.dev/p."),
      [
        text("a see "),
        {
          kind: "link",
          url: "https://x.dev/p",
          title: Option.none(),
          content: [text("https://x.dev/p")],
        },
        text("."),
      ]
    );
  });

  it("keeps escapes and reads hard breaks", () => {
    assert.deepStrictEqual(parseInline("\\*not\\* a  \nb"), [
      text("*not* a"),
      { kind: "break" },
      text("b"),
    ]);
  });
});

describe("block markdown", () => {
  it("reads every block kind of a model's reply", () => {
    assert.deepStrictEqual(
      blocks(SAMPLE).map((block) => block.kind),
      [
        "heading",
        "paragraph",
        "list",
        "list",
        "code",
        "table",
        "quote",
        "rule",
        "paragraph",
      ]
    );
  });

  it("reads task items, continuation lines and nested lists", () => {
    const all = blocks(SAMPLE);
    const bullets = all.at(2);
    const numbers = all.at(3);

    assert.isTrue(bullets?.kind === "list" && !bullets.ordered);
    assert.deepStrictEqual(
      bullets?.kind === "list" ? bullets.items.map((item) => item.checked) : [],
      [Option.none(), Option.some(true)]
    );
    assert.deepStrictEqual(
      bullets?.kind === "list" ? bullets.items[1]?.blocks : [],
      [{ kind: "paragraph", content: [text("done item\ncontinued line")] }]
    );
    assert.deepStrictEqual(
      numbers?.kind === "list"
        ? numbers.items[1]?.blocks.map((block) => block.kind)
        : [],
      ["paragraph", "list"]
    );
  });

  it("keeps a fence's blank lines, language and an escaped table pipe", () => {
    const all = blocks(SAMPLE);
    const code = all.at(4);
    const table = all.at(5);

    assert.deepStrictEqual(code, {
      kind: "code",
      language: Option.some("bash"),
      meta: Option.none(),
      value: "npm install\n\nnpm test",
      open: false,
    });
    assert.isTrue(table?.kind === "table");
    assert.deepStrictEqual(table?.kind === "table" ? table.alignments : [], [
      "left",
      "right",
    ]);
    assert.deepStrictEqual(table?.kind === "table" ? table.rows[1]?.[0] : [], [
      text("b|c"),
    ]);
  });

  it("reads a GitHub alert", () => {
    const quote = blocks(SAMPLE).at(6);

    assert.deepStrictEqual(quote, {
      kind: "quote",
      alert: Option.some("warning" as const),
      blocks: [{ kind: "paragraph", content: [text("Mind the gap.")] }],
    });
  });

  it("keeps over-indented text in a list item as text", () => {
    assert.deepStrictEqual(blocks("- item\n\n        still text"), [
      {
        kind: "list",
        ordered: false,
        start: Option.none(),
        tight: false,
        items: [
          {
            checked: Option.none(),
            blocks: [
              { kind: "paragraph", content: [text("item")] },
              { kind: "paragraph", content: [text("still text")] },
            ],
          },
        ],
      },
    ]);
  });

  it("tells a tight list from a loose one", () => {
    assert.deepStrictEqual(tightness("- one\n- two\n- three"), [true]);
    assert.deepStrictEqual(tightness("- one\n\n- two"), [false]);
    assert.deepStrictEqual(tightness("- one\n\n  more\n- two"), [false]);
  });

  it("runs an unclosed fence to the end and marks it open", () => {
    assert.deepStrictEqual(blocks("```ts\nconst a = 1"), [
      {
        kind: "code",
        language: Option.some("ts"),
        meta: Option.none(),
        value: "const a = 1",
        open: true,
      },
    ]);
    assert.deepStrictEqual(
      blocks("```ts\nconst a = 1\n```").map(
        (block) => block.kind === "code" && block.open
      ),
      [false]
    );
  });
});

describe("incremental parse", () => {
  it("gives the same document as a full parse at every prefix of a stream", () => {
    for (let end = 1; end <= SAMPLE.length; end += 7) {
      const prefix = SAMPLE.slice(0, end);

      assert.deepStrictEqual(
        Option.map(
          markdownFor("stream", prefix),
          (document) => document.blocks
        ),
        Option.some(parseDocument(prefix).blocks),
        `prefix of ${end}`
      );
    }
  });

  it("reuses the settled blocks of a growing message", () => {
    const first = markdownFor("reuse", "# Title\n\npara one\n\npara");
    const second = markdownFor("reuse", "# Title\n\npara one\n\npara two");

    assert.strictEqual(
      Option.map(first, (document) => document.blocks[0]).pipe(
        Option.getOrUndefined
      ),
      Option.map(second, (document) => document.blocks[0]).pipe(
        Option.getOrUndefined
      )
    );
  });
});

describe("unmatched brackets", () => {
  it("parse in linear time: 20,000 [ in under 20 ms", () => {
    const brackets = "[".repeat(20_000);

    parseInline(brackets);

    const started = performance.now();

    parseInline(brackets);
    parseInline(`${brackets}]`);

    assert.isBelow(performance.now() - started, 40);
  });
});
