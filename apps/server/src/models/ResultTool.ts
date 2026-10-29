// The `results` extension (`cairn.results`): how a subagent hands back a typed result. A child
// whose brief names a result schema ends by calling `submit_result` with `{ result, divergence }`;
// the value is repaired, checked against the schema, kept in the child's `cairn.result` document
// and returned with `control.terminate`, so the run ends on it. Design from
// docs/phase-2/notes/models.md, section 2 ("Typed results").
//
// One extension serves every child, because the installed set never churns (footgun "moving
// default selections"), so the registered tool cannot carry any one child's schema. Instead:
//
// - The tool is `deferred`, so a thread is offered it only when its spawn adds it to `modelTools`
//   (`offerResultTool`); a thread the user opened never sees it.
// - Its registered parameters accept any object, so every call reaches `execute`, which validates
//   against the child's own schema (`cairn.child`'s `resultSchema`). That is also what lets the cap
//   hold: pi-durable runs `beforeTool` only after its own validation, so a cap in a hook would never
//   see an invalid third call.
// - A `beforeRequest` hook puts the real envelope schema in the request's tool declaration, so the
//   provider sees it (and decodes against it where strict tools are supported). Measured on OpenCode
//   Go: a tool with no schema and the schema in the prompt gave 0 of 8 valid results; the real
//   schema, or a repair step, gave 8 of 8 on each of three models.
//
// Attempts are derived from the transcript when read, never kept as a second counter: the
// `submit_result` results up to the first accepted one, and a nudge (`NUDGE_TEXT`, sent by the
// delegating side when a child ends without a result) that came before any call, which uses the
// first attempt. A third attempt is refused with the instruction to reply in plain text.
//
// The tool is replay-safe: it is pure over its arguments, the transcript and the result document,
// and the commit that writes `cairn.result` is the one a rerun finds.

import type { ModelRef } from "@cairn/protocol/Models";
import { JsonObject } from "@cairn/protocol/Policy";
import { CHILD_DOCUMENT, RESULT_DOCUMENT } from "@cairn/protocol/Subagents";
import type { Context as ChordContext, JsonValue } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type {
  AgentChange,
  ConversationId,
  Cursor,
  DocumentReader,
  EntryRecord,
  Tx,
} from "@earendil-works/pi-durable";
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ToolResultEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import {
  Array as Arr,
  Context,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";

import type { CairnExtension } from "../brain/Extensions.ts";

/** The extension's name in pi-durable's registry. */
export const RESULTS_EXTENSION = "cairn.results";

/** The tool a child ends with. */
export const RESULT_TOOL_NAME = "submit_result";

/** How many attempts a child gets at a valid result: its calls, and a nudge before any call. */
export const MAX_RESULT_ATTEMPTS = 2;

/** The deepest nesting a result schema may have, counted in schema objects from its root. */
export const MAX_SCHEMA_DEPTH = 8;

/** The largest result schema, in bytes of its JSON. */
export const MAX_SCHEMA_BYTES = 16_384;

/**
 * The one nudge a child gets when its run ends without a result: the delegating side sends it as
 * an input. Recognised in the transcript by this exact text.
 */
export const NUDGE_TEXT =
  "Your brief asked for a typed result and you have not submitted one. Call submit_result now with your result and its divergence from the brief.";

/** What a third attempt is told, and the reason a child closes without a result after it. */
export const CAP_TEXT =
  "The result was rejected twice; reply in plain text with what you found.";

// Documents.

/** `cairn.result` as the document holds it: the protocol's `ResultDocument` as plain JSON. */
export interface ResultState {
  [key: string]: JsonValue;
  result: JsonValue;
  divergence: string;
  /** 0 until the commit that accepts a result, which writes the whole document at once. */
  attempts: number;
}

/**
 * `cairn.result` on the child: the first value `submit_result` accepted. Created only in the
 * commit that accepts it, so a committed document always holds a valid result.
 */
export const ResultDoc = defineDoc<ResultState>({
  kind: RESULT_DOCUMENT,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ result: null, divergence: "", attempts: 0 }),
  // Written once.
  checkpointWhen: () => false,
});

