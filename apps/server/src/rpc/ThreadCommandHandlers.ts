// `thread.launch`, `thread.send`, `thread.stop`, `thread.withdraw`, `thread.configure` and
// `thread.respond`: thin calls into `ThreadLaunch` and `Threads` that translate their failures into
// the protocol's errors, carrying the RPC request id. The sender recorded on a turn is the socket's
// viewer.

import {
  AttachmentRejected,
  Conflict,
  Internal,
  InvalidInput,
  NotFound,
  Unavailable,
} from "@cairn/protocol/Errors";
import type { ThreadLaunchInput } from "@cairn/protocol/Launch";
import type { ApprovalDecision } from "@cairn/protocol/Policy";
import { CairnRpcs, Viewer } from "@cairn/protocol/Rpc";
import type {
  ConfigureInput,
  RespondInput,
  SendInput,
  StopInput,
  WithdrawInput,
} from "@cairn/protocol/Thread";
import { Effect, Layer, Option } from "effect";
import type { RpcMessage } from "effect/rpc";

import type { HarnessError } from "../brain/HarnessSeam.ts";
import type { LaunchError } from "../threads/ThreadLaunch.ts";
import { ThreadLaunch } from "../threads/ThreadLaunch.ts";
import { Threads } from "../threads/Threads.ts";
import type { TurnContentError } from "../threads/TurnContent.ts";
import { publicText } from "./PublicText.ts";

/** The resource each seam "not found" names. */
const MISSING: Partial<Record<HarnessError["reason"], NotFound["resource"]>> = {
  thread_not_found: "thread",
  submission_not_found: "submission",
  approval_not_found: "approval",
  task_not_found: "task",
  entry_not_found: "entry",
};

/**
 * A seam failure as the protocol's change errors say it, its text cut to fit (`publicText`). `id`
 * names the call's own target; a missing thread is named by `threadId` when the call has one.
 */
export const fromHarnessError = (
  failure: HarnessError,
  id: string,
  requestId: Option.Option<string>,
  threadId: string = id
): Unavailable | Internal | NotFound | InvalidInput | Conflict => {
  const resource = MISSING[failure.reason];
  const message = publicText(failure.message);

  if (resource !== undefined) {
    return new NotFound({
      message,
      resource,
      id: resource === "thread" ? threadId : id,
      requestId,
    });
  }

  if (failure.reason === "thread_busy") {
    return new Conflict({
      message,
      reason: "thread_busy",
      requestId,
    });
  }

  if (failure.reason === "invalid_input") {
    return new InvalidInput({ message, requestId });
  }

  if (failure.reason === "unavailable") {
    return new Unavailable({ message, requestId });
  }

  return new Internal({
    message: publicText(
      `The thread request failed inside the brain: ${failure.message}`
    ),
    requestId,
  });
};

/** A refused turn as the protocol says it. */
export const fromTurnContentError = (
  failure: TurnContentError,
  requestId: Option.Option<string>
): InvalidInput | AttachmentRejected | Unavailable => {
  if (failure.reason === "attachment") {
    return new AttachmentRejected({
      message: publicText(failure.message),
      reason: "not_ready",
      requestId,
    });
  }

  if (failure.reason === "unavailable") {
    return new Unavailable({ message: publicText(failure.message), requestId });
  }

  return new InvalidInput({
    message: publicText(failure.message),
    field: failure.field,
    requestId,
  });
};

const fromLaunchError = (
  failure: LaunchError,
  projectId: string,
  requestId: Option.Option<string>
): NotFound | InvalidInput | Conflict | Unavailable => {
  if (failure.reason === "project_not_found") {
    return new NotFound({
      message: failure.message,
      resource: "project",
      id: projectId,
      requestId,
    });
  }

  if (failure.reason === "thread_exists") {
    return new Conflict({
      message: failure.message,
      reason: "stale_state",
      requestId,
    });
  }

  if (failure.reason === "unavailable") {
    return new Unavailable({ message: failure.message, requestId });
  }

  return new InvalidInput({
    message: failure.message,
    field: failure.field,
    requestId,
  });
};

const requestIdOf = (requestId: RpcMessage.RequestId) =>
  Option.some(String(requestId));

/**
 * A phase 2 input this brain cannot act on yet: `thread.respond`'s `revise` (briefs, 4A),
 * `accept_sample` and `launch` (5A). `reason` and `answers` are recorded (1A); `accept_for_thread`
 * and `thread.configure`'s `runtimeMode` are handled (ADR 0031), and `thread.stop`'s
 * `subagents: "stop"` stops the working children too (Stop all, ADR 0028). Refused, so nothing is
 * silently dropped; the package that builds each lifts its refusal and turns its test in
 * `ThreadCommandHandlers.test.ts` around.
 */
const notYet = (field: string, requestId: Option.Option<string>) =>
  new InvalidInput({
    message: `This brain does not handle ${field} yet. Nothing changed; update the brain and retry.`,
    field: Option.some(field),
    requestId,
  });

/** The decisions this brain records; the others wait for the packages that build them. */
const HANDLED_DECISIONS: ReadonlySet<ApprovalDecision> = new Set([
  "accept",
  "accept_for_thread",
  "decline",
]);

/**
 * `auto` is listed for later (a decider answers routine approvals, after phase 2) and is not
 * offered, so a thread is never set to it (ADR 0031).
 */
