// `shell.subscribe` and `shell.dispatch`: thin calls into the shell store that translate its
// failures into the protocol's public errors, carrying the RPC request id.
import {
  Conflict,
  InvalidInput,
  LiveStreamOverflow,
  NotFound,
  Unavailable,
} from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer, Option, Stream } from "effect";

import { EventSink } from "../shell/EventSink.ts";
import type { ShellStoreError } from "../shell/ShellStoreError.ts";
import { ShellStream } from "../shell/ShellStream.ts";

const unavailable = (requestId: string) => (failure: ShellStoreError) =>
  new Unavailable({
    message: `${failure.message} (${failure.operation})`,
    requestId: Option.some(requestId),
  });

/** The shell stream handler: snapshot or replay, then live rows. */
export const ShellSubscribeHandler = CairnRpcs.toLayerHandler(
  "shell.subscribe",
  Effect.gen(function* () {
    const shell = yield* ShellStream;

    return (input, { requestId }) =>
      shell.subscribe(input).pipe(
        Stream.catchTags({
          LiveStreamBufferError: (failure) =>
            Stream.fail(
              new LiveStreamOverflow({
                message: failure.message,
                requestId: Option.some(String(requestId)),
              })
            ),
          ShellStoreError: (failure) =>
            Stream.fail(unavailable(String(requestId))(failure)),
        })
      );
  })
);

/** The shell command handler: idempotent by command id, rejections as typed errors. */
export const ShellDispatchHandler = CairnRpcs.toLayerHandler(
  "shell.dispatch",
  Effect.gen(function* () {
    const sink = yield* EventSink;

    return (command, { requestId }) => {
      const id = Option.some(String(requestId));

      return sink.commitCommand(command).pipe(
        Effect.catchTags({
          ShellStoreError: (failure) =>
            Effect.fail(unavailable(String(requestId))(failure)),
          ShellTargetNotFound: (failure) =>
            Effect.fail(
              new NotFound({
                message: failure.message,
                resource: failure.resource,
                id: failure.id,
                requestId: id,
              })
            ),
          ProjectWorkspaceConflictError: (failure) =>
            Effect.fail(
              new Conflict({
                message: failure.message,
                reason: "workspace_in_use",
                requestId: id,
              })
            ),
          ShellCommandInvalid: (failure) =>
            Effect.fail(
              new InvalidInput({
                message: failure.message,
                field: failure.field,
                requestId: id,
              })
            ),
          ShellCommandConflict: (failure) =>
            Effect.fail(
              new Conflict({
                message: failure.message,
                reason: failure.reason,
                requestId: id,
              })
            ),
        })
      );
    };
  })
);

/** Both shell handlers. Needs `ShellStream` and `EventSink`. */
export const ShellHandlers = Layer.mergeAll(
  ShellSubscribeHandler,
  ShellDispatchHandler
);
