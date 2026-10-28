// The dry run behind a workflow's launch card (ADR 0012 as amended, ADR 0032): the rewritten script
// runs in a QuickJS sandbox of its own whose node tools are stubs. Each `agent` or `verify` call
// resolves at once with a value built from its schema, and is recorded with its call site (the
// script's `line:column`), role, label, phase, schema name and whether it may write. The calls
// become the call-site table and the node count; a script that reaches the node cap is `unbounded`
// ("at least N, depends on the data"). Nothing outside the sandbox runs, no model is called, and a
// script the run refuses never reaches the user.
//
// `validate` is parse plus dry run, never a launch. The estimate multiplies each role's call count by
// the spread of that role's settled nodes in past ledgers, with a labelled fallback for a role with
// no history; it is a range and says what it rests on.

import { DisplayText } from "@cairn/protocol/Ids";
import { ThinkingLevel } from "@cairn/protocol/Models";
import { CallSite, Envelope, WorkflowLaunch } from "@cairn/protocol/Policy";
import type {
  NodeArms,
  RuntimeMode,
  WorkflowEstimate,
} from "@cairn/protocol/Policy";
import { RoleSpec } from "@cairn/protocol/Roles";
import type { RoleOverrides } from "@cairn/protocol/Roles";
import type { Budget } from "@cairn/protocol/Spend";
import { WIRE_STRING_LIMIT_BYTES } from "@cairn/protocol/Thread";
import {
  MAX_CONCURRENT_NODES,
  MAX_WORKFLOW_NODES,
} from "@cairn/protocol/Workflows";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { CodemodeResult, CodemodeTool } from "@earendil-works/pi-codemode";
import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";

import {
  AgentCall,
  ApproveCall,
  DEFAULT_NODE_ROLE,
  isObjectRootSchema,
  rewriteScript,
  TOO_MANY_ITEMS,
  VerifyCall,
} from "./Prelude.ts";
import type { ApproveAnswer, NodeOutcome } from "./Prelude.ts";
import { parseWorkflowScript, WorkflowRefusal } from "./WorkflowScript.ts";
import type { WorkflowScript } from "./WorkflowScript.ts";

/** The dry run could not run at all (the sandbox would not start). Nothing was decided; retry. */
export class DryRunUnavailable extends Schema.TaggedError<DryRunUnavailable>()(
  "DryRunUnavailable",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  }
) {}

/** How far a dry run may go before it stops. */
export interface DryRunLimits {
  /** Nodes recorded before the run stops and calls the script `unbounded`. */
  readonly nodeCap: number;
  /** Tool calls of any kind before the run stops; a script looping on `log` ends here. */
  readonly callCap: number;
  /** Wall time before the run is refused as not finishing. */
  readonly timeoutMs: number;
  /** The VM's memory. */
  readonly memoryLimitBytes: number;
}

/** The limits a dry run runs under unless a test sets others. */
export const DryRunLimits = Context.Reference<DryRunLimits>(
  "cairn/server/workflows/WorkflowPlan/DryRunLimits",
  {
    defaultValue: () => ({
      nodeCap: MAX_WORKFLOW_NODES,
      callCap: 20 * MAX_WORKFLOW_NODES,
      timeoutMs: 10_000,
      memoryLimitBytes: 64 * 1024 * 1024,
    }),
  }
);

/** What the dry run is given: what the launch would bake into the script. */
export interface PlanInput {
  /** The launch arguments, plain JSON, at most the wire's string limit when written out. */
  readonly args: Schema.Json;
  readonly budget: Budget;
  /** Run on N first; none runs on all. */
  readonly sample: Option.Option<number>;
}

/** The dry run's answer: the script, its call sites and how many nodes it dispatched. */
export interface DryRun {
  readonly script: WorkflowScript;
  /** In order of each site's first call. */
  readonly callSites: ReadonlyArray<CallSite>;
  /** Nodes dispatched; with `unbounded`, the run stopped at the cap and the real count is higher. */
  readonly nodes: { readonly count: number; readonly unbounded: boolean };
  /** Nodes per role spec, in order of each spec's first node: what the estimate multiplies. */
  readonly byRole: ReadonlyArray<{
    readonly spec: RoleSpec;
    readonly count: number;
  }>;
  /** Phases the run reached that `meta` does not declare, in order. */
  readonly undeclaredPhases: ReadonlyArray<string>;
  /** What the script wrote with `log()`, `text()` and `console.*`, for the card's fold. */
  readonly output: ReadonlyArray<string>;
}

