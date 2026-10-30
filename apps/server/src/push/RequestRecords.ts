// What the notifier reads to word an approval push: a thread's `cairn.approvals` records, as the
// request card reads them (briefs note B7). A shell row names only the oldest pending request and a
// count, so the push's body (a brief's title, a question's header, a tool call's summary) and its
// routing (a question still with the parent is not the user's) come from the records themselves.
// They are read through the harness seam's one-document read (`HarnessSeam.document`), the
// `cairn.approvals` document projected as a client's stream carries it, so both harnesses answer
// alike, the brain's pi-durable stays behind its seam, and no stream (with its transcript
// snapshot and document watches) is opened for a push decision.

import { approvalRecordsOf } from "@cairn/client-logic/PendingRequests";
import type { ThreadId } from "@cairn/protocol/Ids";
import { APPROVALS_DOCUMENT } from "@cairn/protocol/Policy";
import type { ApprovalRecord } from "@cairn/protocol/Policy";
import { Context, Duration, Effect, Layer, Option } from "effect";

import { HarnessSeam } from "../brain/HarnessSeam.ts";

/** How long one read may take before the push decision goes ahead with no records. */
const READ_TIMEOUT = Duration.seconds(5);

/** A thread's decision records, oldest first. */
export class RequestRecords extends Context.Service<
  RequestRecords,
  {
    /**
     * Every `cairn.approvals` record of the thread, oldest first. Never fails: a thread with no
     * conversation, a read that fails or one that takes over five seconds reads as no records, so
     * a push is left for the next event or the sweep rather than sent with the wrong words (the
     * notifier reads again on the next event when a row that says a request waits read as none).
     */
    of(threadId: ThreadId): Effect.Effect<ReadonlyArray<ApprovalRecord>>;
  }
>()("cairn/server/push/RequestRecords") {
  /** The records from the thread's `cairn.approvals` document. Needs `HarnessSeam`. */
  static readonly layer = Layer.effect(
    RequestRecords,
    Effect.gen(function* () {
      const harness = yield* HarnessSeam;

      const of = Effect.fn("RequestRecords.of")(
        function* (threadId: ThreadId) {
          const document = yield* harness
            .document(threadId, APPROVALS_DOCUMENT)
            .pipe(Effect.timeoutOption(READ_TIMEOUT));

          return approvalRecordsOf(
            Option.getOrUndefined(Option.flatten(document))
          );
        },
        (effect, threadId) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("approval records not read", cause).pipe(
                Effect.annotateLogs({
                  event: "push_records_unread",
                  threadId,
                }),
                Effect.as([])
              )
            )
          )
      );

      return RequestRecords.of({ of });
    })
  );

  /** A fixed table of records by thread, for tests and judges; `records` may change between reads. */
  static readonly layerFrom = (
    records: (threadId: ThreadId) => ReadonlyArray<ApprovalRecord>
  ) =>
    Layer.succeed(
      RequestRecords,
      RequestRecords.of({
        of: (threadId) => Effect.sync(() => records(threadId)),
      })
    );

  /** No thread has records: a notifier that pushes run ends only. */
  static readonly layerNone = RequestRecords.layerFrom(() => []);
}
