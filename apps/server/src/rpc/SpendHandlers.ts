// `spend.get` (ADR 0036): what a thread and its lineage subtree, a goal, a workflow run or the whole
// brain spent, by model, for the detail panel. Dollar figures are list prices with their basis, and
// unpriced tokens are counted apart, never as zero. A scope naming a thread or run the brain does
// not hold answers `NotFound`; a ledger that cannot be read is logged and answers `Internal`.

import { Internal, NotFound } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import type { SpendGetInput } from "@cairn/protocol/Spend";
import { Effect } from "effect";

import { SpendLedger } from "../usage/SpendLedger.ts";
import { publicText } from "./PublicText.ts";

/** `spend.get`'s answer from the ledger, its failures as public errors. */
export const answerSpend = (
  ledger: SpendLedger["Service"],
  input: SpendGetInput
) =>
  ledger.rollup(input.scope).pipe(
    Effect.catchTags({
      SpendScopeNotFound: (missing) =>
        Effect.fail(
          new NotFound({
            message: publicText(missing.message),
            resource: missing.resource,
            id: missing.id,
          })
        ),
      SpendLedgerError: (failure) =>
        Effect.logError("spend not read").pipe(
          Effect.annotateLogs({
            event: "spend_get_failed",
            error: failure.message,
          }),
          Effect.andThen(
            Effect.fail(
              new Internal({
                message:
                  "Reading the spend ledger failed. Nothing changed; retry, and check the brain's log (spend_get_failed) if it repeats.",
              })
            )
          )
        ),
    })
  );

/** `spend.get`. Needs `SpendLedger`. */
export const SpendHandlers = CairnRpcs.toLayerHandler(
  "spend.get",
  SpendLedger.useSync((ledger) => (input) => answerSpend(ledger, input))
);
