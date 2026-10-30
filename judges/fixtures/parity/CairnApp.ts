// The Cairn half of the parity judges (plan 4F): the real web client over a real in-process brain,
// seeded with what t3code showed, so the judges drive the same `update` and `view` the live app
// runs. Used by judges/capture.ts (hero and thread states), judges/behaviour.ts and judges/surfaces.ts.
//
// The brain is AppLayer over the scripted harness on an ephemeral loopback port, with Vite in front
// of it on another, as judges/typing.ts runs it. `restartBrain` closes the brain and opens it again
// over the same scripted store and data folder (the brief card judge's restart). Seeding happens
// before the page opens:
// - one folder project with t3code's draft project title, rooted in a temporary git repository
//   with a README and a docs folder (so the `@` menu has paths to find, but none for `@src`,
//   which t3code's read-only pairing cannot search either);
// - one thread with t3code's thread title whose conversation holds the entries the t3code importer
//   (apps/server/src/brain/conformance/fixtures/T3Import.ts) made from t3code's projection. They
//   are written into the scripted store before any client subscribes, so the first snapshot the
//   page receives already holds the whole conversation.
// Production's port 3774 and the deployed brain's data are never touched.

import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  ApprovalId,
  CommandId,
  ConversationId,
  EntryId,
  ProjectId,
  TaskId,
  ThreadId,
} from "@cairn/protocol/Ids";
import type { RoleTable } from "@cairn/protocol/Roles";
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
} from "effect";
import { createServer as createViteServer } from "vite";

import {
  AppLayer,
  HarnessBoot,
  SettingsLive,
  withCatalog,
} from "../../../apps/server/src/AppLayer.ts";
import { BudgetSources } from "../../../apps/server/src/brain/BudgetSources.ts";
import type { ImportedEntry } from "../../../apps/server/src/brain/conformance/fixtures/T3Import.ts";
import { HarnessSeam } from "../../../apps/server/src/brain/HarnessSeam.ts";
import { ModelSource } from "../../../apps/server/src/brain/ModelSource.ts";
import {
  piConversationId,
  piEntryId,
} from "../../../apps/server/src/brain/PiIds.ts";
import { EventReactors } from "../../../apps/server/src/brain/EventReactors.ts";
import { SpendFeed } from "../../../apps/server/src/brain/SpendFeed.ts";
import {
  ScriptedBoot,
  ScriptedHarness,
  ScriptedModel,
  ScriptedRoleTable,
  ScriptedStore,
  ScriptedTools,
  scriptedAnswer,
} from "../../../apps/server/src/brain/ScriptedHarness.ts";
import { SettingsStore } from "../../../apps/server/src/models/SettingsStore.ts";
import { ServerConfig } from "../../../apps/server/src/Config.ts";
import { ExecutorLink } from "../../../apps/server/src/executor/ExecutorLink.ts";
import { ReachMachine } from "../../../apps/server/src/reach/ReachLayer.ts";
import { Identity } from "../../../apps/server/src/http/Identity.ts";
import { EventSink } from "../../../apps/server/src/shell/EventSink.ts";
import {
  emptyActivityPatch,
  ProjectRegister,
  ThreadActivityUpdate,
  ThreadCreate,
} from "../../../apps/server/src/shell/ShellCommands.ts";
import type { ThreadActivityPatch } from "../../../apps/server/src/shell/ShellCommands.ts";
import { GoalBook } from "../../../apps/server/src/verdicts/GoalBook.ts";
import { WorkflowStops } from "../../../apps/server/src/workflows/WorkflowStop.ts";

const root = path.join(import.meta.dirname, "../../..");

const LOOPBACK = "127.0.0.1";

export const PARITY_THREAD_ID = ThreadId.make(
  "019a0000-0000-7000-8000-00000000a4f1"
);

const PROJECT_ID = ProjectId.make("prj_parity_judge");

/** What the Cairn half is seeded with. */
export interface CairnSeed {
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly entries: ReadonlyArray<ImportedEntry>;
}

