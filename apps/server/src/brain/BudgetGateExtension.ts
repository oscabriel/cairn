// The `cairn.budgets` extension (ADR 0036, models note section 4, enforcement point b): a
// `beforeTool` hook in every conversation that blocks the next tool call of work a budget stopped,
// so a run winds down without calling what it cannot afford.
//
// It asks the `BudgetBook` (`gateDecision`) with the call's thread and tool, and the subagent a delegating call names
// (`subagent` in `subagent_send`), and blocks with the text it answers: in a scope at its line in
// `stop` mode every tool but `submit_result`, in `drain` mode the delegating tools. A hook runs
// before intent, so a call blocked once is a committed result and a rerun never asks again; a call
// that passed is never re-gated. The book is in memory, so the hook is cheap on every call.
//
// The hook runs Effects through one runtime from the layer's scope (S43). A gate that cannot answer
// lets the call through and logs: the guard's stop still bounds the overshoot.

import { ThreadId } from "@cairn/protocol/Ids";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { Context, Effect, FiberSet, Layer, Option, Schema } from "effect";

import { BudgetBook, DELEGATING_TOOLS } from "../usage/BudgetBook.ts";
import { gateDecision } from "../usage/Budgets.ts";
import { ThreadMeta } from "./CairnDocs.ts";
import { ExtensionOrder } from "./Extensions.ts";
import type { CairnExtension } from "./Extensions.ts";

/** The extension's name in pi-durable's registry. */
export const BUDGETS_EXTENSION = "cairn.budgets";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** The `cairn.budgets` extension. */
export class BudgetGate extends Context.Service<
  BudgetGate,
  {
    /** The extension, for the installed set. */
    readonly extension: CairnExtension;
  }
>()("cairn/server/brain/BudgetGateExtension/BudgetGate") {
  /**
   * Over the `BudgetBook` (the same one `Budgets` fills), at `ExtensionOrder.budgets`. It needs nothing that
   * needs the brain, so the brain's extension set can be built with it.
   */
  static readonly layer = Layer.effect(
    BudgetGate,
    Effect.gen(function* () {
      const book = yield* BudgetBook;
      const run = yield* FiberSet.makeRuntimePromise();

      const decide = Effect.fn("BudgetGate.decide")(
        function* (
          threadId: ThreadId,
          tool: string,
          target: Option.Option<ThreadId>
        ) {
          return gateDecision(
            tool,
            yield* book.coveringOf(threadId),
            Option.isSome(target) ? yield* book.coveringOf(target.value) : []
          );
        },
        (effect, threadId, tool) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("budget gate did not answer", cause).pipe(
                Effect.annotateLogs({
                  event: "budget_gate_failed",
                  threadId,
                  tool,
                }),
                Effect.as(Option.none<string>())
              )
            )
          )
      );

      const extension = defineExtension({
        name: BUDGETS_EXTENSION,
        hooks: [
          hook(ToolTask, {
            beforeTool: async (call, api, context) => {
              const meta = await api.snapshot(
                ThreadMeta,
                api.conversationId,
                context
              );

              const threadId = decodeThreadId(meta?.threadId);

              const target = DELEGATING_TOOLS.has(call.name)
                ? decodeThreadId(call.arguments.subagent)
                : Option.none<ThreadId>();

              const block = await run(
                Option.match(threadId, {
                  onNone: () => Effect.succeedNone,
                  onSome: (thread) => decide(thread, call.name, target),
                })
              );

              return Option.getOrUndefined(
                Option.map(block, (text) => ({ block: text }))
              );
            },
          }),
        ],
      });

      return BudgetGate.of({
        extension: { order: ExtensionOrder.budgets, extension },
      });
    })
  );
}
