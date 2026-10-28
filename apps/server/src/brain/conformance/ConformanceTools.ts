// The tools conformance scenarios call, on both sides: `echo` returns its `text`; `gate` asks for an
// approval through the approval ledger and answers with the decision and the decider's reason
// (`accepted` succeeds, anything else is an error result: "declined: not now"). Both are
// replay-safe, so a restart reruns them: `gate` then finds its record and waits again. The
// pi-durable side installs this extension; the scripted side has the same two tools as a
// ScriptedTools layer.

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Layer, Predicate } from "effect";

import { approvalLedger, settlementText } from "../CairnDocs.ts";
import { ExtensionOrder } from "../Extensions.ts";
import type { CairnExtension } from "../Extensions.ts";
import { ScriptedTools } from "../ScriptedHarness.ts";

/** A day: approvals in scenarios never expire on their own. */
const APPROVAL_TTL_MILLIS = 86_400_000;

const echo = defineTool({
  name: "echo",
  description: "Returns its text.",
  parameters: Type.Object({ text: Type.String() }),
  replay: "safe",
  execute: async (args) => {
    await Promise.resolve();

    return { output: [{ type: "text", text: args.text }] };
  },
});

const gate = defineTool({
  name: "gate",
  description: "Waits for the user's approval and reports the decision.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api, context) => {
    const ledger = approvalLedger(api);

    const settlement = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ledger.ask({
          tool: "gate",
          kind: "tool-call",
          summary: "Open the gate",
          ttlMillis: APPROVAL_TTL_MILLIS,
          autoAccept: false,
        });

        return yield* ledger.awaitSettlement;
      }),
      { signal: context.abortSignal }
    );

    return {
      output: [{ type: "text", text: settlementText(settlement) }],
      isError: settlement.status !== "accepted",
    };
  },
});

/** The conformance tools as a Cairn extension for the pi-durable side. */
export const conformanceTools: CairnExtension = {
  order: ExtensionOrder.judge,
  extension: defineExtension({
    name: "conformance-tools",
    tools: [echo, gate],
  }),
};

/** The same tools for the scripted side. */
export const scriptedConformanceTools = Layer.succeed(
  ScriptedTools,
  ScriptedTools.of({
    run: (call, api) =>
      Effect.gen(function* () {
        if (call.name === "echo") {
          const { text } = call.arguments;

          return {
            text: Predicate.isString(text) ? text : "",
            isError: false,
          };
        }

        if (call.name === "gate") {
          const settlement = yield* api.ask("Open the gate");

          return {
            text: settlementText(settlement),
            isError: settlement.status !== "accepted",
          };
        }

        return { text: `Tool ${call.name} not found`, isError: true };
      }),
  })
);
