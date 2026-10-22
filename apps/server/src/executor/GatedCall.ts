// One Executor `call` or `execute` through Cairn's approval (ADR 0013, plan D37), the effect
// sandwich of spikes/4-approvals/brain.ts:
//
// 1. Record the approval in `cairn.approvals` (`ledger.ask`). In full access, the only mode Phase 1
//    offers, it is recorded accepted at once; otherwise the call waits for the user's answer.
// 2. Mark `started` (`ledger.begin`) before anything reaches Executor. A rerun that finds the mark
//    returns "Interrupted after it started, so it may have run. Not retried." and sends nothing.
// 3. Send the call. When Executor answers `approval-required`, record its `apr_` id
//    (`ledger.noteExecutorRequest`) and answer `resume accept` at once: Cairn's approval already
//    covers this call, so Executor's prompt never meets a person. A program (`execute`) may pause
//    again for each nested call; each is accepted the same way in full access, and declined
//    otherwise (approval cards for nested calls arrive with the other permission modes).
// 4. Mark `done` (`ledger.finish`) once the outcome is known.
//
// `input-required` forms are cancelled with a clear error: Cairn has no form renderer yet. A
// failure after an accept was sent leaves the outcome unknown and is reported as "may have run",
// never retried. The boot sweep (ExecutorSweep.ts) declines every recorded `apr_` whose call never
// reached `done`.
//
// The texts and the status handling are ported from cairn-v1, apps/server/src/ExecutorTools.ts at
// 1a5cd4a (`run`), with v1's approval queue, re-ask after expiry and superseding rows replaced by
// the ledger sandwich (notes/v1.md B7).
import { Duration, Effect, Option, Ref, Result } from "effect";

import type { ApprovalLedger } from "../brain/CairnDocs.ts";
import { ExecutorLink } from "./ExecutorLink.ts";
import type { ExecutorCallError } from "./ExecutorLink.ts";
import {
  callOutcome,
  executeOutcome,
  failed,
  INTERRUPTED,
  matchOutcome,
  outcomeOf,
  REFUSED,
  RERUN_AFTER_START,
} from "./ExecutorReply.ts";
import type {
  ExecutorReply,
  JsonObject,
  ToolOutcome,
} from "./ExecutorReply.ts";

/** How long a recorded approval stays answerable when it waits for the user. */
const APPROVAL_TTL = Duration.hours(24);

/** How long a best-effort decline or cancel may take before the tool reports anyway. */
const REFUSE_WAIT = Duration.seconds(5);

/** The most pauses one program may raise before Cairn stops answering them. */
const MAX_ROUNDS = 64;

/** One gated Executor request. */
export interface GatedRequest {
  readonly kind: "call" | "execute";
  /** What Executor receives: `{calls: [{path, input}]}` or `{code}`. */
  readonly request: JsonObject;
  /** One line for the approval record. */
  readonly summary: string;
  /** Full access: approve at once (the record is still written). */
  readonly autoAccept: boolean;
}

const callFailure = (error: ExecutorCallError, accepted: boolean) => {
  if (error.reason === "sign_in_required") {
    return failed(
      `${error.message} Tell the user; they connect Executor from Cairn's settings.`
    );
  }

  if (!error.sent) {
    return failed(
      accepted
        ? `${error.message} The approved call was not sent again, and Executor will let it expire.`
        : `${error.message} Nothing ran.`
    );
  }

  return failed(`${INTERRUPTED} (${error.message})`);
};

/**
 * Runs one gated request to its final outcome. Never fails: every failure is an outcome the model
 * reads. Interrupting it declines a request Executor asked about and Cairn had not answered.
 */
