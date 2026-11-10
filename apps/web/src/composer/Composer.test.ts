import {
  AttachmentId,
  ProjectId,
  RequestId,
  SubmissionId,
  ThreadId,
} from "@cairn/protocol/Ids";
import { ProjectShell } from "@cairn/protocol/Shell";
import { ConversationView } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Option, Ref, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";
import { Mount } from "foldkit";
import * as Scene from "foldkit/scene";
import * as Story from "foldkit/story";

import { SaveReady } from "../attachments/Command.ts";
import { Message as AttachmentsMessage } from "../attachments/Message.ts";
import { AttachmentStatus } from "../attachments/Model.ts";
import { AttachmentPaste } from "../attachments/Paste.ts";
import {
  loadSaved,
  RESTORE_WINDOW_MS,
  saveSaved,
} from "../attachments/Saved.ts";
import { noticeFor, readyIds } from "../attachments/Update.ts";
import { CairnConnection } from "../connection/Connection.ts";
import { OutboxItem } from "../connection/Outbox.ts";
import { view } from "../next/composer/View.ts";
import { AppRoute } from "../Route.ts";
import {
  FocusPopoverSearch,
  MoveHeroToDraftUrl,
  OpenProjectThread,
  PrepareLaunch,
  PrepareSend,
  SaveDrafts,
  SearchEntries,
  WithdrawQueued,
} from "./Command.ts";
import {
  catalog,
  composerOn,
  contextFor,
  otherThreadId,
  project,
  threadId,
} from "./ComposerFixtures.ts";
import { composerContext } from "./Context.ts";
import {
  activeDraft,
  DRAFTS_STORAGE_KEY,
  draftProject,
  loadDrafts,
  saveDrafts,
  shownNotice,
} from "./Drafts.ts";
import { ComposerInput } from "./Editor.ts";
import { MeasureFooter } from "./Footer.ts";
import { drawerRoomOf, KeepDrawerRoom } from "./HeroDrawerRoom.ts";
import { Message, OutMessage } from "./Message.ts";
import { ComposerTarget, emptyDraft, initial, Popover } from "./Model.ts";
import type { Model } from "./Model.ts";
import { pickerRows } from "./Popovers.ts";
import { menuContents } from "./TriggerMenu.ts";
import { contextChanged, inform, pickDraftProject, update } from "./Update.ts";
import type { UpdateReturn } from "./Update.ts";

const editor = Scene.testId("composer-editor");

const menu = Scene.testId("composer-menu");

const onThread = composerOn(ComposerTarget.Thread({ threadId }));

/** The launch a send from `model` mints, if any. */
const launchOf = (model: Model) =>
  (
    update(model, Message.ClickedSend({ alternate: false })).commands ?? []
  ).find((command) => command.name === PrepareLaunch.name);

