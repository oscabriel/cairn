// In-memory waits on a conversation document, for the subagent tools: `ask_parent` waits for its
// question's answer, `subagent_status` for a child to report.
// None is durable: a wait cut off by a restart is rerun by its task or replay-safe tool, which
// finds what was decided meanwhile in the first value (ADR 0013). The shape follows the approval
// ledger's wait (`approvalLedger` in brain/CairnDocs.ts): a watch whose listener only hands each
// value on, ended by the stream's scope.

import type { Context as ChordContext } from "@earendil-works/chord/context";
import type {
  ConversationDocToken,
  ConversationId,
  DocumentObserver,
  JsonObject,
} from "@earendil-works/pi-durable";
import { Effect, Option, Queue, Stream } from "effect";

import { durable, handOff } from "../brain/Durable.ts";
import type { DurableCallError } from "../brain/Durable.ts";

/**
 * The first value of `token` on `conversationId` that `pick` accepts, the current one included.
 * None when the document does not exist.
 */
export const awaitDoc = <T extends JsonObject, A>(
  observer: DocumentObserver,
  token: ConversationDocToken<T>,
  conversationId: ConversationId,
  pick: (value: Readonly<T> | null) => Option.Option<A>
): Effect.Effect<Option.Option<A>, DurableCallError> =>
  Stream.callback<Readonly<T> | null, DurableCallError>(
    (queue) =>
      Effect.gen(function* () {
        const watch = yield* Effect.acquireRelease(
          durable(
            "subagents.watch",
            async (context) =>
              await observer.watchDoc(token, conversationId, context)
          ),
          (handle) =>
            Effect.promise(async () => {
              await handle?.stop();
            })
        );

        if (watch === undefined) {
          yield* Queue.end(queue);
        } else {
          Queue.offerUnsafe(queue, watch.value);
          watch.start(
            handOff((value: Readonly<T> | null) => {
              Queue.offerUnsafe(queue, value);
            })
          );
        }
      }),
    { bufferSize: 1, strategy: "sliding" }
  ).pipe(
    Stream.map(pick),
    Stream.filter(Option.isSome),
    Stream.map((found) => found.value),
    Stream.runHead
  );

/** Runs a wait from pi-durable code, cancelled with the call's own abort signal. */
export const runWait = async <A>(
  wait: Effect.Effect<A, DurableCallError>,
  context: ChordContext
): Promise<A> => await Effect.runPromise(wait, { signal: context.abortSignal });