/** The part of `cairn.child` this extension reads: the schema the brief named. */
interface ChildSchemaState {
  [key: string]: JsonValue;
  resultSchema: JsonValue;
}

/**
 * A read-only view of `cairn.child`, which the spawn writes (the subagents extension owns it).
 * Only `snapshot` reads go through this token, so its `initial` is never stored.
 */
const ChildSchemaDoc = defineDoc<ChildSchemaState>({
  kind: CHILD_DOCUMENT,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ resultSchema: null }),
  checkpointWhen: () => false,
});

const decodeChildSchema = Schema.decodeUnknownOption(
  Schema.Struct({ resultSchema: Schema.NullOr(JsonObject) })
);

// Result schemas.

/** Why a result schema is refused at brief time. */
export const SchemaRefusalReason = Schema.Literals([
  "root-union",
  "too-deep",
  "too-large",
  "not-compilable",
]);

export type SchemaRefusalReason = typeof SchemaRefusalReason.Type;

/** A result schema Cairn will not ask a model to fill, with the sentence that says why. */
export interface SchemaRefusal {
  readonly reason: SchemaRefusalReason;
  readonly message: string;
}

const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

/** Narrows a JSON value to its array case, keeping the element type. */
const isJsonArray = (
  value: Schema.Json | undefined
): value is Schema.JsonArray => Arr.isArray(value);

const isJsonObject = (value: Schema.Json | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

/** How deep `schema` nests schema objects, its root being 1. */
const depthOf = (schema: Schema.Json): number => {
  if (isJsonArray(schema)) {
    return Math.max(0, ...schema.map(depthOf));
  }

  if (!isJsonObject(schema)) {
    return 0;
  }

  return 1 + Math.max(0, ...Object.values(schema).map(depthOf));
};

/** The JSON types a schema names: its `type`, or the one its keywords imply. */
const typesOf = (schema: JsonObject): ReadonlyArray<string> => {
  const declared = schema.type;

  if (Predicate.isString(declared)) {
    return [declared];
  }

  if (isJsonArray(declared)) {
    return declared.filter(Predicate.isString);
  }

  if (Predicate.isObject(schema.properties)) {
    return ["object"];
  }

  if (schema.items !== undefined) {
    return ["array"];
  }

  return [];
};

/**
 * The envelope `submit_result` takes for `schema`: the node's value under `result` and a required
 * `divergence`, closed to other keys, which is the shape strict tool decoding accepts.
 */
export const envelopeOf = (schema: JsonObject): JsonObject => ({
  type: "object",
  properties: {
    result: schema,
    divergence: {
      type: "string",
      description:
        'How the work differs from the brief, or "None" when it does not.',
    },
  },
  required: ["result", "divergence"],
  additionalProperties: false,
});

const RESULT_TOOL_DESCRIPTION =
  'Submit your final result for the brief and end your work. `result` must match the schema; `divergence` says how the work differs from the brief, or "None". Call it once, when you are done.';

const decodeJsonObject = Schema.decodeUnknownOption(JsonObject);

const toolFor = (schema: JsonObject) => ({
  name: RESULT_TOOL_NAME,
  description: RESULT_TOOL_DESCRIPTION,
  parameters: Type.Unsafe(envelopeOf(schema)),
});

/** pi-ai's validator over `args`: the coerced value, or its error text. */
const validateWith = (
  schema: JsonObject,
  args: JsonObject
): Result.Result<JsonObject, string> =>
  Result.try({
    try: (): Option.Option<JsonObject> => {
      // pi-ai types its validated arguments as `any`; they are the coerced copy of `args`.
      const checked: unknown = validateToolArguments(toolFor(schema), {
        type: "toolCall",
        id: "check",
        name: RESULT_TOOL_NAME,
        arguments: args,
      });

      return decodeJsonObject(checked);
    },
    catch: (error) =>
      Predicate.isError(error) ? error.message : "Unknown validation error",
  }).pipe(
    Result.flatMap((checked) =>
      Result.fromOption(checked, () => "  - root: must be an object")
    )
  );

/**
 * `schema` if Cairn can ask a model to fill it, else why not: a union at the root (strict tool
 * decoding refuses it and providers differ on it), nesting deeper than `MAX_SCHEMA_DEPTH`, JSON
 * larger than `MAX_SCHEMA_BYTES`, or a schema the validator cannot compile. Checked when a brief
 * names the schema, so the refusal reaches the parent instead of surfacing on a provider.
 */
export const checkResultSchema = (
  schema: JsonObject
): Result.Result<JsonObject, SchemaRefusal> => {
  if (
    COMBINATORS.some((keyword) => schema[keyword] !== undefined) ||
    typesOf(schema).length > 1
  ) {
    return Result.fail({
      reason: "root-union",
      message:
        "The result schema's root is a union. Wrap the alternatives in an object property, so the root is one object or type.",
    });
  }

  const depth = depthOf(schema);

  if (depth > MAX_SCHEMA_DEPTH) {
    return Result.fail({
      reason: "too-deep",
      message: `The result schema nests ${String(depth)} levels; the limit is ${String(MAX_SCHEMA_DEPTH)}. Flatten it.`,
    });
  }

  const bytes = new TextEncoder().encode(JSON.stringify(schema)).length;

  if (bytes > MAX_SCHEMA_BYTES) {
    return Result.fail({
      reason: "too-large",
      message: `The result schema is ${String(bytes)} bytes; the limit is ${String(MAX_SCHEMA_BYTES)}. Shorten its descriptions or split the work.`,
    });
  }

  // A schema that compiles validates the empty object without throwing anything but its verdict.
  const compiled = validateWith(schema, { result: null, divergence: "None" });

  if (
    Result.isFailure(compiled) &&
    !compiled.failure.startsWith("Validation failed")
  ) {
    return Result.fail({
      reason: "not-compilable",
      message: `The result schema is not valid JSON Schema: ${compiled.failure}`,
    });
  }

  return Result.succeed(schema);
};

// Repair.

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Json)
);

