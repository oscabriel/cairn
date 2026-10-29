// The brief a `subagent_spawn` call proposes (ADR 0030): built from the call's flat arguments,
// frozen into its approval record as plain JSON, and read back from that record when Go starts the
// child, so the child's first input is the approved brief and never the call's own arguments.
//
// Spawning asks no role resolution yet: the brief names no role and the child runs on its parent's
// model. The brief tool with roles, its card and expiry come with the briefs package (4A), which
// gates the start where `Subagents` reads the accepted record.

import { Brief } from "@cairn/protocol/Policy";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { Option, Result, Schema } from "effect";

import { SubagentToolText } from "../brain/SubagentText.ts";
import { jsonRecordOf } from "./SubagentDocs.ts";
import type { JsonRecord } from "./SubagentDocs.ts";

/** What `subagent_spawn` was called with, after its flat arguments are read. */
export interface SpawnArguments {
  readonly description: string;
  readonly brief: string;
  readonly why: Option.Option<string>;
  readonly isolation: Option.Option<string>;
  readonly resultSchema: Option.Option<JsonRecord>;
  readonly wake: Option.Option<string>;
}

const encodeBrief = Schema.encodeSync(Brief);

const decodeBrief = Schema.decodeUnknownOption(Brief);

/**
 * The brief a spawn proposes, in `mode` (the parent's effective mode, which a child never widens);
 * fails with the text the model reads when `result_schema` is not a JSON Schema object.
 */
export const briefOf = (
  args: SpawnArguments,
  mode: RuntimeMode
): Result.Result<Brief, string> => {
  const schema = Option.map(args.resultSchema, jsonRecordOf);

  if (Option.isSome(schema) && schema.value === null) {
    return Result.fail(SubagentToolText.resultSchemaNotObject);
  }

  return Result.succeed({
    type: "brief",
    title: args.description,
    task: args.brief,
    why: Option.getOrElse(args.why, () => ""),
    avoid: [],
    doneWhen: [
      { text: "The parent accepts the result.", judge: { kind: "user" } },
    ],
    workspace: Option.contains(args.isolation, "worktree")
      ? "worktree"
      : "shared",
    base: null,
    writes: [],
    role: null,
    model: null,
    thinking: null,
    mode,
    mayCommit: false,
    budget: DEFAULT_BUDGET,
    resultSchema: Option.getOrNull(Option.flatMap(schema, Option.fromNullOr)),
    wake: Option.contains(args.wake, "quiet") ? "quiet" : "answer",
    decisions: [],
  });
};

/** A brief as its approval record's payload holds it: plain JSON. */
export const briefPayload = (brief: Brief): JsonRecord | null =>
  jsonRecordOf(encodeBrief(brief));

/** The brief a record's payload froze; none when it holds no brief. */
export const briefOfPayload = (
  payload: JsonRecord | null
): Option.Option<Brief> =>
  payload === null ? Option.none() : decodeBrief(payload);
