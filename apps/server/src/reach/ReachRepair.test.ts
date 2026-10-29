// Porch not set up is a state, not a boot failure. Before the user runs the reach stage of the
// wizard, the brain's porch binary is missing (spawn ENOENT) or has no machine config: the portal
// reconcile and the sweep record `porch: not set up`, log it once at info with the stage to run,
// and the boot repair succeeds. The tools still answer porch's own error. Porch here is the real
// client over a binary path that does not exist, beside a fake porch the test can switch to; a
// porch that fails for any other reason is the control that still fails the repair.

import path from "node:path";

import { ThreadId } from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Predicate,
  Ref,
  References,
} from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import {
  makeFakePorch,
  PorchClient,
  PorchError,
  PorchSettings,
} from "./PorchClient.ts";
import { Portals } from "./Portals.ts";
import type { OpenInput } from "./Portals.ts";
import { makeFakeUnits, PortalUnits } from "./PortalUnits.ts";
import { portalReconcile } from "./ReachRepair.ts";
import {
  isPorchNotSetUp,
  PORCH_WIZARD_STAGE,
  ReachStatus,
} from "./ReachStatus.ts";

const THREAD = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-00000000f0a1");

const openInput = (name: string): OpenInput => ({
  threadId: THREAD,
  name,
  command: "python3 -m http.server $PORT --bind 127.0.0.1",
  cwd: "/repo",
  ttlHours: 12,
  readyPath: "/",
  readyTimeout: Duration.seconds(5),
});

/** A porch failure for a reason other than not being set up. */
const crashed = (operation: string) =>
  new PorchError({
    message: `porch ${operation} exited 2 without a refusal: boom`,
    operation,
    reason: "crashed",
    porchCode: Option.none(),
    detail: "boom",
    retryable: false,
  });

/** porch's refusal before `porch init`. */
const noConfig = (operation: string) =>
  new PorchError({
    message: `porch ${operation} refused (no-config): run porch init`,
    operation,
    reason: "no-config",
    porchCode: Option.some("no-config"),
    detail: "run porch init",
    retryable: false,
  });

/** A client whose every call fails with `failure`. */
const failingPorch = (
  failure: (operation: string) => PorchError
): PorchClient["Service"] => ({
  version: Effect.fail(failure("version")),
  machine: Effect.fail(failure("machine")),
  publish: () => Effect.fail(failure("publish")),
  add: () => Effect.fail(failure("add")),
  remove: () => Effect.fail(failure("rm")),
  list: Effect.fail(failure("ls")),
  apply: Effect.fail(failure("apply")),
  doctor: Effect.fail(failure("doctor")),
});

/** A client that runs whichever client `current` holds at each call. */
const switching = (
  current: Ref.Ref<PorchClient["Service"]>
): PorchClient["Service"] => {
  const via = <A>(
    call: (client: PorchClient["Service"]) => Effect.Effect<A, PorchError>
  ) => Effect.flatMap(Ref.get(current), call);

  return {
    version: via((client) => client.version),
    machine: via((client) => client.machine),
    publish: (source, project) =>
      via((client) => client.publish(source, project)),
    add: (name, upstream) => via((client) => client.add(name, upstream)),
    remove: (name) => via((client) => client.remove(name)),
    list: via((client) => client.list),
    apply: via((client) => client.apply),
    doctor: via((client) => client.doctor),
  };
};

/** The reach state of porch. */
const porchState = ReachStatus.use((status) => status.porch);

/** The annotations the tests read off a log line. */
interface Annotations {
  readonly event?: string;
  readonly porch?: string;
  readonly source?: string;
  readonly operation?: string;
  readonly reason?: string;
  readonly wizard?: string;
}

interface Logged {
  readonly level: string;
  readonly annotations: Annotations;
}

/**
 * A missing porch (the real client over a binary that does not exist and an empty config home), a
 * fake porch, a switch between them starting on `start`, and `Portals` over it, fake units and a
 * migrated store. Every log line is kept.
 */