/** One settled node of a past ledger: what its role spent. */
export interface NodeHistory {
  readonly spec: string;
  readonly totalTokens: number;
  /** None when its model has no list price (ADR 0036). */
  readonly listMicros: Option.Option<number>;
}

/** Settled nodes per role an estimate reads, newest last. */
export const HISTORY_WINDOW = 20;

/** Tokens a node of a role with no history is assumed to use, low and high. */
export const FALLBACK_NODE_TOKENS = { low: 20_000, high: 100_000 } as const;

/** Above this many nodes, or this many estimated tokens, the card says "Large workflow". */
export const LARGE_WORKFLOW = { nodes: 25, tokens: 1_500_000 } as const;

/** What `toLaunch` needs besides the dry run. */
export interface LaunchInput {
  readonly workflowId: string;
  readonly scriptRef: string;
  readonly args: Schema.Json;
  readonly budget: Budget;
  readonly estimate: Option.Option<WorkflowEstimate>;
  readonly roleOverrides: RoleOverrides;
  /** The envelope's node cap; none takes the dry run's count, or the workflow cap when unbounded. */
  readonly maxNodes: Option.Option<number>;
  readonly modes: ReadonlyArray<RuntimeMode>;
  readonly writes: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------------------------
// The recorder: the stub node tools and what they saw.

const decodeAgentCall = Schema.decodeUnknownOption(AgentCall);

const decodeVerifyCall = Schema.decodeUnknownOption(VerifyCall);

const decodeApproveCall = Schema.decodeUnknownOption(ApproveCall);

const decodeRoleSpec = Schema.decodeUnknownOption(RoleSpec);

const isThinkingLevel = Schema.is(ThinkingLevel);

const isDisplayText = Schema.is(DisplayText);

const ARMS: NodeArms = "host";

/** Longest label a call site shows; a prompt used as the label is cut here. */
const LABEL_MAX = 80;

/** The parts of a JSON Schema the dry run reads to build a placeholder value. */
interface SchemaNode {
  readonly const?: Schema.Json;
  readonly default?: Schema.Json;
  readonly enum?: ReadonlyArray<Schema.Json>;
  readonly examples?: ReadonlyArray<Schema.Json>;
  readonly anyOf?: ReadonlyArray<SchemaNode>;
  readonly oneOf?: ReadonlyArray<SchemaNode>;
  readonly type?: string | ReadonlyArray<string>;
  readonly properties?: { readonly [key: string]: SchemaNode };
  readonly items?: SchemaNode;
  readonly minItems?: number;
  readonly minimum?: number;
  readonly title?: string;
}

const SchemaNode: Schema.Codec<SchemaNode> = Schema.Struct({
  const: Schema.optionalKey(Schema.Json),
  default: Schema.optionalKey(Schema.Json),
  enum: Schema.optionalKey(Schema.Array(Schema.Json)),
  examples: Schema.optionalKey(Schema.Array(Schema.Json)),
  anyOf: Schema.optionalKey(Schema.Array(Schema.suspend(() => SchemaNode))),
  oneOf: Schema.optionalKey(Schema.Array(Schema.suspend(() => SchemaNode))),
  type: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Array(Schema.String)])
  ),
  properties: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.suspend(() => SchemaNode)
    )
  ),
  items: Schema.optionalKey(Schema.suspend(() => SchemaNode)),
  minItems: Schema.optionalKey(Schema.Finite),
  minimum: Schema.optionalKey(Schema.Finite),
  title: Schema.optionalKey(Schema.String),
});

const decodeSchemaNode = Schema.decodeUnknownOption(SchemaNode);

/** The first type a node names that is not `null`. */
const typeOf = (node: SchemaNode) =>
  Predicate.isString(node.type)
    ? node.type
    : node.type?.find((entry) => entry !== "null");

