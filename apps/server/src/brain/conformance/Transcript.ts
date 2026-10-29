// The replay transcript format of the harness conformance suite (ADR 0024), one JSON object per
// line. A scenario is driven by `input` lines, fed by `model` lines, and judged by `expect_*` lines
// written by hand from the seam's contract (never recorded), so the suite judges each harness
// instead of replaying one.
//
// Lines:
// - `transcript_start {scenario, version}`: first line.
// - `model {label, hold?, text?, toolCalls?, stopReason?, errorMessage?}`: the next model answer,
//   consumed in order by whichever request comes next. `hold` keeps it until `release {label}`.
// - `input {step, ...}`: `ensure {runtimeMode?}` (full access by default), `ensure_race`,
//   `subscribe`, `configure {runtimeMode}`, `message` (with `whenBusy`), `steer`, `follow_up`,
//   `stop`, `stop_clear`, `withdraw {requestId}`, `respond {decision, reason?}`, `compact`,
//   `restart`. `subscribe` opens the client's one subscription now, before any ensure,
//   as a page opened on a launch does: it waits on `whenEnsured`, then watches, and is never
//   reopened. An input may carry `expect` on its own result (an error reason, `withdrawn`, the
//   submission of an earlier request id, one conversation for a race).
// - `crash`: close the harness and open a new one over the same store.
// - `release {label}`, `settle {ms}`.
// - `expect_event {event}`: the next event, after the previous match, that contains `event`.
// - `expect_event_count {event, count}`: how many events so far contain `event`.
// - `expect_view {path, equals}`: the client's normalized view at `path` reaches `equals`.
//
// The format follows the replay transcripts of t3code's provider testing
// (github.com/pingdotgg/t3code, packages/provider-testing/src/replayTranscript.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92), format ideas only.

import { RuntimeMode } from "@cairn/protocol/Policy";
import { Result, Schema } from "effect";

const { Json } = Schema;

const PathSegment = Schema.Union([Schema.String, Schema.Int]);

const ToolCallLine = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Json),
});

/** Shared fields of every input line. */
const inputFields = {
  type: Schema.Literal("input"),
  requestId: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  image: Schema.optionalKey(Schema.Boolean),
  whenBusy: Schema.optionalKey(
    Schema.Literals(["steer", "followUp", "reject"])
  ),
  decision: Schema.optionalKey(
    Schema.Literals(["accept", "accept_for_thread", "decline"])
  ),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  reason: Schema.optionalKey(Schema.String),
  expect: Schema.optionalKey(
    Schema.Struct({
      error: Schema.optionalKey(Schema.String),
      withdrawn: Schema.optionalKey(Schema.Boolean),
      sameSubmissionAs: Schema.optionalKey(Schema.String),
      sameConversation: Schema.optionalKey(Schema.Boolean),
    })
  ),
};

/** One transcript line. */
export const TranscriptLine = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("transcript_start"),
    scenario: Schema.String,
    version: Schema.Literal(1),
  }),
  Schema.Struct({
    type: Schema.Literal("model"),
    label: Schema.String,
    hold: Schema.optionalKey(Schema.Boolean),
    text: Schema.optionalKey(Schema.String),
    toolCalls: Schema.optionalKey(Schema.Array(ToolCallLine)),
    stopReason: Schema.optionalKey(
      Schema.Literals(["stop", "toolUse", "error"])
    ),
    errorMessage: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...inputFields,
    step: Schema.Literals([
      "ensure",
      "ensure_race",
      "subscribe",
      "configure",
      "message",
      "steer",
      "follow_up",
      "stop",
      "stop_clear",
      "withdraw",
      "respond",
      "compact",
      "restart",
    ]),
  }),
  Schema.Struct({ type: Schema.Literal("crash") }),
  Schema.Struct({ type: Schema.Literal("release"), label: Schema.String }),
  Schema.Struct({ type: Schema.Literal("settle"), ms: Schema.Int }),
  Schema.Struct({
    type: Schema.Literal("expect_event"),
    event: Schema.Record(Schema.String, Json),
  }),
  Schema.Struct({
    type: Schema.Literal("expect_event_count"),
    event: Schema.Record(Schema.String, Json),
    count: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("expect_view"),
    path: Schema.Array(PathSegment),
    equals: Json,
  }),
]);

export type TranscriptLine = typeof TranscriptLine.Type;

/** A model line. */
export type ModelLine = Extract<TranscriptLine, { readonly type: "model" }>;

/** An input line. */
export type InputLine = Extract<TranscriptLine, { readonly type: "input" }>;

/** A parsed scenario. */
export interface Scenario {
  readonly name: string;
  readonly lines: ReadonlyArray<TranscriptLine>;
}

/** A transcript that does not parse. */
export class TranscriptError extends Schema.TaggedError<TranscriptError>()(
  "TranscriptError",
  { message: Schema.String, line: Schema.Int }
) {}

const decodeLine = Schema.decodeUnknownResult(
  Schema.fromJsonString(TranscriptLine)
);

/** Parses NDJSON text into a scenario. */
export const parseTranscript = (
  text: string
): Result.Result<Scenario, TranscriptError> => {
  const lines: Array<TranscriptLine> = [];
  const raw = text.split("\n").filter((line) => line.trim() !== "");

  for (const [index, line] of raw.entries()) {
    const decoded = decodeLine(line);

    if (Result.isFailure(decoded)) {
      return Result.fail(
        new TranscriptError({
          message: `Line ${index + 1} is not a transcript line: ${decoded.failure.message}`,
          line: index + 1,
        })
      );
    }

    lines.push(decoded.success);
  }

  const [first] = lines;

  if (first?.type !== "transcript_start") {
    return Result.fail(
      new TranscriptError({
        message: "A transcript starts with a transcript_start line.",
        line: 1,
      })
    );
  }

  return Result.succeed({ name: first.scenario, lines });
};
