// The Executor proxies (ADR 0003 as amended, plan D38): Executor's MCP tools `skills`, `search`,
// `describe`, `call` and `execute` as five pi-durable tools in one Cairn extension. Each is
// `callers: ["tools"]`, so the model is never offered them: scripts call them as
// `tools.executor_search(...)` and `tools.executor_call(...)`, listed under code mode's `executor`
// namespace, and the model's own tool list stays fixed (the coding tools plus `codemode`). `resume` is never a tool: it would let a model
// accept its own prompts, so GatedCall.ts answers Executor's pauses itself.
//
// - Discovery (`skills`, `search`, `describe`) only reads, so a rerun after a crash is harmless:
//   `replay: "safe"`. Results leave out the Executor app's own tools (ExecutorScope.ts).
// - `call` and `execute` change the world and go through the approval sandwich (GatedCall.ts);
//   they are `replay: "safe"` because the ledger's `started` mark makes the effect at most once.
// - Each tool returns its value to scripts as `structuredOutput` and its JSON to the model; a
//   failure is an error result with its text as an error diagnostic, which a script reads as a
//   rejected call.
//
// Every tool call runs its Effect through this layer's runtime (S43), with pi-durable's abort
// signal. `unfinishedExecutorRequests` is the boot sweep's read of the approval records, here
// because only `brain/` and extension files may read pi-durable.
//
// Ported from cairn-v1, apps/server/src/ExecutorTools.ts at 1a5cd4a (the five tool definitions,
// their descriptions and the discovery passthrough). Changed: code mode callers, the ledger
// sandwich instead of v1's approval queue, no Executor-app watch and no per-project app list.
import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
  Context,
  Effect,
  FiberSet,
  Layer,
  Match,
  Option,
  Schema,
  Result,
} from "effect";

import { Brain } from "../brain/Brain.ts";
import { Approvals, approvalLedger } from "../brain/CairnDocs.ts";
import { durable } from "../brain/Durable.ts";
import { ExtensionOrder } from "../brain/Extensions.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import { ExecutorLink } from "./ExecutorLink.ts";
import type { ExecutorCallError } from "./ExecutorLink.ts";
import { cut, failed, succeeded } from "./ExecutorReply.ts";
import type { JsonObject, ToolOutcome } from "./ExecutorReply.ts";
import {
  callRefusal,
  discoveryRefusal,
  executeRefusal,
  ExecutorScope,
  filterDescribe,
  filterSearch,
  filterSkills,
} from "./ExecutorScope.ts";
import { gatedCall } from "./GatedCall.ts";

/** The extension's name, as pi-durable selects it. */
export const EXECUTOR_EXTENSION = "cairn-executor";

/** The five proxies, in code mode as `executor.<name>` (prefix `executor_`). */
export const EXECUTOR_TOOL_NAMES = [
  "executor_skills",
  "executor_search",
  "executor_describe",
  "executor_call",
  "executor_execute",
] as const;

/** The longest `executor_execute` program: the user approves exactly what the record shows. */
export const CODE_MAX = 65_536;

/** The length of an approval record's summary line. */
const SUMMARY_MAX = 120;

/**
 * Full access is the only permission mode until approval cards exist (plan D37), so every gated
 * call is approved at once and the record kept for the audit trail and the sandwich.
 */
const AUTO_ACCEPT = true;

const decodeJsonObject = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.MutableJson)
);

/** The pi-durable result for an outcome: text for the model, the value for scripts. */
const toResult = (outcome: ToolOutcome): ToolExecutionResult => {
  const output = [{ type: "text" as const, text: outcome.text }];

  if (outcome.isError) {
    const diagnostics = [{ severity: "error" as const, message: outcome.text }];

    return Option.match(outcome.value, {
      onNone: () => ({ output, isError: true, diagnostics }),
      onSome: (structuredOutput) => ({
        output,
        structuredOutput,
        isError: true,
        diagnostics,
      }),
    });
  }

  return Option.match(outcome.value, {
    onNone: () => ({ output }),
    onSome: (structuredOutput) => ({ output, structuredOutput }),
  });
};

const discoveryFailure = (error: ExecutorCallError) =>
  failed(
    error.reason === "sign_in_required"
      ? `${error.message} Tell the user; they connect Executor from Cairn's settings.`
      : `Executor could not answer: ${error.message}`
  );

