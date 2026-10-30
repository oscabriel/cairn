// Workflows note judge 9 (plan 5D): the council recipe's typed nodes on real models, two
// providers. The built-in council runs by name on a judge brain (a pi-durable Harness over a
// scratch store with Cairn's code mode, workflows, results and bridge-cwd extensions, never the
// deployed unit): advisor 1 on the Claude bridge, advisor 2 and the claim matrix on OpenCode Go,
// so each typed result is a real provider's. The launching thread runs on pi-ai's faux provider,
// which only sends the recipe reference to `codemode`.
//
//   node judges/council-typed.ts [--bridge-model claude-haiku-5-5]
//     [--advisor-model opencode-go/deepseek-v4.1-flash] [--judge-model opencode-go/qwen3.8-flash]
//
// Pass: the workflow finishes with five settled nodes (two reports, the matrix, two cross-
// examinations); every node took one or two schema attempts (the ledger's `schemaAttempts`, which
// the result tool derives from the transcript); each cross-examination resumed its advisor's report
// node (the roster says `resumed`, no fresh-context fallback); and each node ran on the model its
// role names. Prints one JSON line per node and a summary with the tokens and list-price cost (the
// bridge's tokens are plan usage, unpriced). Exit 0 on a pass.
//
// `--kill-in-pass-2` is workflows note judge 6's kill on the same council (plan 7B): the brain runs
// as a child of this judge over a SQLite store in a scratch directory, and the judge `kill -9`s it
// two seconds after a pass 2 cross-examination's input is with its model, then opens a second life
// on the same store, which resubmits the run under its request id and waits for the end. It passes
// on the checks above, read by the last life, plus the kill having happened and no node past its
// first attempt (each dispatched once across both lives).
//
// The user's decision of 2026-10-29 (no Codex subscription) makes this two providers. Models are
// the cheapest that answer: Claude Haiku through the bridge, OpenCode Go's flash models.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { ClaudeSdk } from "@cairn/bridge/ClaudeSdk";
import { ClaudeUsage } from "@cairn/bridge/ClaudeUsage";
import type { ModelRef } from "@cairn/protocol/Models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Cause,
  Duration,
  Effect,
  Layer,
  Logger,
  Option,
  Result,
  Schema,
} from "effect";

import { BridgeCwd } from "../apps/server/src/brain/BridgeCwdExtension.ts";
import { CodeMode } from "../apps/server/src/brain/CodeMode.ts";
import { ModelSource } from "../apps/server/src/brain/ModelSource.ts";
import { ServerConfig } from "../apps/server/src/Config.ts";
import { BridgeProvider } from "../apps/server/src/models/BridgeProvider.ts";
import {
  ExtraProviders,
  PiModelSource,
} from "../apps/server/src/models/PiModelSource.ts";
import { ResultTool } from "../apps/server/src/models/ResultTool.ts";
import {
  BUILT_IN_RECIPES,
  recipeReference,
} from "../apps/server/src/workflows/recipes/BuiltInRecipes.ts";
import { HOLD_RETRY_MILLIS } from "../apps/server/src/workflows/WorkflowBudget.ts";
import { WorkflowsDoc } from "../apps/server/src/workflows/WorkflowDocs.ts";
import type {
  NodeItemState,
  WorkflowItemState,
} from "../apps/server/src/workflows/WorkflowDocs.ts";
import { WorkflowPlan } from "../apps/server/src/workflows/WorkflowPlan.ts";
import { planAccess } from "../apps/server/src/workflows/Workflows.ts";
import {
  codemodeResultText,
  plant,
  plantDefaults,
  runScript,
} from "../apps/server/src/workflows/WorkflowTestKit.ts";
import type { KitBrain } from "../apps/server/src/workflows/WorkflowTestKit.ts";
import {
  NO_HOLD,
  NO_WORKFLOW_FAULTS,
  workflowExtension,
} from "../apps/server/src/workflows/WorkflowTools.ts";
import type { RoleResolver } from "../apps/server/src/workflows/WorkflowTools.ts";
import {
  councilRoot,
  openCouncilBrain,
  openCouncilStore,
} from "./fixtures/workflows/CouncilBrain.ts";

