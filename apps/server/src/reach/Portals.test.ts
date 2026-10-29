// Portals over a fake systemd (`makeFakeUnits`), the fake porch and a migrated in-memory
// cairn.sqlite: the open sequence and its reruns, a crash after each step (the kill matrix of the
// reach note, R5) ending open on a rerun or with nothing left after the repair and a close, the
// limits, close and start, the boot reconcile and the sweep. `judges/reach-restart.sh` runs the same
// matrix against real units, a real porch and a throwaway Caddy.

import path from "node:path";

import { Conflict, NotFound } from "@cairn/protocol/Errors";
import { ThreadId } from "@cairn/protocol/Ids";
import { MAX_OPEN_PORTALS, PortalId } from "@cairn/protocol/Reach";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Result,
} from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { answerPortalClose, answerPortalStart } from "../rpc/PortalHandlers.ts";
import { makeFakePorch, PorchClient } from "./PorchClient.ts";
import {
  isPortalName,
  judgePortalFaults,
  portalFaultStep,
  portalName,
  PortalError,
  PortalFaults,
  Portals,
  PortalSettings,
} from "./Portals.ts";
import type {
  OpenInput,
  PortalConfig,
  PortalFaultHooks,
  PortalStep,
} from "./Portals.ts";
import {
  makeFakeUnits,
  PortalUnits,
  systemdRunArgs,
  unitsOfListing,
} from "./PortalUnits.ts";

const DOMAIN = "example.test";

const THREAD_A = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-00000000f001");

const THREAD_B = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-00000000f002");

const PREFIX = "cairn-portal-";

const STEPS: ReadonlyArray<PortalStep> = [
  "row",
  "porch",
  "unit",
  "probe",
  "open",
];

const CLOSE_STEPS: ReadonlyArray<PortalStep> = [
  "close-row",
  "close-unit",
  "close-porch",
];

const openInput = (name: string, threadId = THREAD_A): OpenInput => ({
  threadId,
  name,
  command: "python3 -m http.server $PORT --bind 127.0.0.1",
  cwd: "/repo",
  ttlHours: 12,
  readyPath: "/",
  readyTimeout: Duration.seconds(5),
});

/** A fresh fake porch, fake systemd and store, and the `Portals` layer over them. */
const stageWith = (
  faults: PortalFaultHooks,
  settings: Option.Option<PortalConfig>,
  wrapUnits: (units: PortalUnits["Service"]) => PortalUnits["Service"]
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "cairn-portals-",
    });

    const artifacts = path.join(root, "artifacts");
    yield* fs.makeDirectory(artifacts);

    const porch = yield* makeFakePorch({ domain: DOMAIN, artifacts });
    const units = yield* makeFakeUnits;

    const layer = Portals.layerNoDeps.pipe(
      Layer.provideMerge(Layer.succeed(PorchClient, porch.client)),
      Layer.provideMerge(Layer.succeed(PortalUnits, wrapUnits(units.units))),
      Layer.provideMerge(Database.layerTest(migrations)),
      Layer.provide(Layer.succeed(PortalFaults, faults)),
      Layer.provide(
        Option.match(settings, {
          onNone: () => Layer.empty,
          onSome: (config) => Layer.succeed(PortalSettings, config),
        })
      )
    );

    return { porch, units, layer };
  });

const NO_FAULTS: PortalFaultHooks = { after: () => Effect.void };

type Stage = Effect.Success<ReturnType<typeof stageWith>>;

