// Scene tests for the diff panel, driven as the user drives it: opening a turn's diff at a file
// (what a changed-files card's row sends while the panel is on), the patch arrives and shows as
// files and numbered lines, the scope switch asks again, a failure offers Retry, Close empties the
// panel, and the chat header's toggle opens the whole diff and closes it.

import { ThreadId } from "@cairn/protocol/Ids";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";
import { describe, expect, it } from "vitest";

import { formatCompactCount } from "./Card.ts";
import { FetchDiff, ScrollToFile } from "./Command.ts";
import { Message } from "./Message.ts";
import { initial, isOpen } from "./Model.ts";
import type { Model } from "./Model.ts";
import { diffToggle } from "./ToggleView.ts";
import { update } from "./Update.ts";
import { languageOfPath, view as panelView } from "./View.ts";

const threadId = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-000000000001");

const patch = [
  "diff --git a/b.txt b/b.txt",
  "new file mode 100644",
  "index 0000000..a8de70b",
  "--- /dev/null",
  "+++ b/b.txt",
  "@@ -0,0 +1 @@",
  "+bee",
  "diff --git a/notes/a.txt b/notes/a.txt",
  "index 5626abf..1e1b65b 100644",
  "--- a/notes/a.txt",
  "+++ b/notes/a.txt",
  "@@ -1,2 +1,2 @@",
  " one",
  "-two",
  "+deux",
  "",
].join("\n");

/**
 * A button that sends what a changed-files card's row for `notes/a.txt` in turn 2 sends, beside the
 * panel the thread page mounts.
 */
const testView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      h.button(
        [
          h.Type("button"),
          h.OnClick(
            Message.RequestedOpen({
              threadId,
              turn: 2,
              path: Option.some("notes/a.txt"),
            })
          ),
        ],
        ["Open notes/a.txt"]
      ),
      h.submodel({
        slotId: "diff",
        model,
        view: panelView,
        toParentMessage: (message: Message) => message,
      }),
    ]
  );

const config = { update, view: testView };

const fetchFor = (version: number, scope: "turn" | "full") =>
  FetchDiff({ version, threadId, turn: 2, scope, ignoreWhitespace: false });

describe("the diff panel", () => {
  it("opens the diff at a file, shows it, switches scope, retries and closes", () => {
    Scene.scene(
      config,
      Scene.given(initial),
      Scene.click(Scene.role("button", { name: "Open notes/a.txt" })),
      Scene.expect(Scene.selector('[data-testid="diff-status"]')).toHaveText(
        "Loading the diff..."
      ),
      Scene.Command.resolve(
        fetchFor(1, "turn"),
        Message.LoadedDiff({ version: 1, patch })
      ),
      Scene.Command.resolve(
        ScrollToFile({ path: "notes/a.txt" }),
        Message.ScrolledToFile()
      ),
      Scene.expect(Scene.selector('[data-testid="diff-panel"] h2')).toHaveText(
        "Turn 2"
      ),
      Scene.expect(
        Scene.selector('[data-diff-file="notes/a.txt"] [data-kind="added"]')
      ).toContainText("deux"),
      Scene.expect(
        Scene.selector('[data-diff-file="notes/a.txt"] [data-kind="removed"]')
      ).toContainText("two"),
      Scene.expect(Scene.selector('[data-diff-file="b.txt"]')).toContainText(
        "Added"
      ),
      Scene.expect(
        Scene.selector('[data-diff-tree-file="notes/a.txt"]')
      ).toExist(),
      Scene.click(Scene.role("button", { name: "All turns" })),
      Scene.Command.resolve(
        fetchFor(2, "full"),
        Message.FailedDiff({
          version: 2,
          message: "diff.full: thread has no checkpoint for turn 0.",
        })
      ),
      Scene.expect(Scene.selector('[data-testid="diff-status"]')).toContainText(
        "no checkpoint for turn 0"
      ),
      Scene.click(Scene.role("button", { name: "Retry" })),
      Scene.Command.resolve(
        fetchFor(3, "full"),
        Message.LoadedDiff({ version: 3, patch: "" })
      ),
      Scene.Command.resolve(
        ScrollToFile({ path: "notes/a.txt" }),
        Message.ScrolledToFile()
      ),
      Scene.expect(Scene.selector('[data-testid="diff-status"]')).toHaveText(
        "The thread changed no files."
      ),
      Scene.click(Scene.role("button", { name: "Close diff" })),
      Scene.expect(Scene.selector('[data-testid="diff-panel"]')).toBeAbsent(),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });

  it("opens the whole diff from the header toggle and closes it again", () => {
    const toggle = Message.ClickedToggle({ threadId, latestTurn: 2 });

    const toggleView = (model: Model, h: HtmlBuilder<Message>): Html =>
      h.div(
        [],
        [
          diffToggle(h, isOpen(model), Option.some(toggle)),
          h.submodel({
            slotId: "diff",
            model,
            view: panelView,
            toParentMessage: (message: Message) => message,
          }),
        ]
      );

    Scene.scene(
      { update, view: toggleView },
      Scene.given(initial),
      Scene.expect(
        Scene.role("button", { name: "Toggle diff panel" })
      ).toHaveAttr("aria-pressed", "false"),
      Scene.click(Scene.role("button", { name: "Toggle diff panel" })),
      Scene.Command.resolve(
        fetchFor(1, "full"),
        Message.LoadedDiff({ version: 1, patch })
      ),
      Scene.expect(
        Scene.role("button", { name: "Toggle diff panel" })
      ).toHaveAttr("aria-pressed", "true"),
      Scene.expect(
        Scene.selector('[data-diff-file="notes/a.txt"] [data-kind="added"]')
      ).toContainText("deux"),
      Scene.click(Scene.role("button", { name: "Toggle diff panel" })),
      Scene.expect(Scene.selector('[data-testid="diff-panel"]')).toBeAbsent(),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });

  it("disables the toggle while the thread has nothing to show", () => {
    Scene.scene(
      {
        update,
        view: (_model: Model, h: HtmlBuilder<Message>) =>
          diffToggle(h, false, Option.none()),
      },
      Scene.given(initial),
      Scene.expect(
        Scene.role("button", { name: "Toggle diff panel" })
      ).toBeDisabled(),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });

  it("drops an answer for a request the user already left", () => {
    const opened = update(
      initial,
      Message.RequestedOpen({ threadId, turn: 2, path: Option.none() })
    ).model;

    const closed = update(opened, Message.ClickedClose()).model;
    const late = update(closed, Message.LoadedDiff({ version: 1, patch }));

    expect(Option.isNone(late.model.target)).toBeTruthy();
    expect(late.model.load._tag).toBe("Idle");
  });
});

describe("helpers", () => {
  it("formats large counts compactly", () => {
    expect(
      [999, 1234, 12_345, 2_500_000].map((value) => formatCompactCount(value))
    ).toStrictEqual(["999", "1.2k", "12k", "2.5m"]);
  });

  it("finds a grammar by path", () => {
    expect(
      ["src/App.tsx", "ops/Dockerfile", "notes.txt"].map((path) =>
        languageOfPath(path)
      )
    ).toStrictEqual([
      Option.some("tsx"),
      Option.some("dockerfile"),
      Option.none(),
    ]);
  });
});