/** The view's Mounts, acknowledged as the browser would run them. */
const acknowledgeMounts = [
  Scene.Mount.resolve(ComposerInput, Message.FocusedEditor()),
  Scene.Mount.resolve(
    Mount.mapMessage(AttachmentPaste(), (message: AttachmentsMessage) =>
      Message.GotAttachmentsMessage({ message })
    ),
    Message.GotAttachmentsMessage({
      message: AttachmentsMessage.ClickedDismissNotice(),
    })
  ),
  Scene.Mount.resolve(
    MeasureFooter,
    Message.MeasuredFooter({
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

/** Typing `value` with the caret after it, as the editor's input and selection events report it. */
const typeWithCaret = (value: string) => [
  Scene.type(editor, value),
  Scene.Subscription.emit(
    Message.ChangedSelection({ start: value.length, end: value.length })
  ),
];

/** An @ search answer for `src` in `projectId`, listing one file. */
const srcAnswer = (projectId: ProjectId, path: string) =>
  Message.SucceededPathSearch({
    projectId,
    query: "src",
    result: { entries: [{ path, kind: "file" }], truncated: false },
  });

/** `model` after each of `messages` in turn. */
const afterAll = (model: Model, messages: ReadonlyArray<Message>): Model => {
  let current = model;

  for (const message of messages) {
    current = update(current, message).model;
  }

  return current;
};

describe("composer triggers", () => {
  it("opens the command menu for a slash at the start of a line", () => {
    Scene.scene(
      { update, view },
      Scene.given(onThread),
      ...acknowledgeMounts,
      ...typeWithCaret("/"),
      Scene.expect(menu).toHaveAttr("data-trigger", "slash-command"),
      Scene.expect(Scene.text("/model")).toExist(),
      Scene.expect(Scene.text("/skill:review")).toExist(),
      Scene.expect(editor).toHaveAttr("aria-expanded", "true"),
      Scene.tap((simulation) => {
        assert.lengthOf(simulation.commands, 0);
      })
    );
  });

  it("keeps a path like /tmp/x out of the menu", () => {
    Scene.scene(
      { update, view },
      Scene.given(onThread),
      ...acknowledgeMounts,
      ...typeWithCaret("/tmp/x"),
      Scene.expect(menu).toBeAbsent(),
      Scene.expect(editor).toHaveAttr("aria-expanded", "false"),
      Scene.tap((simulation) => {
        assert.lengthOf(simulation.commands, 0);
      })
    );
  });

  it("searches the project's files for @src after the debounce and lists the results", () => {
    Scene.scene(
      { update, view },
      Scene.given(onThread),
      ...acknowledgeMounts,
      ...typeWithCaret("see @src"),
      Scene.expect(menu).toHaveAttr("data-trigger", "path"),
      Scene.expect(Scene.text("Searching workspace files...")).toExist(),
      Scene.Subscription.emit(
        Message.ElapsedPathSearchDebounce({
          projectId: project.id,
          query: "src",
        })
      ),
      Scene.Command.resolve(
        SearchEntries,
        Message.SucceededPathSearch({
          projectId: project.id,
          query: "src",
          result: {
            entries: [
              { path: "src/main.ts", kind: "file" },
              { path: "src/lib", kind: "directory" },
            ],
            truncated: false,
          },
        })
      ),
      Scene.expect(Scene.text("src/main.ts")).toExist(),
      Scene.expect(Scene.text("src/lib")).toExist(),
      Scene.tap((simulation) => {
        assert.lengthOf(simulation.commands, 0);
      })
    );
  });

  it("stops searching when the search fails, says why, and asks again when typed again", () => {
    Scene.scene(
      { update, view },
      Scene.given(onThread),
      ...acknowledgeMounts,
      ...typeWithCaret("see @src"),
      Scene.Subscription.emit(
        Message.ElapsedPathSearchDebounce({
          projectId: project.id,
          query: "src",
        })
      ),
      Scene.Command.resolve(
        SearchEntries,
        Message.FailedPathSearch({
          projectId: project.id,
          query: "src",
          message: "The workspace could not be searched.",
        })
      ),
      Scene.expect(Scene.text("Searching workspace files...")).toBeAbsent(),
      Scene.expect(
        Scene.text("The workspace could not be searched.")
      ).toExist(),
      ...typeWithCaret("see @src"),
      Scene.expect(Scene.text("Searching workspace files...")).toExist(),
      Scene.tap((simulation) => {
        assert.lengthOf(simulation.commands, 0);
      })
    );
  });

  it("applies an @ search answer only for the target project, and does not spin without one", () => {
    const draftId = "019a0000-0000-7000-8000-000000000b08";
    const target = ComposerTarget.Draft({ draftId });

    const other = ProjectShell.make({
      ...project,
      id: ProjectId.make("prj_other"),
      title: "other",
      workspaceRoot: "/home/user/other",
    });

    const base = inform(composerOn(target), {
      ...contextFor(target),
      projects: [project, other],
    }).model;

    const typed = [
      Message.ChangedDraft({ value: "see @src" }),
      Message.ChangedSelection({ start: 8, end: 8 }),
    ];

    const steps = [
      ...typed,
      Message.ElapsedPathSearchDebounce({
        projectId: project.id,
        query: "src",
      }),
      Message.PickedProject({ projectId: other.id }),
      Message.ElapsedPathSearchDebounce({ projectId: other.id, query: "src" }),
      srcAnswer(project.id, "src/first.ts"),
      srcAnswer(other.id, "src/second.ts"),
    ];

    const answered = afterAll(
      pickDraftProject(base, draftId, project.id),
      steps
    );

    assert.deepStrictEqual(
      Option.map(menuContents(answered), (contents) =>
        contents.items.map((item) => item.description)
      ),
      Option.some(["src/second.ts"]),
      "the menu lists the picked project's files"
    );

    // A draft whose project is gone falls back to the default project, so only a shell with no
    // project at all leaves it with none.
    const orphaned = afterAll(
      pickDraftProject(
        inform(composerOn(target), { ...contextFor(target), projects: [] })
          .model,
        draftId,
        ProjectId.make("prj_gone")
      ),
      typed
    );

    assert.deepStrictEqual(
      Option.map(menuContents(orphaned), ({ error, loading }) => ({
        loading,
        error,
      })),
      Option.some({
        loading: false,
        error: Option.some("Choose a project to search its files."),
      }),
      "a draft with no project shows no endless search"
    );
  });

  it("inserts the picked file as a markdown link", () => {
    const searched = update(
      update(
        update(onThread, Message.ChangedDraft({ value: "see @src" })).model,
        Message.ChangedSelection({ start: 8, end: 8 })
      ).model,
      Message.SucceededPathSearch({
        projectId: project.id,
        query: "src",
        result: {
          entries: [{ path: "src/main.ts", kind: "file" }],
          truncated: false,
        },
      })
    ).model;

    const picked = update(
      searched,
      Message.PressedMenuKey({ key: "Enter" })
    ).model;

    assert.strictEqual(activeDraft(picked).text, "see [main.ts](src/main.ts) ");
    assert.isTrue(Option.isNone(picked.triggerMenu));
  });

  it("lists skills under $", () => {
    Scene.scene(
      { update, view },
      Scene.given(onThread),
      ...acknowledgeMounts,
      ...typeWithCaret("use $"),
      Scene.expect(menu).toHaveAttr("data-trigger", "skill"),
      Scene.expect(Scene.text("$review")).toExist(),
      Scene.expect(Scene.text("$deploy")).toExist(),
      Scene.tap((simulation) => {
        assert.lengthOf(simulation.commands, 0);
      })
    );
  });

  it("closes a menu on Escape until the caret leaves the trigger", () => {
    const opened = update(
      update(onThread, Message.ChangedDraft({ value: "/" })).model,
      Message.ChangedSelection({ start: 1, end: 1 })
    ).model;

    const dismissed = update(
      opened,
      Message.PressedMenuKey({ key: "Escape" })
    ).model;

    const typedOn = update(
      update(dismissed, Message.ChangedDraft({ value: "/m" })).model,
      Message.ChangedSelection({ start: 2, end: 2 })
    ).model;

    assert.isTrue(Option.isSome(opened.triggerMenu));
    assert.isTrue(Option.isNone(dismissed.triggerMenu));
    assert.isTrue(Option.isNone(typedOn.triggerMenu));
  });
});

/**
 * The footer's one measured block, the runtime mode, at host widths around its fold: the model pill
 * 120 px, the mode 139.78 px wide and 63 px icon-only, a 4 px gap. The pill names the model and its
 * thinking level, so there is no thinking block and no overflow button to fold into.
 */
const footerStates: ReadonlyArray<{
  readonly host: number;
  readonly mode: "full" | "icon";
}> = [
  { host: 634, mode: "full" },
  { host: 264, mode: "full" },
  { host: 200, mode: "icon" },
  // Too tight even for the glyph: the layout would hide the mode, but there is nowhere to fold it
  // into, so it stays drawn as its glyph and the pill truncates instead.
  { host: 150, mode: "icon" },
];

const block = (name: string) =>
  Scene.selector(`[data-resting-block="${name}"]`);

/** A thread's view: the user's prompt, the answer, and `live` streaming. */
const viewWith = (live: string) =>
  Schema.decodeSync(ConversationView)({
    conversation: { id: 1 },
    entries: [
      {
        id: 1,
        conversationId: 1,
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: [{ type: "text", text: "fix the tests" }],
            timestamp: 1,
          },
        ],
      },
      {
        id: 2,
        conversationId: 1,
        kind: "pi.assistant",
        model: [
          { role: "assistant", content: [{ type: "text", text: "Done." }] },
        ],
      },
    ],
    docs: { "pi.live": { generation: live } },
  });

const contextOf = (conversation: ConversationView) =>
  composerContext({
    route: AppRoute.Thread({ threadId }),
    threadId: Option.some(threadId),
    epoch: 1,
    hasClient: true,
    live: true,
    shell: Option.none(),
    threadView: Option.some(conversation),
    defaults: Option.none(),
    usage: Option.none(),
  });

describe("prompt history", () => {
  it("recalls the user's prompt from the thread's view with the up arrow", () => {
    const informed = inform(onThread, contextOf(viewWith(""))).model;

    const recalled = update(
      informed,
      Message.PressedHistoryKey({ direction: "backward" })
    ).model;

    assert.strictEqual(activeDraft(recalled).text, "fix the tests");
  });

  it("ignores a streamed token, which changes the view but not the prompts or the queue", () => {
    const before = viewWith("I'll");
    const informed = inform(onThread, contextOf(before)).model;

    const streamed = {
      ...before,
      docs: { ...before.docs, "pi.live": { generation: "I'll start" } },
    };

    assert.isFalse(contextChanged(informed, contextOf(streamed)));
  });
});

describe("pointer highlights", () => {
  it("keep the same Model while the pointer moves over the highlighted picker row", () => {
    const opened = update(
      onThread,
      Message.OpenedPopover({
        popover: Popover.ModelPicker({
          query: "",
          highlighted: Option.none(),
          provider: Option.none(),
        }),
      })
    ).model;

    const highlighted = update(
      opened,
      Message.MovedPopoverHighlight({ id: "opencode-go/small" })
    ).model;

    const sameRow = update(
      highlighted,
      Message.MovedPopoverHighlight({ id: "opencode-go/small" })
    ).model;

    const nextRow = update(
      highlighted,
      Message.MovedPopoverHighlight({ id: "opencode-go/large" })
    ).model;

    assert.isTrue(Option.isSome(opened.popover));
    assert.notStrictEqual(highlighted, opened);
    assert.strictEqual(sameRow, highlighted);
    assert.notStrictEqual(nextRow, highlighted);
  });

  it("keep the same Model while the pointer moves over the highlighted menu item", () => {
    const opened = update(
      update(onThread, Message.ChangedDraft({ value: "/" })).model,
      Message.ChangedSelection({ start: 1, end: 1 })
    ).model;

    const highlighted = update(
      opened,
      Message.HighlightedMenuItem({ id: "/model" })
    ).model;

    const sameItem = update(
      highlighted,
      Message.HighlightedMenuItem({ id: "/model" })
    ).model;

    assert.isTrue(Option.isSome(opened.triggerMenu));
    assert.notStrictEqual(highlighted, opened);
    assert.strictEqual(sameItem, highlighted);
  });
});

describe("composer footer folding", () => {
  it.each(footerStates)(
    "draws the mode $mode in a $host px host, and no thinking block or overflow",
    ({ host, mode }) => {
      Scene.scene(
        { update, view },
        Scene.given(onThread),
        ...acknowledgeMounts,
        Scene.Subscription.emit(
          Message.MeasuredFooter({
            width: 390,
            hostWidth: host,
            measurement: {
              gap: 4,
              naturalFixedWidth: 120,
              minimumFixedWidth: 52,
              blockWidths: [139.78],
              iconOnlyBlockWidths: Option.some([63]),
              overflowWidth: 0,
            },
          })
        ),
        Scene.expect(block("mode")).toHaveAttr(
          "data-composer-block-icon-only",
          String(mode === "icon")
        ),
        Scene.expect(block("mode")).toHaveAttr(
          "data-composer-block-hidden",
          "false"
        ),
        Scene.expect(block("traits")).toBeAbsent(),
        Scene.expect(
          Scene.selector("[data-resting-controls-overflow]")
        ).toBeAbsent(),
        Scene.tap((simulation) => {
          assert.lengthOf(simulation.commands, 0);
        })
      );
    }
  );
});

describe("composer model pill", () => {
  it("names the model shortly with its thinking level, and its picker offers the levels", () => {
    Scene.scene(
      { update, view },
      Scene.given(onThread),
      ...acknowledgeMounts,
      Scene.expect(
        Scene.selector("[data-chat-provider-model-picker-label]")
      ).toHaveText("kimi-k3 · Medium"),
      Scene.expect(
        Scene.selector("[data-chat-provider-model-picker]")
      ).toHaveAttr("title", "Kimi K3"),
      Scene.click(Scene.selector("[data-chat-provider-model-picker]")),
      Scene.Command.resolve(
        FocusPopoverSearch,
        Message.CompletedEditorCommand()
      ),
      Scene.expect(Scene.testId("composer-model-thinking")).toContainText(
        "High"
      ),
      Scene.expect(
        Scene.selector(
          '[data-testid="composer-model-thinking"] [aria-pressed="true"]'
        )
      ).toHaveText("Medium"),
      Scene.tap((simulation) => {
        assert.lengthOf(simulation.commands, 0);
      })
    );
  });
});

/** `model` with the model picker open, as the pill opens it. */
const openPicker = (model: Model) =>
  update(
    model,
    Message.OpenedPopover({
      popover: Popover.ModelPicker({
        query: "",
        highlighted: Option.none(),
        provider: Option.none(),
      }),
    })
  ).model;

describe("the model picker's provider rail", () => {
  // The fixture catalog with a second provider: the bridge's Claude models.
  const twoProviders = {
    ...onThread,
    catalog: Option.some({
      ...catalog,
      models: [
        ...catalog.models,
        {
          provider: "claude-bridge",
          modelId: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          thinkingLevels: ["off", "low", "medium", "high"] as const,
          acceptsImages: true,
          contextWindow: Option.none(),
          available: true,
        },
      ],
    }),
  };

  it("opens on the current model's provider and lists only its models", () => {
    assert.deepStrictEqual(
      pickerRows(openPicker(twoProviders)).map((listing) => listing.modelId),
      ["kimi-k3", "glm-5"]
    );
  });

  it("shows another provider's models when it is picked on the rail", () => {
    const picked = update(
      openPicker(twoProviders),
      Message.PickedPickerProvider({ provider: "claude-bridge" })
    ).model;

    assert.deepStrictEqual(
      pickerRows(picked).map((listing) => listing.modelId),
      ["claude-opus-5-5"]
    );
  });

  it("searches every provider, whatever the rail shows", () => {
    const searched = update(
      update(
        openPicker(twoProviders),
        Message.PickedPickerProvider({ provider: "claude-bridge" })
      ).model,
      Message.ChangedPopoverQuery({ query: "k" })
    ).model;

    assert.include(
      pickerRows(searched).map((listing) => listing.modelId),
      "kimi-k3"
    );
  });

  it("draws one rail button per provider with its mark, and the pill takes the model's mark", () => {
    Scene.scene(
      { update, view },
      Scene.given(twoProviders),
      ...acknowledgeMounts,
      Scene.expect(
        Scene.selector(
          '[data-chat-provider-model-picker] [data-provider-mark="opencode"]'
        )
      ).toExist(),
      Scene.click(Scene.selector("[data-chat-provider-model-picker]")),
      Scene.Command.resolve(
        FocusPopoverSearch,
        Message.CompletedEditorCommand()
      ),
      Scene.expect(
        Scene.selector('[data-model-picker-provider="opencode-go"]')
      ).toHaveAttr("aria-pressed", "true"),
      Scene.expect(
        Scene.selector(
          '[data-model-picker-provider="claude-bridge"] [data-provider-mark="claude"]'
        )
      ).toExist(),
      Scene.expect(
        Scene.selector('[data-model-picker-provider="claude-bridge"]')
      ).toHaveAttr("aria-label", "Claude"),
      Scene.tap((simulation) => {
        assert.lengthOf(simulation.commands, 0);
      })
    );
  });
});

describe("composer drafts", () => {
  it("keeps each thread's draft apart and restores it after a reload", async () => {
    const typed = update(
      onThread,
      Message.ChangedDraft({ value: "half a thought" })
    ).model;

    const elsewhere = inform(
      typed,
      contextFor(ComposerTarget.Thread({ threadId: otherThreadId }))
    ).model;

    const typedElsewhere = update(
      elsewhere,
      Message.ChangedDraft({ value: "another" })
    ).model;

    const back = inform(
      typedElsewhere,
      contextFor(ComposerTarget.Thread({ threadId }))
    ).model;

    assert.strictEqual(activeDraft(elsewhere).text, "");
    assert.strictEqual(activeDraft(back).text, "half a thought");

    // The saver writes after the pause; a new page reads it back.
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        yield* saveDrafts({}, back.drafts);

        return yield* loadDrafts;
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
    );

    const reloaded = update(
      inform(initial, contextFor(ComposerTarget.Thread({ threadId }))).model,
      Message.LoadedDrafts({ drafts: saved })
    ).model;

    assert.strictEqual(activeDraft(reloaded).text, "half a thought");
    assert.strictEqual(
      activeDraft(
        inform(
          reloaded,
          contextFor(ComposerTarget.Thread({ threadId: otherThreadId }))
        ).model
      ).text,
      "another"
    );
  });

  it("saves drafts once typing pauses", () => {
    Story.story(
      update,
      Story.given(onThread),
      Story.message(Message.ChangedDraft({ value: "a" })),
      Story.message(Message.ChangedDraft({ value: "ab" })),
      Story.message(Message.ElapsedDraftDebounce({ version: 1 })),
      Story.Command.expectNone(),
      Story.message(Message.ElapsedDraftDebounce({ version: 2 })),
      Story.Command.expectHas(SaveDrafts),
      Story.Command.resolve(
        SaveDrafts,
        Message.CompletedSaveDrafts({
          version: 2,
          written: { [`thread:${threadId}`]: { ...emptyDraft, text: "ab" } },
          stored: Option.some({
            [`thread:${threadId}`]: { ...emptyDraft, text: "ab" },
          }),
        })
      ),
      Story.model((model: Model) => {
        assert.strictEqual(model.savedVersion, 2);
      })
    );
  });

  it("shows the restored draft in the editor", () => {
    const withDraft = update(
      onThread,
      Message.ChangedDraft({ value: "restored text" })
    ).model;

    Scene.scene(
      { update, view },
      Scene.given(withDraft),
      ...acknowledgeMounts,
      Scene.expect(editor).toHaveValue("restored text"),
      Scene.tap((simulation) => {
        assert.lengthOf(simulation.commands, 0);
      })
    );
  });
});

/** Runs the Commands named `names` an update issued, as the runtime would, with no connection. */
const runCommands = (result: UpdateReturn, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const disconnected = yield* Ref.make(Option.none());

    return yield* Effect.forEach(
      (result.commands ?? []).filter(({ name }) => names.includes(name)),
      (command) => command.effect
    ).pipe(Effect.provideService(CairnConnection._tag, disconnected));
  });

