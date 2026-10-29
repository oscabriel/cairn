// The tools conformance scenarios call, on both sides: `echo` returns its `text`; `gate` asks for an
// approval through the approval ledger and answers with the decision and the decider's reason
// (`accepted` succeeds, anything else is an error result: "declined: not now"); `act` is a tool
// that acts, which asks only when the thread's effective permission mode is narrower than full
// access, so a subagent scenario can show a parent's narrowing reach its child (ADR 0031). All are
// replay-safe, so a restart reruns them: `gate` then finds its record and waits again. The
// pi-durable side installs this extension (where `act` is accepted by full access until the
// permission modes reach it); the scripted side has the same tools as a ScriptedTools layer.

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

/** Asks the ledger for this call's approval and answers with its settlement. */
const askLedger = async (
  api: Parameters<typeof approvalLedger>[0],
  signal: AbortSignal | undefined,
  request: {
    readonly tool: string;
    readonly summary: string;
    readonly autoAccept: boolean;
  }
) => {
  const ledger = approvalLedger(api);

  const settlement = await Effect.runPromise(
    Effect.gen(function* () {
      yield* ledger.ask({
        tool: request.tool,
        kind: "tool-call",
        summary: request.summary,
        ttlMillis: APPROVAL_TTL_MILLIS,
        autoAccept: request.autoAccept,
      });

      return yield* ledger.awaitSettlement;
    }),
    { signal }
  );

  return {
    output: [{ type: "text" as const, text: settlementText(settlement) }],
    isError: settlement.status !== "accepted",
  };
};

const gate = defineTool({
  name: "gate",
  description: "Waits for the user's approval and reports the decision.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api, context) =>
    await askLedger(api, context.abortSignal, {
      tool: "gate",
      summary: "Open the gate",
      autoAccept: false,
    }),
});

const act = defineTool({
  name: "act",
  description:
    "Does what it says, asking first when the permission mode needs it.",
  parameters: Type.Object({ what: Type.String() }),
  replay: "safe",
  execute: async (args, api, context) =>
    await askLedger(api, context.abortSignal, {
      tool: "act",
      summary: `Act: ${args.what}`,
      autoAccept: true,
    }),
});

/** The conformance tools as a Cairn extension for the pi-durable side. */
export const conformanceTools: CairnExtension = {
  order: ExtensionOrder.judge,
  extension: defineExtension({
    name: "conformance-tools",
    tools: [echo, gate, act],
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
          const settlement = yield* api.ask("Open the gate", false);

          return {
            text: settlementText(settlement),
            isError: settlement.status !== "accepted",
          };
        }

        if (call.name === "act") {
          const { what } = call.arguments;
          const mode = yield* api.mode;

          const settlement = yield* api.ask(
            `Act: ${Predicate.isString(what) ? what : ""}`,
            mode === "full-access"
          );

          return {
            text: settlementText(settlement),
            isError: settlement.status !== "accepted",
          };
        }

        return { text: `Tool ${call.name} not found`, isError: true };
      }),
  })
);
