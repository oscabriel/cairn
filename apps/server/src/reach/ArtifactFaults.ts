// Fault points for the artifacts kill judge (`judges/artifacts-kill.ts`): a judge brain plants a
// SIGKILL right after one step of a publish or revoke, so the judge can rerun the replay-safe call
// over the torn state. Production and dev never plant one; the hooks default to doing nothing.
// Kept apart from `Artifacts.ts` so `ArtifactPublisher`, which `Artifacts` builds on, can read
// them too.

import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";

// ── Faults ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The crash windows of an artifact's steps, in order: `stage` after `Artifacts` wrote the staged
 * copy and before porch runs; `claim` after `ArtifactPublisher` inserted its claim and before
 * porch; `porch` after porch copied and before the row is filled in; `publish` after the row is
 * filled in and before a revoked page's copy is restored; `remove` after a revoke removed the files
 * and before it marks the row. `claim` and `porch` fire once `ArtifactPublisher` reads these hooks.
 */
export const ArtifactStep = Schema.Literals([
  "stage",
  "claim",
  "porch",
  "publish",
  "remove",
]);

export type ArtifactStep = typeof ArtifactStep.Type;

/** A hook that runs after each crash window opens; a judge brain kills itself there. */
export interface ArtifactFaultHooks {
  after(step: ArtifactStep): Effect.Effect<void>;
}

/**
 * No fault: production and dev never plant one. Judge brains set it from `CAIRN_JUDGE_FAULT`
 * (`judgeArtifactFaults`). Read once, when `Artifacts` is built.
 */
export const ArtifactFaults = Context.Reference<ArtifactFaultHooks>(
  "cairn/server/reach/ArtifactFaults",
  { defaultValue: () => ({ after: () => Effect.void }) }
);

const decodeStep = Schema.decodeUnknownOption(ArtifactStep);

/**
 * The step a judge brain's `CAIRN_JUDGE_FAULT` names, `artifact:after-<step>` (such as
 * `artifact:after-stage`); none for any other value, which belongs to another fault family.
 */
export const artifactFaultStep = (spec: string): Option.Option<ArtifactStep> =>
  spec.startsWith("artifact:after-")
    ? decodeStep(spec.slice("artifact:after-".length))
    : Option.none();

/**
 * A judge brain's faults (`judges/artifacts-kill.ts`): for `spec` an `artifact:after-<step>`, the
 * process kills itself with SIGKILL right after that step, as a `kill -9` there would, once per
 * `marker` file, so the next life runs clean. Any other `spec` plants none. Judge brains only:
 * production and dev roots never provide it.
 */
export const judgeArtifactFaults = (spec: string, marker: string) =>
  Layer.effect(
    ArtifactFaults,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      return Option.match(artifactFaultStep(spec), {
        onNone: (): ArtifactFaultHooks => ({ after: () => Effect.void }),
        onSome: (target): ArtifactFaultHooks => ({
          after: (step) =>
            Effect.gen(function* () {
              if (
                step !== target ||
                (yield* fs
                  .exists(marker)
                  .pipe(Effect.orElseSucceed(() => true)))
              ) {
                return;
              }

              yield* fs.writeFileString(marker, step).pipe(Effect.ignore);
              yield* Effect.logWarning("judge fault fired").pipe(
                Effect.annotateLogs({ event: "judge_fault", fault: spec })
              );
              yield* Effect.sync(() => {
                process.kill(process.pid, "SIGKILL");
              });
            }),
        }),
      });
    })
  );
