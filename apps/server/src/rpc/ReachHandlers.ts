// `reach.list` and `artifact.revoke` (ADR 0038): the work panel's list of a thread's artifacts and
// portals, and the owner stopping an artifact from being served. Revoke answers `NotFound` for an
// id with no published artifact, `Unavailable` when porch's machine config cannot be read (the
// file's place is unknown), and `Internal`, logged, when the table or the folder fails. Revoking
// twice succeeds twice.

import { Internal, NotFound, Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer, Option } from "effect";

import type { ArtifactsError } from "../reach/Artifacts.ts";
import { Artifacts } from "../reach/Artifacts.ts";
import { ReachLister } from "../reach/ReachList.ts";
import { publicText } from "./PublicText.ts";

/** A store or folder failure, logged under `event` and answered without its cause. */
const internal = (event: string, what: string) => (failure: ArtifactsError) =>
  Effect.logError(`${what} failed`).pipe(
    Effect.annotateLogs({ event, error: failure.message }),
    Effect.andThen(
      Effect.fail(
        new Internal({
          message: `${what} failed. Retry, and check the brain's log (${event}) if it repeats.`,
        })
      )
    )
  );

/** `reach.list`. Needs `ReachLister`. */
export const ReachListHandler = CairnRpcs.toLayerHandler(
  "reach.list",
  ReachLister.useSync(
    (lister) => (input) =>
      lister.list(input.threadId).pipe(
        Effect.catchTags({
          ArtifactsError: internal(
            "reach_list_failed",
            "Listing artifacts and portals"
          ),
        })
      )
  )
);

/** `artifact.revoke`. Needs `Artifacts`. */
export const ArtifactRevokeHandler = CairnRpcs.toLayerHandler(
  "artifact.revoke",
  Artifacts.useSync(
    (artifacts) => (input) =>
      artifacts.revoke(input.artifactId, Option.none()).pipe(
        Effect.asVoid,
        Effect.catchTags({
          ArtifactNotFound: (missing) =>
            Effect.fail(
              new NotFound({
                message: publicText(missing.message),
                resource: "artifact",
                id: input.artifactId,
              })
            ),
          PorchError: (failure) =>
            Effect.fail(
              new Unavailable({ message: publicText(failure.message) })
            ),
          ArtifactsError: internal(
            "artifact_revoke_failed",
            "Revoking the artifact"
          ),
        })
      )
  )
);

/** Both handlers. Needs `Artifacts` and `ReachLister`. */
export const ReachHandlers = Layer.mergeAll(
  ReachListHandler,
  ArtifactRevokeHandler
);
