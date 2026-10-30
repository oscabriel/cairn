// The goals extension as the installed set takes it (ExtensionSet.ts, integrator seam): the goal
// tools and the judge-run task (`GoalTools.ts`), with the model judge resolving its spec through
// `RoleAliases` (ADR 0035) and asking its one question through the brain's `ModelSource`, never
// the Claude bridge. A model judge's answered call is recorded in the spend ledger under its run id
// when the brain has one (ADR 0036), so a rerun after a crash counts once. pi-durable calls these
// outside Effect, so they run through the layer's context (S43).

import type { ModelRef } from "@cairn/protocol/Models";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";

import type { CairnExtension } from "../brain/Extensions.ts";
import { ModelSource } from "../brain/ModelSource.ts";
import { RoleAliases } from "../models/RoleAliases.ts";
import { SpendLedger } from "../usage/SpendLedger.ts";
import { goalsExtension } from "./GoalTools.ts";
import { NO_JUDGE_FAULTS } from "./JudgeRun.ts";
import type { JudgeFaults, JudgeModels } from "./JudgeRun.ts";
import { modelText } from "./ModelJudge.ts";

/** How long a model judge's one request may take. */
export const MODEL_JUDGE_TIMEOUT = Duration.seconds(120);

/** The spend ledger's source for a model judge's call. */
export const JUDGE_SPEND_SOURCE = "judge-run";

/** A model judge's request got no usable answer. */
class JudgeModelFailed extends Schema.TaggedError<JudgeModelFailed>()(
  "JudgeModelFailed",
  { message: Schema.String }
) {}

/** The provider session of one judge run's request: its thread's and its run's ids. */
export const judgeSessionId = (call: Parameters<JudgeModels["ask"]>[3]) =>
  Option.match(call.threadId, {
    onNone: () => `cairn-${call.runId}`,
    onSome: (threadId) => `cairn-${threadId}-${call.runId}`,
  });

const replyText = (message: AssistantMessage): string =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();

/** The model judge's resolver and caller over the brain's services. */
const judgeModels = Effect.gen(function* () {
  const roles = yield* RoleAliases;
  const source = yield* ModelSource;
  const ledger = yield* Effect.serviceOption(SpendLedger);
  const run = Effect.runPromiseWith(yield* Effect.context());

  const resolve: JudgeModels["resolve"] = async (spec) =>
    await run(
      roles.resolve(spec, Option.none()).pipe(
        Effect.map((resolved): ModelRef => resolved.model),
        Effect.mapError((error) => error.message),
        Effect.result
      )
    );

  const askOnce = Effect.fn("Goals.askJudge")(function* (
    model: ModelRef,
    system: string,
    prompt: string,
    call: Parameters<JudgeModels["ask"]>[3]
  ) {
    const timestamp = yield* Clock.currentTimeMillis;

    const message = yield* source
      .completeSimple(
        model,
        {
          systemPrompt: system,
          messages: [{ role: "user", content: prompt, timestamp }],
        },
        // OpenCode Go refuses a request without a session to route it by (`x-opencode-session`,
        // which pi-ai sets from `sessionId`); one per judge run.
        { sessionId: judgeSessionId(call) }
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: MODEL_JUDGE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new JudgeModelFailed({
                message: `${modelText(model)} did not answer within ${Duration.format(MODEL_JUDGE_TIMEOUT)}.`,
              })
            ),
        })
      );

    if (Option.isSome(ledger)) {
      yield* ledger.value
        .recordCall(
          {
            source: JUDGE_SPEND_SOURCE,
            key: call.runId,
            threadId: call.threadId,
          },
          message
        )
        .pipe(
          Effect.catchTag("SpendLedgerError", (failure) =>
            Effect.logWarning("judge model spend not recorded").pipe(
              Effect.annotateLogs({
                event: "judge_spend_failed",
                runId: call.runId,
                error: failure.message,
              })
            )
          )
        );
    }

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return yield* new JudgeModelFailed({
        message: `${modelText(model)} failed to answer: ${message.errorMessage ?? message.stopReason}.`,
      });
    }

    const text = replyText(message);

    if (text === "") {
      return yield* new JudgeModelFailed({
        message: `${modelText(model)} answered with no text.`,
      });
    }

    return text;
  });

  const ask: JudgeModels["ask"] = async (model, system, prompt, call) =>
    await run(
      askOnce(model, system, prompt, call).pipe(
        Effect.mapError((error) => error.message),
        Effect.result
      )
    );

  return { resolve, ask } satisfies JudgeModels;
});

/** The goals extension, for the installed set. */
export class Goals extends Context.Service<
  Goals,
  { readonly extension: CairnExtension }
>()("cairn/server/verdicts/Goals") {
  /** Over the root's `RoleAliases` and `ModelSource`, and its `SpendLedger` when it has one. */
  static readonly layer = Layer.effect(
    Goals,
    Effect.map(judgeModels, (models) =>
      Goals.of({ extension: goalsExtension(models, NO_JUDGE_FAULTS) })
    )
  );

  /** As `layer`, with planted faults: a judge brain's kill points. */
  static readonly layerWith = (faults: JudgeFaults) =>
    Layer.effect(
      Goals,
      Effect.map(judgeModels, (models) =>
        Goals.of({ extension: goalsExtension(models, faults) })
      )
    );
}
