// Git's version for the brain's coding tools, asked once through Node's git when the layer is built.

import { Effect, Layer } from "effect";

import { GitVersion } from "../brain/GitVersion.ts";
import { Git } from "./Git.ts";

/**
 * `git version` through Node's git. A git that cannot run reports its failure in the line, and the
 * coding tools leave the trailer off.
 */
export const GitVersionLive = Layer.effect(
  GitVersion,
  Effect.gen(function* () {
    const git = yield* Git;

    const line = yield* git
      .run("CodingTools.gitVersion", ".", ["version"])
      .pipe(
        Effect.map((result) => result.stdout),
        Effect.catchTag("GitError", (failure) =>
          Effect.succeed(failure.message)
        )
      );

    return GitVersion.of({ line });
  })
).pipe(Layer.provide(Git.layer));
