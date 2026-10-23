// The `mid-upload` window's uploader (notes/edges.md, "Durability", item 24): the raw bytes of one
// file `POST`ed to the one-shot URL `attachments.createUploadUrl` signed, as the web client's
// `UploadQueue` sends them, but paced in chunks so a 20 MB upload lasts a few seconds on loopback
// and a `kill -9` can land while the brain is writing its `.part` file.
import http from "node:http";
import type { IncomingMessage } from "node:http";
import { buffer } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";

export interface UploadTarget {
  readonly port: number;
  readonly path: string;
  /** Sent as `Host`, `Origin` and `X-Cairn-User`, as Caddy and the page would. */
  readonly host: string;
  readonly origin: string;
  readonly owner: string;
  readonly mimeType: string;
}

export interface UploadAnswer {
  readonly status: number;
  readonly body: string;
}

/** How long the socket may stay silent, either way, before the upload counts as broken. */
const ANSWER_TIMEOUT_MS = 30_000;

/** What one upload has heard so far. */
interface UploadState {
  response: IncomingMessage | undefined;
  broken: string | undefined;
}

/**
 * Sends `bytes` in `chunk`-sized writes `delayMs` apart. Answers the status and body, or a status
 * of 0 with the error's text when the socket broke (the kill).
 */
export const post = async (
  target: UploadTarget,
  bytes: Uint8Array,
  pacing: { readonly chunk: number; readonly delayMs: number }
): Promise<UploadAnswer> => {
  const state: UploadState = { response: undefined, broken: undefined };

  const request = http.request({
    host: "127.0.0.1",
    port: target.port,
    method: "POST",
    path: target.path,
    headers: {
      host: target.host,
      origin: target.origin,
      "x-cairn-user": target.owner,
      "content-type": target.mimeType,
      "content-length": String(bytes.byteLength),
    },
  });

  const onResponse = (response: IncomingMessage) => {
    state.response = response;
  };

  const onBroken = (cause: Error) => {
    state.broken = cause.message;
  };

  request.on("response", onResponse);
  request.on("error", onBroken);
  // A half-open socket (no RST) breaks the upload instead of hanging the window.
  request.setTimeout(ANSWER_TIMEOUT_MS, () => {
    request.destroy(
      new Error(`no answer within ${ANSWER_TIMEOUT_MS / 1000} s of silence`)
    );
  });

  for (let offset = 0; offset < bytes.byteLength; offset += pacing.chunk) {
    if (state.broken !== undefined || request.destroyed) {
      break;
    }

    request.write(bytes.subarray(offset, offset + pacing.chunk));

    if (pacing.delayMs > 0) {
      // oxlint-disable-next-line no-await-in-loop -- pacing one upload, on purpose
      await sleep(pacing.delayMs);
    }
  }

  request.end();

  // The answer, or the broken socket; polled, so neither event can be missed.
  while (state.response === undefined && state.broken === undefined) {
    // oxlint-disable-next-line no-await-in-loop -- waiting for one answer, on purpose
    await sleep(20);
  }

  if (state.response === undefined) {
    return { status: 0, body: state.broken ?? "no answer" };
  }

  try {
    const body = await buffer(state.response);

    return {
      status: state.response.statusCode ?? 0,
      body: body.toString("utf-8"),
    };
  } catch {
    return { status: 0, body: "the answer broke off" };
  }
};
