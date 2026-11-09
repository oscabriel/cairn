// The tray's queue: three uploads at a time, eager start, one automatic retry with a new URL,
// removal aborts, and a send pressed during uploads waits for the last one.

import { AttachmentId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { Message, OutMessage } from "./Message.ts";
import { AttachmentStatus, initial } from "./Model.ts";
import type { Model } from "./Model.ts";
import {
  mustWait,
  noteNotSent,
  noticeFor,
  readyIds,
  requestSend,
  update,
  waitsFor,
} from "./Update.ts";
import type { UpdateReturn } from "./Update.ts";

const draftKey = "thread:019a0000-0000-7000-8000-000000000001";

const context = { draftKey: Option.some(draftKey) };

const loaded: Model = { ...initial, loaded: true };

const pdf = (index: number) =>
  new File([`%PDF-1.7 ${index}`], `doc-${index}.pdf`, {
    type: "application/pdf",
  });

const ref = (localId: string) => ({
  id: AttachmentId.make(`att_${localId.replace("attachment-", "")}`),
  name: `${localId}.pdf`,
  mimeType: "application/pdf",
  sizeBytes: 12,
  kind: "pdf" as const,
  sha256: "0".repeat(64),
});

const names = (result: UpdateReturn) =>
  (result.commands ?? []).map(({ name }) => name);

const states = (model: Model) => model.items.map(({ status }) => status._tag);

const drop = (count: number) =>
  update(
    loaded,
    Message.DroppedFiles({
      files: Array.from({ length: count }, (_, index) => pdf(index)),
    }),
    context
  );

const succeed = (model: Model, localId: string) =>
  update(
    model,
    Message.SucceededUpload({
      localId,
      ref: ref(localId),
      pasteToRequestMs: Option.none(),
    }),
    context
  );

const fail = (model: Model, localId: string, retryable: boolean) =>
  update(
    model,
    Message.FailedUpload({
      localId,
      reason: "The upload failed: the connection dropped.",
      retryable,
      pasteToRequestMs: Option.none(),
    }),
    context
  );

describe("the upload queue", () => {
  it("starts three uploads at once and queues the rest", () => {
    const dropped = drop(5);

    assert.deepStrictEqual(states(dropped.model), [
      "Uploading",
      "Uploading",
      "Uploading",
      "Queued",
      "Queued",
    ]);
    assert.deepStrictEqual(names(dropped), [
      "UploadAttachment",
      "UploadAttachment",
      "UploadAttachment",
    ]);
  });

  it("starts the next upload when one answers, and attaches the ready one to its draft", () => {
    const answered = succeed(drop(4).model, "attachment-1");

    assert.deepStrictEqual(states(answered.model), [
      "Ready",
      "Uploading",
      "Uploading",
      "Uploading",
    ]);
    assert.deepStrictEqual(
      answered.outMessage,
      OutMessage.Attached({
        draftKey,
        attachmentId: AttachmentId.make("att_1"),
      })
    );
    assert.include(names(answered), "UploadAttachment");
    assert.deepStrictEqual(readyIds(answered.model, draftKey), [
      AttachmentId.make("att_1"),
    ]);
  });

  it("retries a retryable failure once with a new URL, then shows it", () => {
    const first = fail(drop(1).model, "attachment-1", true);

    assert.deepStrictEqual(states(first.model), ["Uploading"]);
    assert.deepStrictEqual(names(first), ["UploadAttachment"]);

    const second = fail(first.model, "attachment-1", true);

    assert.deepStrictEqual(states(second.model), ["Failed"]);
    assert.deepStrictEqual(names(second), []);
  });

  it("aborts an upload in flight when its attachment is removed", () => {
    const removed = update(
      drop(1).model,
      Message.ClickedRemove({ localId: "attachment-1" }),
      context
    );

    assert.deepStrictEqual(removed.model.items, []);
    assert.include(names(removed), "UploadAttachment.Interrupt");
  });
});

describe("a send during uploads", () => {
  it("waits for the last upload, then asks the composer to send", () => {
    const dropped = drop(2).model;

    assert.isTrue(mustWait(dropped, draftKey));

    const waiting = requestSend(dropped, draftKey, "foreground");

    assert.isUndefined(waiting.outMessage);
    assert.isTrue(waitsFor(waiting.model, draftKey));

    const one = succeed(waiting.model, "attachment-1");

    assert.deepStrictEqual(
      one.outMessage,
      OutMessage.Attached({
        draftKey,
        attachmentId: AttachmentId.make("att_1"),
      })
    );

    const both = succeed(one.model, "attachment-2");

    assert.deepStrictEqual(
      both.outMessage,
      OutMessage.ReadyToSend({ draftKey, intent: "foreground" })
    );
    assert.isFalse(mustWait(both.model, draftKey));
  });

  it("does not send when an attachment is refused for good, and says why", () => {
    const refused = fail(drop(1).model, "attachment-1", false);

    assert.isTrue(
      AttachmentStatus.guards.Failed(refused.model.items[0]?.status)
    );

    const waiting = requestSend(refused.model, draftKey, "foreground");

    assert.isUndefined(waiting.outMessage);
    assert.isFalse(waitsFor(waiting.model, draftKey));
    assert.isTrue(Option.isSome(noticeFor(waiting.model, draftKey)));
  });

  it("keeps each draft's waiting send and note apart", () => {
    const other = "thread:019a0000-0000-7000-8000-000000000002";
    const otherContext = { draftKey: Option.some(other) };

    const waitingA = requestSend(drop(1).model, draftKey, "foreground");

    const droppedB = update(
      waitingA.model,
      Message.DroppedFiles({ files: [pdf(9)] }),
      otherContext
    );

    const waitingB = requestSend(droppedB.model, other, "foreground");

    const answeredA = update(
      waitingB.model,
      Message.SucceededUpload({
        localId: "attachment-1",
        ref: ref("attachment-1"),
        pasteToRequestMs: Option.none(),
      }),
      otherContext
    );

    assert.deepStrictEqual(
      answeredA.outMessage,
      OutMessage.ReadyToSend({ draftKey, intent: "foreground" }),
      "A's send is released when A's upload answers, though B also waits"
    );
    assert.isTrue(waitsFor(answeredA.model, other));

    const notedA = noteNotSent(answeredA.model, draftKey);

    const pastedB = update(
      notedA,
      Message.DroppedFiles({ files: [pdf(10)] }),
      otherContext
    );

    assert.isTrue(
      Option.isSome(noticeFor(pastedB.model, draftKey)),
      "a file added in B leaves A's note"
    );

    const dismissedB = update(
      pastedB.model,
      Message.ClickedDismissNotice(),
      otherContext
    );

    assert.isTrue(Option.isSome(noticeFor(dismissedB.model, draftKey)));
  });
});