/** What a seeded managed thread is doing, as its shell row says. */
export type ManagedState =
  | "asking"
  | "working"
  | "failed"
  | "done"
  | "idle"
  | "parked";

/** A thread the seeded project thread manages (a subagent row, ADR 0028). */
export interface ManagedSeed {
  readonly title: string;
  readonly state: ManagedState;
  /** Made in the harness too, so it opens and takes messages; the others are rows only. */
  readonly usable: boolean;
}

/** Another folder project on the rail, with a favicon in its root or none. */
export interface ProjectSeed {
  readonly title: string;
  readonly favicon: boolean;
}

/**
 * The `next` shell's seed (look track L6): the seeded thread made its project's project thread,
 * the threads it manages, and more projects for the rail. Classic judges pass none, so what they
 * capture is unchanged.
 */
export interface ShellSeed {
  readonly managed: ReadonlyArray<ManagedSeed>;
  readonly projects: ReadonlyArray<ProjectSeed>;
}

/** No shell seed: one project, one thread, as the classic judges have it. */
export const NO_SHELL_SEED: ShellSeed = { managed: [], projects: [] };

/** The managed threads the `next` judges seed (behaviour.ts `--ui next`, look.ts), oldest first; the list shows them newest first. */
export const MANAGED_SEED: ShellSeed["managed"] = [
  { title: "Map the favicon resolver", state: "idle", usable: true },
  { title: "Brief: port the fold line tallies", state: "done", usable: false },
  { title: "Steps panel projection", state: "parked", usable: false },
  { title: "Probe the bridge usage endpoint", state: "failed", usable: false },
  { title: "Review: steps panel", state: "working", usable: false },
  {
    title: "Pick the budget meter's thresholds",
    state: "asking",
    usable: false,
  },
];

/** The `next` shell's seed: managed threads and two more rail projects, one with a favicon. */
export const SHELL_SEED: ShellSeed = {
  managed: MANAGED_SEED,
  projects: [
    { title: "oscargabriel-dev", favicon: true },
    { title: "myr", favicon: false },
  ],
};

/**
 * The scripted brain's model and tools, when a judge needs other answers than "Noted." and the
 * echo tool (judges/surfaces.ts gives a model that asks for approvals and questions).
 */
export interface CairnBrain {
  readonly model: Layer.Layer<ScriptedModel>;
  readonly tools: Layer.Layer<ScriptedTools>;
  /**
   * The workflow stops the page's Stop reaches (the workflow surfaces judge plays its own ledger,
   * plan 6F); none runs no workflows (`WorkflowStops.layerOff`).
   */
  readonly stops?: Layer.Layer<WorkflowStops>;
}

/**
 * The role tables a judge gives (the brief card judge, plan 6B): the brain's settings table, which
 * `roles.check` reads, and the scripted harness's, which its `subagent_spawn` and Go resolve
 * through. Two tables, so a brief can name a role the settings no longer bind, as when the table
 * changed after the brief was asked.
 */
export interface CairnRoles {
  readonly settings: RoleTable;
  readonly scripted: RoleTable;
}

/** A running Cairn: the page origin, the seeded thread's URL, and how to stop it. */
export interface CairnApp {
  readonly origin: string;
  readonly threadUrl: string;
  /**
   * Closes the brain and opens a new one over the same store and data folder on the same port, as
   * a restart does (the scripted harness resumes from its store); the page reconnects on its own.
   */
  readonly restartBrain: () => Promise<void>;
  /** How many threads the scripted store holds: the seeded ones and every child started. */
  readonly threadCount: () => number;
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

/** A small git repository for the project, so path search has files to list. */
const makeWorkspace = (base: string, title: string): string => {
  const workspace = path.join(base, title);

  mkdirSync(path.join(workspace, "docs"), { recursive: true });
  writeFileSync(path.join(workspace, "README.md"), `# ${title}\n`);
  writeFileSync(path.join(workspace, "docs/guide.md"), "# Guide\n");
  writeFileSync(path.join(workspace, "package.json"), "{}\n");

  const git = (...args: ReadonlyArray<string>) =>
    execFileSync(
      "git",
      ["-c", "user.name=parity", "-c", "user.email=parity@localhost", ...args],
      { cwd: workspace, stdio: "ignore" }
    );

  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  return workspace;
};

/** The scripted model answers at once, so a send from a behaviour check settles quickly. */
const QuickModel = Layer.succeed(
  ScriptedModel,
  ScriptedModel.of({
    answer: () =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        scriptedAnswer("Noted.", now)
      ),
  })
);

