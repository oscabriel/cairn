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
import { laterRead } from "../storage/TabChanges.ts";
import type { LastRead } from "../storage/TabChanges.ts";
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
import { rebaseSaved, savedUnion, savedWithin, savedWithout } from "./Saved.ts";
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

/** True while `draftKey`'s send waits for its uploads. */
export const waitsFor = (model: Model, draftKey: string): boolean =>
  Record.has(model.waitingSends, draftKey);

/** `draftKey`'s tray note, if it has one. */
export const noticeFor = (
  model: Model,
  draftKey: string
): Option.Option<string> => Record.get(model.notices, draftKey);

const setNotice = (
  model: Model,
  draftKey: string,
  text: Option.Option<string>
): Model =>
  modifyFields(model, {
    notices: (notices) =>
      Option.match(text, {
        onNone: () => Record.remove(notices, draftKey),
        onSome: (note) => Record.set(notices, draftKey, note),
      }),
  });

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

/** The tray with a save on its way, and the save. */
interface Saving {
  readonly model: Model;
  readonly commands?: ReadonlyArray<TrayCommand>;
}

/**
 * The save of what this tab changed in the ready attachments since it last asked for one, once the
 * saved ones were read (else this tab would not know which of them it removed). What it asks for is
 * its base from now on, not from when the save answers: a save asked for while another is on its
 * way writes only what changed since that one, so the send that empties the tray as the last upload
 * answers also removes that upload, which its own save, still on its way, was adding.
 */
const save = (model: Model): Saving => {
  if (!model.loaded) {
    return { model };
  }

  const drafts = savedFrom(model.items);

  return {
    model: modifyFields(model, { stored: () => drafts }),
    commands: [
      SaveReady({ base: model.stored, read: model.storedRead, drafts }),
    ],
  };
};

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

const stopWaiting = (model: Model, draftKey: string): Model =>
  modifyFields(model, {
    waitingSends: (waiting) => Record.remove(waiting, draftKey),
  });

/**
 * Settles every draft's waiting send: one fires when its draft has nothing pending and nothing
 * failed, and one is dropped with a note in its own draft when an attachment failed for good. One
 * change settles at most one upload, so at most one send fires; another ready one fires on the next.
 */
