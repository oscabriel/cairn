// The workflow prelude (ADR 0012 as amended): fixed JavaScript that gives a workflow script
// `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, `args`, `verify` and `approve` over
// the nested node tools (`tools.workflow_begin`, `tools.agent`, ...). The gate's `beforeTool` hook
// rewrites an approved script with `rewriteScript` once; pi-durable stores the rewritten source in
// the call's start data, so a workflow replays with the prelude it started with even after Cairn
// upgrades. `PRELUDE_VERSION` names this text.
//
// The rewrite keeps every line of the script on its line: the constants and the call to
// `workflow_begin` take the place of the `export` keyword, the body runs inside one async function
// so unawaited `phase()` and `log()` calls finish before the script returns, and the prelude's
// functions follow the body, where their declarations hoist. A call site is therefore the script's
// own `line:column`, read from the stack inside `agent`, the dry run's table and the ledger agree on
// it, and an error's line is the line the model wrote.
//
// The semantics are Claude Code's workflow script API (research 06 section 2.5): `agent` resolves
// with the value or `null` when its node was stopped, refused or failed; `parallel` is a barrier
// whose failed thunks become `null`; `pipeline` has no barrier between stages and a stage that
// throws drops its item to `null`; at most 4,096 items per call, more is an error, never a cut.
// `budget.spent()` and `.remaining()` are nested calls, so a replay reads what the live run read.

import { NonNegativeInt } from "@cairn/protocol/Ids";
import { MAX_ITEMS_PER_CALL } from "@cairn/protocol/Workflows";
import { Option, Schema } from "effect";

import type { WorkflowScript } from "./WorkflowScript.ts";

/** The version of `PRELUDE_SOURCE`; bump it with any change to the text. */
export const PRELUDE_VERSION = 1;

/** The nested tools the prelude calls, all `callers: ["tools"]`. */
export const NODE_TOOLS = [
  "workflow_begin",
  "agent",
  "verify",
  "approve",
  "phase",
  "log",
  "budget",
] as const;

/** The start of the error `parallel` and `pipeline` throw past `MAX_ITEMS_PER_CALL` items. */
export const TOO_MANY_ITEMS = "Too many items";

/** The role a node runs as when the script names none. */
export const DEFAULT_NODE_ROLE = "@worker";

/** `agent` options the prelude passes on; any other key is reported in `unknownOptions`. */
export const AGENT_OPTIONS: ReadonlyArray<string> = [
  "label",
  "phase",
  "role",
  "schema",
  "key",
  "readonly",
  "resume",
  "effort",
];

/** `tools.workflow_begin`'s argument: the first call of every rewritten script. */
export const BeginCall = Schema.Struct({
  workflowId: Schema.String,
  scriptHash: Schema.String,
  preludeVersion: NonNegativeInt,
});

export type BeginCall = typeof BeginCall.Type;

/**
 * `tools.agent`'s argument, built by the prelude from `agent(prompt, opts)`. `role` and `schema`
 * are passed as written; the node tool and the dry run check them.
 */
export const AgentCall = Schema.Struct({
  workflowId: Schema.String,
  prompt: Schema.String,
  /** `line:column` of the script's call, or null when the stack showed none. */
  site: Schema.OptionFromNullOr(Schema.String),
  label: Schema.OptionFromNullOr(Schema.String),
  /** `opts.phase`, else the title of the last `phase()` call. */
  phase: Schema.OptionFromNullOr(Schema.String),
  role: Schema.OptionFromNullOr(Schema.String),
  schema: Schema.OptionFromNullOr(Schema.Json),
  key: Schema.OptionFromNullOr(Schema.String),
  readonly: Schema.Boolean,
  /** A settled node's id to send a further input to. */
  resume: Schema.OptionFromNullOr(Schema.String),
  effort: Schema.OptionFromNullOr(Schema.String),
  /** Option keys the prelude does not know, so a node tool can refuse rather than ignore them. */
  unknownOptions: Schema.Array(Schema.String),
});

export type AgentCall = typeof AgentCall.Type;

/** `tools.verify`'s argument: check one result against a claim in a fresh child. */
export const VerifyCall = Schema.Struct({
  workflowId: Schema.String,
  result: Schema.Json,
  claim: Schema.OptionFromNullOr(Schema.String),
  site: Schema.OptionFromNullOr(Schema.String),
  label: Schema.OptionFromNullOr(Schema.String),
  phase: Schema.OptionFromNullOr(Schema.String),
  role: Schema.OptionFromNullOr(Schema.String),
});

export type VerifyCall = typeof VerifyCall.Type;

/** `tools.approve`'s argument: the only way a script asks the user. */
export const ApproveCall = Schema.Struct({
  workflowId: Schema.String,
  summary: Schema.String,
  options: Schema.OptionFromNullOr(Schema.Array(Schema.String)),
});

export type ApproveCall = typeof ApproveCall.Type;

