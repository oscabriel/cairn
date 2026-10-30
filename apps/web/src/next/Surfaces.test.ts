// Scene tests for the Phase 1 surfaces the `next` views redraw (plan look track L7): the composer
// and hero, the transcript's fold line with its tally, the settings page's Views row, and the
// words typed on a request card that closed carried into the composer's draft. The look rules
// (`judges/look.ts capture --strict`) judge their sizes, rings and spills in a real browser; these
// hold the hooks, the words and the wiring.

import { ProjectId } from "@cairn/protocol/Ids";
import { DEFAULT_ROLE_TABLE } from "@cairn/protocol/Roles";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { Mount } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import * as Scene from "foldkit/scene";

import { Message as AttachmentsMessage } from "../attachments/Message.ts";
import { AttachmentPaste } from "../attachments/Paste.ts";
import { composerOn, project, threadId } from "../composer/ComposerFixtures.ts";
import { activeDraft } from "../composer/Drafts.ts";
import { ComposerInput } from "../composer/Editor.ts";
import { MeasureFooter } from "../composer/Footer.ts";
import { Message as ComposerMessage } from "../composer/Message.ts";
import { ComposerTarget } from "../composer/Model.ts";
import {
  carryIntoDraft,
  update as composerUpdate,
} from "../composer/Update.ts";
import { initial as settingsInitial } from "../settings/Model.ts";
import { update as settingsUpdate } from "../settings/Update.ts";
import type { ListItem } from "../timeline/Rows.ts";
import type { RowContext } from "../timeline/RowView.ts";
import { view as composerView } from "./composer/View.ts";
import { view as settingsView } from "./settings/View.ts";
import { rowView } from "./timeline/RowView.ts";

const editor = Scene.testId("composer-editor");

/** The composer's Mounts, acknowledged as the browser would run them. */
const acknowledgeMounts = [
  Scene.Mount.resolve(ComposerInput, ComposerMessage.FocusedEditor()),
  Scene.Mount.resolve(
    Mount.mapMessage(AttachmentPaste(), (message: AttachmentsMessage) =>
      ComposerMessage.GotAttachmentsMessage({ message })
    ),
    ComposerMessage.GotAttachmentsMessage({
      message: AttachmentsMessage.ClickedDismissNotice(),
    })
  ),
  Scene.Mount.resolve(
    MeasureFooter,
    ComposerMessage.MeasuredFooter({
      width: 900,
      hostWidth: 634,
      measurement: {
        gap: 4,
        naturalFixedWidth: 169.17,
        minimumFixedWidth: 52,
        blockWidths: [124.39, 139.78],
        iconOnlyBlockWidths: Option.some([63, 63]),
        overflowWidth: 38,
      },
    })
  ),
];

const send = Scene.testId("composer-send");