/** One discovery passthrough, filtered to what the thread may see. */
const discover = Effect.fn("ExecutorExtension.discover")(function* (
  name: "skills" | "search" | "describe",
  args: JsonObject
) {
  const link = yield* ExecutorLink;
  const refusal = discoveryRefusal(name, args);

  if (Option.isSome(refusal)) {
    return failed(refusal.value);
  }

  const reply = yield* link.call(name, args).pipe(Effect.result);

  if (Result.isFailure(reply)) {
    return discoveryFailure(reply.failure);
  }

  const { structured, text, isError } = reply.success;

  if (Option.isNone(structured)) {
    return failed(text === "" ? "Executor refused the request." : text);
  }

  const filtered = Match.value(name).pipe(
    Match.when("search", () => filterSearch(structured.value)),
    Match.when("describe", () => filterDescribe(structured.value)),
    Match.when("skills", () => filterSkills(structured.value)),
    Match.exhaustive
  );

  const outcome = succeeded(filtered.value);

  const note =
    filtered.hidden > 0
      ? `\n\n(Cairn: ${filtered.hidden} result(s) from Executor's own app were left out.)`
      : "";

  return { ...outcome, text: `${outcome.text}${note}`, isError };
});

/** One `executor_call`, scoped to the thread's project and gated. */
const callTool = Effect.fn("ExecutorExtension.call")(function* (
  path: string,
  input: JsonObject,
  cwd: Option.Option<string>,
  ledger: Parameters<typeof gatedCall>[0]
) {
  const scopes = yield* ExecutorScope;
  const scope = yield* scopes.forCwd(cwd);
  const refusal = callRefusal(scope, path, input);

  if (Option.isSome(refusal)) {
    return failed(refusal.value);
  }

  return yield* gatedCall(ledger, {
    kind: "call",
    request: { calls: [{ path, input }] },
    summary: cut(`${path} ${JSON.stringify(input)}`, SUMMARY_MAX),
    autoAccept: AUTO_ACCEPT,
  });
});

/** One `executor_execute` program, gated. */
const executeTool = Effect.fn("ExecutorExtension.execute")(function* (
  code: string,
  ledger: Parameters<typeof gatedCall>[0]
) {
  const refusal = executeRefusal(code);

  if (Option.isSome(refusal)) {
    return failed(refusal.value);
  }

  return yield* gatedCall(ledger, {
    kind: "execute",
    request: { code },
    summary: cut(
      `executor_execute ${code.trim().split("\n")[0] ?? ""}`,
      SUMMARY_MAX
    ),
    autoAccept: AUTO_ACCEPT,
  });
});

/** An Executor request the brain recorded and never finished: the boot sweep declines it. */
export interface UnfinishedRequest {
  readonly conversationId: number;
  readonly approvalId: string;
  /** Executor's `apr_` id. */
  readonly requestId: string;
}

/**
 * Every recorded Executor request whose call is `started` but not `done`, in the conversations
 * that still have live tasks. Read before the Harness resumes, so nothing changes under it.
 */
export const unfinishedExecutorRequests = Effect.gen(function* () {
  const brain = yield* Brain;
  const session = yield* brain.session;

  const inspection = yield* durable(
    "inspect",
    async (context) => await session.harness.inspect(context)
  );

  const conversations = new Set(
    inspection.tasks.map((task) => task.record.conversationId)
  );

  const found: Array<UnfinishedRequest> = [];

  for (const conversationId of conversations) {
    const approvals = yield* durable(
      "approvals.read",
      async (context) =>
        await session.harness.snapshot(Approvals, conversationId, context)
    );

    for (const record of Object.values(approvals?.items ?? {})) {
      if (record.run === "started" && record.executorRequestId !== null) {
        found.push({
          conversationId,
          approvalId: record.id,
          requestId: record.executorRequestId,
        });
      }
    }
  }

  return found;
});

/** The Executor proxies as one Cairn extension. */
export class ExecutorExtension extends Context.Service<
  ExecutorExtension,
  { readonly extension: CairnExtension }