/**
 * `value` parsed when it is a JSON string of an object or an array and `types` allows that and
 * not a string: the mistake models make most (an array sent as `"[...]"`), which pi-ai's
 * validator would otherwise reject, or for `string[]` silently wrap as one string.
 */
const parsedContainer = (
  value: Schema.Json,
  types: ReadonlyArray<string>
): Schema.Json => {
  if (!Predicate.isString(value) || types.includes("string")) {
    return value;
  }

  const wantsObject = types.includes("object");
  const wantsArray = types.includes("array");

  if (!wantsObject && !wantsArray) {
    return value;
  }

  return Option.match(decodeJson(value.trim()), {
    onNone: () => value,
    onSome: (parsed) =>
      (wantsArray && isJsonArray(parsed)) ||
      (wantsObject && isJsonObject(parsed))
        ? parsed
        : value,
  });
};

/**
 * `value` repaired against `schema`: every JSON string where the schema wants an object or an
 * array is parsed, at any depth. Pure, and never mutates `value`; anything it cannot repair is
 * left for validation to report.
 */
export const repairValue = (
  schema: Schema.Json,
  value: Schema.Json
): Schema.Json => {
  if (!isJsonObject(schema)) {
    return value;
  }

  const members = COMBINATORS.flatMap((keyword) => {
    const listed = schema[keyword];

    return isJsonArray(listed) ? listed.filter(isJsonObject) : [];
  });

  const types = [...typesOf(schema)];

  // An `allOf` member constrains the value further; only `anyOf` and `oneOf` widen its types.
  if (schema.anyOf !== undefined || schema.oneOf !== undefined) {
    types.push(...members.flatMap(typesOf));
  }

  const parsed = parsedContainer(value, types);

  if (isJsonArray(parsed)) {
    const { items } = schema;

    return isJsonObject(items)
      ? parsed.map((item) => repairValue(items, item))
      : parsed;
  }

  if (isJsonObject(parsed)) {
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    const additional = schema.additionalProperties;

    return Object.fromEntries(
      Object.entries(parsed).map(([key, item]) => {
        const property = properties[key];

        if (property !== undefined) {
          return [key, repairValue(property, item)];
        }

        return [
          key,
          isJsonObject(additional) ? repairValue(additional, item) : item,
        ];
      })
    );
  }

  return parsed;
};