describe("the next composer", () => {
  it("opens the command menu above the box and sends with the accent fill, the main ink", () => {
    Scene.scene(
      { update: composerUpdate, view: composerView },
      Scene.given(composerOn(ComposerTarget.Thread({ threadId }))),
      ...acknowledgeMounts,
      Scene.expect(Scene.selector("[data-chat-composer-docked]")).toExist(),
      Scene.expect(send).toBeDisabled(),
      Scene.expect(send).toHaveClass("bg-accent-fill"),
      Scene.expect(send).toHaveClass("pointer-coarse:size-(--hit-target)"),
      Scene.type(editor, "/"),
      Scene.Subscription.emit(
        ComposerMessage.ChangedSelection({ start: 1, end: 1 })
      ),
      Scene.expect(Scene.testId("composer-menu")).toHaveAttr(
        "data-trigger",
        "slash-command"
      ),
      Scene.expect(Scene.text("/model")).toExist(),
      Scene.expect(send).toBeEnabled(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("draws the hero's question and the project it starts in, with no header of its own", () => {
    Scene.scene(
      { update: composerUpdate, view: composerView },
      Scene.given(composerOn(ComposerTarget.Home())),
      ...acknowledgeMounts,
      Scene.expect(
        Scene.role("heading", { name: "What should we build?" })
      ).toExist(),
      Scene.expect(Scene.testId("hero-project-trigger")).toContainText(
        project.title
      ),
      Scene.expect(Scene.testId("hero-start-without-project")).toExist(),
      Scene.expect(Scene.selector("header")).toBeAbsent(),
      Scene.expect(Scene.testId("composer-context-strip")).toExist(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("puts words typed on a closed request below the thread's draft, never over it", () => {
    const typed = composerUpdate(
      composerOn(ComposerTarget.Thread({ threadId })),
      ComposerMessage.ChangedDraft({ value: "my own words" })
    ).model;

    const carried = carryIntoDraft(typed, threadId, "MariaDB, please");

    assert.strictEqual(
      activeDraft(carried).text,
      "my own words\n\nMariaDB, please"
    );
    assert.strictEqual(carried.draftsVersion, typed.draftsVersion + 1);
    assert.strictEqual(carryIntoDraft(typed, threadId, "  "), typed);

    const empty = composerOn(ComposerTarget.Thread({ threadId }));

    assert.strictEqual(
      activeDraft(carryIntoDraft(empty, threadId, "MariaDB, please")).text,
      "MariaDB, please"
    );
  });
});

const context: RowContext = {
  threadId,
  workspaceRoot: Option.none(),
  highlightedLanguages: [],
  highlightedCode: 0,
  copiedRowId: Option.none(),
  expanded: false,
  retryPrompt: Option.none(),
  history: "idle",
  historyCursor: Option.none(),
  subagents: Option.none(),
};

const fold = (tally: ReadonlyArray<{ count: number; word: string }>) =>
  ({
    kind: "turn-fold",
    id: "turn-fold:turn-1",
    createdAt: 0,
    turnId: "turn-1",
    label: "Worked for 3m 41s",
    tally,
    expanded: false,
    continuesWorkLog: false,
  }) satisfies ListItem;

const rowScene = (item: ListItem) => ({
  update: (model: number) => ({ model }),
  view: (_model: number, h: Parameters<typeof rowView>[0]) =>
    rowView(h, item, context),
});

describe("the next fold line", () => {
  it("says how long the turn worked and what its hidden work was", () => {
    Scene.scene(
      rowScene(
        fold([
          { count: 4, word: "edits" },
          { count: 9, word: "reads" },
          { count: 2, word: "commands" },
          { count: 2, word: "agents" },
        ])
      ),
      Scene.given(0),
      Scene.expect(Scene.testId("turn-fold")).toHaveAttr(
        "aria-expanded",
        "false"
      ),
      Scene.expect(Scene.testId("turn-fold")).toContainText(
        "Worked for 3m 41s"
      ),
      Scene.expect(Scene.testId("fold-tally")).toHaveText(
        " · 4 edits · 9 reads · 2 commands · 2 agents"
      ),
      Scene.expect(Scene.testId("turn-fold")).toHaveClass(
        "pointer-coarse:min-h-(--hit-target)"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("draws no tally when the hidden work held no tool call", () => {
    Scene.scene(
      rowScene(fold([])),
      Scene.given(0),
      Scene.expect(Scene.testId("turn-fold")).toContainText(
        "Worked for 3m 41s"
      ),
      Scene.expect(Scene.testId("fold-tally")).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

describe("the next settings page", () => {
  it("draws the Views row, so the phone can go back to classic without the address", () => {
    const loaded = {
      ...settingsInitial,
      context: {
        epoch: 3,
        hasClient: true,
        isOpen: true,
        projects: [{ id: ProjectId.make("prj_cairn"), title: "cairn" }],
      },
      loadedEpoch: Option.some(3),
      clientLoaded: true,
      server: AsyncData.succeed({
        autoSettleDays: 7,
        titleModel: Option.none(),
        bridgeEnabled: true,
        bridgeGenerationCap: 4,
        roleBindings: DEFAULT_ROLE_TABLE,
        defaultBudget: DEFAULT_BUDGET,
      }),
    };

    Scene.scene(
      {
        update: settingsUpdate,
        view: Scene.withViewInputs(settingsView, {
          notifications: () => null,
          roleTable: () => null,
        })(),
      },
      Scene.given(loaded),
      Scene.expect(Scene.selector("#settings-ui")).toHaveValue("classic"),
      Scene.expect(
        Scene.role("switch", { name: "Confirm thread deletion" })
      ).toExist(),
      Scene.expect(Scene.selector("#settings-ui")).toHaveHandler("change"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