/** The parity judges' brain: "Noted." at once, and the echo tool. */
const QUICK_BRAIN: CairnBrain = {
  model: QuickModel,
  tools: ScriptedTools.layerEcho,
};

/** A favicon for a seeded rail project: a filled square, so a screenshot shows it edge to edge. */
const SEED_FAVICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#2f6f4f"/><path d="M8 22 16 8l8 14z" fill="#f2efe6"/></svg>\n';

/** A seeded id: `019a0000-0000-7000-8000-` and twelve hex digits from `prefix` and `index`. */
const seededId = (prefix: string, index: number): string =>
  `019a0000-0000-7000-8000-${prefix}${index.toString(16).padStart(12 - prefix.length, "0")}`;

/** The activity patch that puts a seeded managed row in each state, from when its run started. */
const PATCHES: Readonly<
  Record<
    ManagedState,
    (started: DateTime.Utc, index: number) => ThreadActivityPatch
  >
> = {
  asking: (started, index) => ({
    ...emptyActivityPatch,
    activity: Option.some("waiting"),
    latestRunStartedAt: Option.some(Option.some(started)),
    pendingRuntimeRequest: Option.some(
      Option.some({
        id: ApprovalId.make(`approval-shell-${index}`),
        kind: "tool-call",
        createdAt: started,
        origin: Option.none(),
      })
    ),
    pendingCount: Option.some(1),
  }),
  working: (started) => ({
    ...emptyActivityPatch,
    activity: Option.some("running"),
    latestRunStartedAt: Option.some(Option.some(started)),
  }),
  failed: (started) => ({
    ...emptyActivityPatch,
    activity: Option.some("failed"),
    latestRunStartedAt: Option.some(Option.some(started)),
    lastError: Option.some(Option.some("The provider answered 500.")),
    lastErrorClass: Option.some(Option.some("provider_error")),
  }),
  done: (started) => ({
    ...emptyActivityPatch,
    latestRunStartedAt: Option.some(Option.some(started)),
    latestRunCompletedAt: Option.some(Option.some(started)),
  }),
  parked: (started) => ({
    ...emptyActivityPatch,
    activity: Option.some("parked"),
    latestRunStartedAt: Option.some(Option.some(started)),
    parkedTaskIds: Option.some([TaskId.make(7)]),
  }),
  idle: () => emptyActivityPatch,
};

const seedShell = (shellSeed: ShellSeed, dataDir: string) =>
  Effect.gen(function* () {
    const sink = yield* EventSink;
    const seam = yield* HarnessSeam;
    const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);

    for (const [index, managed] of shellSeed.managed.entries()) {
      const threadId = ThreadId.make(seededId("b", index + 1));

      yield* sink.commitCommand(
        ThreadCreate.make({
          commandId: CommandId.make(seededId("c", index + 1)),
          threadId,
          projectId: PROJECT_ID,
          title: managed.title,
          provider: "scripted",
          modelId: "echo",
          thinkingLevel: "medium",
          runtimeMode: "full-access",
          branch: Option.none(),
          worktreePath: Option.none(),
          lineage: Option.some({
            parentThreadId: PARITY_THREAD_ID,
            relationshipToParent: "subagent",
            rootThreadId: PARITY_THREAD_ID,
          }),
        })
      );

      // A usable row is a real thread the harness made; the others only say what they are doing.
      yield* managed.usable
        ? Effect.asVoid(
            seam.ensureThread({
              threadId,
              projectId: PROJECT_ID,
              model: { provider: "scripted", modelId: "echo" },
              thinkingLevel: "medium",
              cwd: dataDir,
              instructions: Option.none(),
              runtimeMode: "full-access",
            })
          )
        : Effect.asVoid(
            sink.commitCommand(
              ThreadActivityUpdate.make({
                commandId: CommandId.make(seededId("d", index + 1)),
                threadId,
                patch: PATCHES[managed.state](
                  DateTime.subtract(now, { minutes: 3 + index * 7 }),
                  index
                ),
              })
            )
          );
    }

    for (const [index, project] of shellSeed.projects.entries()) {
      const projectRoot = makeWorkspace(dataDir, project.title);

      if (project.favicon) {
        writeFileSync(path.join(projectRoot, "favicon.svg"), SEED_FAVICON);
      }

      yield* sink.commitCommand(
        ProjectRegister.make({
          commandId: CommandId.make(seededId("e", index + 1)),
          projectId: ProjectId.make(`prj_shell_${index + 1}`),
          kind: "folder",
          title: project.title,
          workspaceRoot: projectRoot,
          repository: Option.none(),
        })
      );
    }
  });

