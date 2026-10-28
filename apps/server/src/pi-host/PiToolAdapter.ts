// A pi TUI extension's tool definition as a pi-durable tool registration (ADR 0039). The mapping:
//
// | pi `ToolDefinition`                                     | pi-durable `ToolRegistration`            |
// | ------------------------------------------------------- | ---------------------------------------- |
// | `name`, `description`, `parameters`, `prepareArguments` | the same                                 |
// | `exposure` direct / model-only                          | `callers` model and tools / model        |
// | `exposure` codemode / deferred                          | `callers` tools                          |
// | `exposure` hidden                                       | the tool is dropped                      |
// | `executionMode`                                         | `executionMode`                          |
// | `outputSchema`                                          | `structuredOutputSchema`                 |
// | `promptSnippet`, `promptGuidelines`                     | the one static `pi-tools` section        |
// | renderers, annotations, namespace, `prepareLoadout`     | dropped                                  |
// | replay                                                  | from `PiHostPolicy`, never the extension |
//
// Running a call is the host's business: the adapter resolves the conversation's cwd and hands the
// call to a `PiToolRunner`, which picks the extension instance and its context. Partial results
// become running output; `details` is cloned to plain JSON, or dropped when it has no JSON form.

import { isJsonValue } from "@earendil-works/chord";
import type {
  AgentToolResult,
  ToolDefinition,
  ToolExposure,
} from "@earendil-works/pi-coding-agent";
import type {
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { Option, Predicate } from "effect";
import type { Types } from "effect";

/** Who may call a tool, as pi-durable says it. */
export type ToolCallers = ReadonlyArray<"model" | "tools">;

const CALLERS: Readonly<Record<ToolExposure, Option.Option<ToolCallers>>> = {
  direct: Option.some(["model", "tools"]),
  "model-only": Option.some(["model"]),
  codemode: Option.some(["tools"]),
  deferred: Option.some(["tools"]),
  hidden: Option.none(),
};

/** The pi-durable callers for a pi exposure (`direct` when unset); none for a hidden tool. */
export const callersOf = (
  exposure: ToolExposure | undefined
): Option.Option<ToolCallers> => CALLERS[exposure ?? "direct"];

/** One call of an adapted tool, as the host's runner receives it. */
export interface PiToolCall {
  readonly name: string;
  /** The arguments pi-durable validated against the tool's own `parameters`. */
  readonly args: unknown;
  readonly callId: string;
  /** The calling conversation's cwd. */
  readonly cwd: string;
  readonly conversationId: string;
  readonly signal: AbortSignal | undefined;
  /** pi's partial results, for the call's running output. */
  readonly onUpdate: (partial: AgentToolResult<unknown>) => void;
}

/** Runs one call on the right extension instance. A throw is the tool's error. */
export type PiToolRunner = (
  call: PiToolCall
) => Promise<AgentToolResult<unknown>>;

/** The text of a result's text parts, joined. */
const textOf = (result: AgentToolResult<unknown>): string =>
  result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

/**
 * Turns pi's partial results, each the whole text so far, into running output chunks: what a
 * partial adds to the one before, or the whole text on a new line when it does not extend it.
 */
export const partialOutput = () => {
  let previous = "";

  return (partial: AgentToolResult<unknown>): Option.Option<string> => {
    const text = textOf(partial);

    const chunk = text.startsWith(previous)
      ? text.slice(previous.length)
      : `\n${text}`;

    previous = text;

    return chunk === "" ? Option.none() : Option.some(chunk);
  };
};

/** The pi-durable result for pi's result: `details` as plain JSON, or left out without a JSON form. */
export const resultOf = (
  definition: ToolDefinition,
  result: AgentToolResult<unknown>
): ToolExecutionResult => {
  const adapted: Types.Mutable<ToolExecutionResult> = {
    output: result.content,
  };

  const text = JSON.stringify(result.details);

  if (Predicate.isString(text)) {
    const details: unknown = JSON.parse(text);

    if (isJsonValue(details)) {
      adapted.details = details;
    }
  }

  const structured: unknown = result.structuredContent;

  if (definition.outputSchema !== undefined && isJsonValue(structured)) {
    adapted.structuredOutput = structured;
  }

  if (result.isError === true) {
    adapted.isError = true;
  }

  if (result.usage !== undefined) {
    adapted.usage = result.usage;
  }

  return adapted;
};

/**
 * The registration for `definition`, replaying as `replay` says and run by `run`; none for a
 * hidden tool. A call from a conversation with no cwd fails, because every pi tool works in one.
 */
export const adaptTool = (
  definition: ToolDefinition,
  replay: "safe" | "unsafe",
  run: PiToolRunner
): Option.Option<ToolRegistration> =>
  Option.map(callersOf(definition.exposure), (callers) => {
    const registration: Types.Mutable<ToolRegistration> = {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      replay,
      callers,
      execute: async (args, api, context) => {
        const agent = await api.agent(context);
        const cwd = agent.cwd ?? "";

        if (cwd === "") {
          throw new Error(
            `${definition.name} has no working directory for this thread; a pi tool always runs in one.`
          );
        }

        const chunks = partialOutput();

        const result = await run({
          name: definition.name,
          args,
          callId: api.callId,
          cwd,
          conversationId: String(api.conversationId),
          signal: context.abortSignal,
          onUpdate: (partial) => {
            const chunk = chunks(partial);

            if (Option.isSome(chunk)) {
              api.output(chunk.value);
            }
          },
        });

        return resultOf(definition, result);
      },
    };

    if (definition.prepareArguments !== undefined) {
      registration.prepareArguments = definition.prepareArguments;
    }

    if (definition.executionMode !== undefined) {
      registration.executionMode = definition.executionMode;
    }

    if (definition.outputSchema !== undefined) {
      registration.structuredOutputSchema = definition.outputSchema;
    }

    return registration;
  });

/**
 * The `pi-tools` prompt section for the tools that survived adaptation: each tool's
 * `promptSnippet`, then every `promptGuidelines` bullet. None when no tool brings either.
 */
export const piToolsSection = (
  definitions: ReadonlyArray<ToolDefinition>
): Option.Option<string> => {
  const snippets = definitions.flatMap((definition) =>
    definition.promptSnippet === undefined
      ? []
      : [`- ${definition.name}: ${definition.promptSnippet}`]
  );

  const guidelines = definitions.flatMap((definition) =>
    (definition.promptGuidelines ?? []).map((line) => `- ${line}`)
  );

  if (snippets.length === 0 && guidelines.length === 0) {
    return Option.none();
  }

  const lines = ["Tools from the user's pi extensions:", ...snippets];

  if (guidelines.length > 0) {
    lines.push("", "Guidelines:", ...guidelines);
  }

  return Option.some(lines.join("\n"));
};
