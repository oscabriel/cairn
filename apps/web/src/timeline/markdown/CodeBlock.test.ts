// Scene tests for a code block in the streaming message, with a highlighter stub that counts what it
// tokenizes: a fence still growing stays plain and costs nothing; a short one is tokenized once
// when it closes, and the commit reuses it; a long one is tokenized once, a slice at a time, by its
// Mount after the message commits, drawn as far as the slices have gone, and never tokenized in one
// go by a render.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Scene from "foldkit/scene";
import { beforeEach } from "vitest";

import { LoadHighlighting } from "../Command.ts";
import { Message as TimelineMessage } from "../Message.ts";
import { setHighlighter, SLICE_CHARS, sliceTokens } from "./Highlight.ts";
import type { Highlighter } from "./Highlight.ts";
import { markdownView } from "./View.ts";

const FRAMES = 200;

const tokenized: Array<string> = [];

const linesTokenized = (): number =>
  tokenized.reduce((sum, code) => sum + code.split("\n").length, 0);

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

/** The first `count` lines of a fence named `name`; each name gives its own cache entries. */
const fenceCode = (name: string, count: number): string =>
  Array.from(
    { length: count },
    (_, line) =>
      `export const ${name}${String(line)} = (value: number): number => value * ${String(line)};`
  ).join("\n");

interface Reply {
  readonly text: string;
  readonly streaming: boolean;
}

interface Model {
  readonly name: string;
  readonly lines: number;
  readonly frame: number;
  readonly closed: boolean;
  readonly streaming: boolean;
}

const Message = defineMessageUnion({
  ClickedGrow: {},
  ClickedClose: {},
  ClickedCommit: {},
  GotMarkdownMessage: { message: TimelineMessage },
});

type Message = typeof Message.Type;

/** The reply after `frame` of `FRAMES` frames: a TS fence whose lines grow to `model.lines`. */
const textOf = (model: Model): string =>
  [
    "Here is the module:",
    "",
    "```ts",
    fenceCode(model.name, Math.ceil((model.lines * model.frame) / FRAMES)),
    ...(model.closed ? ["```", "", "Done."] : []),
  ].join("\n");

const update = (model: Model, message: Message) =>
  Message.match(message, {
    ClickedGrow: () => ({ model: { ...model, frame: model.frame + 1 } }),
    ClickedClose: () => ({ model: { ...model, closed: true } }),
    ClickedCommit: () => ({ model: { ...model, streaming: false } }),
    GotMarkdownMessage: () => ({ model }),
  });

const replyView = Submodel.defineView<Reply, TimelineMessage>((reply, h) =>
  markdownView(
    {
      h,
      rowId: "reply",
      highlightedLanguages: ["typescript"],
      copiedRowId: Option.none(),
    },
    reply.text,
    reply.streaming
  )
);

const button = (h: HtmlBuilder<Message>, testId: string, message: Message) =>
  h.button([h.DataAttribute("testid", testId), h.OnClick(message)], [testId]);

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      button(h, "grow", Message.ClickedGrow()),
      button(h, "close", Message.ClickedClose()),
      button(h, "commit", Message.ClickedCommit()),
      h.submodel({
        slotId: "reply",
        model: { text: textOf(model), streaming: model.streaming },
        view: replyView,
        toParentMessage: (message: TimelineMessage) =>
          Message.GotMarkdownMessage({ message }),
      }),
    ]
  );

const config = { update, view };

const streaming = (name: string, lines: number): Model => ({
  name,
  lines,
  frame: 1,
  closed: false,
  streaming: true,
});

const loaded = Scene.Mount.resolve(
  LoadHighlighting,
  TimelineMessage.LoadedLanguage({ language: "typescript" })
);

const grow = Array.from({ length: FRAMES - 1 }, () =>
  Scene.click(Scene.testId("grow"))
);

const code = Scene.selector('[data-slot="code-block"] code');

describe("a code block in the streaming message", () => {
  beforeEach(() => {
    tokenized.length = 0;
    setHighlighter(countingHighlighter);
  });

  it.live(
    "stays plain through 200 frames of a 300-line fence, then is tokenized once, in slices, at commit",
    () =>
      Effect.gen(function* () {
        Scene.scene(
          config,
          Scene.given(streaming("grown", 300)),
          loaded,
          ...grow,
          Scene.expect(code).toHaveAttr("data-highlighted", "false"),
          Scene.tap(() => {
            assert.strictEqual(tokenized.length, 0);
          }),
          Scene.click(Scene.testId("commit")),
          Scene.expect(code).toHaveAttr("data-highlighted", "false"),
          Scene.tap(() => {
            assert.strictEqual(tokenized.length, 0);
          })
        );

        // What the block's Mount does once the message has committed: one slice, then (as after an
        // unmount and a new mount) the rest, going on from where the first stopped.
        const code300 = fenceCode("grown", 300);

        const first = yield* Stream.runCollect(
          Stream.take(sliceTokens(code300, "typescript"), 1)
        );

        assert.strictEqual(tokenized.length, 1);

        Scene.scene(
          config,
          Scene.given({ ...streaming("grown", 300), frame: FRAMES }),
          loaded,
          Scene.click(Scene.testId("commit")),
          Scene.expect(code).toHaveAttr("data-highlighted", "partly"),
          Scene.expect(code).toHaveText(code300)
        );

        const rest = yield* Stream.runCollect(
          sliceTokens(code300, "typescript")
        );

        assert.deepStrictEqual([...first, ...rest].at(-1), 300);
        assert.strictEqual(linesTokenized(), 300);
        assert.isAbove(tokenized.length, 2);
        assert.isTrue(tokenized.every((slice) => slice.length <= SLICE_CHARS));

        const slices = tokenized.length;

        Scene.scene(
          config,
          Scene.given({ ...streaming("grown", 300), frame: FRAMES }),
          loaded,
          Scene.click(Scene.testId("commit")),
          Scene.expect(code).toHaveAttr("data-highlighted", "true"),
          Scene.expect(code).toHaveText(code300)
        );

        const again = yield* Stream.runCollect(
          sliceTokens(code300, "typescript")
        );

        assert.strictEqual(again.length, 0);
        assert.strictEqual(tokenized.length, slices);
      })
  );

  it("is tokenized once when a short fence closes, and the commit reuses it", () => {
    assert.isAtMost(fenceCode("short", 10).length, SLICE_CHARS);

    Scene.scene(
      config,
      Scene.given(streaming("short", 10)),
      loaded,
      ...grow,
      Scene.expect(code).toHaveAttr("data-highlighted", "false"),
      Scene.click(Scene.testId("close")),
      Scene.expect(code).toHaveAttr("data-highlighted", "true"),
      Scene.click(Scene.testId("commit")),
      Scene.expect(code).toHaveAttr("data-highlighted", "true"),
      Scene.tap(() => {
        assert.deepStrictEqual(tokenized, [fenceCode("short", 10)]);
      })
    );
  });
});
