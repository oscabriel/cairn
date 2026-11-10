// A fake systemd for tests (moved out of `PortalUnits.ts`, so the deployed brain, which loads
// `PortalUnits.ts`, loads no fake; ADR 0053): portals' units in memory, with controls to make one
// exit, stop answering, or find its port held.

import { Effect, Layer, Option, Ref } from "effect";

import { PortalUnitError, PortalUnits } from "./PortalUnits.ts";
import type { UnitSpec } from "./PortalUnits.ts";

interface FakeUnit {
  readonly spec: UnitSpec;
  readonly active: boolean;
}

interface FakeUnitsState {
  readonly units: ReadonlyMap<string, FakeUnit>;
  /** Ports something outside Cairn holds. */
  readonly busy: ReadonlySet<number>;
  /** Whether a running unit's server answers its probe. */
  readonly answering: boolean;
  readonly starts: number;
}

/** A fake systemd and its controls, for tests. */
export interface FakeUnits {
  readonly units: PortalUnits["Service"];
  /** The unit's process exits on its own (a crash, `RuntimeMaxSec`); `--collect` removes it. */
  exit(unit: string): Effect.Effect<void>;
  /** From now on a running unit's server does or does not answer. */
  setAnswering(answering: boolean): Effect.Effect<void>;
  /** Something outside Cairn holds `port`. */
  hold(port: number): Effect.Effect<void>;
  /** The units running now, by name. */
  readonly running: Effect.Effect<ReadonlyArray<string>>;
  /** How many times a unit was started. */
  readonly starts: Effect.Effect<number>;
  /** The spec a unit last started with. */
  specOf(unit: string): Effect.Effect<Option.Option<UnitSpec>>;
}

/** `units` less `unit`. */
const without = (units: ReadonlyMap<string, FakeUnit>, unit: string) => {
  const next = new Map(units);
  next.delete(unit);

  return next;
};

/** The port a fake unit serves, from its `PORT`. */
const portOf = (unit: FakeUnit) => Number(unit.spec.env.PORT ?? "0");

/**
 * An in-memory systemd: `start` refuses a unit that already runs (as `systemd-run --unit` does), a
 * stopped or exited unit is gone (`--collect`), and a running unit answers on its `PORT`.
 */
export const makeFakeUnits = Effect.gen(function* () {
  const state = yield* Ref.make<FakeUnitsState>({
    units: new Map(),
    busy: new Set(),
    answering: true,
    starts: 0,
  });

  const start = (spec: UnitSpec) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);

      if (current.units.get(spec.unit)?.active === true) {
        return yield* new PortalUnitError({
          message: `systemd-run refused ${spec.unit}: the unit already runs.`,
          operation: "start",
          unit: spec.unit,
          detail: `Failed to start transient service unit: Unit ${spec.unit}.service was already loaded or has a fragment file.`,
        });
      }

      return yield* Ref.set(state, {
        ...current,
        units: new Map(current.units).set(spec.unit, { spec, active: true }),
        starts: current.starts + 1,
      });
    });

  const isActive = (unit: string) =>
    Effect.map(
      Ref.get(state),
      (current) => current.units.get(unit)?.active === true
    );

  const stop = (unit: string) =>
    Ref.update(state, (current) => ({
      ...current,
      units: without(current.units, unit),
    }));

  const list = (prefix: string) =>
    Effect.map(Ref.get(state), (current) =>
      [...current.units.keys()].filter((name) => name.startsWith(prefix))
    );

  const units: PortalUnits["Service"] = {
    start,
    isActive,
    stop,
    list,
    journal: (unit) => Effect.succeed(`(fake journal of ${unit})`),
    portFree: (port) =>
      Effect.map(
        Ref.get(state),
        (current) =>
          !current.busy.has(port) &&
          ![...current.units.values()].some(
            (running) => running.active && portOf(running) === port
          )
      ),
    answers: (port) =>
      Effect.map(
        Ref.get(state),
        (current) =>
          current.answering &&
          [...current.units.values()].some(
            (running) => running.active && portOf(running) === port
          )
      ),
  };

  const fake: FakeUnits = {
    units,
    exit: stop,
    setAnswering: (answering) =>
      Ref.update(state, (current) => ({ ...current, answering })),
    hold: (port) =>
      Ref.update(state, (current) => ({
        ...current,
        busy: new Set(current.busy).add(port),
      })),
    running: Effect.map(Ref.get(state), (current) =>
      [...current.units].flatMap(([name, unit]) => (unit.active ? [name] : []))
    ),
    starts: Effect.map(Ref.get(state), (current) => current.starts),
    specOf: (unit) =>
      Effect.map(Ref.get(state), (current) =>
        Option.map(
          Option.fromUndefinedOr(current.units.get(unit)),
          (found) => found.spec
        )
      ),
  };

  return fake;
});

/** `PortalUnits` as an in-memory systemd (`makeFakeUnits`). */
export const FakePortalUnitsLayer = Layer.effect(
  PortalUnits,
  Effect.map(makeFakeUnits, (fake) => fake.units)
);