/** A placeholder for a node whose type alone decides it. */
const stubOfType = (
  node: SchemaNode,
  depth: number,
  stubOf: (inner: SchemaNode, depth: number) => Schema.Json
): Schema.Json => {
  switch (typeOf(node) ?? "null") {
    case "object": {
      return Object.fromEntries(
        Object.entries(node.properties ?? {}).map(([key, property]) => [
          key,
          stubOf(property, depth + 1),
        ])
      );
    }

    case "array": {
      const count = Math.min(3, Math.max(1, Math.floor(node.minItems ?? 1)));
      const { items } = node;

      return Arr.makeBy(count, () =>
        items === undefined ? null : stubOf(items, depth + 1)
      );
    }

    case "string": {
      return "(dry run)";
    }

    case "integer":
    case "number": {
      return node.minimum ?? 0;
    }

    case "boolean": {
      return false;
    }

    default: {
      return null;
    }
  }
};

/** A value that satisfies `node` well enough for the script to go on with it. */
const stubOf = (node: SchemaNode, depth: number): Schema.Json => {
  if (depth > 8) {
    return null;
  }

  const choices = node.enum ?? node.examples ?? [];
  const [branch] = node.anyOf ?? node.oneOf ?? [];

  if (node.const !== undefined) {
    return node.const;
  }

  if (node.default !== undefined) {
    return node.default;
  }

  if (choices.length > 0) {
    return choices[0] ?? null;
  }

  return branch === undefined
    ? stubOfType(node, depth, stubOf)
    : stubOf(branch, depth + 1);
};

/** A placeholder value for a node's result schema; null when the schema cannot be read. */
const stubValue = (schema: Schema.Json): Schema.Json =>
  decodeSchemaNode(schema).pipe(
    Option.match({ onNone: () => null, onSome: (node) => stubOf(node, 0) })
  );

/** The `title` of a result schema, which the call-site table shows as its name. */
const schemaTitle = (schema: Schema.Json) =>
  decodeSchemaNode(schema).pipe(
    Option.flatMap((node) => Option.fromUndefinedOr(node.title))
  );

/** One recorded node call before the table groups it. */
interface RecordedNode {
  readonly site: string;
  readonly spec: RoleSpec;
  readonly label: string;
  readonly phase: Option.Option<string>;
  readonly schemaName: Option.Option<string>;
  readonly readonly: boolean;
}

/** The first line of `prompt`, cut to a label. */
const labelFrom = (prompt: string) => {
  const line = (
    prompt.split("\n").find((part) => part.trim() !== "") ?? ""
  ).trim();

  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line;
};

/** The stub tools of one dry run and what they recorded. */
class Recorder {
  readonly nodes: Array<RecordedNode> = [];
  readonly problems: Array<string> = [];
  readonly phases: Array<string> = [];
  readonly logs: Array<string> = [];
  readonly stop = new AbortController();
  calls = 0;
  capReached = false;
  callCapReached = false;

  readonly limits: DryRunLimits;

  constructor(limits: DryRunLimits) {
    this.limits = limits;
  }

  /** Counts a call; stops the run past the call cap. */
  count(): boolean {
    this.calls += 1;

    if (this.calls > this.limits.callCap) {
      this.callCapReached = true;
      this.stop.abort();

      return false;
    }

    return true;
  }

  /** Records a node unless the cap is reached, in which case the run stops. */
  node(entry: RecordedNode): Option.Option<string> {
    if (this.nodes.length >= this.limits.nodeCap) {
      this.capReached = true;
      this.stop.abort();

      return Option.none();
    }

    this.nodes.push(entry);

    return Option.some(`dry-${this.nodes.length}`);
  }

  /** True when `nodeId` is one this run has answered. */
  issued(nodeId: string) {
    const match = /^dry-(?<index>\d+)$/u.exec(nodeId);

    return match !== null && Number(match.groups?.index) <= this.nodes.length;
  }

  problem(text: string) {
    if (this.problems.length < 10) {
      this.problems.push(text);
    }
  }

  /** The role spec a call names, or the problem with it. */
  spec(
    site: string,
    role: Option.Option<string>,
    fallback: string
  ): Option.Option<RoleSpec> {
    const written = Option.getOrElse(role, () => fallback);
    const spec = decodeRoleSpec(written);

    if (Option.isNone(spec)) {
      this.problem(
        `line ${site}: role \`${written}\` is not a role alias (\`@worker\`, \`@scout:high\`) or a \`provider/model\``
      );
    }

    return spec;
  }

