// The brain the meters judge plays against (plan 6G, judges/meters.ts): the real web client over a
// real in-process brain on the scripted harness, as judges/fixtures/parity/CairnApp.ts runs one,
// seeded with the readings the usage page and the role table must show, each with a known truth:
//
// - a catalog of the user's plans: the Claude bridge (Opus, Sonnet), OpenCode Go (gpt-6-luna, and
//   `beam-free`, which has no list price) and a metered `openrouter` model; no Codex model;
// - three threads with spend recorded through the spend ledger's own `recordCall`: one on the
//   bridge at $1.00 (a plan's list price), one on `beam-free` (60,000 tokens with no price), and one
//   on gpt-6-luna and the metered model ($0.25 and $0.10);
// - two budgets declared through `Budgets.declare` over in-memory sources: the bridge thread at
//   110,000 tokens (past its warning line) and the gpt-6-luna thread at $0.20 (reached);
// - the Claude plan's windows from a stand-in usage service: the session window read at 42%, the
//   weekly window unknown, the Opus window spent; no Codex login, so no Codex row; OpenCode Go
//   ready, so its row says `unsupported`;
// - the role table the deployed brain still holds: `@verifier` on Codex `gpt-6-luna` with no
//   fallback, so it resolves to no ready model until the user rebinds it.
//
// Production's port 3774 and the deployed brain's data are never touched.

