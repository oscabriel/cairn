// The `ask_user` tool on pi-durable (briefs note, section 4): it writes a `user-input` record with
// the questions frozen in its payload, waits for it like any approval, and returns the numbered
// answers. The rules (arguments, record, result text) are `AskUser.ts`, which the scripted harness
// shares.
//
// It is `replay: "safe"`: the record is keyed by the tool task (`call-<taskId>`), so a rerun after
// a restart finds its record and waits again, or reads the answer that landed meanwhile (ADR
// 0013). It is offered to the model only (`callers: ["model"]`): a codemode script that waited on
// the user would hold its sandbox for as long as the user takes. A stop cancels the record with
// the run that asked. Routing a child's question to its parent first (ADR 0027) is the question
// router's; here every question is the user's.

import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Option, Result } from "effect";

import { approvalLedger, Approvals } from "../brain/CairnDocs.ts";
import { durable } from "../brain/Durable.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import {
  ASK_USER_DESCRIPTION,
  ASK_USER_TOOL,
  askUserResult,
  MAX_HEADER,
  MAX_LABEL,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MAX_TEXT,
  QUESTION_TTL_MILLIS,
  questionAskOf,
} from "./AskUser.ts";
import type { QuestionAsk } from "./AskUser.ts";

/** The extension's name in pi-durable's registry. */
export const ASK_USER_EXTENSION = "cairn.ask-user";

const parameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      header: Type.String({ minLength: 1, maxLength: MAX_HEADER }),
      question: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({ minLength: 1, maxLength: MAX_LABEL }),
            description: Type.Optional(Type.String({ maxLength: MAX_TEXT })),
            recommended: Type.Optional(Type.Boolean()),
          }),
          { maxItems: MAX_OPTIONS }
        )
      ),
      multiSelect: Type.Optional(Type.Boolean()),
      allowCustomAnswer: Type.Optional(Type.Boolean()),
    }),
    { minItems: 1, maxItems: MAX_QUESTIONS }
  ),
});

const refusal = (text: string) => ({
  output: [{ type: "text" as const, text }],
  isError: true,
});

/** Asks, waits, and reads the settled record back with its answers. */
const askAndWait = (api: ToolExecutionApi, ask: QuestionAsk) =>
  Effect.gen(function* () {
    const ledger = approvalLedger(api);

    yield* ledger.ask({
      tool: ASK_USER_TOOL,
      kind: "user-input",
      summary: ask.summary,
      ttlMillis: QUESTION_TTL_MILLIS,
      payload: Option.some(ask.payload),
      acceptedBy: Option.none(),
    });

    yield* ledger.awaitSettlement;

    const doc = yield* durable(
      "approvals.read",
      async (context) =>
        await api.snapshot(Approvals, api.conversationId, context)
    );

    const record = Option.fromUndefinedOr(doc?.items[ledger.approvalId]);

    const result = Option.match(record, {
      onNone: () => ({
        text: "The questions have no record any more. Nothing was answered.",
        isError: true,
      }),
      onSome: (found) => askUserResult(found, ask.questions),
    });

    return {
      output: [{ type: "text" as const, text: result.text }],
      isError: result.isError,
    };
  }).pipe(
    Effect.catchTags({
      ApprovalLedgerError: (failure) =>
        Effect.succeed(refusal(failure.message)),
      DurableCallError: (failure) =>
        Effect.succeed(
          refusal(
            `Reading the answers failed: ${failure.message}. Nothing was answered.`
          )
        ),
    })
  );

/** `ask_user` as a pi-durable tool. */
export const askUserTool = defineTool({
  name: ASK_USER_TOOL,
  description: ASK_USER_DESCRIPTION,
  parameters,
  replay: "safe",
  callers: ["model"],
  execute: async (args, api, context) => {
    const ask = questionAskOf(args);

    if (Result.isFailure(ask)) {
      return refusal(ask.failure);
    }

    return await Effect.runPromise(askAndWait(api, ask.success), {
      signal: context.abortSignal,
    });
  },
});

/** The `ask_user` extension, installed at `order`; production passes `ExtensionOrder.askUser`. */
export const askUserExtension = (order: number): CairnExtension => ({
  order,
  extension: defineExtension({
    name: ASK_USER_EXTENSION,
    tools: [askUserTool],
  }),
});
