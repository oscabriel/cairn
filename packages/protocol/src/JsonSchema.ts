// JSON Schema documents for every RPC's payload, success and error, describing the JSON each one
// takes on the wire. A client in another language (the GPUI client later) builds from these; the
// golden files in `packages/protocol/schema/` record them, and a test fails when they drift.

import { Schema } from "effect";
import type { JsonSchema } from "effect";
import { RpcSchema } from "effect/rpc";

import { CairnRpcs, ViewerMiddleware } from "./Rpc.ts";

/** The JSON Schema documents of one RPC. A stream RPC's `success` and `error` describe one chunk. */
export interface RpcJsonSchema {
  readonly tag: string;
  readonly stream: boolean;
  readonly payload: JsonSchema.Document<"draft-2020-12">;
  readonly success: JsonSchema.Document<"draft-2020-12">;
  readonly error: JsonSchema.Document<"draft-2020-12">;
}

/** The documents for every RPC in `CairnRpcs`, in declaration order. */
export const rpcJsonSchemas = (): ReadonlyArray<RpcJsonSchema> =>
  Array.from(CairnRpcs.requests.values(), (rpc) => {
    const stream = RpcSchema.isStreamSchema(rpc.successSchema);

    const success = RpcSchema.isStreamSchema(rpc.successSchema)
      ? rpc.successSchema.success
      : rpc.successSchema;

    const error = RpcSchema.isStreamSchema(rpc.successSchema)
      ? rpc.successSchema.error
      : rpc.errorSchema;

    return {
      tag: rpc._tag,
      stream,
      payload: Schema.toJsonSchemaDocument(rpc.payloadSchema),
      success: Schema.toJsonSchemaDocument(success),
      error: Schema.toJsonSchemaDocument(
        Schema.Union([error, ViewerMiddleware.error])
      ),
    };
  });