import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { ClaudeUsage, INITIAL_READING } from "@cairn/bridge/ClaudeUsage";
import { CommandId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { DEFAULT_ROLE_TABLE, RoleName } from "@cairn/protocol/Roles";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { ProviderUsage } from "@cairn/protocol/Usage";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { NodeServices } from "@effect/platform-node";
import {
  Clock,
  DateTime,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  References,
  Stream,
} from "effect";
import { createServer as createViteServer } from "vite";

import {
  AppLayer,
  HarnessBoot,
  SettingsLive,
} from "../../../apps/server/src/AppLayer.ts";
import { EventReactors } from "../../../apps/server/src/brain/EventReactors.ts";
import { ModelSource } from "../../../apps/server/src/brain/ModelSource.ts";
import {
  ScriptedHarness,
  ScriptedModel,
  ScriptedStore,
  ScriptedTools,
  scriptedAnswer,
} from "../../../apps/server/src/brain/ScriptedHarness.ts";
import { SpendFeed } from "../../../apps/server/src/brain/SpendFeed.ts";
import {
  piUsageOf,
  usageOf,
} from "../../../apps/server/src/brain/SpendTestKit.ts";
import { ServerConfig } from "../../../apps/server/src/Config.ts";
import { ExecutorLink } from "../../../apps/server/src/executor/ExecutorLink.ts";
import { Identity } from "../../../apps/server/src/http/Identity.ts";
import { BridgeProvider } from "../../../apps/server/src/models/BridgeProvider.ts";
import { PiModelSource } from "../../../apps/server/src/models/PiModelSource.ts";
import { SettingsStore } from "../../../apps/server/src/models/SettingsStore.ts";
import { ReachMachine } from "../../../apps/server/src/reach/ReachLayer.ts";
import { EventSink } from "../../../apps/server/src/shell/EventSink.ts";
import {
  ProjectRegister,
  ThreadCreate,
} from "../../../apps/server/src/shell/ShellCommands.ts";
import { Budgets } from "../../../apps/server/src/usage/Budgets.ts";
import { SourcesMemory } from "../../../apps/server/src/usage/BudgetTestKit.ts";
import { SpendLedger } from "../../../apps/server/src/usage/SpendLedger.ts";
import { GoalBook } from "../../../apps/server/src/verdicts/GoalBook.ts";
import { WorkflowStops } from "../../../apps/server/src/workflows/WorkflowStop.ts";

const root = path.join(import.meta.dirname, "../../..");

const LOOPBACK = "127.0.0.1";

const PROJECT_ID = ProjectId.make("prj_meters_judge");

/** The bridge thread: $1.00 at a plan's list price, past its 110,000-token warning line. */
export const BRIDGE_THREAD = ThreadId.make(
  "019a0000-0000-7000-8000-00000000b601"
);

/** The thread on a model with no list price: 60,000 tokens, no dollars. */
export const UNPRICED_THREAD = ThreadId.make(
  "019a0000-0000-7000-8000-00000000b602"
);

/** The thread on gpt-6-luna and a metered model: $0.35, at its $0.20 line. */
export const LUNA_THREAD = ThreadId.make(
  "019a0000-0000-7000-8000-00000000b603"
);

/** The model with no list price. */
export const UNPRICED_MODEL = "opencode-go/beam-free";

/** A running Cairn and how to stop it. */
export interface MetersApp {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

const freePort = async (): Promise<number> => {
  const server = createNetServer().listen(0, LOOPBACK);

  await once(server, "listening");

  const address = server.address();

  server.close();
  await once(server, "close");

  if (address === null || Predicate.isString(address)) {
    throw new Error("The kernel gave no loopback port.");
  }

  return address.port;
};

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const priced = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

/** The user's plans as pi's model runtime lists them; no Codex model, as there is no login. */
const catalog = () => {
  const models = createModels();

  for (const [provider, ids] of [
    ["claude-bridge", ["claude-opus-5-5", "claude-sonnet-5-5"]],
    ["openrouter", ["qwen3.8-flash"]],
  ] as const) {
    models.setProvider(
      fauxProvider({
        provider,
        models: ids.map((id) => ({ id, reasoning: true, cost: priced })),
      }).provider
    );
  }

  // OpenCode Go's free model lists no price.
  models.setProvider(
    fauxProvider({
      provider: "opencode-go",
      models: [
        { id: "gpt-6-luna", reasoning: true, cost: priced },
        { id: "beam-free", cost: zero },
      ],
    }).provider
  );

  return models;
};

const Models = Layer.mock(ModelSource)({
  models: () => catalog(),
  settings: () => ({}),
});

/** One recorded response of `input` tokens costing `dollars` (0: no cost recorded). */
const response = (
  provider: string,
  model: string,
  input: number,
  dollars: number
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  api: "faux",
  provider,
  model,
  usage: piUsageOf(usageOf({ input, costTotal: dollars })),
  stopReason: "stop",
  timestamp: 0,
});

const RESETS = DateTime.makeUnsafe("2026-11-02T15:00:00Z");

/** The Claude plan's windows: one read, one unknown, one spent. */
const CLAUDE_ROWS: ReadonlyArray<ProviderUsage> = [
  {
    provider: "claude-bridge",
    reading: "read",
    windows: [
      {
        id: "five_hour",
        label: "Session",
        used: Option.some(0.42),
        resetsAt: Option.some(RESETS),
        exhausted: false,
      },
      {
        id: "seven_day",
        label: "Weekly",
        used: Option.none(),
        resetsAt: Option.none(),
        exhausted: false,
      },
      {
        id: "seven_day_opus",
        label: "Weekly (Opus)",
        used: Option.some(1),
        resetsAt: Option.some(RESETS),
        exhausted: true,
      },
    ],
    checkedAt: Option.none(),
  },
];

/** A bridge with no Claude Code behind it, whose usage service reports `CLAUDE_ROWS`. */
const Bridge = Layer.succeed(BridgeProvider, {
  claude: Option.none(),
  usage: Option.some(
    ClaudeUsage.of({
      current: Effect.succeed(INITIAL_READING),
      changes: Stream.concat(Stream.succeed(INITIAL_READING), Stream.never),
      watch: Stream.concat(Stream.succeed(CLAUDE_ROWS), Stream.never),
      observe: () => Effect.void,
      probe: Effect.void,
    })
  ),
});

/** The scripted model answers at once. */
const QuickModel = Layer.succeed(
  ScriptedModel,
  ScriptedModel.of({
    answer: () =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        scriptedAnswer("Noted.", now)
      ),
  })
);

const threadCreate = (index: number, threadId: ThreadId, title: string) =>
  ThreadCreate.make({
    commandId: CommandId.make(
      `019a0000-0000-7000-8000-00000000b61${String(index)}`
    ),
    threadId,
    projectId: PROJECT_ID,
    title,
    provider: "scripted",
    modelId: "echo",
    thinkingLevel: "medium",
    runtimeMode: "full-access",
    branch: Option.none(),
    worktreePath: Option.none(),
  });