const seedLayer = (
  seed: CairnSeed,
  workspace: string,
  shellSeed: ShellSeed,
  dataDir: string
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sink = yield* EventSink;
      const seam = yield* HarnessSeam;
      const store = yield* ScriptedStore;

      const isShell =
        shellSeed.managed.length > 0 || shellSeed.projects.length > 0;

      yield* sink.commitCommand(
        ProjectRegister.make({
          commandId: CommandId.make("019a0000-0000-7000-8000-00000000a4f2"),
          projectId: PROJECT_ID,
          kind: "folder",
          title: seed.projectTitle,
          workspaceRoot: workspace,
          repository: Option.none(),
        })
      );

      const create = {
        commandId: CommandId.make("019a0000-0000-7000-8000-00000000a4f3"),
        threadId: PARITY_THREAD_ID,
        projectId: PROJECT_ID,
        title: seed.threadTitle,
        provider: "scripted",
        modelId: "echo",
        thinkingLevel: "medium",
        runtimeMode: "full-access",
        branch: Option.none(),
        worktreePath: Option.none(),
      } as const;

      // With a shell seed the thread is its project's project thread (5H), as a first launch makes it.
      yield* sink.commitCommand(
        isShell
          ? ThreadCreate.make({
              ...create,
              projectThread: { replaces: Option.none() },
            })
          : ThreadCreate.make(create)
      );
      yield* seam.ensureThread({
        threadId: PARITY_THREAD_ID,
        projectId: PROJECT_ID,
        model: { provider: "scripted", modelId: "echo" },
        thinkingLevel: "medium",
        cwd: workspace,
        instructions: Option.none(),
        runtimeMode: "full-access",
      });

      // `ensureThread` above made it; its absence is a broken harness, so a defect.
      const thread = yield* Effect.orDie(
        Effect.fromNullishOr(store.threads.get(PARITY_THREAD_ID))
      );

      const conversationId = piConversationId(
        ConversationId.make(thread.conversationId)
      );

      for (const entry of seed.entries) {
        const id = store.ids.next;

        store.ids.next += 1;
        thread.entries.push({
          id: piEntryId(EntryId.make(id)),
          conversationId,
          kind: entry.kind,
          model: [...entry.model],
        });
      }

      // The harness publishes its view on a change it made; an unchanged setting is such a change
      // and puts the seeded entries in the view every subscriber starts from.
      yield* seam.configure(PARITY_THREAD_ID, {
        model: Option.none(),
        thinkingLevel: Option.some("medium"),
        cwd: Option.none(),
        runtimeMode: Option.none(),
      });

      if (isShell) {
        yield* seedShell(shellSeed, dataDir);
      }
    })
  );

/** What a judge changes from the parity default: the brain's answers, and the shell's seed. */
export interface CairnOptions {
  /** The scripted model and tools; "Noted." and the echo tool when absent. */
  readonly brain?: CairnBrain;
  /** The `next` shell's seed; none when absent, so classic judges capture what they did. */
  readonly shell?: ShellSeed;
  /** The role tables; the default table in both when absent. */
  readonly roles?: CairnRoles;
}

