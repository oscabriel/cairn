// The upload stack for tests: every attachment service over a temporary directory and an in-memory
// `cairn.sqlite` migrated through `0003_Attachments`, and a web handler that serves the upload and
// attachment routes from the same services, so a test's requests and its direct calls see one store.

import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";

import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { Shell0001 } from "../db/migrations/0001Shell.ts";
import { Launches0002 } from "../db/migrations/0002Launches.ts";
import { Attachments0003 } from "../db/migrations/0003Attachments.ts";
import type { AttachmentIntake } from "./AttachmentIntake.ts";
import { AttachmentRoute } from "./AttachmentRoute.ts";
import { AttachmentsLayer } from "./AttachmentsLayer.ts";
import type { AttachmentStore } from "./AttachmentStore.ts";
import { PhotonInWorker } from "./ImagePrepare.ts";
import type { ImagePrepare } from "./ImagePrepare.ts";
import type { TextExtract } from "./TextExtract.ts";
import { UploadRoute } from "./UploadRoute.ts";
import { UploadKeyFromFile } from "./UploadTokens.ts";
import type { UploadTokens } from "./UploadTokens.ts";

/** The migrations `cairn.sqlite` has once this package is wired, in their order. */
export const attachmentMigrations = {
  "0001_Shell": Shell0001,
  "0002_Launches": Launches0002,
  "0003_Attachments": Attachments0003,
};

/** The services the upload routes and the attachment stage read. */
export type AttachmentServices =
  | AttachmentIntake
  | AttachmentStore
  | UploadTokens
  | ImagePrepare
  | TextExtract;

/** The attachment services alone, over whatever provides their config, files and database. */
export const attachmentServices = AttachmentsLayer.pipe(
  Layer.provide(Layer.succeed(PhotonInWorker, false))
);

/**
 * The upload stack over `dir` (data under `dir/data`, the signing key under `dir/config`), with an
 * in-memory database. Photon runs on the calling thread. The key is file-backed, as the deployed
 * brain's is: `dir` is a temporary directory.
 */
export const attachmentsTestLayer = (dir: string) =>
  attachmentServices.pipe(
    Layer.provide(UploadKeyFromFile),
    Layer.provideMerge(Database.layerTest(attachmentMigrations)),
    Layer.provideMerge(
      ServerConfig.layerWith({
        dataDir: path.join(dir, "data"),
        configDir: path.join(dir, "config"),
      })
    ),
    Layer.provideMerge(NodeServices.layer)
  );

/** A web request handler. */
export type WebHandler = (request: Request) => Promise<Response>;

/** The upload and attachment routes over the services in scope; disposed with the scope. */
export const uploadHandler = Effect.gen(function* () {
  const context = yield* Effect.context<AttachmentServices>();

  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(UploadRoute, AttachmentRoute).pipe(
      Layer.provide(Layer.succeedContext(context))
    ),
    { disableLogger: true }
  );

  yield* Effect.addFinalizer(() => Effect.promise(dispose));

  return handler satisfies WebHandler;
});

/** A route's answer: its status, headers and JSON body (none when empty or not JSON). */
export interface RouteAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly json: unknown;
  readonly bytes: Uint8Array;
}

const decodeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Unknown)
);

const answer = async (response: Response): Promise<RouteAnswer> => {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "";

  return {
    status: response.status,
    headers: response.headers,
    json: type.startsWith("application/json")
      ? decodeJson(Buffer.from(bytes).toString("utf-8"))
      : undefined,
    bytes,
  };
};

/**
 * POSTs `body` to `uploadPath`. By default the body is sent whole with its true length; a number
 * claims that `Content-Length` instead, and `"stream"` sends it as a stream with no length.
 */
export const postUpload = (
  handler: WebHandler,
  uploadPath: string,
  body: Uint8Array,
  length: number | "stream" = body.length
) =>
  Effect.promise(async () => {
    const url = `http://cairn.test${uploadPath}`;

    if (length === "stream") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      });

      return await answer(
        await handler(
          new Request(url, {
            method: "POST",
            body: stream,
            duplex: "half",
          })
        )
      );
    }

    return await answer(
      await handler(
        new Request(url, {
          method: "POST",
          body: new Uint8Array(body),
          headers: { "content-length": String(length) },
        })
      )
    );
  });

/** GETs `address` from the handler. */
export const getAttachment = (handler: WebHandler, address: string) =>
  Effect.promise(
    async () =>
      await answer(await handler(new Request(`http://cairn.test${address}`)))
  );
