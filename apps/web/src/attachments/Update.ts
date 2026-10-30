// The tray's update. Files are admitted against Cairn's limits, images are fitted first, and every
// item then waits for one of three upload slots, shared by every draft, and starts at once when
// one is free (eager upload). A retryable failure gets one more attempt with a new URL before it
// shows. A send pressed while the draft still has uploads in flight waits here and fires the moment
// the last one answers (t3code's pending-draft-work rule, as a count of pending items). The
// composer passes the active draft's key with each Message, and calls the capabilities at the
// bottom when a turn is sent or a draft is discarded.

import {
  admitAttachmentFiles,
  imageTooLarge,
} from "@cairn/client-logic/AttachmentFiles";
import { nextPastedTextFileName } from "@cairn/client-logic/TextPaste";
import type { AttachmentRef } from "@cairn/protocol/Attachments";
import type { AttachmentId } from "@cairn/protocol/Ids";
import { Array, Option, Record } from "effect";
import type { Command, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { Services } from "../Command.ts";
import {
  DiscardAttachment,
  LoadSaved,
  PrepareImage,
  RevokePreview,
  SaveReady,
  UploadAttachment,
} from "./Command.ts";
import { Message, OutMessage } from "./Message.ts";
import { AttachmentStatus, initial } from "./Model.ts";
import type { Item, Model, SendIntent } from "./Model.ts";
import type { SavedAttachments } from "./Saved.ts";
import { MAX_CONCURRENT_UPLOADS } from "./UploadQueue.ts";

/** What the tray's update returns. */
export type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  Services
>;

type TrayCommand = Command.Command<Message, never, Services>;

/** What the composer tells the tray with each Message: the draft that is open now. */
export interface TrayContext {
  readonly draftKey: Option.Option<string>;
}

/** Upload attempts an item gets before a retryable failure shows. */
const MAX_AUTOMATIC_ATTEMPTS = 2;

/** The tray's first Model, and the read of what was saved on this device. */
export const init = (): Update.Return<Model, Message, Services> => ({
  model: initial,
  commands: [LoadSaved()],
});

/** One draft's items, oldest first. */
export const itemsOf = (model: Model, draftKey: string): ReadonlyArray<Item> =>
  Array.filter(model.items, (item) => item.draftKey === draftKey);

const isPending = (item: Item): boolean =>
  AttachmentStatus.match(item.status, {
    Preparing: () => true,
    Queued: () => true,
    Uploading: () => true,
    Ready: () => false,
    Failed: () => false,
  });

const isFailed = (item: Item): boolean =>
  AttachmentStatus.guards.Failed(item.status);

/** The brain's ref for an attachment whose upload is ready; none until then. */
export const readyRef = (item: Item): Option.Option<AttachmentRef> =>
  AttachmentStatus.guards.Ready(item.status)
    ? Option.some(item.status.ref)
    : Option.none();

/** How many of a draft's attachments are still being fitted or uploaded. */
export const pendingCount = (model: Model, draftKey: string): number =>
  Array.filter(itemsOf(model, draftKey), isPending).length;

/** True when a send of this draft must wait: an upload is in flight, or one failed. */
export const mustWait = (model: Model, draftKey: string): boolean =>
  Array.some(
    itemsOf(model, draftKey),
    (item) => isPending(item) || isFailed(item)
  );

/** The brain's ids of a draft's ready attachments, in the order they were attached. */
export const readyIds = (
  model: Model,
  draftKey: string
): ReadonlyArray<AttachmentId> =>
  Array.getSomes(itemsOf(model, draftKey).map(readyRef)).map(({ id }) => id);

/** True when the draft has any attachment, ready or not. */
export const hasAttachments = (model: Model, draftKey: string): boolean =>
  Array.some(model.items, (item) => item.draftKey === draftKey);

const savedFrom = (items: ReadonlyArray<Item>): SavedAttachments =>
  Array.reduce(
    items,
    Record.empty<string, ReadonlyArray<AttachmentRef>>(),
    (saved, item) =>
      Option.match(readyRef(item), {
        onNone: () => saved,
        onSome: (ref) => ({
          ...saved,
          [item.draftKey]: Array.append(saved[item.draftKey] ?? [], ref),
        }),
      })
  );

/** The save of every ready attachment, once the saved ones were read (else they would be lost). */
const saveCommands = (model: Model): ReadonlyArray<TrayCommand> =>
  model.loaded ? [SaveReady({ drafts: savedFrom(model.items) })] : [];

const revokeCommands = (
  items: ReadonlyArray<Item>
): ReadonlyArray<TrayCommand> =>
  Array.getSomes(items.map((item) => item.previewUrl)).map((url) =>
    RevokePreview({ url })
  );

const replaceItem = (
  model: Model,
  localId: string,
  change: (item: Item) => Item
): Model =>
  modifyFields(model, {
    items: (items) =>
      items.map((item) => (item.localId === localId ? change(item) : item)),
  });

const findItem = (model: Model, localId: string): Option.Option<Item> =>
  Array.findFirst(model.items, (item) => item.localId === localId);

/** Starts queued uploads, oldest first, while a slot is free. */
const pump = (model: Model) => {
  let running = Array.filter(model.items, (item) =>
    AttachmentStatus.guards.Uploading(item.status)
  ).length;

  const commands: Array<TrayCommand> = [];

  const items = model.items.map((item) => {
    if (
      running >= MAX_CONCURRENT_UPLOADS ||
      !AttachmentStatus.guards.Queued(item.status)
    ) {
      return item;
    }

    return Option.match(item.file, {
      onNone: () => item,
      onSome: (file) => {
        running += 1;
        commands.push(
          UploadAttachment({
            localId: item.localId,
            file,
            name: item.name,
            mimeType: item.mimeType,
            pastedAt: item.pastedAt,
          })
        );

        return {
          ...item,
          attempts: item.attempts + 1,
          status: AttachmentStatus.Uploading({ progress: 0 }),
        };
      },
    });
  });

  return { model: modifyFields(model, { items: () => items }), commands };
};

/**
 * Settles a waiting send: it fires when the draft has nothing pending and nothing failed, and is
 * dropped with a note when an attachment failed for good.
 */
const settleWaitingSend = (model: Model): UpdateReturn =>
  Option.match(model.waitingSend, {
    onNone: () => ({ model }),
    onSome: ({ draftKey, intent }) => {
      const items = itemsOf(model, draftKey);

      if (Array.some(items, isPending)) {
        return { model };
      }

      if (Array.some(items, isFailed)) {
        return {
          model: modifyFields(model, {
            waitingSend: () => Option.none(),
            notice: () =>
              Option.some({
                draftKey,
                text: "An attachment did not upload, so the message was not sent. Retry or remove it, then send again.",
              }),
          }),
        };
      }

      return {
        model: modifyFields(model, { waitingSend: () => Option.none() }),
        outMessage: OutMessage.ReadyToSend({ draftKey, intent }),
      };
    },
  });

/** Pumps the queue and settles a waiting send after a change, keeping `commands` first. */
const afterChange = (
  model: Model,
  commands: ReadonlyArray<TrayCommand>,
  outMessage: Option.Option<OutMessage> = Option.none()
): UpdateReturn => {
  const pumped = pump(model);
  const settled = settleWaitingSend(pumped.model);

  return {
    model: settled.model,
    commands: [...commands, ...pumped.commands],
    // A send that fires wins over a note about one attachment: the composer re-reads the tray.
    ...Option.match(
      Option.orElse(
        Option.fromUndefinedOr(settled.outMessage),
        () => outMessage
      ),
      {
        onNone: () => ({}),
        onSome: (message) => ({ outMessage: message }),
      }
    ),
  };
};

const fileFacts = (file: File) => ({
  name: file.name,
  type: file.type,
  size: file.size,
});

/** Admits `files` into the open draft and starts their work; refusals become the tray's note. */
const addFiles = (
  model: Model,
  context: TrayContext,
  files: ReadonlyArray<File>,
  pastedAt: Option.Option<number>,
  rename: (item: Item, siblings: ReadonlyArray<Item>) => string = (item) =>
    item.name
): UpdateReturn => {
  if (Option.isNone(context.draftKey) || files.length === 0) {
    return { model };
  }

  const draftKey = context.draftKey.value;
  const existing = itemsOf(model, draftKey);
  const admission = admitAttachmentFiles(files.map(fileFacts), existing.length);
  const commands: Array<TrayCommand> = [];
  const added: Array<Item> = [];

  for (const [offset, admitted] of admission.admitted.entries()) {
    const file = files[admitted.index];

    if (file !== undefined) {
      const localId = `attachment-${model.nextLocalId + offset}`;
      const isImage = admitted.kind === "image";

      const draft: Item = {
        localId,
        draftKey,
        name: file.name,
        mimeType: admitted.mimeType,
        sizeBytes: file.size,
        isImage,
        file: Option.some(file),
        previewUrl: Option.none(),
        pastedAt,
        pasteToRequestMs: Option.none(),
        attempts: 0,
        status: isImage
          ? AttachmentStatus.Preparing()
          : AttachmentStatus.Queued(),
      };

      added.push({ ...draft, name: rename(draft, [...existing, ...added]) });

      if (isImage) {
        commands.push(
          PrepareImage({ localId, file, mimeType: admitted.mimeType })
        );
      }
    }
  }

  const next = modifyFields(model, {
    items: (items) => [...items, ...added],
    nextLocalId: (id) => id + admission.admitted.length,
    notice: () =>
      admission.refusals.length === 0
        ? Option.none()
        : Option.some({ draftKey, text: admission.refusals.join(" ") }),
  });

  return afterChange(next, commands);
};

/** The next free `pasted-text.txt` name among the draft's items. */
const pastedTextName = (_item: Item, siblings: ReadonlyArray<Item>): string =>
  nextPastedTextFileName(siblings.map(({ name }) => name));

/** Removes one item: aborts its upload, releases its thumbnail, and takes back a stored upload. */
const removeItem = (model: Model, localId: string): UpdateReturn =>
  Option.match(findItem(model, localId), {
    onNone: () => ({ model }),
    onSome: (item) => {
      const without = modifyFields(model, {
        items: (items) =>
          Array.filter(items, (other) => other.localId !== localId),
      });

      const cancel: ReadonlyArray<TrayCommand> =
        AttachmentStatus.guards.Uploading(item.status)
          ? [
              UploadAttachment.Interrupt({ localId }, () =>
                Message.CompletedCancelUpload({ localId })
              ),
            ]
          : [];

      const ref = readyRef(item);

      const discard: ReadonlyArray<TrayCommand> = Option.match(ref, {
        onNone: () => [],
        onSome: ({ id }) => [DiscardAttachment({ attachmentId: id })],
      });

      return afterChange(
        without,
        [
          ...cancel,
          ...revokeCommands([item]),
          ...discard,
          ...Option.match(ref, {
            onNone: () => [],
            onSome: () => saveCommands(without),
          }),
        ],
        Option.map(ref, ({ id }) =>
          OutMessage.Detached({ draftKey: item.draftKey, attachmentId: id })
        )
      );
    },
  });

/**
 * Queues a failed item again, with a new URL and a fresh attempt count. A refusal of the file itself
 * (too large, a type the brain will not take) stays failed: only removing it helps.
 */
const requeue = (item: Item): Item =>
  AttachmentStatus.guards.Failed(item.status) &&
  item.status.retryable &&
  Option.isSome(item.file)
    ? { ...item, attempts: 0, status: AttachmentStatus.Queued() }
    : item;

/** Ready items for `refs` in `draftKey`, skipping refs the tray already holds. */
const readyItemsFor = (
  model: Model,
  draftKey: string,
  refs: ReadonlyArray<AttachmentRef>
) => {
  const known = new Set(
    Array.getSomes(model.items.map(readyRef)).map(({ id }) => id)
  );

  let next = model.nextLocalId;

  const items = Array.filter(refs, ({ id }) => !known.has(id)).map(
    (ref): Item => {
      const localId = `attachment-${next}`;

      next += 1;

      return {
        localId,
        draftKey,
        name: ref.name,
        mimeType: ref.mimeType,
        sizeBytes: ref.sizeBytes,
        isImage: ref.kind === "image",
        file: Option.none(),
        previewUrl: Option.none(),
        pastedAt: Option.none(),
        pasteToRequestMs: Option.none(),
        attempts: 0,
        status: AttachmentStatus.Ready({ ref }),
      };
    }
  );

  return { items, nextLocalId: next };
};

const restoreSaved = (model: Model, saved: SavedAttachments): Model => {
  let { nextLocalId } = model;
  const restored: Array<Item> = [];

  for (const [draftKey, refs] of Record.toEntries(saved)) {
    const made = readyItemsFor({ ...model, nextLocalId }, draftKey, refs);

    restored.push(...made.items);
    ({ nextLocalId } = made);
  }

  return modifyFields(model, {
    items: (items) => [...restored, ...items],
    nextLocalId: () => nextLocalId,
    loaded: () => true,
  });
};

/** The tray's update; `context` names the draft that is open now. */
export const update = (
  model: Model,
  message: Message,
  context: TrayContext
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    PastedFiles: ({ files, pastedAt }) =>
      addFiles(model, context, files, Option.some(pastedAt)),
    PastedText: ({ file, pastedAt }) =>
      addFiles(model, context, [file], Option.some(pastedAt), pastedTextName),
    DroppedFiles: ({ files }) => addFiles(model, context, files, Option.none()),
    PickedFiles: ({ files }) => addFiles(model, context, files, Option.none()),
    ClickedRemove: ({ localId }) => removeItem(model, localId),
    ClickedRetry: ({ localId }) =>
      afterChange(replaceItem(model, localId, requeue), []),
    ClickedDismissNotice: () => ({
      model: modifyFields(model, { notice: () => Option.none() }),
    }),

    PreparedImage: ({ file, localId, previewUrl }) =>
      Option.match(findItem(model, localId), {
        // Removed while it was being fitted: only the thumbnail is left to release.
        onNone: () => ({
          model,
          commands: Option.match(previewUrl, {
            onNone: () => [],
            onSome: (url) => [RevokePreview({ url })],
          }),
        }),
        onSome: () =>
          afterChange(
            replaceItem(model, localId, (item) => ({
              ...item,
              name: file.name,
              mimeType: file.type || item.mimeType,
              sizeBytes: file.size,
              file: Option.some(file),
              previewUrl,
              status: Option.match(imageTooLarge(file.size), {
                onNone: () => AttachmentStatus.Queued(),
                onSome: (reason) =>
                  AttachmentStatus.Failed({ reason, retryable: false }),
              }),
            })),
            []
          ),
      }),
    ProgressedUpload: ({ localId, progress }) => ({
      model: replaceItem(model, localId, (item) =>
        AttachmentStatus.guards.Uploading(item.status) &&
        progress > item.status.progress
          ? { ...item, status: AttachmentStatus.Uploading({ progress }) }
          : item
      ),
    }),
    SucceededUpload: ({ localId, pasteToRequestMs, ref }) =>
      Option.match(findItem(model, localId), {
        // Removed as it finished: the brain holds an upload nobody will send.
        onNone: () => ({
          model,
          commands: [DiscardAttachment({ attachmentId: ref.id })],
        }),
        onSome: (item) => {
          const next = replaceItem(model, localId, (current) => ({
            ...current,
            // The bytes are stored; the thumbnail keeps its own URL.
            file: Option.none(),
            pasteToRequestMs,
            status: AttachmentStatus.Ready({ ref }),
          }));

          return afterChange(
            next,
            saveCommands(next),
            Option.some(
              OutMessage.Attached({
                draftKey: item.draftKey,
                attachmentId: ref.id,
              })
            )
          );
        },
      }),
    FailedUpload: ({ localId, pasteToRequestMs, reason, retryable }) =>
      afterChange(
        replaceItem(model, localId, (item) => {
          const measured = Option.orElse(
            item.pasteToRequestMs,
            () => pasteToRequestMs
          );

          return retryable && item.attempts < MAX_AUTOMATIC_ATTEMPTS
            ? {
                ...item,
                pasteToRequestMs: measured,
                status: AttachmentStatus.Queued(),
              }
            : {
                ...item,
                pasteToRequestMs: measured,
                status: AttachmentStatus.Failed({ reason, retryable }),
              };
        }),
        []
      ),
    CompletedCancelUpload: () => ({ model }),
    CompletedDiscard: () => ({ model }),
    CompletedRevokePreview: () => ({ model }),

    LoadedSaved: ({ drafts }) => {
      const restored = restoreSaved(model, drafts);

      return { model: restored, commands: saveCommands(restored) };
    },
    CompletedSave: ({ saved }) =>
      saved
        ? { model }
        : Option.match(context.draftKey, {
            onNone: () => ({ model }),
            onSome: (draftKey) => ({
              model: modifyFields(model, {
                notice: () =>
                  Option.some({
                    draftKey,
                    text: "Attachments could not be saved on this device. Send before you reload this page.",
                  }),
              }),
            }),
          }),
  });