const seedLayer = (workspace: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sink = yield* EventSink;
      const ledger = yield* SpendLedger;
      const budgets = yield* Budgets;
      const settings = yield* SettingsStore;

      yield* sink.commitCommand(
        ProjectRegister.make({
          commandId: CommandId.make("019a0000-0000-7000-8000-00000000b600"),
          projectId: PROJECT_ID,
          kind: "folder",
          title: "Meters",
          workspaceRoot: workspace,
          repository: Option.none(),
        })
      );
      yield* sink.commitCommand(
        threadCreate(1, BRIDGE_THREAD, "Port the parser")
      );
      yield* sink.commitCommand(
        threadCreate(2, UNPRICED_THREAD, "Free model notes")
      );
      yield* sink.commitCommand(
        threadCreate(3, LUNA_THREAD, "Review the plan")
      );

      const record = (
        threadId: ThreadId,
        key: string,
        message: AssistantMessage
      ) =>
        ledger.recordCall(
          { source: "meters-judge", key, threadId: Option.some(threadId) },
          message
        );

      yield* record(
        BRIDGE_THREAD,
        "bridge",
        response("claude-bridge", "claude-opus-5-5", 100_000, 1)
      );
      yield* record(
        UNPRICED_THREAD,
        "free",
        response("opencode-go", "beam-free", 60_000, 0)
      );
      yield* record(
        LUNA_THREAD,
        "luna",
        response("opencode-go", "gpt-6-luna", 15_000, 0.25)
      );
      yield* record(
        LUNA_THREAD,
        "metered",
        response("openrouter", "qwen3.8-flash", 5000, 0.1)
      );
      yield* ledger.flush;

      yield* budgets.declare(
        BRIDGE_THREAD,
        { ...DEFAULT_BUDGET, maxTokens: 110_000 },
        "drain"
      );
      yield* budgets.declare(
        LUNA_THREAD,
        { ...DEFAULT_BUDGET, maxListMicros: Micros.make(200_000) },
        "drain"
      );
      yield* ledger.touch([BRIDGE_THREAD, LUNA_THREAD]);
      yield* ledger.flush;

      // The deployed brain's table: `@verifier` still on Codex, seeded before 2026-10-29.
      const verifier = RoleName.make("@verifier");

      yield* settings.update({
        autoSettleDays: Option.none(),
        titleModel: Option.none(),
        bridgeEnabled: Option.none(),
        bridgeGenerationCap: Option.none(),
        roleBindings: Option.some({
          ...DEFAULT_ROLE_TABLE,
          [verifier]: {
            model: { provider: "openai-codex", modelId: "gpt-6-luna" },
            thinkingLevel: Option.none(),
            fallbacks: [],
            note: Option.none(),
          },
        }),
        defaultBudget: Option.some({
          ...DEFAULT_BUDGET,
          maxTokens: 200_000,
        }),
      });
    }).pipe(Effect.orDie)
  );

/** Starts the brain and Vite, seeded; nothing listens outside loopback. */
export const startMeters = async (): Promise<MetersApp> => {
  const vitePort = await freePort();
  const brainPort = await freePort();
  const origin = `http://${LOOPBACK}:${vitePort}`;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cairn-meters-"));

  const Harness = Layer.mergeAll(
    Layer.succeed(HarnessBoot, HarnessBoot.of({ resume: Effect.void })),
    EventReactors.layerOff,
    SpendFeed.layerOff,
    WorkflowStops.layerOff,
    GoalBook.layerOff
  ).pipe(
    Layer.provideMerge(SourcesMemory),
    Layer.provideMerge(ScriptedHarness.layerNoDeps),
    Layer.provideMerge(ScriptedStore.layer),
    Layer.provide(QuickModel),
    Layer.provide(ScriptedTools.layerEcho),
    Layer.provideMerge(
      PiModelSource.layerFromModelSource.pipe(Layer.provideMerge(Models))
    )
  );

  const App = seedLayer(dataDir).pipe(
    Layer.provide(SettingsLive),
    Layer.provideMerge(AppLayer),
    Layer.provideMerge(Harness),
    Layer.provide(Bridge),
    Layer.provide(ReachMachine.layerTest),
    Layer.provide(ExecutorLink.layerDisabled),
    Layer.provide(Identity.layerLoopbackOwner),
    Layer.provide(
      ServerConfig.layerWith({
        host: `${LOOPBACK}:${vitePort}`,
        origin,
        owner: "meters-judge",
        listenHost: LOOPBACK,
        port: brainPort,
        dataDir,
        webRoot: path.join(dataDir, "no-web"),
      })
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error"))
  );

  const runtime = ManagedRuntime.make(App);

  await runtime.runPromise(Effect.void);

  process.env.CAIRN_DEV_BRAIN = `http://${LOOPBACK}:${brainPort}`;

  const vite = await createViteServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    root: path.join(root, "apps/web"),
    logLevel: "error",
    server: { host: LOOPBACK, port: vitePort, strictPort: true },
  });

  await vite.listen();

  return {
    origin,
    stop: async () => {
      await vite.close();
      await runtime.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
};
