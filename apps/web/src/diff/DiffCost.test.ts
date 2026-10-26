// What the open diff panel spends on a render, with a highlighter stub that counts what it
// tokenizes: a 300-hunk patch is parsed once and its files tokenized once, by their Mounts, so a
// second render of the same Model reuses every file's view, parses nothing and tokenizes nothing;
// and the panel draws at most `MAX_TOTAL_LINES` lines across its files.

import { ThreadId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema, Stream } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";
import { Lazy } from "foldkit/test";
import { beforeEach } from "vitest";

import { setHighlighter, sliceTokens } from "../timeline/markdown/Highlight.ts";
import type { Highlighter } from "../timeline/markdown/Highlight.ts";
import { LoadDiffHighlighting } from "./Command.ts";
import { Message } from "./Message.ts";
import { DiffLoad, initial } from "./Model.ts";
import type { Model } from "./Model.ts";
import { update } from "./Update.ts";
import { MAX_TOTAL_LINES, view as panelView } from "./View.ts";

const tokenized: Array<string> = [];

const countingHighlighter: Highlighter = {
  getLoadedLanguages: () => ["typescript"],
  codeToTokens: (code) => {
    tokenized.push(code);

    return {
      tokens: code.split("\n").map((line) => [
        {
          content: line,
          offset: 0,
          htmlStyle: { "--shiki-light": "#0550ae", "--shiki-dark": "#79c0ff" },
        },
      ]),
    };
  },
};

const FILES = 60;

const HUNKS_PER_FILE = 5;

/** One file's diff: `hunks` hunks of a context line, a change and a closing context line. */
const fileDiff = (path: string, hunks: number, linesPerHunk: number) => [
  `diff --git a/${path} b/${path}`,
  "index 5626abf..1e1b65b 100644",
  `--- a/${path}`,
  `+++ b/${path}`,
  ...Array.from({ length: hunks }, (_, hunk) => {
    const start = 1 + hunk * (linesPerHunk + 10);

    return [
      `@@ -${String(start)},${String(linesPerHunk)} +${String(start)},${String(linesPerHunk)} @@`,
      ...Array.from({ length: linesPerHunk }, (_empty, line) =>
        line === 1
          ? `-export const ${path.replaceAll(/\W/gu, "_")}_${String(hunk)} = 1;`
          : `+export const ${path.replaceAll(/\W/gu, "_")}_${String(hunk)}_${String(line)} = 2;`
      ),
    ];
  }).flat(),
];

const patchOf = (files: ReadonlyArray<ReadonlyArray<string>>): string =>
  [...files.flat(), ""].join("\n");

const loaded = (patch: string): Model => ({
  ...initial,
  target: Option.some({
    threadId: ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-000000000001"),
    turn: 2,
  }),
  load: DiffLoad.Loaded({ patch }),
  highlightedLanguages: ["typescript"],
});

const testView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: "diff",
    model,
    view: panelView,
    toParentMessage: (message: Message) => message,
  });

const config = { update, view: testView };

const MountArgs = Schema.Struct({
  language: Schema.String,
  code: Schema.Option(Schema.String),
});

const decodeMountArgs = Schema.decodeUnknownOption(MountArgs);

const resolveMounts = (count: number) =>
  Array.from({ length: count }, () =>
    Scene.Mount.resolve(
      LoadDiffHighlighting,
      Message.LoadedLanguage({ language: "typescript" })
    )
  );

describe("the diff panel's cost", () => {
  beforeEach(() => {
    tokenized.length = 0;
    setHighlighter(countingHighlighter);
  });

  it.live(
    "renders a 300-hunk patch a second time with no parse and no tokenization",
    () =>
      Effect.gen(function* () {
        const patch = patchOf(
          Array.from({ length: FILES }, (_, file) =>
            fileDiff(`src/cost${String(file)}.ts`, HUNKS_PER_FILE, 4)
          )
        );

        const model = loaded(patch);
        const mounted: Array<typeof MountArgs.Type> = [];

        Scene.scene(
          config,
          Scene.given(model),
          Scene.tap(({ mounts }) => {
            mounted.push(
              ...mounts.flatMap((mount) =>
                Option.toArray(decodeMountArgs(mount.args))
              )
            );
          }),
          ...resolveMounts(FILES)
        );

        // What each file's Mount does: its shown lines, tokenized into the cache.
        for (const args of mounted) {
          yield* Option.match(args.code, {
            onNone: () => Effect.void,
            onSome: (code) => Stream.runDrain(sliceTokens(code, args.language)),
          });
        }

        assert.strictEqual(mounted.length, FILES);
        assert.strictEqual(tokenized.length, FILES);

        tokenized.length = 0;

        // Renders the same Model twice; throws unless the second reuses every file's view, which a
        // new parse (new file objects) or new tokens would not allow.
        Lazy.expectAllReused({ view: testView, model });

        assert.strictEqual(tokenized.length, 0);
      })
  );

  it("draws at most MAX_TOTAL_LINES lines across its files", () => {
    const patch = patchOf(
      ["a", "b", "c", "d"].map((name) => fileDiff(`${name}.txt`, 1, 1500))
    );

    Scene.scene(
      config,
      Scene.given(loaded(patch)),
      Scene.expectAll(
        Scene.all.selector('[data-diff-file="a.txt"] [data-kind]')
      ).toHaveCount(1500),
      Scene.expectAll(
        Scene.all.selector('[data-diff-file="c.txt"] [data-kind]')
      ).toHaveCount(MAX_TOTAL_LINES - 3000),
      Scene.expect(Scene.selector('[data-diff-file="c.txt"]')).toContainText(
        `${String(4500 - MAX_TOTAL_LINES)} more lines not shown`
      ),
      Scene.expectAll(
        Scene.all.selector('[data-diff-file="d.txt"] [data-kind]')
      ).toHaveCount(0),
      Scene.expect(Scene.selector('[data-diff-file="d.txt"]')).toContainText(
        "1500 more lines not shown"
      ),
      Scene.tap(({ commands }) => {
        assert.strictEqual(commands.length, 0);
      })
    );
  });
});
