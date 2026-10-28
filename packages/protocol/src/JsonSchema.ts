// JSON Schema documents for every RPC's payload, success and error, describing the JSON each one
// takes on the wire. A client in another language (the GPUI client later) builds from these; the
// golden files in `packages/protocol/schema/` record them, and a test fails when they drift.

import { Schema } from "effect";
import type { JsonSchema } from "effect";
import { RpcSchema } from "effect/rpc";

import {
  APPROVALS_DOCUMENT,
  ApprovalsDocument,
  GOAL_DOCUMENT,
  GoalDocument,
  PERMISSIONS_DOCUMENT,
  PermissionsDocument,
} from "./Policy.ts";
import { ArtifactDetails, PortalDetails } from "./Reach.ts";
import { CairnRpcs, ViewerMiddleware } from "./Rpc.ts";
import {
  CHILD_DOCUMENT,
  ChildDocument,
  ESCALATIONS_DOCUMENT,
  EscalationsDocument,
  RESULT_DOCUMENT,
  ResultDocument,
  SUBAGENT_RESULT_ENTRY,
  SUBAGENTS_DOCUMENT,
  SubagentSettlement,
  SubagentsDocument,
} from "./Subagents.ts";
import { NOTICE_ENTRY_KIND, NoticeEntryData } from "./Thread.ts";
import {
  EVENTS_DOCUMENT,
  EventsDocument,
  WORKFLOWS_DOCUMENT,
  WorkflowsDocument,
} from "./Workflows.ts";

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

/** The JSON Schema of one pi-durable document or entry payload the brain writes and clients read. */
export interface DocumentJsonSchema {
  /** The document kind, the entry kind, or `<tool> details`. */
  readonly kind: string;
  readonly schema: JsonSchema.Document<"draft-2020-12">;
}

/** Every document and entry payload schema, by kind. */
export const DOCUMENT_SCHEMAS: ReadonlyArray<readonly [string, Schema.Top]> = [
  [APPROVALS_DOCUMENT, ApprovalsDocument],
  [PERMISSIONS_DOCUMENT, PermissionsDocument],
  [GOAL_DOCUMENT, GoalDocument],
  [SUBAGENTS_DOCUMENT, SubagentsDocument],
  [CHILD_DOCUMENT, ChildDocument],
  [ESCALATIONS_DOCUMENT, EscalationsDocument],
  [RESULT_DOCUMENT, ResultDocument],
  [WORKFLOWS_DOCUMENT, WorkflowsDocument],
  [EVENTS_DOCUMENT, EventsDocument],
  [SUBAGENT_RESULT_ENTRY, SubagentSettlement],
  [NOTICE_ENTRY_KIND, NoticeEntryData],
  ["artifact_publish details", ArtifactDetails],
  ["portal_open details", PortalDetails],
];

/**
 * The documents Cairn keeps inside pi-durable's store and the entry payloads it writes, as JSON
 * Schema. They reach a client through the thread stream as plain JSON, so their shape is wire too.
 */
export const documentJsonSchemas = (): ReadonlyArray<DocumentJsonSchema> =>
  DOCUMENT_SCHEMAS.map(([kind, schema]) => ({
    kind,
    schema: Schema.toJsonSchemaDocument(schema),
  }));
