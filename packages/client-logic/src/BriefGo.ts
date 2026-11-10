// What the brief card says about Go (plan wave 6, 6B; briefs note section 4; ADR 0043): the models
// a subagent's brief or a workflow's launch names, what each resolves to now by `models.check`,
// whether Go is blocked and why in plain words, and which of Send back and Run on 1 first a request
// takes. Pure, so the card's view draws only what this decides and its tests judge the words.
//
// - A child that names no model runs on its parent's model and level, so nothing is asked about
//   it.
// - A named model that does not resolve blocks Go (and Run on 1 first): a spec that is not
//   `provider/modelId[:level]`, or a model that is not in the catalog, has no usable credential, is
//   at its plan limit or whose provider is failing. Go would start nothing then (the brain checks
//   again at Go and tells the parent so), so the card says why and what to do instead.
// - Send back is for a subagent's brief (its parent writes a new brief from the notes) and a
//   workflow's launch (its model proposes the script again, 6F). A node's own brief has no one to
//   revise it (the record refuses it).
// - Run on 1 first is a workflow's launch's only (ADR 0032), and only when there is more than one
//   node to run: with one node it is Go.
// - A changed budget travels with Go on a subagent's brief or a workflow's launch (ADR 0047).

import type { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import { ModelCheck } from "@cairn/protocol/ModelSpecs";
import type {
  ApprovalRecord,
  Brief,
  WorkflowLaunch,
} from "@cairn/protocol/Policy";
import type { Budget } from "@cairn/protocol/Spend";
import { Match, Option, Schema } from "effect";

import { RequestBody } from "./PendingRequests.ts";

/** The tool whose briefs start a subagent at Go, and so take Send back. */
export const SPAWN_TOOL = "subagent_spawn";

/** `provider/modelId`. */
export const modelText = (model: ModelRef): string =>
  `${model.provider}/${model.modelId}`;

/**
 * The model a goal's model judge runs on, in words: the spec it names, or "this thread's" when it
 * names none and runs on the goal thread's model.
 */
export const judgeModelText = (spec: string | null): string =>
  spec ?? "this thread's";

/** The levels a spec may end in. */
const LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** A named spec in words: "opencode-go/gpt-6-luna at high" for `opencode-go/gpt-6-luna:high`. */
export const namedSpecText = (spec: string): string => {
  const colon = spec.lastIndexOf(":");
  const tail = colon === -1 ? "" : spec.slice(colon + 1);

  return LEVELS.has(tail) ? `${spec.slice(0, colon)} at ${tail}` : spec;
};

/** What the card asks `models.check` about one request: the specs, each once, in order. */
export interface ModelQuestion {
  readonly specs: ReadonlyArray<string>;
}

/** The named specs among `specs`, each once: blanks dropped. */
const namedSpecs = (specs: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(specs.filter((spec) => spec.trim() !== "")),
];

const questionOf = (
  specs: ReadonlyArray<string>
): Option.Option<ModelQuestion> => {
  const named = namedSpecs(specs);

  return named.length === 0 ? Option.none() : Option.some({ specs: named });
};

/** The spec a brief's child runs on: the model it names; none for the parent's. */
export const briefSpec = (brief: Brief): Option.Option<string> =>
  Option.fromNullOr(brief.model);

const launchQuestion = (launch: WorkflowLaunch): Option.Option<ModelQuestion> =>
  questionOf([
    ...launch.callSites.map((site) => site.spec),
    ...launch.envelope.models.map((entry) => entry.spec),
  ]);

/** The tools whose briefs are a workflow node's own (raised when it falls outside its envelope). */
export const NODE_BRIEF_TOOLS: ReadonlySet<string> = new Set([
  "agent",
  "verify",
]);

/** What to ask `models.check` for a request; none when it names no model (it runs on its parent's). */
export const modelQuestionOf = (
  record: Pick<ApprovalRecord, "tool">,
  body: RequestBody
): Option.Option<ModelQuestion> =>
  RequestBody.$match(body, {
    Brief: ({ payload }) => {
      if (payload.type === "workflow") {
        return launchQuestion(payload);
      }

      return record.tool === SPAWN_TOOL || NODE_BRIEF_TOOLS.has(record.tool)
        ? questionOf(Option.toArray(briefSpec(payload)))
        : Option.none();
    },
    Approval: () => Option.none(),
    Question: () => Option.none(),
    Criteria: () => Option.none(),
  });

/** The tool of a workflow's launch approval. */
export const LAUNCH_TOOL = "workflow_plan";

/** Whether a request takes Send back: a subagent's brief, or a workflow's launch. */
export const takesSendBack = (
  record: Pick<ApprovalRecord, "kind" | "tool">,
  body: RequestBody
): boolean =>
  record.kind === "brief" &&
  RequestBody.$is("Brief")(body) &&
  ((record.tool === SPAWN_TOOL && body.payload.type === "brief") ||
    (record.tool === LAUNCH_TOOL && body.payload.type === "workflow"));

/** Whether a request takes Run on 1 first: a workflow's launch with more than one node. */
export const takesRunOnOne = (body: RequestBody): boolean =>
  RequestBody.$is("Brief")(body) &&
  body.payload.type === "workflow" &&
  (body.payload.nodes.unbounded || body.payload.nodes.count > 1);

/**
 * Whether a request's Go may carry a changed budget (ADR 0047): a subagent's brief or a workflow's
 * launch. A node's own brief is bounded by its workflow's budget.
 */
export const takesBudgetEdit = (
  record: Pick<ApprovalRecord, "kind" | "tool">,
  body: RequestBody
): boolean =>
  record.kind === "brief" &&
  RequestBody.$is("Brief")(body) &&
  (body.payload.type === "workflow" || record.tool === SPAWN_TOOL);

/** The budget a brief or a launch proposes: the brief's own, or the launch's envelope's. */
export const proposedBudgetOf = (payload: Brief | WorkflowLaunch): Budget =>
  payload.type === "workflow" ? payload.envelope.budget : payload.budget;

/** Why Go is blocked, in the card's words. */
export interface GoBlock {
  /** The spec that blocks it. */
  readonly spec: string;
  readonly title: string;
  readonly detail: string;
}

/** A check's resolution as a tagged union, to match on. */
export const Resolution = ModelCheck.fields.resolution.pipe(
  Schema.toTaggedUnion("_tag")
);

type Unresolved = Extract<
  ModelCheck["resolution"],
  { readonly _tag: "Unresolved" }
>;

/** Why a named model is not ready, in the words the card ends its title with. */
const NOT_READY_WORDS: Readonly<
  Record<Exclude<Unresolved["reason"], "invalid_spec">, string>
> = {
  unknown_model: "it is not in the model catalog",
  missing_credential: "its provider has no usable credential",
  limited: "its plan limit is reached",
  failing: "its provider is failing",
};

/** The words for one spec that does not resolve. */
const blockOf = (spec: string, unresolved: Unresolved): GoBlock =>
  Match.value(unresolved.reason).pipe(
    Match.when("invalid_spec", () => ({
      spec,
      title: `Go is blocked: ${spec} is not a model (provider/modelId).`,
      detail: "Send it back for one that names a model, or none.",
    })),
    Match.orElse((reason) => ({
      spec,
      title: `Go is blocked: ${spec} is not ready, as ${NOT_READY_WORDS[reason]}.`,
      detail: "Check again once it is ready, or send it back.",
    }))
  );

/** The first spec that blocks Go, with why; none when every spec resolves. */
export const goBlockOf = (
  checks: ReadonlyArray<ModelCheck>
): Option.Option<GoBlock> =>
  Option.fromUndefinedOr(
    checks.flatMap((check) =>
      Resolution.match(check.resolution, {
        Resolved: () => [],
        Unresolved: (unresolved) => [blockOf(check.spec, unresolved)],
      })
    )[0]
  );

const UNRESOLVED_WORDS: Readonly<Record<Unresolved["reason"], string>> = {
  invalid_spec: "not a model",
  unknown_model: "not in the catalog",
  missing_credential: "no usable credential",
  limited: "at its plan limit",
  failing: "provider failing",
};

/** A model and level in words: `opencode-go/gpt-6-luna at high`. */
export const modelAtText = (
  model: ModelRef,
  level: Option.Option<ThinkingLevel>
): string =>
  Option.match(level, {
    onNone: () => modelText(model),
    onSome: (found) => `${modelText(model)} at ${found}`,
  });

/**
 * What one named spec runs on now, for the card's "Runs on" line: `opencode-go/gpt-6-luna at
 * high`, or the spec and why it does not resolve.
 */
export const runsOnText = (check: ModelCheck): string =>
  Resolution.match(check.resolution, {
    Unresolved: ({ reason }) => `${check.spec}: ${UNRESOLVED_WORDS[reason]}`,
    Resolved: ({ resolved }) =>
      modelAtText(resolved.model, Option.fromNullOr(resolved.thinkingLevel)),
  });

/** Every spec's "Runs on" text, joined. */
export const runsOnLine = (checks: ReadonlyArray<ModelCheck>): string =>
  checks.map(runsOnText).join("; ");

/** What the "Runs on" line says for a request that names no model: it runs on its parent's. */
export const PARENT_MODEL_TEXT = "The parent thread's model";