/** Runs `body` on a fresh stage whose open runs `faults` after each step. */
const onStage = <A, E>(
  body: (
    s: Stage
  ) => Effect.Effect<
    A,
    E,
    Portals | PortalUnits | PorchClient | SqlClient.SqlClient
  >,
  faults: PortalFaultHooks = NO_FAULTS,
  settings: Option.Option<PortalConfig> = Option.none(),
  wrapUnits: (units: PortalUnits["Service"]) => PortalUnits["Service"] = (
    units
  ) => units
) =>
  Effect.gen(function* () {
    const s = yield* stageWith(faults, settings, wrapUnits);

    return yield* body(s).pipe(Effect.provide(s.layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Every portal porch (a name with `--`). */
const portalPorches = Effect.gen(function* () {
  const porch = yield* PorchClient;

  return (yield* porch.list)
    .map((row) => row.name)
    .filter((name) => isPortalName(name));
});

/** Every row's state, by name. */
const rowStates = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql<{
    readonly name: string;
    readonly state: string;
    readonly stop_reason: string | null;
  }>`SELECT name, state, stop_reason FROM portals ORDER BY opened_at, name`;
});

/**
 * A fault that crashes the first open after `step`, as a `kill -9` of the brain there would; the
 * rerun, as after a restart, runs clean.
 */
const crashOnceAfter = (step: PortalStep): PortalFaultHooks => {
  const fired = { done: false };

  return {
    after: (at) =>
      Effect.suspend(() => {
        if (at !== step || fired.done) {
          return Effect.void;
        }

        fired.done = true;

        return Effect.die(`crash after ${step}`);
      }),
  };
};

describe("portal names", () => {
  it("are one DNS label with --, from the branch and the project", () => {
    assert.strictEqual(
      portalName("feature/Login UI", "Cairn"),
      "feature-login-ui--cairn"
    );
    assert.strictEqual(portalName("", "..."), "main--project");

    const long = portalName("x".repeat(80), "y".repeat(80));
    assert.isAtMost(long.length, 63);
    assert.isTrue(isPortalName(long));
    assert.isFalse(isPortalName("cairn"));
    assert.isFalse(isPortalName("plans"));
    assert.isFalse(isPortalName("-a--b"));
  });

  it("units start with --collect and a lifetime, and listings parse", () => {
    const args = systemdRunArgs({
      unit: "cairn-portal-00000000000000aa",
      cwd: "/repo",
      command: "pnpm dev",
      env: { PORT: "3100" },
      lifetime: Duration.hours(12),
    });

    assert.include(args, "--collect");
    assert.include(args, "--unit=cairn-portal-00000000000000aa");
    assert.include(args, "--property=RuntimeMaxSec=43200");
    assert.include(args, "--setenv=PORT=3100");
    assert.deepStrictEqual(args.slice(-3), ["/bin/sh", "-c", "pnpm dev"]);

    assert.deepStrictEqual(
      unitsOfListing(
        "cairn-portal-a.service loaded active running cairn\n  cairn-portal-b.service loaded failed failed x\n\n"
      ),
      ["cairn-portal-a", "cairn-portal-b"]
    );
  });
});

describe("judge faults", () => {
  it("parse only portal:after-<step>, of an open or a close", () => {
    assert.deepStrictEqual(
      portalFaultStep("portal:after-unit"),
      Option.some("unit")
    );
    assert.deepStrictEqual(
      portalFaultStep("portal:after-close-row"),
      Option.some("close-row")
    );
    assert.isTrue(Option.isNone(portalFaultStep("portal:after-nope")));
    assert.isTrue(Option.isNone(portalFaultStep("events:after-commit")));
    assert.isTrue(Option.isNone(portalFaultStep("")));
  });

  it.effect("another family's fault, or a fired marker, plants nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "cairn-portal-faults-",
      });

      const marker = path.join(root, "fired");
      yield* fs.writeFileString(marker, "unit");

      for (const [spec, file] of [
        ["events:after-commit", path.join(root, "unused")],
        ["portal:after-unit", marker],
      ] as const) {
        const hooks = yield* PortalFaults.pipe(
          Effect.provide(judgePortalFaults(spec, file))
        );

        for (const step of STEPS) {
          yield* hooks.after(step);
        }
      }

      assert.isFalse(yield* fs.exists(path.join(root, "unused")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect(
    "a marker that cannot be written plants nothing, so no life crash-loops",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "cairn-portal-faults-",
        });

        // A marker in a folder that does not exist: the write fails, and the brain must live.
        const hooks = yield* PortalFaults.pipe(
          Effect.provide(
            judgePortalFaults(
              "portal:after-unit",
              path.join(root, "missing", "fired")
            )
          )
        );

        for (const step of STEPS) {
          yield* hooks.after(step);
        }

        assert.isFalse(yield* fs.exists(path.join(root, "missing")));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});

describe("Portals.open", () => {
  it.effect("opens: row open, porch registered, one unit on the port", () =>
    onStage(({ units }) =>
      Effect.gen(function* () {
        const portals = yield* Portals;
        const row = yield* portals.open(openInput("main--cairn"));

        assert.strictEqual(row.state, "open");
        assert.strictEqual(row.url, "https://main--cairn.example.test");
        assert.deepStrictEqual(row.port, Option.some(3100));
        assert.deepStrictEqual(yield* portalPorches, ["main--cairn"]);
        assert.deepStrictEqual(yield* units.running, [`${PREFIX}${row.id}`]);

        const spec = yield* units.specOf(`${PREFIX}${row.id}`);
        assert.isTrue(Option.isSome(spec));

        if (Option.isSome(spec)) {
          assert.strictEqual(spec.value.env.PORT, "3100");
          assert.strictEqual(spec.value.env.HOST, "127.0.0.1");
          assert.strictEqual(
            spec.value.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS,
            "main--cairn.example.test"
          );
          assert.isFalse(
            Object.keys(spec.value.env).some((key) => key.startsWith("CAIRN_"))
          );
        }

        // The same name again is the same portal, untouched.
        const again = yield* portals.open(openInput("main--cairn"));
        assert.strictEqual(again.id, row.id);
        assert.strictEqual(yield* units.starts, 1);
      })
    )
  );

  it.effect("skips ports something else holds", () =>
    onStage(({ units }) =>
      Effect.gen(function* () {
        yield* units.hold(3100);
        const row = yield* (yield* Portals).open(openInput("main--cairn"));

        assert.deepStrictEqual(row.port, Option.some(3101));
      })
    )
  );

  it.effect("refuses another thread's name, and a seventh portal", () =>
    onStage(() =>
      Effect.gen(function* () {
        const portals = yield* Portals;
        yield* portals.open(openInput("main--cairn"));

        const taken = yield* Effect.result(
          portals.open(openInput("main--cairn", THREAD_B))
        );

        assert.isTrue(
          Result.isFailure(taken) &&
            taken.failure instanceof PortalError &&
            taken.failure.reason === "taken"
        );

        for (let index = 1; index < MAX_OPEN_PORTALS; index += 1) {
          yield* portals.open(openInput(`b${String(index)}--cairn`));
        }

        const seventh = yield* Effect.result(
          portals.open(openInput("seven--cairn"))
        );

        assert.isTrue(Result.isFailure(seventh));

        if (Result.isFailure(seventh)) {
          assert.include(seventh.failure.message, "main--cairn");
          assert.isTrue(
            seventh.failure instanceof PortalError &&
              seventh.failure.reason === "limit"
          );
        }
      })
    )
  );

  it.effect("refuses a name without --, and a relative folder", () =>
    onStage(() =>
      Effect.gen(function* () {
        const portals = yield* Portals;

        const bad = yield* Effect.result(portals.open(openInput("cairn")));

        const relative = yield* Effect.result(
          portals.open({ ...openInput("main--cairn"), cwd: "repo" })
        );

        for (const result of [bad, relative]) {
          assert.isTrue(
            Result.isFailure(result) &&
              result.failure instanceof PortalError &&
              result.failure.reason === "bad-input"
          );
        }

        assert.deepStrictEqual(yield* rowStates, []);
      })
    )
  );

  it.effect(
    "a server that never answers leaves the row opening; a rerun opens it",
    () =>
      onStage(({ units }) =>
        Effect.gen(function* () {
          const portals = yield* Portals;
          yield* units.setAnswering(false);

          const late = yield* Effect.result(
            portals.open({
              ...openInput("main--cairn"),
              readyTimeout: Duration.zero,
            })
          );

          assert.isTrue(
            Result.isFailure(late) &&
              late.failure instanceof PortalError &&
              late.failure.reason === "not-ready"
          );
          assert.deepStrictEqual(
            (yield* rowStates).map((row) => row.state),
            ["opening"]
          );

          yield* units.setAnswering(true);
          const row = yield* portals.open(openInput("main--cairn"));

          assert.strictEqual(row.state, "open");
          assert.strictEqual(yield* units.starts, 1);
        })
      )
  );

  it.effect(
    "a fixed command after not-ready replaces the old process on the same port",
    () =>
      onStage(({ units }) =>
        Effect.gen(function* () {
          const portals = yield* Portals;
          yield* units.setAnswering(false);

          const late = yield* Effect.result(
            portals.open({
              ...openInput("main--cairn"),
              command: "pnpm dev --port 9999",
              readyTimeout: Duration.zero,
            })
          );

          assert.isTrue(Result.isFailure(late));
          yield* units.setAnswering(true);

          const fixed = "pnpm dev --host 127.0.0.1 --port $PORT";

          const row = yield* portals.open({
            ...openInput("main--cairn"),
            command: fixed,
          });

          assert.strictEqual(row.state, "open");
          assert.strictEqual(row.command, fixed);
          assert.deepStrictEqual(row.port, Option.some(3100));
          assert.strictEqual(yield* units.starts, 2);
          assert.strictEqual((yield* units.running).length, 1);

          const spec = yield* units.specOf(`${PREFIX}${row.id}`);
          assert.strictEqual(
            Option.getOrUndefined(Option.map(spec, (found) => found.command)),
            fixed
          );
        })
      )
  );

  it.effect("a server whose process exits is not open", () =>
    onStage(({ units }) =>
      Effect.gen(function* () {
        const portals = yield* Portals;
        yield* units.setAnswering(false);

        const fiber = yield* Effect.forkChild(
          Effect.result(portals.open(openInput("main--cairn")))
        );

        yield* TestClock.adjust(Duration.millis(300));

        for (const unit of yield* units.running) {
          yield* units.exit(unit);
        }

        yield* TestClock.adjust(Duration.millis(300));

        const result = yield* Fiber.await(fiber);

        assert.isTrue(Exit.isSuccess(result));

        if (Exit.isSuccess(result)) {
          assert.isTrue(Result.isFailure(result.value));

          if (Result.isFailure(result.value)) {
            assert.include(result.value.failure.message, "exited");
          }
        }
      })
    )
  );
});

describe("the kill matrix", () => {
  for (const step of STEPS) {
    it.effect(`a crash after ${step}: the rerun opens the same portal`, () =>
      onStage(
        ({ units }) =>
          Effect.gen(function* () {
            const portals = yield* Portals;

            const crashed = yield* Effect.exit(
              portals.open(openInput("main--cairn"))
            );

            assert.isTrue(Exit.isFailure(crashed));

            // The brain comes back: its boot repair, inside the grace, then the tool's rerun.
            yield* portals.reconcile;
            const row = yield* portals.open(openInput("main--cairn"));

            assert.strictEqual(row.state, "open");
            assert.lengthOf(yield* units.running, 1);
            assert.isAtMost(yield* units.starts, 1);
            assert.deepStrictEqual(yield* portalPorches, ["main--cairn"]);

            yield* portals.close(row.id);

            assert.deepStrictEqual(yield* units.running, []);
            assert.deepStrictEqual(yield* portalPorches, []);
            assert.deepStrictEqual(
              (yield* rowStates).map((stored) => stored.state),
              ["removed"]
            );
          }),
        crashOnceAfter(step)
      )
    );

    it.effect(
      `a crash after ${step} never retried: repair and close leave nothing`,
      () =>
        onStage(
          ({ units }) =>
            Effect.gen(function* () {
              const portals = yield* Portals;

              yield* Effect.exit(portals.open(openInput("main--cairn")));

              yield* TestClock.adjust(Duration.minutes(4));
              yield* portals.reconcile;

              const [row] = yield* portals.list(Option.none());
              assert.isDefined(row);

              if (row !== undefined) {
                // An open portal survives the restart; one left mid-open is ended.
                assert.strictEqual(
                  row.state,
                  step === "row" || step === "porch" ? "stopped" : "open"
                );
                yield* portals.close(row.id);
              }

              assert.deepStrictEqual(yield* units.running, []);
              assert.deepStrictEqual(yield* portalPorches, []);
              assert.deepStrictEqual(
                (yield* rowStates).map((stored) => stored.state),
                ["removed"]
              );
            }),
          crashOnceAfter(step)
        )
    );
  }
});

describe("the close kill matrix", () => {
  for (const step of CLOSE_STEPS) {
    for (const rerun of [true, false]) {
      it.effect(
        `a crash after ${step}, ${rerun ? "closed again" : "left to the boot repair"}: removed, nothing left`,
        () =>
          onStage(
            ({ units }) =>
              Effect.gen(function* () {
                const portals = yield* Portals;
                const row = yield* portals.open(openInput("main--cairn"));

                const crashed = yield* Effect.exit(portals.close(row.id));
                assert.isTrue(Exit.isFailure(crashed));

                yield* portals.reconcile;

                if (rerun) {
                  const closed = yield* portals.close(row.id);
                  assert.strictEqual(closed.state, "removed");
                }

                assert.deepStrictEqual(yield* units.running, []);
                assert.deepStrictEqual(yield* portalPorches, []);
                assert.deepStrictEqual(yield* rowStates, [
                  {
                    name: "main--cairn",
                    state: "removed",
                    stop_reason: "closed",
                  },
                ]);
              }),
            crashOnceAfter(step)
          )
      );
    }
  }

  it.effect(
    "closing a removed portal again leaves the porch of a newer portal of the name",
    () =>
      onStage(({ units }) =>
        Effect.gen(function* () {
          const portals = yield* Portals;
          const first = yield* portals.open(openInput("main--cairn"));
          yield* portals.close(first.id);

          const second = yield* portals.open(openInput("main--cairn"));
          yield* portals.close(first.id);

          assert.deepStrictEqual(yield* portalPorches, ["main--cairn"]);
          assert.deepStrictEqual(yield* units.running, [
            `${PREFIX}${second.id}`,
          ]);
        })
      )
  );
});

describe("settings", () => {
  it.effect(
    "are the composition root's, not the calling fiber's: units and ports follow them",
    () =>
      onStage(
        ({ units }) =>
          Effect.gen(function* () {
            const row = yield* (yield* Portals).open(openInput("main--cairn"));

            assert.deepStrictEqual(row.port, Option.some(38_100));
            assert.deepStrictEqual(yield* units.running, [
              `cairn-judge-portal-1-${row.id}`,
            ]);
          }),
        NO_FAULTS,
        Option.some({
          unitPrefix: "cairn-judge-portal-1-",
          firstPort: 38_100,
          lastPort: 38_199,
          openingGrace: Duration.minutes(2),
          sweepEvery: Duration.minutes(1),
          probeEvery: Duration.millis(250),
          env: {},
        })
      )
  );
});

describe("close and start", () => {
  it.effect("close is idempotent and gives the name back", () =>
    onStage(({ units }) =>
      Effect.gen(function* () {
        const portals = yield* Portals;
        const row = yield* portals.open(openInput("main--cairn"));

        const closed = yield* portals.close(row.id);
        const again = yield* portals.close(row.id);

        assert.strictEqual(closed.state, "removed");
        assert.deepStrictEqual(again.stopReason, Option.some("closed"));
        assert.deepStrictEqual(yield* units.running, []);
        assert.deepStrictEqual(yield* portals.list(Option.none()), []);

        const other = yield* portals.open(openInput("main--cairn", THREAD_B));
        assert.notStrictEqual(other.id, row.id);
      })
    )
  );

  it.effect(
    "start runs a stopped portal again, on a new port if its old one is held",
    () =>
      onStage(({ units }) =>
        Effect.gen(function* () {
          const portals = yield* Portals;
          const row = yield* portals.open(openInput("main--cairn"));
          const unit = `${PREFIX}${row.id}`;

          yield* units.exit(unit);
          yield* portals.sweep;

          const [stopped] = yield* portals.list(Option.none());
          assert.strictEqual(stopped?.state, "stopped");
          assert.deepStrictEqual(stopped?.stopReason, Option.some("exited"));
          // The porch stays, so the name shows porch's dark page.
          assert.deepStrictEqual(yield* portalPorches, ["main--cairn"]);

          yield* units.hold(3100);
          const started = yield* portals.start(row.id);

          assert.strictEqual(started.id, row.id);
          assert.strictEqual(started.state, "open");
          assert.deepStrictEqual(started.port, Option.some(3101));

          const spec = yield* units.specOf(unit);
          assert.strictEqual(
            Option.map(spec, (found) => found.env.PORT).pipe(Option.getOrNull),
            "3101"
          );
        })
      )
  );

  it.effect(
    "a stopped portal keeps its port: a new portal gets another, so the old name stays dark",
    () =>
      onStage(({ units }) =>
        Effect.gen(function* () {
          const portals = yield* Portals;
          const first = yield* portals.open(openInput("a--x"));

          yield* units.exit(`${PREFIX}${first.id}`);
          yield* portals.sweep;

          const second = yield* portals.open(openInput("b--x"));

          assert.deepStrictEqual(first.port, Option.some(3100));
          assert.deepStrictEqual(second.port, Option.some(3101));
          assert.deepStrictEqual(yield* portalPorches, ["a--x", "b--x"]);

          // Started again, the stopped portal takes its own port back.
          const again = yield* portals.start(first.id);
          assert.deepStrictEqual(again.port, Option.some(3100));

          // Closed for good, it gives the port back.
          yield* portals.close(first.id);
          const third = yield* portals.open(openInput("c--x"));
          assert.deepStrictEqual(third.port, Option.some(3100));
        })
      )
  );

  it.effect("the RPCs answer NotFound, and Conflict for a closed portal", () =>
    onStage(() =>
      Effect.gen(function* () {
        const portals = yield* Portals;

        const missing = yield* Effect.result(
          answerPortalClose(portals, {
            portalId: PortalId.make("00000000000000ff"),
          })
        );

        assert.isTrue(
          Result.isFailure(missing) && missing.failure instanceof NotFound
        );

        const row = yield* portals.open(openInput("main--cairn"));
        yield* answerPortalClose(portals, { portalId: row.id });

        const removed = yield* Effect.result(
          answerPortalStart(portals, { portalId: row.id })
        );

        assert.isTrue(
          Result.isFailure(removed) && removed.failure instanceof Conflict
        );
      })
    )
  );
});

describe("reconcile and sweep", () => {
  it.effect(
    "reconcile: a lost unit stops its row; strays are stopped and removed",
    () =>
      onStage(({ units }) =>
        Effect.gen(function* () {
          const portals = yield* Portals;
          const porch = yield* PorchClient;
          const row = yield* portals.open(openInput("main--cairn"));

          yield* units.exit(`${PREFIX}${row.id}`);
          yield* units.units.start({
            unit: `${PREFIX}00000000000000ab`,
            cwd: "/repo",
            command: "sleep 1000",
            env: { PORT: "3300" },
            lifetime: Duration.hours(1),
          });
          yield* porch.add("stray--cairn", "http://127.0.0.1:3301");

          const report = yield* portals.reconcile;

          assert.strictEqual(report.stopped, 1);
          assert.strictEqual(report.unitsStopped, 1);
          assert.strictEqual(report.porchesRemoved, 1);
          assert.deepStrictEqual(yield* units.running, []);
          assert.deepStrictEqual(yield* portalPorches, ["main--cairn"]);
          assert.deepStrictEqual(yield* rowStates, [
            { name: "main--cairn", state: "stopped", stop_reason: "lost" },
          ]);
        })
      )
  );

  it.effect(
    "reconcile: a row whose porch went missing gets it back, so the rerun finds it served",
    () =>
      onStage(({ units }) =>
        Effect.gen(function* () {
          const portals = yield* Portals;
          const porch = yield* PorchClient;
          const row = yield* portals.open(openInput("main--cairn"));

          // What a kill between register's remove and add leaves: the unit runs, the porch is gone.
          yield* porch.remove("main--cairn");
          assert.deepStrictEqual(yield* portalPorches, []);

          const report = yield* portals.reconcile;

          assert.strictEqual(report.porchesRestored, 1);
          assert.deepStrictEqual(yield* portalPorches, ["main--cairn"]);

          const rerun = yield* portals.open(openInput("main--cairn"));
          assert.strictEqual(rerun.id, row.id);
          assert.strictEqual(rerun.state, "open");
          assert.strictEqual(yield* units.starts, 1);
          assert.strictEqual((yield* portals.reconcile).porchesRestored, 0);
        })
      )
  );

  it.effect(
    "sweep: an opening portal whose server never answers is ended past the grace, not at its lifetime",
    () =>
      onStage(({ units }) =>
        Effect.gen(function* () {
          const portals = yield* Portals;
          yield* units.setAnswering(false);

          const failed = yield* Effect.result(
            portals.open({
              ...openInput("main--cairn"),
              readyTimeout: Duration.zero,
            })
          );

          assert.isTrue(Result.isFailure(failed));
          assert.lengthOf(yield* units.running, 1);

          // Inside the grace a probe may be in flight: left alone.
          yield* TestClock.adjust(Duration.minutes(2));
          assert.strictEqual((yield* portals.sweep).stopped, 0);
          assert.lengthOf(yield* units.running, 1);

          yield* TestClock.adjust(Duration.minutes(2));
          assert.strictEqual((yield* portals.sweep).stopped, 1);
          assert.deepStrictEqual(yield* units.running, []);
          assert.deepStrictEqual(yield* rowStates, [
            { name: "main--cairn", state: "stopped", stop_reason: "lost" },
          ]);
        })
      )
  );

  it.effect(
    "sweep: an opening portal that answers past the grace is marked open",
    () =>
      onStage(({ units }) =>
        Effect.gen(function* () {
          const portals = yield* Portals;
          yield* units.setAnswering(false);

          yield* Effect.result(
            portals.open({
              ...openInput("main--cairn"),
              readyTimeout: Duration.zero,
            })
          );

          yield* units.setAnswering(true);
          yield* TestClock.adjust(Duration.minutes(4));

          assert.strictEqual((yield* portals.sweep).opened, 1);
          assert.deepStrictEqual(
            (yield* rowStates).map((stored) => stored.state),
            ["open"]
          );
        })
      )
  );

  it.effect(
    "sweep: a rerun of the same open restarts the grace, without touching the porch",
    () =>
      onStage(({ units, porch }) =>
        Effect.gen(function* () {
          const portals = yield* Portals;
          yield* units.setAnswering(false);

          const notReady = {
            ...openInput("main--cairn"),
            readyTimeout: Duration.zero,
          };

          assert.isTrue(
            Result.isFailure(yield* Effect.result(portals.open(notReady)))
          );

          // Just under the three-minute grace, the agent runs the same open again.
          yield* TestClock.adjust(Duration.seconds(170));
          const reloads = yield* porch.reloads;

          assert.isTrue(
            Result.isFailure(yield* Effect.result(portals.open(notReady)))
          );
          assert.strictEqual(yield* porch.reloads, reloads);

          // Past the first open's grace, inside the rerun's: left alone.
          yield* TestClock.adjust(Duration.seconds(30));
          assert.strictEqual((yield* portals.sweep).stopped, 0);
          assert.deepStrictEqual(
            (yield* rowStates).map((stored) => stored.state),
            ["opening"]
          );
          assert.lengthOf(yield* units.running, 1);
          assert.strictEqual(yield* units.starts, 1);

          // Past the rerun's grace too: ended.
          yield* TestClock.adjust(Duration.minutes(3));
          assert.strictEqual((yield* portals.sweep).stopped, 1);
          assert.deepStrictEqual(yield* units.running, []);
        })
      )
  );

  it.effect(
    "sweep: a row a claim renewed after the sweep read it is neither stopped nor its unit",
    () => {
      // Runs once, inside the sweep's own readiness probe: what a rerun's claim landing between
      // the sweep's read and its write does to the row.
      const between = { run: Effect.void };

      return onStage(
        ({ units }) =>
          Effect.gen(function* () {
            const portals = yield* Portals;
            const sql = yield* SqlClient.SqlClient;
            yield* units.setAnswering(false);

            yield* Effect.result(
              portals.open({
                ...openInput("main--cairn"),
                readyTimeout: Duration.zero,
              })
            );

            yield* TestClock.adjust(Duration.minutes(4));

            between.run = Effect.suspend(() => {
              between.run = Effect.void;

              return sql`UPDATE portals SET updated_at = updated_at + 240000`.pipe(
                Effect.orDie,
                Effect.asVoid
              );
            });

            assert.strictEqual((yield* portals.sweep).stopped, 0);
            assert.deepStrictEqual(
              (yield* rowStates).map((stored) => stored.state),
              ["opening"]
            );
            assert.lengthOf(yield* units.running, 1);
          }),
        NO_FAULTS,
        Option.none(),
        (units) => ({
          ...units,
          answers: (port, readyPath) =>
            Effect.suspend(() => between.run).pipe(
              Effect.andThen(units.answers(port, readyPath))
            ),
        })
      );
    }
  );

  it.effect("a row without a port is refused, never served on port 0", () =>
    onStage(({ units }) =>
      Effect.gen(function* () {
        const portals = yield* Portals;
        const sql = yield* SqlClient.SqlClient;
        yield* units.setAnswering(false);

        yield* Effect.result(
          portals.open({
            ...openInput("main--cairn"),
            readyTimeout: Duration.zero,
          })
        );

        yield* sql`UPDATE portals SET port = NULL`;
        yield* units.setAnswering(true);

        const rerun = yield* Effect.result(
          portals.open(openInput("main--cairn"))
        );

        assert.isTrue(
          Result.isFailure(rerun) &&
            rerun.failure instanceof PortalError &&
            rerun.failure.reason === "store"
        );
        assert.isFalse((yield* portals.reconcile).porchesRestored > 0);
      })
    )
  );

  it.effect("sweep: a lifetime ends a portal even while its unit runs", () =>
    onStage(({ units }) =>
      Effect.gen(function* () {
        const portals = yield* Portals;
        yield* portals.open({ ...openInput("main--cairn"), ttlHours: 1 });

        yield* TestClock.adjust(Duration.minutes(59));
        assert.strictEqual((yield* portals.sweep).stopped, 0);

        yield* TestClock.adjust(Duration.minutes(2));
        assert.strictEqual((yield* portals.sweep).stopped, 1);
        assert.deepStrictEqual(yield* units.running, []);
        assert.deepStrictEqual(yield* rowStates, [
          { name: "main--cairn", state: "stopped", stop_reason: "expired" },
        ]);
      })
    )
  );

  it.effect("sweep: archiving the thread closes its portals", () =>
    onStage(({ units }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const portals = yield* Portals;

        yield* sql`INSERT INTO projects (id, workspace_root, created_at, shell_json) VALUES ('p', '/repo', 0, '{}')`;
        yield* sql`
          INSERT INTO threads (id, project_id, created_at, updated_at, shell_json)
          VALUES (${THREAD_A}, 'p', 0, 0, '{}')
        `;

        yield* portals.open(openInput("main--cairn"));
        assert.strictEqual((yield* portals.sweep).closed, 0);

        yield* sql`UPDATE threads SET archived_at = 1 WHERE id = ${THREAD_A}`;
        assert.strictEqual((yield* portals.sweep).closed, 1);
        assert.deepStrictEqual(yield* units.running, []);
        assert.deepStrictEqual(yield* portalPorches, []);
      })
    )
  );

  it.effect(
    "the sweeper runs on its schedule and stops with the close hook",
    () =>
      onStage(({ units }) =>
        Effect.gen(function* () {
          const portals = yield* Portals;
          const row = yield* portals.open(openInput("main--cairn"));

          yield* portals.startSweeper;
          yield* units.exit(`${PREFIX}${row.id}`);
          yield* TestClock.adjust(Duration.minutes(1));

          assert.deepStrictEqual(
            (yield* rowStates).map((stored) => stored.state),
            ["stopped"]
          );

          yield* portals.stopSweeper;

          const second = yield* portals.open(openInput("feat--cairn"));
          yield* units.exit(`${PREFIX}${second.id}`);
          yield* TestClock.adjust(Duration.minutes(5));

          assert.deepStrictEqual(
            (yield* rowStates).map((stored) => stored.state),
            ["stopped", "open"]
          );
        })
      ).pipe(
        Effect.provideService(PortalSettings, {
          unitPrefix: PREFIX,
          firstPort: 3100,
          lastPort: 3699,
          openingGrace: Duration.minutes(2),
          sweepEvery: Duration.minutes(1),
          probeEvery: Duration.millis(250),
          env: {},
        })
      )
  );
});