const { values } = parseArgs({
  options: {
    "bridge-model": { type: "string", default: "claude-haiku-5-5" },
    "advisor-model": {
      type: "string",
      default: "opencode-go/deepseek-v4.1-flash",
    },
    "judge-model": { type: "string", default: "opencode-go/qwen3.8-flash" },
    "kill-in-pass-2": { type: "boolean", default: false },
    // Internal to `--kill-in-pass-2`: one life of the brain over the store in `--dir`.
    life: { type: "boolean", default: false },
    // Internal: the life prints the pass 2 marker (the first life only).
    mark: { type: "boolean", default: false },
    dir: { type: "string" },
  },
});

const context = BACKGROUND_CONTEXT;

const WF = "wf-council-typed";

/** How long the whole council may take. */
const DEADLINE = Duration.minutes(15);

const refOf = (spec: string): ModelRef => {
  const [provider = "", ...rest] = spec.split("/");

  return { provider, modelId: rest.join("/") };
};

/** The roles the council names, and the models they run on. */
const ROLES: ReadonlyMap<string, ModelRef> = new Map([
  [
    "@advisor-bridge",
    { provider: "claude-bridge", modelId: values["bridge-model"] },
  ],
  ["@advisor-go", refOf(values["advisor-model"])],
  ["@judge-go", refOf(values["judge-model"])],
]);

const ARGS = {
  question:
    "Should a small command-line tool keep its settings in a TOML file or a JSON file?",
  scope: "A single-user CLI written in TypeScript; the file is edited by hand",
  nonGoals: "Remote or synced settings",
  evidence: "None given; answer from what you know and say what you assumed",
  advisors: ["@advisor-bridge", "@advisor-go"],
  judge: "@judge-go",
};

const resolveRole: RoleResolver = async (spec) =>
  await Promise.resolve(
    Option.match(Option.fromUndefinedOr(ROLES.get(spec)), {
      onNone: () => Result.fail(`the judge binds no model to ${spec}`),
      onSome: (model) =>
        Result.succeed({
          provider: model.provider,
          modelId: model.modelId,
          thinkingLevel: Option.none(),
        }),
    })
  );

/** The judge did not see the target met. */
class CouncilTypedFailed extends Schema.TaggedError<CouncilTypedFailed>()(
  "CouncilTypedFailed",
  { message: Schema.String }
) {}

/** What the council's roster says, as far as the judge reads it. */
const Roster = Schema.Struct({
  roster: Schema.Array(
    Schema.Struct({
      advisor: Schema.Finite,
      crossExam: Schema.Array(Schema.String),
    })
  ),
});

const decodeRoster = Schema.decodeUnknownOption(Schema.fromJsonString(Roster));

/** One node's line. */
interface NodeLine {
  readonly node: string;
  readonly role: string | null;
  readonly model: string;
  readonly state: string;
  readonly schemaAttempts: number;
  readonly attempt: number;
  readonly totalTokens: number;
  readonly listMicros: number | null;
  readonly error: string | null;
}

/** The summary line. */
interface Summary {
  readonly summary: true;
  readonly pass: boolean;
  readonly state: string;
  readonly nodes: number;
  readonly crossExam: ReadonlyArray<string>;
  readonly tokens: number;
  readonly costUsd: number;
  readonly bridgeTokensPlanUsage: number;
  readonly seconds: number;
  readonly failures: ReadonlyArray<string>;
}

const print = (line: NodeLine | Summary) =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  });

const ended = (row: WorkflowItemState | undefined) =>
  row !== undefined && ["finished", "failed", "stopped"].includes(row.state);

/** The line a life prints when pass 2 is under way, before the node's label. */
const PASS2_MARK = "pass2 ";

/** A pass 2 cross-examination whose input is with its model: the moment the kill mode waits for. */
const inPass2 = (row: WorkflowItemState | undefined) =>
  Object.values(row?.nodes ?? {}).find(
    (node) =>
      node.label.includes("pass 2") &&
      node.state === "running" &&
      node.stage === "submitted"
  );