/** What `tools.approve` answers and `approve()` resolves with; null in the script when it fails. */
export const ApproveAnswer = Schema.Struct({
  accepted: Schema.Boolean,
  /** The option the user picked, when the request offered options. */
  choice: Schema.NullOr(Schema.String),
});

export type ApproveAnswer = typeof ApproveAnswer.Type;

/** `tools.phase`'s argument. */
export const PhaseCall = Schema.Struct({
  workflowId: Schema.String,
  title: Schema.String,
});

export type PhaseCall = typeof PhaseCall.Type;

/** `tools.log`'s argument. */
export const LogCall = Schema.Struct({
  workflowId: Schema.String,
  text: Schema.String,
});

export type LogCall = typeof LogCall.Type;

/** `tools.budget`'s argument. */
export const BudgetCall = Schema.Struct({ workflowId: Schema.String });

export type BudgetCall = typeof BudgetCall.Type;

/** What `tools.budget` answers: tokens spent, and what is left (null with no token ceiling). */
export const BudgetReading = Schema.Struct({
  spent: NonNegativeInt,
  remaining: Schema.NullOr(NonNegativeInt),
});

export type BudgetReading = typeof BudgetReading.Type;

/** How a node ended, as `tools.agent` and `tools.verify` answer and `agent.full` resolves. */
export const NodeOutcome = Schema.Struct({
  status: Schema.Literals(["ok", "failed", "stopped", "refused"]),
  /** The validated value, the final text without a schema; null unless `ok`. */
  value: Schema.Json,
  reason: Schema.NullOr(Schema.String),
  nodeId: Schema.NullOr(Schema.String),
});

export type NodeOutcome = typeof NodeOutcome.Type;

/** A node's result schema must be a JSON Schema whose root is an object. */
export const isObjectRootSchema = Schema.is(
  Schema.Struct({ type: Schema.Literal("object") })
);

/**
 * The prelude's functions, appended after the script's body. Plain ES2023 for QuickJS, no
 * template literals, so it can sit in a TypeScript template string unchanged.
 */
export const PRELUDE_SOURCE = `/* Cairn workflow prelude v${PRELUDE_VERSION} */
function __cairnSite() {
  var lines = String(new Error().stack || "").split("\\n");
  for (var i = 0; i < lines.length; i++) {
    var m = /codemode\\.js:(\\d+):(\\d+)/.exec(lines[i]);
    if (m && Number(m[1]) < __cairnPreludeLine) return m[1] + ":" + m[2];
  }
  return null;
}
function __cairnText(value) {
  return value === undefined || value === null ? null : String(value);
}
function __cairnMessage(error) {
  return error && error.message ? String(error.message) : String(error);
}
function __cairnFreeze(value) {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(__cairnFreeze);
    Object.freeze(value);
  }
  return value;
}
function __cairnQuiet(promise) {
  var settled = promise.then(function () { return undefined; }, function () { return undefined; });
  __cairnPending.push(settled);
  return settled;
}
async function __cairnRun(body) {
  try {
    return await body();
  } finally {
    await Promise.all(__cairnPending);
  }
}
function __cairnCheckItems(name, items) {
  if (!Array.isArray(items)) throw new TypeError(name + "() takes an array");
  if (items.length > ${MAX_ITEMS_PER_CALL}) {
    throw new RangeError("${TOO_MANY_ITEMS}: " + name + "() takes at most ${MAX_ITEMS_PER_CALL} items and got " + items.length + "; split the list.");
  }
}
function __cairnOptions(name, opts) {
  if (opts === undefined || opts === null) return {};
  if (typeof opts !== "object" || Array.isArray(opts)) throw new TypeError(name + "(): options must be an object");
  return opts;
}
async function __cairnAgentFull(prompt, opts) {
  var o = __cairnOptions("agent", opts);
  if (typeof prompt !== "string" || prompt.trim() === "") throw new TypeError("agent(prompt): prompt must be a non-empty string");
  var known = ${JSON.stringify(AGENT_OPTIONS)};
  var call = {
    workflowId: WORKFLOW,
    prompt: prompt,
    site: __cairnSite(),
    label: __cairnText(o.label),
    phase: o.phase === undefined || o.phase === null ? __cairnPhase : String(o.phase),
    role: __cairnText(o.role),
    schema: o.schema === undefined ? null : o.schema,
    key: __cairnText(o.key),
    readonly: o.readonly === true,
    resume: __cairnText(o.resume),
    effort: __cairnText(o.effort),
    unknownOptions: Object.keys(o).filter(function (k) { return known.indexOf(k) === -1; })
  };
  try {
    return await tools.agent(call);
  } catch (error) {
    var reason = __cairnMessage(error);
    return { status: /aborted/.test(reason) ? "stopped" : "failed", value: null, reason: reason, nodeId: null };
  }
}
async function agent(prompt, opts) {
  var outcome = await __cairnAgentFull(prompt, opts);
  return outcome && outcome.status === "ok" ? outcome.value : null;
}
async function verify(result, opts) {
  var o = __cairnOptions("verify", opts);
  try {
    var outcome = await tools.verify({
      workflowId: WORKFLOW,
      result: result === undefined ? null : result,
      claim: __cairnText(o.claim),
      site: __cairnSite(),
      label: __cairnText(o.label),
      phase: o.phase === undefined || o.phase === null ? __cairnPhase : String(o.phase),
      role: __cairnText(o.role)
    });
    if (outcome && outcome.status === "ok") return outcome.value;
    return { verdict: "unverified", reason: outcome ? outcome.reason : null };
  } catch (error) {
    return { verdict: "unverified", reason: __cairnMessage(error) };
  }
}
async function approve(request) {
  var o = __cairnOptions("approve", request);
  try {
    return await tools.approve({
      workflowId: WORKFLOW,
      summary: String(o.summary),
      options: Array.isArray(o.options) ? o.options.map(String) : null
    });
  } catch (error) {
    return null;
  }
}
async function parallel(thunks) {
  __cairnCheckItems("parallel", thunks);
  return await Promise.all(thunks.map(async function (thunk) {
    try {
      return await thunk();
    } catch (error) {
      return null;
    }
  }));
}
async function pipeline(items) {
  var stages = Array.prototype.slice.call(arguments, 1);
  __cairnCheckItems("pipeline", items);
  var taken = items;
  if (SAMPLE !== null && items.length > SAMPLE) {
    taken = items.slice(0, SAMPLE);
    log("Run on " + SAMPLE + " first: pipeline() took " + SAMPLE + " of " + items.length + " items and left the rest.");
  }
  return await Promise.all(taken.map(async function (item, index) {
    var value = item;
    for (var s = 0; s < stages.length; s++) {
      try {
        value = await stages[s](value, item, index);
      } catch (error) {
        return null;
      }
    }
    return value;
  }));
}
function phase(title) {
  __cairnPhase = String(title);
  return __cairnQuiet(tools.phase({ workflowId: WORKFLOW, title: __cairnPhase }));
}
function log(message) {
  return __cairnQuiet(tools.log({ workflowId: WORKFLOW, text: String(message) }));
}
function __cairnBudget(total) {
  return Object.freeze({
    total: total,
    spent: async function () {
      return (await tools.budget({ workflowId: WORKFLOW })).spent;
    },
    remaining: async function () {
      var reading = await tools.budget({ workflowId: WORKFLOW });
      return reading.remaining === null ? Infinity : reading.remaining;
    }
  });
}
`;

