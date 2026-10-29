// The Cairn half of the parity judges (plan 4F): the real web client over a real in-process brain,
// seeded with what t3code showed, so the judges drive the same `update` and `view` the live app
// runs. Used by judges/capture.ts (hero and thread states) and judges/behaviour.ts.
//
// The brain is AppLayer over the scripted harness on an ephemeral loopback port, with Vite in front
// of it on another, as judges/typing.ts runs it. Seeding happens before the page opens:
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
  CommandId,
  ConversationId,
  EntryId,
  ProjectId,
  ThreadId,
} from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import {
  Clock,
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
  ScriptedHarness,
  ScriptedModel,
  ScriptedStore,
  ScriptedTools,
  scriptedAnswer,
} from "../../../apps/server/src/brain/ScriptedHarness.ts";
import { ServerConfig } from "../../../apps/server/src/Config.ts";
import { ExecutorLink } from "../../../apps/server/src/executor/ExecutorLink.ts";
import { ReachMachine } from "../../../apps/server/src/reach/ReachLayer.ts";
import { Identity } from "../../../apps/server/src/http/Identity.ts";
import { EventSink } from "../../../apps/server/src/shell/EventSink.ts";
import {
  ProjectRegister,
  ThreadCreate,
} from "../../../apps/server/src/shell/ShellCommands.ts";

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

/** A running Cairn: the page origin, the seeded thread's URL, and how to stop it. */
export interface CairnApp {
  readonly origin: string;
  readonly threadUrl: string;
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

const seedLayer = (seed: CairnSeed, workspace: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sink = yield* EventSink;
      const seam = yield* HarnessSeam;
      const store = yield* ScriptedStore;

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
      yield* sink.commitCommand(
        ThreadCreate.make({
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
        })
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
    })
  );

/** Starts the brain and Vite, seeded; nothing listens outside loopback. */
export const startCairn = async (seed: CairnSeed): Promise<CairnApp> => {
  const vitePort = await freePort();
  const brainPort = await freePort();
  const origin = `http://${LOOPBACK}:${vitePort}`;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cairn-parity-"));
  const workspace = makeWorkspace(dataDir, seed.projectTitle);

  const Harness = Layer.mergeAll(
    Layer.succeed(HarnessBoot, HarnessBoot.of({ resume: Effect.void })),
    EventReactors.layerOff,
    SpendFeed.layerOff,
    BudgetSources.layerNone
  ).pipe(
    Layer.provideMerge(ScriptedHarness.layerNoDeps),
    Layer.provideMerge(ScriptedStore.layer),
    Layer.provide(QuickModel),
    Layer.provide(ScriptedTools.layerEcho),
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

  const App = seedLayer(seed, workspace).pipe(
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
    threadUrl: `${origin}/t/${PARITY_THREAD_ID}`,
    stop: async () => {
      await vite.close();
      await runtime.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
};
