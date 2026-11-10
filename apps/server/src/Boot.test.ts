// Boot: its order (repairs, resume, reconcile, then ready), the serving gate on a real socket (`/ws`
// answers 503 until boot is done, then upgrades), and the one number that matters from the 300-conversation scale probe (plan D1): under 3 s from
// opening the stores to ready over a brain of 300 threads.

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { ProjectId, RunId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Ref,
  References,
  Schema,
} from "effect";
import { HttpServer } from "effect/http";
import { TestClock } from "effect/testing";

import {
  HarnessBoot,
  PiDurableBrain,
  ScriptedBrain,
  ThreadsLive,
  withCatalog,
} from "./AppLayer.ts";
import { runBoot } from "./Boot.ts";
import { endCrashLoopedTasks } from "./brain/CrashLimit.ts";
import { HarnessSeam } from "./brain/HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "./brain/ModelSource.ts";
import { ServerConfig } from "./Config.ts";
import { Database } from "./db/Database.ts";
import { migrations } from "./db/Migrations.ts";
import { ExecutorLink } from "./executor/ExecutorLink.ts";
import { Diffs } from "./git/Diffs.ts";
import { Health } from "./http/Health.ts";
import { HttpLive } from "./http/Http.ts";
import { Identity, IdentityRefused, USER_HEADER } from "./http/Identity.ts";
import { BootJson } from "./http/Static.ts";
import { PeerPath } from "./load/PeerPath.ts";
import { ModelHealth } from "./models/ModelHealth.ts";
import { isolatePiSetup } from "./models/PiConfigTestKit.ts";
import { SettingsStore } from "./models/SettingsStore.ts";
import { PiHost } from "./pi-host/PiHost.ts";
import { PushLayer } from "./push/PushLayer.ts";
import {
  ReachMachine,
  ReachServices,
  ReachServicesTest,
} from "./reach/ReachLayer.ts";
import { HandlersLayer } from "./rpc/Handlers.ts";
import { SessionHello } from "./rpc/SessionHandlers.ts";
import { EventSink } from "./shell/EventSink.ts";
import { ProjectorSignals } from "./shell/ProjectorSignals.ts";
import {
  emptyActivityPatch,
  ThreadActivityUpdate,
} from "./shell/ShellCommands.ts";
import { ShellLayer } from "./shell/ShellLayer.ts";
import { ShellProjector } from "./shell/ShellProjector.ts";
import {
  createProject,
  createThread,
  testCommandId,
  testThreadId,
} from "./shell/ShellTestKit.ts";
import { ThreadRows } from "./shell/ThreadRows.ts";
import { Shutdown } from "./Shutdown.ts";
import { shutdownHooks } from "./ShutdownHooks.ts";
import { SpendLedger } from "./usage/SpendLedger.ts";

// The pi-durable brains below build the brain's own pi setup: an empty one, never the user's.
isolatePiSetup();

describe("boot", () => {
  it.effect(
    "runs the repairs, then the resume, then the reconcile, and is ready only after them",
    () =>
      Effect.gen(function* () {
        const steps = yield* Ref.make<ReadonlyArray<string>>([]);
        const gate = yield* Deferred.make<boolean>();

        const record = (step: string) =>
          Ref.update(steps, (done) => [...done, step]);

        const projector = ShellProjector.of({
          reconcile: record("reconcile").pipe(
            Effect.as({ threads: 2, live: 1, patched: 1 })
          ),
          flushAll: Effect.void,
        });

        const health = yield* Health;

        const boot = yield* runBoot({
          repairs: record("repairs"),
          resume: record("resume").pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.asVoid
          ),
        }).pipe(
          Effect.provideService(ShellProjector, projector),
          Effect.forkChild
        );

        yield* Effect.yieldNow;
        assert.deepStrictEqual(yield* Ref.get(steps), ["repairs", "resume"]);
        assert.isFalse(yield* health.isReady);

        yield* Deferred.succeed(gate, true);

        const report = yield* Fiber.join(boot);

        assert.deepStrictEqual(yield* Ref.get(steps), [
          "repairs",
          "resume",
          "reconcile",
        ]);
        assert.isTrue(yield* health.isReady);
        assert.deepStrictEqual(report.reconcile, {
          threads: 2,
          live: 1,
          patched: 1,
        });
      }).pipe(Effect.provide(Health.layer))
  );

  it.effect("names a boot step still running after 30 s", () =>
    Effect.gen(function* () {
      const slow: Array<unknown> = [];

      const capture = Logger.make((options) => {
        const annotations = options.fiber.getRef(
          References.CurrentLogAnnotations
        );

        if (annotations.event === "boot_slow") {
          slow.push(annotations.step);
        }
      });

      const gate = yield* Deferred.make<boolean>();

      const projector = ShellProjector.of({
        reconcile: Effect.succeed({ threads: 0, live: 0, patched: 0 }),
        flushAll: Effect.void,
      });

      const boot = yield* runBoot({
        repairs: Effect.void,
        resume: Effect.asVoid(Deferred.await(gate)),
      }).pipe(
        Effect.provideService(ShellProjector, projector),
        Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
        Effect.forkChild
      );

      yield* TestClock.adjust("29 seconds");
      assert.deepStrictEqual(slow, []);

      yield* TestClock.adjust("2 seconds");
      assert.deepStrictEqual(slow, ["resume"]);

      yield* Deferred.succeed(gate, true);
      yield* Fiber.join(boot);
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(slow, ["resume"], "the reconcile was quick");
    }).pipe(Effect.provide(Health.layer))
  );
});

