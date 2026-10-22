// What Executor answers in model mode, parsed once at the link, and the texts a tool returns for it.
// Executor puts every outcome in an MCP result's `structuredContent`: `completed` with the
// execution, `approval-required` with an `apr_` request id and the invocation it is for,
// `input-required` with an `elc_` form, `unavailable` with a reason (answered, expired, ended,
// not-found), or a refusal such as `busy`. A result with no structured content is Executor
// refusing the request, and its text says why.
//
// Ported from cairn-v1, apps/server/src/ExecutorTools.ts (`callOutcome`, `executeOutcome`, `plain`,
// `cut`, the INTERRUPTED and REFUSED texts) and apps/server/src/Executor.ts (`structured`,
// `declineOutcome`) at 1a5cd4a. Changed: replies are decoded with schemas instead of read through
// casts, and an outcome is a plain value the extension turns into a pi-durable result.
import { Data, Option, Predicate, Schema } from "effect";

/** A JSON object, as Executor's structured results are. */
export interface JsonObject {
  readonly [key: string]: Schema.MutableJson;
}

const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);

const decodeJsonObject = Schema.decodeUnknownOption(JsonObjectSchema);

/** The value as a JSON object, when it is one. */
export const asJsonObject = (
  value: Schema.MutableJson | undefined
): Option.Option<JsonObject> => decodeJsonObject(value);

/** One MCP tool result from Executor, parsed. */
export interface ExecutorReply {
  /** The structured outcome; none when Executor refused the request in plain text. */
  readonly structured: Option.Option<JsonObject>;
  /** The result's text content, joined. */
  readonly text: string;
  readonly isError: boolean;
}

/** Parses one MCP result: its structured content when that is a JSON object, and its text. */
export const parseReply = (result: {
  readonly content: ReadonlyArray<{ readonly type: string }>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}): ExecutorReply => ({
  structured: decodeJsonObject(result.structuredContent),
  text: result.content
    .flatMap((part) =>
      Predicate.hasProperty(part, "text") && Predicate.isString(part.text)
        ? [part.text]
        : []
    )
    .join("\n"),
  isError: result.isError === true,
});

const Invocation = Schema.Struct({
  app: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.MutableJson),
});

const ApprovalRequired = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
  invocation: Schema.optionalKey(Invocation),
  expiresAt: Schema.optionalKey(Schema.Finite),
});

const InputRequired = Schema.Struct({
  status: Schema.Literal("input-required"),
  requestId: Schema.String,
  tool: Schema.optionalKey(
    Schema.Struct({
      app: Schema.optionalKey(Schema.String),
      tool: Schema.optionalKey(Schema.String),
    })
  ),
});

const Unavailable = Schema.Struct({
  status: Schema.Literal("unavailable"),
  reason: Schema.String,
  message: Schema.optionalKey(Schema.String),
});

const Completed = Schema.Struct({ status: Schema.Literal("completed") });

const Other = Schema.Struct({ status: Schema.String });

const decodeApproval = Schema.decodeUnknownOption(ApprovalRequired);

const decodeInput = Schema.decodeUnknownOption(InputRequired);

const decodeUnavailable = Schema.decodeUnknownOption(Unavailable);

const decodeCompleted = Schema.decodeUnknownOption(Completed);

const decodeOther = Schema.decodeUnknownOption(Other);

/** Executor's outcome of one `call`, `execute` or `resume`. */
export type ExecutorOutcome = Data.TaggedEnum<{
  Completed: { readonly value: JsonObject };
  ApprovalRequired: {
    readonly requestId: string;
    /** `<app>.<tool>`, for the record and the log. */
    readonly name: string;
  };
  InputRequired: { readonly requestId: string; readonly name: string };
  Unavailable: { readonly reason: string; readonly message: string };
  /** A status Cairn does not handle (`busy`, `capacity-exceeded`, ...), or none at all. */
  Other: { readonly status: string };
}>;

const Outcome = Data.taggedEnum<ExecutorOutcome>();

/** Classifies a structured reply by its `status`. */
export const outcomeOf = (value: JsonObject): ExecutorOutcome => {
  const approval = decodeApproval(value);

  if (Option.isSome(approval)) {
    const { invocation } = approval.value;

    return Outcome.ApprovalRequired({
      requestId: approval.value.requestId,
      name: `${invocation?.app ?? "executor"}.${invocation?.tool ?? "tool"}`,
    });
  }

  const input = decodeInput(value);

  if (Option.isSome(input)) {
    const { tool } = input.value;

    return Outcome.InputRequired({
      requestId: input.value.requestId,
      name: `${tool?.app ?? "An Executor app"}.${tool?.tool ?? "tool"}`,
    });
  }

  const unavailable = decodeUnavailable(value);

  if (Option.isSome(unavailable)) {
    return Outcome.Unavailable({
      reason: unavailable.value.reason,
      message: unavailable.value.message ?? "",
    });
  }

  if (Option.isSome(decodeCompleted(value))) {
    return Outcome.Completed({ value });
  }

  return Outcome.Other({
    status: Option.match(decodeOther(value), {
      onNone: () => "none",
      onSome: (other) => other.status,
    }),
  });
};

