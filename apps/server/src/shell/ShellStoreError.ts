// The one failure every shell store read or write can end in: SQLite refused the statement or a
// stored row no longer decodes. Neither is the caller's fault and neither committed anything.
import { Effect, Schema } from "effect";

/** A shell store statement failed or a stored row did not decode; nothing was committed. */
export class ShellStoreError extends Schema.TaggedError<ShellStoreError>()(
  "ShellStoreError",
  {
    message: Schema.String,
    /** The store operation, as `Store.method`. */
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {}

/** Maps every SQL or decode failure of `operation` to a `ShellStoreError`. */
export const shellStoreFailure =
  (operation: string) =>
  <A, E extends Error, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ShellStoreError({
            message: `The shell store failed in ${operation}. Nothing was committed; retry, and report it if it repeats.`,
            operation,
            cause,
          })
      )
    );
