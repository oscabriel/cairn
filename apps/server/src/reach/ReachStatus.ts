// The reach status: whether porch is set up on this machine. Until the user runs the reach stage of
// the phase 2 wizard (`ops/wizards/phase-2.sh 2`), the porch binary is missing (spawn ENOENT) or has
// no machine config (`no-config`, before `porch init`). That is a state of the machine, not a
// fault: the portal reconcile and the sweep record `porch: not set up` here, log it once at info
// with the stage to run, and go on, instead of failing the boot repair or warning every minute.
// The reach tools are unchanged: they answer porch's own "not set up" error to the model.
//
// `Portals.layerNoDeps` builds the status and gives it out beside `Portals`, so every root that has
// portals has one status and no root provides it by hand.

import { Context, Effect, Layer, Option, Predicate, Ref } from "effect";

import type { PorchError } from "./PorchClient.ts";

/** The wizard stage that installs porch and runs `porch init`. */
export const PORCH_WIZARD_STAGE = "ops/wizards/phase-2.sh 2";

/**
 * What the brain knows of porch: `unknown` before any repair asked, `ready` once a reconcile
 * listed its porches, `not set up` while the binary is missing or has no machine config.
 */
export type PorchState = "unknown" | "ready" | "not set up";

/** The spawn of the binary failed because there is no such file (ENOENT). */
const isMissingBinary = (cause: unknown) =>
  Predicate.isTagged(cause, "PlatformError") &&
  Predicate.hasProperty(cause, "reason") &&
  Predicate.isTagged(cause.reason, "NotFound") &&
  Predicate.hasProperty(cause.reason, "method") &&
  cause.reason.method === "spawn";

/**
 * Whether a porch failure means porch is not set up yet: its binary is not installed, or it has no
 * machine config. Any other failure (a crash, a refusal, a timeout) is a real one.
 */
export const isPorchNotSetUp = (failure: PorchError) =>
  failure.reason === "no-config" ||
  (failure.reason === "unavailable" && isMissingBinary(failure.cause));

/** The reach state one brain keeps, with its log lines. */
export class ReachStatus extends Context.Service<
  ReachStatus,
  {
    /** What the last reconcile or sweep found of porch. */
    readonly porch: Effect.Effect<PorchState>;
    /**
     * Records `not set up`, seen by `source` (`portal reconcile`, `portal sweep`). Logs at info
     * only when the state changes, so a sweep every minute adds nothing after the first line.
     */
    porchNotSetUp(source: string, failure: PorchError): Effect.Effect<void>;
    /** Records `ready`; logs once when porch was not set up before. */
    readonly porchReady: Effect.Effect<void>;
  }
>()("cairn/server/reach/ReachStatus") {
  /** A fresh status, porch `unknown`. */
  static readonly layer = Layer.effect(
    ReachStatus,
    Effect.gen(function* () {
      const state = yield* Ref.make<PorchState>("unknown");

      const porchNotSetUp = (source: string, failure: PorchError) =>
        Effect.gen(function* () {
          const before = yield* Ref.getAndSet(state, "not set up");

          if (before === "not set up") {
            return;
          }

          yield* Effect.logInfo(
            `porch is not set up; run ${PORCH_WIZARD_STAGE} to install it`
          ).pipe(
            Effect.annotateLogs({
              event: "reach_porch_not_set_up",
              porch: "not set up",
              source,
              operation: failure.operation,
              reason: failure.reason,
              wizard: PORCH_WIZARD_STAGE,
            })
          );
        });

      const porchReady = Effect.gen(function* () {
        const before = yield* Ref.getAndSet(state, "ready");

        if (before === "not set up") {
          yield* Effect.logInfo("porch is set up").pipe(
            Effect.annotateLogs({ event: "reach_porch_ready", porch: "ready" })
          );
        }
      });

      return ReachStatus.of({
        porch: Ref.get(state),
        porchNotSetUp,
        porchReady,
      });
    })
  );
}

/**
 * Runs a porch call; when it fails because porch is not set up, records that on `status` and
 * answers `None`. Every other failure passes through.
 */
export const unlessPorchNotSetUp = <A, R>(
  status: ReachStatus["Service"],
  source: string,
  call: Effect.Effect<A, PorchError, R>
) =>
  call.pipe(
    Effect.asSome,
    Effect.catchTag("PorchError", (failure) =>
      isPorchNotSetUp(failure)
        ? status
            .porchNotSetUp(source, failure)
            .pipe(Effect.as(Option.none<A>()))
        : Effect.fail(failure)
    )
  );