  agent(call: AgentCall): NodeOutcome {
    const site = Option.getOrElse(call.site, () => "?");

    if (call.unknownOptions.length > 0) {
      this.problem(
        `line ${site}: agent() does not take ${call.unknownOptions.map((key) => `\`${key}\``).join(", ")}; its options are label, phase, role, schema, key, readonly, resume and effort (a model goes in \`role\`)`
      );
    }

    const schema = Option.filter(call.schema, (value) => value !== null);

    if (Option.isSome(schema) && !isObjectRootSchema(schema.value)) {
      this.problem(
        `line ${site}: agent()'s schema must be a JSON Schema with \`type: "object"\` at its root`
      );
    }

    if (Option.isSome(call.effort) && !isThinkingLevel(call.effort.value)) {
      this.problem(
        `line ${site}: effort \`${call.effort.value}\` is not one of off, minimal, low, medium, high, xhigh, max`
      );
    }

    if (Option.isSome(call.resume) && !this.issued(call.resume.value)) {
      this.problem(
        `line ${site}: resume names \`${call.resume.value}\`, which is not an earlier node's id (\`agent.full()\` answers it)`
      );
    }

    const spec = this.spec(site, call.role, DEFAULT_NODE_ROLE);

    if (Option.isNone(spec)) {
      return {
        status: "refused",
        value: null,
        reason: "invalid role",
        nodeId: null,
      };
    }

    const nodeId = this.node({
      site,
      spec: spec.value,
      label: Option.getOrElse(call.label, () => labelFrom(call.prompt)),
      phase: call.phase,
      schemaName: Option.flatMap(schema, schemaTitle),
      readonly: call.readonly,
    });

    return {
      status: Option.isSome(nodeId) ? "ok" : "refused",
      value: Option.isSome(schema)
        ? stubValue(schema.value)
        : "(dry run: no answer)",
      reason: null,
      nodeId: Option.getOrNull(nodeId),
    };
  }

  verify(call: VerifyCall): NodeOutcome {
    const site = Option.getOrElse(call.site, () => "?");
    const spec = this.spec(site, call.role, "@verifier");

    if (Option.isNone(spec)) {
      return {
        status: "refused",
        value: null,
        reason: "invalid role",
        nodeId: null,
      };
    }

    const nodeId = this.node({
      site,
      spec: spec.value,
      label: Option.getOrElse(call.label, () =>
        labelFrom(`Verify: ${Option.getOrElse(call.claim, () => "result")}`)
      ),
      phase: call.phase,
      schemaName: Option.some("verdict"),
      readonly: true,
    });

    return {
      status: Option.isSome(nodeId) ? "ok" : "refused",
      value: { verdict: "verified", reason: "(dry run)" },
      reason: null,
      nodeId: Option.getOrNull(nodeId),
    };
  }

  /** The stub tools the sandbox exposes as `tools.*`. */
  tools(): Array<CodemodeTool> {
    const malformed = (name: string) => {
      this.problem(
        `tools.${name} was called with arguments the prelude never sends; call agent(), verify() and approve() instead`
      );

      return {
        status: "refused",
        value: null,
        reason: "malformed call",
        nodeId: null,
      } satisfies NodeOutcome;
    };

    return [
      {
        name: "workflow_begin",
        execute: () => (this.count() ? { ok: true } : null),
      },
      {
        name: "agent",
        execute: (args) => {
          if (!this.count()) {
            return null;
          }

          return Option.match(decodeAgentCall(args), {
            onNone: () => malformed("agent"),
            onSome: (call) => this.agent(call),
          });
        },
      },
      {
        name: "verify",
        execute: (args) => {
          if (!this.count()) {
            return null;
          }

          return Option.match(decodeVerifyCall(args), {
            onNone: () => malformed("verify"),
            onSome: (call) => this.verify(call),
          });
        },
      },
      {
        name: "approve",
        execute: (args) => {
          if (!this.count()) {
            return null;
          }

          return Option.match(decodeApproveCall(args), {
            onNone: () => malformed("approve"),
            onSome: (call): ApproveAnswer => ({
              accepted: true,
              choice: call.options.pipe(
                Option.flatMap(Arr.head),
                Option.getOrNull
              ),
            }),
          });
        },
      },
      {
        name: "phase",
        execute: (args) => {
          if (
            this.count() &&
            Schema.is(Schema.Struct({ title: Schema.String }))(args)
          ) {
            this.phases.push(args.title);
          }

          return null;
        },
      },
      {
        name: "log",
        execute: (args) => {
          if (
            this.count() &&
            Schema.is(Schema.Struct({ text: Schema.String }))(args)
          ) {
            this.logs.push(args.text);
          }

          return null;
        },
      },
      {
        name: "budget",
        execute: () => (this.count() ? { spent: 0, remaining: null } : null),
      },
    ];
  }
}

