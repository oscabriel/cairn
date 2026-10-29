// J-typed: the typed-results target on real models. Each model runs N trials of the probe task
// (`judges/fixtures/TypedResults.ts`) through a bare pi-durable Harness with Cairn's `results`
// extension; a trial passes when its stored result decodes against the judge's own schema, holds
// the task's facts, took at most two attempts counted by the judge from the transcript (a nudge
// before any call counts as one) and equal to the count the tool stored, and came from the model
// the child was dispatched on.
//   node judges/typed-results.ts [--provider opencode-go,bridge]
//     [--models claude-haiku-5-5,deepseek-v4.1-flash,qwen3.8-flash,gpt-6-luna]
//     [--bridge-model claude-haiku-5-5] [--trials 8] [--control v1,union]
//
// OpenCode Go runs through pi's model runtime, read-only over `~/.pi/agent` (the brain's own
// `PiModelSource`); the bridge through the real Agent SDK and the `claude` binary's login, with
// Cairn's `bridge-cwd` extension. Controls, which must fail: `v1` runs the first OpenCode Go model
// with v1's open tool and the schema in the prompt (the models note measured 0 of 8); `union`
// asks the result tool to accept a schema whose root is a union, which it must refuse.
//
// Prints one JSON line per model and control, then a summary line with the total cost. Exit 0
// when every model passes every trial and both controls fail. A model the runtime does not have,
// or a provider with no credential, prints a skipped line and fails the run.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { ClaudeSdk } from "@cairn/bridge/ClaudeSdk";
import { ClaudeUsage } from "@cairn/bridge/ClaudeUsage";
import { NodeRuntime } from "@effect/platform-node";
import { Duration, Effect, Layer, Option, Schema } from "effect";

import { BridgeCwd } from "../apps/server/src/brain/BridgeCwdExtension.ts";
import { ModelSource } from "../apps/server/src/brain/ModelSource.ts";
import { ServerConfig } from "../apps/server/src/Config.ts";
import { BridgeProvider } from "../apps/server/src/models/BridgeProvider.ts";
import { PiModelSource } from "../apps/server/src/models/PiModelSource.ts";
import {
  bridgeTarget,
  runTrials,
  unionControl,
} from "./fixtures/TypedResults.ts";
import type { Target, Trial, TrialMode } from "./fixtures/TypedResults.ts";

const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "opencode-go,bridge" },
    models: {
      type: "string",
      default: "claude-haiku-5-5,deepseek-v4.1-flash,qwen3.8-flash,gpt-6-luna",
    },
    "bridge-model": { type: "string", default: "claude-haiku-5-5" },
    trials: { type: "string", default: "8" },
    control: { type: "string", default: "v1,union" },
  },
});

const listOf = (value: string) =>
  value.split(",").filter((name) => name !== "");

const TRIALS = Number(values.trials);

const providers = new Set(listOf(values.provider));

const controls = new Set(listOf(values.control));

const goModels = listOf(values.models);

/** How long one model's trials may take. */
const DEADLINE = Duration.minutes(6);

/** The run did not meet the target. */
class TypedResultsFailed extends Schema.TaggedError<TypedResultsFailed>()(
  "TypedResultsFailed",
  { message: Schema.String }
) {}

