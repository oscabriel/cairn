// J-typed: the typed-results target on real models across three providers (plan 4F; models note
// M9, subagents note S8). Each model runs N trials of the probe task (`judges/fixtures/
// TypedResults.ts`), by default through real subagent children (`judges/fixtures/
// TypedChildren.ts`): a scripted parent spawns a typed brief, the judge says Go, the child runs on
// the model under test with Cairn's production extensions, and 3A's reporter sends the one nudge.
// `--path bare` runs them on a bare pi-durable Harness with the `results` extension instead.
//
//   node judges/typed-results.ts [--provider opencode-go,bridge,codex]
//     [--models claude-haiku-5-5,deepseek-v4.1-flash,qwen3.8-flash,gpt-6-luna]
//     [--bridge-model claude-haiku-5-5] [--trials 8] [--control v1,union] [--path children]
//     [--deployed-port 3774] [--config ~/.config/cairn/cairn.json]
//
// The gate (wave 2 decision, `docs/phase-2/waves.md`): a trial passes when its stored result
// decodes against the judge's own schema, took at most two attempts counted by the judge from the
// transcript (a nudge before any call counts as one) and equal to the count the tool stored, and
// came from the model its dispatch record names, which is the one asked for. Whether the result
// holds the task's facts is reported per model (`factsRight`) and does not fail the judge.
//
// Providers: OpenCode Go through pi's model runtime, read-only over `~/.pi/agent`; the bridge
// through the real Agent SDK and the `claude` binary's login. Codex: only the deployed brain may
// use the user's Codex sign-in (it holds the OAuth lock, ADR 0037), so the judge reads
// `providers.status` from it on `--deployed-port` (read-only, no turn). Unless `openai-codex` is
// ready there, the Codex case is blocked, printed with its reason, and the recorded fallback
// `opencode-go/gpt-6-luna` (ADR 0037) runs as the third provider. When Codex is ready there, the
// judge brain still cannot use it, so the Codex line fails with that reason.
//
// Controls, which must fail: `v1` runs the first OpenCode Go model with v1's open tool and the
// schema in the prompt on the bare Harness (the models note measured 0 of 8); `union` asks the
// result tool to accept a schema whose root is a union, which it must refuse.
//
// Prints one JSON line per model and control, then a summary line with the total cost. Exit 0
// when every model run passes every trial and both controls fail. A model the runtime does not
// have, or a provider with no credential, prints a skipped line and fails the run.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { ClaudeSdk } from "@cairn/bridge/ClaudeSdk";
import { ClaudeUsage } from "@cairn/bridge/ClaudeUsage";
import type { ModelRef } from "@cairn/protocol/Models";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";

import { BridgeCwd } from "../apps/server/src/brain/BridgeCwdExtension.ts";
import { ModelSource } from "../apps/server/src/brain/ModelSource.ts";
import { BridgeProvider } from "../apps/server/src/models/BridgeProvider.ts";
import { PiModelSource } from "../apps/server/src/models/PiModelSource.ts";
import {
  childBrain,
  scriptedParent,
  openBrain,
  runChildTrials,
  scriptParents,
} from "./fixtures/TypedChildren.ts";
import {
  bridgeTarget,
  runTrials,
  unionControl,
} from "./fixtures/TypedResults.ts";
import type { Target, Trial, TrialMode } from "./fixtures/TypedResults.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";

const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "opencode-go,bridge,codex" },
    models: {
      type: "string",
      default: "claude-haiku-5-5,deepseek-v4.1-flash,qwen3.8-flash,gpt-6-luna",
    },
    "bridge-model": { type: "string", default: "claude-haiku-5-5" },
    trials: { type: "string", default: "8" },
    control: { type: "string", default: "v1,union" },
    path: { type: "string", default: "children" },
    "deployed-port": { type: "string", default: "3774" },
    config: {
      type: "string",
      default: path.join(homedir(), ".config", "cairn", "cairn.json"),
    },
  },
});

const listOf = (value: string) =>
  value.split(",").filter((name) => name !== "");

const TRIALS = Number(values.trials);

const providers = new Set(listOf(values.provider));

const controls = new Set(listOf(values.control));

const goModels = listOf(values.models);

const throughChildren = values.path !== "bare";

const CODEX = "openai-codex";

/** The model the Codex case runs on, and its recorded fallback (ADR 0037). */
const CODEX_MODEL = "gpt-6-luna";