// ---------------------------------------------------------------------------------------------
// From the recording to the table.

/** Groups recorded nodes by site, spec and mutability, in order of first call. */
const callSitesOf = (
  nodes: ReadonlyArray<RecordedNode>,
  unbounded: boolean
) => {
  const groups = new Map<
    string,
    { readonly first: RecordedNode; count: number }
  >();

  for (const node of nodes) {
    const key = `${node.site}|${node.spec}|${node.readonly}`;
    const group = groups.get(key);

    if (group === undefined) {
      groups.set(key, { first: node, count: 1 });
    } else {
      group.count += 1;
    }
  }

  return [...groups.values()].map(({ first, count }) =>
    CallSite.make({
      spec: first.spec,
      label: first.label.slice(0, LABEL_MAX),
      phase: Option.getOrNull(first.phase),
      schemaName: Option.getOrNull(first.schemaName),
      readonly: first.readonly,
      arms: ARMS,
      // A site called more than once in a run that hit the cap may be the loop: its count is open.
      maxCount: unbounded && count > 1 ? null : count,
    })
  );
};

/** Nodes per role spec, in order of first use. */
const byRoleOf = (nodes: ReadonlyArray<RecordedNode>) => {
  const counts = new Map<RoleSpec, number>();

  for (const node of nodes) {
    counts.set(node.spec, (counts.get(node.spec) ?? 0) + 1);
  }

  return [...counts].map(([spec, count]) => ({ spec, count }));
};

/** The script line a failed run's stack points at, when it points into the script. */
const failedLine = (result: CodemodeResult) => {
  if (result.ok) {
    return Option.none<number>();
  }

  const line = /codemode\.js:(?<line>\d+):\d+/u.exec(result.error.stack ?? "")
    ?.groups?.line;

  return line === undefined ? Option.none<number>() : Option.some(Number(line));
};

const outputOf = (result: CodemodeResult, logs: ReadonlyArray<string>) => [
  ...logs,
  ...result.output.flatMap((item) => (item.type === "text" ? [item.text] : [])),
];

/** Nearest-rank quantile of sorted numbers. */
const quantile = (sorted: ReadonlyArray<number>, q: number) =>
  sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  ] ?? 0;

