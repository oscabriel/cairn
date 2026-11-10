// The brief a `subagent_spawn` call proposes (ADR 0030): built from the call's flat arguments,
// frozen into its approval record as plain JSON, and read back from that record when Go starts the
// child, so the child's first input is the approved brief and never the call's own arguments.
//
// A result schema is checked when the brief is asked (`checkResultSchema`), so a schema the result
// tool cannot hold a child to comes back to the parent at once, naming what to change. A model must
// be `provider/modelId[:level]` by its form here (ADR 0043); whether it is ready is the tool's check
// at the ask, and the start task checks it again at Go. The budget is what the
// call asks (`max_tokens`, `max_usd`) over the server's default, frozen with the rest (ADR 0047).
//
// How the result will be judged (`doneWhen`, ADR 0055): the command the parent names in
// `done_when`, frozen as a command criterion the card shows before Go and the child is told to run,
// or, without one, the parent accepting the result, which is no outside judge. Cairn does not run
// the command yet.

import { ModelSpec } from "@cairn/protocol/ModelSpecs";
import { Brief } from "@cairn/protocol/Policy";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import type { Budget } from "@cairn/protocol/Spend";
import { Option, Result, Schema } from "effect";

import type { ApprovalPayloadState } from "../brain/CairnDocs.ts";
import { jsonRecordOf, plainCopy } from "../brain/SubagentDocs.ts";
import type { JsonRecord } from "../brain/SubagentDocs.ts";
import { SubagentToolText } from "../brain/SubagentText.ts";
import { checkResultSchema } from "../models/ResultTool.ts";
import { budgetAsked } from "../usage/DefaultBudget.ts";

/** What `subagent_spawn` was called with, after its flat arguments are read. */
export interface SpawnArguments {
  readonly description: string;
  readonly brief: string;
  readonly why: Option.Option<string>;
  readonly isolation: Option.Option<string>;
  readonly resultSchema: Option.Option<JsonRecord>;
  readonly wake: Option.Option<string>;
  /** The `provider/modelId[:level]` the child runs on; none for the parent's model and level. */
  readonly model: Option.Option<string>;
  /** `done_when`: the command, as an argv list, that exits 0 once the work is done. */
  readonly doneWhen: Option.Option<ReadonlyArray<string>>;
  /** The token budget the call asks; none for the server's default (ADR 0047). */
  readonly maxTokens: Option.Option<number>;
  /** The list-price dollar budget the call asks; none for the server's default. */
  readonly maxUsd: Option.Option<number>;
}

/** How long a brief's `done_when` command may run, when something runs it. */
export const DONE_WHEN_TIMEOUT_SEC = 600;

/** What a brief says when the parent named no command: it accepts the result itself. */
export const PARENT_ACCEPTS = "The parent accepts the result.";

/** A brief's `doneWhen` from `done_when`; fails when it is not a command. */
const doneWhenOf = (
  argv: Option.Option<ReadonlyArray<string>>
): Result.Result<Brief["doneWhen"], string> => {
  if (Option.isNone(argv)) {
    return Result.succeed([{ text: PARENT_ACCEPTS, judge: { kind: "user" } }]);
  }

  const [first, ...rest] = argv.value;

  if (first === undefined || argv.value.some((part) => part.trim() === "")) {
    return Result.fail(SubagentToolText.doneWhenInvalid);
  }

  return Result.succeed([
    {
      text: `\`${argv.value.join(" ")}\` exits 0`,
      judge: {
        kind: "command",
        argv: [first, ...rest],
        expectExit: 0,
        timeoutSec: DONE_WHEN_TIMEOUT_SEC,
      },
    },
  ]);
};

const encodeBrief = Schema.encodeSync(Brief);

const decodeBrief = Schema.decodeUnknownOption(Brief);

const decodeModelSpec = Schema.decodeOption(ModelSpec);

/**
 * The brief a spawn proposes, in `mode` (the parent's effective mode, which a child never widens),
 * with the budget the call asks over `fallback`, the server's default (ADR 0047); fails with the
 * text the model reads when `result_schema` is not a JSON Schema object, or a budget it names is out
 * of range.
 */
export const briefOf = (
  args: SpawnArguments,
  mode: RuntimeMode,
  fallback: Budget
): Result.Result<Brief, string> => {
  const schema = Option.map(args.resultSchema, jsonRecordOf);

  const model = Option.map(args.model, (text) => text.trim());

  const spec = Option.flatMap(model, decodeModelSpec);

  if (Option.isSome(model) && Option.isNone(spec)) {
    return Result.fail(SubagentToolText.modelInvalid(model.value));
  }

  if (Option.isSome(schema) && schema.value === null) {
    return Result.fail(SubagentToolText.resultSchemaNotObject);
  }

  const doneWhen = doneWhenOf(args.doneWhen);

  if (Result.isFailure(doneWhen)) {
    return Result.fail(doneWhen.failure);
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

  const budget = budgetAsked(fallback, {
    maxTokens: args.maxTokens,
    maxUsd: args.maxUsd,
  });

  if (Result.isFailure(budget)) {
    return Result.fail(budget.failure);
  }

  return Result.succeed({
    type: "brief",
    title: args.description,
    task: args.brief,
    why: Option.getOrElse(args.why, () => ""),
    avoid: [],
    doneWhen: doneWhen.success,
    workspace: Option.contains(args.isolation, "worktree")
      ? "worktree"
      : "shared",
    base: null,
    writes: [],
    model: Option.getOrNull(spec),
    thinking: null,
    mode,
    mayCommit: false,
    budget: budget.success,
    resultSchema: Option.getOrNull(Option.flatMap(schema, Option.fromNullOr)),
    wake: Option.contains(args.wake, "quiet") ? "quiet" : "answer",
    decisions: [],
  });
};

/** A brief as its approval record's payload holds it. */
export const briefPayload = (brief: Brief): ApprovalPayloadState =>
  plainCopy(encodeBrief(brief));

/** The brief a record's payload froze; none when it holds no brief. */
export const briefOfPayload = (
  payload: Readonly<ApprovalPayloadState> | null
): Option.Option<Brief> =>
  payload === null ? Option.none() : decodeBrief(payload);

/** The model a brief names, as a spec; none when it names none and runs on its parent's. */
export const namedSpecOf = (brief: Brief): Option.Option<string> =>
  Option.fromNullOr(brief.model);