/**
 * `args` of a `submit_result` call repaired for `schema`: the whole call parsed when it arrived as
 * a JSON string, a result sent at the top level (no `result` key, every other key one of the
 * schema's properties) moved under `result`, then `repairValue` over the envelope.
 */
export const repairArguments = (
  schema: JsonObject,
  args: Schema.Json
): Schema.Json => {
  const whole = parsedContainer(args, ["object"]);

  if (!isJsonObject(whole)) {
    return whole;
  }

  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  const { divergence, ...rest } = whole;
  const loose = Object.keys(rest);

  const atTopLevel =
    whole.result === undefined &&
    loose.length > 0 &&
    loose.every((key) => properties[key] !== undefined);

  if (!atTopLevel) {
    return repairValue(envelopeOf(schema), whole);
  }

  const wrapped: JsonObject =
    divergence === undefined ? { result: rest } : { result: rest, divergence };

  return repairValue(envelopeOf(schema), wrapped);
};

/** A call's arguments, accepted: the value for `result` and the divergence. */
export interface AcceptedResult {
  readonly result: Schema.Json;
  readonly divergence: string;
}

/**
 * The verdict on `args` against `schema`, after `repairArguments`: the accepted value, or pi-ai's
 * error lines (a path and a reason each), without the echo of the arguments.
 */
export const validateResult = (
  schema: JsonObject,
  args: Schema.Json
): Result.Result<AcceptedResult, string> => {
  const repaired = repairArguments(schema, args);

  if (!isJsonObject(repaired)) {
    return Result.fail(
      "  - root: must be an object with result and divergence"
    );
  }

  return Result.flatMap(validateWith(schema, repaired), (valid) => {
    const { result, divergence } = valid;

    return Predicate.isString(divergence) && result !== undefined
      ? Result.succeed({ result, divergence })
      : Result.fail("  - divergence: must be string");
  }).pipe(
    Result.mapError((message) =>
      (message.split("\n\nReceived arguments:")[0] ?? message)
        .split("\n")
        .filter((line) => line.startsWith("  - "))
        .join("\n")
    )
  );
};

// Attempts, from the transcript.

/** What one transcript entry says about the result: a call's verdict, or the nudge. */
export type ResultMark = "rejected" | "accepted" | "nudge";

/** Where a child stands on its result, derived from its transcript's marks in order. */
export interface AttemptState {
  /** Attempts used: rejected calls, plus a nudge that came before any call. */
  readonly used: number;
  readonly accepted: boolean;
  readonly nudged: boolean;
}

/** The state after `marks`, oldest first. Marks after the first accepted call change nothing. */
export const attemptStateOf = (marks: Iterable<ResultMark>): AttemptState => {
  let used = 0;
  let called = false;
  let nudged = false;

  for (const mark of marks) {
    if (mark === "accepted") {
      return { used: used + 1, accepted: true, nudged };
    }

    if (mark === "rejected") {
      called = true;
      used += 1;
    } else if (!nudged) {
      nudged = true;

      if (!called) {
        used += 1;
      }
    }
  }

  return { used, accepted: false, nudged };
};

/** Whether a child in `state` may still call `submit_result`. */
export const canSubmit = (state: AttemptState): boolean =>
  !state.accepted && state.used < MAX_RESULT_ATTEMPTS;

/**
 * Whether a child in `state` whose run just ended gets the nudge: it has no result, has not been
 * nudged, and has an attempt left. Otherwise it closes without a result.
 */
export const nudgeDue = (state: AttemptState): boolean =>
  !state.accepted && !state.nudged && state.used < MAX_RESULT_ATTEMPTS;

const textOf = (message: Message): string => {
  if (message.role !== "user") {
    return "";
  }

  return Predicate.isString(message.content)
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
};

