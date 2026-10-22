// Judges `Unit` against real transient user units (systemd 262 on the Beelink): a killed main process
// is restarted with a new invocation, its journal lines stay attributable to the run that wrote them,
// nothing is orphaned, and a process that leaves the cgroup is caught. Skipped where there is no
// user systemd.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Schedule } from "effect";

import * as Events from "./Events.ts";
import * as Unit from "./Unit.ts";

const hasUserSystemd = (() => {
  try {
    execFileSync("systemctl", ["--user", "is-system-running"], {
      stdio: "ignore",
    });

    return true;
  } catch {
    // `is-system-running` exits non-zero for "degraded" too; only a missing manager matters.
    try {
      execFileSync("systemctl", ["--user", "show", "-P", "Version"], {
        stdio: "ignore",
      });

      return true;
    } catch {
      return false;
    }
  }
})();

const unitName = (role: string) =>
  `cairn-judge-lib-${role}-${randomBytes(4).toString("hex")}`;

/** Polls until `check` holds, up to five seconds. */
const eventually = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  check.pipe(
    Effect.filterOrFail((ok) => ok),
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 })
  );

const listeningLine =
  '{"message":"listening","level":"INFO","timestamp":"2026-10-22T09:00:00.000Z","annotations":{"event":"listening","port":4100}}';

describe.skipIf(!hasUserSystemd)("transient units", () => {
  layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect(
      "restarts a killed main process with a new invocation and no orphans",
      () =>
        Effect.gen(function* () {
          const unit = yield* Unit.start({
            name: unitName("kill"),
            command: [
              "bash",
              "-c",
              `echo '${listeningLine}'; sleep 300 & sleep 300 & wait`,
            ],
            properties: Unit.brainProperties,
          });

          yield* eventually(
            Unit.processes(unit).pipe(Effect.map((list) => list.length >= 3))
          );

          const firstPid = yield* Unit.mainPid(unit);

          const firstRun = yield* Unit.invocationId(unit);

          const before = yield* Unit.snapshot(unit);

          assert.isTrue(
            before.some(({ command }) => command === "sleep 300"),
            "the unit's children are listed with their command lines"
          );

          yield* Unit.killMain(unit);

          yield* eventually(
            Unit.mainPid(unit).pipe(
              Effect.map((pid) => pid !== 0 && pid !== firstPid)
            )
          );

          assert.notStrictEqual(yield* Unit.invocationId(unit), firstRun);

          assert.strictEqual(yield* Unit.restarts(unit), 1);

          assert.deepStrictEqual(yield* Unit.orphans(unit, before), []);

          const firstLines = yield* Unit.journal(unit, firstRun);

          assert.deepStrictEqual(
            Events.parseLines(firstLines).map((event) => event.event),
            ["listening"]
          );
        }).pipe(Effect.scoped),
      { timeout: 20_000 }
    );

    it.effect(
      "counts a process that left the cgroup as an orphan once the unit stops",
      () =>
        Effect.gen(function* () {
          const escape = unitName("escape");

          yield* Effect.addFinalizer(() =>
            Effect.ignore(Unit.stop(`${escape}.scope`))
          );

          // systemd-run --scope moves the sleep into a scope of its own, as Chrome does over the bus.
          const unit = yield* Unit.start({
            name: unitName("leaky"),
            command: [
              "bash",
              "-c",
              `systemd-run --user --scope --quiet --unit=${escape} sleep 300 & sleep 300 & wait`,
            ],
            env: {
              XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "/run/user/1000",
            },
          });

          yield* eventually(
            Unit.escaped(unit).pipe(Effect.map((list) => list.length === 1))
          );

          const before = yield* Unit.snapshot(unit);

          yield* Unit.stop(unit);

          const left = yield* Unit.orphans(unit, before);

          assert.deepStrictEqual(
            left.map(({ command }) => command),
            ["/usr/bin/sleep 300"]
          );
        }).pipe(Effect.scoped),
      { timeout: 20_000 }
    );
  });
});