/** Polls the ledger until the row ended or the deadline passed; the row as it stands then. */
const waitForEnd = (brain: KitBrain) =>
  Effect.gen(function* () {
    let marked = false;

    const read = Effect.promise(async () => {
      const ledger = await brain.harness.snapshot(
        WorkflowsDoc,
        brain.root,
        context
      );

      return ledger?.items[WF];
    });

    const poll = Effect.gen(function* () {
      for (;;) {
        const row = yield* read;

        if (ended(row)) {
          return row;
        }

        const pass2 = inPass2(row);

        if (values.mark && !marked && pass2 !== undefined) {
          marked = true;
          process.stdout.write(`${PASS2_MARK}${pass2.label}\n`);
        }

        yield* Effect.sleep(Duration.seconds(1));
      }
    });

    const row = yield* poll.pipe(Effect.timeoutOption(DEADLINE));

    return Option.isSome(row) ? row.value : yield* read;
  });

/** What is wrong with one node, if anything. */
const nodeFailures = (node: NodeItemState): ReadonlyArray<string> => {
  const want = ROLES.get(node.role ?? "");
  const ran = `${node.provider ?? ""}/${node.modelId ?? ""}`;
  const found: Array<string> = [];

  if (node.state !== "settled") {
    found.push(`${node.label}: ${node.state} (${node.error ?? ""})`);
  } else if (node.schemaAttempts < 1 || node.schemaAttempts > 2) {
    found.push(`${node.label}: ${String(node.schemaAttempts)} schema attempts`);
  }

  if (want === undefined || ran !== `${want.provider}/${want.modelId}`) {
    found.push(`${node.label}: ran on ${ran}`);
  }

  return found;
};

const lineOf = (node: NodeItemState): NodeLine => ({
  node: node.label,
  role: node.role,
  model: `${node.provider ?? ""}/${node.modelId ?? ""}`,
  state: node.state,
  schemaAttempts: node.schemaAttempts,
  attempt: node.attempt,
  totalTokens: node.receipt?.totalTokens ?? 0,
  listMicros: node.receipt?.listMicros ?? null,
  error: node.error,
});

const sum = (
  nodes: ReadonlyArray<NodeItemState>,
  of: (node: NodeItemState) => number
) => nodes.reduce((total, node) => total + of(node), 0);

/** Opens the brain, launches the council by name and waits for it: the row and the script's result. */
const runCouncil = Effect.gen(function* () {
  const source = yield* ModelSource;
  const codemode = yield* CodeMode;
  const results = yield* ResultTool;
  const bridgeCwd = yield* BridgeCwd;

  const plan = planAccess(
    yield* WorkflowPlan,
    Option.none(),
    yield* Effect.context()
  );

  const lifeDir = values.dir;

  const cwd =
    lifeDir === undefined
      ? mkdtempSync(path.join(tmpdir(), "cairn-council-typed-"))
      : path.join(lifeDir, "cwd");

  if (lifeDir === undefined) {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rmSync(cwd, { recursive: true, force: true });
      })
    );
  } else {
    mkdirSync(cwd, { recursive: true });
  }

  const storage =
    lifeDir === undefined
      ? undefined
      : yield* Effect.promise(
          async () => await openCouncilStore(path.join(lifeDir, "store.sqlite"))
        );

  const brain = yield* Effect.acquireRelease(
    Effect.promise(
      async () =>
        await openCouncilBrain(
          source.models(),
          [
            codemode.extension.extension,
            workflowExtension({
              resolveRole,
              plan,
              faults: NO_WORKFLOW_FAULTS,
              hold: NO_HOLD,
              holdRetryMillis: HOLD_RETRY_MILLIS,
            }).extension,
            results.extension.extension,
            bridgeCwd.extension.extension,
          ],
          cwd,
          storage
        )
    ),
    (open) =>
      Effect.promise(async () => {
        await open.harness.close(context);
      })
  );

  const planted = yield* Effect.promise(
    async () => await brain.harness.snapshot(WorkflowsDoc, brain.root, context)
  );

  if (planted?.items[WF] === undefined) {
    yield* plant(
      brain,
      BUILT_IN_RECIPES.get("council") ?? "",
      { ...plantDefaults(WF), args: ARGS },
      context
    );
  }

  // A later life resumes the tasks the killed one left on the store.
  brain.harness.resume();

  yield* Effect.promise(async () => {
    await runScript(brain, recipeReference("council"), "run-1", context);
  });

  const row = yield* waitForEnd(brain);

  const resultText = yield* Effect.promise(
    async () => await codemodeResultText(brain, context)
  );

  return { row, resultText };
});