/** What `entry` says about the result, if anything. */
export const markOf = (entry: EntryRecord): Option.Option<ResultMark> => {
  const message = entry.model?.[0];

  if (message === undefined) {
    return Option.none();
  }

  if (
    ToolResultEntry.is(entry) &&
    message.role === "toolResult" &&
    message.toolName === RESULT_TOOL_NAME
  ) {
    return Option.some(message.isError ? "rejected" : "accepted");
  }

  return UserEntry.is(entry) && textOf(message).trim() === NUDGE_TEXT
    ? Option.some("nudge")
    : Option.none();
};

const SCAN_PAGE = 256;

/** The attempt state of `conversationId`, read from its transcript inside `tx`. */
export const readAttemptState = async (
  tx: Tx,
  conversationId: ConversationId
): Promise<AttemptState> => {
  const marks: Array<ResultMark> = [];

  // Pages are read one after another: each cursor comes from the page before.
  const scan = async (cursor: Option.Option<Cursor>): Promise<AttemptState> => {
    const page = await tx.scanEntries(
      { conversationId, order: "ascending" },
      SCAN_PAGE,
      Option.getOrUndefined(cursor)
    );

    for (const entry of page.items) {
      marks.push(...Option.toArray(markOf(entry)));
    }

    return page.next === undefined
      ? attemptStateOf(marks)
      : await scan(Option.some(page.next));
  };

  return await scan(Option.none());
};

/**
 * The model that produced the child's last assistant message, which is what the result came
 * from: read from the transcript, never from the role table.
 */
export const returnedModelOf = (
  messages: ReadonlyArray<Message>
): Option.Option<ModelRef> => {
  const last = messages.findLast((message) => message.role === "assistant");

  return last?.role === "assistant"
    ? Option.some({ provider: last.provider, modelId: last.model })
    : Option.none();
};

// The tool.

const resultSchemaOf = (value: Readonly<ChildSchemaState> | undefined) =>
  Option.flatMap(decodeChildSchema(value), (child): Option.Option<JsonObject> =>
    Option.fromNullOr(child.resultSchema)
  );

/** The verdict of one call, decided in the commit that reads the transcript. */
type Verdict =
  | { readonly kind: "accepted"; readonly value: ResultState }
  | {
      readonly kind: "rejected";
      readonly attempt: number;
      readonly errors: string;
    }
  | { readonly kind: "capped" };

const text = (value: string) => [{ type: "text" as const, text: value }];

/**
 * `submit_result`. Offered only where `offerResultTool` added it; refuses a thread whose
 * `cairn.child` names no schema.
 */
export const RESULT_TOOL = defineTool({
  name: RESULT_TOOL_NAME,
  description: RESULT_TOOL_DESCRIPTION,
  // Any object reaches `execute`, which validates against the child's own schema; the request
  // carries the real envelope (the `beforeRequest` hook below).
  parameters: Type.Unsafe<JsonObject>({ type: "object" }),
  constrainedSampling: { type: "json_schema", strict: "prefer" },
  replay: "safe",
  deferred: true,
  structuredOutputSchema: Type.Object({
    result: Type.Unknown(),
    divergence: Type.String(),
    attempts: Type.Integer({ minimum: 1 }),
  }),
  // A call sent whole as a JSON string. Schema-aware repair needs the child's schema, so it runs
  // in `execute`.
  prepareArguments: (args) => {
    const parsed = Predicate.isString(args)
      ? decodeJson(args.trim())
      : Option.none();

    // SAFETY: `prepareArguments` returns what pi-durable validates next against `parameters`
    // (any object), so a value that is not an object is refused there as invalid arguments.
    // Verified by: ResultTool.test.ts "parses a whole call sent as a JSON string".
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return (Option.getOrUndefined(parsed) ?? args) as JsonObject;
  },
  execute: async (args, api, context) => {
    const child = await api.snapshot(
      ChildSchemaDoc,
      api.conversationId,
      context
    );

    const schema = resultSchemaOf(child);

    if (Option.isNone(schema)) {
      return {
        output: text(
          "submit_result: this thread was not asked for a typed result. Answer in plain text."
        ),
        isError: true,
      };
    }

    const verdict = validateResult(schema.value, args);

    const decided = await api.commit(async (tx): Promise<Verdict> => {
      const state = await readAttemptState(tx, api.conversationId);

      if (!canSubmit(state)) {
        return { kind: "capped" };
      }

      const attempt = state.used + 1;

      if (Result.isFailure(verdict)) {
        return { kind: "rejected", attempt, errors: verdict.failure };
      }

      // Opened only to accept, since opening creates the document.
      const document = await tx.doc(ResultDoc, api.conversationId);

      // A rerun, or a second call of the same round: the first accepted value stands.
      if (document.attempts > 0) {
        return { kind: "accepted", value: { ...document } };
      }

      document.result = copyJson(verdict.success.result);
      document.divergence = verdict.success.divergence;
      document.attempts = attempt;

      return { kind: "accepted", value: { ...document } };
    }, context);

    if (decided.kind === "accepted") {
      return {
        output: text("Result accepted. Your work on this brief is done."),
        structuredOutput: decided.value,
        control: { terminate: true },
      };
    }

    if (decided.kind === "capped") {
      return { output: text(`submit_result: ${CAP_TEXT}`), isError: true };
    }

    const next =
      decided.attempt < MAX_RESULT_ATTEMPTS
        ? "Fix these and call submit_result again."
        : CAP_TEXT;

    return {
      output: text(
        `submit_result rejected (attempt ${String(decided.attempt)} of ${String(MAX_RESULT_ATTEMPTS)}):\n${decided.errors}\n${next}`
      ),
      isError: true,
    };
  },
});