/** What a tool hands back: text for the model, a value for code mode scripts, and whether it failed. */
export interface ToolOutcome {
  readonly text: string;
  readonly value: Option.Option<Schema.MutableJson>;
  readonly isError: boolean;
}

/** A failed outcome with only text. */
export const failed = (text: string): ToolOutcome => ({
  text,
  value: Option.none(),
  isError: true,
});

/** A successful outcome: the value, and its JSON for the model. */
export const succeeded = (value: Schema.MutableJson): ToolOutcome => ({
  text: JSON.stringify(value, null, 2),
  value: Option.some(value),
  isError: false,
});

const CHECK =
  "Check the current state with a safe read (a query tool) before running anything again.";

/** A call whose outcome is unknown: it may have run. */
export const INTERRUPTED = `The call was interrupted and is not retried: it may have run. ${CHECK}`;

/** A rerun of a gated call that found its `started` mark (ADR 0013). */
export const RERUN_AFTER_START =
  "Interrupted after it started, so it may have run. Not retried.";

/** Executor refused a request no accept was sent for: nothing ran. */
export const REFUSED =
  "Executor refused the request before anything ran, so it may be tried again later.";

/** Cuts a string to `max` characters, saying how much was cut. */
export const cut = (text: string, max: number) =>
  text.length > max
    ? `${text.slice(0, max)}... (${text.length - max} more characters)`
    : text;

const ItemResult = Schema.Struct({
  ok: Schema.Boolean,
  value: Schema.optionalKey(Schema.MutableJson),
  error: Schema.optionalKey(
    Schema.Struct({
      message: Schema.optionalKey(Schema.String),
      response: Schema.optionalKey(
        Schema.Struct({
          recovery: Schema.optionalKey(
            Schema.Struct({ instructions: Schema.optionalKey(Schema.String) })
          ),
        })
      ),
    })
  ),
});

const decodeItem = Schema.decodeUnknownOption(ItemResult);

const ExecutionError = Schema.Struct({
  error: Schema.Struct({ message: Schema.optionalKey(Schema.String) }),
});

const decodeExecutionError = Schema.decodeUnknownOption(ExecutionError);

/** A direct call's outcome: its first (only) item's value or error. */
export const callOutcome = (result: JsonObject): ToolOutcome => {
  const execution = decodeJsonObject(result.execution);

  const value = Option.flatMap(execution, (found) =>
    Option.fromUndefinedOr(found.value)
  );

  const first = Option.flatMap(value, (found) =>
    decodeItem(Array.isArray(found) ? found[0] : found)
  );

  if (Option.isSome(first)) {
    if (first.value.ok) {
      return succeeded(first.value.value ?? null);
    }

    const { error } = first.value;

    return failed(
      [
        error?.message ?? "The call failed.",
        error?.response?.recovery?.instructions,
      ]
        .filter(Predicate.isString)
        .join("\n\n")
    );
  }

  const executionError = Option.flatMap(execution, decodeExecutionError);

  if (Option.isSome(executionError)) {
    return failed(
      executionError.value.error.message ?? "The call failed in Executor."
    );
  }

  return succeeded(result);
};

/** An `execute` program's outcome, as Executor reported it. */
export const executeOutcome = (result: JsonObject): ToolOutcome => {
  const execution = Option.getOrElse(
    decodeJsonObject(result.execution),
    (): JsonObject => ({})
  );

  const unavailable = result.unavailableApps;

  const body: JsonObject =
    Array.isArray(unavailable) && unavailable.length > 0
      ? { ...execution, unavailableApps: unavailable }
      : execution;

  return { ...succeeded(body), isError: "error" in execution };
};

type DeclineOutcome = "declined" | "not-run" | "unknown";

/** What answering a request with `decline` showed: declined, never ran, or unknown. */
export const declineOutcome = (
  reply: Option.Option<JsonObject>
): DeclineOutcome =>
  Option.match(reply, {
    onNone: (): DeclineOutcome => "unknown",
    onSome: (value) =>
      Outcome.$match(outcomeOf(value), {
        Completed: (): DeclineOutcome => "declined",
        Unavailable: ({ reason }): DeclineOutcome =>
          reason === "expired" || reason === "not-found"
            ? "not-run"
            : "unknown",
        ApprovalRequired: (): DeclineOutcome => "unknown",
        InputRequired: (): DeclineOutcome => "unknown",
        Other: (): DeclineOutcome => "unknown",
      }),
  });

/** Matches an outcome by tag. */
export const matchOutcome = Outcome.$match;