const stage = (start: "missing" | "fake") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "cairn-reach-repair-",
    });

    const artifacts = path.join(root, "artifacts");
    yield* fs.makeDirectory(artifacts);

    const missing = yield* Effect.service(PorchClient).pipe(
      Effect.provide(
        PorchClient.layer.pipe(
          Layer.provide(
            Layer.succeed(PorchSettings, {
              bin: path.join(root, "bin", "porch"),
              env: { XDG_CONFIG_HOME: path.join(root, "config") },
              timeout: Duration.seconds(10),
            })
          )
        )
      )
    );

    const fake = yield* makeFakePorch({ domain: "example.test", artifacts });

    const current = yield* Ref.make(
      start === "missing" ? missing : fake.client
    );

    const units = yield* makeFakeUnits;

    const logged: Array<Logged> = [];

    const capture = Logger.make((options) => {
      logged.push({
        level: options.logLevel,
        annotations: options.fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    const layer = Portals.layerNoDeps.pipe(
      Layer.provideMerge(Layer.succeed(PorchClient, switching(current))),
      Layer.provideMerge(Layer.succeed(PortalUnits, units.units)),
      Layer.provideMerge(Database.layerTest(migrations)),
      Layer.provideMerge(Logger.layer([capture], { mergeWithExisting: false }))
    );

    const events = (event: string) =>
      logged.filter((line) => line.annotations.event === event);

    return { missing, fake, current, layer, events };
  });

type Stage = Effect.Success<ReturnType<typeof stage>>;

const onStage = <A, E>(
  start: "missing" | "fake",
  body: (
    s: Stage
  ) => Effect.Effect<A, E, Portals | ReachStatus | SqlClient.SqlClient>
) =>
  Effect.gen(function* () {
    const s = yield* stage(start);

    return yield* body(s).pipe(Effect.provide(s.layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("porch not set up", () => {
  it.effect(
    "a missing porch binary: the reconcile records not set up, logs it once at info with the wizard stage, and boot goes on",
    () =>
      onStage("missing", ({ events }) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* porchState, "unknown");

          yield* portalReconcile.repair;
          yield* portalReconcile.repair;

          assert.deepStrictEqual(events("boot_repair_failed"), []);
          assert.strictEqual(yield* porchState, "not set up");

          const notSetUp = events("reach_porch_not_set_up");
          assert.strictEqual(notSetUp.length, 1, "logged once, not per run");
          assert.strictEqual(notSetUp[0]?.level, "Info");
          assert.deepInclude(notSetUp[0]?.annotations, {
            porch: "not set up",
            source: "portal reconcile",
            operation: "ls",
            reason: "unavailable",
            wizard: PORCH_WIZARD_STAGE,
          });

          // Both runs reconciled the rows and units, and said porch was skipped.
          const reconciled = events("portal_reconcile");
          assert.strictEqual(reconciled.length, 2);
          assert.strictEqual(reconciled[0]?.annotations.porch, "not set up");
        })
      )
  );

  it.effect(
    "the missing binary's error is spawn ENOENT, which reads as not set up",
    () =>
      onStage("missing", ({ missing }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(missing.list);

          assert.strictEqual(error.reason, "unavailable");
          assert.isTrue(isPorchNotSetUp(error));
          assert.isFalse(isPorchNotSetUp(crashed("ls")));
          assert.isTrue(isPorchNotSetUp(noConfig("ls")));
        })
      )
  );

  it.effect(
    "porch installed but not initialized (no-config) is not set up too",
    () =>
      onStage("fake", ({ current, events }) =>
        Effect.gen(function* () {
          yield* Ref.set(current, failingPorch(noConfig));
          yield* portalReconcile.repair;

          assert.deepStrictEqual(events("boot_repair_failed"), []);
          assert.strictEqual(yield* (yield* ReachStatus).porch, "not set up");
          assert.strictEqual(
            events("reach_porch_not_set_up")[0]?.annotations.reason,
            "no-config"
          );
        })
      )
  );

  it.effect(
    "the sweep records it the same way: one info line, no warning each minute",
    () =>
      onStage("fake", ({ current, missing, events }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const portals = yield* Portals;

          yield* sql`INSERT INTO projects (id, workspace_root, created_at, shell_json) VALUES ('p', '/repo', 0, '{}')`;
          yield* sql`
            INSERT INTO threads (id, project_id, created_at, updated_at, shell_json)
            VALUES (${THREAD}, 'p', 0, 0, '{}')
          `;

          yield* portals.open(openInput("main--cairn"));
          yield* portals.open(openInput("docs--cairn"));

          // porch goes away (uninstalled), then the thread is archived: the sweep's close meets it.
          yield* Ref.set(current, missing);
          yield* sql`UPDATE threads SET archived_at = 1 WHERE id = ${THREAD}`;

          yield* portals.startSweeper;
          yield* TestClock.adjust(Duration.minutes(1));
          yield* TestClock.adjust(Duration.minutes(1));
          yield* TestClock.adjust(Duration.minutes(1));
          yield* portals.stopSweeper;

          assert.deepStrictEqual(events("portal_sweep_failed"), []);
          assert.strictEqual(yield* porchState, "not set up");

          const notSetUp = events("reach_porch_not_set_up");
          assert.strictEqual(notSetUp.length, 1);
          assert.strictEqual(notSetUp[0]?.annotations.source, "portal sweep");
          assert.strictEqual(notSetUp[0]?.level, "Info");
        })
      )
  );

  it.effect(
    "once the wizard has run, the next reconcile records porch ready",
    () =>
      onStage("missing", ({ current, fake, events }) =>
        Effect.gen(function* () {
          yield* portalReconcile.repair;
          assert.strictEqual(yield* porchState, "not set up");

          yield* Ref.set(current, fake.client);
          yield* portalReconcile.repair;

          assert.strictEqual(yield* porchState, "ready");
          assert.strictEqual(events("reach_porch_ready").length, 1);
          assert.deepStrictEqual(events("boot_repair_failed"), []);
        })
      )
  );

  it.effect(
    "control: a porch that fails for another reason still fails the repair, and is not recorded as not set up",
    () =>
      onStage("fake", ({ current, events }) =>
        Effect.gen(function* () {
          yield* Ref.set(current, failingPorch(crashed));
          yield* portalReconcile.repair;

          assert.strictEqual(events("boot_repair_failed").length, 1);
          assert.deepStrictEqual(events("reach_porch_not_set_up"), []);
          assert.strictEqual(yield* (yield* ReachStatus).porch, "unknown");
        })
      )
  );

  it.effect(
    "the portal tool's open still answers porch's plain not-set-up error",
    () =>
      onStage("missing", ({ events }) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            (yield* Portals).open(openInput("main--cairn"))
          );

          assert.isTrue(
            Predicate.isTagged(error, "PorchError") && isPorchNotSetUp(error),
            "porch's not-set-up error, not a crash"
          );
          assert.include(error.message, "ops/wizards/phase-2.sh");
          // A tool call answers the model; it does not move the reach state or log it.
          assert.deepStrictEqual(events("reach_porch_not_set_up"), []);
        })
      )
  );
});