/**
 * The part of a child's spawn `AgentChange` that offers `submit_result`. `modelTools` replaces
 * the stored filter as a whole, so a spawn that sets other model tools merges this `add` into its
 * own.
 */
export const offerResultTool: AgentChange = {
  modelTools: { add: [RESULT_TOOL] },
};

/**
 * `messages` with every `submit_result` declaration carrying `schema`'s envelope: what the
 * provider is sent, while the stored declaration stays the registered one.
 */
export const declareSchema = (
  messages: ReadonlyArray<Message>,
  schema: JsonObject
): ReadonlyArray<Message> => {
  const parameters = Type.Unsafe(envelopeOf(schema));

  return messages.map((message) =>
    message.role === "system" &&
    message.toolsAdded?.some((tool) => tool.name === RESULT_TOOL_NAME) === true
      ? {
          ...message,
          toolsAdded: message.toolsAdded.map((tool) =>
            tool.name === RESULT_TOOL_NAME ? { ...tool, parameters } : tool
          ),
        }
      : message
  );
};

/** The `results` extension: the tool and the hook that declares each child's schema. */
export class ResultTool extends Context.Service<
  ResultTool,
  {
    /** The extension, for the installed set. */
    readonly extension: CairnExtension;
  }
>()("cairn/server/models/ResultTool") {
  /** The extension at `order` (the integrator's key in `ExtensionOrder`). */
  static readonly layerAt = (order: number) =>
    Layer.succeed(
      ResultTool,
      ResultTool.of({
        extension: {
          order,
          extension: defineExtension({
            name: RESULTS_EXTENSION,
            tools: [RESULT_TOOL],
            hooks: [
              hook(GenerationTask, {
                beforeRequest: async (request, api, context) => {
                  const child = await api.snapshot(
                    ChildSchemaDoc,
                    api.conversationId,
                    context
                  );

                  return Option.getOrUndefined(
                    Option.map(resultSchemaOf(child), (schema) => ({
                      messages: declareSchema(request.messages, schema),
                    }))
                  );
                },
              }),
            ],
          }),
        },
      })
    );
}

/** The accepted result of `conversationId`, if it has one, as the delegating tool reads it. */
export const readResult = async (
  read: DocumentReader,
  conversationId: ConversationId,
  context: ChordContext
): Promise<Option.Option<ResultState>> => {
  const document = await read.snapshot(ResultDoc, conversationId, context);

  return document !== undefined && document.attempts > 0
    ? Option.some({ ...document })
    : Option.none();
};