// The serving gate, over the real listener and the real `/ws` route.

const OWNER = "oscabriel@github";

const HOST = "code.gneiss.run";

const ORIGIN = "https://code.gneiss.run";

const TestIdentity = Layer.succeed(
  Identity,
  Identity.of({
    admit: () =>
      Effect.fail(
        new IdentityRefused({ message: "not used", reason: "not_the_owner" })
      ),
    viewerOf: (request) =>
      request.headers[USER_HEADER] === OWNER
        ? Option.some(OWNER)
        : Option.none(),
    stillAdmitted: () => Effect.succeed(true),
  })
);

/** Released by the test: until then the resume step, and so boot, does not finish. */
const resumeGate = Deferred.makeUnsafe<boolean>();

const gateDataDir = mkdtempSync(path.join(os.tmpdir(), "cairn-boot-gate-"));

// The app as `AppLayer` composes it, with boot run in the background so the test can watch the
// listener while boot waits on its resume.
const GatedApp = Layer.mergeAll(
  HttpLive,
  Layer.effectDiscard(
    Effect.forkScoped(
      runBoot({
        repairs: Effect.void,
        resume: Effect.asVoid(Deferred.await(resumeGate)),
      })
    )
  )
).pipe(
  Layer.provide(HandlersLayer),
  Layer.provide(Diffs.layer),
  Layer.provide(SessionHello.layer),
  Layer.provide(BootJson.layerNone),
  Layer.provide(PeerPath.fixed(new Map())),
  Layer.provide(Shutdown.layerFrom(shutdownHooks)),
  Layer.provide(Health.layer),
  Layer.provide(ShellProjector.layer),
  Layer.provideMerge(ThreadsLive),
  Layer.provideMerge(SpendLedger.layerNoDeps),
  Layer.provideMerge(PushLayer),
  Layer.provide(SettingsStore.layerNoDeps),
  Layer.provideMerge(
    Layer.merge(
      ReachServices.pipe(Layer.provide(ReachMachine.layerTest)),
      ModelHealth.layerTest
    )
  ),
  Layer.provideMerge(
    ShellLayer.pipe(
      Layer.provideMerge(ProjectorSignals.layer),
      Layer.provideMerge(
        Database.layer({
          filename: path.join(gateDataDir, "cairn.sqlite"),
          migrations,
        })
      )
    )
  ),
  Layer.provide(ScriptedBrain),
  Layer.provide(ExecutorLink.layerDisabled),
  Layer.provide(PiHost.layerEmpty),
  Layer.provide(TestIdentity),
  Layer.provide(
    ServerConfig.layerWith({
      host: HOST,
      origin: ORIGIN,
      owner: OWNER,
      webRoot: "/nonexistent/cairn-web",
      dataDir: gateDataDir,
    })
  ),
  Layer.provide(NodeServices.layer)
);

const boundPort = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const { address } = server;

  return "port" in address ? address.port : 0;
});

/** The status a raw WebSocket upgrade to `/ws` gets: 101 when it becomes a socket. */
const upgradeStatus = Effect.gen(function* () {
  const port = yield* boundPort;

  return yield* Effect.callback<number>((resume) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/ws?protocol=2",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        host: HOST,
        origin: ORIGIN,
        [USER_HEADER]: OWNER,
      },
    });

    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      resume(Effect.succeed(101));
    });
    request.on("response", (response) => {
      response.resume();
      resume(Effect.succeed(response.statusCode ?? 0));
    });
    request.on("error", (cause) => {
      resume(Effect.die(cause));
    });
    request.end();
  });
});

const decodeHealth = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ ready: Schema.Boolean }))
);

/** Whether `/_cairn/health`, asked from loopback, reports ready. */
const healthReady = Effect.gen(function* () {
  const port = yield* boundPort;

  const body = yield* Effect.callback<string>((resume) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/_cairn/health" },
      (response) => {
        const chunks: Array<Buffer> = [];

        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resume(Effect.succeed(Buffer.concat(chunks).toString("utf-8")));
        });
      }
    );

    request.on("error", (cause) => {
      resume(Effect.die(cause));
    });
  });

  return decodeHealth(body).ready;
});