const FALLBACK: ModelRef = { provider: "opencode-go", modelId: CODEX_MODEL };

/** How long one model's trials may take. */
const DEADLINE = Duration.minutes(12);

/** The run did not meet the target. */
class TypedResultsFailed extends Schema.TaggedError<TypedResultsFailed>()(
  "TypedResultsFailed",
  { message: Schema.String }
) {}

/** Which provider a model line stands for in the target's three. */
type Role = "opencode-go" | "bridge" | "codex" | "codex-fallback";

/** One model's line. */
interface Line {
  readonly name: string;
  readonly role: Role;
  readonly mode: TrialMode;
  readonly path: "children" | "bare";
  readonly valid: number;
  readonly factsRight: number;
  readonly trials: number;
  readonly costUsd: number;
  readonly skipped: string;
  readonly timedOut: boolean;
  readonly results: ReadonlyArray<Trial>;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** The Codex case: what the deployed brain says, and what ran in its place. */
interface CodexCase {
  readonly state: string;
  readonly blocked: string;
}

/** The summary line. */
interface Summary {
  readonly summary: true;
  readonly pass: boolean;
  readonly path: "children" | "bare";
  readonly models: ReadonlyArray<string>;
  readonly factsRight: ReadonlyArray<string>;
  readonly providers: Readonly<Record<string, string>>;
  readonly codex: CodexCase;
  readonly controls: ReadonlyArray<string>;
  readonly costUsd: number;
  readonly failures: ReadonlyArray<string>;
}

/** The union control's line. */
interface UnionLine {
  readonly name: "union-schema";
  readonly mode: "control";
  readonly refused: boolean;
  readonly reason: string;
}

/** A model's line with its wall time. */
interface TimedLine extends Line {
  readonly seconds: number;
}

/** The Codex case's line. */
interface CodexLine extends CodexCase {
  readonly name: "openai-codex";
  readonly mode: "provider-check";
}

const print = (line: Line | TimedLine | Summary | UnionLine | CodexLine) =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  });

const costOf = (items: ReadonlyArray<{ readonly costUsd: number }>) => {
  let sum = 0;

  for (const item of items) {
    sum += item.costUsd;
  }

  return sum;
};

const nameOf = (model: ModelRef) => `${model.provider}/${model.modelId}`;

/** Runs one model's trials under the deadline and prints its line. */
const timed = <E, R>(
  name: string,
  role: Role,
  mode: TrialMode,
  bare: boolean,
  trials: Effect.Effect<ReadonlyArray<Trial>, E, R>
) =>
  Effect.gen(function* () {
    const started = performance.now();
    const outcome = yield* trials.pipe(Effect.timeoutOption(DEADLINE));
    const results = Option.getOrElse(outcome, (): ReadonlyArray<Trial> => []);

    const line: Line = {
      name,
      role,
      mode,
      path: bare ? "bare" : "children",
      valid: results.filter((trial) => trial.valid).length,
      factsRight: results.filter((trial) => trial.factsRight).length,
      trials: TRIALS,
      costUsd: round(costOf(results)),
      skipped: "",
      timedOut: Option.isNone(outcome),
      results,
    };

    yield* print({
      ...line,
      seconds: Math.round((performance.now() - started) / 1000),
    });

    return line;
  });

const skipped = (name: string, role: Role, why: string): Line => ({
  name,
  role,
  mode: "typed",
  path: throughChildren ? "children" : "bare",
  valid: 0,
  factsRight: 0,
  trials: TRIALS,
  costUsd: 0,
  skipped: why,
  timedOut: false,
  results: [],
});

const CairnJson = Schema.fromJsonString(
  Schema.Struct({
    owner: Schema.String,
    host: Schema.String,
    origin: Schema.String,
  })
);

const decodeCairnJson = Schema.decodeEffect(CairnJson);

/**
 * `openai-codex`'s state on the deployed brain (`providers.status`, read-only), or why it could
 * not be read.
 */