/** Writes the settings' role table, when a judge gives one. */
const seedRoles = (roles: CairnRoles | undefined) =>
  roles === undefined
    ? Layer.empty
    : Layer.effectDiscard(
        SettingsStore.use((settings) =>
          settings.update({
            autoSettleDays: Option.none(),
            titleModel: Option.none(),
            bridgeEnabled: Option.none(),
            bridgeGenerationCap: Option.none(),
            roleBindings: Option.some(roles.settings),
            defaultBudget: Option.none(),
          })
        ).pipe(Effect.orDie)
      ).pipe(Layer.provide(SettingsLive));

/**
 * Starts the brain and Vite, seeded; nothing listens outside loopback. A shell seed adds the
 * project thread's managed threads and more rail projects (the `next` shell's judges).
 */
export const startCairn = async (
  seed: CairnSeed,
  options: CairnOptions = {}
): Promise<CairnApp> => {
  const brain = options.brain ?? QUICK_BRAIN;
  const shellSeed = options.shell ?? NO_SHELL_SEED;
  const vitePort = await freePort();
  const brainPort = await freePort();
  const origin = `http://${LOOPBACK}:${vitePort}`;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cairn-parity-"));
  const workspace = makeWorkspace(dataDir, seed.projectTitle);

  // One store for every life of the brain, so `restartBrain` is a restart and not a new brain.
  const store = ScriptedStore.of({
    threads: new Map(),
    reporters: new Map(),
    ids: { next: 1 },
  });

  const Harness = Layer.mergeAll(
    Layer.succeed(HarnessBoot, HarnessBoot.of({ resume: Effect.void })),
    EventReactors.layerOff,
    SpendFeed.layerOff,
    BudgetSources.layerNone,
    brain.stops ?? WorkflowStops.layerOff,
    GoalBook.layerOff
  ).pipe(
    Layer.provideMerge(ScriptedHarness.layerNoDeps),
    Layer.provideMerge(Layer.succeed(ScriptedStore, store)),
    Layer.provide(brain.model),
    Layer.provide(brain.tools),
    Layer.provide(
      options.roles === undefined
        ? Layer.empty
        : Layer.succeed(ScriptedRoleTable, options.roles.scripted)
    ),
    Layer.provideMerge(
      withCatalog(
        ModelSource.layerFaux({
          tokensPerSecond: 200,
          settings: {},
          // The model t3code's baseline shows, so the footer folds at the same widths.
          name: "Claude Fable 5.1",
        })
      )
    )
  );

  // A later life seeds nothing: it resumes what the store and the data folder hold.
  const seeded = Layer.merge(
    seedLayer(seed, workspace, shellSeed, dataDir),
    seedRoles(options.roles)
  );

  const resumed = Layer.effectDiscard(
    ScriptedBoot.use((boot) => boot.resume)
  );

  type Top = Layer.Layer<
    never,
    Layer.Error<typeof seeded>,
    Layer.Services<typeof seeded> | Layer.Services<typeof resumed>
  >;

  const seededTop: Top = seeded;
  const resumedTop: Top = resumed;

  const life = (first: boolean) =>
    (first ? seededTop : resumedTop).pipe(
    Layer.provideMerge(AppLayer),
    Layer.provideMerge(Harness),
    Layer.provide(ReachMachine.layerTest),
    Layer.provide(ExecutorLink.layerDisabled),
    Layer.provide(Identity.layerLoopbackOwner),
    Layer.provide(
      ServerConfig.layerWith({
        host: `${LOOPBACK}:${vitePort}`,
        origin,
        owner: "parity-judge",
        listenHost: LOOPBACK,
        port: brainPort,
        dataDir,
        webRoot: path.join(dataDir, "no-web"),
      })
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error"))
  );

  let runtime = ManagedRuntime.make(life(true));

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
    threadUrl: `${origin}/t/${PARITY_THREAD_ID}`,
    restartBrain: async () => {
      await runtime.dispose();
      runtime = ManagedRuntime.make(life(false));
      await runtime.runPromise(Effect.void);
    },
    threadCount: () => store.threads.size,
    stop: async () => {
      await vite.close();
      await runtime.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
};