>()("cairn/server/executor/ExecutorExtension") {
  /** Needs `ExecutorLink` and `ExecutorScope`. */
  static readonly layerNoDeps = Layer.effect(
    ExecutorExtension,
    Effect.gen(function* () {
      const run = yield* FiberSet.makeRuntimePromise<
        ExecutorLink | ExecutorScope
      >();

      const runTool = async (
        outcome: Effect.Effect<
          ToolOutcome,
          never,
          ExecutorLink | ExecutorScope
        >,
        signal: AbortSignal | undefined
      ) =>
        toResult(
          await run(outcome, signal === undefined ? undefined : { signal })
        );

      const structuredOutputSchema = Type.Unknown();

      const skills = defineTool({
        name: "executor_skills",
        description:
          "Read Executor's skills (how to use its apps). With no arguments, lists them; with `app` and `name`, returns one. Start with app `executor`, name `executor`.",
        parameters: Type.Object({
          app: Type.Optional(
            Type.String({ description: "An app slug, such as github." })
          ),
          name: Type.Optional(
            Type.String({ description: "A skill name from the list." })
          ),
          file: Type.Optional(
            Type.String({ description: "A file inside the skill." })
          ),
        }),
        structuredOutputSchema,
        callers: ["tools"],
        replay: "safe",
        execute: async (args, _api, context) =>
          await runTool(discover("skills", { ...args }), context.abortSignal),
      });

      const search = defineTool({
        name: "executor_search",
        description:
          "Find Executor app tools by words. Returns exact paths (tools.<app>.<tool>) and one-line input types; pass a path to tools.executor_describe for the full signature, then to tools.executor_call.",
        parameters: Type.Object({
          query: Type.Optional(Type.String()),
          namespace: Type.Optional(
            Type.String({
              description:
                "An app slug, such as github, or a namespace inside it.",
            })
          ),
          limit: Type.Optional(Type.Integer({ minimum: 1 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        structuredOutputSchema,
        callers: ["tools"],
        replay: "safe",
        execute: async (args, _api, context) =>
          await runTool(discover("search", { ...args }), context.abortSignal),
      });

      const describe = defineTool({
        name: "executor_describe",
        description:
          "Full descriptions and TypeScript signatures of Executor tools at exact paths from tools.executor_search.",
        parameters: Type.Object({
          paths: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
        }),
        structuredOutputSchema,
        callers: ["tools"],
        replay: "safe",
        execute: async (args, _api, context) =>
          await runTool(
            discover("describe", { paths: [...args.paths] }),
            context.abortSignal
          ),
      });

      const call = defineTool({
        name: "executor_call",
        description:
          "Call one Executor app tool by its exact path from tools.executor_search, with its input. Credentials stay in Executor. Returns the tool's value. " +
          "An interrupted call may have run: check with a safe read before calling again.",
        parameters: Type.Object({
          path: Type.String({
            description: "An exact path, such as tools.github.issues.list.",
          }),
          input: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "The tool's input, matching its input type.",
            })
          ),
        }),
        structuredOutputSchema,
        callers: ["tools"],
        replay: "safe",
        execute: async (args, api, context) => {
          const agent = await api.agent(context);
          const input = decodeJsonObject(args.input ?? {});

          const outcome = Option.match(input, {
            onNone: () =>
              Effect.succeed(
                failed(
                  "tools.executor_call's input must be a JSON object. Nothing was sent to Executor."
                )
              ),
            onSome: (value) =>
              callTool(
                args.path,
                value,
                Option.fromUndefinedOr(agent.cwd),
                approvalLedger(api)
              ),
          });

          return await runTool(outcome, context.abortSignal);
        },
      });

      const execute = defineTool({
        name: "executor_execute",
        description:
          "Run a JavaScript program over Executor apps, when one call's result feeds another or a large result should be filtered inside Executor; the tools are async functions at their paths (tools.<app>.<tool>). " +
          "Read tools.executor_skills (app executor, name code-mode) first. A program is never rerun: earlier calls may have completed.",
        parameters: Type.Object({ code: Type.String({ maxLength: CODE_MAX }) }),
        structuredOutputSchema,
        callers: ["tools"],
        replay: "safe",
        execute: async (args, api, context) =>
          await runTool(
            executeTool(args.code, approvalLedger(api)),
            context.abortSignal
          ),
      });

      return ExecutorExtension.of({
        extension: {
          order: ExtensionOrder.executor,
          extension: defineExtension({
            name: EXECUTOR_EXTENSION,
            tools: [skills, search, describe, call, execute],
          }),
        },
      });
    })
  );

  /** With the thread scope read through Node's file system. Needs `ExecutorLink`. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(ExecutorScope.layer)
  );
}