const program = Effect.gen(function* () {
  const started = performance.now();
  const { row, resultText } = yield* runCouncil;

  const nodes = Object.values(row?.nodes ?? {}).toSorted(
    (a, b) => a.index - b.index
  );

  const failures = nodes.flatMap(nodeFailures);

  yield* Effect.forEach(nodes, (node) => print(lineOf(node)));

  if (row?.state !== "finished") {
    failures.push(`workflow ${row?.state ?? "missing"}`);
  }

  if (values.life) {
    const again = nodes.filter((node) => node.attempt !== 1);

    if (again.length > 0) {
      failures.push(
        `past a first attempt: ${again.map((node) => node.label).join(", ")}`
      );
    }
  }

  if (nodes.length !== 5) {
    failures.push(`${String(nodes.length)} nodes, want 5`);
  }

  const crossExam = Option.match(
    decodeRoster(
      resultText.slice(resultText.indexOf("{"), resultText.lastIndexOf("}") + 1)
    ),
    {
      onNone: (): ReadonlyArray<string> => [],
      onSome: (found) => found.roster.map((entry) => entry.crossExam.join(",")),
    }
  );

  if (crossExam.join(";") !== "resumed;resumed") {
    failures.push(
      `cross-examinations ${JSON.stringify(crossExam)}, want both resumed`
    );
  }

  yield* print({
    summary: true,
    pass: failures.length === 0,
    state: row?.state ?? "missing",
    nodes: nodes.length,
    crossExam,
    tokens: sum(nodes, (node) => node.receipt?.totalTokens ?? 0),
    costUsd: sum(nodes, (node) => node.receipt?.listMicros ?? 0) / 1_000_000,
    bridgeTokensPlanUsage: sum(
      nodes.filter((node) => node.provider === "claude-bridge"),
      (node) => node.receipt?.totalTokens ?? 0
    ),
    seconds: Math.round((performance.now() - started) / 1000),
    failures,
  });

  if (failures.length > 0) {
    return yield* new CouncilTypedFailed({
      message: `council-typed failed: ${failures.join("; ")}`,
    });
  }

  return nodes.length;
});

/** One life's arguments: this script over the store in `dir`, with the same role bindings. */
const lifeArgs = (dir: string, mark: boolean) => {
  const args = [
    import.meta.filename,
    "--life",
    "--dir",
    dir,
    "--bridge-model",
    values["bridge-model"],
    "--advisor-model",
    values["advisor-model"],
    "--judge-model",
    values["judge-model"],
  ];

  if (mark) {
    args.push("--mark");
  }

  return args;
};

const startLife = (dir: string, stdout: "pipe" | "inherit") =>
  Effect.sync(() =>
    spawn(process.execPath, lifeArgs(dir, stdout === "pipe"), {
      stdio: ["ignore", stdout, "inherit"],
    })
  );

/** The label of the first pass 2 marker `child` prints, passing its other lines on; none if it exits first. */
const waitForPass2 = (child: ChildProcess) =>
  Effect.callback<Option.Option<string>>((resume) => {
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith(PASS2_MARK)) {
          resume(Effect.succeedSome(line.slice(PASS2_MARK.length)));

          return;
        }

        process.stdout.write(`${line}\n`);
      }
    };

    const onExit = () => {
      resume(Effect.succeedNone);
    };

    child.stdout?.on("data", onData);
    child.once("exit", onExit);

    return Effect.sync(() => {
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    });
  });