const deployedCodexState = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const config = yield* decodeCairnJson(
    yield* fs.readFileString(values.config)
  );

  const client = yield* ProtocolClient.cairn({
    base: `http://127.0.0.1:${values["deployed-port"]}`,
    origin: config.origin,
    headers: { Host: config.host, "X-Cairn-User": config.owner },
  });

  yield* client["session.hello"]();

  const statuses = yield* client["providers.status"]();

  return (
    statuses.find((status) => status.provider === CODEX)?.state ?? "absent"
  );
}).pipe(
  Effect.scoped,
  Effect.timeoutOption(Duration.seconds(20)),
  Effect.map(Option.getOrElse(() => "unreadable: no answer in 20 s")),
  Effect.result,
  Effect.map(
    Result.getOrElse(
      (failure) => `unreadable: ${String(failure).slice(0, 160)}`
    )
  )
);

/** Whether `model` is available to this brain's runtime. */
const availableIn = Effect.fn("TypedResults.available")(function* (
  model: ModelRef
) {
  const catalog = yield* PiModelSource;

  const listing = yield* catalog.catalog({
    bridgeEnabled: model.provider === "claude-bridge",
  });

  return listing.models.some(
    (found) =>
      found.provider === model.provider &&
      found.modelId === model.modelId &&
      found.available
  );
});

/** What the run plans: each model with its role. */
interface Planned {
  readonly model: ModelRef;
  readonly role: Role;
}

/** The models to run, given the Codex case. */
const planOf = (codex: CodexCase): ReadonlyArray<Planned> => {
  const go: Array<Planned> = providers.has("opencode-go")
    ? goModels.map((modelId) => ({
        model: { provider: "opencode-go", modelId },
        role: "opencode-go" as const,
      }))
    : [];

  const bridge: Array<Planned> = providers.has("bridge")
    ? [
        {
          model: { provider: "claude-bridge", modelId: values["bridge-model"] },
          role: "bridge",
        },
      ]
    : [];

  if (!providers.has("codex")) {
    return [...go, ...bridge];
  }

  if (codex.blocked === "") {
    return [
      ...go,
      ...bridge,
      { model: { provider: CODEX, modelId: CODEX_MODEL }, role: "codex" },
    ];
  }

  // The fallback stands in for Codex: one run, labelled as the fallback, even when the OpenCode
  // Go list already names it.
  return [
    ...go.filter((planned) => nameOf(planned.model) !== nameOf(FALLBACK)),
    ...bridge,
    { model: FALLBACK, role: "codex-fallback" },
  ];
};

/** The parent threads' scripted model, registered in the judge's brain beside the real ones. */
const parentModel = scriptedParent();

/** The typed models, each through real subagent children on the judge's brain. */
const childrenRun = (plan: ReadonlyArray<Planned>, cwd: string) =>
  Effect.gen(function* () {
    scriptParents(parentModel, plan.length * TRIALS);

    const log = yield* openBrain;
    const lines: Array<Line> = [];

    for (const [offset, planned] of plan.entries()) {
      const name = nameOf(planned.model);

      if (yield* availableIn(planned.model)) {
        lines.push(
          yield* timed(
            name,
            planned.role,
            "typed",
            false,
            runChildTrials(log, planned.model, TRIALS, offset * TRIALS + 1, cwd)
          )
        );
      } else {
        const why =
          planned.role === "codex"
            ? "openai-codex is ready on the deployed brain, but only the brain holding the OAuth lock may use the sign-in, so this judge brain cannot"
            : "model not available";

        const line = skipped(name, planned.role, why);

        yield* print(line);
        lines.push(line);
      }
    }

    return lines;
  });

/** The typed models on the bare Harness, as 2E ran them. */
const bareRun = (plan: ReadonlyArray<Planned>, cwd: string) =>
  Effect.gen(function* () {
    const source = yield* ModelSource;
    const models = source.models();
    const lines: Array<Line> = [];

    for (const planned of plan) {
      const name = nameOf(planned.model);

      if (!(yield* availableIn(planned.model))) {
        const line = skipped(name, planned.role, "model not available");

        yield* print(line);
        lines.push(line);
      } else if (planned.model.provider === "claude-bridge") {
        const target = yield* bridgeTarget(planned.model.modelId, cwd);

        lines.push(
          yield* timed(
            name,
            planned.role,
            "typed",
            true,
            runTrials(target, "typed", TRIALS)
          )
        );
      } else {
        const target: Target = {
          models,
          model: planned.model,
          cwd: Option.none(),
          extensions: [],
        };

        lines.push(
          yield* timed(
            name,
            planned.role,
            "typed",
            true,
            runTrials(target, "typed", TRIALS)
          )
        );
      }
    }

    return lines;
  });

