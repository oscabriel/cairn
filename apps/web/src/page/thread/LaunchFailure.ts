// Why a thread's launch failed, read from its shell row, for the thread page's failure line.

import { Option } from "effect";

import { retryDraftId } from "../../composer/Update.ts";
import type { Model } from "../../Model.ts";
import { draftRouter } from "../../Route.ts";
import { threadRowOf } from "../../ThreadRow.ts";
import type { LaunchFailure } from "./Inputs.ts";

/**
 * Why the thread's launch failed, from its shell row, and the draft its first message went back to
 * when this page put it there.
 */
export const launchFailureOf = (
  model: Model,
  threadId: string
): Option.Option<LaunchFailure> =>
  Option.flatMap(
    Option.filter(
      threadRowOf(model.shell, threadId),
      (thread) => thread.activity === "failed"
    ),
    (thread) =>
      Option.map(thread.lastError, (message) => {
        const draftId = retryDraftId(threadId);

        return {
          message,
          retryUrl: Option.some(draftRouter({ draftId })).pipe(
            Option.filter(() =>
              Object.hasOwn(model.composer.drafts, `draft:${draftId}`)
            )
          ),
        };
      })
  );