layer(GatedApp, { excludeTestServices: true })("the serving gate", (gated) => {
  gated.effect("answers /ws with 503 until boot is done, then upgrades", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* upgradeStatus, 503);
      assert.isFalse(yield* healthReady);

      yield* Deferred.succeed(resumeGate, true);

      for (
        let attempt = 0;
        attempt < 100 && !(yield* healthReady);
        attempt += 1
      ) {
        yield* Effect.sleep("20 millis");
      }

      assert.isTrue(yield* healthReady);
      assert.strictEqual(yield* upgradeStatus, 101);
    })
  );
});

// The scale number: a brain holding 300 threads, with their rows in the shell store and a few of
// them left "running" by a crash, boots to ready in under 3 s.

const THREADS = 300;

const STALE_RUNNING = 10;

const PROJECT = createProject(1);

const brainFor = (dataDir: string) =>
  PiDurableBrain({
    models: withCatalog(
      ModelSource.layerFaux({ tokensPerSecond: 2000, settings: {} })
    ),
  }).pipe(
    Layer.provideMerge(ExecutorLink.layerDisabled),
    Layer.provide(PiHost.layerEmpty),
    Layer.provide(ModelHealth.layerNoDeps),
    Layer.provide(SettingsStore.layerNoDeps),
    Layer.provide(ReachServicesTest),
    Layer.provideMerge(
      ShellLayer.pipe(
        Layer.provideMerge(ProjectorSignals.layer),
        Layer.provideMerge(
          Database.layer({
            filename: path.join(dataDir, "cairn.sqlite"),
            migrations,
          })
        )
      )
    ),
    Layer.provide(ServerConfig.layerWith({ dataDir }))
  );

/** Creates the threads in a fresh brain and shell store, then closes both. */
const seedBrain = (dataDir: string) =>
  Effect.gen(function* () {
    const harness = yield* HarnessSeam;
    const sink = yield* EventSink;

    yield* sink.commitCommand(PROJECT.command);

    yield* Effect.forEach(
      Array.from({ length: THREADS }, (_, index) => index + 1),
      (n) =>
        Effect.gen(function* () {
          const threadId: ThreadId = testThreadId(n);

          yield* sink.commitCommand(createThread(PROJECT.projectId, n));
          yield* harness.ensureThread({
            threadId,
            projectId: ProjectId.make(PROJECT.projectId),
            model: FAUX_MODEL,
            thinkingLevel: "off",
            cwd: dataDir,
            instructions: Option.none(),
            runtimeMode: "full-access",
          });

          if (n <= STALE_RUNNING) {
            yield* sink.commitCommand(
              ThreadActivityUpdate.make({
                commandId: testCommandId(50_000 + n),
                threadId,
                patch: {
                  ...emptyActivityPatch,
                  activity: Option.some("running"),
                  activeRunId: Option.some(Option.some(RunId.make(n))),
                },
              })
            );
          }
        }),
      { concurrency: 8, discard: true }
    );
  }).pipe(Effect.scoped, Effect.provide(brainFor(dataDir)));

/** Opens everything again and boots, timing from the first layer to ready. */
const bootBrain = (dataDir: string) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;

    const context = yield* Layer.build(
      ShellProjector.layer.pipe(
        Layer.provideMerge(Health.layer),
        Layer.provideMerge(brainFor(dataDir))
      )
    );

    const report = yield* runBoot({
      repairs: endCrashLoopedTasks({ kinds: new Set(), tools: new Set() }).pipe(
        Effect.orDie
      ),
      resume: HarnessBoot.use((boot) => boot.resume),
    }).pipe(Effect.provideContext(context));

    const elapsed = (yield* Clock.currentTimeMillis) - started;

    const rows = yield* ThreadRows.use((threads) => threads.listLive).pipe(
      Effect.provideContext(context)
    );

    return { elapsed, report, rows };
  }).pipe(Effect.scoped);

describe("boot over a brain of 300 threads", () => {
  it.live(
    "is ready in under 3 s and ends the runs a crash left behind",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          mkdtempSync(path.join(os.tmpdir(), "cairn-boot-scale-"))
        ),
        (dataDir) =>
          Effect.gen(function* () {
            yield* seedBrain(dataDir);

            const { elapsed, report, rows } = yield* bootBrain(dataDir);

            yield* Effect.logInfo(
              `boot over ${THREADS} threads: ${elapsed} ms to ready (repairs ${report.repairsMs}, resume ${report.resumeMs}, reconcile ${report.reconcileMs})`
            );

            assert.isBelow(elapsed, 3000);
            assert.strictEqual(report.reconcile.threads, THREADS);
            assert.strictEqual(report.reconcile.patched, STALE_RUNNING);
            assert.isTrue(rows.every((row) => row.shell.activity === "idle"));
          }),
        (dataDir) =>
          Effect.sync(() => {
            rmSync(dataDir, { recursive: true, force: true });
          })
      ),
    60_000
  );
});