/**
 * Asks for the draft to be sent once its uploads answer. Failed uploads are tried again (a send
 * retries them, as in t3code); the tray fires `ReadyToSend` when the last one answers.
 */
export const requestSend = (
  model: Model,
  draftKey: string,
  intent: SendIntent
): UpdateReturn =>
  afterChange(
    modifyFields(model, {
      items: (items) =>
        items.map((item) =>
          item.draftKey === draftKey ? requeue(item) : item
        ),
      waitingSend: () => Option.some({ draftKey, intent }),
      notice: () => Option.none(),
    }),
    []
  );

/** The ready refs of a draft's attachments, in the order they were attached. */
export const readyRefs = (
  model: Model,
  draftKey: string
): ReadonlyArray<AttachmentRef> =>
  Array.getSomes(itemsOf(model, draftKey).map(readyRef));

/**
 * Puts the attachments of a turn the brain refused back into `draftKey`, as ready items: the brain
 * still holds them, so nothing uploads again.
 */
export const restore = (
  model: Model,
  draftKey: string,
  refs: ReadonlyArray<AttachmentRef>
): Update.Return<Model, Message, Services> => {
  const made = readyItemsFor(model, draftKey, refs);

  const next = modifyFields(model, {
    items: (items) => [...items, ...made.items],
    nextLocalId: () => made.nextLocalId,
  });

  return { model: next, commands: saveCommands(next) };
};

/** Says in `draftKey`'s tray that its send was let go when the user moved to another draft. */
export const noteNotSent = (model: Model, draftKey: string): Model =>
  modifyFields(model, {
    notice: () =>
      Option.some({
        draftKey,
        text: "Not sent: its attachments finished after you moved away. Press Send again.",
      }),
  });

/** Forgets a draft's attachments after its turn was sent: the brain has claimed them. */
export const clearSent = (
  model: Model,
  draftKey: string
): Update.Return<Model, Message, Services> => {
  const sent = itemsOf(model, draftKey);

  const next = modifyFields(model, {
    items: (items) => Array.filter(items, (item) => item.draftKey !== draftKey),
    waitingSend: (waiting) =>
      Option.filter(waiting, (send) => send.draftKey !== draftKey),
    notice: (notice) =>
      Option.filter(notice, (note) => note.draftKey !== draftKey),
  });

  return {
    model: next,
    commands: [...revokeCommands(sent), ...saveCommands(next)],
  };
};
