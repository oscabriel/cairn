// The portal tools under a real pi-durable Harness with a faux model, over `Portals` on a fake
// systemd, the fake porch and an in-memory cairn.sqlite: the model opens a portal named for the
// thread's branch and repository, lists it and closes it, and a call from a conversation that is not
// a Cairn thread is refused without touching anything.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ThreadId } from "@cairn/protocol/Ids";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";

import { ThreadMeta } from "../brain/CairnDocs.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { Git } from "../git/Git.ts";
import { testThreadId } from "../shell/ShellTestKit.ts";
import { makeFakePorch, PorchClient } from "./PorchClient.ts";
import { Portals } from "./Portals.ts";
import { PortalTools } from "./PortalTools.ts";
import { makeFakeUnits, PortalUnits } from "./PortalUnits.ts";

const context = BACKGROUND_CONTEXT;

const MODEL = { provider: "faux-portals", modelId: "small" };

/** The text of the latest tool result the model was shown. */
const lastToolResult = (transcript: TranscriptContext) => {
  const results = transcript.messages.filter(
    (message) => message.role === "toolResult"
  );

  return JSON.stringify(results.at(-1)?.content ?? []);
};

/** A git repository `repo` on branch `feat/Login`, inside a fresh scratch folder. */
const scratchRepo = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cairn-ptools-")));
  const repo = path.join(root, "repo");

  mkdirSync(repo);
  execFileSync("git", ["init", "--quiet", "--initial-branch=feat/Login"], {
    cwd: repo,
  });

  return { root, repo };
};

/** Fake systemd and porch, a migrated store, `Portals` and the tools over them. */
const stage = Effect.gen(function* () {
  const dirs = scratchRepo();
  const units = yield* makeFakeUnits;

  const porch = yield* makeFakePorch({
    domain: "example.test",
    artifacts: dirs.root,
  });

  const layer = PortalTools.layerNoDeps.pipe(
    Layer.provideMerge(Portals.layerNoDeps),
    Layer.provideMerge(Layer.succeed(PorchClient, porch.client)),
    Layer.provideMerge(Layer.succeed(PortalUnits, units.units)),
    Layer.provideMerge(Database.layerTest(migrations)),
    Layer.provide(Git.layer)
  );

  return { dirs, units, layer };
});

/** A Harness with the portal tools and a faux model scripted by `steps`, closed with the scope. */
const openHarness = (
  root: string,
  steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]
) =>
  Effect.gen(function* () {
    const { tools } = yield* PortalTools;
    const models = createModels();

    const faux = fauxProvider({
      provider: MODEL.provider,
      models: [{ id: MODEL.modelId }],
    });

    models.setProvider(faux.provider);
    faux.setResponses(steps);

    const registry = createRegistry();

    registry.install(defineExtension({ name: "test.portals", tools }));

    const storage = yield* Effect.promise(
      async () => await openNodeSqliteStorage(path.join(root, "brain.sqlite"))
    );

    return yield* Effect.acquireRelease(
      Effect.promise(
        async () => await Harness.open(storage, { models, registry }, context)
      ),
      (harness) =>
        Effect.promise(async () => {
          await harness.close(context);
        })
    );
  });

/** Runs one turn of a conversation in `cwd`, named `threadId` unless none is given. */
const turn = (
  harness: Awaited<ReturnType<typeof Harness.open>>,
  cwd: string,
  threadId: Option.Option<ThreadId>
) =>
  Effect.promise(async () => {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: MODEL, cwd },
        init: async (tx, id) => {
          if (Option.isSome(threadId)) {
            const meta = await tx.doc(ThreadMeta, id);

            meta.threadId = threadId.value;
          }
        },
      },
      context
    );

    await conversation.submit(
      { type: "input", content: "go", requestId: "r1" },
      context
    );
    await harness.waitForIdle(context);
  });

const rowStates = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql<{
    readonly name: string;
    readonly state: string;
  }>`SELECT name, state FROM portals`;
});

describe("the portal tools", () => {
  it.live(
    "open names the portal for the branch and repository, list shows it, close takes it down",
    () =>
      Effect.gen(function* () {
        const { dirs, units, layer } = yield* stage;
        const seen: Array<string> = [];

        const record = (transcript: TranscriptContext) => {
          seen.push(lastToolResult(transcript));
        };

        yield* Effect.gen(function* () {
          const harness = yield* openHarness(dirs.root, [
            fauxAssistantMessage(
              fauxToolCall("portal_open", {
                command: "python3 -m http.server $PORT --bind 127.0.0.1",
              }),
              { stopReason: "toolUse" }
            ),
            (transcript) => {
              record(transcript);

              return fauxAssistantMessage(fauxToolCall("portal_list", {}), {
                stopReason: "toolUse",
              });
            },
            (transcript) => {
              record(transcript);

              return fauxAssistantMessage(
                fauxToolCall("portal_close", { name: "feat-login" }),
                { stopReason: "toolUse" }
              );
            },
            (transcript) => {
              record(transcript);

              return fauxAssistantMessage("done");
            },
          ]);

          yield* turn(harness, dirs.repo, Option.some(testThreadId(1)));

          assert.lengthOf(seen, 3);
          assert.include(
            seen[0],
            "Portal feat-login--repo is open at https://feat-login--repo.example.test"
          );
          assert.include(seen[1], "feat-login--repo open");
          assert.include(seen[2], "Portal feat-login--repo is closed");
          assert.deepStrictEqual(yield* units.running, []);
          assert.strictEqual(yield* units.starts, 1);
          assert.deepStrictEqual(yield* rowStates, [
            { name: "feat-login--repo", state: "removed" },
          ]);
        }).pipe(Effect.provide(layer));

        rmSync(dirs.root, { recursive: true, force: true });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000
  );

  it.live("refuses a conversation that is not a Cairn thread", () =>
    Effect.gen(function* () {
      const { dirs, units, layer } = yield* stage;
      const seen: Array<string> = [];

      yield* Effect.gen(function* () {
        const harness = yield* openHarness(dirs.root, [
          fauxAssistantMessage(
            fauxToolCall("portal_open", { command: "true" }),
            { stopReason: "toolUse" }
          ),
          (transcript) => {
            seen.push(lastToolResult(transcript));

            return fauxAssistantMessage("done");
          },
        ]);

        yield* turn(harness, dirs.repo, Option.none());

        assert.lengthOf(seen, 1);
        assert.include(seen[0], "works only in a Cairn thread");
        assert.strictEqual(yield* units.starts, 0);
        assert.deepStrictEqual(yield* rowStates, []);
      }).pipe(Effect.provide(layer));

      rmSync(dirs.root, { recursive: true, force: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