export const gatedCall = Effect.fn("GatedCall.run")(function* (
  ledger: ApprovalLedger,
  gated: GatedRequest
) {
  const link = yield* ExecutorLink;
  const format = gated.kind === "call" ? callOutcome : executeOutcome;
  const unanswered = yield* Ref.make(Option.none<string>());

  const refuse = (requestId: string, action: "decline" | "cancel") =>
    link
      .call("resume", { requestId, response: { action } })
      .pipe(Effect.timeout(REFUSE_WAIT), Effect.ignore);

  // One reply of the conversation with Executor, to its final outcome. `accepted` is true once an
  // accept was sent, after which an unknown outcome may have run.
  const step = (
    reply: ExecutorReply,
    accepted: boolean,
    round: number
  ): Effect.Effect<ToolOutcome> => {
    if (round >= MAX_ROUNDS) {
      return Effect.succeed(
        failed(
          `The program asked Executor for more than ${MAX_ROUNDS} approvals, so Cairn stopped answering. ${INTERRUPTED}`
        )
      );
    }

    if (Option.isNone(reply.structured)) {
      // No structured outcome: Executor refused the request, and says why.
      const text =
        reply.text === "" ? "Executor refused the request." : reply.text;

      return Effect.succeed(
        failed(`${text} ${accepted ? INTERRUPTED : REFUSED}`)
      );
    }

    return matchOutcome(outcomeOf(reply.structured.value), {
      Completed: ({ value }) => Effect.succeed(format(value)),
      ApprovalRequired: ({ requestId, name }) =>
        Effect.gen(function* () {
          yield* ledger.noteExecutorRequest(requestId).pipe(
            Effect.catchTag("ApprovalLedgerError", (error) =>
              // The record must hold the `apr_` id before an accept is sent, so the boot sweep
              // can decline it; without it, decline now.
              refuse(requestId, "decline").pipe(
                Effect.andThen(Effect.fail(error))
              )
            )
          );

          if (!gated.autoAccept && gated.kind === "execute") {
            yield* refuse(requestId, "decline");

            return failed(
              `The program asked Executor to approve ${name}, and Cairn approves nested calls only in full access, so it declined it. Earlier calls in the program may have run. ${INTERRUPTED}`
            );
          }

          yield* Ref.set(unanswered, Option.some(requestId));

          const resumed = yield* link
            .call("resume", { requestId, response: { action: "accept" } })
            .pipe(
              Effect.result,
              Effect.ensuring(Ref.set(unanswered, Option.none()))
            );

          if (Result.isFailure(resumed)) {
            return callFailure(resumed.failure, true);
          }

          return yield* step(resumed.success, true, round + 1);
        }).pipe(
          Effect.catchTag("ApprovalLedgerError", (ledgerFailure) =>
            Effect.succeed(failed(`${ledgerFailure.message} ${REFUSED}`))
          )
        ),
      InputRequired: ({ requestId, name }) =>
        refuse(requestId, "cancel").pipe(
          Effect.as(
            failed(
              `${name} asked for input with a form, and Cairn can't answer tool input forms yet, so it was cancelled. It may have done some work before it asked. ${INTERRUPTED}`
            )
          )
        ),
      Unavailable: ({ reason, message }) => {
        const detail = message === "" ? "" : ` ${message}`;

        if (!accepted) {
          return Effect.succeed(
            failed(
              `Executor no longer has this request (${reason}).${detail} ${REFUSED}`
            )
          );
        }

        const neverRan =
          gated.kind === "call" &&
          (reason === "expired" || reason === "not-found");

        return Effect.succeed(
          failed(
            neverRan
              ? `Executor no longer had the request when Cairn accepted it (${reason}), so the call did not run. It is not retried.`
              : `Executor no longer has this request (${reason}).${detail} ${INTERRUPTED}`
          )
        );
      },
      Other: ({ status }) => {
        const refused =
          !accepted && (status === "busy" || status === "capacity-exceeded");

        return Effect.succeed(
          failed(
            `Executor answered ${status}. ${refused ? REFUSED : INTERRUPTED}`
          )
        );
      },
    });
  };

  const drive = link.call(gated.kind, gated.request).pipe(
    Effect.matchEffect({
      onFailure: (failure) => Effect.succeed(callFailure(failure, false)),
      onSuccess: (reply) => step(reply, false, 0),
    })
  );

  const sandwich = Effect.gen(function* () {
    const record = yield* ledger.ask({
      tool: `executor_${gated.kind}`,
      kind: "executor-call",
      summary: gated.summary,
      ttlMillis: Duration.toMillis(APPROVAL_TTL),
      autoAccept: gated.autoAccept,
    });

    const answer =
      record.status === "pending" ? yield* ledger.awaitAnswer : record.status;

    if (answer !== "accepted") {
      return failed(
        `Cairn's approval for this call was ${answer}, so nothing was sent to Executor.`
      );
    }

    const prior = yield* ledger.begin;

    if (Option.isSome(prior)) {
      yield* ledger.finish;

      return failed(RERUN_AFTER_START);
    }

    const outcome = yield* drive;

    yield* ledger.finish;

    return outcome;
  });

  return yield* sandwich.pipe(
    Effect.catchTag("ApprovalLedgerError", (error) =>
      Effect.succeed(failed(error.message))
    ),
    Effect.onInterrupt(() =>
      Ref.get(unanswered).pipe(
        Effect.flatMap((requestId) =>
          Option.match(requestId, {
            onNone: () => Effect.void,
            onSome: (id) => refuse(id, "decline"),
          })
        )
      )
    )
  );
});