const settleWaitingSend = (model: Model): UpdateReturn =>
  Array.reduce(
    Record.toEntries(model.waitingSends),
    { model },
    (settled: UpdateReturn, [draftKey, intent]): UpdateReturn => {
      const items = itemsOf(settled.model, draftKey);

      if (Array.some(items, isPending)) {
        return settled;
      }

      if (Array.some(items, isFailed)) {
        return {
          ...settled,
          model: setNotice(
            stopWaiting(settled.model, draftKey),
            draftKey,
            Option.some(
              "An attachment did not upload, so the message was not sent. Retry or remove it, then send again."
            )
          ),
        };
      }

      return settled.outMessage === undefined
        ? {
            model: stopWaiting(settled.model, draftKey),
            outMessage: OutMessage.ReadyToSend({ draftKey, intent }),
          }
        : settled;
    }
  );

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

  const next = setNotice(
    modifyFields(model, {
      items: (items) => [...items, ...added],
      nextLocalId: (id) => id + admission.admitted.length,
    }),
    draftKey,
    admission.refusals.length === 0
      ? Option.none()
      : Option.some(admission.refusals.join(" "))
  );

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

      const saved: Saving = Option.match(ref, {
        onNone: () => ({ model: without }),
        onSome: () => save(without),
      });

      return afterChange(
        saved.model,
        Array.appendAll(
          [...cancel, ...revokeCommands([item]), ...discard],
          saved.commands ?? []
        ),
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

const isIn = (saved: SavedAttachments, item: Item, ref: AttachmentRef) =>
  Option.exists(Record.get(saved, item.draftKey), (refs) =>
    refs.some(({ id }) => id === ref.id)
  );

/**
 * The tray once storage holds `stored`, read at `read`: the base of the next save becomes `stored`
 * with what this tab asked for in the saves still on their way since `written`, and the ready items
 * follow every attachment this tab did not add or remove since `written`, so one another tab
 * removed (or a clear of storage took) goes and one it added comes in. Items still on their way stay. One this tab took out in a refused save
 * never comes back: a save asked before the refusal answered did not write its removal, so storage
 * may still hold it until a later save does. One this tab holds again (a turn put back into its
 * draft) is no longer a removal.
 */
const syncSaved = (
  model: Model,
  written: SavedAttachments,
  stored: SavedAttachments,
  read: Option.Option<LastRead>
) => {
  const mine = savedFrom(model.items);
  const refused = savedWithout(model.refusedRemovals, mine);
  const target = savedWithout(rebaseSaved(written, mine, stored), refused);

  const isGone = (item: Item): boolean =>
    Option.exists(readyRef(item), (ref) => !isIn(target, item, ref));

  const dropped = Array.filter(model.items, isGone);
  const kept = Array.filter(model.items, (item) => !isGone(item));

  // The base of the next save: storage as answered, with what this tab asked for in the saves
  // still on their way since `written`.
  const next = modifyFields(
    restoreSaved(modifyFields(model, { items: () => kept }), target),
    {
      stored: () => rebaseSaved(written, model.stored, stored),
      storedRead: (last) => laterRead(read, last),
      refusedRemovals: () => savedWithin(refused, stored),
    }
  );

  return { model: next, commands: revokeCommands(dropped) };
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
    ClickedDismissNotice: () =>
      Option.match(context.draftKey, {
        onNone: () => ({ model }),
        onSome: (draftKey) => ({
          model: setNotice(model, draftKey, Option.none()),
        }),
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

          const saved = save(next);

          return afterChange(
            saved.model,
            saved.commands ?? [],
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

    LoadedSaved: ({ drafts, read }) => {
      // Attachments made ready before storage answered stay, and are saved beside the rest.
      const restored = syncSaved(model, model.stored, drafts, read);
      const saved = save(restored.model);

      return {
        model: saved.model,
        commands: Array.appendAll(restored.commands, saved.commands ?? []),
      };
    },
    // Saving merges into what the other tab wrote, and its answer brings those attachments here.
    ChangedStoredAttachments: () => save(model),
    CompletedSave: ({ base, read, stored, written }) =>
      Option.match(stored, {
        onSome: (saved) => syncSaved(model, written, saved, read),
        onNone: () => {
          // Nothing was written: the base goes back to `base`, with what this tab asked for in
          // the saves still on their way since, so the next save writes this one's changes again.
          // What it took out stays out of the tray until storage no longer holds it.
          const unsaved = modifyFields(model, {
            stored: () => rebaseSaved(written, model.stored, base),
            refusedRemovals: (refused) =>
              savedUnion(refused, savedWithout(base, written)),
          });

          return Option.match(context.draftKey, {
            onNone: () => ({ model: unsaved }),
            onSome: (draftKey) => ({
              model: setNotice(
                unsaved,
                draftKey,
                Option.some(
                  "Attachments could not be saved on this device. Send before you reload this page."
                )
              ),
            }),
          });
        },
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
    setNotice(
      modifyFields(model, {
        items: (items) =>
          items.map((item) =>
            item.draftKey === draftKey ? requeue(item) : item
          ),
        waitingSends: (waiting) => Record.set(waiting, draftKey, intent),
      }),
      draftKey,
      Option.none()
    ),
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

  return save(
    modifyFields(model, {
      items: (items) => [...items, ...made.items],
      nextLocalId: () => made.nextLocalId,
    })
  );
};

/** Says in `draftKey`'s tray that its send was let go when the user moved to another draft. */
export const noteNotSent = (model: Model, draftKey: string): Model =>
  setNotice(
    model,
    draftKey,
    Option.some(
      "Not sent: its attachments finished after you moved away. Press Send again."
    )
  );

/** Forgets a draft's attachments after its turn was sent: the brain has claimed them. */
export const clearSent = (
  model: Model,
  draftKey: string
): Update.Return<Model, Message, Services> => {
  const sent = itemsOf(model, draftKey);

  const saved = save(
    setNotice(
      stopWaiting(
        modifyFields(model, {
          items: (items) =>
            Array.filter(items, (item) => item.draftKey !== draftKey),
        }),
        draftKey
      ),
      draftKey,
      Option.none()
    )
  );

  return {
    model: saved.model,
    commands: Array.appendAll(revokeCommands(sent), saved.commands ?? []),
  };
};
