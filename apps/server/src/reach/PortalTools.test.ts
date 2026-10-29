// The portal tools under a real pi-durable Harness with a faux model, over `Portals` on a fake
// systemd, the fake porch and an in-memory cairn.sqlite: the model opens a portal named for the
// thread's branch and repository, lists it and closes it, and a call from a conversation that is not
// a Cairn thread is refused without touching anything. A Harness closed while `portal_open` is
// mid-call, after its unit started, reopens over the same store and its rerun of the call ends with
// the same portal open: one row, one unit started once, one porch.

import { execFileSync } from "node:child_process";
import path from "node:path";

import type { ThreadId } from "@cairn/protocol/Ids";
import type { ApprovalDecision, RuntimeMode } from "@cairn/protocol/Policy";
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
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
} from "effect";
import { SqlClient } from "effect/sql";

import {
  answerApproval,
  Approvals,
  ThreadMeta,
  writeMode,
} from "../brain/CairnDocs.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { Git } from "../git/Git.ts";
import { testThreadId } from "../shell/ShellTestKit.ts";
import { makeFakePorch, PorchClient } from "./PorchClient.ts";
import { isPortalName, PortalFaults, Portals } from "./Portals.ts";
import type { PortalFaultHooks } from "./Portals.ts";
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

/** A git repository `repo` on branch `feat/Login`, inside a scratch folder removed with the scope. */
const scratchRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "cairn-ptools-" })
  );

  const repo = path.join(root, "repo");

  yield* fs.makeDirectory(repo);
  execFileSync("git", ["init", "--quiet", "--initial-branch=feat/Login"], {
    cwd: repo,
  });

  return { root, repo };
});

const NO_FAULTS: PortalFaultHooks = { after: () => Effect.void };

/** Fake systemd and porch, a migrated store, `Portals` and the tools over them. */
const stage = (faults: PortalFaultHooks = NO_FAULTS) =>
  Effect.gen(function* () {
    const dirs = yield* scratchRepo;
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
      Layer.provide(Layer.succeed(PortalFaults, faults)),
      Layer.provide(Git.layer)
    );

    return { dirs, units, porch, layer };
  });

/** A Harness over `root`'s brain store with the portal tools and a faux model scripted by `steps`. */
const harnessOver = (
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

    return yield* Effect.promise(
      async () => await Harness.open(storage, { models, registry }, context)
    );
  });

type OpenHarness = Effect.Success<ReturnType<typeof harnessOver>>;

const closeHarness = (harness: OpenHarness) =>
  Effect.promise(async () => {
    await harness.close(context);
  });

/** `harnessOver`, closed with the scope. */
const openHarness = (
  root: string,
  steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]
) => Effect.acquireRelease(harnessOver(root, steps), closeHarness);

/**
 * Starts one turn of a conversation in `cwd`, named `threadId` unless none is given, in `mode`
 * (the default, full access, unless given). Answers the conversation's id.
 */
const submitTurn = (
  harness: OpenHarness,
  cwd: string,
  threadId: Option.Option<ThreadId>,
  mode: Option.Option<RuntimeMode> = Option.none()
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

          if (Option.isSome(mode)) {
            await writeMode(tx, id, mode.value);
          }
        },
      },
      context
    );

    await conversation.submit(
      { type: "input", content: "go", requestId: "r1" },
      context
    );

    return conversation.id;
  });

type ConversationId = Effect.Success<ReturnType<typeof submitTurn>>;

/** The conversation's approval records, by id. */
const approvalsOf = (harness: OpenHarness, conversationId: ConversationId) =>
  Effect.promise(
    async () => await harness.snapshot(Approvals, conversationId, context)
  ).pipe(Effect.map((doc) => Object.values(doc?.items ?? {})));

