// `GET /api/attachments/:id/:variant`: one of an uploaded attachment's files, for the transcript's
// chips and image previews. `prepared` is the image the model saw, `original` the upload, `text` a
// document's extracted text. Ids are random and files never change, so a response is cached for
// good by the browser that asked and never by anything shared; `nosniff` and a sandboxing CSP keep
// an uploaded HTML or SVG file from running as a page. Anything that is not an image, a PDF or text
// is sent as a download. The guard in front of `/api` admits only the owner.
import { AttachmentId } from "@cairn/protocol/Ids";
import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { AttachmentStore, AttachmentVariant } from "./AttachmentStore.ts";
import type { StoredAttachment } from "./AttachmentStore.ts";

/** The route's path, as the router matches it. */
export const ATTACHMENT_PATH = "/api/attachments/:id/:variant";

/** The path of one of an attachment's files, for clients and tests. */
export const attachmentUrl = (id: AttachmentId, variant: AttachmentVariant) =>
  `/api/attachments/${encodeURIComponent(id)}/${variant}`;

const Params = Schema.Struct({ id: AttachmentId, variant: AttachmentVariant });

const SAFE_INLINE = /^(?:image\/(?:png|jpeg|gif|webp)|application\/pdf)$/u;

const TEXT_PLAIN = "text/plain; charset=utf-8";

const problem = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { code, message, retryable: status >= 500 },
    { status, headers: { "cache-control": "no-store" } }
  );

/** How a file is served: its type, and whether the browser should download it. */
interface Presentation {
  readonly contentType: string;
  readonly download: boolean;
}

/** The type and disposition a file is served with. */
const presentation = (
  stored: StoredAttachment,
  variant: AttachmentVariant
): Presentation => {
  if (variant === "text") {
    return { contentType: TEXT_PLAIN, download: false };
  }

  if (variant === "prepared") {
    return {
      contentType: Option.getOrElse(
        stored.preparedMimeType,
        () => stored.ref.mimeType
      ),
      download: false,
    };
  }

  if (stored.ref.kind === "text") {
    return { contentType: TEXT_PLAIN, download: false };
  }

  return SAFE_INLINE.test(stored.ref.mimeType)
    ? { contentType: stored.ref.mimeType, download: false }
    : { contentType: "application/octet-stream", download: true };
};

/** The file handler over the store it was built with. */
const serveAttachment = (store: AttachmentStore["Service"]) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.schemaPathParams(Params).pipe(
      Effect.option
    );

    if (Option.isNone(params)) {
      return problem(
        400,
        "invalid_input",
        "The attachment address is malformed: it needs an attachment id and one of original, prepared or text."
      );
    }

    const { id, variant } = params.value;
    const stored = yield* store.get(id);
    const bytes = yield* store.read(id, variant);

    if (Option.isNone(stored) || Option.isNone(bytes)) {
      return problem(
        404,
        "not_found",
        `Attachment ${id} has no ${variant} file. It may have been discarded, or it has no such variant.`
      );
    }

    const { contentType, download } = presentation(stored.value, variant);

    return HttpServerResponse.uint8Array(bytes.value, {
      contentType,
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(stored.value.ref.name)}`,
      },
    });
  }).pipe(
    Effect.catchTag("AttachmentStoreError", (failure) =>
      Effect.succeed(problem(503, "unavailable", failure.message))
    )
  );

/** Serves attachment files; register it in `http/Routes.ts`. It takes the store when built. */
export const AttachmentRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const store = yield* AttachmentStore;

    yield* router.add("GET", ATTACHMENT_PATH, serveAttachment(store));
  })
);
