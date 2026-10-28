// Every error an RPC can fail with. Each carries a literal `code` a non-Effect client can switch on,
// a message written for the person who must act, the request id when the server stamped one, and
// whether sending the same request again is safe. None carries secrets, paths outside the
// request, SQL, stack traces or vendor responses.

import { Effect, Schema } from "effect";

import { DisplayText, TrimmedNonEmptyString } from "./Ids.ts";

const code = <const C extends string>(value: C) =>
  Schema.Literal(value).pipe(
    Schema.withConstructorDefault(Effect.succeed(value))
  );

const retryable = (value: boolean) =>
  Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(value)));

const requestId = Schema.OptionFromNullOr(TrimmedNonEmptyString).pipe(
  Schema.withConstructorDefault(Effect.succeedNone)
);

/** The socket's identity was missing or is no longer the owner's. Sign in again; nothing ran. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {
    code: code("unauthorized"),
    message: DisplayText,
    requestId,
    retryable: retryable(false),
  }
) {}

/** The brain is not ready (booting, closing) or a dependency is down. Nothing ran; retry later. */
export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  {
    code: code("unavailable"),
    message: DisplayText,
    requestId,
    retryable: retryable(true),
  }
) {}

/** The named resource does not exist (or no longer does). */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  code: code("not_found"),
  message: DisplayText,
  resource: Schema.Literals([
    "project",
    "thread",
    "entry",
    "attachment",
    "task",
    "approval",
    "submission",
    "folder",
    "checkpoint",
    "workflow",
    "node",
    "recipe",
    "artifact",
    "portal",
  ]),
  /** The id or path as the request gave it. */
  id: DisplayText,
  requestId,
  retryable: retryable(false),
}) {}

/** The request was well-formed but its values cannot be used; fix the input and send again. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  {
    code: code("invalid_input"),
    message: DisplayText,
    /** The payload field at fault, when there is one. */
    field: Schema.OptionFromNullOr(TrimmedNonEmptyString).pipe(
      Schema.withConstructorDefault(Effect.succeedNone)
    ),
    requestId,
    retryable: retryable(false),
  }
) {}

/** The request conflicts with the current state. */
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  code: code("conflict"),
  message: DisplayText,
  reason: Schema.Literals([
    /** Another project already has this folder as its root. */
    "workspace_in_use",
    /** A run is busy and the input asked to be rejected rather than queued. */
    "thread_busy",
    /** The thread or project changed in a way that makes the command meaningless. */
    "stale_state",
    /** A permission mode wider than the parent thread's (ADR 0031). */
    "mode_too_wide",
    /** A fixed cap is reached: live children, open portals. */
    "limit_reached",
  ]),
  requestId,
  retryable: retryable(false),
}) {}

/** An upload or an attachment reference was refused. */
export class AttachmentRejected extends Schema.TaggedError<AttachmentRejected>()(
  "AttachmentRejected",
  {
    code: code("attachment_rejected"),
    message: DisplayText,
    reason: Schema.Literals([
      "too_large",
      "unsupported_type",
      "expired",
      "too_many",
      "not_ready",
    ]),
    requestId,
    retryable: retryable(false),
  }
) {}

/**
 * The server's buffer for a slow stream subscriber filled up. Resubscribe from the last received
 * sequence; nothing was lost.
 */
export class LiveStreamOverflow extends Schema.TaggedError<LiveStreamOverflow>()(
  "LiveStreamOverflow",
  {
    code: code("live_stream_overflow"),
    message: DisplayText,
    requestId,
    retryable: retryable(true),
  }
) {}

/** An invariant broke inside the brain. Report the request id; retrying is not known to be safe. */
export class Internal extends Schema.TaggedError<Internal>()("Internal", {
  code: code("internal"),
  message: DisplayText,
  requestId,
  retryable: retryable(false),
}) {}
