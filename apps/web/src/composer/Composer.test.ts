import {
  AttachmentId,
  RequestId,
  SubmissionId,
  ThreadId,
} from "@cairn/protocol/Ids";
import { ConversationView } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Ref, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Mount } from "foldkit";
import * as Scene from "foldkit/scene";
import * as Story from "foldkit/story";

import { Message as AttachmentsMessage } from "../attachments/Message.ts";
import { AttachmentStatus } from "../attachments/Model.ts";
import { AttachmentPaste } from "../attachments/Paste.ts";
import { readyIds } from "../attachments/Update.ts";
import { CairnConnection } from "../connection/Connection.ts";
import { OutboxItem } from "../connection/Outbox.ts";
import { AppRoute } from "../Route.ts";
import {
  MoveHeroToDraftUrl,
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
import { activeDraft, loadDrafts, saveDrafts } from "./Drafts.ts";
import { ComposerInput } from "./Editor.ts";
import { MeasureFooter } from "./Footer.ts";
import { MeasureHeadline } from "./MeasureHeadline.ts";
import { Message, OutMessage } from "./Message.ts";
import { ComposerTarget, emptyDraft, initial, Popover } from "./Model.ts";
import type { Model } from "./Model.ts";
import { contextChanged, inform, update } from "./Update.ts";
import { view } from "./View.ts";

const editor = Scene.testId("composer-editor");

const menu = Scene.testId("composer-menu");

const onThread = composerOn(ComposerTarget.Thread({ threadId }));

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
 * t3code's footer at each composer width, recorded from the installed nightly
 * (t3code-nightly-bin 0.1.1_nightly.20261020.3438, commit fe27e8e3) on 2026-10-22 by forcing
 * `[data-slot=composer-shell]` to the width and reading its attributes. The measurement is t3code's
 * own at that build: the model picker 169.17 px, the traits block 124.39 px and the mode block
 * 139.78 px wide (63 px each icon-only), a 4 px gap, and the controls' host 18 px narrower than the
 * cluster (its padding). Cairn's folding must give the same states for the same widths.
 */
const t3FooterStates: ReadonlyArray<{
  readonly width: number;
  readonly host: number;
  readonly compact: boolean;
  readonly traits: "full" | "icon" | "hidden";
  readonly mode: "full" | "icon" | "hidden";
  readonly overflow: boolean;
}> = [
  {
    width: 900,
    host: 634,
    compact: false,
    traits: "full",
    mode: "full",
    overflow: false,
  },
  {
    width: 780,
    host: 634,
    compact: false,
    traits: "full",
    mode: "full",
    overflow: false,
  },
  {
    width: 700,
    host: 598,
    compact: false,
    traits: "full",
    mode: "full",
    overflow: false,
  },
  {
    width: 620,
    host: 518,
    compact: false,
    traits: "full",
    mode: "full",
    overflow: false,
  },
  {
    width: 560,
    host: 452,
    compact: true,
    traits: "full",
    mode: "full",
    overflow: false,
  },
  {
    width: 520,
    host: 412,
    compact: true,
    traits: "full",
    mode: "icon",
    overflow: false,
  },
  {
    width: 480,
    host: 372,
    compact: true,
    traits: "full",
    mode: "icon",
    overflow: false,
  },
  {
    width: 440,
    host: 332,
    compact: true,
    traits: "icon",
    mode: "icon",
    overflow: false,
  },
  {
    width: 400,
    host: 292,
    compact: true,
    traits: "icon",
    mode: "hidden",
    overflow: true,
  },
  {
    width: 360,
    host: 252,
    compact: true,
    traits: "hidden",
    mode: "hidden",
    overflow: true,
  },
];

const block = (name: string) =>
  Scene.selector(`[data-resting-block="${name}"]`);

const expectBlock = (name: string, state: "full" | "icon" | "hidden") => [
  Scene.expect(block(name)).toHaveAttr(
    "data-composer-block-icon-only",
    String(state !== "full")
  ),
  Scene.expect(block(name)).toHaveAttr(
    "data-composer-block-hidden",
    String(state === "hidden")
  ),
];

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
        popover: Popover.ModelPicker({ query: "", highlighted: Option.none() }),
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
  it.each(t3FooterStates)(
    "matches t3code's footer at $width px",
    ({ compact, host, mode, overflow, traits, width }) => {
      Scene.scene(
        { update, view },
        Scene.given(onThread),
        ...acknowledgeMounts,
        Scene.Subscription.emit(
          Message.MeasuredFooter({
            width,
            hostWidth: host,
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
        Scene.expect(Scene.selector("[data-chat-composer-footer]")).toHaveAttr(
          "data-chat-composer-footer-compact",
          String(compact)
        ),
        ...expectBlock("traits", traits),
        ...expectBlock("mode", mode),
        overflow
          ? Scene.expect(
              Scene.selector("[data-resting-controls-overflow]")
            ).not.toHaveAttr("aria-hidden")
          : Scene.expect(
              Scene.selector("[data-resting-controls-overflow]")
            ).toHaveAttr("aria-hidden", "true"),
        Scene.tap((simulation) => {
          assert.lengthOf(simulation.commands, 0);
        })
      );
    }
  );
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
        yield* saveDrafts(back.drafts);

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
        Message.CompletedSaveDrafts({ version: 2, saved: true })
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
        assert.deepStrictEqual(catalog.defaults.model.modelId, "kimi-k3");
      })
    );
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
        notice: Option.map(answered.model.attachments.notice, (notice) => [
          notice.draftKey,
          notice.text.startsWith("Not sent"),
        ]),
      },
      { prepared: false, notice: Option.some([key, true]) }
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
      Scene.Mount.resolve(
        MeasureHeadline,
        Message.MeasuredHeadline({ inline: true })
      ),
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