/** Waits (at most ten seconds) for a pending approval of `tool`, and answers its id. */
const pendingApproval = (
  harness: OpenHarness,
  conversationId: ConversationId,
  tool: string
) =>
  Effect.gen(function* () {
    for (;;) {
      const pending = (yield* approvalsOf(harness, conversationId)).find(
        (record) => record.tool === tool && record.status === "pending"
      );

      if (pending !== undefined) {
        return pending.id;
      }

      yield* Effect.sleep(Duration.millis(20));
    }
  }).pipe(Effect.timeout(Duration.seconds(10)), Effect.orDie);

/** The user's answer to one approval. */
const answer = (
  harness: OpenHarness,
  conversationId: ConversationId,
  approvalId: string,
  decision: ApprovalDecision
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    return yield* answerApproval(
      harness,
      conversationId,
      approvalId,
      {
        decision,
        by: { kind: "user" },
        reason: Option.none(),
        answers: Option.none(),
      },
      now
    );
  }).pipe(Effect.orDie);

const waitIdle = (harness: OpenHarness) =>
  Effect.promise(async () => {
    await harness.waitForIdle(context);
  });

/** Runs one turn of a conversation in `cwd`, named `threadId` unless none is given. */
const turn = (
  harness: OpenHarness,
  cwd: string,
  threadId: Option.Option<ThreadId>
) => Effect.andThen(submitTurn(harness, cwd, threadId), waitIdle(harness));

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
        const { dirs, units, layer } = yield* stage();
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
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000
  );

  it.live("refuses a conversation that is not a Cairn thread", () =>
    Effect.gen(function* () {
      const { dirs, units, layer } = yield* stage();
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live(
    "Supervised: portal_open starts nothing until its approval is accepted, and portal_close asks too",
    () =>
      Effect.gen(function* () {
        const { dirs, units, layer } = yield* stage();
        const seen: Array<string> = [];

        yield* Effect.gen(function* () {
          const harness = yield* openHarness(dirs.root, [
            fauxAssistantMessage(
              fauxToolCall("portal_open", {
                command: "python3 -m http.server $PORT --bind 127.0.0.1",
              }),
              { stopReason: "toolUse" }
            ),
            (transcript) => {
              seen.push(lastToolResult(transcript));

              return fauxAssistantMessage(
                fauxToolCall("portal_close", { name: "feat-login" }),
                { stopReason: "toolUse" }
              );
            },
            (transcript) => {
              seen.push(lastToolResult(transcript));

              return fauxAssistantMessage("done");
            },
          ]);

          const conversationId = yield* submitTurn(
            harness,
            dirs.repo,
            Option.some(testThreadId(1)),
            Option.some("approval-required")
          );

          const openAsk = yield* pendingApproval(
            harness,
            conversationId,
            "portal_open"
          );

          assert.strictEqual(yield* units.starts, 0);
          assert.deepStrictEqual(yield* rowStates, []);

          const [record] = yield* approvalsOf(harness, conversationId);
          assert.include(record?.summary, "feat-login--repo");
          assert.include(record?.summary, "python3 -m http.server");

          assert.strictEqual(
            yield* answer(harness, conversationId, openAsk, "accept"),
            "answered"
          );

          const closeAsk = yield* pendingApproval(
            harness,
            conversationId,
            "portal_close"
          );

          assert.lengthOf(yield* units.running, 1);
          assert.deepStrictEqual(yield* rowStates, [
            { name: "feat-login--repo", state: "open" },
          ]);

          yield* answer(harness, conversationId, closeAsk, "accept");
          yield* waitIdle(harness);

          assert.lengthOf(seen, 2);
          assert.include(seen[0], "Portal feat-login--repo is open");
          assert.include(seen[1], "Portal feat-login--repo is closed");
          assert.deepStrictEqual(yield* units.running, []);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000
  );

  it.live(
    "auto-accept edits: a declined portal_open starts nothing and says why",
    () =>
      Effect.gen(function* () {
        const { dirs, units, layer } = yield* stage();
        const seen: Array<string> = [];

        yield* Effect.gen(function* () {
          const harness = yield* openHarness(dirs.root, [
            fauxAssistantMessage(
              fauxToolCall("portal_open", { command: "rm -rf ~" }),
              { stopReason: "toolUse" }
            ),
            (transcript) => {
              seen.push(lastToolResult(transcript));

              return fauxAssistantMessage("done");
            },
          ]);

          const conversationId = yield* submitTurn(
            harness,
            dirs.repo,
            Option.some(testThreadId(1)),
            Option.some("auto-accept-edits")
          );

          const ask = yield* pendingApproval(
            harness,
            conversationId,
            "portal_open"
          );

          yield* answer(harness, conversationId, ask, "decline");
          yield* waitIdle(harness);

          assert.lengthOf(seen, 1);
          assert.include(
            seen[0],
            "Not run: the approval for this call was declined"
          );
          assert.strictEqual(yield* units.starts, 0);
          assert.deepStrictEqual(yield* rowStates, []);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000
  );

  it.live("full access opens at once and writes no approval record", () =>
    Effect.gen(function* () {
      const { dirs, units, layer } = yield* stage();

      yield* Effect.gen(function* () {
        const harness = yield* openHarness(dirs.root, [
          fauxAssistantMessage(
            fauxToolCall("portal_open", {
              command: "python3 -m http.server $PORT --bind 127.0.0.1",
            }),
            { stopReason: "toolUse" }
          ),
          fauxAssistantMessage("done"),
        ]);

        const conversationId = yield* submitTurn(
          harness,
          dirs.repo,
          Option.some(testThreadId(1)),
          Option.some("full-access")
        );

        yield* waitIdle(harness);

        assert.strictEqual(yield* units.starts, 1);
        assert.deepStrictEqual(yield* approvalsOf(harness, conversationId), []);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live(
    "a Harness closed mid portal_open reopens and its rerun ends with the same portal open",
    () =>
      Effect.gen(function* () {
        const parked = yield* Deferred.make<boolean>();
        const fired = { done: false };

        // After the unit starts, the first open parks until the Harness closes under it, as a
        // brain killed at `portal:after-unit` would leave it.
        const faults: PortalFaultHooks = {
          after: (step) =>
            Effect.suspend(() => {
              if (step !== "unit" || fired.done) {
                return Effect.void;
              }

              fired.done = true;

              return Effect.andThen(
                Deferred.succeed(parked, true),
                Effect.never
              );
            }),
        };

        const { dirs, units, porch, layer } = yield* stage(faults);
        const seen: Array<string> = [];

        yield* Effect.gen(function* () {
          const first = yield* harnessOver(dirs.root, [
            fauxAssistantMessage(
              fauxToolCall("portal_open", {
                command: "python3 -m http.server $PORT --bind 127.0.0.1",
              }),
              { stopReason: "toolUse" }
            ),
          ]);

          yield* submitTurn(first, dirs.repo, Option.some(testThreadId(1)));
          yield* Deferred.await(parked);
          yield* closeHarness(first);

          assert.deepStrictEqual(yield* rowStates, [
            { name: "feat-login--repo", state: "opening" },
          ]);
          assert.strictEqual(yield* units.starts, 1);

          const second = yield* openHarness(dirs.root, [
            (transcript) => {
              seen.push(lastToolResult(transcript));

              return fauxAssistantMessage("done");
            },
          ]);

          second.resume();
          yield* waitIdle(second);

          assert.lengthOf(seen, 1);
          assert.include(
            seen[0],
            "Portal feat-login--repo is open at https://feat-login--repo.example.test"
          );
          assert.strictEqual(yield* units.starts, 1);
          assert.lengthOf(yield* units.running, 1);
          assert.deepStrictEqual(yield* rowStates, [
            { name: "feat-login--repo", state: "open" },
          ]);
          assert.deepStrictEqual(
            (yield* porch.client.list)
              .map((row) => row.name)
              .filter((name) => isPortalName(name)),
            ["feat-login--repo"]
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000
  );
});
