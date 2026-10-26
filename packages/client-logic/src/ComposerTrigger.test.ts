// Ported from github.com/pingdotgg/t3code, packages/shared/src/composerTrigger.test.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: the currency-symbol skill cases are now a
// literal `$` only (the other symbols must not trigger), and Cairn's own cases for `/` at a line
// start, `@` searches and the stale-range refusal are added. MIT License, Copyright (c) 2026 T3
// Tools Inc.; the full notice is in ComposerTrigger.ts.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  applyTriggerReplacement,
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
} from "./ComposerTrigger.ts";
import type { ComposerTrigger } from "./ComposerTrigger.ts";

const at = (text: string, cursor = text.length) =>
  detectComposerTrigger(text, cursor);

describe(detectComposerTrigger, () => {
  it.each([
    ["Run /tmp/build.sh", "Run /tmp/build.sh".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
    ["/tmp/x", "/tmp/x".length],
  ])("keeps the path in %j out of the slash menu", (text, cursor) => {
    assert.isTrue(Option.isNone(at(text, cursor)));
  });

  it("opens the command menu for a slash at the start of a line", () => {
    assert.deepStrictEqual(
      at("/"),
      Option.some({
        kind: "slash-command",
        query: "",
        rangeStart: 0,
        rangeEnd: 1,
      })
    );
    assert.deepStrictEqual(
      at("first line\n/rev"),
      Option.some({
        kind: "slash-command",
        query: "rev",
        rangeStart: 11,
        rangeEnd: 15,
      })
    );
  });

  it("keeps a slash in the line-leading model picker query", () => {
    assert.deepStrictEqual(
      Option.map(at("/model openai/gpt", 17), ({ kind, query }) => ({
        kind,
        query,
      })),
      Option.some({ kind: "slash-model", query: "openai/gpt" })
    );
    assert.deepStrictEqual(
      Option.map(at("/model"), ({ kind }) => kind),
      Option.some("slash-model")
    );
  });

  it.each(["Use ", "Use\t", "Use\n  "])(
    "detects inline slash skills after %j",
    (prefix) => {
      const text = `${prefix}/skill:review later`;
      const cursor = `${prefix}/skill:review`.length;

      assert.deepStrictEqual(
        at(text, cursor),
        Option.some({
          kind: "slash-command",
          query: "skill:review",
          rangeStart: prefix.length,
          rangeEnd: cursor,
        })
      );
    }
  );

  it.each(["Use /", "Use /review"])(
    "detects the inline slash token in %j",
    (text) => {
      assert.deepStrictEqual(
        at(text),
        Option.some({
          kind: "slash-command",
          query: text.slice(5),
          rangeStart: 4,
          rangeEnd: text.length,
        })
      );
    }
  );

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => {
      assert.isTrue(Option.isNone(at(text)));
    }
  );

  it("detects a $ skill and its source range", () => {
    assert.deepStrictEqual(
      at("Use $review"),
      Option.some({
        kind: "skill",
        query: "review",
        rangeStart: 4,
        rangeEnd: 11,
      })
    );
  });

  it.each(["€", "£", "¥"])(
    "does not treat %s as a skill prefix (only $ is)",
    (prefix) => {
      assert.isTrue(Option.isNone(at(`Use ${prefix}review`)));
    }
  );

  it("detects an @ file search with its query", () => {
    assert.deepStrictEqual(
      at("look at @src"),
      Option.some({ kind: "path", query: "src", rangeStart: 8, rangeEnd: 12 })
    );
  });

  it("clamps a caret past the end", () => {
    assert.deepStrictEqual(
      Option.map(at("@a", 99), ({ query }) => query),
      Option.some("a")
    );
  });
});

describe(serializeComposerFileLink, () => {
  it("uses the basename as the markdown label", () => {
    assert.strictEqual(
      serializeComposerFileLink("path/to/package.json"),
      "[package.json](path/to/package.json)"
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    assert.strictEqual(
      serializeComposerFileLink("docs/My File (draft).md"),
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)"
    );
  });

  it("supports windows paths", () => {
    assert.strictEqual(
      serializeComposerFileLink("C:\\repo\\src\\index.ts"),
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)"
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    assert.strictEqual(
      serializeComposerFileLink("@scope/package.json"),
      "[package.json](@scope/package.json)"
    );
  });
});

describe(replaceTextRange, () => {
  it("replaces the range and puts the caret after the replacement", () => {
    assert.deepStrictEqual(replaceTextRange("see @sr now", 4, 7, "[x](x) "), {
      text: "see [x](x)  now",
      cursor: 11,
    });
  });

  it("clamps a stale range", () => {
    assert.deepStrictEqual(replaceTextRange("abc", 5, 9, "!"), {
      text: "abc!",
      cursor: 4,
    });
  });

  it("refuses a pick when the trigger's text changed since it was read", () => {
    const read: ComposerTrigger = {
      kind: "path",
      query: "sr",
      rangeStart: 4,
      rangeEnd: 7,
    };

    assert.isTrue(
      Option.isSome(applyTriggerReplacement("see @sr", read, "@sr", "[a](a) "))
    );
    assert.isTrue(
      Option.isNone(applyTriggerReplacement("see @xy", read, "@sr", "[a](a) "))
    );
  });
});