/** What the gate bakes into a script it lets run. */
export interface PreludeBake {
  /** The approved workflow's id (`wf-<task id>`). */
  readonly workflowId: string;
  /** Run on N first: `pipeline` takes this many items; none runs on all. */
  readonly sample: Option.Option<number>;
  /** The token ceiling `budget.total` reports; none when the budget has no token limit. */
  readonly budgetTokens: Option.Option<number>;
  /** The launch arguments, plain JSON; frozen inside the script. */
  readonly args: Schema.Json;
}

/** The number of line breaks in `text`. */
const breaks = (text: string) => text.split("\n").length - 1;

/**
 * The script as code mode runs it: the prelude's constants and `workflow_begin` where `export`
 * stood, the body wrapped so pending `phase()` and `log()` calls finish, the prelude after it.
 * Every line of the script keeps its number. Deterministic: the same script and bake give the
 * same text, which the replay of a stored call relies on.
 */
export const rewriteScript = (
  script: WorkflowScript,
  bake: PreludeBake
): string => {
  const before = script.source.slice(0, script.exportAt);
  // Drop `export`, keep `const meta = ...` and everything after it as written.
  const body = script.source.slice(script.exportAt + "export".length);

  const begin = JSON.stringify({
    workflowId: bake.workflowId,
    scriptHash: script.hash,
    preludeVersion: PRELUDE_VERSION,
  });

  // The opening adds no line break, so the prelude starts on the line after the closing `});`.
  const preludeLine = breaks(`${before}${body}\n});\n`) + 1;

  const constants = [
    `const WORKFLOW = ${JSON.stringify(bake.workflowId)}`,
    `SAMPLE = ${JSON.stringify(Option.getOrNull(bake.sample))}`,
    `__cairnPreludeLine = ${preludeLine}`,
    `__cairnPending = []`,
    `args = __cairnFreeze(${JSON.stringify(bake.args)})`,
    `budget = __cairnBudget(${JSON.stringify(Option.getOrNull(bake.budgetTokens))})`,
  ].join(", ");

  const opening = `${constants}; let __cairnPhase = null; agent.full = __cairnAgentFull; await tools.workflow_begin(${begin}); return await __cairnRun(async () => {`;

  return `${before}${opening}${body}\n});\n${PRELUDE_SOURCE}`;
};