/** The v1 control on the first OpenCode Go model, on the bare Harness (it replaces the tool). */
const v1Control = Effect.gen(function* () {
  const source = yield* ModelSource;
  const [first] = goModels;

  if (!controls.has("v1") || first === undefined) {
    return Option.none<Line>();
  }

  const model: ModelRef = { provider: "opencode-go", modelId: first };

  if (!(yield* availableIn(model))) {
    return Option.none<Line>();
  }

  const target: Target = {
    models: source.models(),
    model,
    cwd: Option.none(),
    extensions: [],
  };

  return Option.some(
    yield* timed(
      nameOf(model),
      "opencode-go",
      "v1",
      true,
      runTrials(target, "v1", TRIALS)
    )
  );
});

const program = Effect.gen(function* () {
  const state = providers.has("codex")
    ? yield* deployedCodexState
    : "not asked";

  const codex: CodexCase = {
    state,
    blocked:
      !providers.has("codex") || state === "ready"
        ? ""
        : `openai-codex is ${state} on the deployed brain (the user's Codex login, ops/wizards/phase-2.sh 1, has not happened); ran the fallback ${nameOf(FALLBACK)}`,
  };

  if (providers.has("codex")) {
    yield* print({ name: CODEX, mode: "provider-check", ...codex });
  }

  const plan = planOf(codex);
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "cairn-typed-")));

  const removeCwd = Effect.sync(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const typed: ReadonlyArray<Line> = throughChildren
    ? yield* childrenRun(plan, cwd).pipe(Effect.ensuring(removeCwd))
    : yield* bareRun(plan, cwd).pipe(Effect.ensuring(removeCwd));

  const v1 = Option.toArray(yield* v1Control);

  const union = controls.has("union")
    ? Option.some(unionControl())
    : Option.none();

  for (const result of Option.toArray(union)) {
    yield* print({ name: "union-schema", mode: "control", ...result });
  }

  const count = (line: Line, value: number) =>
    `${line.name} ${String(value)}/${String(line.trials)}`;

  const failures = [
    ...typed.flatMap((line) =>
      line.valid === line.trials
        ? []
        : [`${count(line, line.valid)} ${line.skipped}`.trim()]
    ),
    ...v1.flatMap((line) =>
      line.valid === line.trials
        ? [`v1 control on ${count(line, line.valid)} passed`]
        : []
    ),
    ...Option.toArray(union).flatMap((result) =>
      result.refused ? [] : ["union control: the schema was accepted"]
    ),
  ];

  const byRole = (role: Role) =>
    typed
      .flatMap((line) => (line.role === role ? [count(line, line.valid)] : []))
      .join(", ");

  yield* print({
    summary: true,
    pass: failures.length === 0,
    path: throughChildren ? "children" : "bare",
    models: typed.map((line) => count(line, line.valid)),
    factsRight: typed.map((line) => count(line, line.factsRight)),
    providers: {
      bridge: byRole("bridge"),
      "opencode-go": byRole("opencode-go"),
      codex:
        codex.blocked === ""
          ? byRole("codex")
          : `blocked; fallback ${byRole("codex-fallback")}`,
    },
    codex,
    controls: [
      ...v1.map((line) => `v1 ${count(line, line.valid)}`),
      ...Option.toArray(union).map((result) => `union ${result.reason}`),
    ],
    costUsd: round(costOf([...typed, ...v1])),
    failures,
  });

  if (failures.length > 0) {
    return yield* new TypedResultsFailed({
      message: `typed-results failed: ${failures.join("; ")}`,
    });
  }

  return typed.length;
});

// The bridge on the real Agent SDK and the `claude` binary's login; nothing is asked of it unless
// the bridge provider runs.
const bridgeLayer = BridgeCwd.layer.pipe(
  Layer.provideMerge(BridgeProvider.layerNoDeps),
  Layer.provideMerge(
    ClaudeUsage.layerBridgeNoDeps.pipe(Layer.provideMerge(ClaudeSdk.layer))
  )
);

const brainDir = mkdtempSync(path.join(tmpdir(), "cairn-typed-brain-"));

NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(
      childBrain(brainDir, parentModel.provider).pipe(
        Layer.provideMerge(bridgeLayer),
        Layer.provideMerge(NodeServices.layer)
      )
    ),
    Effect.ensuring(
      Effect.sync(() => {
        rmSync(brainDir, { recursive: true, force: true });
      })
    )
  )
);
