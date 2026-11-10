// The composer's streams: the soft keyboard, the draft saver's 300 ms pause, the `@` search's 120 ms
// debounce, the `pagehide` flush, another tab's draft writes, and type-to-focus (a printable key pressed with focus on no field
// starts typing into the composer, from t3code's composerFocusRedirect.ts).

import { isTypeToFocusKey } from "@cairn/client-logic/ComposerLogic";
import { ProjectId } from "@cairn/protocol/Ids";
import { Duration, Effect, Option, Predicate, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import {
  streamFromEventFilterMap,
  streamFromEventFilterMapPreventDefault,
} from "foldkit/dom";

import type { CairnConnectionService } from "../connection/Connection.ts";
import { storageChanges } from "../storage/TabChanges.ts";
import { attachmentSubscriptions } from "./AttachmentTray.ts";
import {
  fetchBranches,
  fetchModels,
  fetchSkills,
  mintHomeDraft,
} from "./Command.ts";
import {
  DRAFT_SAVE_DEBOUNCE_MS,
  DRAFTS_STORAGE_KEY,
  draftProject,
  isDraftTarget,
  targetProject,
} from "./Drafts.ts";
import { EDITOR_TEST_ID } from "./Editor.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { softwareKeyboardChanges } from "./SoftwareKeyboard.ts";

/** How long the `@` search waits for typing to pause. */
export const PATH_SEARCH_DEBOUNCE_MS = 120;

const EDITABLE =
  'input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]';

const INTERACTIVE =
  'button,a[href],summary,[role="application"],[role="button"],[role="checkbox"],[role="menuitem"],[role="option"],[role="radio"],[role="switch"],[role="tab"]';

const FLOATING_LAYER =
  '[role="dialog"][aria-modal="true"],[data-slot="popover-popup"],[data-slot="menu-popup"],[data-slot="sheet-popup"]';

const pathContains = (event: Event, selector: string): boolean =>
  event
    .composedPath()
    .some(
      (target) => target instanceof Element && target.closest(selector) !== null
    );

/**
 * Whether the editor is drawn. On the phone the request card takes the composer's slot and the
 * editor is hidden (`next/card/card.css`): a key then lands nowhere rather than in a draft the user
 * cannot see (W-1).
 */
const editorShown = (): boolean =>
  Option.exists(
    Option.fromNullishOr(
      document.querySelector(`[data-testid="${EDITOR_TEST_ID}"]`)
    ),
    (editor) => editor.getClientRects().length > 0
  );

/**
 * t3code's rule: only keys that land on nothing editable or interactive, with no popup open, and
 * only while the editor is drawn.
 */
const shouldRedirect = (event: KeyboardEvent): boolean =>
  !event.defaultPrevented &&
  isTypeToFocusKey({
    key: event.key,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    isComposing: event.isComposing,
    // oxlint-disable-next-line typescript/no-deprecated -- Safari marks its IME confirm keydown only by keyCode 229
    keyCode: event.keyCode,
    repeat: event.repeat,
  }) &&
  !pathContains(event, EDITABLE) &&
  !pathContains(event, INTERACTIVE) &&
  document.querySelector(FLOATING_LAYER) === null &&
  editorShown();

const typeToFocus = streamFromEventFilterMapPreventDefault({
  target: document,
  type: "keydown",
  filterMapEvent: (event) =>
    shouldRedirect(event)
      ? Option.some(Message.TypedOutsideEditor({ text: event.key }))
      : Option.none(),
});

const pageHides = streamFromEventFilterMap({
  target: window,
  type: "pagehide",
  filterMapEvent: () => Option.some(Message.HidPage()),
});

const after = <A>(millis: number, message: A): Stream.Stream<A> =>
  Stream.fromEffect(Effect.as(Effect.sleep(Duration.millis(millis)), message));

/** The draft's folder project, whose branches the context strip offers. */
const branchProject = (model: Model) =>
  Option.filter(
    isDraftTarget(model) ? draftProject(model) : Option.none(),
    (project) => project.kind === "folder"
  );

const trayLifted = attachmentSubscriptions<Model, Message>({
  read: (model) => Option.some(model.attachments),
  toParentMessage: (message) => Message.GotAttachmentsMessage({ message }),
});

/**
 * The composer's subscriptions. The brain's lists (models, skills, branches) load from here, keyed
 * on what they depend on, so a new connection or project fetches again and nothing asks twice.
 */
export const subscriptions = Subscription.make<
  Model,
  Message,
  CairnConnectionService
>()((entry) => ({
  models: entry(
    { epoch: Schema.Int, hasClient: Schema.Boolean, loaded: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        epoch: model.context.epoch,
        hasClient: model.context.hasClient,
        loaded: Option.isSome(model.catalog),
      }),
      dependenciesToStream: ({ epoch, hasClient, loaded }) =>
        hasClient && !loaded
          ? Stream.fromEffect(fetchModels(epoch))
          : Stream.empty,
    }
  ),
  skills: entry(
    {
      projectId: Schema.Option(ProjectId),
      hasClient: Schema.Boolean,
      loaded: Schema.Boolean,
    },
    {
      modelToDependencies: (model) => {
        const projectId = Option.map(targetProject(model), ({ id }) => id);

        return {
          projectId,
          hasClient: model.context.hasClient,
          loaded: Option.exists(model.skills, (skills) =>
            Option.contains(projectId, skills.projectId)
          ),
        };
      },
      dependenciesToStream: ({ hasClient, loaded, projectId }) =>
        Option.match(
          Option.filter(projectId, () => hasClient && !loaded),
          {
            onNone: () => Stream.empty,
            onSome: (id) => Stream.fromEffect(fetchSkills(id)),
          }
        ),
    }
  ),
  branches: entry(
    {
      projectId: Schema.Option(ProjectId),
      hasClient: Schema.Boolean,
      loaded: Schema.Boolean,
    },
    {
      modelToDependencies: (model) => {
        const projectId = Option.map(branchProject(model), ({ id }) => id);

        return {
          projectId,
          hasClient: model.context.hasClient,
          loaded: Option.exists(model.branches, (branches) =>
            Option.contains(projectId, branches.projectId)
          ),
        };
      },
      dependenciesToStream: ({ hasClient, loaded, projectId }) =>
        Option.match(
          Option.filter(projectId, () => hasClient && !loaded),
          {
            onNone: () => Stream.empty,
            onSome: (id) => Stream.fromEffect(fetchBranches(id)),
          }
        ),
    }
  ),
  homeDraft: entry(
    { needed: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        needed:
          Predicate.isTagged(model.context.target, "Home") &&
          Option.isNone(model.homeDraftId),
      }),
      dependenciesToStream: ({ needed }) =>
        needed ? Stream.fromEffect(mintHomeDraft) : Stream.empty,
    }
  ),
  softwareKeyboard: Subscription.persistentEntry(
    Stream.map(softwareKeyboardChanges, (open) =>
      Message.ChangedSoftwareKeyboard({ open })
    )
  ),
  pageHide: Subscription.persistentEntry(pageHides),
  storedDrafts: Subscription.persistentEntry(
    storageChanges(DRAFTS_STORAGE_KEY, Message.ChangedStoredDrafts())
  ),
  typeToFocus: Subscription.persistentEntry(typeToFocus),
  attachmentProgress: trayLifted.uploadProgress,
  attachmentPaste: trayLifted.documentPaste,
  attachmentStorage: trayLifted.storedAttachments,
  draftSave: entry(
    { version: Schema.Int, saved: Schema.Int },
    {
      modelToDependencies: (model) => ({
        version: model.draftsVersion,
        saved: model.savedVersion,
      }),
      dependenciesToStream: ({ saved, version }) =>
        version > saved
          ? after(
              DRAFT_SAVE_DEBOUNCE_MS,
              Message.ElapsedDraftDebounce({ version })
            )
          : Stream.empty,
    }
  ),
  pathSearch: entry(
    {
      projectId: Schema.Option(ProjectId),
      query: Schema.Option(Schema.String),
    },
    {
      modelToDependencies: (model) => ({
        projectId: Option.map(targetProject(model), ({ id }) => id),
        query: model.pathSearch.pending,
      }),
      dependenciesToStream: ({ projectId, query }) =>
        Option.match(Option.all({ projectId, query }), {
          onNone: () => Stream.empty,
          onSome: (search) =>
            after(
              PATH_SEARCH_DEBOUNCE_MS,
              Message.ElapsedPathSearchDebounce(search)
            ),
        }),
    }
  ),
}));