/** Runs the draft saves an update issued, and returns their answers. */
const runSaves = (result: UpdateReturn) =>
  runCommands(result, [SaveDrafts.name]);

/** A tab on `target` whose drafts were read from an empty store. */
const freshTab = (target: ComposerTarget): Model =>
  update(composerOn(target), Message.LoadedDrafts({ drafts: {} })).model;

/** Types `value` into `tab`'s open draft, lets the saver's pause run out, and takes its answer. */
const typeAndSave = (tab: Model, value: string) =>
  Effect.gen(function* () {
    const typed = update(tab, Message.ChangedDraft({ value })).model;

    const [answer] = yield* runSaves(
      update(
        typed,
        Message.ElapsedDraftDebounce({ version: typed.draftsVersion })
      )
    );

    return answer === undefined ? typed : update(typed, answer).model;
  });

/** `tab` told another tab wrote, after its save (which reads storage) answered. */
const hear = (tab: Model) =>
  Effect.gen(function* () {
    const told = update(tab, Message.ChangedStoredDrafts());
    const [answer] = yield* runSaves(told);

    return answer === undefined ? told.model : update(told.model, answer).model;
  });

describe("drafts in two tabs", () => {
  it.effect("keep each other's saved drafts", () =>
    Effect.gen(function* () {
      const tabB = freshTab(ComposerTarget.Thread({ threadId: otherThreadId }));
      const tabA = freshTab(ComposerTarget.Thread({ threadId }));

      yield* typeAndSave(tabA, "half a thought");
      yield* typeAndSave(tabB, "another");

      const stored = yield* loadDrafts;

      assert.deepStrictEqual(
        {
          a: stored[`thread:${threadId}`]?.text,
          b: stored[`thread:${otherThreadId}`]?.text,
        },
        { a: "half a thought", b: "another" }
      );
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("show each other's writes, and keep their own unsaved typing", () =>
    Effect.gen(function* () {
      const xKey = `thread:${threadId}`;
      const yKey = `thread:${otherThreadId}`;

      const tabA = freshTab(ComposerTarget.Thread({ threadId }));
      const tabB = freshTab(ComposerTarget.Thread({ threadId: otherThreadId }));
      const wrote = yield* typeAndSave(tabA, "half a thought");

      // Tab B types without pausing, so its draft is not saved yet.
      const typing = update(
        tabB,
        Message.ChangedDraft({ value: "mine" })
      ).model;

      const heard = yield* hear(typing);

      // Tab A empties its draft, and the saver writes it.
      yield* typeAndSave(wrote, "");

      const heardAgain = yield* hear(heard);

      assert.deepStrictEqual(
        {
          heard: [heard.drafts[xKey]?.text, heard.drafts[yKey]?.text],
          heardAgain: [
            heardAgain.drafts[xKey]?.text,
            heardAgain.drafts[yKey]?.text,
          ],
          stored: Object.keys(yield* loadDrafts),
        },
        {
          heard: ["half a thought", "mine"],
          heardAgain: [undefined, "mine"],
          stored: [yKey],
        }
      );
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "keep a draft another tab's write dropped because it read storage before the draft was saved",
    () =>
      Effect.gen(function* () {
        const xKey = `thread:${threadId}`;
        const yKey = `thread:${otherThreadId}`;
        const store = yield* KeyValueStore.KeyValueStore;

        const tabA = yield* typeAndSave(
          freshTab(ComposerTarget.Thread({ threadId })),
          "hello"
        );

        // Tab B read storage before tab A's write landed, so its own write leaves A's draft out.
        yield* store.remove(DRAFTS_STORAGE_KEY);
        yield* typeAndSave(
          freshTab(ComposerTarget.Thread({ threadId: otherThreadId })),
          "another"
        );

        const heard = yield* hear(tabA);

        assert.deepStrictEqual(
          {
            open: activeDraft(heard).text,
            stored: Object.keys(yield* loadDrafts).toSorted(),
          },
          { open: "hello", stored: [xKey, yKey].toSorted() }
        );
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

/** `model` after both stores answered with what they hold now, drafts first or tray first. */
const reload = (model: Model, traysFirst: boolean) =>
  Effect.gen(function* () {
    const drafts = Message.LoadedDrafts({ drafts: yield* loadDrafts });

    const tray = Message.GotAttachmentsMessage({
      message: AttachmentsMessage.LoadedSaved({ drafts: yield* loadSaved }),
    });

    const [first, second] = traysFirst ? [tray, drafts] : [drafts, tray];

    return update(update(model, first).model, second).model;
  });

describe("drafts after a reload", () => {
  const key = `thread:${threadId}`;

  const pdfRef = {
    id: AttachmentId.make("att_1"),
    name: "notes.pdf",
    mimeType: "application/pdf",
    sizeBytes: 12,
    kind: "pdf" as const,
    sha256: "0".repeat(64),
  };

  /** A page opened on the thread, before either store answered. */
  const opened: Model = { ...onThread, draftsLoaded: false };

  it.effect(
    "drop an attachment the brain has swept, so an empty composer cannot send",
    () =>
      Effect.gen(function* () {
        yield* saveSaved({}, { [key]: [pdfRef] });
        yield* saveDrafts(
          {},
          { [key]: { ...emptyDraft, attachments: [pdfRef.id] } }
        );
        yield* TestClock.adjust(Duration.millis(RESTORE_WINDOW_MS));

        for (const traysFirst of [false, true]) {
          const reloaded = yield* reload(opened, traysFirst);

          const sent = update(
            reloaded,
            Message.ClickedSend({ alternate: false })
          );

          assert.deepStrictEqual(
            {
              attachments: activeDraft(reloaded).attachments,
              tray: readyIds(reloaded.attachments, key),
              sends: (sent.commands ?? []).map(({ name }) => name),
            },
            { attachments: [], tray: [], sends: [] }
          );
        }
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "drop a swept attachment without overwriting another tab's newer words for the draft",
    () =>
      Effect.gen(function* () {
        const old = { ...emptyDraft, text: "old", attachments: [pdfRef.id] };

        yield* saveSaved({}, { [key]: [pdfRef] });
        yield* saveDrafts({}, { [key]: old });
        yield* TestClock.adjust(Duration.millis(RESTORE_WINDOW_MS));

        const reloaded = yield* reload(opened, false);

        // Another tab rewrites the draft after this page read it.
        yield* saveDrafts({ [key]: old }, { [key]: { ...old, text: "newer" } });
        yield* runSaves(update(reloaded, Message.HidPage()));

        assert.strictEqual((yield* loadDrafts)[key]?.text, "newer");
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "keep a sent turn's words out of the drafts when the page dies before the saver's pause",
    () =>
      Effect.gen(function* () {
        const drafts = {
          [key]: { ...emptyDraft, text: "ship it", attachments: [pdfRef.id] },
        };

        const saved = { [key]: [pdfRef] };

        yield* saveDrafts({}, drafts);
        yield* saveSaved({}, saved);

        const typed: Model = {
          ...onThread,
          drafts,
          storedDrafts: drafts,
          attachments: {
            ...onThread.attachments,
            loaded: true,
            stored: saved,
            nextLocalId: 2,
            items: [
              {
                localId: "attachment-1",
                draftKey: key,
                name: pdfRef.name,
                mimeType: pdfRef.mimeType,
                sizeBytes: pdfRef.sizeBytes,
                isImage: false,
                file: Option.none(),
                previewUrl: Option.none(),
                pastedAt: Option.none(),
                pasteToRequestMs: Option.none(),
                attempts: 1,
                status: AttachmentStatus.Ready({ ref: pdfRef }),
              },
            ],
          },
        };

        // Send: the tray is saved at once and the turn's id is minted; every save the composer
        // issues runs, but the saver's pause never runs out, because the page dies here.
        const sent = update(typed, Message.ClickedSend({ alternate: false }));
        const answers = yield* runCommands(sent, [PrepareSend.name]);

        yield* runCommands(sent, [SaveReady.name, SaveDrafts.name]);

        const [answer] = answers;

        const prepared = update(
          sent.model,
          answer ?? Message.CompletedRequest()
        );

        yield* runCommands(prepared, [SaveReady.name, SaveDrafts.name]);

        const reloaded = yield* reload(opened, false);

        assert.deepStrictEqual(
          {
            text: activeDraft(reloaded).text,
            attachments: activeDraft(reloaded).attachments,
            tray: readyIds(reloaded.attachments, key),
          },
          { text: "", attachments: [], tray: [] }
        );
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "keep a launch's words saved while its scratch project is being made",
    () =>
      Effect.gen(function* () {
        const draftId = "019a0000-0000-7000-8000-000000000b09";
        const base = composerOn(ComposerTarget.Draft({ draftId }));

        // No project: the launch first asks the brain for the scratch project.
        const projectless: Model = {
          ...base,
          context: { ...base.context, projects: [] },
        };

        const typed = update(
          projectless,
          Message.ChangedDraft({ value: "start the migration" })
        ).model;

        const sent = update(typed, Message.ClickedSend({ alternate: false }));

        // The tab closes before the brain answers.
        yield* runSaves(update(sent.model, Message.HidPage()));

        assert.deepStrictEqual(
          {
            launching: (sent.commands ?? []).some(
              ({ name }) => name === PrepareLaunch.name
            ),
            saved: (yield* loadDrafts)[`draft:${draftId}`]?.text,
          },
          { launching: true, saved: "start the migration" }
        );
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it("keeps Send off while only the draft, not the tray, names an attachment", () => {
    Scene.scene(
      { update, view },
      Scene.given({
        ...onThread,
        drafts: { [key]: { ...emptyDraft, attachments: [pdfRef.id] } },
      }),
      ...acknowledgeMounts,
      Scene.expect(Scene.testId("composer-send")).toBeDisabled(),
      Scene.tap((simulation) => {
        assert.lengthOf(simulation.commands, 0);
      })
    );
  });
});

describe("composer sends", () => {
  it("sends a thread turn through the outbox and empties the composer", () => {
    Story.story(
      update,
      Story.given(onThread),
      Story.message(
        Message.ChangedDraft({ value: "  run the tests $review  " })
      ),
      Story.message(Message.PressedSubmitKey({ intent: "foreground" })),
      Story.model((model: Model) => {
        assert.strictEqual(activeDraft(model).text, "");
      }),
      Story.Command.expectHas(PrepareSend),
      Story.Command.resolve(
        PrepareSend,
        Message.PreparedTurn({
          draftKey: `thread:${threadId}`,
          item: OutboxItem.Send({
            input: {
              threadId,
              input: {
                requestId: RequestId.make("req-1"),
                text: "run the tests $review",
                attachments: [],
                skillRefs: ["review"],
              },
              whenBusy: "followUp",
            },
          }),
          navigateTo: Option.none(),
          attachments: [],
        })
      ),
      Story.expectOutMessage(
        OutMessage.Submitted({
          item: OutboxItem.Send({
            input: {
              threadId,
              input: {
                requestId: RequestId.make("req-1"),
                text: "run the tests $review",
                attachments: [],
                skillRefs: ["review"],
              },
              whenBusy: "followUp",
            },
          }),
          navigateTo: Option.none(),
          attachments: [],
        })
      ),
      Story.Command.resolve(
        SaveDrafts,
        Message.CompletedSaveDrafts({
          version: 3,
          written: {},
          stored: Option.some({}),
        })
      )
    );
  });

  it("refuses an oversized draft and keeps it", () => {
    const long = "x".repeat(120_001);

    const refused = update(
      update(onThread, Message.ChangedDraft({ value: long })).model,
      Message.PressedSubmitKey({ intent: "foreground" })
    );

    assert.strictEqual(activeDraft(refused.model).text, long);
    assert.isTrue(Option.isSome(refused.model.notice));
    assert.deepStrictEqual(refused.commands ?? [], []);
  });

  it("moves the hero to its draft's URL once the draft has an id, so a reload restores it", () => {
    const draftId = ThreadId.make("019a0000-0000-7000-8000-000000000b02");

    Story.story(
      update,
      Story.given(composerOn(ComposerTarget.Home())),
      Story.message(Message.MintedHomeDraft({ draftId })),
      Story.Command.expectHas(MoveHeroToDraftUrl),
      Story.Command.resolve(MoveHeroToDraftUrl, Message.MovedHeroToDraftUrl()),
      Story.model((model: Model) => {
        assert.isTrue(Option.contains(model.homeDraftId, draftId));
      })
    );

    const moved = inform(
      {
        ...composerOn(ComposerTarget.Home()),
        homeDraftId: Option.some(draftId),
      },
      contextFor(ComposerTarget.Draft({ draftId }))
    );

    assert.deepStrictEqual(moved.commands ?? [], []);
  });

  it("forgets the hero's draft id once that draft launches from its own URL", () => {
    const draftId = "019a0000-0000-7000-8000-000000000b03";

    Story.story(
      update,
      Story.given({
        ...composerOn(ComposerTarget.Draft({ draftId })),
        homeDraftId: Option.some(draftId),
      }),
      Story.message(Message.ChangedDraft({ value: "start here" })),
      Story.message(Message.ClickedSend({ alternate: false })),
      Story.Command.expectHas(PrepareLaunch),
      Story.model((model: Model) => {
        assert.isTrue(Option.isNone(model.homeDraftId));
      }),
      Story.Command.resolve(
        PrepareLaunch,
        Message.FailedPrepareTurn({
          draftKey: `draft:${draftId}`,
          draft: { ...emptyDraft, text: "start here" },
          attachments: [],
          message: "no",
        })
      )
    );
  });

  it("shows an answer's notice only on the draft it is about", () => {
    const draftId = "019a0000-0000-7000-8000-000000000b07";
    const onDraft = composerOn(ComposerTarget.Draft({ draftId }));

    const sent = update(
      update(onDraft, Message.ChangedDraft({ value: "start here" })).model,
      Message.ClickedSend({ alternate: false })
    );

    assert.isTrue(
      (sent.commands ?? []).some(
        (command) => command.name === PrepareLaunch.name
      )
    );

    const elsewhere = inform(
      sent.model,
      contextFor(ComposerTarget.Thread({ threadId }))
    ).model;

    const failed = update(
      elsewhere,
      Message.FailedPrepareTurn({
        draftKey: `draft:${draftId}`,
        draft: { ...emptyDraft, text: "start here" },
        attachments: [],
        message:
          "The thread did not start. Your message is back in the composer.",
      })
    ).model;

    assert.isTrue(
      Option.isNone(shownNotice(failed)),
      "the thread opened meanwhile shows no notice about the draft"
    );

    const backOnDraft = inform(
      failed,
      contextFor(ComposerTarget.Draft({ draftId }))
    ).model;

    assert.strictEqual(activeDraft(backOnDraft).text, "start here");
    assert.deepStrictEqual(
      shownNotice(backOnDraft),
      Option.some(
        "The thread did not start. Your message is back in the composer."
      ),
      "the draft the message went back to says so when the user returns"
    );

    const stopFailed = update(
      inform(
        failed,
        contextFor(ComposerTarget.Thread({ threadId: otherThreadId }))
      ).model,
      Message.FailedRequest({
        draftKey: Option.some(`thread:${threadId}`),
        message: "The run could not be stopped.",
      })
    ).model;

    assert.isTrue(
      Option.isNone(shownNotice(stopFailed)),
      "a failed Stop of the thread the user left shows nothing on the thread now open"
    );
  });

  it("keeps a draft's notice while the user types in another draft", () => {
    const draftId = "019a0000-0000-7000-8000-000000000b08";

    const failed = update(
      composerOn(ComposerTarget.Thread({ threadId })),
      Message.FailedPrepareTurn({
        draftKey: `draft:${draftId}`,
        draft: { ...emptyDraft, text: "start here" },
        attachments: [],
        message:
          "The thread did not start. Your message is back in the composer.",
      })
    ).model;

    const typed = update(
      failed,
      Message.ChangedDraft({ value: "meanwhile" })
    ).model;

    const backOnDraft = inform(
      typed,
      contextFor(ComposerTarget.Draft({ draftId }))
    ).model;

    assert.deepStrictEqual(
      shownNotice(backOnDraft),
      Option.some(
        "The thread did not start. Your message is back in the composer."
      )
    );
  });

  it("launches a draft with the server's default model", () => {
    const draft = composerOn(
      ComposerTarget.Draft({ draftId: "019a0000-0000-7000-8000-000000000b01" })
    );

    Story.story(
      update,
      Story.given(draft),
      Story.message(Message.ChangedDraft({ value: "start here" })),
      Story.message(Message.ClickedSend({ alternate: false })),
      Story.Command.expectHas(PrepareLaunch),
      Story.model((model: Model) => {
        assert.deepStrictEqual(model.drafts, {});
      }),
      Story.Command.resolve(
        PrepareLaunch,
        Message.FailedPrepareTurn({
          draftKey: "draft:019a0000-0000-7000-8000-000000000b01",
          draft: { ...emptyDraft, text: "start here" },
          attachments: [],
          message: "no",
        })
      ),
      Story.model((model: Model) => {
        assert.strictEqual(activeDraft(model).text, "start here");
      })
    );

    const typed = update(
      draft,
      Message.ChangedDraft({ value: "start here" })
    ).model;

    const launch = (
      update(typed, Message.ClickedSend({ alternate: false })).commands ?? []
    ).find((command) => command.name === PrepareLaunch.name);

    assert.deepStrictEqual(launch?.args?.model, catalog.defaults.model);
  });

  it("launches a draft the shell gave a project in that project, not the most recently updated one", () => {
    const draftId = "019a0000-0000-7000-8000-000000000b05";

    const myr = ProjectShell.make({
      ...project,
      id: ProjectId.make("prj_myr"),
      title: "myr",
      workspaceRoot: "/home/user/myr",
    });

    const recent = ProjectShell.make({
      ...project,
      updatedAt: DateTime.makeUnsafe("2026-10-29T08:00:00Z"),
    });

    const target = ComposerTarget.Draft({ draftId });

    const base = inform(composerOn(target), {
      ...contextFor(target),
      projects: [recent, myr],
    }).model;

    const unpicked = update(base, Message.ChangedDraft({ value: "go" })).model;

    // Without the shell's pick the draft falls back to the most recently updated project.
    assert.deepStrictEqual(
      launchOf(unpicked)?.args?.projectId,
      Option.some(recent.id)
    );

    const picked = update(
      pickDraftProject(base, draftId, myr.id),
      Message.ChangedDraft({ value: "go" })
    ).model;

    assert.deepStrictEqual(
      launchOf(picked)?.args?.projectId,
      Option.some(myr.id)
    );
  });

  it("opens the project thread with the draft's words and attachments instead of launching while its project has one (ADR 0048)", () => {
    const draftId = "019a0000-0000-7000-8000-000000000b0a";
    const key = `draft:${draftId}`;
    const to = `thread:${otherThreadId}`;

    const ref = {
      id: AttachmentId.make("att_9"),
      name: "plan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 12,
      kind: "pdf" as const,
      sha256: "0".repeat(64),
    };

    const base = composerOn(ComposerTarget.Draft({ draftId }));

    const ready: Model = {
      ...base,
      context: {
        ...base.context,
        projects: [{ ...project, projectThreadId: Option.some(otherThreadId) }],
      },
      drafts: {
        [key]: {
          ...emptyDraft,
          text: "and one more thing",
          attachments: [ref.id],
        },
      },
      attachments: {
        ...base.attachments,
        loaded: true,
        nextLocalId: 2,
        items: [
          {
            localId: "attachment-1",
            draftKey: key,
            name: ref.name,
            mimeType: ref.mimeType,
            sizeBytes: ref.sizeBytes,
            isImage: false,
            file: Option.none(),
            previewUrl: Option.none(),
            pastedAt: Option.none(),
            pasteToRequestMs: Option.none(),
            attempts: 1,
            status: AttachmentStatus.Ready({ ref }),
          },
        ],
      },
    };

    const sent = update(
      ready,
      Message.PressedSubmitKey({ intent: "foreground" })
    );

    const names = (sent.commands ?? []).map(({ name }) => name);

    assert.deepStrictEqual(
      {
        launched: names.includes(PrepareLaunch.name),
        opened: (sent.commands ?? []).find(
          ({ name }) => name === OpenProjectThread.name
        )?.args,
        outMessage: sent.outMessage,
        heroDraft: sent.model.drafts[key],
        moved: sent.model.drafts[to]?.text,
        movedAttachments: sent.model.drafts[to]?.attachments,
        tray: readyIds(sent.model.attachments, to),
        heroTray: readyIds(sent.model.attachments, key),
      },
      {
        launched: false,
        opened: { threadId: otherThreadId },
        outMessage: undefined,
        heroDraft: undefined,
        moved: "and one more thing",
        movedAttachments: [ref.id],
        tray: [ref.id],
        heroTray: [],
      }
    );

    // On the project thread's page its composer holds the words, unsent, and says why.
    const opened = inform(
      sent.model,
      contextFor(ComposerTarget.Thread({ threadId: otherThreadId }))
    ).model;

    assert.strictEqual(activeDraft(opened).text, "and one more thing");
    assert.match(
      Option.getOrElse(shownNotice(opened), () => ""),
      /already has a project thread/u
    );
  });

  it("still launches the first thread of a project with no project thread", () => {
    const draftId = "019a0000-0000-7000-8000-000000000b0b";

    const typed = update(
      composerOn(ComposerTarget.Draft({ draftId })),
      Message.ChangedDraft({ value: "begin" })
    ).model;

    assert.isDefined(launchOf(typed));
  });

  it.effect(
    "puts back the text, both ready attachments and the picked model when a launch cannot start",
    () =>
      Effect.gen(function* () {
        const draftId = "019a0000-0000-7000-8000-000000000b04";
        const key = `draft:${draftId}`;
        const picked = { provider: "opencode-go", modelId: "glm-5" };

        const readyItem = (index: number) => ({
          localId: `attachment-${index}`,
          draftKey: key,
          name: `doc-${index}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 12,
          isImage: false,
          file: Option.none(),
          previewUrl: Option.none(),
          pastedAt: Option.none(),
          pasteToRequestMs: Option.none(),
          attempts: 1,
          status: AttachmentStatus.Ready({
            ref: {
              id: AttachmentId.make(`att_${index}`),
              name: `doc-${index}.pdf`,
              mimeType: "application/pdf",
              sizeBytes: 12,
              kind: "pdf",
              sha256: "0".repeat(64),
            },
          }),
        });

        // No project: the launch first asks the brain for the scratch project, which fails.
        const base = composerOn(ComposerTarget.Draft({ draftId }));

        const ready: Model = {
          ...base,
          context: { ...base.context, projects: [] },
          drafts: {
            [key]: {
              ...emptyDraft,
              text: "start here",
              model: Option.some(picked),
              attachments: [
                AttachmentId.make("att_1"),
                AttachmentId.make("att_2"),
              ],
            },
          },
          attachments: {
            ...base.attachments,
            loaded: true,
            items: [readyItem(1), readyItem(2)],
            nextLocalId: 3,
          },
        };

        const sent = update(ready, Message.ClickedSend({ alternate: false }));

        const launch = (sent.commands ?? []).find(
          (command) => command.name === PrepareLaunch.name
        );

        assert.isDefined(launch);

        const disconnected = yield* Ref.make(Option.none());

        const answer = yield* (launch?.effect ?? Effect.die("no launch")).pipe(
          Effect.provideService(CairnConnection._tag, disconnected)
        );

        const restored = update(sent.model, answer).model;

        assert.deepStrictEqual(
          {
            text: activeDraft(restored).text,
            model: activeDraft(restored).model,
            tray: readyIds(restored.attachments, key),
            sentDraft: activeDraft(sent.model).text,
            sentTray: readyIds(sent.model.attachments, key),
          },
          {
            text: "start here",
            model: Option.some(picked),
            tray: [AttachmentId.make("att_1"), AttachmentId.make("att_2")],
            sentDraft: "",
            sentTray: [],
          }
        );
      })
  );

  it("says a send is not sent when its uploads finish after the user moved to another draft", () => {
    const key = `thread:${threadId}`;

    const uploading: Model = {
      ...onThread,
      drafts: { [key]: { ...emptyDraft, text: "with a file" } },
      attachments: {
        ...onThread.attachments,
        loaded: true,
        nextLocalId: 2,
        items: [
          {
            localId: "attachment-1",
            draftKey: key,
            name: "doc.pdf",
            mimeType: "application/pdf",
            sizeBytes: 12,
            isImage: false,
            file: Option.none(),
            previewUrl: Option.none(),
            pastedAt: Option.none(),
            pasteToRequestMs: Option.none(),
            attempts: 1,
            status: AttachmentStatus.Uploading({ progress: 0.5 }),
          },
        ],
      },
    };

    const waiting = update(
      uploading,
      Message.ClickedSend({ alternate: false })
    ).model;

    const moved = inform(
      waiting,
      contextFor(ComposerTarget.Thread({ threadId: otherThreadId }))
    ).model;

    const answered = update(
      moved,
      Message.GotAttachmentsMessage({
        message: AttachmentsMessage.SucceededUpload({
          localId: "attachment-1",
          ref: {
            id: AttachmentId.make("att_1"),
            name: "doc.pdf",
            mimeType: "application/pdf",
            sizeBytes: 12,
            kind: "pdf",
            sha256: "0".repeat(64),
          },
          pasteToRequestMs: Option.none(),
        }),
      })
    );

    assert.deepStrictEqual(
      {
        prepared: (answered.commands ?? []).some(
          (command) => command.name === PrepareSend.name
        ),
        notice: Option.map(noticeFor(answered.model.attachments, key), (text) =>
          text.startsWith("Not sent")
        ),
      },
      { prepared: false, notice: Option.some(true) }
    );
  });

  it("withdraws a queued input", () => {
    Story.story(
      update,
      Story.given(onThread),
      Story.message(
        Message.ClickedWithdraw({ submissionId: SubmissionId.make(4) })
      ),
      Story.Command.expectHas(WithdrawQueued),
      Story.Command.resolve(WithdrawQueued, Message.CompletedRequest()),
      Story.model((model: Model) => {
        assert.isTrue(Option.isNone(model.notice));
      })
    );
  });
});

describe("the new-thread hero", () => {
  const draftId = "019a0000-0000-7000-8000-000000000b02";

  it("asks what to build in the project and offers the project picker", () => {
    Scene.scene(
      { update, view },
      Scene.given(composerOn(ComposerTarget.Draft({ draftId }))),
      ...acknowledgeMounts,
      Scene.Mount.resolve(KeepDrawerRoom, Message.StartedHeroDrawerRoom()),
      Scene.expect(Scene.testId("hero-headline")).toContainText(
        "What should we build"
      ),
      Scene.expect(Scene.testId("hero-project-trigger")).toHaveText("cairn"),
      Scene.expect(Scene.testId("hero-start-without-project")).toExist(),
      Scene.expect(Scene.testId("composer-context-strip")).toContainText(
        "Current checkout"
      ),
      Scene.click(Scene.testId("hero-project-trigger")),
      Scene.expect(Scene.testId("hero-project-list")).toContainText(
        "Add project"
      ),
      Scene.tap((simulation) => {
        assert.lengthOf(simulation.commands, 0);
      })
    );
  });

  it("keeps the menu drawer's list within the room above the box, measured on the page (U-21)", () => {
    // Box 200 px below the scroller's top, unscrolled: 200 px of room.
    assert.strictEqual(
      drawerRoomOf({ scrollerTop: 56, scrollTop: 0, boxTop: 256 }),
      200
    );
    // Scrolled 120 px: the room is still counted from the top a scroll reaches.
    assert.strictEqual(
      drawerRoomOf({ scrollerTop: 56, scrollTop: 120, boxTop: 136.6 }),
      200
    );
    assert.strictEqual(
      drawerRoomOf({ scrollerTop: 56, scrollTop: 0, boxTop: 40 }),
      0
    );

    Scene.scene(
      { update, view },
      Scene.given(composerOn(ComposerTarget.Draft({ draftId }))),
      ...acknowledgeMounts,
      Scene.Mount.resolve(KeepDrawerRoom, Message.StartedHeroDrawerRoom()),
      ...typeWithCaret("/"),
      Scene.expect(menu).toExist(),
      Scene.expect(Scene.selector("[data-chat-composer-stack]")).toHaveClass(
        "[&_[data-slot=command-list]]:max-h-[min(18rem,var(--hero-drawer-room,18rem))]"
      )
    );
  });

  it("launches a draft whose project was removed in the hero's default project, not the scratch project", () => {
    const myr = ProjectShell.make({
      ...project,
      id: ProjectId.make("prj_myr"),
      title: "myr",
      workspaceRoot: "/home/user/myr",
    });

    const target = ComposerTarget.Draft({ draftId });

    const picked = pickDraftProject(
      inform(composerOn(target), {
        ...contextFor(target),
        projects: [project, myr],
      }).model,
      draftId,
      myr.id
    );

    assert.strictEqual(Option.getOrThrow(draftProject(picked)).id, myr.id);

    // myr is removed from its menu: the shell no longer holds it.
    const removed = inform(picked, {
      ...contextFor(target),
      projects: [project],
    }).model;

    assert.strictEqual(Option.getOrThrow(draftProject(removed)).id, project.id);

    const typed = update(removed, Message.ChangedDraft({ value: "go" })).model;

    assert.deepStrictEqual(
      launchOf(typed)?.args?.projectId,
      Option.some(project.id)
    );
  });

  it("asks for a project first when there is none", () => {
    const empty = inform(initial, {
      ...contextFor(ComposerTarget.Draft({ draftId })),
      projects: [],
    }).model;

    Scene.scene(
      { update, view },
      Scene.given(empty),
      Scene.expect(Scene.testId("hero-no-projects")).toContainText(
        "What should we work on?"
      ),
      Scene.expect(editor).toBeAbsent(),
      Scene.click(Scene.testId("hero-add-project")),
      Scene.expectOutMessage(OutMessage.RequestedAddProject()),
      Scene.tap((simulation) => {
        assert.lengthOf(simulation.commands, 0);
      })
    );
  });
});

describe("the model picker and the keyboard", () => {
  // The catalog with GLM 5 unavailable (no key for its provider).
  const withUnavailable = {
    ...onThread,
    catalog: Option.some({
      ...catalog,
      models: catalog.models.map((listing) =>
        listing.modelId === "glm-5" ? { ...listing, available: false } : listing
      ),
    }),
  };

  it("puts the keyboard in the search field when a picker opens", () => {
    const opened = update(
      onThread,
      Message.OpenedPopover({
        popover: Popover.ModelPicker({
          query: "",
          highlighted: Option.none(),
          provider: Option.none(),
        }),
      })
    );

    assert.deepStrictEqual(
      opened.commands?.map((command) => command.name),
      ["FocusPopoverSearch"]
    );
  });

  it("never lists or picks an unavailable model", () => {
    const opened = update(
      withUnavailable,
      Message.OpenedPopover({
        popover: Popover.ModelPicker({
          query: "",
          highlighted: Option.none(),
          provider: Option.none(),
        }),
      })
    ).model;

    assert.deepStrictEqual(
      pickerRows(opened).map((listing) => listing.modelId),
      ["kimi-k3"]
    );

    const picked = update(
      opened,
      Message.PickedModel({
        model: { provider: "opencode-go", modelId: "glm-5" },
      })
    ).model;

    assert.strictEqual(picked, opened);
  });
});
