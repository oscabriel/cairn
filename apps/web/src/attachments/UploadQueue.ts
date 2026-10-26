// Ported from github.com/pingdotgg/t3code, apps/web/src/lib/attachmentUploadQueue.ts (`uploadBytes`,
// `runUpload`) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the bytes go as a raw XHR `POST`
// to a signed one-shot URL with `Content-Type` set, progress from `xhr.upload`, a five minute
// timeout, and abort on removal. Changed: the brain answers `200` with the `AttachmentRef` (plan
// D35), which is decoded here; every attempt asks for a new URL first; interruption aborts the XHR
// (the tray's Command is interruptible by its item); progress reaches the tray through
// `uploadProgress`, a stream its Subscription reads, because a Command answers once. The queue
// itself (three at a time, eager start, one automatic retry) is the tray's update.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { AttachmentRef } from "@cairn/protocol/Attachments";
import { Effect, Option, Queue, Schema, Stream } from "effect";

import type { CallFailure } from "../connection/Failure.ts";
import { failureMessage, isRetryable } from "../connection/Failure.ts";

/** How many uploads run at once. */
export const MAX_CONCURRENT_UPLOADS = 3;

/** How long one upload may take before it is abandoned. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** An upload that did not end in a stored attachment. */
export class UploadFailed extends Schema.TaggedError<UploadFailed>()(
  "UploadFailed",
  {
    /** What the tray shows. */
    message: Schema.String,
    /** True when a new URL and another attempt may succeed (network, expiry, a busy brain). */
    retryable: Schema.Boolean,
  }
) {}

/** One progress report: how far one item's bytes have gone, from 0 to 1. */
export interface UploadProgress {
  readonly localId: string;
  readonly progress: number;
}

type ProgressListener = (report: UploadProgress) => void;

// The XHR's progress events reach the tray through this set: the running upload Command reports
// into it, and the tray's Subscription listens while the app runs. Module-scoped, as t3code's
// upload store is, because a Command can only answer once.
const progressListeners = new Set<ProgressListener>();

const reportProgress = (report: UploadProgress) => {
  for (const listener of progressListeners) {
    listener(report);
  }
};

const offerTo =
  (queue: Queue.Enqueue<UploadProgress>): ProgressListener =>
  (report) => {
    Queue.offerUnsafe(queue, report);
  };

/** Every running upload's progress, in whole percents. */
export const uploadProgress: Stream.Stream<UploadProgress> = Stream.callback(
  (queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = offerTo(queue);

        progressListeners.add(listener);

        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          progressListeners.delete(listener);
        })
    )
);

const RefJson = Schema.fromJsonString(Schema.toCodecJson(AttachmentRef));

const decodeRef = Schema.decodeUnknownEffect(RefJson);

const ErrorBody = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.String,
    reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  })
);

const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

/**
 * Whether an answer of the upload route is worth a new URL: the token expired, is unknown or was
 * used (400 `expired`, 401, 403, 404, 409, 410; each attempt mints a new URL, T38), the request
 * timed out or was throttled, or the brain had trouble. A refusal of the file itself (wrong size,
 * too large, a type the brain will not take) is final.
 */
export const isRetryableAnswer = (
  status: number,
  reason: Option.Option<string>
) =>
  (status === 400 && Option.contains(reason, "expired")) ||
  status === 401 ||
  status === 403 ||
  status === 404 ||
  status === 408 ||
  status === 409 ||
  status === 410 ||
  status === 429 ||
  status >= 500;

interface RawAnswer {
  readonly status: number;
  readonly body: string;
}

/** The XHR itself; resumes with the answer, or fails on a network error, timeout or abort. */
const post = (input: {
  readonly localId: string;
  readonly uploadPath: string;
  readonly file: Blob;
  readonly mimeType: string;
}): Effect.Effect<RawAnswer, UploadFailed> =>
  Effect.callback<RawAnswer, UploadFailed>((resume) => {
    const xhr = new XMLHttpRequest();
    let lastPercent = -1;

    const fail = (message: string) => {
      resume(Effect.fail(new UploadFailed({ message, retryable: true })));
    };

    xhr.open("POST", input.uploadPath, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", input.mimeType);
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        return;
      }

      const percent = Math.floor((event.loaded / event.total) * 100);

      if (percent !== lastPercent) {
        lastPercent = percent;
        reportProgress({ localId: input.localId, progress: percent / 100 });
      }
    });
    xhr.addEventListener("load", () => {
      resume(Effect.succeed({ status: xhr.status, body: xhr.responseText }));
    });
    xhr.addEventListener("error", () => {
      fail("The upload failed: the connection dropped.");
    });
    xhr.addEventListener("timeout", () => {
      fail("The upload timed out.");
    });
    xhr.send(input.file);

    // Interruption (the user removed the attachment) aborts the request.
    return Effect.sync(() => {
      xhr.abort();
    });
  });

/**
 * Sends one file's bytes to its signed upload path and decodes the brain's answer. Fails with
 * `UploadFailed`, saying whether a new URL may help. Interrupting it aborts the request.
 */
export const sendBytes = (input: {
  readonly localId: string;
  readonly uploadPath: string;
  readonly file: Blob;
  readonly mimeType: string;
}): Effect.Effect<AttachmentRef, UploadFailed> =>
  Effect.gen(function* () {
    const answer = yield* post(input);

    if (answer.status !== 200) {
      const body = decodeErrorBody(answer.body);

      const message = Option.match(body, {
        onNone: () => `The upload was refused (HTTP ${answer.status}).`,
        onSome: (found) => found.message,
      });

      return yield* new UploadFailed({
        message,
        retryable: isRetryableAnswer(
          answer.status,
          Option.flatMap(body, (found) => Option.fromNullishOr(found.reason))
        ),
      });
    }

    return yield* decodeRef(answer.body).pipe(
      Effect.mapError(
        () =>
          new UploadFailed({
            message: "The brain's answer to the upload could not be read.",
            retryable: true,
          })
      )
    );
  });

/** The text an RPC failure shows, and whether it is safe to try again. */
export const rpcFailure = (failure: CallFailure): UploadFailed =>
  new UploadFailed({
    message: failureMessage(
      failure,
      `The upload could not start (${failure._tag}).`
    ),
    retryable: isRetryable(failure),
  });