/** One model's line. */
interface Line {
  readonly name: string;
  readonly mode: TrialMode;
  readonly valid: number;
  readonly trials: number;
  readonly costUsd: number;
  readonly skipped: string;
  readonly timedOut: boolean;
  readonly results: ReadonlyArray<Trial>;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** The summary line. */
interface Summary {
  readonly summary: true;
  readonly pass: boolean;
  readonly models: ReadonlyArray<string>;
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

const print = (line: Line | TimedLine | Summary | UnionLine) =>
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

const runOn = (name: string, target: Target, mode: TrialMode) =>
  Effect.gen(function* () {
    const started = performance.now();

    const outcome = yield* runTrials(target, mode, TRIALS).pipe(
      Effect.timeoutOption(DEADLINE)
    );

    const results = Option.getOrElse(outcome, (): ReadonlyArray<Trial> => []);

    const line: Line = {
      name,
      mode,
      valid: results.filter((trial) => trial.valid).length,
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

const skipped = (name: string, mode: TrialMode, why: string): Line => ({
  name,
  mode,
  valid: 0,
  trials: TRIALS,
  costUsd: 0,
  skipped: why,
  timedOut: false,
  results: [],
});

/** The OpenCode Go models, then the v1 control on the first of them. */
const openCodeGo = Effect.gen(function* () {
  const catalog = yield* PiModelSource;
  const source = yield* ModelSource;
  const listing = yield* catalog.catalog({ bridgeEnabled: false });
  const models = source.models();
  const lines: Array<Line> = [];

  const available = (modelId: string) =>
    listing.models.some(
      (model) =>
        model.provider === "opencode-go" &&
        model.modelId === modelId &&
        model.available
    );

  const targetOf = (modelId: string): Target => ({
    models,
    model: { provider: "opencode-go", modelId },
    cwd: Option.none(),
    extensions: [],
  });

  for (const modelId of goModels) {
    const name = `opencode-go/${modelId}`;

    if (available(modelId)) {
      lines.push(yield* runOn(name, targetOf(modelId), "typed"));
    } else {
      const line = skipped(name, "typed", "model not available");

      yield* print(line);
      lines.push(line);
    }
  }

  const [first] = goModels;

  if (controls.has("v1") && first !== undefined && available(first)) {
    lines.push(yield* runOn(`opencode-go/${first}`, targetOf(first), "v1"));
  }

  return lines;
});

const goLayer = (dataDir: string) =>
  PiModelSource.layer.pipe(Layer.provide(ServerConfig.layerWith({ dataDir })));

/** The bridge on `--bridge-model`. */
const bridge = Effect.gen(function* () {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "cairn-typed-")));
  const target = yield* bridgeTarget(values["bridge-model"], cwd);

  return yield* runOn(
    `claude-bridge/${values["bridge-model"]}`,
    target,
    "typed"
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        rmSync(cwd, { recursive: true, force: true });
      })
    )
  );
});

const bridgeLayer = BridgeCwd.layer.pipe(
  Layer.provideMerge(BridgeProvider.layerNoDeps),
  Layer.provideMerge(
    ClaudeUsage.layerBridgeNoDeps.pipe(Layer.provideMerge(ClaudeSdk.layer))
  )
);

const program = Effect.gen(function* () {
  const lines: Array<Line> = [];

  if (providers.has("opencode-go")) {
    const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-typed-go-"));

    lines.push(
      ...(yield* openCodeGo.pipe(
        Effect.provide(goLayer(dataDir)),
        Effect.ensuring(
          Effect.sync(() => {
            rmSync(dataDir, { recursive: true, force: true });
          })
        )
      ))
    );
  }

  if (providers.has("bridge")) {
    lines.push(yield* bridge.pipe(Effect.scoped, Effect.provide(bridgeLayer)));
  }

  const union = controls.has("union")
    ? Option.some(unionControl())
    : Option.none();

  for (const result of Option.toArray(union)) {
    yield* print({ name: "union-schema", mode: "control", ...result });
  }

  const typed = lines.filter((line) => line.mode === "typed");
  const v1 = lines.filter((line) => line.mode === "v1");

  const failures = [
    ...typed.flatMap((line) =>
      line.valid === line.trials
        ? []
        : [
            `${line.name} ${String(line.valid)}/${String(line.trials)} ${line.skipped}`.trim(),
          ]
    ),
    ...v1.flatMap((line) =>
      line.valid === line.trials
        ? [
            `v1 control on ${line.name} passed ${String(line.valid)}/${String(line.trials)}`,
          ]
        : []
    ),
    ...Option.toArray(union).flatMap((result) =>
      result.refused ? [] : ["union control: the schema was accepted"]
    ),
  ];

  yield* print({
    summary: true,
    pass: failures.length === 0,
    models: typed.map(
      (line) => `${line.name} ${String(line.valid)}/${String(line.trials)}`
    ),
    controls: [
      ...v1.map(
        (line) => `v1 ${line.name} ${String(line.valid)}/${String(line.trials)}`
      ),
      ...Option.toArray(union).map((result) => `union ${result.reason}`),
    ],
    costUsd: round(costOf(lines)),
    failures,
  });

  if (failures.length > 0) {
    return yield* new TypedResultsFailed({
      message: `typed-results failed: ${failures.join("; ")}`,
    });
  }

  return lines.length;
});

NodeRuntime.runMain(program);