/** The exit code of `child` once it is gone (1 for a signal). */
const exitOf = (child: ChildProcess) =>
  Effect.callback<number>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(child.exitCode ?? 1));

      return;
    }

    child.once("exit", (code) => {
      resume(Effect.succeed(code ?? 1));
    });
  });

/** Judge 6's kill: the first life is `kill -9`ed in pass 2, the second finishes the council. */
const killRun = Effect.gen(function* () {
  const dir = mkdtempSync(path.join(tmpdir(), "cairn-council-kill-"));

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      rmSync(dir, { recursive: true, force: true });
    })
  );

  const first = yield* startLife(dir, "pipe");

  const marker = yield* waitForPass2(first).pipe(
    Effect.timeoutOption(DEADLINE),
    Effect.map(Option.flatten)
  );

  if (Option.isNone(marker)) {
    first.kill("SIGKILL");

    return yield* new CouncilTypedFailed({
      message: "the first life ended or ran out of time before pass 2; no kill",
    });
  }

  yield* Effect.sleep(Duration.seconds(2));

  const live = first.exitCode === null && first.signalCode === null;

  first.kill("SIGKILL");
  yield* exitOf(first);
  process.stdout.write(
    `${JSON.stringify({ kill: "SIGKILL", after: marker.value, live })}\n`
  );

  if (!live) {
    return yield* new CouncilTypedFailed({
      message: "the first life had ended before the kill",
    });
  }

  const code = yield* exitOf(yield* startLife(dir, "inherit"));

  if (code !== 0) {
    return yield* new CouncilTypedFailed({
      message: `the second life failed (exit ${String(code)})`,
    });
  }

  return 5;
});

// A life of `--kill-in-pass-2` keeps its data inside the run's folder, which the judge removes
// whether or not the life was killed; a killed life runs no finalizer of its own.
const dataDir =
  values.dir === undefined
    ? mkdtempSync(path.join(tmpdir(), "cairn-council-typed-data-"))
    : path.join(values.dir, "data");

mkdirSync(dataDir, { recursive: true });

const root = councilRoot();

// The bridge on the real Agent SDK and the `claude` binary's login.
const bridgeLayer = BridgeCwd.layer.pipe(
  Layer.provideMerge(BridgeProvider.layerNoDeps),
  Layer.provideMerge(
    ClaudeUsage.layerBridgeNoDeps.pipe(Layer.provideMerge(ClaudeSdk.layer))
  )
);

const modelsLayer = PiModelSource.layer.pipe(
  Layer.provide(
    Layer.effect(
      ExtraProviders,
      BridgeProvider.useSync((bridge) => [
        ...Option.toArray(
          Option.map(bridge.claude, (claude) => claude.provider)
        ),
        root.provider,
      ])
    )
  ),
  Layer.provide(ServerConfig.layerWith({ dataDir })),
  Layer.orDie
);

const lifeProgram = program.pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      modelsLayer,
      CodeMode.layer,
      ResultTool.layer,
      WorkflowPlan.layer
    ).pipe(
      Layer.provideMerge(bridgeLayer),
      Layer.provideMerge(NodeServices.layer),
      // Logs go to stderr, so stdout carries only the JSON lines.
      Layer.provideMerge(
        Logger.layer([Logger.withConsoleError(Logger.formatSimple)])
      )
    )
  )
);

NodeRuntime.runMain(
  (values["kill-in-pass-2"] && !values.life
    ? killRun.pipe(Effect.scoped)
    : lifeProgram
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        rmSync(dataDir, { recursive: true, force: true });
      })
    ),
    // The failure goes to stderr too; runMain's own report would land on stdout.
    Effect.tapCause((cause) =>
      Effect.sync(() => {
        process.stderr.write(`${Cause.pretty(cause)}\n`);
      })
    )
  ),
  { disableErrorReporting: true }
);
