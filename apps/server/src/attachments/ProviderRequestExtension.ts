// A Cairn extension that writes one `provider.request` log line before every model request whose
// newest user message carries images: for each image its media type, base64 length and the sha256
// of the exact base64 handed to the provider. The paste judge compares that hash with the prepared
// file's, which proves the model saw the pasted image and not another. The hook reads and returns
// nothing, so the request is unchanged; its log runs on a runtime built from the brain's layer
// (S43), so the line goes through the brain's logger.
import { createHash } from "node:crypto";

import type { Message } from "@earendil-works/pi-ai";
import {
  defineExtension,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";
import { Context, Effect, FiberSet, Layer, Predicate } from "effect";

import type { CairnExtension } from "../brain/Extensions.ts";

/** The install order key: after the bridge's cwd hook, before judge extensions. */
export const PROVIDER_REQUEST_ORDER = 750;

/** One image of a request as the log records it. */
export interface RequestImage {
  readonly mimeType: string;
  readonly base64Chars: number;
  /** sha256 of the base64 text exactly as handed to the provider. */
  readonly sha256: string;
}

/** The images of the newest user message in `messages`, in order. */
export const requestImages = (
  messages: ReadonlyArray<Message>
): ReadonlyArray<RequestImage> => {
  const user = messages.findLast((message) => message.role === "user");

  if (user === undefined || Predicate.isString(user.content)) {
    return [];
  }

  return user.content.flatMap((part) =>
    part.type === "image"
      ? [
          {
            mimeType: part.mimeType,
            base64Chars: part.data.length,
            sha256: createHash("sha256").update(part.data).digest("hex"),
          },
        ]
      : []
  );
};

/** The extension's name and install order: production's by default, another for a test's copy. */
export interface ProviderRequestIdentity {
  readonly name: string;
  readonly order: number;
}

const PRODUCTION: ProviderRequestIdentity = {
  name: "cairn-provider-request-log",
  order: PROVIDER_REQUEST_ORDER,
};

/**
 * The `provider.request` hook as a Cairn extension, logging through the context it is built in.
 * A test that runs it beside the production set gives it its own `identity`.
 */
export const providerRequestExtension = Effect.fn(
  "ProviderRequestLog.extension"
)(function* (identity: ProviderRequestIdentity = PRODUCTION) {
  const run = yield* FiberSet.makeRuntime();

  const logged = hook(GenerationTask, {
    beforeRequest: (request, api) => {
      const images = requestImages(request.messages);

      if (images.length > 0) {
        run(
          Effect.logInfo("provider request with images").pipe(
            Effect.annotateLogs({
              event: "provider.request",
              conversationId: api.conversationId,
              taskId: api.taskId,
              images,
            })
          )
        );
      }
    },
  });

  return {
    order: identity.order,
    extension: defineExtension({ name: identity.name, hooks: [logged] }),
  } satisfies CairnExtension;
});

/** The `provider.request` hook as the production Cairn extension. */
export class ProviderRequestLog extends Context.Service<
  ProviderRequestLog,
  { readonly extension: CairnExtension }
>()("cairn/server/attachments/ProviderRequestExtension/ProviderRequestLog") {
  static readonly layer = Layer.effect(
    ProviderRequestLog,
    Effect.map(providerRequestExtension(), (extension) =>
      ProviderRequestLog.of({ extension })
    )
  );
}
