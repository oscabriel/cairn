// The brief a `subagent_spawn` call proposes (ADR 0030): built from the call's flat arguments,
// frozen into its approval record as plain JSON, and read back from that record when Go starts the
// child, so the child's first input is the approved brief and never the call's own arguments.
//
// A result schema is checked when the brief is asked (`checkResultSchema`), so a schema the result
// tool cannot hold a child to comes back to the parent at once, naming what to change. A role must
// be a role or a model by its form here; whether it resolves is the tool's check at the ask, and
// the start task resolves it again at Go (ADR 0035).

import { Brief } from "@cairn/protocol/Policy";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import { RoleSpec } from "@cairn/protocol/Roles";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { Option, Result, Schema } from "effect";

import { SubagentToolText } from "../brain/SubagentText.ts";
import { checkResultSchema } from "../models/ResultTool.ts";
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
  /** A role (`@worker`) or `provider/modelId[:level]` the child runs on; none for the parent's. */
  readonly role: Option.Option<string>;
}

const encodeBrief = Schema.encodeSync(Brief);

const decodeBrief = Schema.decodeUnknownOption(Brief);

const decodeRoleSpec = Schema.decodeOption(RoleSpec);

/**
 * The brief a spawn proposes, in `mode` (the parent's effective mode, which a child never widens);
 * fails with the text the model reads when `result_schema` is not a JSON Schema object.
 */
export const briefOf = (
  args: SpawnArguments,
  mode: RuntimeMode
): Result.Result<Brief, string> => {
  const schema = Option.map(args.resultSchema, jsonRecordOf);

  const role = Option.map(args.role, (text) => text.trim());
  const spec = Option.flatMap(role, decodeRoleSpec);

  if (Option.isSome(role) && Option.isNone(spec)) {
    return Result.fail(SubagentToolText.roleInvalid(role.value));
  }

  if (Option.isSome(schema) && schema.value === null) {
    return Result.fail(SubagentToolText.resultSchemaNotObject);
  }

  // A schema the result tool cannot hold the child to is refused now, while the parent can fix
  // it, rather than at the child's first request (2E's rule).
  for (const named of Option.toArray(
    Option.flatMap(schema, Option.fromNullOr)
  )) {
    const checked = checkResultSchema(named);

    if (Result.isFailure(checked)) {
      return Result.fail(checked.failure.message);
    }
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
    role: Option.getOrNull(spec),
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