const autoNotOffered = (requestId: Option.Option<string>) =>
  new InvalidInput({
    message:
      "The Auto permission mode is not offered yet. Nothing changed; choose Supervised, Auto-accept edits or Full access.",
    field: Option.some("runtimeMode"),
    requestId,
  });

/** The first field of a `thread.respond` this brain cannot act on yet, if any. */
const respondNotYet = (input: RespondInput): Option.Option<string> => {
  if (!HANDLED_DECISIONS.has(input.decision)) {
    return Option.some("decision");
  }

  return Option.isSome(input.launch) ? Option.some("launch") : Option.none();
};

/** The handlers, for the handler group and for tests that call them directly. */
export const threadCommandHandlers = Effect.gen(function* () {
  const launcher = yield* ThreadLaunch;
  const threads = yield* Threads;

  return {
    launch: (
      input: ThreadLaunchInput,
      from: string,
      requestId: Option.Option<string>
    ) =>
      launcher.launch(input, from).pipe(
        Effect.catchTags({
          LaunchError: (failure) =>
            Effect.fail(fromLaunchError(failure, input.projectId, requestId)),
          TurnContentError: (failure) =>
            Effect.fail(fromTurnContentError(failure, requestId)),
        })
      ),
    send: (input: SendInput, from: string, requestId: Option.Option<string>) =>
      threads.send(input, from).pipe(
        Effect.catchTags({
          HarnessError: (failure) =>
            Effect.fail(fromHarnessError(failure, input.threadId, requestId)),
          TurnContentError: (failure) =>
            Effect.fail(fromTurnContentError(failure, requestId)),
          ThreadNotReady: (failure) =>
            Effect.fail(
              new Unavailable({ message: failure.message, requestId })
            ),
          ThreadLaunchLost: (failure) =>
            Effect.fail(
              new NotFound({
                message: failure.message,
                resource: "thread",
                id: input.threadId,
                requestId,
              })
            ),
          LaunchStoreError: (failure) =>
            Effect.fail(
              new Unavailable({ message: failure.message, requestId })
            ),
          ShellStoreError: (failure) =>
            Effect.fail(
              new Unavailable({ message: failure.message, requestId })
            ),
        })
      ),
    stop: (input: StopInput, requestId: Option.Option<string>) =>
      threads.stop(input).pipe(
        Effect.catchTags({
          HarnessError: (failure) =>
            Effect.fail(fromHarnessError(failure, input.threadId, requestId)),
          LaunchStoreError: (failure) =>
            Effect.fail(
              new Unavailable({ message: failure.message, requestId })
            ),
        })
      ),
    withdraw: (input: WithdrawInput, requestId: Option.Option<string>) =>
      threads
        .withdraw(input)
        .pipe(
          Effect.mapError((failure) =>
            fromHarnessError(
              failure,
              String(input.submissionId),
              requestId,
              input.threadId
            )
          )
        ),
    configure: (input: ConfigureInput, requestId: Option.Option<string>) =>
      Option.contains(input.runtimeMode, "auto")
        ? Effect.fail(autoNotOffered(requestId))
        : threads
            .configure(input)
            .pipe(
              Effect.mapError((failure) =>
                fromHarnessError(failure, input.threadId, requestId)
              )
            ),
    respond: (input: RespondInput, requestId: Option.Option<string>) =>
      Option.match(respondNotYet(input), {
        onSome: (field) => Effect.fail(notYet(field, requestId)),
        onNone: () =>
          threads
            .respond(input)
            .pipe(
              Effect.mapError((failure) =>
                fromHarnessError(
                  failure,
                  input.approvalId,
                  requestId,
                  input.threadId
                )
              )
            ),
      }),
  };
});

/** The thread command handlers, to merge over the stubs in `rpc/Handlers.ts`. */
export const ThreadCommandHandlers = {
  layer: Layer.mergeAll(
    CairnRpcs.toLayerHandler(
      "thread.launch",
      Effect.map(
        threadCommandHandlers,
        (handlers) =>
          (input, { requestId }) =>
            Viewer.use((viewer) =>
              handlers.launch(input, viewer.login, requestIdOf(requestId))
            )
      )
    ),
    CairnRpcs.toLayerHandler(
      "thread.send",
      Effect.map(
        threadCommandHandlers,
        (handlers) =>
          (input, { requestId }) =>
            Viewer.use((viewer) =>
              handlers.send(input, viewer.login, requestIdOf(requestId))
            )
      )
    ),
    CairnRpcs.toLayerHandler(
      "thread.stop",
      Effect.map(
        threadCommandHandlers,
        (handlers) =>
          (input, { requestId }) =>
            handlers.stop(input, requestIdOf(requestId))
      )
    ),
    CairnRpcs.toLayerHandler(
      "thread.withdraw",
      Effect.map(
        threadCommandHandlers,
        (handlers) =>
          (input, { requestId }) =>
            handlers.withdraw(input, requestIdOf(requestId))
      )
    ),
    CairnRpcs.toLayerHandler(
      "thread.configure",
      Effect.map(
        threadCommandHandlers,
        (handlers) =>
          (input, { requestId }) =>
            handlers.configure(input, requestIdOf(requestId))
      )
    ),
    CairnRpcs.toLayerHandler(
      "thread.respond",
      Effect.map(
        threadCommandHandlers,
        (handlers) =>
          (input, { requestId }) =>
            handlers.respond(input, requestIdOf(requestId))
      )
    )
  ),
};