const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`;

/**
 * The pre-launch estimate: each role's node count times the spread (first to third quartile) of
 * its last `HISTORY_WINDOW` settled nodes, or `FALLBACK_NODE_TOKENS` for a role with none. Dollars
 * only when every role's history is priced. For an unbounded run it is the floor of the estimate.
 */
export const estimateRun = (
  run: DryRun,
  history: ReadonlyArray<NodeHistory>
): WorkflowEstimate => {
  const nodes = run.byRole.reduce((sum, entry) => sum + entry.count, 0);
  let tokensLow = 0;
  let tokensHigh = 0;
  let microsLow = 0;
  let microsHigh = 0;
  let priced = true;
  const notes: Array<string> = [];

  for (const { spec, count: share } of run.byRole) {
    const samples = history
      .filter((entry) => entry.spec === spec)
      .slice(-HISTORY_WINDOW);

    if (samples.length === 0) {
      tokensLow += share * FALLBACK_NODE_TOKENS.low;
      tokensHigh += share * FALLBACK_NODE_TOKENS.high;
      priced = false;
      notes.push(
        `${spec}: no history, ${thousands(FALLBACK_NODE_TOKENS.low)} to ${thousands(FALLBACK_NODE_TOKENS.high)} tokens a node assumed`
      );
      continue;
    }

    const tokens = samples
      .map((entry) => entry.totalTokens)
      .toSorted((a, b) => a - b);

    tokensLow += share * quantile(tokens, 0.25);
    tokensHigh += share * quantile(tokens, 0.75);
    notes.push(
      `${spec}: from its last ${samples.length} node${samples.length === 1 ? "" : "s"}`
    );

    const micros = samples.flatMap((entry) => Option.toArray(entry.listMicros));

    if (micros.length === samples.length) {
      const sorted = micros.toSorted((a, b) => a - b);

      microsLow += share * quantile(sorted, 0.25);
      microsHigh += share * quantile(sorted, 0.75);
    } else {
      priced = false;
    }
  }

  const head = run.nodes.unbounded
    ? `At least ${nodes} nodes (the dry run stopped at its node cap; the real count depends on the data)`
    : `${nodes} node${nodes === 1 ? "" : "s"}`;

  return {
    nodes,
    tokensLow: Math.round(tokensLow),
    tokensHigh: Math.round(tokensHigh),
    listMicrosLow: priced && nodes > 0 ? Math.round(microsLow) : null,
    listMicrosHigh: priced && nodes > 0 ? Math.round(microsHigh) : null,
    basis: `${[head, ...notes].join("; ")}.`.slice(0, 4096),
  };
};

/** True when the card should say "Large workflow". */
export const isLargeWorkflow = (
  run: DryRun,
  estimate: WorkflowEstimate,
  budget: Budget
) =>
  run.nodes.unbounded ||
  run.nodes.count > LARGE_WORKFLOW.nodes ||
  estimate.tokensHigh > LARGE_WORKFLOW.tokens ||
  (budget.maxTokens !== null && estimate.tokensHigh > budget.maxTokens);

/** The launch approval's payload for a dry run: the plan the user says Go to. */
export const toLaunch = (run: DryRun, input: LaunchInput): WorkflowLaunch => {
  const roles = new Map<string, { spec: RoleSpec; readonly: boolean }>();

  for (const site of run.callSites) {
    const key = `${site.spec}|${site.readonly}`;

    if (!roles.has(key)) {
      roles.set(key, { spec: site.spec, readonly: site.readonly });
    }
  }

  const counted = run.nodes.unbounded
    ? MAX_WORKFLOW_NODES
    : Math.max(1, run.nodes.count);

  return WorkflowLaunch.make({
    type: "workflow",
    workflowId: input.workflowId,
    name: run.script.meta.name,
    description: run.script.meta.description,
    phases: run.script.meta.phases,
    scriptHash: run.script.hash,
    scriptRef: input.scriptRef,
    args: input.args,
    callSites: run.callSites,
    nodes: run.nodes,
    estimate: Option.getOrNull(input.estimate),
    envelope: Envelope.make({
      scriptHash: run.script.hash,
      maxNodes: Math.min(
        MAX_WORKFLOW_NODES,
        Option.getOrElse(input.maxNodes, () => counted)
      ),
      maxConcurrent: MAX_CONCURRENT_NODES,
      roles: [...roles.values()].map((role) => ({ ...role, arms: ARMS })),
      modes: input.modes,
      writes: input.writes,
      budget: input.budget,
    }),
    roleOverrides: input.roleOverrides,
  });
};

const refuse = (reason: WorkflowRefusal["reason"], message: string) =>
  new WorkflowRefusal({ reason, message });

/** Dry-runs and validates workflow scripts; nothing it does reaches a model or the ledger. */
export class WorkflowPlan extends Context.Service<
  WorkflowPlan,
  {
    /**
     * Runs `script` with stub nodes and answers its call sites and node count. Fails with
     * `WorkflowRefusal` when the script throws, does not finish, passes bad `agent()` options, hands
     * `parallel`/`pipeline` too many items or dispatches no node; with `DryRunUnavailable` when the
     * sandbox would not start.
     */
    dryRun(
      script: WorkflowScript,
      input: PlanInput
    ): Effect.Effect<DryRun, WorkflowRefusal | DryRunUnavailable>;
    /** Parses `source` and dry-runs it: everything a launch would refuse, without launching. */
    validate(
      source: string,
      input: PlanInput
    ): Effect.Effect<DryRun, WorkflowRefusal | DryRunUnavailable>;
  }
>()("cairn/server/workflows/WorkflowPlan") {
  static readonly layer = Layer.effect(
    WorkflowPlan,
    Effect.gen(function* () {
      const limits = yield* DryRunLimits;

      const dryRun = Effect.fn("WorkflowPlan.dryRun")(function* (
        script: WorkflowScript,
        input: PlanInput
      ) {
        const written = JSON.stringify(input.args);

        if (Buffer.byteLength(written, "utf-8") > WIRE_STRING_LIMIT_BYTES) {
          return yield* refuse(
            "args_invalid",
            `Workflow args are ${Buffer.byteLength(written, "utf-8")} bytes written out, over the ${WIRE_STRING_LIMIT_BYTES} byte limit; pass paths or ids and let nodes read the rest.`
          );
        }

        const recorder = new Recorder(limits);

        const code = rewriteScript(script, {
          workflowId: "dry-run",
          sample: input.sample,
          budgetTokens: Option.fromNullOr(input.budget.maxTokens),
          args: input.args,
        });

        const result = yield* Effect.acquireUseRelease(
          Effect.sync(
            () =>
              new CodemodeSandbox({
                tools: recorder.tools(),
                timeoutMs: limits.timeoutMs,
                memoryLimitBytes: limits.memoryLimitBytes,
              })
          ),
          (sandbox) =>
            Effect.tryPromise({
              try: async (signal) =>
                await sandbox.execute(code, {
                  signal: AbortSignal.any([signal, recorder.stop.signal]),
                }),
              catch: (cause) =>
                new DryRunUnavailable({
                  message: `The dry run of workflow ${script.meta.name} could not start its sandbox. Nothing ran; try again.`,
                  cause,
                }),
            }),
          (sandbox) =>
            Effect.promise(async () => {
              await sandbox.close();
            })
        );

        if (recorder.callCapReached) {
          return yield* refuse(
            "dry_run_timeout",
            `The dry run of workflow ${script.meta.name} made over ${limits.callCap} tool calls without finishing. Bound its loops (a loop that only logs never ends), then propose it again.`
          );
        }

        if (!result.ok && !recorder.capReached) {
          const line = failedLine(result).pipe(
            Option.match({ onNone: () => "", onSome: (at) => ` (line ${at})` })
          );

          if (result.error.kind === "timeout") {
            return yield* refuse(
              "dry_run_timeout",
              `The dry run of workflow ${script.meta.name} did not finish in ${limits.timeoutMs / 1000} s with every node answering at once. Look for a loop that never awaits a node, then propose it again.`
            );
          }

          if (result.error.kind === "sandbox") {
            return yield* new DryRunUnavailable({
              message: `The dry run of workflow ${script.meta.name} lost its sandbox: ${result.error.message}. Nothing ran; try again.`,
              cause: result.error,
            });
          }

          return yield* refuse(
            result.error.message.includes(TOO_MANY_ITEMS)
              ? "too_many_items"
              : "script_failed",
            `The dry run of workflow ${script.meta.name} failed${line}: ${result.error.message}. Every node answered at once with a placeholder shaped by its schema; fix the script, then propose it again.`
          );
        }

        if (recorder.problems.length > 0) {
          return yield* refuse(
            "agent_options_invalid",
            `The dry run of workflow ${script.meta.name} found calls a launch would refuse: ${recorder.problems.join("; ")}.`
          );
        }

        if (recorder.nodes.length === 0) {
          return yield* refuse(
            "no_nodes",
            `Workflow ${script.meta.name} dispatched no node in its dry run. A workflow fans work out with agent() or verify(); do small work directly instead.`
          );
        }

        const declared = new Set(
          script.meta.phases.map((phase) => phase.title)
        );

        const reached = [
          ...recorder.phases,
          ...recorder.nodes.flatMap((node) => Option.toArray(node.phase)),
        ];

        return {
          script,
          callSites: callSitesOf(recorder.nodes, recorder.capReached),
          nodes: {
            count: recorder.nodes.length,
            unbounded: recorder.capReached,
          },
          undeclaredPhases: [
            ...new Set(reached.filter((title) => !declared.has(title))),
          ],
          byRole: byRoleOf(recorder.nodes),
          output: outputOf(result, recorder.logs)
            .filter(isDisplayText)
            .slice(0, 50),
        } satisfies DryRun;
      });

      const validate = Effect.fn("WorkflowPlan.validate")(function* (
        source: string,
        input: PlanInput
      ) {
        const script = yield* parseWorkflowScript(source);

        return yield* dryRun(script, input);
      });

      return WorkflowPlan.of({ dryRun, validate });
    })
  );
}
